import { config } from './config.js';
import { db, listServers, audit } from './db.js';
import { sampleStats, containerState, runHelper } from './docker.js';
import { refresh, stopServer } from './servers.js';
import { stateOf, events, allStates } from './state.js';
import { buildMappings, currentRoutes, syncRoutes } from './router.js';
import { notify } from './notify.js';
import { refreshAll as refreshUpnp } from './upnp.js';

/**
 * Resource history lives in SQLite rather than memory, so a graph survives a
 * manager restart instead of resetting to nothing, and sampled on its own
 * faster interval rather than piggybacking on the once-a-minute tick, so the
 * short-range graph actually has enough points to be worth drawing.
 */
const SAMPLE_INTERVAL_MS = 10000; // one sample per server every 10s while running
const RETENTION_MS = 24 * 60 * 60 * 1000; // a day, no more

const insertSample = db.prepare(
  'INSERT INTO stats_history (server_id, at, cpu_percent, mem_used, mem_limit) VALUES (?,?,?,?,?)'
);
const selectHistory = db.prepare(
  `SELECT at, cpu_percent AS cpuPercent, mem_used AS memUsed, mem_limit AS memLimit
   FROM stats_history WHERE server_id = ? AND at >= ? ORDER BY at`
);

/** History for one server, from `sinceMs` milliseconds ago to now. */
export function statsHistory(id, sinceMs = 10 * 60000) {
  return selectHistory.all(id, Date.now() - sinceMs);
}

async function sampleTick() {
  for (const server of listServers()) {
    if (!stateOf(server.id).running) continue;
    try {
      const s = await sampleStats(server.container_name);
      insertSample.run(server.id, s.at, s.cpuPercent, s.memUsed, s.memLimit);
    } catch {
      /* container may have just exited */
    }
  }
}

function pruneHistory() {
  db.prepare('DELETE FROM stats_history WHERE at < ?').run(Date.now() - RETENTION_MS);
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
        console.log(`[monitor] ${server.slug} idle for ${timeout}m - stopping`);
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
    console.log('[monitor] mc-router routes drifted - resyncing');
    await syncRoutes(allStates()).catch((e) => console.error('[monitor] resync failed:', e.message));
  }
}

/**
 * The backups volume is the one most likely to fill up unnoticed (snapshots
 * accumulate quietly in the background), so it is the one checked. `df`
 * against a helper container mounting it reports the host filesystem's real
 * free space, the same as running it on the host directly.
 */
let lastDiskWarning = 0;
async function checkDiskSpace() {
  try {
    const { output } = await runHelper(config.backupVolume, "df -Pk /data | tail -1 | awk '{print $4, $5}'");
    const [availKb, usedPctRaw] = output.trim().split(/\s+/);
    const usedPct = parseInt(usedPctRaw, 10);
    const availGb = Number(availKb) / (1024 * 1024);
    if (!Number.isFinite(usedPct)) return;
    if (usedPct < 90) return;
    if (Date.now() - lastDiskWarning < 6 * 60 * 60 * 1000) return; // at most once every 6h
    lastDiskWarning = Date.now();
    console.warn(`[monitor] backup volume ${usedPct}% full, ${availGb.toFixed(1)} GB free`);
    await notify('Backup disk running low', `${usedPct}% used, ${availGb.toFixed(1)} GB free on the backups volume.`);
  } catch (e) {
    console.error('[monitor] disk check failed:', e.message);
  }
}

export function startMonitor() {
  tick().catch(() => {});
  const t = setInterval(() => tick().catch(() => {}), config.monitorIntervalMs);
  t.unref?.();

  sampleTick().catch(() => {});
  const s = setInterval(() => sampleTick().catch(() => {}), SAMPLE_INTERVAL_MS);
  s.unref?.();

  pruneHistory();
  const p = setInterval(pruneHistory, 15 * 60000);
  p.unref?.();

  checkDiskSpace().catch(() => {});
  const d = setInterval(() => checkDiskSpace().catch(() => {}), 30 * 60000);
  d.unref?.();

  // Routers do not reliably honour a "permanent" UPnP lease, and a reboot
  // forgets every mapping outright, so this is renewal and self-healing in
  // one, not just the initial request made when a server is created.
  refreshUpnp().catch(() => {});
  const u = setInterval(() => refreshUpnp().catch(() => {}), 15 * 60000);
  u.unref?.();

  return t;
}

/** Disk usage of a server's volume - needs a helper container, so it's on demand. */
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
