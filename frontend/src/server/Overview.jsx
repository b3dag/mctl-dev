import React, { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import { bytes, useToast, when } from '../ui.jsx';

function Spark({ points, max, label }) {
  if (!points.length) return <div className="muted small">No samples yet.</div>;
  const w = 300;
  const h = 56;
  const top = max || Math.max(...points, 1);
  const step = points.length > 1 ? w / (points.length - 1) : w;
  const line = points
    .map((v, i) => `${i === 0 ? 'M' : 'L'}${(i * step).toFixed(1)},${(h - (v / top) * h).toFixed(1)}`)
    .join(' ');
  return (
    <svg className="spark" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" role="img" aria-label={label}>
      <path d={`${line} L${w},${h} L0,${h} Z`} className="spark-fill" />
      <path d={line} className="spark-line" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

/** The server's landing page: where to connect, how it is doing, what changed. */
export default function Overview({ server, state, me }) {
  const [stats, setStats] = useState(null);
  const [disk, setDisk] = useState(undefined);
  const [activity, setActivity] = useState([]);
  const toast = useToast();

  const load = useCallback(
    (withDisk = false) => {
      api.stats(server.id, withDisk).then((d) => {
        setStats(d);
        if (d.disk !== undefined) setDisk(d.disk);
      }).catch(() => {});
      api.serverAudit(server.id).then((d) => setActivity(d.entries.slice(0, 8))).catch(() => {});
    },
    [server.id]
  );

  useEffect(() => {
    load();
    const t = setInterval(() => load(), 15000);
    return () => clearInterval(t);
  }, [load]);

  const copy = (text) => { navigator.clipboard?.writeText(text); toast('Copied'); };
  const history = stats?.history || [];
  const cpu = history.map((s) => s.cpuPercent);
  const mem = history.map((s) => s.memUsed);

  return (
    <div className="stack">
      <section className="card">
        <div className="card-head"><h3>Connect</h3></div>
        <table>
          <tbody>
            <tr>
              <td style={{ width: 170 }} className="muted">Through the router</td>
              <td><button className="link mono" onClick={() => copy(server.routerAddress)}>{server.routerAddress}</button></td>
            </tr>
            <tr>
              <td className="muted">Direct</td>
              <td>
                {server.directAddress ? (
                  <button className="link mono" onClick={() => copy(server.directAddress)}>{server.directAddress}</button>
                ) : (
                  <span className="muted">none, set a direct port under Settings</span>
                )}
              </td>
            </tr>
          </tbody>
        </table>
        {!server.autostartOnJoin && (
          <div className="hint">
            Wake-on-join is off, so players connecting are told the server is offline rather than
            starting it. Turn it back on under Settings.
          </div>
        )}
      </section>

      <div className="grid">
        <section className="card">
          <div className="card-head">
            <h3>CPU</h3>
            <span className="mono small">{stats?.current ? `${stats.current.cpuPercent.toFixed(1)}%` : 'idle'}</span>
          </div>
          <Spark points={cpu} label="CPU over time" />
          <div className="hint">{history.length} samples, one a minute</div>
        </section>

        <section className="card">
          <div className="card-head">
            <h3>Memory</h3>
            <span className="mono small">
              {stats?.current ? `${bytes(stats.current.memUsed)} / ${bytes(stats.current.memLimit)}` : 'idle'}
            </span>
          </div>
          <Spark points={mem} max={stats?.current?.memLimit} label="Memory over time" />
          <div className="hint">Limit is the heap plus JVM overhead</div>
        </section>

        <section className="card">
          <div className="card-head">
            <h3>Disk</h3>
            <span className="mono small">{disk === undefined ? 'not measured' : bytes(disk)}</span>
          </div>
          <div className="hint">
            Measured inside the data volume, which needs a short-lived helper container.
          </div>
          <div style={{ marginTop: 8 }}>
            <button className="sm" onClick={() => load(true)}>Measure now</button>
          </div>
        </section>

        <section className="card">
          <div className="card-head"><h3>Container</h3></div>
          <dl className="kv">
            <dt>Name</dt><dd className="mono small">{server.container}</dd>
            <dt>Type</dt><dd>{server.type} {server.version}</dd>
            <dt>Memory</dt><dd className="mono">{server.memory}</dd>
            <dt>Idle stop</dt>
            <dd>{server.idleTimeoutMinutes ? `${server.idleTimeoutMinutes} min` : 'never'}</dd>
            <dt>Created</dt><dd className="muted">{when(server.createdAt)}</dd>
          </dl>
        </section>
      </div>

      <section className="card" style={{ padding: 0 }}>
        <div className="card-head" style={{ padding: '13px 13px 0' }}><h3>Recent activity</h3></div>
        <table>
          <tbody>
            {activity.map((e) => (
              <tr key={e.id}>
                <td style={{ width: 110 }} className="muted small" title={new Date(e.at).toLocaleString()}>
                  {when(e.at)}
                </td>
                <td style={{ width: 150 }} className="mono small">{e.action}</td>
                <td className="small muted">{e.actor || 'system'} {e.detail || ''}</td>
              </tr>
            ))}
            {activity.length === 0 && (
              <tr><td className="muted small">Nothing recorded yet.</td></tr>
            )}
          </tbody>
        </table>
      </section>
    </div>
  );
}
