import { db, audit } from './db.js';
import { config } from './config.js';
import { detectLanIp } from './docker.js';

/**
 * Settings live in the database so they can be changed from the UI, and fall
 * back to the environment so a fresh install works from .env alone. The
 * environment is only ever a default: once a value is set here it wins.
 */

db.exec(`
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`);

const read = (key) => db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value ?? null;

const write = (key, value) => {
  if (value === null || value === '') db.prepare('DELETE FROM settings WHERE key = ?').run(key);
  else
    db.prepare(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
    ).run(key, String(value));
};

export const getDomain = () => (read('domain') || config.domain).toLowerCase();

/**
 * The direct-connect address needs something players can actually open a raw
 * TCP connection to. The domain usually isn't that: it is typically
 * Cloudflare-proxied for the web UI, which doesn't proxy an arbitrary game
 * port. So the fallback here reaches for a real IP before ever reaching for
 * the domain. Both the public IP and the host's own LAN IP are detected,
 * refreshed periodically since either can change under you (a home
 * connection's public IP, or DHCP renewing the LAN one).
 */
let detectedIp = null;
let detectedLanIp = null;

async function refreshDetectedIp() {
  try {
    const res = await fetch('https://api.ipify.org?format=text', { signal: AbortSignal.timeout(5000) });
    if (res.ok) {
      const ip = (await res.text()).trim();
      if (/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) detectedIp = ip;
    }
  } catch {
    /* offline, or outbound blocked; keep whatever was last detected */
  }
  detectedLanIp = (await detectLanIp()) || detectedLanIp;
}

export function startIpDetection() {
  refreshDetectedIp();
  const t = setInterval(refreshDetectedIp, 15 * 60 * 1000);
  t.unref?.();
  return t;
}

/** Where directly published servers are advertised: set here, PUBLIC_HOST, the detected IP, or last the domain. */
export const getPublicHost = () => read('publicHost') || config.publicHost || detectedIp || getDomain();

const publicHostSource = () => {
  if (read('publicHost') !== null) return 'set here';
  if (config.publicHost) return 'PUBLIC_HOST';
  if (detectedIp) return 'detected automatically';
  return 'the base domain, until an IP is detected';
};

const HOSTNAME_RE = /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/;

/** Accepts a hostname or a bare IP, tolerating a pasted URL or trailing port. */
export function normalizeHost(input, label) {
  const host = String(input ?? '')
    .trim()
    .toLowerCase()
    .replace(/^[a-z]+:\/\//, '')
    .replace(/[:/].*$/, '')
    .replace(/\.$/, '');
  if (!host) return null;
  const isIp = /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
  if (!isIp && !HOSTNAME_RE.test(host)) {
    const e = new Error(`${label} "${input}" is not a valid hostname or IP address`);
    e.status = 400;
    throw e;
  }
  return host;
}

/**
 * A server is reachable two ways at once: always by hostname through
 * mc-router, and additionally on its own host port if one is set. Both are
 * derived here so every view agrees on what to tell players.
 */
export const routerAddress = (server) =>
  config.publicMcPort === 25565 ? server.hostname : `${server.hostname}:${config.publicMcPort}`;

export const directAddress = (server) =>
  server.host_port ? `${getPublicHost()}:${server.host_port}` : null;

/** Same port, but the host's LAN IP instead of its public one, for players on the same network. */
export const lanAddress = (server) =>
  server.host_port && detectedLanIp ? `${detectedLanIp}:${server.host_port}` : null;

/** A webhook (Discord-compatible) that crashes, backup failures and low disk space get posted to. Empty means off. */
export const getWebhookUrl = () => read('webhookUrl') || '';

function normalizeWebhookUrl(input) {
  const url = String(input ?? '').trim();
  if (!url) return null;
  // https for Discord and most public webhook services; http tolerated too,
  // for a self-hosted receiver (ntfy, Home Assistant, ...) on the local network.
  if (!/^https?:\/\//i.test(url)) {
    const e = new Error('Webhook URL must start with http:// or https://');
    e.status = 400;
    throw e;
  }
  return url;
}

export function getSettings() {
  return {
    domain: getDomain(),
    publicHost: getPublicHost(),
    domainFromEnv: read('domain') === null,
    publicHostFromEnv: read('publicHost') === null,
    publicHostSource: publicHostSource(),
    detectedIp,
    detectedLanIp,
    envDomain: config.domain,
    webhookUrl: getWebhookUrl(),
  };
}

/**
 * Returns which keys actually changed, so the caller only re-derives hostnames
 * and rewrites the router table when it needs to.
 */
export function saveSettings(patch, actor) {
  const before = {
    domain: getDomain(),
    publicHost: getPublicHost(),
    webhookUrl: getWebhookUrl(),
  };

  if (patch.domain !== undefined) write('domain', normalizeHost(patch.domain, 'Domain'));
  if (patch.publicHost !== undefined) write('publicHost', normalizeHost(patch.publicHost, 'Public host'));
  if (patch.webhookUrl !== undefined) write('webhookUrl', normalizeWebhookUrl(patch.webhookUrl));
  const after = {
    domain: getDomain(),
    publicHost: getPublicHost(),
    webhookUrl: getWebhookUrl(),
  };
  const changed = Object.keys(after).filter((k) => after[k] !== before[k]);
  if (changed.length) audit(actor, null, 'settings.update', changed.map((k) => `${k}=${after[k]}`).join(' '));
  return { settings: getSettings(), changed };
}
