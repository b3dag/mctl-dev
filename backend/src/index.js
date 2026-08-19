import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import express from 'express';
import { config } from './config.js';
import { requireAuth } from './auth.js';
import { ping as dockerPing } from './docker.js';
import { reconcile } from './servers.js';
import { startMonitor } from './monitor.js';
import { initBackups } from './backups.js';
import { startWaker } from './waker.js';
import { startIpDetection } from './settings.js';
import { attachWebsockets } from './ws.js';
import { router as serverRoutes } from './routes/servers.js';
import { router as fileRoutes } from './routes/files.js';
import { router as backupRoutes } from './routes/backups.js';
import { router as modRoutes } from './routes/mods.js';
import { router as systemRoutes } from './routes/system.js';

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true);
app.use(express.json({ limit: '5mb' }));

app.get('/healthz', (_req, res) => res.json({ ok: true }));

const api = express.Router();
api.use(requireAuth);
api.use('/', systemRoutes);
api.use('/servers', serverRoutes);
api.use('/servers', fileRoutes);
api.use('/servers', backupRoutes);
api.use('/servers', modRoutes);
app.use('/api', api);

// SPA
if (fs.existsSync(config.publicDir)) {
  app.use(express.static(config.publicDir, { index: false, maxAge: '1h' }));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api/')) return next();
    res.sendFile(path.join(config.publicDir, 'index.html'));
  });
}

app.use((req, res) => res.status(404).json({ error: 'not found', path: req.path }));

app.use((err, _req, res, _next) => {
  const status = err.status || err.statusCode || 500;
  if (status >= 500) console.error('[api]', err);
  if (res.headersSent) return res.end();
  res.status(status).json({ error: err.message || 'internal error' });
});

const server = http.createServer(app);
attachWebsockets(server);

async function main() {
  try {
    await dockerPing();
    console.log('[boot] Docker socket OK');
  } catch (e) {
    console.error('[boot] cannot reach the Docker socket:', e.message);
    console.error('[boot] mount /var/run/docker.sock into this container');
    process.exit(1);
  }

  await initBackups();
  await reconcile().catch((e) => console.error('[boot] reconcile failed:', e.message));
  startMonitor();
  startWaker();
  startIpDetection();

  server.listen(config.port, '0.0.0.0', () => {
    console.log(`[boot] manager API on :${config.port}`);
    console.log(`[boot] domain ${config.domain}, network ${config.network}`);
    if (!config.requireCfAccess) console.warn('[boot] Cloudflare Access enforcement is OFF');
  });
}

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    console.log(`[boot] ${sig} - shutting down`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  });
}

main();
