import React, { useCallback, useEffect, useState } from 'react';
import { NavLink, Navigate, Route, Routes, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api.js';
import { Confirm, StatusDot, PHASE_LABEL, useAsync, useToast } from '../ui.jsx';
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

export default function ServerDetail({ states = {}, onChange }) {
  const { id } = useParams();
  const nav = useNavigate();
  const toast = useToast();
  const [server, setServer] = useState(null);
  const [me, setMe] = useState(null);
  const [error, setError] = useState(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const { busy, run } = useAsync();

  const load = useCallback(() => {
    api.getServer(id).then((d) => setServer(d.server)).catch((e) => setError(e.message));
  }, [id]);

  useEffect(() => {
    load();
    api.me().then(setMe).catch(() => {});
  }, [load]);

  if (error) return <div className="card err-text">{error}</div>;
  if (!server) return <div className="empty">Loading…</div>;

  const state = states[id] || server.state || {};
  const act = (fn, msg) => run(async () => { await fn(id); load(); onChange?.(); }, msg);
  const address = server.hostPort ? `${me?.publicHost || ''}:${server.hostPort}` : server.hostname;

  return (
    <div className="stack">
      <div className="row between wrap">
        <div style={{ minWidth: 0 }}>
          <h2>{server.name}</h2>
          <div className="row small muted" style={{ gap: 6, marginTop: 2 }}>
            <StatusDot state={state} />
            <span>{PHASE_LABEL[state.phase] || '—'}</span>
            {state.phase === 'ready' && <span>· {state.online ?? 0}{state.max ? `/${state.max}` : ''} online</span>}
            <span>· {server.type} {server.version}</span>
          </div>
        </div>
        <div className="row wrap" style={{ gap: 6 }}>
          {state.running ? (
            <>
              <button className="sm" disabled={busy} onClick={() => act(api.stop, 'Stopping…')}>Stop</button>
              <button className="sm" disabled={busy} onClick={() => act(api.restart, 'Restarting…')}>Restart</button>
            </>
          ) : (
            <button className="sm primary" disabled={busy} onClick={() => act(api.start, 'Starting…')}>Start</button>
          )}
          <button className="sm danger" onClick={() => setConfirmDelete(true)}>Delete</button>
        </div>
      </div>

      <div className="card row between wrap" style={{ gap: 8 }}>
        <div style={{ minWidth: 0 }}>
          <div className="muted small">Players connect to</div>
          <div className="mono" style={{ wordBreak: 'break-all' }}>{address}</div>
        </div>
        <button
          className="sm"
          onClick={() => { navigator.clipboard?.writeText(address); toast('Address copied'); }}
        >
          Copy
        </button>
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
        <Route
          path="settings"
          element={<Settings server={server} me={me} onSaved={() => { load(); onChange?.(); }} />}
        />
      </Routes>

      {confirmDelete && (
        <Confirm
          title={`Delete ${server.name}?`}
          message="This removes the container, its data volume (world, configs, mods) and its route. Backups already taken are kept."
          confirmWord={server.slug}
          onClose={() => setConfirmDelete(false)}
          onConfirm={() =>
            run(async () => {
              await api.deleteServer(id, server.slug, false);
              onChange?.();
              nav('/');
            }, 'Server deleted')
          }
        />
      )}
    </div>
  );
}
