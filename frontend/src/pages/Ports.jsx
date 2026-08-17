import React, { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { useToast } from '../ui.jsx';

export default function Ports() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const toast = useToast();

  const load = useCallback(() => {
    api.ports().then(setData).catch((e) => setError(e.message));
  }, []);

  useEffect(load, [load]);

  if (error) return <div className="card err-text">{error}</div>;
  if (!data) return <div className="empty">Loading…</div>;

  const copy = (text) => { navigator.clipboard?.writeText(text); toast('Copied'); };

  return (
    <div className="stack">
      <div className="row between wrap">
        <h2>Ports</h2>
        <button className="sm" onClick={load}>Refresh</button>
      </div>

      {data.conflicts.length > 0 && (
        <div className="card">
          <div className="err-text">
            {data.conflicts.map((c) => `Port ${c.port} is claimed by ${c.servers.join(' and ')}`).join('. ')}.
          </div>
          <div className="hint">Only one of them will start. Change one under its settings.</div>
        </div>
      )}

      <div className="card">
        <div className="card-head"><h3>Open on the host</h3></div>
        <table>
          <thead>
            <tr><th style={{ width: 80 }}>Port</th><th>What</th><th style={{ width: 130 }}>Connect with</th></tr>
          </thead>
          <tbody>
            <tr>
              <td className="mono">{data.shared.port}</td>
              <td>{data.shared.description}</td>
              <td className="muted small">any hostname below</td>
            </tr>
            {data.servers.filter((s) => s.hostPort).map((s) => (
              <tr key={s.id}>
                <td className="mono">{s.hostPort}</td>
                <td>
                  <Link to={`/servers/${s.id}`}>{s.name}</Link>
                  <span className="muted small"> — published directly</span>
                  {s.pendingRestart && (
                    <div className="err-text small">
                      not applied yet — recreate the container from its settings
                    </div>
                  )}
                </td>
                <td>
                  <button className="ghost sm mono" style={{ padding: 0 }} onClick={() => copy(s.address)}>
                    {s.address}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="hint" style={{ marginTop: 8 }}>
          These are the only ports you need to forward on your router or firewall.
        </div>
      </div>

      <div className="card">
        <div className="card-head"><h3>Reachable by hostname</h3></div>
        {data.servers.length === 0 ? (
          <div className="muted small">No servers yet.</div>
        ) : (
          <table>
            <thead>
              <tr><th>Server</th><th>Hostname</th><th style={{ width: 110 }}>Direct port</th></tr>
            </thead>
            <tbody>
              {data.servers.map((s) => (
                <tr key={s.id}>
                  <td><Link to={`/servers/${s.id}`}>{s.name}</Link></td>
                  <td>
                    <button className="ghost sm mono" style={{ padding: 0 }} onClick={() => copy(s.hostname)}>
                      {s.hostname}
                    </button>
                  </td>
                  <td className="mono">{s.hostPort || <span className="muted">—</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <div className="hint" style={{ marginTop: 8 }}>
          All of these share port {data.shared.port}. They need DNS pointing at this host — a
          wildcard record covers them all at once.
        </div>
      </div>

      <div className="card">
        <div className="card-head"><h3>Internal only</h3></div>
        <table>
          <thead>
            <tr><th style={{ width: 80 }}>Port</th><th>Where</th><th>What</th></tr>
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
        <div className="hint" style={{ marginTop: 8 }}>
          Not published to the host and not reachable from outside the Docker network. Nothing here
          needs forwarding.
        </div>
      </div>
    </div>
  );
}
