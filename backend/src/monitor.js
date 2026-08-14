import { config } from './config.js';
import { db, listServers, audit } from './db.js';
import { sampleStats, containerState, runHelper } from './docker.js';
import { refresh, stateOf, stopServer, events, allStates } from './servers.js';
import { buildMappings, currentRoutes, syncRoutes } from './router.js';

/** Ring buffer of resource samples per server, for the graphs. */
const HISTORY = 180; // ~3h at one sample/min
const history = new Map(); // id -> [{at,cpuPercent,memUsed,memLimit}]

export function statsHistory(id) {
  return history.get(id) || [];
}

function push(id, sample) {
  const arr = history.get(id) || [];
  arr.push(sample);
  if (arr.length > HISTORY) arr.splice(0, arr.length - HISTORY);
  history.set(id, arr);
}

const idleSince = new Map(); // id -> ms timestamp when the server went empty

async function tick() {
  for (const server of listServers()) {
    try {
      const st = await refresh(server);

      if (!st.running) {
        idleSince.delete(server.id);
        continue;
      }

      try {
        push(server.id, await sampleStats(server.container_name));
      } catch {
        /* container may have just exited */
      }

      // --- idle auto-stop -------------------------------------------------
      const timeout = server.idle_timeout_minutes;
      if (!timeout || st.phase !== 'ready') {
        idleSince.delete(server.id);
        continue;
      }
      if (st.online > 0) {
        idleSince.delete(server.id);
        continue;
      }
      const since = idleSince.get(server.id) ?? Date.now();
      idleSince.set(server.id, since);
      if (Date.now() - since >= timeout * 60000) {
        console.log(`[monitor] ${server.slug} idle for ${timeout}m — stopping`);
        audit('system', server.id, 'server.autostop', `idle ${timeout}m`);
        idleSince.delete(server.id);
        await stopServer(server.id, 'system', { reason: `idle ${timeout}m` }).catch((e) =>
          console.error('[monitor] autostop failed:', e.message)
        );
      }
    } catch (e) {
      console.error(`[monitor] ${server.slug}:`, e.message);
    }
  }
  events.emit('states');
  await healRoutes();
}

/**
 * Cheap drift check: only rewrite the route table when mc-router's live view
 * disagrees with ours, so a router restart or a lost update self-heals without
 * touching the config file every minute.
 */
async function healRoutes() {
  const live = await currentRoutes();
  if (!live) return;
  const expected = buildMappings(allStates());
  const keys = new Set([...Object.keys(live), ...Object.keys(expected)]);
  const drifted = [...keys].some((k) => live[k] !== expected[k]);
  if (drifted) {
    console.log('[monitor] mc-router routes drifted — resyncing');
    await syncRoutes(allStates()).catch((e) => console.error('[monitor] resync failed:', e.message));
  }
}

export function startMonitor() {
  tick().catch(() => {});
  const t = setInterval(() => tick().catch(() => {}), config.monitorIntervalMs);
  t.unref?.();
  return t;
}

/** Disk usage of a server's volume — needs a helper container, so it's on demand. */
export async function diskUsage(server) {
  const { output } = await runHelper(server.volume_name, 'du -sk /data 2>/dev/null | cut -f1');
  const kb = Number(String(output).trim().split(/\s+/)[0]);
  return Number.isFinite(kb) ? kb * 1024 : null;
}

export async function currentStats(server) {
  const st = await containerState(server.container_name);
  if (!st.running) return null;
  return sampleStats(server.container_name);
}
