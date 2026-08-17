import React from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { StatusDot, PHASE_LABEL, useAsync, useToast, when } from '../ui.jsx';

export default function Overview({ servers, states, me, onChange }) {
  const { busy, run } = useAsync();
  const toast = useToast();

  const act = (id, fn, msg) => run(async () => { await fn(id); onChange?.(); }, msg);

  if (servers === null) return <div className="empty">Loading…</div>;

  const running = servers.filter((s) => (states[s.id] || s.state || {}).running).length;
  const players = servers.reduce((n, s) => n + ((states[s.id] || {}).online || 0), 0);

  return (
    <div className="stack">
      <div className="row between wrap">
        <h2>Overview</h2>
        <Link to="/new"><button className="primary">New server</button></Link>
      </div>

      <div className="card">
        <dl className="kv">
          <dt>Base domain</dt>
          <dd className="mono">{me?.domain || '-'}</dd>
          <dt>Shared port</dt>
          <dd className="mono">
            {me?.publicMcPort ?? 25565} <span className="muted">- mc-router, by hostname</span>
          </dd>
          <dt>Servers</dt>
          <dd>{servers.length} total, {running} running, {players} player{players === 1 ? '' : 's'} online</dd>
        </dl>
      </div>

      {servers.length === 0 ? (
        <div className="card empty">
          No servers yet. <Link to="/new">Create one</Link> - it gets a hostname under your domain,
          and optionally its own port.
        </div>
      ) : (
        <div className="card" style={{ padding: 0 }}>
          <table>
            <thead>
              <tr>
                <th>Server</th>
                <th>Address</th>
                <th style={{ width: 110 }}>Status</th>
                <th style={{ width: 190 }}></th>
              </tr>
            </thead>
            <tbody>
              {servers.map((s) => {
                const state = states[s.id] || s.state || {};
                return (
                  <tr key={s.id}>
                    <td>
                      <Link to={`/servers/${s.id}`} style={{ color: 'inherit', fontWeight: 500 }}>{s.name}</Link>
                      <div className="muted small">{s.type} {s.version}</div>
                    </td>
                    <td>
                      <button
                        className="link mono"
                        title="Copy router address"
                        onClick={() => { navigator.clipboard?.writeText(s.routerAddress); toast('Copied'); }}
                      >
                        {s.routerAddress}
                      </button>
                      {s.directAddress && (
                        <div>
                          <button
                            className="link mono muted"
                            title="Copy direct address"
                            onClick={() => { navigator.clipboard?.writeText(s.directAddress); toast('Copied'); }}
                          >
                            {s.directAddress}
                          </button>
                        </div>
                      )}
                    </td>
                    <td>
                      <span className="row" style={{ gap: 6 }}>
                        <StatusDot state={state} />
                        <span className="small">{PHASE_LABEL[state.phase] || '-'}</span>
                      </span>
                      {state.phase === 'ready' && (
                        <div className="muted small">{state.online ?? 0}{state.max ? `/${state.max}` : ''} online</div>
                      )}
                      {!state.running && state.lastSeen && (
                        <div className="muted small">{when(state.lastSeen)}</div>
                      )}
                    </td>
                    <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                      {state.running ? (
                        <>
                          <button className="sm" disabled={busy} onClick={() => act(s.id, api.stop, `${s.name} stopping`)}>Stop</button>{' '}
                          <button className="sm" disabled={busy} onClick={() => act(s.id, api.restart, `${s.name} restarting`)}>Restart</button>
                        </>
                      ) : (
                        <button className="sm primary" disabled={busy} onClick={() => act(s.id, api.start, `${s.name} starting`)}>Start</button>
                      )}{' '}
                      <Link to={`/servers/${s.id}/console`}><button className="sm">Console</button></Link>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
