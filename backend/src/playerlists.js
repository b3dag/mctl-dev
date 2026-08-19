import crypto from 'node:crypto';
import { readFileFromContainer, writeFileToContainer, containerState, volumeOwner } from './docker.js';
import { rconCommand } from './rcon.js';
import { stateOf } from './state.js';
import { httpError, sleep } from './errors.js';
import { db } from './db.js';
import { stripFormatting } from './text.js';

/**
 * Whitelist, operators and bans.
 *
 * Vanilla only gives the whitelist a way to reload itself from disk without a
 * restart (`whitelist reload`), so it is the one list mctl edits as a file:
 * write whitelist.json with our own UUID resolution, then ask a running
 * server to reload it. That also sidesteps a real bug, where asking a running
 * server to resolve a name itself queries Mojang even in offline mode and can
 * land a UUID that never matches a connecting player.
 *
 * Ops and bans have no reload command, so a file write there would always
 * need a restart to take effect anyway. There is nothing to gain by writing
 * their files ourselves, so those go over RCON only and need the server up.
 */

const FILES = {
  whitelist: 'whitelist.json',
  ops: 'ops.json',
  bannedPlayers: 'banned-players.json',
  bannedIps: 'banned-ips.json',
};

const NAME_RE = /^[A-Za-z0-9_]{1,16}$/;
const IP_RE = /^[0-9a-fA-F:.]{3,45}$/;

export function validName(input) {
  const name = String(input || '').trim();
  if (!NAME_RE.test(name)) throw httpError(400, `"${input}" is not a valid Minecraft name`);
  return name;
}

export function validIp(input) {
  const ip = String(input || '').trim();
  if (!IP_RE.test(ip)) throw httpError(400, `"${input}" is not a valid IP address`);
  return ip;
}

const isLive = async (server) => {
  const st = await containerState(server.container_name);
  return st.running && stateOf(server.id).phase === 'ready';
};

/**
 * Waits out a server that is mid-boot rather than racing it: the container is
 * up, so it has already read these files once and will write its own copy
 * back as soon as RCON comes up, and touching a file during that window looks
 * like it worked and is then silently overwritten. Returns once the server
 * has settled one way or the other, or gives up honestly after too long.
 */
async function awaitSettled(server, { waitMs = 120000 } = {}) {
  const deadline = Date.now() + waitMs;
  for (;;) {
    const st = await containerState(server.container_name);
    const phase = stateOf(server.id).phase;
    if (!st.running) return { running: false, ready: false };
    if (phase !== 'starting') return { running: true, ready: phase === 'ready' };
    if (Date.now() >= deadline) {
      throw httpError(409, 'the server is still starting. Try again once it is up.');
    }
    await sleep(1500);
  }
}

async function readJson(server, file) {
  try {
    const buf = await readFileFromContainer(server.container_name, `/data/${file}`);
    const parsed = JSON.parse(buf.toString('utf8') || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return []; // absent until the server has written it once
  }
}

async function writeJson(server, file, list) {
  // The image runs as uid 1000; a root-owned file here breaks its next boot.
  await writeFileToContainer(
    server.container_name,
    `/data/${file}`,
    Buffer.from(JSON.stringify(list, null, 2), 'utf8'),
    await volumeOwner(server.volume_name)
  );
}

/** Whether server.properties has the whitelist switched on. */
async function whitelistEnabled(server) {
  try {
    const buf = await readFileFromContainer(server.container_name, '/data/server.properties');
    return /^white-list\s*=\s*true\s*$/m.test(buf.toString('utf8'));
  } catch {
    return false;
  }
}

export async function readLists(server) {
  const [whitelist, ops, bannedPlayers, bannedIps, enabled, live] = await Promise.all([
    readJson(server, FILES.whitelist),
    readJson(server, FILES.ops),
    readJson(server, FILES.bannedPlayers),
    readJson(server, FILES.bannedIps),
    whitelistEnabled(server),
    isLive(server),
  ]);

  return {
    live,
    whitelistEnabled: enabled,
    whitelist: whitelist.map((e) => ({ name: e.name, uuid: e.uuid })),
    ops: ops.map((e) => ({
      name: e.name,
      uuid: e.uuid,
      level: e.level ?? 4,
      bypassesPlayerLimit: !!e.bypassesPlayerLimit,
    })),
    bannedPlayers: bannedPlayers.map((e) => ({
      name: e.name,
      uuid: e.uuid,
      reason: e.reason || '',
      source: e.source || '',
      created: e.created || '',
      expires: e.expires || 'forever',
    })),
    bannedIps: bannedIps.map((e) => ({
      ip: e.ip,
      reason: e.reason || '',
      source: e.source || '',
      created: e.created || '',
      expires: e.expires || 'forever',
    })),
  };
}

/**
 * Minecraft's own algorithm for players who are never authenticated against
 * Mojang: UUID v3 of "OfflinePlayer:<name>". A server running ONLINE_MODE=false
 * assigns connecting players this UUID, not their real Mojang one, so that is
 * what has to end up in whitelist.json or the entry never matches.
 */
function offlineUuid(name) {
  const hash = Buffer.from(crypto.createHash('md5').update(`OfflinePlayer:${name}`).digest());
  hash[6] = (hash[6] & 0x0f) | 0x30; // version 3
  hash[8] = (hash[8] & 0x3f) | 0x80; // variant
  const hex = hash.toString('hex');
  return { name, uuid: `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}` };
}

/** Resolve a name to a UUID for the whitelist file, offline-aware. */
async function lookupUuid(name, server) {
  if (server?.env?.ONLINE_MODE === 'false') return offlineUuid(name);
  let res;
  let lastError;
  // Retried because this is a single outbound call on someone else's network,
  // and one blocked or dropped request should not fail the whole operation.
  for (let attempt = 0; attempt < 3 && !res; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, 400 * attempt));
    try {
      res = await fetch(`https://api.mojang.com/users/profiles/minecraft/${encodeURIComponent(name)}`, {
        headers: { 'user-agent': 'mctl' },
        signal: AbortSignal.timeout(8000),
      });
    } catch (e) {
      lastError = e;
    }
  }
  if (!res) {
    throw httpError(
      503,
      `could not reach Mojang to look up "${name}" (${lastError?.message}). ` +
        `Start the server and add them there instead.`
    );
  }
  if (res.status === 404) throw httpError(404, `no Minecraft account called "${name}"`);
  if (!res.ok) throw httpError(502, `Mojang lookup failed with ${res.status}`);
  const data = await res.json();
  const id = String(data.id);
  return {
    name: data.name,
    uuid: `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}`,
  };
}

// --- whitelist: always a file write, reloaded live when possible -----------

/**
 * Writes whitelist.json, then asks a running server to pick it up immediately
 * with `whitelist reload`. If that fails (RCON drops mid-request, say) the
 * file write itself already succeeded, so it is reported as taking effect on
 * the next start rather than treated as an error.
 */
async function mutateWhitelist(server, apply) {
  const { running } = await awaitSettled(server);
  const list = await readJson(server, FILES.whitelist);
  const next = await apply(list);
  await writeJson(server, FILES.whitelist, next);

  if (running) {
    try {
      const out = await rconCommand(server, 'whitelist reload');
      return { via: 'file', output: `Saved and reloaded live. ${stripFormatting(out).trim()}`.trim() };
    } catch {
      /* saved either way; just couldn't confirm the live reload */
    }
  }
  return {
    via: 'file',
    output: running
      ? 'Saved to the file. Restart the server for this to take effect.'
      : 'Saved to the file. It takes effect the next time the server starts.',
  };
}

export const addToWhitelist = (server, name, actor) =>
  mutateWhitelist(server, async (list) => {
    if (list.some((e) => e.name?.toLowerCase() === name.toLowerCase())) return list;
    const profile = await lookupUuid(name, server);
    return [...list, profile];
  });

export const removeFromWhitelist = (server, name, actor) =>
  mutateWhitelist(server, async (list) => list.filter((e) => e.name?.toLowerCase() !== name.toLowerCase()));

/**
 * Enforcement lives in server.properties, which is only read at boot, so that
 * file is always the source of truth here (and the stored ENABLE_WHITELIST is
 * kept in step, since the image would otherwise undo this on the next
 * recreate). `whitelist on`/`off` is applied on top when the server is up,
 * since unlike a list edit that command is already instant and needs no
 * reload.
 */
export const setWhitelistEnabled = async (server, enabled) => {
  const { running } = await awaitSettled(server);

  let text = '';
  try {
    text = (await readFileFromContainer(server.container_name, '/data/server.properties')).toString('utf8');
  } catch {
    throw httpError(409, 'this server has no server.properties yet; start it once first');
  }

  const line = `white-list=${enabled}`;
  const existing = /^white-list\s*=.*$/m;
  text = existing.test(text)
    ? text.replace(existing, line)
    : text.replace(/\n?$/, '\n') + line + '\n';

  await writeFileToContainer(
    server.container_name,
    '/data/server.properties',
    Buffer.from(text, 'utf8'),
    await volumeOwner(server.volume_name)
  );

  const env = { ...(server.env || {}), ENABLE_WHITELIST: String(enabled) };
  db.prepare('UPDATE servers SET env = ? WHERE id = ?').run(JSON.stringify(env), server.id);

  if (running) {
    try {
      const out = await rconCommand(server, `whitelist ${enabled ? 'on' : 'off'}`);
      return { via: 'file', output: `Saved and applied live. ${stripFormatting(out).trim()}`.trim() };
    } catch {
      /* saved either way; just couldn't confirm the live toggle */
    }
  }
  return { via: 'file', output: `Whitelist enforcement ${enabled ? 'on' : 'off'} from the next start.` };
};

// --- ops and bans: RCON only, no file equivalent ----------------------------

/** Everything below needs the server up and answering RCON; there is no file path to fall back to. */
async function mutateLive(server, command) {
  const { running, ready } = await awaitSettled(server);
  if (!ready) {
    throw httpError(409, running ? 'the server is not responding to RCON yet' : 'the server is not running');
  }
  const out = await rconCommand(server, command);
  return { via: 'rcon', output: stripFormatting(out).trim() };
}

export const addOp = (server, name, actor) => mutateLive(server, `op ${name}`);

export const removeOp = (server, name, actor) => mutateLive(server, `deop ${name}`);

export const banPlayer = (server, name, reason, actor) =>
  mutateLive(server, `ban ${name}${reason ? ` ${reason}` : ''}`);

export const pardonPlayer = (server, name, actor) => mutateLive(server, `pardon ${name}`);

export const banIp = (server, ip, reason, actor) => mutateLive(server, `ban-ip ${ip}${reason ? ` ${reason}` : ''}`);

export const pardonIp = (server, ip, actor) => mutateLive(server, `pardon-ip ${ip}`);

export async function kick(server, name, reason) {
  if (!(await isLive(server))) throw httpError(409, 'the server is not running');
  const out = await rconCommand(server, `kick ${name}${reason ? ` ${reason}` : ''}`);
  return { via: 'rcon', output: stripFormatting(out).trim() };
}
