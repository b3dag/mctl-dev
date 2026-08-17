import { Router } from 'express';
import { db, getServer, listServers, audit } from '../db.js';
import { ENV_CATALOG, SERVER_TYPES } from '../envcatalog.js';
import { routerAddress, directAddress } from '../settings.js';
import {
  createServer,
  startServer,
  stopServer,
  restartServer,
  recreateServer,
  updateServer,
  deleteServer,
  refresh,
  refreshAll,
  stateOf,
  allStates,
  httpError,
} from '../servers.js';
import { rconCommand, playerList } from '../rcon.js';
import { statsHistory, currentStats, diskUsage } from '../monitor.js';
import { containerState } from '../docker.js';
import { stripFormatting } from '../text.js';

export const router = Router();

export function loadServer(req, res, next) {
  const server = getServer(req.params.id);
  if (!server) return res.status(404).json({ error: 'no such server' });
  req.server = server;
  next();
}

const shape = (s) => ({
  id: s.id,
  name: s.name,
  slug: s.slug,
  hostname: s.hostname,
  hostnameOverride: s.hostname_override || '',
  hostPort: s.host_port || null,
  routerAddress: routerAddress(s),
  directAddress: directAddress(s),
  container: s.container_name,
  type: s.type,
  version: s.version,
  memory: s.memory,
  seed: s.seed,
  env: s.env,
  autostartOnJoin: !!s.autostart_on_join,
  idleTimeoutMinutes: s.idle_timeout_minutes,
  createdAt: s.created_at,
  lastActiveAt: s.last_active_at,
  state: stateOf(s.id),
});

router.get('/meta', (_req, res) => {
  res.json({ types: SERVER_TYPES, envCatalog: ENV_CATALOG });
});

router.get('/', (_req, res) => {
  res.json({ servers: listServers().map(shape) });
});

router.post('/', async (req, res, next) => {
  try {
    const server = await createServer(req.body || {}, req.user);
    if (req.body?.start) startServer(server.id, req.user).catch(() => {});
    res.status(201).json({ server: shape(server) });
  } catch (e) {
    next(e);
  }
});

router.post('/refresh', async (_req, res, next) => {
  try {
    res.json({ states: await refreshAll() });
  } catch (e) {
    next(e);
  }
});

router.get('/states', (_req, res) => res.json({ states: allStates() }));

router.get('/:id', loadServer, async (req, res, next) => {
  try {
    await refresh(req.server).catch(() => {});
    const container = await containerState(req.server.container_name);
    res.json({ server: shape(getServer(req.params.id)), container });
  } catch (e) {
    next(e);
  }
});

router.patch('/:id', loadServer, async (req, res, next) => {
  try {
    const result = await updateServer(req.params.id, req.body || {}, req.user);
    res.json({ server: shape(getServer(req.params.id)), recreated: result.recreated });
  } catch (e) {
    next(e);
  }
});

router.delete('/:id', loadServer, async (req, res, next) => {
  try {
    if (String(req.query.confirm || '') !== req.server.slug) {
      return res
        .status(400)
        .json({ error: `confirmation required: pass ?confirm=${req.server.slug}` });
    }
    const deleteVolume = String(req.query.keepData || '') !== 'true';
    res.json(await deleteServer(req.params.id, { deleteVolume }, req.user));
  } catch (e) {
    next(e);
  }
});

// --- lifecycle --------------------------------------------------------------

router.post('/:id/start', loadServer, async (req, res, next) => {
  try {
    res.json({ state: await startServer(req.params.id, req.user) });
  } catch (e) {
    next(e);
  }
});

router.post('/:id/stop', loadServer, async (req, res, next) => {
  try {
    // keepOff also turns wake-on-join off, so nothing brings it straight back.
    const state = await stopServer(req.params.id, req.user, {
      disableAutostart: req.body?.keepOff === true,
    });
    res.json({ state, server: shape(getServer(req.params.id)) });
  } catch (e) {
    next(e);
  }
});

router.post('/:id/restart', loadServer, async (req, res, next) => {
  try {
    res.json({ state: await restartServer(req.params.id, req.user) });
  } catch (e) {
    next(e);
  }
});

router.post('/:id/recreate', loadServer, async (req, res, next) => {
  try {
    res.json({ state: await recreateServer(req.params.id, req.user) });
  } catch (e) {
    next(e);
  }
});

// --- RCON -------------------------------------------------------------------

const BLOCKED = /^\s*(stop|restart)\b/i;

router.post('/:id/rcon', loadServer, async (req, res, next) => {
  try {
    const command = String(req.body?.command || '').trim();
    if (!command) throw httpError(400, 'command is required');
    if (BLOCKED.test(command))
      throw httpError(400, 'use the stop/restart buttons so the manager can track state');
    const output = await rconCommand(req.server, command);
    audit(req.user, req.server.id, 'rcon', command);
    res.json({ command, output: stripFormatting(output) });
  } catch (e) {
    next(e);
  }
});

router.get('/:id/players', loadServer, async (req, res, next) => {
  try {
    res.json(await playerList(req.server));
  } catch (e) {
    next(e);
  }
});

const player = (v) => {
  const name = String(v || '').trim();
  if (!/^[A-Za-z0-9_.]{1,32}$/.test(name)) throw httpError(400, `invalid player name: ${name}`);
  return name;
};

const PLAYER_ACTIONS = {
  kick: (n, reason) => `kick ${n}${reason ? ` ${reason}` : ''}`,
  ban: (n, reason) => `ban ${n}${reason ? ` ${reason}` : ''}`,
  pardon: (n) => `pardon ${n}`,
  op: (n) => `op ${n}`,
  deop: (n) => `deop ${n}`,
  'whitelist-add': (n) => `whitelist add ${n}`,
  'whitelist-remove': (n) => `whitelist remove ${n}`,
};

router.post('/:id/players/:action', loadServer, async (req, res, next) => {
  try {
    const build = PLAYER_ACTIONS[req.params.action];
    if (!build) throw httpError(404, `unknown action ${req.params.action}`);
    const name = player(req.body?.player);
    const reason = req.body?.reason ? String(req.body.reason).replace(/[\r\n]/g, ' ').slice(0, 120) : '';
    const output = await rconCommand(req.server, build(name, reason));
    audit(req.user, req.server.id, `player.${req.params.action}`, name);
    res.json({ output });
  } catch (e) {
    next(e);
  }
});

router.post('/:id/ban-ip', loadServer, async (req, res, next) => {
  try {
    const ip = String(req.body?.ip || '').trim();
    if (!/^[0-9a-fA-F:.]{3,45}$/.test(ip)) throw httpError(400, 'invalid IP address');
    const reason = req.body?.reason ? String(req.body.reason).replace(/[\r\n]/g, ' ').slice(0, 120) : '';
    const output = await rconCommand(req.server, `ban-ip ${ip}${reason ? ` ${reason}` : ''}`);
    audit(req.user, req.server.id, 'player.ban-ip', ip);
    res.json({ output });
  } catch (e) {
    next(e);
  }
});

router.get('/:id/whitelist', loadServer, async (req, res, next) => {
  try {
    res.json({ output: await rconCommand(req.server, 'whitelist list') });
  } catch (e) {
    next(e);
  }
});

// --- stats ------------------------------------------------------------------

router.get('/:id/stats', loadServer, async (req, res, next) => {
  try {
    const [current, disk] = await Promise.all([
      currentStats(req.server).catch(() => null),
      req.query.disk === 'true' ? diskUsage(req.server).catch(() => null) : Promise.resolve(undefined),
    ]);
    res.json({ current, history: statsHistory(req.server.id), disk });
  } catch (e) {
    next(e);
  }
});

router.get('/:id/audit', loadServer, (req, res) => {
  res.json({
    entries: db
      .prepare('SELECT * FROM audit_log WHERE server_id = ? ORDER BY id DESC LIMIT 200')
      .all(req.params.id),
  });
});
