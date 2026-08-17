import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import { useAsync } from '../ui.jsx';

export default function Settings({ server, me, onSaved }) {
  const [meta, setMeta] = useState(null);
  const [core, setCore] = useState({
    name: server.name,
    hostname: server.hostnameOverride || '',
    host_port: server.hostPort ? String(server.hostPort) : '',
    type: server.type,
    version: server.version,
    memory: server.memory,
    autostart_on_join: server.autostartOnJoin,
    idle_timeout_minutes: server.idleTimeoutMinutes,
  });
  const [env, setEnv] = useState(server.env || {});
  const [rawKey, setRawKey] = useState('');
  const [rawVal, setRawVal] = useState('');
  const { busy, run } = useAsync();

  useEffect(() => {
    api.meta().then(setMeta).catch(() => {});
  }, []);

  const setCoreField = (k) => (e) => {
    const v = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
    setCore((c) => ({ ...c, [k]: v }));
  };

  const setEnvVar = (k, v) =>
    setEnv((prev) => {
      const next = { ...prev };
      if (v === '' || v === undefined) delete next[k];
      else next[k] = String(v);
      return next;
    });

  const save = (apply) =>
    run(async () => {
      await api.updateServer(server.id, {
        ...core,
        host_port: core.host_port === '' ? null : Number(core.host_port),
        idle_timeout_minutes: Number(core.idle_timeout_minutes),
        env,
        apply,
      });
      onSaved?.();
    }, apply ? 'Saved — container recreated' : 'Saved (not yet applied)');

  const catalogKeys = new Set((meta?.envCatalog || []).flatMap((g) => g.vars.map((v) => v.key)));
  const extraEnv = Object.entries(env).filter(([k]) => !catalogKeys.has(k));

  return (
    <div className="stack">
      <div className="card stack">
        <strong>Core</strong>
        <div className="field">
          <label>Display name</label>
          <input value={core.name} onChange={setCoreField('name')} />
        </div>

        <div className="field">
          <label>Join address</label>
          <input
            className="mono"
            value={core.hostname}
            onChange={setCoreField('hostname')}
            placeholder={server.hostname}
            autoCapitalize="off"
            spellCheck={false}
          />
          <div className="hint">
            {core.hostname.trim()
              ? 'Custom address. Make sure DNS for it points at this host.'
              : `Using the default for this server's slug. Leave empty to keep tracking the base domain.`}{' '}
            Applied immediately, without restarting the server.
          </div>
        </div>

        <div className="field">
          <label>Direct port (optional)</label>
          <input
            className="mono"
            type="number"
            min="1024"
            max="65535"
            style={{ maxWidth: 160 }}
            value={core.host_port}
            onChange={setCoreField('host_port')}
            placeholder="none"
          />
          <div className="hint">
            {core.host_port
              ? <>Also reachable at <code className="mono">{me?.publicHost || 'your-host'}:{core.host_port}</code> without DNS. Forward this port on your firewall.</>
              : <>Only reachable by hostname through mc-router on port {me?.publicMcPort ?? 25565}. Set a port here to publish it directly as well — useful if you don't want to set up DNS.</>}
            {' '}Changing this recreates the container.
          </div>
        </div>
        <div className="row wrap" style={{ gap: 12 }}>
          <div className="field grow">
            <label>Type</label>
            <select value={core.type} onChange={setCoreField('type')}>
              {(meta?.types || []).map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
            </select>
          </div>
          <div className="field grow">
            <label>Version</label>
            <input value={core.version} onChange={setCoreField('version')} />
          </div>
          <div className="field grow">
            <label>Memory</label>
            <input value={core.memory} onChange={setCoreField('memory')} />
          </div>
        </div>
        <div className="checkbox">
          <input id="wake" type="checkbox" checked={core.autostart_on_join} onChange={setCoreField('autostart_on_join')} />
          <label htmlFor="wake">Start automatically when a player joins</label>
        </div>
        <div className="field" style={{ maxWidth: 220 }}>
          <label>Stop after idle (minutes, 0 = never)</label>
          <input type="number" min="0" value={core.idle_timeout_minutes} onChange={setCoreField('idle_timeout_minutes')} />
        </div>
        <div className="hint">
          Container <code>{server.container}</code> and its data volume are named after the short
          name and stay fixed; create a new server to change those.
        </div>
      </div>

      {(meta?.envCatalog || []).map((group) => (
        <div className="card stack" key={group.group}>
          <strong>{group.group}</strong>
          <div className="grid">
            {group.vars.map((v) => (
              <div className="field" key={v.key} style={{ margin: 0 }}>
                <label title={v.key}>{v.label} <span className="muted mono">{v.key}</span></label>
                {v.type === 'select' ? (
                  <select value={env[v.key] ?? v.default ?? ''} onChange={(e) => setEnvVar(v.key, e.target.value)}>
                    {v.options.map((o) => <option key={o}>{o}</option>)}
                  </select>
                ) : v.type === 'bool' ? (
                  <select
                    value={String(env[v.key] ?? v.default ?? 'false').toLowerCase()}
                    onChange={(e) => setEnvVar(v.key, e.target.value)}
                  >
                    <option value="true">yes</option>
                    <option value="false">no</option>
                  </select>
                ) : (
                  <input
                    type={v.type === 'number' ? 'number' : 'text'}
                    value={env[v.key] ?? ''}
                    placeholder={v.default || ''}
                    onChange={(e) => setEnvVar(v.key, e.target.value)}
                  />
                )}
                {v.hint && <div className="small muted">{v.hint}</div>}
              </div>
            ))}
          </div>
        </div>
      ))}

      <div className="card stack">
        <strong>Other environment variables</strong>
        <div className="small muted">
          Anything else the itzg image supports. <code>EULA</code>, <code>TYPE</code>,{' '}
          <code>VERSION</code> and the RCON settings are managed for you and cannot be set here.
        </div>
        {extraEnv.map(([k, v]) => (
          <div className="row" key={k} style={{ gap: 8 }}>
            <input className="mono" style={{ maxWidth: 220 }} value={k} readOnly />
            <input className="grow mono" value={v} onChange={(e) => setEnvVar(k, e.target.value)} />
            <button className="sm danger" onClick={() => setEnvVar(k, '')}>×</button>
          </div>
        ))}
        <div className="row" style={{ gap: 8 }}>
          <input
            className="mono"
            style={{ maxWidth: 220 }}
            placeholder="CURSEFORGE_FILES"
            value={rawKey}
            onChange={(e) => setRawKey(e.target.value.toUpperCase())}
          />
          <input className="grow mono" placeholder="value" value={rawVal} onChange={(e) => setRawVal(e.target.value)} />
          <button
            className="sm"
            disabled={!rawKey.trim()}
            onClick={() => {
              setEnvVar(rawKey.trim(), rawVal);
              setRawKey('');
              setRawVal('');
            }}
          >
            add
          </button>
        </div>
      </div>

      <div className="card row wrap between">
        <div className="small muted">
          Applying recreates the container against the same data volume — worlds, mods and configs stay.
        </div>
        <div className="row" style={{ gap: 8 }}>
          <button disabled={busy} onClick={() => save(false)}>Save only</button>
          <button className="primary" disabled={busy} onClick={() => save(true)}>Save &amp; apply</button>
        </div>
      </div>
    </div>
  );
}
