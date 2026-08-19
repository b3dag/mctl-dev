import { readFileFromContainer, writeFileToContainer, containerState, volumeOwner } from './docker.js';
import { rconCommand } from './rcon.js';
import { stateOf, httpError } from './servers.js';
import { db } from './db.js';
import { stripFormatting } from './text.js';

/**
 * Whitelist, operators and bans.
 *
 * Minecraft keeps all four as JSON next to the world, and RCON edits them live.
 * So: read from the files, which works whether or not the server is running,
 * and write through RCON when it is, because that applies immediately and lets
 * the server own the file. Only when the server is stopped do we edit the JSON
 * ourselves, which is what makes it possible to prepare a whitelist in advance.
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
 * Resolve a name to a UUID, needed only when editing the files directly. A
 * running server does this itself, so this is the offline path.
 */
async function lookupUuid(name) {
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

const stamp = () => new Date().toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' +0000');

/**
 * Every mutation takes the same shape: if the server is up, let it do the work
 * over RCON; if not, edit the file so the change is waiting when it starts.
 */
async function mutate(server, { command, file, apply, actor }) {
  if (await isLive(server)) {
    const out = await rconCommand(server, command);
    return { via: 'rcon', output: stripFormatting(out).trim() };
  }
  const list = await readJson(server, file);
  const next = await apply(list);
  await writeJson(server, file, next);
  return { via: 'file', output: 'Applied to the file; it takes effect when the server starts.' };
}

export const addToWhitelist = (server, name, actor) =>
  mutate(server, {
    command: `whitelist add ${name}`,
    file: FILES.whitelist,
    actor,
    apply: async (list) => {
      if (list.some((e) => e.name?.toLowerCase() === name.toLowerCase())) return list;
      const profile = await lookupUuid(name);
      return [...list, profile];
    },
  });

export const removeFromWhitelist = (server, name, actor) =>
  mutate(server, {
    command: `whitelist remove ${name}`,
    file: FILES.whitelist,
    actor,
    apply: async (list) => list.filter((e) => e.name?.toLowerCase() !== name.toLowerCase()),
  });

/**
 * Enforcement lives in server.properties rather than a JSON list, so the
 * offline path edits that instead. The stored ENABLE_WHITELIST is kept in step
 * at the same time, because the image rewrites server.properties from the
 * environment whenever the container is recreated and would otherwise undo it.
 */
/**
 * Enforcement lives in server.properties rather than a JSON list, so the
 * offline path edits that file instead.
 */
export const setWhitelistEnabled = async (server, enabled) => {
  if (await isLive(server)) {
    const out = await rconCommand(server, `whitelist ${enabled ? 'on' : 'off'}`);
    return { via: 'rcon', output: stripFormatting(out).trim() };
  }

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

  // The image rewrites server.properties from the environment on recreate, so
  // the stored value has to agree or the next rebuild would undo this.
  const env = { ...(server.env || {}), ENABLE_WHITELIST: String(enabled) };
  db.prepare('UPDATE servers SET env = ? WHERE id = ?').run(JSON.stringify(env), server.id);

  return {
    via: 'file',
    output: `Whitelist enforcement ${enabled ? 'on' : 'off'} from the next start.`,
  };
};

export const addOp = (server, name, level, actor) =>
  mutate(server, {
    command: `op ${name}`,
    file: FILES.ops,
    actor,
    apply: async (list) => {
      const profile =
        list.find((e) => e.name?.toLowerCase() === name.toLowerCase()) || (await lookupUuid(name));
      const rest = list.filter((e) => e.name?.toLowerCase() !== name.toLowerCase());
      return [
        ...rest,
        {
          uuid: profile.uuid,
          name: profile.name,
          level: level ?? 4,
          bypassesPlayerLimit: false,
        },
      ];
    },
  });

export const removeOp = (server, name, actor) =>
  mutate(server, {
    command: `deop ${name}`,
    file: FILES.ops,
    actor,
    apply: async (list) => list.filter((e) => e.name?.toLowerCase() !== name.toLowerCase()),
  });

export const banPlayer = (server, name, reason, actor) =>
  mutate(server, {
    command: `ban ${name}${reason ? ` ${reason}` : ''}`,
    file: FILES.bannedPlayers,
    actor,
    apply: async (list) => {
      if (list.some((e) => e.name?.toLowerCase() === name.toLowerCase())) return list;
      const profile = await lookupUuid(name);
      return [
        ...list,
        {
          uuid: profile.uuid,
          name: profile.name,
          created: stamp(),
          source: actor || 'mctl',
          expires: 'forever',
          reason: reason || 'Banned by an operator.',
        },
      ];
    },
  });

export const pardonPlayer = (server, name, actor) =>
  mutate(server, {
    command: `pardon ${name}`,
    file: FILES.bannedPlayers,
    actor,
    apply: async (list) => list.filter((e) => e.name?.toLowerCase() !== name.toLowerCase()),
  });

export const banIp = (server, ip, reason, actor) =>
  mutate(server, {
    command: `ban-ip ${ip}${reason ? ` ${reason}` : ''}`,
    file: FILES.bannedIps,
    actor,
    apply: async (list) => {
      if (list.some((e) => e.ip === ip)) return list;
      return [
        ...list,
        {
          ip,
          created: stamp(),
          source: actor || 'mctl',
          expires: 'forever',
          reason: reason || 'Banned by an operator.',
        },
      ];
    },
  });

export const pardonIp = (server, ip, actor) =>
  mutate(server, {
    command: `pardon-ip ${ip}`,
    file: FILES.bannedIps,
    actor,
    apply: async (list) => list.filter((e) => e.ip !== ip),
  });

export async function kick(server, name, reason) {
  if (!(await isLive(server))) throw httpError(409, 'the server is not running');
  const out = await rconCommand(server, `kick ${name}${reason ? ` ${reason}` : ''}`);
  return { via: 'rcon', output: stripFormatting(out).trim() };
}
