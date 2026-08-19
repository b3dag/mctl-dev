import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { config } from './config.js';

fs.mkdirSync(config.dataDir, { recursive: true });

export const db = new Database(path.join(config.dataDir, 'mctl.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS servers (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  slug           TEXT NOT NULL UNIQUE,
  hostname       TEXT NOT NULL UNIQUE,
  container_name TEXT NOT NULL UNIQUE,
  volume_name    TEXT NOT NULL,
  type           TEXT NOT NULL DEFAULT 'VANILLA',
  version        TEXT NOT NULL DEFAULT 'LATEST',
  memory         TEXT NOT NULL DEFAULT '2G',
  seed           TEXT,
  rcon_password  TEXT NOT NULL,
  env            TEXT NOT NULL DEFAULT '{}',
  autostart_on_join INTEGER NOT NULL DEFAULT 1,
  idle_timeout_minutes INTEGER NOT NULL DEFAULT 30,
  created_at     TEXT NOT NULL,
  last_active_at TEXT,
  created_by     TEXT
);

CREATE TABLE IF NOT EXISTS backups (
  id         TEXT PRIMARY KEY,
  server_id  TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  filename   TEXT,
  size       INTEGER NOT NULL DEFAULT 0,
  kind       TEXT NOT NULL DEFAULT 'manual',
  note       TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_backups_server ON backups(server_id, created_at DESC);

CREATE TABLE IF NOT EXISTS backup_schedules (
  server_id  TEXT PRIMARY KEY REFERENCES servers(id) ON DELETE CASCADE,
  cron       TEXT NOT NULL,
  keep       INTEGER NOT NULL DEFAULT 7,
  enabled    INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS audit_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  at         TEXT NOT NULL,
  actor      TEXT,
  server_id  TEXT,
  action     TEXT NOT NULL,
  detail     TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_at ON audit_log(at DESC);

-- Resource samples for the CPU/memory graphs. Written every few seconds while
-- a server is running, pruned back to a day, so a graph survives a manager
-- restart instead of resetting to nothing.
CREATE TABLE IF NOT EXISTS stats_history (
  server_id   TEXT NOT NULL,
  at          INTEGER NOT NULL,
  cpu_percent REAL NOT NULL,
  mem_used    INTEGER NOT NULL,
  mem_limit   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_stats_history_server_at ON stats_history(server_id, at);
`);

db.exec('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)');

// --- migrations -------------------------------------------------------------
// Additive only, guarded so an existing database upgrades in place on boot.
const columns = (table) => db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);

const serverColumns = columns('servers');
if (!serverColumns.includes('hostname_override')) {
  db.exec('ALTER TABLE servers ADD COLUMN hostname_override TEXT');
}
// Optional direct publish: bypasses mc-router so players can connect with a
// plain host:port, for people who'd rather not run wildcard DNS.
if (!serverColumns.includes('host_port')) {
  db.exec('ALTER TABLE servers ADD COLUMN host_port INTEGER');
}
// cpu_limit existed briefly and was dropped again; clear it where it landed.
if (serverColumns.includes('cpu_limit')) {
  try {
    db.exec('ALTER TABLE servers DROP COLUMN cpu_limit');
  } catch {
    /* older SQLite cannot drop columns; an unused column is harmless */
  }
}

// The shutdown countdown started life as one global value, but it is a
// lifecycle behaviour like the idle timeout, so it lives on the server.
if (!serverColumns.includes('stop_warning_seconds')) {
  db.exec('ALTER TABLE servers ADD COLUMN stop_warning_seconds INTEGER');
  // Carry over whatever the global setting was, so nobody loses their value.
  const prior = db
    .prepare("SELECT value FROM settings WHERE key = 'stopWarningSeconds'")
    .all()
    .map((r) => Number(r.value))
    .find((n) => Number.isFinite(n));
  db.prepare('UPDATE servers SET stop_warning_seconds = ?').run(prior ?? 30);
  db.prepare("DELETE FROM settings WHERE key = 'stopWarningSeconds'").run();
}

// Backups moved from one tar.gz per snapshot to a deduplicated restic repo.
// Old rows keep filename and are read back through the tar path.
const backupColumns = columns('backups');
if (!backupColumns.includes('engine')) db.exec('ALTER TABLE backups ADD COLUMN engine TEXT');
if (!backupColumns.includes('snapshot_id')) db.exec('ALTER TABLE backups ADD COLUMN snapshot_id TEXT');
if (!backupColumns.includes('scope')) db.exec('ALTER TABLE backups ADD COLUMN scope TEXT');
if (!backupColumns.includes('logical_size')) db.exec('ALTER TABLE backups ADD COLUMN logical_size INTEGER');

export function audit(actor, serverId, action, detail) {
  db.prepare(
    'INSERT INTO audit_log (at, actor, server_id, action, detail) VALUES (?,?,?,?,?)'
  ).run(new Date().toISOString(), actor || null, serverId || null, action, detail ? String(detail).slice(0, 2000) : null);
}

export const rowToServer = (r) =>
  r && {
    ...r,
    env: JSON.parse(r.env || '{}'),
    autostart_on_join: !!r.autostart_on_join,
  };

export const getServer = (id) =>
  rowToServer(db.prepare('SELECT * FROM servers WHERE id = ?').get(id));

export const getServerByHostname = (hostname) =>
  rowToServer(db.prepare('SELECT * FROM servers WHERE hostname = ?').get(String(hostname).toLowerCase()));

export const listServers = () =>
  db.prepare('SELECT * FROM servers ORDER BY name COLLATE NOCASE').all().map(rowToServer);
