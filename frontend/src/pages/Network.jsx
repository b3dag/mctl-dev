import React, { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { useAsync, useToast } from '../ui.jsx';

/**
 * One page for "can players reach this and how". Replaces the old Ports and
 * Router pages, which were the same subject split by implementation.
 */
export default function Network() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const { busy, run } = useAsync();
  const toast = useToast();

  const load = useCallback(() => {
    api.network().then(setData).catch((e) => setError(e.message));
  }, []);

  useEffect(load, [load]);

  if (error) return <div className="card err-text">{error}</div>;
  if (!data) return <div className="empty">Loading</div>;

  const copy = (text) => { navigator.clipboard?.writeText(text); toast('Copied'); };
  const direct = data.servers.filter((s) => s.hostPort);
  const drifted = data.router.routes.filter((r) => r.drifted);

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h2>Network</h2>
          <div className="muted small">How players reach your servers, and what is open on the host</div>
        </div>
        <button className="sm" onClick={load}>Refresh</button>
      </div>

      {data.conflicts.length > 0 && (
        <div className="card err-text">
          {data.conflicts.map((c) => `Port ${c.port} is claimed by ${c.servers.join(' and ')}.`).join(' ')}
        </div>
      )}

      <section className="card">
        <div className="card-head"><h3>Addresses</h3></div>
        <table>
          <thead>
            <tr>
              <th style={{ width: 150 }}>Server</th>
              <th>Through the router</th>
              <th>Direct</th>
            </tr>
          </thead>
          <tbody>
            {data.servers.map((s) => (
              <tr key={s.id}>
                <td><Link to={`/servers/${s.id}`}>{s.name}</Link></td>
                <td><button className="link mono" onClick={() => copy(s.routerAddress)}>{s.routerAddress}</button></td>
                <td>
                  {s.directAddress ? (
                    <button className="link mono" onClick={() => copy(s.directAddress)}>{s.directAddress}</button>
                  ) : (
                    <span className="muted">none</span>
                  )}
                  {s.pendingRestart && (
                    <div className="err-text small">Not applied yet, recreate the container</div>
                  )}
                </td>
              </tr>
            ))}
            {data.servers.length === 0 && (
              <tr><td colSpan={3} className="muted small">No servers yet.</td></tr>
            )}
          </tbody>
        </table>
      </section>

      <section className="card">
        <div className="card-head"><h3>Open on the host</h3></div>
        <table>
          <thead>
            <tr><th style={{ width: 90 }}>Port</th><th>Used by</th></tr>
          </thead>
          <tbody>
            <tr>
              <td className="mono">{data.sharedPort}</td>
              <td>mc-router, shared by every hostname above</td>
            </tr>
            {direct.map((s) => (
              <tr key={s.id}>
                <td className="mono">{s.hostPort}</td>
                <td><Link to={`/servers/${s.id}`}>{s.name}</Link>, published directly</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="card">
        <div className="card-head">
          <h3>Routing</h3>
          <div className="row" style={{ gap: 8 }}>
            <span className="pill">
              <span className={`dot ${data.router.reachable ? 'ready' : 'unhealthy'}`} />
              {data.router.reachable ? 'mc-router reachable' : 'mc-router unreachable'}
            </span>
            <button
              className="sm"
              disabled={busy}
              onClick={() => run(async () => { await api.syncRouter(); load(); }, 'Routes resynced')}
            >
              Resync
            </button>
          </div>
        </div>

        {data.router.status.lastError && (
          <div className="err-text small" style={{ marginBottom: 8 }}>{data.router.status.lastError}</div>
        )}

        {drifted.length === 0 ? (
          <div className="muted small">
            All {data.router.routes.length} route{data.router.routes.length === 1 ? '' : 's'} match what mctl expects.
          </div>
        ) : (
          <table>
            <thead>
              <tr><th>Hostname</th><th>Live</th><th>Expected</th></tr>
            </thead>
            <tbody>
              {drifted.map((r) => (
                <tr key={r.hostname}>
                  <td className="mono small">{r.hostname}</td>
                  <td className="mono small">{r.live || <span className="muted">none</span>}</td>
                  <td className="mono small err-text">{r.expected || <span className="muted">none</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="card">
        <div className="card-head"><h3>Internal only, never published</h3></div>
        <table>
          <thead>
            <tr><th style={{ width: 90 }}>Port</th><th style={{ width: 150 }}>Where</th><th>What</th></tr>
          </thead>
          <tbody>
            {data.internal.map((p) => (
              <tr key={`${p.scope}-${p.port}`}>
                <td className="mono">{p.port}</td>
                <td className="muted small">{p.scope}</td>
                <td className="small">{p.description}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}
