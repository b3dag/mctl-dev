import React, { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { useEvents } from '../useEvents.js';
import { StatusPill, useAsync, useToast, when } from '../ui.jsx';

export default function Dashboard() {
  const [servers, setServers] = useState(null);
  const [error, setError] = useState(null);
  const toast = useToast();
  const { run } = useAsync();

  const load = useCallback(() => {
    api
      .listServers()
      .then((d) => setServers(d.servers))
      .catch((e) => setError(e.message));
  }, []);

  useEffect(load, [load]);
  const { states, connected } = useEvents(load);

  const act = (id, fn, msg) => run(async () => {
    await fn(id);
    load();
  }, msg);

  if (error) return <div className="card badge-error">{error}</div>;
  if (!servers) return <div className="empty">Loading…</div>;

  return (
    <div className="stack">
      <div className="row between wrap">
        <div className="row">
          <h2 style={{ margin: 0, fontSize: 20 }}>Servers</h2>
          {!connected && <span className="pill">reconnecting…</span>}
        </div>
        <Link to="/new"><button className="primary">New server</button></Link>
      </div>

      {servers.length === 0 && (
        <div className="card empty">
          No servers yet. <Link to="/new">Create your first one</Link> — it gets its own hostname
          and is reachable through mc-router immediately.
        </div>
      )}

      <div className="grid">
        {servers.map((s) => {
          const state = states[s.id] || s.state || {};
          const running = state.running;
          return (
            <div className="card stack" key={s.id}>
              <div className="row between">
                <Link to={`/servers/${s.id}`} style={{ fontWeight: 600, fontSize: 16, color: 'inherit' }}>
                  {s.name}
                </Link>
                <StatusPill state={state} />
              </div>

              <div className="small muted mono" style={{ wordBreak: 'break-all' }}>{s.hostname}</div>

              <div className="row wrap small muted" style={{ gap: 12 }}>
                <span>{s.type} {s.version}</span>
                <span>{s.memory}</span>
                {s.autostartOnJoin && <span title="Starts when a player connects">wake-on-join</span>}
                {s.idleTimeoutMinutes > 0 && <span>idle stop {s.idleTimeoutMinutes}m</span>}
              </div>

              {state.phase === 'ready' && state.players?.length > 0 && (
                <div className="small">👤 {state.players.join(', ')}</div>
              )}
              {state.lastSeen && state.phase !== 'ready' && (
                <div className="small muted">last active {when(state.lastSeen)}</div>
              )}

              <div className="row wrap" style={{ gap: 8 }}>
                {running ? (
                  <>
                    <button className="sm" onClick={() => act(s.id, api.stop, `${s.name} stopping`)}>Stop</button>
                    <button className="sm" onClick={() => act(s.id, api.restart, `${s.name} restarting`)}>Restart</button>
                  </>
                ) : (
                  <button className="sm primary" onClick={() => act(s.id, api.start, `${s.name} starting`)}>Start</button>
                )}
                <Link to={`/servers/${s.id}/console`}><button className="sm">Console</button></Link>
                <div className="grow" />
                <button
                  className="sm ghost"
                  title="Copy the join address"
                  onClick={() => {
                    navigator.clipboard?.writeText(s.hostname);
                    toast('Address copied');
                  }}
                >
                  copy
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
