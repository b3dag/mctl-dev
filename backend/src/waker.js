import net from 'node:net';
import { config } from './config.js';
import { getServerByHostname } from './db.js';
import { packet, parseHandshake, takePacket, writeString } from './mcproto.js';
import { startAndWait, stateOf } from './servers.js';

/**
 * mc-router forwards a stopped server's hostname here instead of to a backend
 * that isn't running. We speak just enough of the protocol to:
 *   - answer the server-list ping with a "sleeping" MOTD, and
 *   - turn a join attempt into a container start plus a friendly disconnect.
 * Once the container answers RCON, servers.js repoints the route at it, so the
 * player's reconnect goes straight through with no extra hop.
 */

const COLOR = { gold: '§6', green: '§a', gray: '§7', red: '§c', yellow: '§e' };

function statusJson(server, protocol, phase) {
  const sleeping = phase !== 'starting';
  const description = sleeping
    ? `${COLOR.gold}${server.name} ${COLOR.gray}is asleep\n${COLOR.green}Join to start it`
    : `${COLOR.yellow}${server.name} ${COLOR.gray}is starting…\n${COLOR.gray}Try again in a moment`;
  return JSON.stringify({
    version: { name: sleeping ? 'Sleeping' : 'Starting', protocol },
    players: { max: 0, online: 0, sample: [] },
    description: { text: description },
  });
}

function disconnectJson(server, ok) {
  const text = ok
    ? `${COLOR.gold}${server.name}\n\n${COLOR.green}Waking the server up…\n${COLOR.gray}Reconnect in about 30 seconds.`
    : `${COLOR.gold}${server.name}\n\n${COLOR.red}Could not start the server.\n${COLOR.gray}Ask an admin to take a look.`;
  return JSON.stringify({ text });
}

function unknownHostJson(host) {
  return JSON.stringify({
    text: `§cNo server is registered for §f${host}§c.`,
  });
}

function handleConnection(socket) {
  socket.setTimeout(15000);
  socket.on('error', () => socket.destroy());
  socket.on('timeout', () => socket.destroy());

  let buf = Buffer.alloc(0);
  let handshake = null;
  let server = null;

  socket.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);

    // Legacy (<=1.6) server list ping — just hang up.
    if (!handshake && buf[0] === 0xfe) return socket.destroy();

    let pkt;
    while ((pkt = takePacket(buf))) {
      buf = pkt.rest;

      if (!handshake) {
        if (pkt.id !== 0x00) return socket.destroy();
        handshake = parseHandshake(pkt.payload);
        if (!handshake) return socket.destroy();
        server = getServerByHostname(handshake.host);
        continue;
      }

      if (handshake.nextState === 1) {
        if (pkt.id === 0x00) {
          const json = server
            ? statusJson(server, handshake.protocol, stateOf(server.id).phase)
            : JSON.stringify({
                version: { name: 'Unknown', protocol: handshake.protocol },
                players: { max: 0, online: 0 },
                description: { text: `§cUnknown host §f${handshake.host}` },
              });
          socket.write(packet(0x00, writeString(json)));
        } else if (pkt.id === 0x01 && pkt.payload.length >= 8) {
          socket.write(packet(0x01, pkt.payload.slice(0, 8)));
          socket.end();
        }
        continue;
      }

      if (handshake.nextState === 2) {
        // Login start (or anything else in login state): boot the server, then
        // disconnect with an explanation. We answer immediately rather than
        // holding the socket open, because vanilla clients time out long before
        // a cold Minecraft server finishes generating a world.
        if (!server) {
          socket.write(packet(0x00, writeString(unknownHostJson(handshake.host))));
          return socket.end();
        }
        if (!server.autostart_on_join) {
          socket.write(
            packet(0x00, writeString(JSON.stringify({ text: `§6${server.name}\n\n§cThis server is offline.` })))
          );
          return socket.end();
        }
        socket.write(packet(0x00, writeString(disconnectJson(server, true))));
        socket.end();
        console.log(`[waker] join attempt on ${handshake.host} -> starting ${server.slug}`);
        startAndWait(server.id).catch((e) => console.error('[waker] start failed:', e.message));
        return;
      }

      return socket.destroy();
    }
  });
}

export function startWaker() {
  const srv = net.createServer(handleConnection);
  srv.on('error', (e) => console.error('[waker] listen error:', e.message));
  srv.listen(config.wakerPort, '0.0.0.0', () =>
    console.log(`[waker] listening on :${config.wakerPort}`)
  );
  return srv;
}
