import React, { useCallback, useEffect, useState } from 'react';
import { Link, Route, Routes, useLocation } from 'react-router-dom';
import { api } from './api.js';
import { ToastProvider } from './ui.jsx';
import { useEvents } from './useEvents.js';
import Sidebar from './Sidebar.jsx';

import ServerList from './pages/ServerList.jsx';
import NewServer from './pages/NewServer.jsx';
import Network from './pages/Network.jsx';
import BackupsOverview from './pages/BackupsOverview.jsx';
import Activity from './pages/Activity.jsx';
import SystemSettings from './pages/SystemSettings.jsx';
import ServerLayout from './server/ServerLayout.jsx';

export default function App() {
  const [me, setMe] = useState(null);
  const [authError, setAuthError] = useState(null);
  const [servers, setServers] = useState(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const location = useLocation();

  const loadServers = useCallback(() => {
    api.listServers().then((d) => setServers(d.servers)).catch(() => {});
  }, []);

  const loadMe = useCallback(() => {
    api.me().then(setMe).catch((e) => setAuthError(e.message));
  }, []);

  useEffect(() => {
    loadMe();
    loadServers();
  }, [loadMe, loadServers]);

  const { states } = useEvents(loadServers);

  // Close the mobile drawer whenever the route changes.
  useEffect(() => setMenuOpen(false), [location.pathname]);

  const refresh = useCallback(() => {
    loadServers();
    loadMe();
  }, [loadServers, loadMe]);

  if (authError) {
    return (
      <ToastProvider>
        <div className="main-inner">
          <div className="card">
            <h3 className="err-text">Not authenticated</h3>
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
            <button className="ghost sm" onClick={() => setMenuOpen((v) => !v)} aria-label="Menu">MENU</button>
            <Link to="/" className="brand">mctl</Link>
          </header>

          <div className="main-inner">
            <Routes>
              <Route path="/" element={<ServerList servers={servers} states={states} me={me} onChange={loadServers} />} />
              <Route path="/new" element={<NewServer me={me} onCreated={loadServers} />} />
              <Route path="/network" element={<Network />} />
              <Route path="/backups" element={<BackupsOverview />} />
              <Route path="/activity" element={<Activity />} />
              <Route path="/settings" element={<SystemSettings onChange={refresh} />} />
              <Route path="/servers/:id/*" element={<ServerLayout states={states} onChange={loadServers} />} />
              <Route path="*" element={<div className="empty">Nothing here. <Link to="/">Servers</Link></div>} />
            </Routes>
          </div>
        </div>
      </div>
    </ToastProvider>
  );
}
