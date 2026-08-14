import React, { useEffect, useState } from 'react';
import { Link, Route, Routes } from 'react-router-dom';
import { api } from './api.js';
import { ToastProvider } from './ui.jsx';
import Dashboard from './pages/Dashboard.jsx';
import CreateServer from './pages/CreateServer.jsx';
import ServerDetail from './pages/ServerDetail.jsx';
import RouterStatus from './pages/RouterStatus.jsx';

export default function App() {
  const [me, setMe] = useState(null);
  const [authError, setAuthError] = useState(null);

  useEffect(() => {
    api.me().then(setMe).catch((e) => setAuthError(e.message));
  }, []);

  return (
    <ToastProvider>
      <div className="app">
        <header className="topbar">
          <Link to="/" className="brand" style={{ color: 'inherit' }}>
            mc<span>tl</span>
          </Link>
          <div className="spacer" />
          <Link to="/router" className="small muted">router</Link>
          <span className="who">{me?.email}</span>
        </header>

        <main className="content">
          {authError ? (
            <div className="card">
              <strong className="badge-error">Not authenticated</strong>
              <p className="small muted">{authError}</p>
              <p className="small muted">
                This app expects Cloudflare Access in front of it. For local development, start the
                manager with <code>REQUIRE_CF_ACCESS=false</code> and <code>DEV_USER=you@example.com</code>.
              </p>
            </div>
          ) : (
            <Routes>
              <Route path="/" element={<Dashboard />} />
              <Route path="/new" element={<CreateServer />} />
              <Route path="/router" element={<RouterStatus />} />
              <Route path="/servers/:id/*" element={<ServerDetail />} />
              <Route path="*" element={<div className="empty">Nothing here. <Link to="/">Back to dashboard</Link></div>} />
            </Routes>
          )}
        </main>
      </div>
    </ToastProvider>
  );
}
