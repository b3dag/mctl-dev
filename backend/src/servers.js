import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { config } from './config.js';
import { db, audit, getServer, listServers } from './db.js';
import {
  docker,
  ensureImage,
  ensureNetwork,
  ensureVolume,
  removeVolume,
  containerState,
  inspectSafe,
} from './docker.js';
import { syncRoutes } from './router.js';
import { dropRcon, isReady, playerList } from './rcon.js';
import { sanitizeEnv, RESERVED_ENV, SERVER_TYPES } from './envcatalog.js';

export const events = new EventEmitter();

/** In-memory view of what each server is doing right now. */
const runtime = new Map(); // id -> { running, state, phase, players, online, max, lastSeen }

export function stateOf(id) {
  return runtime.get(id) || { running: false, state: 'unknown', phase: 'stopped' };
}

export function allStates() {
  const out = {};
  for (const s of listServers()) out[s.id] = stateOf(s.id);
  return out;
}

function setState(id, patch) {
  const next = { ...stateOf(id), ...patch };
  runtime.set(id, next);
  events.emit('state', { id, state: next });
  return next;
}

export const slugify = (s) =>
  String(s)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);

// --- creation ---------------------------------------------------------------

function buildEnv(server) {
  const env = {
    EULA: 'TRUE',
    TYPE: server.type,
    VERSION: server.version,
    MEMORY: server.memory,
    ENABLE_RCON: 'TRUE',
    RCON_PASSWORD: server.rcon_password,
    RCON_PORT: '25575',
    SERVER_PORT: '25565',
    ...server.env,
  };
  if (server.seed) env.SEED = server.seed;
  return Object.entries(env).map(([k, v]) => `${k}=${v}`);
}

async function createContainer(server) {
  await ensureNetwork();
  await ensureVolume(server.volume_name, { 'mctl.serverId': server.id });
  await ensureImage(config.mcImage);

  // By default nothing is published — players arrive through mc-router. A
  // server with host_port set is additionally reachable at that port directly,
  // which is the escape hatch for setups without wildcard DNS.
  const publish = server.host_port
    ? {
        ExposedPorts: { '25565/tcp': {} },
        PortBindings: { '25565/tcp': [{ HostPort: String(server.host_port) }] },
      }
    : {};

  return docker.createContainer({
    name: server.container_name,
    Image: config.mcImage,
    Env: buildEnv(server),
    Tty: false,
    OpenStdin: false,
    ExposedPorts: publish.ExposedPorts,
    Labels: {
      'mctl.managed': 'true',
      'mctl.serverId': server.id,
      'mctl.hostname': server.hostname,
    },
    HostConfig: {
      Binds: [`${server.volume_name}:/data`],
      RestartPolicy: { Name: 'no' }, // lifecycle is ours, not Docker's
      NetworkMode: config.network,
      Memory: Math.round(parseMemory(server.memory) * 1.4), // heap + JVM overhead
      PortBindings: publish.PortBindings,
    },
    NetworkingConfig: {
      EndpointsConfig: {
        [config.network]: { Aliases: [server.container_name, server.slug] },
      },
    },
  });
}

/**
 * RCON is never published, so only the game port is ever exposed. Validate
 * against the router's own port and against the other servers rather than
 * letting Docker fail at start time with a bind error.
 */
export function validateHostPort(input, selfId = null) {
  if (input === null || input === undefined || input === '') return null;
  const port = Math.trunc(Number(input));
  if (!Number.isFinite(port) || port < 1024 || port > 65535)
    throw httpError(400, 'port must be between 1024 and 65535');
  if (port === config.publicMcPort)
    throw httpError(400, `port ${port} is already used by mc-router itself`);
  const clash = db
    .prepare('SELECT name FROM servers WHERE host_port = ? AND id IS NOT ?')
    .get(port, selfId);
  if (clash) throw httpError(409, `port ${port} is already used by "${clash.name}"`);
  return port;
}

function parseMemory(mem) {
  const m = String(mem).match(/^(\d+)\s*([GMgm])?$/);
  if (!m) return 2 * 1024 ** 3;
  const n = Number(m[1]);
  return (m[2] || 'G').toUpperCase() === 'G' ? n * 1024 ** 3 : n * 1024 ** 2;
}

export async function createServer(input, actor) {
  const name = String(input.name || '').trim();
  if (!name) throw httpError(400, 'name is required');
  const slug = slugify(input.slug || name);
  if (!slug) throw httpError(400, 'could not derive a slug from that name');
  if (db.prepare('SELECT 1 FROM servers WHERE slug = ?').get(slug))
    throw httpError(409, `slug "${slug}" is already taken`);

  const type = String(input.type || 'VANILLA').toUpperCase();
  if (!SERVER_TYPES.some((t) => t.value === type)) throw httpError(400, `unknown server type ${type}`);

  const id = crypto.randomUUID();
  const server = {
    id,
    name,
    slug,
    hostname: `${slug}.${config.domain}`.toLowerCase(),
    container_name: `mc-${slug}`,
    volume_name: `mctl-${slug}-data`,
    host_port: validateHostPort(input.host_port),
    type,
    version: String(input.version || 'LATEST'),
    memory: String(input.memory || config.defaultMemory),
    seed: input.seed ? String(input.seed) : null,
    rcon_password: crypto.randomBytes(18).toString('base64url'),
    env: JSON.stringify(sanitizeEnv(input.env)),
    autostart_on_join: input.autostart_on_join === false ? 0 : 1,
    idle_timeout_minutes: Number.isFinite(+input.idle_timeout_minutes)
      ? Math.max(0, Math.trunc(+input.idle_timeout_minutes))
      : 30,
    created_at: new Date().toISOString(),
    created_by: actor || null,
  };

  if (await inspectSafe(server.container_name))
    throw httpError(409, `container ${server.container_name} already exists`);

  db.prepare(
    `INSERT INTO servers (id,name,slug,hostname,container_name,volume_name,host_port,type,version,
       memory,seed,rcon_password,env,autostart_on_join,idle_timeout_minutes,created_at,created_by)
     VALUES (@id,@name,@slug,@hostname,@container_name,@volume_name,@host_port,@type,@version,
       @memory,@seed,@rcon_password,@env,@autostart_on_join,@idle_timeout_minutes,@created_at,@created_by)`
  ).run(server);

  const full = getServer(id);
  try {
    await createContainer(full);
  } catch (e) {
    db.prepare('DELETE FROM servers WHERE id = ?').run(id);
    throw e;
  }

  setState(id, { running: false, state: 'created', phase: 'stopped' });
  await syncRoutes(allStates());
  audit(actor, id, 'server.create', `${type} ${server.version} -> ${server.hostname}`);
  events.emit('servers');
  return full;
}

// --- lifecycle --------------------------------------------------------------

const starting = new Map(); // id -> Promise

export function startServer(id, actor) {
  if (starting.has(id)) return starting.get(id);
  const p = doStart(id, actor).finally(() => starting.delete(id));
  starting.set(id, p);
  return p;
}

async function doStart(id, actor) {
  const server = getServer(id);
  if (!server) throw httpError(404, 'no such server');

  const st = await containerState(server.container_name);
  if (!st.exists) await createContainer(server);
  if (st.running) return stateOf(id);

  setState(id, { phase: 'starting' });
  audit(actor, id, 'server.start');
  await docker.getContainer(server.container_name).start();
  setState(id, { running: true, state: 'running', phase: 'starting' });
  await syncRoutes(allStates());

  // Wait for RCON in the background; the route is already pointed at the
  // container so the player's reconnect lands in the right place.
  waitReady(server).catch(() => {});
  return stateOf(id);
}

async function waitReady(server) {
  const deadline = Date.now() + config.readyTimeoutMs;
  while (Date.now() < deadline) {
    const st = await containerState(server.container_name);
    if (!st.running) {
      setState(server.id, { running: false, state: st.state, phase: 'stopped' });
      await syncRoutes(allStates());
      return false;
    }
    if (await isReady(server)) {
      setState(server.id, { running: true, state: 'running', phase: 'ready' });
      touch(server.id);
      await syncRoutes(allStates());
      return true;
    }
    await sleep(3000);
  }
  setState(server.id, { phase: 'unhealthy' });
  return false;
}

export async function stopServer(id, actor, { reason } = {}) {
  const server = getServer(id);
  if (!server) throw httpError(404, 'no such server');
  const st = await containerState(server.container_name);
  if (!st.exists || !st.running) {
    setState(id, { running: false, state: st.state, phase: 'stopped' });
    await syncRoutes(allStates());
    return stateOf(id);
  }

  setState(id, { phase: 'stopping' });
  audit(actor, id, 'server.stop', reason);
  // Graceful: itzg's image traps SIGTERM and runs a clean `stop`.
  try {
    await docker.getContainer(server.container_name).stop({ t: 120 });
  } catch (e) {
    if (e.statusCode !== 304) throw e;
  }
  dropRcon(server.container_name);
  setState(id, { running: false, state: 'exited', phase: 'stopped', online: 0, players: [] });
  await syncRoutes(allStates());
  return stateOf(id);
}

export async function restartServer(id, actor) {
  await stopServer(id, actor, { reason: 'restart' });
  return startServer(id, actor);
}

/** Apply changed settings by recreating the container against the same volume. */
export async function recreateServer(id, actor) {
  const server = getServer(id);
  if (!server) throw httpError(404, 'no such server');
  const st = await containerState(server.container_name);
  const wasRunning = st.running;

  if (wasRunning) await stopServer(id, actor, { reason: 'recreate' });
  if (st.exists) {
    await docker.getContainer(server.container_name).remove({ force: true }).catch((e) => {
      if (e.statusCode !== 404) throw e;
    });
  }
  await createContainer(server);
  audit(actor, id, 'server.recreate');
  if (wasRunning) return startServer(id, actor);
  setState(id, { running: false, state: 'created', phase: 'stopped' });
  await syncRoutes(allStates());
  return stateOf(id);
}

export async function updateServer(id, patch, actor) {
  const server = getServer(id);
  if (!server) throw httpError(404, 'no such server');

  const fields = {};
  if (patch.name !== undefined) fields.name = String(patch.name).trim();
  if (patch.version !== undefined) fields.version = String(patch.version);
  if (patch.type !== undefined) {
    const t = String(patch.type).toUpperCase();
    if (!SERVER_TYPES.some((x) => x.value === t)) throw httpError(400, `unknown server type ${t}`);
    fields.type = t;
  }
  if (patch.memory !== undefined) fields.memory = String(patch.memory);
  if (patch.seed !== undefined) fields.seed = patch.seed ? String(patch.seed) : null;
  if (patch.autostart_on_join !== undefined) fields.autostart_on_join = patch.autostart_on_join ? 1 : 0;
  if (patch.idle_timeout_minutes !== undefined)
    fields.idle_timeout_minutes = Math.max(0, Math.trunc(+patch.idle_timeout_minutes) || 0);
  if (patch.env !== undefined) fields.env = JSON.stringify(sanitizeEnv(patch.env));

  // An empty string clears the override and falls back to <slug>.<DOMAIN>.
  if (patch.hostname !== undefined) {
    const override = patch.hostname === null || patch.hostname === '' ? null : normalizeHostname(patch.hostname);
    fields.hostname_override = override;
    fields.hostname = override || `${server.slug}.${config.domain}`.toLowerCase();
    const clash = db
      .prepare('SELECT name FROM servers WHERE hostname = ? AND id != ?')
      .get(fields.hostname, id);
    if (clash) throw httpError(409, `${fields.hostname} is already used by "${clash.name}"`);
  }

  if (patch.host_port !== undefined) {
    fields.host_port = validateHostPort(patch.host_port, id);
  }

  if (Object.keys(fields).length) {
    const sets = Object.keys(fields).map((k) => `${k} = @${k}`).join(', ');
    db.prepare(`UPDATE servers SET ${sets} WHERE id = @id`).run({ ...fields, id });
    audit(actor, id, 'server.update', Object.keys(fields).join(','));
  }

  // Port bindings are fixed at container creation, so changing one means
  // rebuilding the container against the same volume.
  const needsRecreate = ['type', 'version', 'memory', 'seed', 'env', 'host_port'].some(
    (k) => k in fields
  );
  const updated = getServer(id);
  if (needsRecreate && patch.apply !== false) await recreateServer(id, actor);
  else await syncRoutes(allStates());
  events.emit('servers');
  return { server: updated, recreated: needsRecreate && patch.apply !== false };
}

export async function deleteServer(id, { deleteVolume = true } = {}, actor) {
  const server = getServer(id);
  if (!server) throw httpError(404, 'no such server');

  dropRcon(server.container_name);
  const st = await containerState(server.container_name);
  if (st.exists) {
    await docker.getContainer(server.container_name).remove({ force: true, v: false }).catch((e) => {
      if (e.statusCode !== 404) throw e;
    });
  }
  if (deleteVolume) await removeVolume(server.volume_name);

  db.prepare('DELETE FROM servers WHERE id = ?').run(id);
  runtime.delete(id);
  await syncRoutes(allStates());
  audit(actor, id, 'server.delete', `${server.slug} volume=${deleteVolume}`);
  events.emit('servers');
  return { deleted: true, volumeRemoved: deleteVolume };
}

// --- status -----------------------------------------------------------------

export function touch(id) {
  const now = new Date().toISOString();
  db.prepare('UPDATE servers SET last_active_at = ? WHERE id = ?').run(now, id);
  setState(id, { lastSeen: now });
}

/** Refresh container + player state for one server. */
export async function refresh(server) {
  const st = await containerState(server.container_name);
  const prev = stateOf(server.id);
  const patch = { running: st.running, state: st.state, exists: st.exists };

  if (!st.running) {
    patch.phase = prev.phase === 'starting' ? 'starting' : 'stopped';
    if (!st.exists) patch.phase = 'missing';
    patch.online = 0;
    patch.players = [];
  } else {
    try {
      const list = await playerList(server);
      patch.phase = 'ready';
      patch.online = list.online;
      patch.max = list.max;
      patch.players = list.players;
      if (list.online > 0) touch(server.id);
    } catch {
      patch.phase = prev.phase === 'starting' ? 'starting' : 'unhealthy';
      patch.online = 0;
      patch.players = [];
    }
  }
  return setState(server.id, patch);
}

export async function refreshAll() {
  const servers = listServers();
  await Promise.all(servers.map((s) => refresh(s).catch(() => {})));
  return allStates();
}

/** A hostname label: letters, digits, hyphens, dot-separated. */
const HOSTNAME_RE = /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;

export function normalizeHostname(input) {
  const host = String(input || '')
    .trim()
    .toLowerCase()
    .replace(/^[a-z]+:\/\//, '') // tolerate a pasted URL
    .replace(/[:/].*$/, '') // and a trailing port or path
    .replace(/\.$/, '');
  if (!host) return null;
  if (!HOSTNAME_RE.test(host)) throw httpError(400, `"${input}" is not a valid hostname`);
  return host;
}

/** Where players connect: an explicit override, else `<slug>.<DOMAIN>`. */
export const effectiveHostname = (s) =>
  (s.hostname_override || `${s.slug}.${config.domain}`).toLowerCase();

/**
 * DOMAIN lives in .env and can change after servers exist, so re-derive
 * hostnames on boot. Servers with an explicit override keep it; the rest move
 * to the new domain, which makes changing DOMAIN a one-line edit plus restart.
 */
export function migrateHostnames() {
  const moved = [];
  for (const s of listServers()) {
    const expected = effectiveHostname(s);
    if (s.hostname === expected) continue;
    db.prepare('UPDATE servers SET hostname = ? WHERE id = ?').run(expected, s.id);
    audit('system', s.id, 'server.rehost', `${s.hostname} -> ${expected}`);
    moved.push(`${s.hostname} -> ${expected}`);
  }
  if (moved.length) {
    console.log(`[boot] DOMAIN changed, rehosted ${moved.length} server(s):`);
    for (const m of moved) console.log(`  ${m}`);
  }
  return moved;
}

/**
 * Called on boot: adopt whatever containers already exist, then make the
 * router's table match reality.
 */
export async function reconcile() {
  await ensureNetwork();
  migrateHostnames();
  for (const s of listServers()) {
    const st = await containerState(s.container_name);
    if (!st.exists) {
      // Recreate the definition so a stopped-and-pruned server still works.
      await createContainer(s).catch(() => {});
    }
  }
  await refreshAll();
  await syncRoutes(allStates());
}

/** Used by the waker: start and wait until RCON answers (or time out). */
export async function startAndWait(id, actor = 'waker') {
  await startServer(id, actor);
  const server = getServer(id);
  return waitReady(server);
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

export { RESERVED_ENV };
