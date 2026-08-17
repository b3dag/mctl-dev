import React, { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { when } from '../ui.jsx';

export default function Activity() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [actor, setActor] = useState('');
  const [q, setQ] = useState('');

  const load = useCallback(() => {
    api
      .audit({ actor: actor || undefined, q: q || undefined })
      .then(setData)
      .catch((e) => setError(e.message));
  }, [actor, q]);

  useEffect(load, [load]);

  if (error) return <div className="card err-text">{error}</div>;
  if (!data) return <div className="empty">Loading</div>;

  return (
    <div className="stack">
      <div className="row between wrap">
        <div className="row" style={{ gap: 8 }}>
          <h2>Activity</h2>
          <span className="muted small">{data.entries.length} of {data.total}</span>
        </div>
        <button className="sm" onClick={load}>Refresh</button>
      </div>

      <div className="card row wrap" style={{ gap: 10 }}>
        <div style={{ minWidth: 180 }}>
          <label>Who</label>
          <select value={actor} onChange={(e) => setActor(e.target.value)}>
            <option value="">Everyone</option>
            {data.actors.map((a) => (
              <option key={a.actor} value={a.actor}>{a.actor} ({a.n})</option>
            ))}
          </select>
        </div>
        <div className="grow" style={{ minWidth: 180 }}>
          <label>Search</label>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="action, detail or server" />
        </div>
      </div>

      <div className="card" style={{ padding: 0 }}>
        <table>
          <thead>
            <tr>
              <th style={{ width: 110 }}>When</th>
              <th style={{ width: 170 }}>Who</th>
              <th style={{ width: 150 }}>Action</th>
              <th style={{ width: 130 }}>Server</th>
              <th>Detail</th>
            </tr>
          </thead>
          <tbody>
            {data.entries.map((e) => (
              <tr key={e.id}>
                <td className="muted small" title={new Date(e.at).toLocaleString()}>{when(e.at)}</td>
                <td className="small" style={{ wordBreak: 'break-all' }}>{e.actor || 'system'}</td>
                <td className="mono small">{e.action}</td>
                <td className="small">
                  {e.server_id ? (
                    e.server_name ? <Link to={`/servers/${e.server_id}`}>{e.server_name}</Link>
                      : <span className="muted">deleted</span>
                  ) : <span className="muted">-</span>}
                </td>
                <td className="small mono" style={{ wordBreak: 'break-word' }}>{e.detail || ''}</td>
              </tr>
            ))}
            {data.entries.length === 0 && (
              <tr><td colSpan={5} className="muted small">Nothing recorded yet.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
