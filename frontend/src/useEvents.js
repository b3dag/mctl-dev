import { useEffect, useRef, useState } from 'react';
import { wsUrl } from './api.js';

/**
 * Live per-server state from the manager's event feed, with reconnect.
 * Returns { states, connected } and calls onServers() when the server list
 * itself changed (create/delete) so callers can refetch.
 */
export function useEvents(onServers) {
  const [states, setStates] = useState({});
  const [connected, setConnected] = useState(false);
  const cbRef = useRef(onServers);
  cbRef.current = onServers;

  useEffect(() => {
    let ws;
    let retry;
    let closed = false;
    let delay = 1000;

    const connect = () => {
      ws = new WebSocket(wsUrl('/api/ws/events'));
      ws.onopen = () => {
        setConnected(true);
        delay = 1000;
      };
      ws.onmessage = (ev) => {
        let msg;
        try {
          msg = JSON.parse(ev.data);
        } catch {
          return;
        }
        if (msg.type === 'states') setStates(msg.data);
        else if (msg.type === 'state') setStates((s) => ({ ...s, [msg.data.id]: msg.data.state }));
        else if (msg.type === 'servers') cbRef.current?.();
      };
      ws.onclose = () => {
        setConnected(false);
        if (closed) return;
        retry = setTimeout(connect, delay);
        delay = Math.min(delay * 2, 15000);
      };
      ws.onerror = () => ws.close();
    };
    connect();

    return () => {
      closed = true;
      clearTimeout(retry);
      ws?.close();
    };
  }, []);

  return { states, connected };
}
