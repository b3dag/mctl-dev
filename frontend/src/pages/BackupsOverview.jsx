import React, { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { bytes, when } from '../ui.jsx';

/**
 * The repository is shared by every server, so its health and deduplication
 * figures belong here rather than on any one server's page.
 */
export default function BackupsOverview() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  const load = useCallback(() => {
    api.allBackups().then(setData).catch((e) => setError(e.message));
  }, []);

  useEffect(load, [load]);

  if (error) return <div className="card err-text">{error}</div>;
  if (!data) return <div className="empty">Loading</div>;

  const repo = data.repo?.repo || {};
  const tracked = data.servers.reduce((n, s) => n + s.count, 0);

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h2>Backups</h2>
          <div className="muted small">One deduplicated repository shared by every server</div>
        </div>
        <button className="sm" onClick={load}>Refresh</button>
      </div>

      {data.repo?.error && <div className="card err-text">Repository: {data.repo.error}</div>}

      {!data.repo?.error && (
        <section className="card">
          <div className="card-head"><h3>Repository</h3></div>
          <dl className="kv">
            <dt>Snapshots</dt>
            <dd>{repo.snapshots}</dd>
            <dt>Stored on disk</dt>
            <dd className="mono">{bytes(repo.onDisk)}</dd>
            <dt>Restored size</dt>
            <dd className="mono">
              {bytes(repo.logical)}
              {repo.saved > 0 && <span className="muted"> ({bytes(repo.saved)} saved by deduplication)</span>}
            </dd>
          </dl>
          {repo.snapshots !== tracked && (
            <div className="hint err-text">
              The repository holds {repo.snapshots} snapshot(s) but mctl tracks {tracked}. Snapshots
              taken outside mctl are not listed on any server.
            </div>
          )}
        </section>
      )}

      <section className="card" style={{ padding: 0 }}>
        <table>
          <thead>
            <tr>
              <th>Server</th>
              <th style={{ width: 90 }}>Snapshots</th>
              <th style={{ width: 120 }}>Latest</th>
              <th>Schedule</th>
            </tr>
          </thead>
          <tbody>
            {data.servers.map((s) => (
              <tr key={s.id}>
                <td><Link to={`/servers/${s.id}/backups`}>{s.name}</Link></td>
                <td>{s.count}</td>
                <td className="muted small">{s.latest ? when(s.latest) : 'never'}</td>
                <td className="small">
                  {s.schedule?.enabled ? (
                    <>
                      <span className="mono">{s.schedule.cron}</span>
                      <span className="muted"> keeping {s.schedule.keep}</span>
                    </>
                  ) : (
                    <span className="muted">not scheduled</span>
                  )}
                </td>
              </tr>
            ))}
            {data.servers.length === 0 && (
              <tr><td colSpan={4} className="muted small">No servers yet.</td></tr>
            )}
          </tbody>
        </table>
      </section>
    </div>
  );
}
