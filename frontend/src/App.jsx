import React, { useCallback, useEffect, useState } from 'react';
import { Link, Route, Routes, useLocation } from 'react-router-dom';
import { api } from './api.js';
import { ToastProvider } from './ui.jsx';
import { useEvents } from './useEvents.js';
import Sidebar from './Sidebar.jsx';
import Overview from './pages/Overview.jsx';
import Ports from './pages/Ports.jsx';
import CreateServer from './pages/CreateServer.jsx';
import ServerDetail from './pages/ServerDetail.jsx';
import RouterStatus from './pages/RouterStatus.jsx';
import GeneralSettings from './pages/GeneralSettings.jsx';

export default function App() {
  const [me, setMe] = useState(null);
  const [authError, setAuthError] = useState(null);
  const [servers, setServers] = useState(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const location = useLocation();

  const loadServers = useCallback(() => {
    api.listServers().then((d) => setServers(d.servers)).catch(() => {});
  }, []);

  useEffect(() => {
    api.me().then(setMe).catch((e) => setAuthError(e.message));
    loadServers();
  }, [loadServers]);

  const { states } = useEvents(loadServers);

  // Close the mobile drawer whenever the route changes.
  useEffect(() => setMenuOpen(false), [location.pathname]);

  if (authError) {
    return (
      <ToastProvider>
        <div className="main-inner">
          <div className="card">
            <strong className="err-text">Not authenticated</strong>
            <p className="small muted">{authError}</p>
            <p className="small muted">
              This app expects Cloudflare Access in front of it. For local use, start the manager
              with <code>REQUIRE_CF_ACCESS=false</code> and <code>DEV_USER=you@example.com</code>.
            </p>
          </div>
        </div>
      </ToastProvider>
    );
  }

  return (
    <ToastProvider>
      <div className="shell">
        <Sidebar
          servers={servers}
          states={states}
          open={menuOpen}
          onNavigate={() => setMenuOpen(false)}
        />
        {menuOpen && <div className="scrim" onClick={() => setMenuOpen(false)} />}

        <div className="main">
          <header className="topbar">
            <button className="ghost sm" onClick={() => setMenuOpen((v) => !v)} aria-label="Menu">☰</button>
            <Link to="/" className="brand">mctl</Link>
          </header>

          <div className="main-inner">
            <Routes>
              <Route path="/" element={<Overview servers={servers} states={states} me={me} onChange={loadServers} />} />
              <Route path="/ports" element={<Ports />} />
              <Route path="/router" element={<RouterStatus />} />
              <Route path="/settings" element={<GeneralSettings onChange={() => { loadServers(); api.me().then(setMe).catch(() => {}); }} />} />
              <Route path="/new" element={<CreateServer onCreated={loadServers} />} />
              <Route path="/servers/:id/*" element={<ServerDetail states={states} onChange={loadServers} />} />
              <Route path="*" element={<div className="empty">Nothing here. <Link to="/">Overview</Link></div>} />
            </Routes>
          </div>
        </div>
      </div>
    </ToastProvider>
  );
}
