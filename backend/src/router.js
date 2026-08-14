import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';
import { listServers } from './db.js';

/**
 * mc-router keeps its mapping in two places we care about:
 *   1. the routes config file it watches (survives a router restart)
 *   2. its REST API (takes effect immediately)
 * We write the file first, then reconcile through the API so changes are live
 * without restarting the router.
 */

let lastError = null;
export const routerStatus = () => ({ api: config.routerApi, lastError });

async function api(method, urlPath, body) {
  const res = await fetch(config.routerApi + urlPath, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`mc-router ${method} ${urlPath} -> ${res.status} ${await res.text()}`);
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

/** Where a hostname should currently point. */
export function backendFor(server, running) {
  if (running) return `${server.container_name}:25565`;
  // Stopped but wake-on-join enabled: park the hostname on the waker so a join
  // attempt can boot the container. Otherwise leave it unmapped.
  return server.autostart_on_join ? config.wakerTarget : null;
}

export function buildMappings(states) {
  const mappings = {};
  for (const s of listServers()) {
    const target = backendFor(s, !!states[s.id]?.running);
    if (target) mappings[s.hostname] = target;
  }
  return mappings;
}

/**
 * GET /routes returns `{host: "backend:port"}` on older mc-router builds and
 * `{host: {backend, scalingTarget}}` on newer ones. Flatten to plain strings.
 */
function normalizeRoutes(raw) {
  const out = {};
  for (const [host, value] of Object.entries(raw || {})) {
    out[host] = typeof value === 'string' ? value : value?.backend || '';
  }
  return out;
}

async function writeRoutesFile(mappings) {
  await fs.mkdir(path.dirname(config.routesFile), { recursive: true });
  const tmp = config.routesFile + '.tmp';
  // The waker doubles as the default route so unknown hostnames get a readable
  // "no such server" disconnect instead of a dropped connection. mc-router also
  // needs a default route to exist before its API will persist route changes.
  await fs.writeFile(
    tmp,
    JSON.stringify({ mappings, defaultServer: config.wakerTarget }, null, 2)
  );
  await fs.rename(tmp, config.routesFile);
}

async function reconcileApi(mappings) {
  let current;
  try {
    current = normalizeRoutes(await api('GET', '/routes'));
  } catch (e) {
    lastError = e.message;
    throw e;
  }
  for (const [host, backend] of Object.entries(mappings)) {
    if (current[host] !== backend) {
      await api('POST', '/routes', { serverAddress: host, backend });
    }
  }
  for (const host of Object.keys(current)) {
    if (!(host in mappings)) {
      await api('DELETE', `/routes/${encodeURIComponent(host)}`).catch(() => {});
    }
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const sameRoutes = (a, b) => {
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  return ka.length === kb.length && ka.every((k) => a[k] === b[k]);
};

/** Has mc-router's watcher caught up with the file we just wrote? */
async function awaitConvergence(mappings, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (sameRoutes(normalizeRoutes(await api('GET', '/routes')), mappings)) return true;
    } catch {
      return false;
    }
    await sleep(300);
  }
  return false;
}

let queue = Promise.resolve();

/** Serialised so concurrent lifecycle events can't interleave route writes. */
export function syncRoutes(states) {
  queue = queue.then(async () => {
    const mappings = buildMappings(states);
    try {
      await writeRoutesFile(mappings);
    } catch (e) {
      lastError = `routes file: ${e.message}`;
    }
    try {
      // The config watcher normally applies this within milliseconds. If it
      // doesn't (watch disabled, fsnotify unavailable on the volume), push the
      // same mapping through the REST API so routing is never left stale.
      if (await awaitConvergence(mappings)) lastError = null;
      else {
        await reconcileApi(mappings);
        lastError = null;
      }
    } catch (e) {
      lastError = e.message;
    }
    return mappings;
  });
  return queue;
}

export async function currentRoutes() {
  try {
    return normalizeRoutes(await api('GET', '/routes'));
  } catch (e) {
    lastError = e.message;
    return null;
  }
}
