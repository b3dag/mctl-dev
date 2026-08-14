import React, { useEffect, useRef, useState } from 'react';
import { wsUrl } from '../api.js';

const classify = (line) => {
  if (/\b(ERROR|FATAL|Exception|SEVERE)\b/.test(line)) return 'err';
  if (/\bWARN(ING)?\b/.test(line)) return 'warn';
  return '';
};

export default function Console({ server, state }) {
  const [lines, setLines] = useState([]);
  const [connected, setConnected] = useState(false);
  const [cmd, setCmd] = useState('');
  const [history, setHistory] = useState([]);
  const [histIdx, setHistIdx] = useState(-1);
  const boxRef = useRef(null);
  const wsRef = useRef(null);
  const stickRef = useRef(true);

  const push = (line, kind = '') =>
    setLines((prev) => [...prev.slice(-1500), { line, kind, key: `${Date.now()}-${Math.random()}` }]);

  useEffect(() => {
    let ws;
    let retry;
    let closed = false;

    const connect = () => {
      ws = new WebSocket(wsUrl(`/api/ws/servers/${server.id}/console`));
      wsRef.current = ws;
      ws.onopen = () => setConnected(true);
      ws.onclose = () => {
        setConnected(false);
        if (!closed) retry = setTimeout(connect, 2000);
      };
      ws.onerror = () => ws.close();
      ws.onmessage = (ev) => {
        let msg;
        try {
          msg = JSON.parse(ev.data);
        } catch {
          return;
        }
        if (msg.type === 'line') push(msg.data.line, classify(msg.data.line));
        else if (msg.type === 'info') push(`— ${msg.data.message}`, 'sys');
        else if (msg.type === 'error') push(`! ${msg.data.message}`, 'err');
        else if (msg.type === 'command') {
          push(`> ${msg.data.command}`, 'echo');
          if (msg.data.output) push(String(msg.data.output).replace(/§./g, ''));
        }
      };
    };
    connect();

    return () => {
      closed = true;
      clearTimeout(retry);
      ws?.close();
    };
  }, [server.id]);

  useEffect(() => {
    const box = boxRef.current;
    if (box && stickRef.current) box.scrollTop = box.scrollHeight;
  }, [lines]);

  const onScroll = () => {
    const box = boxRef.current;
    if (!box) return;
    stickRef.current = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
  };

  const send = (e) => {
    e.preventDefault();
    const command = cmd.trim();
    if (!command || wsRef.current?.readyState !== WebSocket.OPEN) return;
    wsRef.current.send(JSON.stringify({ type: 'command', command }));
    setHistory((h) => [command, ...h.filter((c) => c !== command)].slice(0, 50));
    setHistIdx(-1);
    setCmd('');
  };

  const onKeyDown = (e) => {
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      const next = Math.min(histIdx + 1, history.length - 1);
      if (next >= 0) {
        setHistIdx(next);
        setCmd(history[next]);
      }
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      const next = histIdx - 1;
      setHistIdx(next);
      setCmd(next >= 0 ? history[next] : '');
    }
  };

  const canSend = state.phase === 'ready';

  return (
    <div className="stack">
      <div className="row between small muted">
        <span>{connected ? 'streaming container logs' : 'reconnecting…'}</span>
        <button className="sm ghost" onClick={() => setLines([])}>clear</button>
      </div>

      <div className="console" ref={boxRef} onScroll={onScroll}>
        {lines.length === 0 && <div className="sys">Waiting for output…</div>}
        {lines.map((l) => (
          <div key={l.key} className={l.kind}>{l.line}</div>
        ))}
      </div>

      <form className="row" onSubmit={send}>
        <input
          className="grow mono"
          value={cmd}
          onChange={(e) => setCmd(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={canSend ? 'say hello   (sent over RCON)' : 'server must be running to send commands'}
          disabled={!canSend}
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
        />
        <button className="primary" disabled={!canSend || !cmd.trim()}>Send</button>
      </form>
      <div className="small muted">
        <code>stop</code> and <code>restart</code> are blocked here — use the buttons above so the
        manager can update mc-router.
      </div>
    </div>
  );
}
