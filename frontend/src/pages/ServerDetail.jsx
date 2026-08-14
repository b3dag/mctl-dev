import React, { useCallback, useEffect, useState } from 'react';
import { Link, NavLink, Navigate, Route, Routes, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api.js';
import { useEvents } from '../useEvents.js';
import { Confirm, StatusPill, useAsync } from '../ui.jsx';
import Console from '../tabs/Console.jsx';
import Players from '../tabs/Players.jsx';
import Files from '../tabs/Files.jsx';
import Mods from '../tabs/Mods.jsx';
import Backups from '../tabs/Backups.jsx';
import Settings from '../tabs/Settings.jsx';
import Stats from '../tabs/Stats.jsx';

const TABS = [
  ['console', 'Console'],
  ['players', 'Players'],
  ['files', 'Files'],
  ['mods', 'Mods'],
  ['backups', 'Backups'],
  ['stats', 'Stats'],
  ['settings', 'Settings'],
];

export default function ServerDetail() {
  const { id } = useParams();
  const nav = useNavigate();
  const [server, setServer] = useState(null);
  const [error, setError] = useState(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const { run } = useAsync();

  const load = useCallback(() => {
    api
      .getServer(id)
      .then((d) => setServer(d.server))
      .catch((e) => setError(e.message));
  }, [id]);

  useEffect(load, [load]);
  const { states } = useEvents();
  const state = states[id] || server?.state || {};

  if (error) return <div className="card badge-error">{error}</div>;
  if (!server) return <div className="empty">Loading…</div>;

  const act = (fn, msg) => run(async () => {
    await fn(id);
    load();
  }, msg);

  return (
    <div className="stack">
      <div className="row between wrap">
        <div className="row grow" style={{ minWidth: 0 }}>
          <Link to="/" className="muted">←</Link>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 19, fontWeight: 600 }}>{server.name}</div>
            <div className="small muted mono" style={{ wordBreak: 'break-all' }}>{server.hostname}</div>
          </div>
        </div>
        <StatusPill state={state} />
      </div>

      <div className="row wrap" style={{ gap: 8 }}>
        {state.running ? (
          <>
            <button onClick={() => act(api.stop, 'Stopping…')}>Stop</button>
            <button onClick={() => act(api.restart, 'Restarting…')}>Restart</button>
          </>
        ) : (
          <button className="primary" onClick={() => act(api.start, 'Starting…')}>Start</button>
        )}
        <div className="grow" />
        <button className="danger" onClick={() => setConfirmDelete(true)}>Delete</button>
      </div>

      <nav className="tabs">
        {TABS.map(([slug, label]) => (
          <NavLink key={slug} to={slug} className={({ isActive }) => (isActive ? 'active' : '')}>
            {label}
          </NavLink>
        ))}
      </nav>

      <Routes>
        <Route index element={<Navigate to="console" replace />} />
        <Route path="console" element={<Console server={server} state={state} />} />
        <Route path="players" element={<Players server={server} state={state} />} />
        <Route path="files" element={<Files server={server} />} />
        <Route path="mods" element={<Mods server={server} />} />
        <Route path="backups" element={<Backups server={server} />} />
        <Route path="stats" element={<Stats server={server} state={state} />} />
        <Route path="settings" element={<Settings server={server} onSaved={load} />} />
      </Routes>

      {confirmDelete && (
        <Confirm
          title={`Delete ${server.name}?`}
          message="This removes the container, its data volume (world, configs, mods) and its mc-router mapping. Backups already taken are kept."
          confirmWord={server.slug}
          onClose={() => setConfirmDelete(false)}
          onConfirm={() =>
            run(async () => {
              await api.deleteServer(id, server.slug, false);
              nav('/');
            }, 'Server deleted')
          }
        />
      )}
    </div>
  );
}
