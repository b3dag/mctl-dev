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
  // Hostname or IP players use for directly published servers, only when set
  // explicitly. Left unset, settings.js falls back to an auto-detected public
  // IP rather than the domain, which is usually Cloudflare-proxied and not
  // actually reachable on an arbitrary game port.
  publicHost: process.env.PUBLIC_HOST || null,

  routerApi: process.env.ROUTER_API || 'http://mc-router:8080',
  routesFile: process.env.ROUTES_FILE || '/routes/routes.json',
  wakerTarget: process.env.WAKER_TARGET || 'mctl-manager:25566',

  mcImage: process.env.MC_IMAGE || 'itzg/minecraft-server:latest',
  helperImage: process.env.HELPER_IMAGE || 'alpine:3.20',
  resticImage: process.env.RESTIC_IMAGE || 'restic/restic:latest',
  // Our own image, re-used as a helper container for UPnP: the router lives
  // on the LAN rather than the internal Docker network, so that call has to
  // run with host networking (like detectLanIp), and only our own image has
  // the port-mapping library available to it.
  selfImage: process.env.SELF_IMAGE || 'mctl-manager:latest',
  defaultMemory: process.env.DEFAULT_MEMORY || '2G',

  // Docker's json-file driver keeps every line forever by default, which
  // quietly fills the host disk on a long-running server.
  logMaxSize: process.env.CONTAINER_LOG_MAX_SIZE || '10m',
  logMaxFile: process.env.CONTAINER_LOG_MAX_FILE || '3',

  dataDir: process.env.DATA_DIR || path.resolve('data'),
  backupDir: process.env.BACKUP_DIR || path.resolve('backups'),
  // Helper containers mount the backups volume by name, so they need the
  // Docker volume rather than the path it appears at inside the manager.
  backupVolume: process.env.BACKUP_VOLUME || 'mctl_backups',
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
