import { Router } from 'express';
import { config } from '../config.js';
import { docker } from '../docker.js';
import { currentRoutes, routerStatus, syncRoutes, buildMappings } from '../router.js';
import { allStates, refreshAll } from '../servers.js';
import { db } from '../db.js';

export const router = Router();

router.get('/me', (req, res) => {
  res.json({ email: req.user, domain: config.domain });
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
