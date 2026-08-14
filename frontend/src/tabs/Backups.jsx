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

  if (error) return <div className="card badge-error">{error}</div>;
  if (!data) return <div className="empty">Loading…</div>;

  return (
    <div className="stack">
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
              <th>Backup</th>
              <th style={{ width: 90 }}>Size</th>
              <th style={{ width: 110 }}>Created</th>
              <th style={{ width: 230 }}></th>
            </tr>
          </thead>
          <tbody>
            {data.backups.map((b) => (
              <tr key={b.id}>
                <td style={{ wordBreak: 'break-all' }}>
                  <span className="small mono">{b.filename}</span>{' '}
                  <span className="pill">{b.kind}</span>
                </td>
                <td className="muted small">{bytes(b.size)}</td>
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
            restore.filename.includes('-all-') ? '/data contents' : `"${data.worldDir}" folder`
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
          message={remove.filename}
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
