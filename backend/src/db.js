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
  filename   TEXT NOT NULL,
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
`);

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
