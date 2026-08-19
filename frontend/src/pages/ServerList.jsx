import React, { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api.js';
import { StatusDot, PHASE_LABEL, useAsync, useToast, when } from '../ui.jsx';

const BULK_ACTIONS = [
  ['start', 'Start selected', api.start],
  ['stop', 'Stop selected', api.stop],
  ['restart', 'Restart selected', api.restart],
  ['keepoff', 'Stop and keep off selected', api.stopAndKeepOff],
];

/** The home screen: every server, its address, and the actions you reach for. */
export default function ServerList({ servers, states, me, onChange }) {
  const { busy, run } = useAsync();
  const toast = useToast();
  const nav = useNavigate();
  const [selected, setSelected] = useState(() => new Set());

  const act = (id, fn, msg) => run(async () => { await fn(id); onChange?.(); }, msg);
  const copy = (text) => { navigator.clipboard?.writeText(text); toast('Copied'); };

  if (servers === null) return <div className="empty">Loading</div>;

  const running = servers.filter((s) => (states[s.id] || s.state || {}).running).length;
  const players = servers.reduce((n, s) => n + ((states[s.id] || {}).online || 0), 0);

  const ids = servers.map((s) => s.id);
  const allSelected = ids.length > 0 && ids.every((id) => selected.has(id));
  const toggleAll = () => setSelected(allSelected ? new Set() : new Set(ids));
  const toggleOne = (id) =>
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  const runBulk = (fn, label) =>
    run(async () => {
      const targets = [...selected];
      const results = await Promise.allSettled(targets.map((id) => fn(id)));
      const failed = results.filter((r) => r.status === 'rejected').length;
      onChange?.();
      setSelected(new Set());
      const ok = targets.length - failed;
      return failed
        ? `${label}: ${ok} of ${targets.length} succeeded`
        : `${label}: ${ok} server${ok === 1 ? '' : 's'}`;
    }).then((msg) => msg && toast(msg));

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h2>Servers</h2>
          <div className="muted small">
            {servers.length} total, {running} running, {players} player{players === 1 ? '' : 's'} online
          </div>
        </div>
        <button className="primary" onClick={() => nav('/new')}>New server</button>
      </div>

      {servers.length === 0 ? (
        <div className="card empty">
          No servers yet. <Link to="/new">Create one</Link>.
        </div>
      ) : (
        <div className="card" style={{ padding: 0 }}>
          <div className="rowlist servers">
            <div className="rowlist-head">
              <div>
                <input type="checkbox" checked={allSelected} onChange={toggleAll} aria-label="Select all servers" />
              </div>
              <div>Server</div>
              <div>Status</div>
              <div>Address</div>
              <div></div>
            </div>
            {servers.map((s) => {
              const state = states[s.id] || s.state || {};
              return (
                <div className="rowlist-row" key={s.id}>
                  <div className="rowlist-cell">
                    <input
                      type="checkbox"
                      checked={selected.has(s.id)}
                      onChange={() => toggleOne(s.id)}
                      aria-label={`Select ${s.name}`}
                    />
                  </div>
                  <div className="rowlist-cell">
                    <Link to={`/servers/${s.id}`} className="strong">{s.name}</Link>
                    <div className="muted small">
                      {s.type} {s.version}
                      {!s.autostartOnJoin && <span className="pill" style={{ marginLeft: 6 }}>wake off</span>}
                    </div>
                  </div>
                  <div className="rowlist-cell">
                    <span className="row" style={{ gap: 6 }}>
                      <StatusDot state={state} />
                      <span className="small">{PHASE_LABEL[state.phase] || 'Unknown'}</span>
                    </span>
                    {state.phase === 'ready' ? (
                      <div className="muted small">
                        {state.online ?? 0}{state.max ? `/${state.max}` : ''} online
                      </div>
                    ) : state.lastSeen ? (
                      <div className="muted small">{when(state.lastSeen)}</div>
                    ) : null}
                  </div>
                  <div className="rowlist-cell">
                    <button className="link mono" onClick={() => copy(s.routerAddress)}>{s.routerAddress}</button>
                    {s.directAddress && (
                      <div>
                        <button className="link mono muted" onClick={() => copy(s.directAddress)}>
                          {s.directAddress}
                        </button>
                      </div>
                    )}
                  </div>
                  <div className="rowlist-cell end">
                    {state.running ? (
                      <>
                        <button className="sm" disabled={busy} onClick={() => act(s.id, api.stop, `${s.name} stopping`)}>Stop</button>
                        <button className="sm" disabled={busy} onClick={() => act(s.id, api.restart, `${s.name} restarting`)}>Restart</button>
                      </>
                    ) : (
                      <button className="sm primary" disabled={busy} onClick={() => act(s.id, api.start, `${s.name} starting`)}>Start</button>
                    )}
                    <button className="sm" onClick={() => nav(`/servers/${s.id}`)}>Open</button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {selected.size > 0 && (
        <div className="save-bar">
          <span className="small">{selected.size} server{selected.size === 1 ? '' : 's'} selected</span>
          <div className="row wrap" style={{ gap: 6 }}>
            {BULK_ACTIONS.map(([key, label, fn]) => (
              <button key={key} className="sm" disabled={busy} onClick={() => runBulk(fn, label)}>{label}</button>
            ))}
            <button className="sm ghost" disabled={busy} onClick={() => setSelected(new Set())}>Clear</button>
          </div>
        </div>
      )}

      <div className="card">
        <dl className="kv">
          <dt>Base domain</dt>
          <dd className="mono">{me?.domain || 'not set'}</dd>
          <dt>Shared port</dt>
          <dd className="mono">{me?.publicMcPort ?? 25565}</dd>
        </dl>
      </div>
    </div>
  );
}
