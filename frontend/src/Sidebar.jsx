import React from 'react';
import { NavLink, Link } from 'react-router-dom';
import { StatusDot } from './ui.jsx';

const SYSTEM = [
  ['/', 'Overview', true],
  ['/ports', 'Ports'],
  ['/router', 'Router'],
  ['/settings', 'Settings'],
];

export default function Sidebar({ servers, states, open, onNavigate }) {
  return (
    <nav className={`sidebar${open ? ' open' : ''}`} onClick={onNavigate}>
      <div className="sidebar-head">
        <Link to="/" className="brand">mctl</Link>
      </div>

      <div className="nav-group">
        <div className="nav-label">
          <span>Servers</span>
          <Link to="/new" title="New server" style={{ color: 'var(--muted)' }}>+</Link>
        </div>
        {servers === null && <div className="nav-empty">Loading…</div>}
        {servers?.length === 0 && <div className="nav-empty">None yet</div>}
        {servers?.map((s) => {
          const state = states[s.id] || s.state || {};
          return (
            <NavLink
              key={s.id}
              to={`/servers/${s.id}`}
              className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}
            >
              <StatusDot state={state} />
              <span className="nav-name">{s.name}</span>
              {state.phase === 'ready' && state.online > 0 && (
                <span className="nav-meta">{state.online}</span>
              )}
            </NavLink>
          );
        })}
      </div>

      <div className="nav-group">
        <div className="nav-label"><span>System</span></div>
        {SYSTEM.map(([to, label, end]) => (
          <NavLink key={to} to={to} end={end} className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}>
            <span className="nav-name">{label}</span>
          </NavLink>
        ))}
      </div>
    </nav>
  );
}
