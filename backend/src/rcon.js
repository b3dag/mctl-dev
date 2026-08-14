import { Rcon } from 'rcon-client';

const pool = new Map(); // containerName -> Rcon

/**
 * RCON is reachable only on the internal Docker network, addressed by container
 * name. Nothing is published to the host, so no extra ports are open anywhere.
 */
async function connect(server) {
  const existing = pool.get(server.container_name);
  if (existing) return existing;

  const rcon = await Rcon.connect({
    host: server.container_name,
    port: 25575,
    password: server.rcon_password,
    timeout: 5000,
  });
  rcon.on('end', () => {
    if (pool.get(server.container_name) === rcon) pool.delete(server.container_name);
  });
  rcon.on('error', () => {
    if (pool.get(server.container_name) === rcon) pool.delete(server.container_name);
  });
  pool.set(server.container_name, rcon);
  return rcon;
}

export async function rconCommand(server, command) {
  let rcon;
  try {
    rcon = await connect(server);
    return await rcon.send(command);
  } catch (err) {
    // Drop a stale socket and try exactly once more.
    pool.delete(server.container_name);
    try {
      await rcon?.end();
    } catch {}
    rcon = await connect(server);
    return await rcon.send(command);
  }
}

export function dropRcon(containerName) {
  const rcon = pool.get(containerName);
  pool.delete(containerName);
  rcon?.end().catch(() => {});
}

/** `list` output: "There are 2 of a max of 20 players online: alice, bob" */
export async function playerList(server) {
  const raw = await rconCommand(server, 'list');
  const text = String(raw).replace(/§./g, '');
  const m = text.match(/There are (\d+)(?:\s*of a max(?: of)?\s*(\d+))? players online/i);
  const online = m ? Number(m[1]) : 0;
  const max = m && m[2] ? Number(m[2]) : null;
  const after = text.split(':').slice(1).join(':');
  const players = after
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return { online, max, players, raw: text };
}

/** True once the server answers RCON, which is our readiness signal. */
export async function isReady(server) {
  try {
    await rconCommand(server, 'list');
    return true;
  } catch {
    return false;
  }
}
