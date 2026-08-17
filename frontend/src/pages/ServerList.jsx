import React from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { StatusDot, PHASE_LABEL, useAsync, useToast, when } from '../ui.jsx';

/** The home screen: every server, its address, and the actions you reach for. */
export default function ServerList({ servers, states, me, onChange }) {
  const { busy, run } = useAsync();
  const toast = useToast();

  const act = (id, fn, msg) => run(async () => { await fn(id); onChange?.(); }, msg);
  const copy = (text) => { navigator.clipboard?.writeText(text); toast('Copied'); };

  if (servers === null) return <div className="empty">Loading</div>;

  const running = servers.filter((s) => (states[s.id] || s.state || {}).running).length;
  const players = servers.reduce((n, s) => n + ((states[s.id] || {}).online || 0), 0);

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h2>Servers</h2>
          <div className="muted small">
            {servers.length} total, {running} running, {players} player{players === 1 ? '' : 's'} online
          </div>
        </div>
        <Link to="/new"><button className="primary">New server</button></Link>
      </div>

      {servers.length === 0 ? (
        <div className="card empty">
          No servers yet. <Link to="/new">Create one</Link>.
        </div>
      ) : (
        <div className="card" style={{ padding: 0 }}>
          <table>
            <thead>
              <tr>
                <th>Server</th>
                <th style={{ width: 130 }}>Status</th>
                <th>Address</th>
                <th style={{ width: 210 }}></th>
              </tr>
            </thead>
            <tbody>
              {servers.map((s) => {
                const state = states[s.id] || s.state || {};
                return (
                  <tr key={s.id}>
                    <td>
                      <Link to={`/servers/${s.id}`} className="strong">{s.name}</Link>
                      <div className="muted small">
                        {s.type} {s.version}
                        {!s.autostartOnJoin && <span className="pill" style={{ marginLeft: 6 }}>wake off</span>}
                      </div>
                    </td>
                    <td>
                      <span className="row" style={{ gap: 6 }}>
                        <StatusDot state={state} />
                        <span className="small">{PHASE_LABEL[state.phase] || 'Unknown'}</span>
                      </span>
                      {state.phase === 'ready' ? (
                        <div className="muted small">
                          {state.online ?? 0}{state.max ? `/${state.max}` : ''} online
                        </div>
                      ) : state.lastSeen ? (
                        <div className="muted small">{when(state.lastSeen)}</div>
                      ) : null}
                    </td>
                    <td>
                      <button className="link mono" onClick={() => copy(s.routerAddress)}>{s.routerAddress}</button>
                      {s.directAddress && (
                        <div>
                          <button className="link mono muted" onClick={() => copy(s.directAddress)}>
                            {s.directAddress}
                          </button>
                        </div>
                      )}
                    </td>
                    <td className="actions">
                      {state.running ? (
                        <>
                          <button className="sm" disabled={busy} onClick={() => act(s.id, api.stop, `${s.name} stopping`)}>Stop</button>
                          <button className="sm" disabled={busy} onClick={() => act(s.id, api.restart, `${s.name} restarting`)}>Restart</button>
                        </>
                      ) : (
                        <button className="sm primary" disabled={busy} onClick={() => act(s.id, api.start, `${s.name} starting`)}>Start</button>
                      )}
                      <Link to={`/servers/${s.id}`}><button className="sm">Open</button></Link>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <div className="card">
        <dl className="kv">
          <dt>Base domain</dt>
          <dd className="mono">{me?.domain || 'not set'}</dd>
          <dt>Shared port</dt>
          <dd className="mono">{me?.publicMcPort ?? 25565}</dd>
        </dl>
      </div>
    </div>
  );
}
