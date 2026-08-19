import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import cron from 'node-cron';
import archiver from 'archiver';
import tar from 'tar-stream';
import unzipper from 'unzipper';
import { config } from './config.js';
import { db, audit, getServer, listServers } from './db.js';
import { putArchiveStream, runHelper, containerState, volumeOwner } from './docker.js';
import { stopServer, startServer, updateServer } from './servers.js';
import { stateOf } from './state.js';
import { httpError } from './errors.js';
import { rconCommand } from './rcon.js';
import { pipeTarIntoZip, zipStream } from './files.js';
import * as restic from './restic.js';

const dirFor = (serverId) => path.join(config.backupDir, serverId);

export const worldDirOf = (server) => server.env?.LEVEL || 'world';

/** Rows written before restic have no snapshot and are still a tar.gz on disk. */
const engineOf = (b) => b.engine || 'tar';

export function listBackups(serverId) {
  return db
    .prepare('SELECT * FROM backups WHERE server_id = ? ORDER BY created_at DESC')
    .all(serverId)
    .map((b) => ({ ...b, engine: engineOf(b) }));
}

export function getBackup(id) {
  const b = db.prepare('SELECT * FROM backups WHERE id = ?').get(id);
  return b && { ...b, engine: engineOf(b) };
}

export const backupPath = (b) => path.join(dirFor(b.server_id), b.filename);

const scopeOf = (b) => (b.scope ? b.scope : b.filename?.includes('-all-') ? 'all' : 'world');

/**
 * Snapshot a server's world (or all of /data) into the restic repository.
 * Reads the data volume directly, so it works stopped or running; when running
 * we flush to disk and pause writes over RCON first for a consistent copy.
 */
export async function createBackup(serverId, { scope = 'world', note, kind = 'manual', actor } = {}) {
  const server = getServer(serverId);
  if (!server) throw httpError(404, 'no such server');

  const st = await containerState(server.container_name);
  if (!st.exists) throw httpError(409, 'container does not exist yet');

  const running = st.running && stateOf(serverId).phase === 'ready';
  if (running) {
    await rconCommand(server, 'save-off').catch(() => {});
    await rconCommand(server, 'save-all flush').catch(() => {});
    await new Promise((r) => setTimeout(r, 1500));
  }

  let result;
  try {
    result = await restic.snapshot(server, { scope, kind, worldDir: worldDirOf(server) });
  } finally {
    if (running) await rconCommand(server, 'save-on').catch(() => {});
  }

  const id = crypto.randomUUID();
  db.prepare(
    `INSERT INTO backups (id, server_id, filename, size, kind, note, created_at, engine, snapshot_id, scope, logical_size)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    id,
    serverId,
    // Databases created before restic declare filename NOT NULL, so restic rows
    // record their snapshot id here too rather than a null.
    result.snapshotId,
    result.bytesAdded,
    kind,
    note || null,
    new Date().toISOString(),
    'restic',
    result.snapshotId,
    scope,
    result.bytesProcessed
  );
  audit(
    actor || 'system',
    serverId,
    'backup.create',
    `${scope} snapshot ${result.snapshotId.slice(0, 8)}, ${result.bytesAdded} new of ${result.bytesProcessed} bytes`
  );
  return getBackup(id);
}

export async function deleteBackup(id, actor) {
  const b = getBackup(id);
  if (!b) throw httpError(404, 'no such backup');

  if (b.engine === 'restic') {
    await restic.forgetSnapshot(b.snapshot_id);
  } else {
    await fsp.rm(backupPath(b), { force: true });
  }
  db.prepare('DELETE FROM backups WHERE id = ?').run(id);
  audit(actor, b.server_id, 'backup.delete', b.snapshot_id || b.filename);
}

/** Restore stops the server, clears the target directory, then unpacks. */
export async function restoreBackup(id, { actor, restart = true } = {}) {
  const b = getBackup(id);
  if (!b) throw httpError(404, 'no such backup');
  const server = getServer(b.server_id);
  if (!server) throw httpError(404, 'no such server');
  if (b.engine === 'tar' && !fs.existsSync(backupPath(b)))
    throw httpError(410, 'backup file is missing from disk');

  const st = await containerState(server.container_name);
  const wasRunning = st.running;
  if (wasRunning) await stopServer(server.id, actor, { reason: 'restore', warn: false });

  const scope = scopeOf(b);
  const world = worldDirOf(server);
  if (scope === 'world') {
    await runHelper(server.volume_name, `rm -rf '/data/${world.replace(/'/g, '')}'`);
  }

  if (b.engine === 'restic') {
    await restic.restore(server, b.snapshot_id, { scope, worldDir: world });
  } else {
    const src = fs.createReadStream(backupPath(b)).pipe(zlib.createGunzip());
    await putArchiveStream(server.container_name, '/data', src);
  }

  audit(actor, server.id, 'backup.restore', b.snapshot_id || b.filename);
  if (wasRunning && restart) await startServer(server.id, actor);
  return { restored: b.snapshot_id || b.filename, restarted: wasRunning && restart };
}

/**
 * The live world right now, zipped with its own contents at the zip root
 * rather than wrapped in a folder named after it - the ordinary convention
 * for a shareable world, and what worldUpload() below expects back. This is
 * independent of the snapshot system entirely: no backup has to exist first.
 */
export async function worldDownloadStream(server, res) {
  await zipStream(server, worldDirOf(server), res, { stripSegments: 1 });
}

/**
 * Replace a server's world with the contents of an uploaded zip - the other
 * half of worldDownloadStream, meant for moving a world to a different
 * server by hand rather than through the shared backup repository. Stops the
 * server, swaps the folder, optionally records a seed for the new world (a
 * plain settings update, applied before the restart rather than after so it
 * does not cause a second one), and starts it again if it was running.
 */
export async function worldUpload(server, zipBuffer, { actor, seed } = {}) {
  const st = await containerState(server.container_name);
  const wasRunning = st.running;
  if (wasRunning) await stopServer(server.id, actor, { reason: 'world upload', warn: true });

  const owner = await volumeOwner(server.volume_name);
  const dir = await unzipper.Open.buffer(zipBuffer);
  const files = dir.files.filter((f) => f.type === 'File');
  if (!files.length) throw httpError(400, 'that zip has no files in it');

  // Only file entries carry an explicit owner; a subdirectory a file happens
  // to need (playerdata/, region/, ...) gets created implicitly by whatever
  // extracts the tar, root-owned, since nothing told it otherwise. The
  // server can then read what is already there but not create anything new
  // in it - which is exactly "failed to save player data" for a player who
  // has never been saved into this particular world before. So every
  // directory a file lives in gets its own explicit, correctly-owned entry
  // too, not just the files themselves.
  const pack = tar.pack();
  const knownDirs = new Set();
  const addDir = (dirPath) => {
    if (!dirPath || knownDirs.has(dirPath)) return;
    addDir(dirPath.split('/').slice(0, -1).join('/'));
    knownDirs.add(dirPath);
    pack.entry({ name: `${dirPath}/`, type: 'directory', uid: owner.uid, gid: owner.gid, mode: 0o755 });
  };
  for (const entry of files) {
    addDir(entry.path.split('/').slice(0, -1).join('/'));
    pack.entry({ name: entry.path, uid: owner.uid, gid: owner.gid, mode: 0o644 }, await entry.buffer());
  }
  pack.finalize();

  // Docker's archive API extracts into an existing directory rather than
  // creating one, so the wipe has to leave an empty, correctly-owned folder
  // behind, not none - a root-owned one would break the image's next boot
  // the same way a root-owned file would.
  const world = worldDirOf(server);
  const wpath = `/data/${world.replace(/'/g, '')}`;
  await runHelper(server.volume_name, `rm -rf '${wpath}' && mkdir -p '${wpath}' && chown ${owner.uid}:${owner.gid} '${wpath}'`);
  await putArchiveStream(server.container_name, `/data/${world}`, pack);
  audit(actor, server.id, 'world.upload', `${files.length} file(s)`);

  if (seed) await updateServer(server.id, { seed }, actor);
  if (wasRunning) await startServer(server.id, actor);
  return { uploaded: true, files: files.length, restarted: wasRunning };
}

/** A tar stream of the snapshot's contents, whichever engine produced it. */
export async function backupTarStream(b) {
  if (b.engine === 'restic') {
    const server = getServer(b.server_id);
    const dir = scopeOf(b) === 'all' ? '/data' : `/data/${worldDirOf(server)}`;
    return restic.dumpTar(b.snapshot_id, dir);
  }
  return fs.createReadStream(backupPath(b)).pipe(zlib.createGunzip());
}

/**
 * Unlike Docker's archive API, restic's dump keeps the snapshot's own full
 * original path on every entry rather than wrapping just one level, so
 * "world only" backups come back as data/<world>/... and "everything" ones
 * as data/.... This strips exactly that many segments, so a zip downloaded
 * here has the same bare-contents layout worldDownloadStream() produces -
 * interchangeable with it, including for worldUpload().
 */
function restoreZipStrip(b) {
  if (b.engine !== 'restic') return 0;
  return scopeOf(b) === 'all' ? 1 : 2;
}

export async function streamAsZip(b, res) {
  const zip = archiver('zip', { zlib: { level: 6 } });
  zip.pipe(res);
  await pipeTarIntoZip(await backupTarStream(b), zip, restoreZipStrip(b));
  await zip.finalize();
}

export async function streamAsTarGz(b, res) {
  const src = await backupTarStream(b);
  src.on('error', () => res.destroy());
  src.pipe(zlib.createGzip({ level: 6 })).pipe(res);
}

export const downloadName = (b, ext) => {
  const server = getServer(b.server_id);
  const stamp = String(b.created_at).replace(/[:.]/g, '-');
  return `${server?.slug || 'server'}-${scopeOf(b)}-${stamp}.${ext}`;
};

export const repoStats = (server) => restic.repoStats(server);
export const checkRepo = () => restic.check();

// --- retention + scheduling -------------------------------------------------

/**
 * Retention is restic's job: forget everything past the last N scheduled
 * snapshots and prune the unreferenced chunks, then drop the matching rows.
 */
async function prune(serverId, keep) {
  const server = getServer(serverId);
  if (!server) return;
  await restic.forget(server, { kind: 'scheduled', keep });

  const remaining = new Set((await restic.snapshots(server)).map((s) => s.short_id));
  for (const b of listBackups(serverId)) {
    if (b.engine !== 'restic' || b.kind !== 'scheduled') continue;
    const short = String(b.snapshot_id).slice(0, 8);
    if (!remaining.has(short)) db.prepare('DELETE FROM backups WHERE id = ?').run(b.id);
  }
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
  // Legacy tar rows whose file vanished are dead weight; restic rows are
  // validated against the repository instead, which needs the repo to exist.
  for (const server of listServers()) {
    for (const b of listBackups(server.id)) {
      if (b.engine === 'tar' && !fs.existsSync(backupPath(b)))
        db.prepare('DELETE FROM backups WHERE id = ?').run(b.id);
    }
  }
  reloadSchedules();
}
