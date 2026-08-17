import React, { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import { bytes } from '../ui.jsx';

function Spark({ points, max, color, label }) {
  if (!points.length) return <div className="small muted">No samples yet.</div>;
  const w = 300;
  const h = 70;
  const top = max || Math.max(...points, 1);
  const step = points.length > 1 ? w / (points.length - 1) : w;
  const path = points.map((v, i) => `${i === 0 ? 'M' : 'L'}${(i * step).toFixed(1)},${(h - (v / top) * h).toFixed(1)}`).join(' ');
  const area = `${path} L${w},${h} L0,${h} Z`;
  return (
    <svg className="spark" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" role="img" aria-label={label}>
      <path d={area} fill={color} opacity="0.15" />
      <path d={path} fill="none" stroke={color} strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

export default function Stats({ server, state }) {
  const [data, setData] = useState(null);
  const [disk, setDisk] = useState(undefined);
  const [error, setError] = useState(null);

  const load = useCallback(
    (withDisk = false) => {
      api
        .stats(server.id, withDisk)
        .then((d) => {
          setData(d);
          if (d.disk !== undefined) setDisk(d.disk);
        })
        .catch((e) => setError(e.message));
    },
    [server.id]
  );

  useEffect(() => {
    load();
    const t = setInterval(() => load(), 10000);
    return () => clearInterval(t);
  }, [load]);

  if (error) return <div className="card err-text">{error}</div>;
  if (!data) return <div className="empty">Loading…</div>;

  const history = data.history || [];
  const cpu = history.map((s) => s.cpuPercent);
  const mem = history.map((s) => s.memUsed);
  const memLimit = data.current?.memLimit || Math.max(...mem, 1);

  return (
    <div className="stack">
      <div className="grid">
        <div className="card stack">
          <div className="row between">
            <strong>CPU</strong>
            <span className="mono">{data.current ? `${data.current.cpuPercent.toFixed(1)}%` : '-'}</span>
          </div>
          <Spark points={cpu} color="#4ea1ff" label="CPU usage over time" />
          <div className="small muted">{history.length} samples, one per minute</div>
        </div>

        <div className="card stack">
          <div className="row between">
            <strong>Memory</strong>
            <span className="mono">
              {data.current ? `${bytes(data.current.memUsed)} / ${bytes(data.current.memLimit)}` : '-'}
            </span>
          </div>
          <Spark points={mem} max={memLimit} color="#3fb950" label="Memory usage over time" />
          <div className="small muted">Container limit is the JVM heap plus overhead</div>
        </div>

        <div className="card stack">
          <div className="row between">
            <strong>Disk</strong>
            <span className="mono">{disk === undefined ? '-' : bytes(disk)}</span>
          </div>
          <div className="small muted">
            Measured inside the data volume; needs a short-lived helper container, so it is on demand.
          </div>
          <button className="sm" onClick={() => load(true)}>Measure now</button>
        </div>

        <div className="card stack">
          <strong>Container</strong>
          <table>
            <tbody>
              <tr><td className="muted">Name</td><td className="mono small">{server.container}</td></tr>
              <tr><td className="muted">Phase</td><td>{state.phase || '-'}</td></tr>
              <tr><td className="muted">Players</td><td>{state.online ?? '-'}</td></tr>
              <tr><td className="muted">Network in</td><td>{bytes(data.current?.netRx)}</td></tr>
              <tr><td className="muted">Network out</td><td>{bytes(data.current?.netTx)}</td></tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
