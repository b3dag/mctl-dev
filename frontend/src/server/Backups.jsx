import React, { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import { Confirm, bytes, useAsync, when } from '../ui.jsx';

const PRESETS = [
  ['0 4 * * *', 'Daily at 04:00'],
  ['0 */6 * * *', 'Every 6 hours'],
  ['0 4 * * 0', 'Weekly, Sunday 04:00'],
];

export default function Backups({ server }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [restore, setRestore] = useState(null);
  const [remove, setRemove] = useState(null);
  const [cron, setCron] = useState('');
  const [keep, setKeep] = useState(7);
  const { busy, run } = useAsync();

  const load = useCallback(() => {
    api
      .backups(server.id)
      .then((d) => {
        setData(d);
        setCron(d.schedule?.cron || '');
        setKeep(d.schedule?.keep ?? 7);
      })
      .catch((e) => setError(e.message));
  }, [server.id]);

  useEffect(load, [load]);

  if (error) return <div className="card err-text">{error}</div>;
  if (!data) return <div className="empty">Loading…</div>;

  return (
    <div className="stack">
      {data.repo?.server && (
        <div className="card">
          <div className="card-head"><h3>Snapshots of this server</h3></div>
          <dl className="kv">
            <dt>Count</dt>
            <dd>{data.repo.server.snapshots}</dd>
            <dt>Restored size</dt>
            <dd className="mono">{bytes(data.repo.server.logical)}</dd>
          </dl>
          {data.repo.server.snapshots !== data.backups.filter((b) => b.engine === 'restic').length && (
            <div className="hint err-text">
              The repository holds {data.repo.server.snapshots} snapshot(s) for this server but
              mctl has {data.backups.filter((b) => b.engine === 'restic').length} row(s). Snapshots
              taken outside mctl are not listed below.
            </div>
          )}

          <div className="card-head" style={{ marginTop: 14 }}><h3>Repository</h3></div>
          <dl className="kv">
            <dt>Snapshots</dt>
            <dd>{data.repo.repo.snapshots} <span className="muted">across every server</span></dd>
            <dt>Stored on disk</dt>
            <dd className="mono">{bytes(data.repo.repo.onDisk)}</dd>
            <dt>Restored size</dt>
            <dd className="mono">
              {bytes(data.repo.repo.logical)}
              {data.repo.repo.saved > 0 && (
                <span className="muted"> ({bytes(data.repo.repo.saved)} saved by deduplication)</span>
              )}
            </dd>
          </dl>
          <div className="row" style={{ marginTop: 10 }}>
            <button
              className="sm"
              disabled={busy}
              onClick={() => run(async () => { const r = await api.checkBackups(server.id); alert(r.result); })}
            >
              Verify integrity
            </button>
          </div>
        </div>
      )}

      {data.repo?.error && <div className="card err-text">Repository: {data.repo.error}</div>}

      <div className="card stack">
        <div className="row between wrap">
          <strong>Manual backup</strong>
          <div className="row" style={{ gap: 8 }}>
            <button
              disabled={busy}
              onClick={() => run(async () => { await api.createBackup(server.id, 'world'); load(); }, 'World backed up')}
            >
              Back up world
            </button>
            <button
              disabled={busy}
              onClick={() => run(async () => { await api.createBackup(server.id, 'all'); load(); }, 'Full backup done')}
            >
              Back up everything
            </button>
          </div>
        </div>
        <div className="small muted">
          World folder: <code>{data.worldDir}</code>. Running servers get <code>save-off</code> +{' '}
          <code>save-all flush</code> first, so the snapshot is consistent.
        </div>
      </div>

      <div className="card stack">
        <strong>Schedule</strong>
        <div className="row wrap" style={{ gap: 10 }}>
          <div className="grow" style={{ minWidth: 170 }}>
            <label>Cron expression (empty = off)</label>
            <input className="mono" value={cron} onChange={(e) => setCron(e.target.value)} placeholder="0 4 * * *" />
          </div>
          <div style={{ width: 110 }}>
            <label>Keep</label>
            <input type="number" min="1" value={keep} onChange={(e) => setKeep(Number(e.target.value))} />
          </div>
          <div style={{ alignSelf: 'flex-end' }}>
            <button
              className="primary"
              disabled={busy}
              onClick={() =>
                run(async () => {
                  await api.setBackupSchedule(server.id, { cron: cron.trim() || null, keep });
                  load();
                }, 'Schedule saved')
              }
            >
              Save
            </button>
          </div>
        </div>
        <div className="row wrap small" style={{ gap: 6 }}>
          {PRESETS.map(([expr, label]) => (
            <button key={expr} className="sm ghost" onClick={() => setCron(expr)}>{label}</button>
          ))}
        </div>
      </div>

      <div className="card" style={{ padding: 0, overflowX: 'auto' }}>
        <table>
          <thead>
            <tr>
              <th>Snapshot</th>
              <th style={{ width: 130 }}>Added</th>
              <th style={{ width: 110 }}>Created</th>
              <th style={{ width: 230 }}></th>
            </tr>
          </thead>
          <tbody>
            {data.backups.map((b) => (
              <tr key={b.id}>
                <td>
                  <span className="small mono">
                    {b.engine === 'restic' ? String(b.snapshot_id).slice(0, 8) : b.filename}
                  </span>{' '}
                  <span className="pill">{b.kind}</span>
                  {b.engine === 'tar' && <span className="pill">legacy tar</span>}
                  {b.scope === 'all' && <span className="pill">all of /data</span>}
                </td>
                <td className="muted small">
                  {bytes(b.size)}
                  {b.logical_size > 0 && <div>of {bytes(b.logical_size)}</div>}
                </td>
                <td className="muted small">{when(b.created_at)}</td>
                <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                  <a className="btn sm" href={api.backupUrl(server.id, b.id, 'zip')} download>zip</a>{' '}
                  <a className="btn sm" href={api.backupUrl(server.id, b.id)} download>tar.gz</a>{' '}
                  <button className="sm" onClick={() => setRestore(b)}>restore</button>{' '}
                  <button className="sm danger" onClick={() => setRemove(b)}>del</button>
                </td>
              </tr>
            ))}
            {data.backups.length === 0 && (
              <tr><td colSpan={4} className="muted small">No backups yet.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {restore && (
        <Confirm
          title="Restore this backup?"
          message={`The server will be stopped, the current ${
            restore.scope === 'all' ? 'contents of /data' : `"${data.worldDir}" folder`
          } replaced with the snapshot, and the server started again if it was running. This cannot be undone.`}
          confirmWord={server.slug}
          onClose={() => setRestore(null)}
          onConfirm={() =>
            run(async () => {
              await api.restoreBackup(server.id, restore.id, server.slug);
              setRestore(null);
              load();
            }, 'Restored')
          }
        />
      )}

      {remove && (
        <Confirm
          title="Delete this backup?"
          message={remove.engine === 'restic' ? `Snapshot ${String(remove.snapshot_id).slice(0, 8)}` : remove.filename}
          onClose={() => setRemove(null)}
          onConfirm={() =>
            run(async () => {
              await api.deleteBackup(server.id, remove.id);
              setRemove(null);
              load();
            }, 'Deleted')
          }
        />
      )}
    </div>
  );
}
