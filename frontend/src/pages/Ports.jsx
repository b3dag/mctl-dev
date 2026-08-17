import React, { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { useToast } from '../ui.jsx';

function Address({ value, onCopy }) {
  if (!value) return <span className="muted">none</span>;
  return <button className="link mono" onClick={() => onCopy(value)}>{value}</button>;
}

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

  // What the operator has to open on the firewall: the shared router port,
  // plus one entry per directly published server.
  const open = [
    { port: data.shared.port, used: data.shared.description, id: 'shared' },
    ...data.servers
      .filter((s) => s.hostPort)
      .map((s) => ({ port: s.hostPort, used: `${s.name}, direct`, id: s.id, pending: s.pendingRestart })),
  ].sort((a, b) => a.port - b.port);

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
        <div className="card-head"><h3>How players reach each server</h3></div>
        <table>
          <thead>
            <tr>
              <th style={{ width: 150 }}>Server</th>
              <th>Router address</th>
              <th>Direct connection</th>
            </tr>
          </thead>
          <tbody>
            {data.servers.map((s) => (
              <tr key={s.id}>
                <td><Link to={`/servers/${s.id}`}>{s.name}</Link></td>
                <td><Address value={s.routerAddress} onCopy={copy} /></td>
                <td>
                  <Address value={s.directAddress} onCopy={copy} />
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
      </div>

      <div className="card">
        <div className="card-head"><h3>Open on the host</h3></div>
        <table>
          <thead>
            <tr>
              <th style={{ width: 80 }}>Port</th>
              <th>Used by</th>
            </tr>
          </thead>
          <tbody>
            {open.map((o) => (
              <tr key={o.id}>
                <td className="mono">{o.port}</td>
                <td>{o.used}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="card">
        <div className="card-head"><h3>Internal only, never published</h3></div>
        <table>
          <thead>
            <tr>
              <th style={{ width: 80 }}>Port</th>
              <th style={{ width: 150 }}>Where</th>
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
