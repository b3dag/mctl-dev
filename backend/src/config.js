import path from 'node:path';

const bool = (v, d = false) => (v === undefined || v === '' ? d : /^(1|true|yes|on)$/i.test(v));

export const config = {
  port: Number(process.env.PORT || 8080),
  wakerPort: Number(process.env.WAKER_PORT || 25566),

  domain: process.env.DOMAIN || 'localhost',
  network: process.env.MC_NETWORK || 'mctl-net',

  // The host port mc-router itself is published on. Servers may not claim it,
  // and the ports view shows it alongside any directly published servers.
  publicMcPort: Number(process.env.PUBLIC_MC_PORT || 25565),
  // Hostname or IP players use for directly published servers. Falls back to
  // the domain, which is right for a single-host setup.
  publicHost: process.env.PUBLIC_HOST || process.env.DOMAIN || 'localhost',

  routerApi: process.env.ROUTER_API || 'http://mc-router:8080',
  routesFile: process.env.ROUTES_FILE || '/routes/routes.json',
  wakerTarget: process.env.WAKER_TARGET || 'mctl-manager:25566',

  mcImage: process.env.MC_IMAGE || 'itzg/minecraft-server:latest',
  helperImage: process.env.HELPER_IMAGE || 'alpine:3.20',
  defaultMemory: process.env.DEFAULT_MEMORY || '2G',

  dataDir: process.env.DATA_DIR || path.resolve('data'),
  backupDir: process.env.BACKUP_DIR || path.resolve('backups'),
  publicDir: process.env.PUBLIC_DIR || path.resolve('public'),

  requireCfAccess: bool(process.env.REQUIRE_CF_ACCESS, true),
  allowedEmails: (process.env.ALLOWED_EMAILS || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
  devUser: process.env.DEV_USER || '',

  curseforgeKey: process.env.CF_API_KEY || '',

  // How long to wait for a freshly started server to answer RCON, in ms.
  readyTimeoutMs: Number(process.env.READY_TIMEOUT_MS || 300000),
  // Poll interval for the idle/health monitor.
  monitorIntervalMs: Number(process.env.MONITOR_INTERVAL_MS || 60000),
};

export const rconPassword = process.env.RCON_PASSWORD_DEFAULT || 'mctl-internal';
