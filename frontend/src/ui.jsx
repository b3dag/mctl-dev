import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';

const ToastCtx = createContext(() => {});
export const useToast = () => useContext(ToastCtx);

export function ToastProvider({ children }) {
  const [toast, setToast] = useState(null);
  const push = useCallback((message, kind = 'info') => {
    setToast({ message: String(message), kind, key: Date.now() });
  }, []);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), toast.kind === 'error' ? 6000 : 3000);
    return () => clearTimeout(t);
  }, [toast]);

  return (
    <ToastCtx.Provider value={push}>
      {children}
      {toast && <div className={`toast ${toast.kind}`}>{toast.message}</div>}
    </ToastCtx.Provider>
  );
}

/** Wrap an async handler so failures surface as a toast instead of a dead click. */
export function useAsync() {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const run = useCallback(
    async (fn, successMessage) => {
      setBusy(true);
      try {
        const out = await fn();
        if (successMessage) toast(successMessage);
        return out;
      } catch (e) {
        toast(e.message, 'error');
        return null;
      } finally {
        setBusy(false);
      }
    },
    [toast]
  );
  return { busy, run };
}

export function Modal({ title, children, onClose, actions }) {
  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <div className="row between" style={{ marginBottom: 12 }}>
          <strong>{title}</strong>
          <button className="ghost sm" onClick={onClose}>✕</button>
        </div>
        {children}
        {actions && <div className="row wrap" style={{ marginTop: 16, justifyContent: 'flex-end' }}>{actions}</div>}
      </div>
    </div>
  );
}

export function StatusDot({ state }) {
  const phase = state?.phase || 'stopped';
  return <span className={`dot ${phase}`} title={phase} />;
}

export const PHASE_LABEL = {
  ready: 'Running',
  starting: 'Starting',
  stopping: 'Stopping',
  stopped: 'Stopped',
  crashed: 'Crashed',
  unhealthy: 'No RCON',
  missing: 'No container',
  unknown: '-',
};

export function StatusPill({ state }) {
  const phase = state?.phase || 'stopped';
  return (
    <span className="pill">
      <StatusDot state={state} />
      {PHASE_LABEL[phase] || phase}
      {phase === 'ready' && state?.online !== undefined && (
        <span className="muted"> {state.online}{state.max ? `/${state.max}` : ''}</span>
      )}
    </span>
  );
}

export function bytes(n) {
  if (n === null || n === undefined) return '-';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = Number(n);
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v < 10 && i > 0 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

export function when(iso) {
  if (!iso) return '-';
  const d = new Date(iso);
  const diff = (Date.now() - d.getTime()) / 1000;
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return d.toLocaleDateString();
}

/**
 * A chart's top edge, rounded up to the next `step` above the highest sample
 * in view rather than fixed, so CPU (which can run past 100% on a multi-core
 * container) always has headroom to show a spike instead of clipping it, and
 * a quiet stretch scales back down instead of leaving most of the chart
 * empty at some earlier peak's expense.
 */
export function stepMax(points, step) {
  const highest = points.reduce((m, p) => Math.max(m, p.value), 0);
  return Math.max(step, Math.ceil(highest / step) * step);
}

/**
 * A resource graph over a fixed time window, always scaled to [min, max]
 * rather than to whatever the samples happen to reach, so a quiet server does
 * not look like it is pegged. `windowMs` is the span the x-axis represents;
 * points are placed by their real timestamp against `Date.now()`, so the
 * whole thing visibly slides left as time passes rather than just filling in
 * and stopping. Compact mode is the bare line for a card; the labeled mode
 * (used once a chart is expanded) adds axis numbers and grid lines.
 *
 * Samples only exist while the server is running, so any stretch of the
 * window with no samples means it was off, not merely idle: `gapMs` (well
 * above the ~10s sampling interval) is how big a hole has to be before it
 * counts as one. Those stretches get a red band instead of a line bridging
 * across them, since drawing a line there would claim data that was never
 * actually sampled.
 */
export function Chart({ points, max, min = 0, windowMs, formatValue = (v) => v, windowLabel, compact = false, gapMs = 30000 }) {
  const width = 600;
  const height = compact ? 56 : 140;
  const now = Date.now();
  const start = now - windowMs;
  const span = max - min || 1;
  const x = (at) => ((at - start) / windowMs) * width;
  const y = (v) => height - ((v - min) / span) * height;

  const visible = points.filter((p) => p.at >= start);

  const segments = [];
  let current = [];
  for (const p of visible) {
    if (current.length && p.at - current[current.length - 1].at > gapMs) {
      segments.push(current);
      current = [];
    }
    current.push(p);
  }
  if (current.length) segments.push(current);

  // Off bands: before the first sample, between segments, and after the last
  // one if it is too stale to still be running.
  const offBands = [];
  const first = segments[0]?.[0];
  if (first && first.at - start > gapMs) offBands.push([start, first.at]);
  for (let i = 1; i < segments.length; i++) {
    offBands.push([segments[i - 1][segments[i - 1].length - 1].at, segments[i][0].at]);
  }
  const last = visible[visible.length - 1];
  if (last && now - last.at > gapMs) offBands.push([last.at, now]);
  if (!last) offBands.push([start, now]);

  const pathFor = (seg) =>
    seg.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(p.at).toFixed(1)},${y(p.value).toFixed(1)}`).join(' ');
  const fillFor = (seg) =>
    `${pathFor(seg)} L${x(seg[seg.length - 1].at).toFixed(1)},${height} L${x(seg[0].at).toFixed(1)},${height} Z`;

  const svg = (
    <svg className="spark" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" role="img">
      {!compact && [0, 0.25, 0.5, 0.75, 1].map((f) => (
        <line key={f} x1={0} x2={width} y1={height * f} y2={height * f} className="chart-grid" />
      ))}
      {offBands.map(([a, b], i) => (
        <rect key={i} x={x(a).toFixed(1)} y={0} width={Math.max(0, x(b) - x(a)).toFixed(1)} height={height} className="chart-off" />
      ))}
      {segments.map((seg, i) => seg.length > 1 && <path key={`f${i}`} d={fillFor(seg)} className="spark-fill" />)}
      {segments.map((seg, i) => <path key={`l${i}`} d={pathFor(seg)} className="spark-line" vectorEffect="non-scaling-stroke" />)}
    </svg>
  );

  if (compact) return svg;

  return (
    <div className="chart-full">
      <div className="chart-yaxis">
        <span>{formatValue(max)}</span>
        <span>{formatValue(min + span / 2)}</span>
        <span>{formatValue(min)}</span>
      </div>
      <div className="chart-body">{svg}</div>
      <div className="chart-xaxis">
        <span>{windowLabel}</span>
        <span>now</span>
      </div>
    </div>
  );
}

const RANGES = [
  { minutes: 10, label: '10m' },
  { minutes: 60, label: '1h' },
  { minutes: 360, label: '6h' },
  { minutes: 1440, label: '24h' },
];

/**
 * The modal a compact Chart opens into: bigger, labeled, with a time range to
 * pick. `maxFor(points)` recomputes the chart's top edge each time the points
 * change, since switching to a longer range can surface a higher peak than
 * the compact view ever saw.
 */
export function ChartModal({ title, current, maxFor, load, formatValue, onClose }) {
  const [minutes, setMinutes] = useState(10);
  const [points, setPoints] = useState([]);

  useEffect(() => {
    let alive = true;
    const poll = () => load(minutes).then((pts) => alive && setPoints(pts));
    poll();
    const t = setInterval(poll, 10000);
    return () => { alive = false; clearInterval(t); };
  }, [minutes, load]);

  const range = RANGES.find((r) => r.minutes === minutes);

  return (
    <Modal title={title} onClose={onClose}>
      <div className="row wrap between" style={{ marginBottom: 12 }}>
        <span className="mono small">{current}</span>
        <span className="row" style={{ gap: 4 }}>
          {RANGES.map((r) => (
            <button
              key={r.minutes}
              className="sm"
              disabled={r.minutes === minutes}
              onClick={() => setMinutes(r.minutes)}
            >
              {r.label}
            </button>
          ))}
        </span>
      </div>
      {points.length === 0 ? (
        <div className="muted small">No samples in this window yet.</div>
      ) : (
        <Chart
          points={points}
          max={maxFor(points)}
          windowMs={minutes * 60000}
          formatValue={formatValue}
          windowLabel={`-${range.label}`}
        />
      )}
    </Modal>
  );
}

export function Confirm({ title, message, confirmWord, onConfirm, onClose, extra, danger = true }) {
  const [typed, setTyped] = useState('');
  const ok = !confirmWord || typed === confirmWord;
  return (
    <Modal
      title={title}
      onClose={onClose}
      actions={
        <>
          <button onClick={onClose}>Cancel</button>
          <button className={danger ? 'danger' : 'primary'} disabled={!ok} onClick={() => onConfirm()}>
            Confirm
          </button>
        </>
      }
    >
      <p className="small">{message}</p>
      {extra}
      {confirmWord && (
        <div className="field">
          <label>Type <code>{confirmWord}</code> to confirm</label>
          <input value={typed} onChange={(e) => setTyped(e.target.value)} autoFocus />
        </div>
      )}
    </Modal>
  );
}
