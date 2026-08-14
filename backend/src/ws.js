import { WebSocketServer } from 'ws';
import { authorizeUpgrade } from './auth.js';
import { getServer, audit } from './db.js';
import { followLogs, containerState } from './docker.js';
import { events, allStates, stateOf } from './servers.js';
import { rconCommand } from './rcon.js';

const CONSOLE_RE = /^\/api\/ws\/servers\/([0-9a-f-]{36})\/console$/i;

export function attachWebsockets(httpServer) {
  const wss = new WebSocketServer({ noServer: true });

  httpServer.on('upgrade', (req, socket, head) => {
    const user = authorizeUpgrade(req);
    if (!user) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      return socket.destroy();
    }
    const url = new URL(req.url, 'http://localhost');
    const consoleMatch = CONSOLE_RE.exec(url.pathname);

    if (url.pathname === '/api/ws/events') {
      wss.handleUpgrade(req, socket, head, (ws) => handleEvents(ws, user));
    } else if (consoleMatch) {
      wss.handleUpgrade(req, socket, head, (ws) => handleConsole(ws, user, consoleMatch[1]));
    } else {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
    }
  });

  return wss;
}

// --- dashboard event feed ---------------------------------------------------

function handleEvents(ws, user) {
  const send = (type, data) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type, data }));
  };
  send('states', allStates());

  const onState = ({ id, state }) => send('state', { id, state });
  const onStates = () => send('states', allStates());
  const onServers = () => send('servers', {});

  events.on('state', onState);
  events.on('states', onStates);
  events.on('servers', onServers);

  const ping = setInterval(() => ws.ping(), 30000);
  ws.on('close', () => {
    clearInterval(ping);
    events.off('state', onState);
    events.off('states', onStates);
    events.off('servers', onServers);
  });
}

// --- per-server console -----------------------------------------------------

async function handleConsole(ws, user, id) {
  const server = getServer(id);
  const send = (type, data) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type, data }));
  };

  if (!server) {
    send('error', { message: 'no such server' });
    return ws.close();
  }

  let logStream = null;
  let closed = false;

  const attach = async () => {
    const st = await containerState(server.container_name);
    if (!st.exists) return send('info', { message: 'container does not exist yet' });
    if (!st.running) return send('info', { message: 'server is stopped — start it to see live output' });
    try {
      logStream = await followLogs(server.container_name, { tail: 300 });
      let carry = '';
      logStream.on('data', (chunk) => {
        const text = carry + chunk.toString('utf8');
        const lines = text.split('\n');
        carry = lines.pop() ?? '';
        for (const line of lines) send('line', { line });
      });
      logStream.on('end', () => {
        if (!closed) send('info', { message: 'log stream ended' });
      });
      logStream.on('error', (e) => send('error', { message: e.message }));
    } catch (e) {
      send('error', { message: e.message });
    }
  };

  await attach();

  // Re-attach when the server comes back up, so the console survives restarts.
  const onState = ({ id: sid, state }) => {
    if (sid !== id) return;
    send('state', state);
    if (state.running && !logStream) attach().catch(() => {});
    if (!state.running && logStream) {
      logStream.destroy?.();
      logStream = null;
    }
  };
  events.on('state', onState);

  ws.on('message', async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (msg.type !== 'command') return;
    const command = String(msg.command || '').trim();
    if (!command) return;
    if (/^\s*(stop|restart)\b/i.test(command)) {
      return send('error', { message: 'use the stop/restart buttons so the manager can track state' });
    }
    try {
      const output = await rconCommand(server, command);
      audit(user, id, 'rcon', command);
      send('command', { command, output });
    } catch (e) {
      send('error', { message: `RCON: ${e.message}` });
    }
  });

  const ping = setInterval(() => ws.ping(), 30000);
  ws.on('close', () => {
    closed = true;
    clearInterval(ping);
    events.off('state', onState);
    logStream?.destroy?.();
  });

  send('state', stateOf(id));
}
