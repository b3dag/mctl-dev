import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from './config.js';
import { runCapture, runStream } from './docker.js';

/**
 * Backups go into a restic repository instead of one tar.gz per snapshot.
 *
 * restic deduplicates at the chunk level, so ten daily snapshots of a world
 * that barely changed cost roughly one copy plus the differences, and it can
 * verify its own integrity. All of it runs in a throwaway container so the
 * manager image does not need restic installed.
 *
 * The repository lives in the backups volume, and its password lives beside it
 * rather than only in the database, so the volume alone is enough to recover.
 */

const REPO = '/backups/restic';
const PASSWORD_FILE = '/backups/restic-password';

const repoEnv = () => [`RESTIC_REPOSITORY=${REPO}`, `RESTIC_PASSWORD_FILE=${PASSWORD_FILE}`];

function binds(serverVolume, { writable = false } = {}) {
  const list = [`${config.backupVolume}:/backups`];
  if (serverVolume) list.push(`${serverVolume}:/data${writable ? '' : ':ro'}`);
  return list;
}

async function restic(args, { serverVolume, writable, timeoutMs } = {}) {
  const res = await runCapture({
    image: config.resticImage,
    cmd: args,
    env: repoEnv(),
    binds: binds(serverVolume, { writable }),
    timeoutMs,
  });
  if (res.code !== 0) {
    const msg = (res.stderr || res.stdout).trim().split('\n').slice(-4).join(' ');
    const e = new Error(`restic ${args[0]} failed: ${msg}`);
    e.status = 500;
    throw e;
  }
  return res;
}

let ready = null;

/** Create the repo and its password on first use. Safe to call repeatedly. */
export function initRepo() {
  ready ||= (async () => {
    await fsp.mkdir(config.backupDir, { recursive: true });
    const localPassword = path.join(config.backupDir, 'restic-password');
    if (!fs.existsSync(localPassword)) {
      await fsp.writeFile(localPassword, crypto.randomBytes(32).toString('base64url'), { mode: 0o600 });
      console.log('[restic] generated a repository password at <backups>/restic-password');
    }

    const probe = await runCapture({
      image: config.resticImage,
      cmd: ['cat', 'config'],
      env: repoEnv(),
      binds: binds(null),
      timeoutMs: 60000,
    });
    if (probe.code !== 0) {
      await restic(['init']);
      console.log('[restic] initialised repository at <backups>/restic');
    }
    return true;
  })().catch((e) => {
    ready = null; // let a later call retry
    throw e;
  });
  return ready;
}

const tagsFor = (server, scope, kind) => [
  '--tag', `server=${server.slug}`,
  '--tag', `scope=${scope}`,
  '--tag', `kind=${kind}`,
];

/**
 * Snapshot straight off the data volume, mounted read-only. Works whether or
 * not the container is running, which is why this does not go through docker cp.
 */
export async function snapshot(server, { scope, kind, worldDir }) {
  await initRepo();
  const target = scope === 'all' ? '/data' : `/data/${worldDir}`;
  const res = await restic(
    ['backup', target, '--json', ...tagsFor(server, scope, kind)],
    { serverVolume: server.volume_name }
  );

  // restic emits one JSON object per line; the last summary carries the totals.
  let summary = null;
  for (const line of res.stdout.split('\n')) {
    if (!line.trim()) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.message_type === 'summary') summary = msg;
    } catch {
      /* progress lines */
    }
  }
  if (!summary?.snapshot_id) throw new Error('restic did not report a snapshot id');
  return {
    snapshotId: summary.snapshot_id,
    bytesAdded: summary.data_added ?? 0,
    bytesProcessed: summary.total_bytes_processed ?? 0,
    filesChanged: (summary.files_new ?? 0) + (summary.files_changed ?? 0),
  };
}

export async function snapshots(server) {
  await initRepo();
  const res = await restic(['snapshots', '--json', '--tag', `server=${server.slug}`]);
  try {
    return JSON.parse(res.stdout || '[]');
  } catch {
    return [];
  }
}

/** Wipe the target directory, then unpack the snapshot back over it. */
export async function restore(server, snapshotId, { scope, worldDir }) {
  await initRepo();
  const include = scope === 'all' ? '/data' : `/data/${worldDir}`;
  await restic(['restore', snapshotId, '--target', '/', '--include', include], {
    serverVolume: server.volume_name,
    writable: true,
  });
}

/** Stream a snapshot as a tar, for downloads. */
export async function dumpTar(snapshotId, dirPath) {
  await initRepo();
  return runStream({
    image: config.resticImage,
    cmd: ['dump', '--archive', 'tar', snapshotId, dirPath],
    env: repoEnv(),
    binds: binds(null),
  });
}

export async function forget(server, { kind, keep }) {
  await initRepo();
  const res = await restic([
    'forget', '--prune', '--json',
    '--tag', `server=${server.slug}`,
    '--tag', `kind=${kind}`,
    '--keep-last', String(Math.max(1, keep)),
  ]);
  return res.stdout;
}

export async function forgetSnapshot(snapshotId) {
  await initRepo();
  await restic(['forget', '--prune', snapshotId]);
}

/**
 * One repository holds every server's snapshots, and deduplication happens
 * across all of them, so on-disk size can only be reported repo-wide. Counts
 * and restored size are reported per server as well, because repo-wide figures
 * on a single server's page just look wrong.
 */
export async function repoStats(server) {
  await initRepo();
  const parse = (res) => {
    try {
      return JSON.parse(res.stdout);
    } catch {
      return {};
    }
  };

  const [raw, restoreSize, list] = await Promise.all([
    restic(['stats', '--json', '--mode', 'raw-data']),
    restic(['stats', '--json', '--mode', 'restore-size']),
    restic(['snapshots', '--json']),
  ]);

  let all = [];
  try {
    all = JSON.parse(list.stdout || '[]');
  } catch {
    /* empty repo */
  }

  const tagsOf = (s) =>
    Object.fromEntries((s.tags || []).filter((t) => t.includes('=')).map((t) => t.split('=', 2)));
  const mine = server ? all.filter((s) => tagsOf(s).server === server.slug) : [];

  // Only worth another restic call if this server actually has snapshots.
  let mineLogical = 0;
  if (mine.length) {
    const scoped = await restic([
      'stats', '--json', '--mode', 'restore-size', '--tag', `server=${server.slug}`,
    ]);
    mineLogical = parse(scoped).total_size ?? 0;
  }

  const onDisk = parse(raw).total_size ?? null;
  const logical = parse(restoreSize).total_size ?? null;

  return {
    server: server ? { snapshots: mine.length, logical: mineLogical } : null,
    repo: {
      snapshots: all.length,
      onDisk,
      logical,
      saved: onDisk !== null && logical !== null ? Math.max(0, logical - onDisk) : null,
    },
  };
}

export async function check() {
  await initRepo();
  const res = await restic(['check'], { timeoutMs: 1800000 });
  return (res.stdout || res.stderr).trim().split('\n').slice(-3).join('\n');
}
