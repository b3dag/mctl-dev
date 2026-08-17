import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import cron from 'node-cron';
import archiver from 'archiver';
import { config } from './config.js';
import { db, audit, getServer, listServers } from './db.js';
import { getArchiveStream, putArchiveStream, runHelper, containerState } from './docker.js';
import { httpError, stopServer, startServer, stateOf } from './servers.js';
import { rconCommand } from './rcon.js';
import { pipeTarIntoZip } from './files.js';

const dirFor = (serverId) => path.join(config.backupDir, serverId);

export const worldDirOf = (server) => server.env?.LEVEL || 'world';

export function listBackups(serverId) {
  return db
    .prepare('SELECT * FROM backups WHERE server_id = ? ORDER BY created_at DESC')
    .all(serverId);
}

export function getBackup(id) {
  return db.prepare('SELECT * FROM backups WHERE id = ?').get(id);
}

export const backupPath = (b) => path.join(dirFor(b.server_id), b.filename);

/**
 * Snapshot a server's world (or all of /data) straight out of the container
 * filesystem. Works stopped or running; when running we flush to disk and
 * pause writes through RCON first so the snapshot is consistent.
 */
export async function createBackup(serverId, { scope = 'world', note, kind = 'manual', actor } = {}) {
  const server = getServer(serverId);
  if (!server) throw httpError(404, 'no such server');

  const target = scope === 'all' ? '/data' : `/data/${worldDirOf(server)}`;
  const st = await containerState(server.container_name);
  if (!st.exists) throw httpError(409, 'container does not exist yet');

  const running = st.running && stateOf(serverId).phase === 'ready';
  if (running) {
    await rconCommand(server, 'save-off').catch(() => {});
    await rconCommand(server, 'save-all flush').catch(() => {});
    await new Promise((r) => setTimeout(r, 1500));
  }

  await fsp.mkdir(dirFor(serverId), { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `${server.slug}-${scope}-${stamp}.tar.gz`;
  const full = path.join(dirFor(serverId), filename);

  try {
    const source = await getArchiveStream(server.container_name, target);
    await pipeline(source, zlib.createGzip({ level: 6 }), fs.createWriteStream(full));
  } catch (e) {
    await fsp.rm(full, { force: true });
    throw e;
  } finally {
    if (running) await rconCommand(server, 'save-on').catch(() => {});
  }

  const { size } = await fsp.stat(full);
  const id = crypto.randomUUID();
  db.prepare(
    'INSERT INTO backups (id, server_id, filename, size, kind, note, created_at) VALUES (?,?,?,?,?,?,?)'
  ).run(id, serverId, filename, size, kind, note || null, new Date().toISOString());
  audit(actor || 'system', serverId, 'backup.create', `${filename} (${size} bytes)`);
  return getBackup(id);
}

export async function deleteBackup(id, actor) {
  const b = getBackup(id);
  if (!b) throw httpError(404, 'no such backup');
  await fsp.rm(backupPath(b), { force: true });
  db.prepare('DELETE FROM backups WHERE id = ?').run(id);
  audit(actor, b.server_id, 'backup.delete', b.filename);
}

/** Restore stops the server, wipes the target dir, then unpacks the archive. */
export async function restoreBackup(id, { actor, restart = true } = {}) {
  const b = getBackup(id);
  if (!b) throw httpError(404, 'no such backup');
  const server = getServer(b.server_id);
  if (!server) throw httpError(404, 'no such server');
  if (!fs.existsSync(backupPath(b))) throw httpError(410, 'backup file is missing from disk');

  const st = await containerState(server.container_name);
  const wasRunning = st.running;
  if (wasRunning) await stopServer(server.id, actor, { reason: 'restore', warn: false });

  const scope = b.filename.includes('-all-') ? 'all' : 'world';
  if (scope === 'world') {
    const world = worldDirOf(server);
    await runHelper(server.volume_name, `rm -rf '/data/${world.replace(/'/g, '')}'`);
  }

  const src = fs.createReadStream(backupPath(b)).pipe(zlib.createGunzip());
  await putArchiveStream(server.container_name, '/data', src);

  audit(actor, server.id, 'backup.restore', b.filename);
  if (wasRunning && restart) await startServer(server.id, actor);
  return { restored: b.filename, restarted: wasRunning && restart };
}

/** Convert a stored tar.gz into a zip on the fly for download. */
export async function streamAsZip(b, res) {
  const zip = archiver('zip', { zlib: { level: 6 } });
  zip.pipe(res);
  const src = fs.createReadStream(backupPath(b)).pipe(zlib.createGunzip());
  await pipeTarIntoZip(src, zip);
  await zip.finalize();
}

// --- retention + scheduling -------------------------------------------------

async function prune(serverId, keep) {
  const all = listBackups(serverId).filter((b) => b.kind === 'scheduled');
  for (const old of all.slice(keep)) await deleteBackup(old.id, 'system').catch(() => {});
}

export function getSchedule(serverId) {
  return db.prepare('SELECT * FROM backup_schedules WHERE server_id = ?').get(serverId) || null;
}

export function setSchedule(serverId, { cron: expr, keep = 7, enabled = true }, actor) {
  if (expr && !cron.validate(expr)) throw httpError(400, `invalid cron expression: ${expr}`);
  if (!expr) {
    db.prepare('DELETE FROM backup_schedules WHERE server_id = ?').run(serverId);
  } else {
    db.prepare(
      `INSERT INTO backup_schedules (server_id, cron, keep, enabled) VALUES (?,?,?,?)
       ON CONFLICT(server_id) DO UPDATE SET cron=excluded.cron, keep=excluded.keep, enabled=excluded.enabled`
    ).run(serverId, expr, Math.max(1, Math.trunc(keep) || 7), enabled ? 1 : 0);
  }
  audit(actor, serverId, 'backup.schedule', expr || 'disabled');
  reloadSchedules();
  return getSchedule(serverId);
}

const jobs = new Map(); // serverId -> cron task

export function reloadSchedules() {
  for (const [id, task] of jobs) {
    task.stop();
    jobs.delete(id);
  }
  const rows = db.prepare('SELECT * FROM backup_schedules WHERE enabled = 1').all();
  for (const row of rows) {
    if (!cron.validate(row.cron)) continue;
    const task = cron.schedule(
      row.cron,
      async () => {
        try {
          await createBackup(row.server_id, { scope: 'world', kind: 'scheduled', actor: 'system' });
          await prune(row.server_id, row.keep);
        } catch (e) {
          console.error(`[backup] scheduled backup failed for ${row.server_id}:`, e.message);
        }
      },
      { timezone: process.env.TZ || 'UTC' }
    );
    jobs.set(row.server_id, task);
  }
  console.log(`[backup] ${jobs.size} schedule(s) active`);
}

export async function initBackups() {
  await fsp.mkdir(config.backupDir, { recursive: true });
  // Drop rows whose files vanished (e.g. volume reset).
  for (const server of listServers()) {
    for (const b of listBackups(server.id)) {
      if (!fs.existsSync(backupPath(b))) db.prepare('DELETE FROM backups WHERE id = ?').run(b.id);
    }
  }
  reloadSchedules();
}
