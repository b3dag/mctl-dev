import { Router } from 'express';
import { config } from '../config.js';
import { docker } from '../docker.js';
import { currentRoutes, routerStatus, syncRoutes, buildMappings } from '../router.js';
import { allStates, refreshAll, stateOf, migrateHostnames } from '../servers.js';
import { db, listServers } from '../db.js';
import { inspectSafe } from '../docker.js';
import { getSettings, saveSettings, getDomain, getPublicHost } from '../settings.js';

export const router = Router();

router.get('/me', (req, res) => {
  res.json({
    email: req.user,
    domain: getDomain(),
    publicHost: getPublicHost(),
    publicMcPort: config.publicMcPort,
  });
});

router.get('/settings', (_req, res) => {
  res.json({ settings: getSettings(), publicMcPort: config.publicMcPort });
});

router.put('/settings', async (req, res, next) => {
  try {
    const { settings, changed } = saveSettings(req.body || {}, req.user);
    // Hostnames are derived from the domain, so a change has to propagate to
    // every server and then to the router's table.
    let rehosted = [];
    if (changed.includes('domain')) {
      rehosted = migrateHostnames();
      await refreshAll();
      await syncRoutes(allStates());
    }
    res.json({ settings, changed, rehosted });
  } catch (e) {
    next(e);
  }
});

/**
 * Everything that is or isn't reachable, in one place: the shared router port,
 * per-server direct ports, and the internal-only ones people ask about (RCON,
 * the waker) so it's clear they are not exposed.
 */
router.get('/ports', async (_req, res, next) => {
  try {
    const servers = listServers();

    // Cross-check the database against what Docker actually has bound, so a
    // container that predates a port change shows up as needing a restart.
    const entries = await Promise.all(
      servers.map(async (s) => {
        const info = await inspectSafe(s.container_name);
        const bound = info?.HostConfig?.PortBindings?.['25565/tcp']?.[0]?.HostPort;
        const actual = bound ? Number(bound) : null;
        return {
          id: s.id,
          name: s.name,
          slug: s.slug,
          hostname: s.hostname,
          hostPort: s.host_port || null,
          actualPort: actual,
          pendingRestart: (s.host_port || null) !== actual,
          running: !!stateOf(s.id).running,
          address: s.host_port ? `${getPublicHost()}:${s.host_port}` : s.hostname,
        };
      })
    );

    const duplicates = {};
    for (const e of entries) {
      if (!e.hostPort) continue;
      (duplicates[e.hostPort] ||= []).push(e.name);
    }

    res.json({
      publicHost: getPublicHost(),
      shared: { port: config.publicMcPort, description: 'mc-router, shared by every hostname' },
      internal: [
        { port: 25565, scope: 'each server', description: 'game port, internal network only' },
        { port: 25575, scope: 'each server', description: 'RCON, never published' },
        { port: config.wakerPort, scope: 'manager', description: 'waker, reached by mc-router only' },
        { port: config.port, scope: 'manager', description: 'web UI, served through the tunnel' },
      ],
      servers: entries,
      conflicts: Object.entries(duplicates)
        .filter(([, names]) => names.length > 1)
        .map(([port, names]) => ({ port: Number(port), servers: names })),
    });
  } catch (e) {
    next(e);
  }
});

router.get('/health', async (_req, res) => {
  const out = { ok: true, docker: false, router: routerStatus() };
  try {
    await docker.ping();
    out.docker = true;
  } catch (e) {
    out.ok = false;
    out.dockerError = e.message;
  }
  res.json(out);
});

router.get('/router', async (_req, res) => {
  res.json({
    status: routerStatus(),
    live: await currentRoutes(),
    expected: buildMappings(allStates()),
    wakerTarget: config.wakerTarget,
  });
});

router.post('/router/sync', async (_req, res, next) => {
  try {
    await refreshAll();
    res.json({ mappings: await syncRoutes(allStates()) });
  } catch (e) {
    next(e);
  }
});

router.get('/audit', (req, res) => {
  res.json({
    entries: db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT ?').all(Number(req.query.limit) || 100),
  });
});
