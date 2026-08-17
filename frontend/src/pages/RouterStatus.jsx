import React, { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { useAsync } from '../ui.jsx';

export default function RouterStatus() {
  const [info, setInfo] = useState(null);
  const [health, setHealth] = useState(null);
  const [error, setError] = useState(null);
  const { busy, run } = useAsync();

  const load = useCallback(() => {
    Promise.all([api.routerInfo(), api.health()])
      .then(([i, h]) => {
        setInfo(i);
        setHealth(h);
      })
      .catch((e) => setError(e.message));
  }, []);

  useEffect(load, [load]);

  if (error) return <div className="card badge-error">{error}</div>;
  if (!info) return <div className="empty">Loading…</div>;

  const live = info.live || {};
  const expected = info.expected || {};
  const hosts = [...new Set([...Object.keys(live), ...Object.keys(expected)])].sort();

  return (
    <div className="stack">
      <div className="row between">
        <h2>mc-router</h2>
        <Link to="/"><button className="ghost">Back</button></Link>
      </div>

      <div className="card stack">
        <div className="row wrap" style={{ gap: 10 }}>
          <span className="pill">
            <span className={`dot ${health?.docker ? 'ready' : 'unhealthy'}`} /> Docker
          </span>
          <span className="pill">
            <span className={`dot ${info.live ? 'ready' : 'unhealthy'}`} /> Router API
          </span>
          <span className="pill mono">{info.status.api}</span>
        </div>
        {info.status.lastError && <div className="badge-error small">{info.status.lastError}</div>}
        <div className="small muted">
          Sleeping hostnames point at <code>{info.wakerTarget}</code>, which starts the container on a
          join attempt.
        </div>
        <div>
          <button disabled={busy} onClick={() => run(async () => { await api.routerSync(); load(); }, 'Routes resynced')}>
            Resync routes
          </button>
        </div>
      </div>

      <div className="card" style={{ padding: 0, overflowX: 'auto' }}>
        <table>
          <thead>
            <tr>
              <th>Hostname</th>
              <th>Live backend</th>
              <th>Expected</th>
            </tr>
          </thead>
          <tbody>
            {hosts.map((h) => (
              <tr key={h}>
                <td className="mono small">{h}</td>
                <td className="mono small">{live[h] || <span className="muted">-</span>}</td>
                <td className={`mono small ${live[h] !== expected[h] ? 'badge-error' : ''}`}>
                  {expected[h] || <span className="muted">-</span>}
                </td>
              </tr>
            ))}
            {hosts.length === 0 && <tr><td colSpan={3} className="muted small">No routes registered.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
