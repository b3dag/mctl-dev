import React, { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import { useAsync } from '../ui.jsx';

export default function Players({ server, state }) {
  const [list, setList] = useState(null);
  const [error, setError] = useState(null);
  const [target, setTarget] = useState('');
  const [reason, setReason] = useState('');
  const [ip, setIp] = useState('');
  const [whitelist, setWhitelist] = useState(null);
  const { busy, run } = useAsync();

  const load = useCallback(() => {
    if (state.phase !== 'ready') return;
    api.players(server.id).then(setList).catch((e) => setError(e.message));
  }, [server.id, state.phase]);

  useEffect(() => {
    load();
    const t = setInterval(load, 15000);
    return () => clearInterval(t);
  }, [load]);

  if (state.phase !== 'ready')
    return <div className="card empty">Start the server to manage players.</div>;

  const doAction = (action, player) =>
    run(async () => {
      await api.playerAction(server.id, action, { player, reason });
      load();
      if (action.startsWith('whitelist')) loadWhitelist();
    }, `${action} ${player}`);

  const loadWhitelist = () =>
    run(async () => {
      const { output } = await api.rcon(server.id, 'whitelist list');
      setWhitelist(String(output).replace(/§./g, ''));
    });

  return (
    <div className="stack">
      {error && <div className="card err-text">{error}</div>}

      <div className="card">
        <div className="row between" style={{ marginBottom: 8 }}>
          <strong>Online{list ? ` (${list.online}${list.max ? `/${list.max}` : ''})` : ''}</strong>
          <button className="sm ghost" onClick={load}>refresh</button>
        </div>
        {!list?.players?.length ? (
          <div className="muted small">Nobody is online right now.</div>
        ) : (
          <table>
            <tbody>
              {list.players.map((p) => (
                <tr key={p}>
                  <td className="mono">{p}</td>
                  <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                    <button className="sm" disabled={busy} onClick={() => doAction('kick', p)}>kick</button>{' '}
                    <button className="sm danger" disabled={busy} onClick={() => doAction('ban', p)}>ban</button>{' '}
                    <button className="sm" disabled={busy} onClick={() => doAction('op', p)}>op</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="card stack">
        <strong>Act on any player</strong>
        <div className="row wrap" style={{ gap: 10 }}>
          <div className="grow" style={{ minWidth: 160 }}>
            <label>Player name</label>
            <input value={target} onChange={(e) => setTarget(e.target.value)} placeholder="Notch" />
          </div>
          <div className="grow" style={{ minWidth: 160 }}>
            <label>Reason (kick/ban)</label>
            <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="optional" />
          </div>
        </div>
        <div className="row wrap" style={{ gap: 8 }}>
          {[
            ['kick', 'Kick'],
            ['ban', 'Ban'],
            ['pardon', 'Unban'],
            ['op', 'Op'],
            ['deop', 'Deop'],
            ['whitelist-add', 'Whitelist +'],
            ['whitelist-remove', 'Whitelist −'],
          ].map(([action, label]) => (
            <button
              key={action}
              className={`sm ${action === 'ban' ? 'danger' : ''}`}
              disabled={busy || !target.trim()}
              onClick={() => doAction(action, target.trim())}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="card stack">
        <strong>Ban an IP</strong>
        <div className="row" style={{ gap: 8 }}>
          <input className="grow mono" value={ip} onChange={(e) => setIp(e.target.value)} placeholder="203.0.113.4" />
          <button
            className="danger"
            disabled={busy || !ip.trim()}
            onClick={() => run(async () => { await api.banIp(server.id, ip.trim(), reason); setIp(''); }, 'IP banned')}
          >
            Ban IP
          </button>
        </div>
      </div>

      <div className="card stack">
        <div className="row between">
          <strong>Whitelist</strong>
          <button className="sm ghost" onClick={loadWhitelist}>load</button>
        </div>
        {whitelist ? <div className="small mono">{whitelist}</div> : <div className="small muted">Not loaded.</div>}
      </div>
    </div>
  );
}
