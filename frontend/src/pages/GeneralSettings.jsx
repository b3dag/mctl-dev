import React, { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import { useAsync } from '../ui.jsx';

export default function GeneralSettings({ onChange }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [form, setForm] = useState({ domain: '', publicHost: '', stopWarningSeconds: '30' });
  const [result, setResult] = useState(null);
  const { busy, run } = useAsync();

  const load = useCallback(() => {
    api
      .settings()
      .then((d) => {
        setData(d);
        setForm({
          domain: d.settings.domain,
          publicHost: d.settings.publicHost,
          stopWarningSeconds: String(d.settings.stopWarningSeconds),
        });
      })
      .catch((e) => setError(e.message));
  }, []);

  useEffect(load, [load]);

  if (error) return <div className="card err-text">{error}</div>;
  if (!data) return <div className="empty">Loading</div>;

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const dirty =
    form.domain !== data.settings.domain ||
    form.publicHost !== data.settings.publicHost ||
    Number(form.stopWarningSeconds) !== data.settings.stopWarningSeconds;

  const save = () =>
    run(async () => {
      const res = await api.saveSettings({
        ...form,
        stopWarningSeconds: Number(form.stopWarningSeconds),
      });
      setResult(res);
      load();
      onChange?.();
    }, 'Settings saved');

  return (
    <div className="stack">
      <h2>Settings</h2>

      <div className="card">
        <div className="card-head"><h3>Addresses</h3></div>

        <div className="field">
          <label>Base domain</label>
          <input className="mono" value={form.domain} onChange={set('domain')} spellCheck={false} autoCapitalize="off" />
          <div className="hint">
            Every server is reachable at <code className="mono">name.{form.domain || 'your-domain'}</code> on
            port {data.publicMcPort}. Changing it renames every server's address and updates
            mc-router straight away. Worlds and containers are untouched.
          </div>
        </div>

        <div className="field">
          <label>Host address for direct ports</label>
          <input className="mono" value={form.publicHost} onChange={set('publicHost')} spellCheck={false} autoCapitalize="off" />
          <div className="hint">
            Shown to players for servers published on their own port, as
            <code className="mono"> {form.publicHost || 'your-host'}:port</code>. A bare IP is fine.
          </div>
        </div>

        <div className="field">
          <label>Warn players before stopping, in seconds</label>
          <input
            className="mono"
            type="number"
            min="0"
            max="120"
            style={{ maxWidth: 160 }}
            value={form.stopWarningSeconds}
            onChange={set('stopWarningSeconds')}
          />
          <div className="hint">
            A stop or restart broadcasts a countdown over RCON first. Skipped when nobody is
            online, so an idle shutdown is still immediate. 0 turns it off.
          </div>
        </div>

        <div className="row" style={{ gap: 8 }}>
          <button className="primary" disabled={busy || !dirty} onClick={save}>Save</button>
          {dirty && <button disabled={busy} onClick={() => setForm({
            domain: data.settings.domain,
            publicHost: data.settings.publicHost,
            stopWarningSeconds: String(data.settings.stopWarningSeconds),
          })}>Reset</button>}
        </div>

        {result?.rehosted?.length > 0 && (
          <div className="hint" style={{ marginTop: 10 }}>
            Moved {result.rehosted.length} server{result.rehosted.length === 1 ? '' : 's'}:
            <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
              {result.rehosted.map((r) => <li key={r} className="mono">{r}</li>)}
            </ul>
          </div>
        )}
      </div>

      <div className="card">
        <div className="card-head"><h3>Where these come from</h3></div>
        <dl className="kv">
          <dt>Base domain</dt>
          <dd>{data.settings.domainFromEnv ? `.env (DOMAIN=${data.settings.envDomain})` : 'set here'}</dd>
          <dt>Host address</dt>
          <dd>{data.settings.publicHostFromEnv ? '.env, or the base domain' : 'set here'}</dd>
          <dt>Shared port</dt>
          <dd className="mono">{data.publicMcPort}</dd>
        </dl>
      </div>
    </div>
  );
}
