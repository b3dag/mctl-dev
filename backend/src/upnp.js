import { config } from './config.js';
import { runCapture } from './docker.js';
import { getDetectedLanIp } from './settings.js';
import { db } from './db.js';

/**
 * Automatic port forwarding for a server's Direct port, so a player behind a
 * home router does not have to open the router's admin page and forward it
 * by hand. Opt-in per server, since it only makes sense on a LAN with a
 * UPnP-capable router in the first place - a VPS has no such device at all,
 * and it should fail quietly there rather than get in the way.
 *
 * The router lives on the LAN, not mctl's own internal Docker network, so
 * this can only work from inside a helper container running with host
 * networking (the same trick detectLanIp uses). Only our own image has the
 * port-mapping library on it, so that is what the helper runs.
 */

const UPNP_SCRIPT = `
import { upnpNat } from '@achingbrain/nat-port-mapper';

const port = Number(process.env.MCTL_PORT);
const lanIp = process.env.MCTL_LAN_IP;
const action = process.env.MCTL_ACTION;

const client = upnpNat();
let done = false;
try {
  for await (const gateway of client.findGateways({ signal: AbortSignal.timeout(8000) })) {
    if (action === 'map') {
      await gateway.map(port, lanIp, { protocol: 'tcp', description: 'mctl' });
    } else {
      await gateway.unmap(port, { protocol: 'tcp' });
    }
    await gateway.stop();
    done = true;
    break; // the first gateway to answer is the one actually routing this LAN
  }
} finally {
  await client.close?.().catch?.(() => {});
}
if (!done) {
  console.error('no UPnP gateway responded');
  process.exit(1);
}
`;

async function run(action, port) {
  const lanIp = getDetectedLanIp();
  if (!lanIp) throw new Error('no LAN address detected yet - try again in a minute');
  const { code, stderr } = await runCapture({
    image: config.selfImage,
    cmd: ['node', '--input-type=module', '-e', UPNP_SCRIPT],
    env: [`MCTL_PORT=${port}`, `MCTL_LAN_IP=${lanIp}`, `MCTL_ACTION=${action}`],
    hostNetwork: true,
    timeoutMs: 15000,
  });
  if (code !== 0) {
    throw new Error(stderr.trim().split('\n').filter(Boolean).pop() || `helper exited ${code}`);
  }
}

// Per-server outcome of the most recent attempt, so the UI can show more than
// "on" - a home router with UPnP switched off is common, and silently doing
// nothing would look identical to it working.
const status = new Map();
export const getUpnpStatus = (id) => status.get(id) || null;

/** Best-effort: never throws, so callers can fire this without their own try/catch. */
export async function requestMapping(server) {
  if (!server.upnp_enabled || !server.host_port) return;
  try {
    await run('map', server.host_port);
    status.set(server.id, { ok: true, message: `Forwarded port ${server.host_port}`, at: Date.now() });
  } catch (e) {
    status.set(server.id, { ok: false, message: e.message, at: Date.now() });
    console.warn(`[upnp] map failed for ${server.slug || server.id}: ${e.message}`);
  }
}

/** Best-effort release, e.g. when the port changes, UPnP is turned off, or the server is deleted. */
export async function releaseMapping(server) {
  if (!server.host_port) return;
  try {
    await run('unmap', server.host_port);
  } catch (e) {
    console.warn(`[upnp] unmap failed for ${server.slug || server.id}: ${e.message}`);
  } finally {
    status.delete(server.id);
  }
}

/**
 * Re-request every enabled mapping. Routers do not reliably honour a
 * "permanent" lease, and a reboot forgets every mapping outright, so this
 * doubles as both renewal and self-healing - called on a timer from
 * monitor.js rather than only at the moment a server is created.
 */
export async function refreshAll() {
  const rows = db.prepare('SELECT * FROM servers WHERE upnp_enabled = 1 AND host_port IS NOT NULL').all();
  for (const server of rows) await requestMapping(server);
}
