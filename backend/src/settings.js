import { db, audit } from './db.js';
import { config } from './config.js';

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

/** Where directly published servers are advertised. Defaults to the domain. */
export const getPublicHost = () => read('publicHost') || config.publicHost || getDomain();

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

export function getSettings() {
  return {
    domain: getDomain(),
    publicHost: getPublicHost(),
    domainFromEnv: read('domain') === null,
    publicHostFromEnv: read('publicHost') === null,
    envDomain: config.domain,
  };
}

/**
 * Returns which keys actually changed, so the caller only re-derives hostnames
 * and rewrites the router table when it needs to.
 */
export function saveSettings(patch, actor) {
  const before = { domain: getDomain(), publicHost: getPublicHost() };

  if (patch.domain !== undefined) write('domain', normalizeHost(patch.domain, 'Domain'));
  if (patch.publicHost !== undefined) write('publicHost', normalizeHost(patch.publicHost, 'Public host'));

  const after = { domain: getDomain(), publicHost: getPublicHost() };
  const changed = Object.keys(after).filter((k) => after[k] !== before[k]);
  if (changed.length) audit(actor, null, 'settings.update', changed.map((k) => `${k}=${after[k]}`).join(' '));
  return { settings: getSettings(), changed };
}
