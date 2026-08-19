import React, { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import { bytes, Chart, ChartModal, stepMax, useToast, when } from '../ui.jsx';

const pct = (v) => `${Math.round(v)}%`;
const GB = 1024 ** 3;

/** The server's landing page: where to connect, how it is doing, what changed. */
export default function Overview({ server, state, me }) {
  const [stats, setStats] = useState(null);
  const [disk, setDisk] = useState(undefined);
  const [activity, setActivity] = useState([]);
  const [expanded, setExpanded] = useState(null); // 'cpu' | 'memory' | null
  const toast = useToast();

  const load = useCallback(
    (withDisk = false) => {
      api.stats(server.id, { disk: withDisk, minutes: 10 }).then((d) => {
        setStats(d);
        if (d.disk !== undefined) setDisk(d.disk);
      }).catch(() => {});
      api.serverAudit(server.id).then((d) => setActivity(d.entries.slice(0, 8))).catch(() => {});
    },
    [server.id]
  );

  useEffect(() => {
    load();
    const t = setInterval(() => load(), 10000);
    return () => clearInterval(t);
  }, [load]);

  const copy = (text) => { navigator.clipboard?.writeText(text); toast('Copied'); };
  const history = stats?.history || [];
  const cpuPoints = history.map((s) => ({ at: s.at, value: s.cpuPercent }));
  const memPoints = history.map((s) => ({ at: s.at, value: s.memUsed }));
  const memLimit = stats?.current?.memLimit ?? history[history.length - 1]?.memLimit ?? null;
  const cpuMax = stepMax(cpuPoints, 100);
  const memMax = stepMax(memPoints, GB);

  const loadCpuPoints = useCallback(
    (minutes) => api.stats(server.id, { minutes }).then((d) => (d.history || []).map((s) => ({ at: s.at, value: s.cpuPercent }))),
    [server.id]
  );
  const loadMemPoints = useCallback(
    (minutes) => api.stats(server.id, { minutes }).then((d) => (d.history || []).map((s) => ({ at: s.at, value: s.memUsed }))),
    [server.id]
  );

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
            {server.directAddress && (
              <tr>
                <td className="muted">Same network</td>
                <td>
                  {server.lanAddress ? (
                    <button className="link mono" onClick={() => copy(server.lanAddress)}>{server.lanAddress}</button>
                  ) : (
                    <span className="muted">not detected yet</span>
                  )}
                </td>
              </tr>
            )}
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
            <span className={`mono small${state.running ? '' : ' err-text'}`}>
              {state.running ? (stats?.current ? pct(stats.current.cpuPercent) : 'starting') : 'off'}
            </span>
          </div>
          {cpuPoints.length === 0 ? (
            <div className="muted small">No samples yet.</div>
          ) : (
            <button className="chart-trigger" onClick={() => setExpanded('cpu')} aria-label="Expand CPU history">
              <Chart points={cpuPoints} max={cpuMax} windowMs={10 * 60000} compact />
            </button>
          )}
          <div className="hint">Last 10 minutes. Click to see more.</div>
        </section>

        <section className="card">
          <div className="card-head">
            <h3>Memory</h3>
            <span className={`mono small${state.running ? '' : ' err-text'}`}>
              {state.running
                ? (stats?.current ? `${bytes(stats.current.memUsed)} / ${bytes(stats.current.memLimit)}` : 'starting')
                : 'off'}
            </span>
          </div>
          {memPoints.length === 0 || !memLimit ? (
            <div className="muted small">No samples yet.</div>
          ) : (
            <button className="chart-trigger" onClick={() => setExpanded('memory')} aria-label="Expand memory history">
              <Chart points={memPoints} max={memMax} windowMs={10 * 60000} compact />
            </button>
          )}
          <div className="hint">Last 10 minutes. Current usage against the heap limit is shown above.</div>
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
        <div className="rowlist activity">
          {activity.map((e) => (
            <div className="rowlist-row" key={e.id}>
              <div className="rowlist-cell muted small" title={new Date(e.at).toLocaleString()}>{when(e.at)}</div>
              <div className="rowlist-cell mono small">{e.action}</div>
              <div className="rowlist-cell small muted">{e.actor || 'system'} {e.detail || ''}</div>
            </div>
          ))}
          {activity.length === 0 && (
            <div className="rowlist-row">
              <div className="rowlist-cell muted small" style={{ gridColumn: '1 / -1' }}>Nothing recorded yet.</div>
            </div>
          )}
        </div>
      </section>

      {expanded === 'cpu' && (
        <ChartModal
          title="CPU"
          current={stats?.current ? pct(stats.current.cpuPercent) : 'idle'}
          maxFor={(pts) => stepMax(pts, 100)}
          load={loadCpuPoints}
          formatValue={pct}
          onClose={() => setExpanded(null)}
        />
      )}
      {expanded === 'memory' && memLimit && (
        <ChartModal
          title="Memory"
          current={stats?.current ? `${bytes(stats.current.memUsed)} / ${bytes(stats.current.memLimit)}` : 'idle'}
          maxFor={(pts) => stepMax(pts, GB)}
          load={loadMemPoints}
          formatValue={bytes}
          onClose={() => setExpanded(null)}
        />
      )}
    </div>
  );
}
