import crypto from 'node:crypto';
import cron from 'node-cron';
import { db, audit, getServer } from './db.js';
import { httpError } from './errors.js';
import { containerState } from './docker.js';
import { restartServer } from './servers.js';
import { rconCommand } from './rcon.js';
import { stripFormatting } from './text.js';
import { notify } from './notify.js';

/**
 * Recurring per-server actions: a clean restart, or a one-line RCON command,
 * on a cron schedule. Reuses the same "warn players first" path a manual
 * restart already goes through, so a scheduled one is not a surprise either.
 */

const BLOCKED = /^\s*(stop|restart)\b/i;

export const listSchedules = (serverId) =>
  db.prepare('SELECT * FROM task_schedules WHERE server_id = ? ORDER BY created_at').all(serverId);

export const getSchedule = (id) => db.prepare('SELECT * FROM task_schedules WHERE id = ?').get(id);

export function createSchedule(serverId, { kind, cron: expr, command }, actor) {
  const server = getServer(serverId);
  if (!server) throw httpError(404, 'no such server');
  if (kind !== 'restart' && kind !== 'command') throw httpError(400, 'kind must be "restart" or "command"');
  if (!expr || !cron.validate(expr)) throw httpError(400, `invalid cron expression: ${expr}`);

  let cmd = null;
  if (kind === 'command') {
    cmd = String(command || '').trim();
    if (!cmd) throw httpError(400, 'command is required');
    if (BLOCKED.test(cmd)) throw httpError(400, 'use a restart schedule instead, not a stop/restart command');
  }

  const id = crypto.randomUUID();
  db.prepare(
    'INSERT INTO task_schedules (id, server_id, kind, cron, command, enabled, created_at) VALUES (?,?,?,?,?,1,?)'
  ).run(id, serverId, kind, expr, cmd, new Date().toISOString());
  audit(actor, serverId, 'schedule.create', `${kind} ${expr}${cmd ? ` "${cmd}"` : ''}`);
  reloadSchedules();
  return getSchedule(id);
}

export function setScheduleEnabled(id, enabled, actor) {
  const s = getSchedule(id);
  if (!s) throw httpError(404, 'no such schedule');
  db.prepare('UPDATE task_schedules SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, id);
  audit(actor, s.server_id, 'schedule.update', enabled ? 'enabled' : 'disabled');
  reloadSchedules();
  return getSchedule(id);
}

export function deleteSchedule(id, actor) {
  const s = getSchedule(id);
  if (!s) throw httpError(404, 'no such schedule');
  db.prepare('DELETE FROM task_schedules WHERE id = ?').run(id);
  audit(actor, s.server_id, 'schedule.delete', `${s.kind} ${s.cron}`);
  reloadSchedules();
}

const jobs = new Map(); // schedule id -> cron task

/** A restart on a server nobody started is not "clean up a leak", it is an unexpected boot; a command on one that is not running has nothing to reach. */
async function runOnce(row) {
  const server = getServer(row.server_id);
  if (!server) return;
  const st = await containerState(server.container_name);
  if (!st.running) return;

  if (row.kind === 'restart') {
    await restartServer(row.server_id, 'system');
  } else {
    const out = await rconCommand(server, row.command);
    audit('system', row.server_id, 'schedule.run', stripFormatting(out).trim().slice(0, 200));
  }
}

export function reloadSchedules() {
  for (const [, task] of jobs) task.stop();
  jobs.clear();
  const rows = db.prepare('SELECT * FROM task_schedules WHERE enabled = 1').all();
  for (const row of rows) {
    if (!cron.validate(row.cron)) continue;
    const task = cron.schedule(
      row.cron,
      () =>
        runOnce(row).catch((e) => {
          console.error(`[schedule] ${row.server_id} ${row.kind} failed:`, e.message);
          const server = getServer(row.server_id);
          notify(`Scheduled ${row.kind} failed`, `${server?.name || row.server_id}: ${e.message}`);
        }),
      { timezone: process.env.TZ || 'UTC' }
    );
    jobs.set(row.id, task);
  }
  console.log(`[schedule] ${jobs.size} task schedule(s) active`);
}


export function initSchedules() {
  reloadSchedules();
}
