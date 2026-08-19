import { EventEmitter } from 'node:events';
import { db, listServers } from './db.js';

/**
 * What each server is doing right now, and the change feed for it.
 *
 * This is deliberately separate from the lifecycle module. Plenty of code needs
 * to know whether a server is up (the waker, the console socket, the player
 * lists) without needing the ability to start or delete one, and routing all of
 * them through servers.js made it the hub that everything depended on.
 *
 * It is in-memory on purpose: it describes the containers as they are right
 * now, and is rebuilt by the monitor rather than persisted.
 */

export const events = new EventEmitter();

const runtime = new Map(); // id -> { running, state, phase, players, online, max, lastSeen }

/**
 * Phases:
 *   stopped    no container running
 *   starting   container is up but has not answered RCON yet
 *   ready      answering RCON, safe to talk to
 *   stopping   shutting down, possibly mid-countdown
 *   unhealthy  running but RCON never came up
 *   missing    no container exists
 */
export function stateOf(id) {
  return runtime.get(id) || { running: false, state: 'unknown', phase: 'stopped' };
}

export function setState(id, patch) {
  const next = { ...stateOf(id), ...patch };
  runtime.set(id, next);
  events.emit('state', { id, state: next });
  return next;
}

export function forgetState(id) {
  runtime.delete(id);
}

export function allStates() {
  const out = {};
  for (const s of listServers()) out[s.id] = stateOf(s.id);
  return out;
}

/** Record that someone was on the server, which is what the idle timer reads. */
export function touch(id) {
  const now = new Date().toISOString();
  db.prepare('UPDATE servers SET last_active_at = ? WHERE id = ?').run(now, id);
  setState(id, { lastSeen: now });
}
