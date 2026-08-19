import React, { useCallback, useEffect, useState } from 'react';
import { NavLink, Navigate, Route, Routes, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api.js';
import { Confirm, StatusDot, PHASE_LABEL, useAsync } from '../ui.jsx';

import Overview from './Overview.jsx';
import Console from './Console.jsx';
import Players from './Players.jsx';
import Files from './Files.jsx';
import Content from './Content.jsx';
import Backups from './Backups.jsx';
import Settings from './Settings.jsx';

const TABS = [
  ['overview', 'Overview'],
  ['console', 'Console'],
  ['players', 'Players'],
  ['files', 'Files'],
  ['content', 'Content'],
  ['backups', 'Backups'],
  ['settings', 'Settings'],
];

/**
 * Everything inside one server. The header states which server you are in and
 * carries the lifecycle actions; the tabs below it are all scoped to it.
 */
export default function ServerLayout({ states = {}, onChange }) {
  const { id } = useParams();
  const nav = useNavigate();
  const [server, setServer] = useState(null);
  const [me, setMe] = useState(null);
  const [error, setError] = useState(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [keepData, setKeepData] = useState(false);
  const { busy, run } = useAsync();

  const load = useCallback(() => {
    api.getServer(id).then((d) => setServer(d.server)).catch((e) => setError(e.message));
  }, [id]);

  useEffect(() => {
    setServer(null);
    setError(null);
    load();
    api.me().then(setMe).catch(() => {});
  }, [load]);

  if (error) return <div className="card err-text">{error}</div>;
  if (!server) return <div className="empty">Loading</div>;

  const state = states[id] || server.state || {};
  const act = (fn, msg) => run(async () => { await fn(id); load(); onChange?.(); }, msg);

  return (
    <div className="stack">
      <div className="page-head">
        <div style={{ minWidth: 0 }}>
          <h2>{server.name}</h2>
          <div className="row wrap small muted" style={{ gap: 10, marginTop: 2 }}>
            <span className="row" style={{ gap: 6 }}>
              <StatusDot state={state} />
              {PHASE_LABEL[state.phase] || 'Unknown'}
            </span>
            {state.phase === 'ready' && (
              <span>{state.online ?? 0}{state.max ? `/${state.max}` : ''} online</span>
            )}
            <span>{server.type} {server.version}</span>
            {!server.autostartOnJoin && <span className="pill">wake off</span>}
          </div>
        </div>

        <div className="actions">
          {state.running ? (
            <>
              <button className="sm" disabled={busy} onClick={() => act(api.stop, 'Stopping')}>Stop</button>
              <button
                className="sm"
                disabled={busy}
                title="Stop it and stop waking it when players connect"
                onClick={() => act(api.stopAndKeepOff, 'Stopping and staying off')}
              >
                Stop and keep off
              </button>
              <button className="sm" disabled={busy} onClick={() => act(api.restart, 'Restarting')}>Restart</button>
            </>
          ) : (
            <button className="sm primary" disabled={busy} onClick={() => act(api.start, 'Starting')}>Start</button>
          )}
        </div>
      </div>

      <nav className="tabs">
        {TABS.map(([slug, label]) => (
          <NavLink key={slug} to={slug} className={({ isActive }) => (isActive ? 'active' : '')}>
            {label}
          </NavLink>
        ))}
      </nav>

      <Routes>
        <Route index element={<Navigate to="overview" replace />} />
        <Route path="overview" element={<Overview server={server} state={state} me={me} />} />
        <Route path="console" element={<Console server={server} state={state} />} />
        <Route path="players" element={<Players server={server} state={state} />} />
        <Route path="files" element={<Files server={server} />} />
        <Route path="content" element={<Content server={server} />} />
        <Route path="backups" element={<Backups server={server} />} />
        <Route
          path="settings"
          element={
            <Settings
              server={server}
              me={me}
              onSaved={() => { load(); onChange?.(); }}
              onDelete={() => setConfirmDelete(true)}
            />
          }
        />
      </Routes>

      {confirmDelete && (
        <Confirm
          title={`Delete ${server.name}?`}
          message={
            keepData
              ? 'This removes the container and its route but leaves the data volume in place, so the world can be recovered.'
              : 'This removes the container, its route, and its data volume: world, configs and mods. Backups already taken are kept.'
          }
          confirmWord={server.slug}
          onClose={() => setConfirmDelete(false)}
          extra={
            <div className="checkbox" style={{ marginTop: 10 }}>
              <input id="keepdata" type="checkbox" checked={keepData} onChange={(e) => setKeepData(e.target.checked)} />
              <label htmlFor="keepdata">Keep the data volume</label>
            </div>
          }
          onConfirm={() =>
            run(async () => {
              await api.deleteServer(id, server.slug, keepData);
              onChange?.();
              nav('/');
            }, 'Server deleted')
          }
        />
      )}
    </div>
  );
}
