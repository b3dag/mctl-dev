import { Router } from 'express';
import { db, getServer, listServers, audit } from '../db.js';
import { ENV_CATALOG, SERVER_TYPES } from '../envcatalog.js';
import { routerAddress, directAddress, lanAddress } from '../settings.js';
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
} from '../servers.js';
import { stateOf, allStates } from '../state.js';
import { httpError } from '../errors.js';
import { rconCommand, playerList } from '../rcon.js';
import { statsHistory, currentStats, diskUsage } from '../monitor.js';
import { containerState } from '../docker.js';
import { stripFormatting } from '../text.js';
import * as lists from '../playerlists.js';

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
  lanAddress: lanAddress(s),
  container: s.container_name,
  type: s.type,
  version: s.version,
  memory: s.memory,
  seed: s.seed,
  env: s.env,
  autostartOnJoin: !!s.autostart_on_join,
  idleTimeoutMinutes: s.idle_timeout_minutes,
  stopWarningSeconds: s.stop_warning_seconds ?? 30,
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

// --- whitelist, operators and bans ------------------------------------------

/**
 * The whitelist is always written to its file, then reloaded live if the
 * server happens to be running. Operators and bans have no such reload
 * command in vanilla, so they only ever apply over RCON and need the server
 * up; there is no file equivalent for those.
 */
router.get('/:id/players/lists', loadServer, async (req, res, next) => {
  try {
    res.json(await lists.readLists(req.server));
  } catch (e) {
    next(e);
  }
});

const reason = (v) => (v ? String(v).replace(/[\r\n]/g, " ").slice(0, 120) : "");

function record(req, action, detail) {
  audit(req.user, req.server.id, action, detail);
}

router.post('/:id/players/kick', loadServer, async (req, res, next) => {
  try {
    const name = lists.validName(req.body?.player);
    const out = await lists.kick(req.server, name, reason(req.body?.reason));
    record(req, 'player.kick', name);
    res.json(out);
  } catch (e) {
    next(e);
  }
});

router.post('/:id/whitelist', loadServer, async (req, res, next) => {
  try {
    const name = lists.validName(req.body?.player);
    const out = await lists.addToWhitelist(req.server, name, req.user);
    record(req, 'whitelist.add', `${name} via ${out.via}`);
    res.json(out);
  } catch (e) {
    next(e);
  }
});

router.delete('/:id/whitelist/:player', loadServer, async (req, res, next) => {
  try {
    const name = lists.validName(req.params.player);
    const out = await lists.removeFromWhitelist(req.server, name, req.user);
    record(req, 'whitelist.remove', `${name} via ${out.via}`);
    res.json(out);
  } catch (e) {
    next(e);
  }
});

router.put('/:id/whitelist/enabled', loadServer, async (req, res, next) => {
  try {
    const enabled = req.body?.enabled === true;
    const out = await lists.setWhitelistEnabled(req.server, enabled);
    record(req, 'whitelist.enabled', String(enabled));
    res.json(out);
  } catch (e) {
    next(e);
  }
});

router.post('/:id/ops', loadServer, async (req, res, next) => {
  try {
    const name = lists.validName(req.body?.player);
    const out = await lists.addOp(req.server, name, req.user);
    record(req, 'op.add', `${name} via ${out.via}`);
    res.json(out);
  } catch (e) {
    next(e);
  }
});

router.delete('/:id/ops/:player', loadServer, async (req, res, next) => {
  try {
    const name = lists.validName(req.params.player);
    const out = await lists.removeOp(req.server, name, req.user);
    record(req, 'op.remove', `${name} via ${out.via}`);
    res.json(out);
  } catch (e) {
    next(e);
  }
});

router.post('/:id/bans', loadServer, async (req, res, next) => {
  try {
    const name = lists.validName(req.body?.player);
    const out = await lists.banPlayer(req.server, name, reason(req.body?.reason), req.user);
    record(req, 'ban.add', `${name} via ${out.via}`);
    res.json(out);
  } catch (e) {
    next(e);
  }
});

router.delete('/:id/bans/:player', loadServer, async (req, res, next) => {
  try {
    const name = lists.validName(req.params.player);
    const out = await lists.pardonPlayer(req.server, name, req.user);
    record(req, 'ban.remove', `${name} via ${out.via}`);
    res.json(out);
  } catch (e) {
    next(e);
  }
});

router.post('/:id/ban-ips', loadServer, async (req, res, next) => {
  try {
    const ip = lists.validIp(req.body?.ip);
    const out = await lists.banIp(req.server, ip, reason(req.body?.reason), req.user);
    record(req, 'banip.add', `${ip} via ${out.via}`);
    res.json(out);
  } catch (e) {
    next(e);
  }
});

router.delete('/:id/ban-ips/:ip', loadServer, async (req, res, next) => {
  try {
    const ip = lists.validIp(req.params.ip);
    const out = await lists.pardonIp(req.server, ip, req.user);
    record(req, 'banip.remove', `${ip} via ${out.via}`);
    res.json(out);
  } catch (e) {
    next(e);
  }
});

// --- stats ------------------------------------------------------------------

router.get('/:id/stats', loadServer, async (req, res, next) => {
  try {
    const minutes = Math.min(Math.max(Number(req.query.minutes) || 10, 1), 24 * 60);
    const [current, disk] = await Promise.all([
      currentStats(req.server).catch(() => null),
      req.query.disk === 'true' ? diskUsage(req.server).catch(() => null) : Promise.resolve(undefined),
    ]);
    res.json({ current, history: statsHistory(req.server.id, minutes * 60000), disk });
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
