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
  if (!data) return <div className="empty">Loading</div>;

  const copy = (text) => {
    navigator.clipboard?.writeText(text);
    toast('Copied');
  };

  // One row per way a player can connect: the shared router port for every
  // hostname, plus a row for each server published on its own port.
  const rows = [];
  for (const s of data.servers) {
    rows.push({
      key: `${s.id}-host`,
      port: data.shared.port,
      domain: s.hostname,
      server: s,
      via: 'mc-router',
    });
    if (s.hostPort) {
      rows.push({
        key: `${s.id}-direct`,
        port: s.hostPort,
        domain: data.publicHost,
        server: s,
        via: 'direct',
        pendingRestart: s.pendingRestart,
      });
    }
  }
  rows.sort((a, b) => a.port - b.port || a.domain.localeCompare(b.domain));

  return (
    <div className="stack">
      <div className="row between wrap">
        <h2>Ports</h2>
        <button className="sm" onClick={load}>Refresh</button>
      </div>

      {data.conflicts.length > 0 && (
        <div className="card err-text">
          {data.conflicts.map((c) => `Port ${c.port} is claimed by ${c.servers.join(' and ')}.`).join(' ')}
        </div>
      )}

      <div className="card">
        <div className="card-head"><h3>Open on the host</h3></div>
        <table>
          <thead>
            <tr>
              <th style={{ width: 80 }}>Port</th>
              <th>Domain</th>
              <th style={{ width: 160 }}>Server</th>
              <th style={{ width: 90 }}>Via</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.key}>
                <td className="mono">{r.port}</td>
                <td>
                  <button className="link mono" onClick={() => copy(r.via === 'direct' ? `${r.domain}:${r.port}` : r.domain)}>
                    {r.domain}
                  </button>
                  {r.pendingRestart && (
                    <div className="err-text small">Not applied yet, recreate the container</div>
                  )}
                </td>
                <td><Link to={`/servers/${r.server.id}`}>{r.server.name}</Link></td>
                <td className="muted small">{r.via}</td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr><td colSpan={4} className="muted small">No servers yet.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="card">
        <div className="card-head"><h3>Internal only, never published</h3></div>
        <table>
          <thead>
            <tr>
              <th style={{ width: 80 }}>Port</th>
              <th style={{ width: 160 }}>Where</th>
              <th>What</th>
            </tr>
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
      </div>
    </div>
  );
}
