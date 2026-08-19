import React, { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { useAsync, useToast } from '../ui.jsx';

/**
 * One page for "can players reach this and how": the domain and host address
 * that decide it, and the resulting per-server addresses, ports and routing
 * state. It used to be split across this page and a separate Settings page,
 * but that page only ever held these same two fields.
 */
export default function Network({ onChange }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const { busy, run } = useAsync();
  const toast = useToast();

  const load = useCallback(() => {
    api.network().then(setData).catch((e) => setError(e.message));
  }, []);

  useEffect(load, [load]);

  const [settings, setSettings] = useState(null);
  const [form, setForm] = useState({ domain: '', publicHost: '', webhookUrl: '' });
  const [saveResult, setSaveResult] = useState(null);
  const { busy: savingSettings, run: runSave } = useAsync();
  const { busy: testingWebhook, run: runTest } = useAsync();

  const loadSettings = useCallback(() => {
    api.settings().then((d) => {
      setSettings(d);
      setForm({ domain: d.settings.domain, publicHost: d.settings.publicHost, webhookUrl: d.settings.webhookUrl });
    });
  }, []);

  useEffect(loadSettings, [loadSettings]);

  if (error) return <div className="card err-text">{error}</div>;
  if (!data) return <div className="empty">Loading</div>;

  const copy = (text) => { navigator.clipboard?.writeText(text); toast('Copied'); };
  const direct = data.servers.filter((s) => s.hostPort);
  const drifted = data.router.routes.filter((r) => r.drifted);

  const setField = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const dirty =
    settings &&
    (form.domain !== settings.settings.domain ||
      form.publicHost !== settings.settings.publicHost ||
      form.webhookUrl !== settings.settings.webhookUrl);

  const saveSettings = () =>
    runSave(async () => {
      const res = await api.saveSettings(form);
      setSaveResult(res);
      loadSettings();
      load();
      onChange?.();
    }, 'Settings saved');

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h2>Network</h2>
          <div className="muted small">How players reach your servers, and what is open on the host</div>
        </div>
        <button className="sm" onClick={load}>Refresh</button>
      </div>

      {data.conflicts.length > 0 && (
        <div className="card err-text">
          {data.conflicts.map((c) => `Port ${c.port} is claimed by ${c.servers.join(' and ')}.`).join(' ')}
        </div>
      )}

      {settings && (
        <section className="card">
          <div className="card-head"><h3>Configuration</h3></div>

          <div className="field">
            <label>Base domain</label>
            <input className="mono" value={form.domain} onChange={setField('domain')} spellCheck={false} autoCapitalize="off" />
            <div className="hint">
              Every server is reachable at <code className="mono">name.{form.domain || 'your-domain'}</code> on
              port {data.sharedPort}. Changing it renames every server's address and updates mc-router straight
              away. Worlds and containers are untouched.
              {' '}({settings.settings.domainFromEnv ? `from .env, DOMAIN=${settings.settings.envDomain}` : 'set here'})
            </div>
          </div>

          <div className="field">
            <label>Host address for direct ports</label>
            <input
              className="mono"
              value={form.publicHost}
              onChange={setField('publicHost')}
              placeholder={settings.settings.detectedIp || 'your-host'}
              spellCheck={false}
              autoCapitalize="off"
            />
            <div className="hint">
              Shown to players for servers published on their own port, as
              <code className="mono"> {form.publicHost || settings.settings.detectedIp || 'your-host'}:port</code>.
              Left blank, mctl detects the server's own public IP rather than using the domain above, which is
              usually proxied and not reachable on an arbitrary port. Set this to override it, for example with
              a LAN address. ({settings.settings.publicHostSource})
            </div>
          </div>

          <div className="row" style={{ gap: 8 }}>
            <button className="primary" disabled={savingSettings || !dirty} onClick={saveSettings}>Save</button>
            {dirty && (
              <button
                disabled={savingSettings}
                onClick={() =>
                  setForm({
                    domain: settings.settings.domain,
                    publicHost: settings.settings.publicHost,
                    webhookUrl: settings.settings.webhookUrl,
                  })
                }
              >
                Reset
              </button>
            )}
          </div>

          {saveResult?.rehosted?.length > 0 && (
            <div className="hint" style={{ marginTop: 10 }}>
              Moved {saveResult.rehosted.length} server{saveResult.rehosted.length === 1 ? '' : 's'}:
              <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
                {saveResult.rehosted.map((r) => <li key={r} className="mono">{r}</li>)}
              </ul>
            </div>
          )}
        </section>
      )}

      {settings && (
        <section className="card">
          <div className="card-head"><h3>Notifications</h3></div>
          <div className="field">
            <label>Webhook URL</label>
            <input
              className="mono"
              value={form.webhookUrl}
              onChange={setField('webhookUrl')}
              placeholder="https://discord.com/api/webhooks/..."
              spellCheck={false}
              autoCapitalize="off"
            />
            <div className="hint">
              Posted to on a server crashing or failing to start, a scheduled backup or task failing,
              and the backup volume running low on space. Works directly with a Discord webhook; empty
              turns it off. Save before testing, since the test sends whatever is currently saved.
            </div>
          </div>
          <button
            className="sm"
            disabled={testingWebhook || dirty || !form.webhookUrl.trim()}
            onClick={() => runTest(() => api.testWebhook(), 'Test sent')}
          >
            Send test
          </button>
        </section>
      )}

      <section className="card">
        <div className="card-head">
          <h3>Addresses</h3>
          <span className="muted small">"Same network" only works for players on the same local network as the host</span>
        </div>
        <table>
          <thead>
            <tr>
              <th style={{ width: 150 }}>Server</th>
              <th>Through the router</th>
              <th>Direct</th>
              <th>Same network</th>
            </tr>
          </thead>
          <tbody>
            {data.servers.map((s) => (
              <tr key={s.id}>
                <td><Link to={`/servers/${s.id}`}>{s.name}</Link></td>
                <td><button className="link mono" onClick={() => copy(s.routerAddress)}>{s.routerAddress}</button></td>
                <td>
                  {s.directAddress ? (
                    <button className="link mono" onClick={() => copy(s.directAddress)}>{s.directAddress}</button>
                  ) : (
                    <span className="muted">none</span>
                  )}
                  {s.pendingRestart && (
                    <div className="err-text small">Not applied yet, recreate the container</div>
                  )}
                </td>
                <td>
                  {s.lanAddress ? (
                    <button className="link mono" onClick={() => copy(s.lanAddress)}>{s.lanAddress}</button>
                  ) : (
                    <span className="muted">{s.hostPort ? 'not detected yet' : 'none'}</span>
                  )}
                </td>
              </tr>
            ))}
            {data.servers.length === 0 && (
              <tr><td colSpan={4} className="muted small">No servers yet.</td></tr>
            )}
          </tbody>
        </table>
      </section>

      <details className="card" open>
        <summary>How to connect</summary>
        <dl className="kv">
          <dt>Through the router</dt>
          <dd>
            name.{settings?.settings?.domain || 'your-domain'} works from anywhere, once set up. Forward port
            {' '}{data.sharedPort} on the router, and point a DNS record at the box's public IP, set to DNS
            only rather than proxied. Every server shares this one port.
          </dd>
          <dt>Direct</dt>
          <dd>
            Bypasses the router using a server's own port, set under its Settings tab. Forward just that port
            on the router and share the address, no DNS record needed. The fastest way to get one server
            reachable.
          </dd>
          <dt>Same network</dt>
          <dd>
            The same port as Direct, but the host's own address on the local network. Works for anyone on the
            same network as the host, with no port forwarding at all.
          </dd>
        </dl>
        <div className="hint" style={{ marginTop: 10 }}>
          If forwarding a port does not seem to work, the ISP may be using CGNAT: check whether the router's
          WAN address actually matches the public IP an outside service reports. If so, port forwarding
          cannot work and a tunnel or relay is needed instead.
        </div>
      </details>

      <section className="card">
        <div className="card-head"><h3>Open on the host</h3></div>
        <table>
          <thead>
            <tr><th style={{ width: 90 }}>Port</th><th>Used by</th></tr>
          </thead>
          <tbody>
            <tr>
              <td className="mono">{data.sharedPort}</td>
              <td>mc-router, shared by every hostname above</td>
            </tr>
            {direct.map((s) => (
              <tr key={s.id}>
                <td className="mono">{s.hostPort}</td>
                <td><Link to={`/servers/${s.id}`}>{s.name}</Link>, published directly</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="card">
        <div className="card-head">
          <h3>Routing</h3>
          <div className="row" style={{ gap: 8 }}>
            <span className="pill">
              <span className={`dot ${data.router.reachable ? 'ready' : 'unhealthy'}`} />
              {data.router.reachable ? 'mc-router reachable' : 'mc-router unreachable'}
            </span>
            <button
              className="sm"
              disabled={busy}
              onClick={() => run(async () => { await api.syncRouter(); load(); }, 'Routes resynced')}
            >
              Resync
            </button>
          </div>
        </div>

        {data.router.status.lastError && (
          <div className="err-text small" style={{ marginBottom: 8 }}>{data.router.status.lastError}</div>
        )}

        {drifted.length === 0 ? (
          <div className="muted small">
            All {data.router.routes.length} route{data.router.routes.length === 1 ? '' : 's'} match what mctl expects.
          </div>
        ) : (
          <table>
            <thead>
              <tr><th>Hostname</th><th>Live</th><th>Expected</th></tr>
            </thead>
            <tbody>
              {drifted.map((r) => (
                <tr key={r.hostname}>
                  <td className="mono small">{r.hostname}</td>
                  <td className="mono small">{r.live || <span className="muted">none</span>}</td>
                  <td className="mono small err-text">{r.expected || <span className="muted">none</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="card">
        <div className="card-head"><h3>Internal only, never published</h3></div>
        <table>
          <thead>
            <tr><th style={{ width: 90 }}>Port</th><th style={{ width: 150 }}>Where</th><th>What</th></tr>
          </thead>
          <tbody>
            {data.internal.map((p) => (
              <tr key={`${p.scope}-${p.port}`}>
                <td className="mono">{p.port}</td>
                <td className="muted small">{p.scope}</td>
                <td className="small">{p.description}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}
