import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import { useAsync } from '../ui.jsx';

/**
 * Grouped by what you came to change, rather than one long form: who it is,
 * how it is reached, what it runs, how it behaves, then the game's own
 * settings and finally the escape hatches.
 */
export default function Settings({ server, me, onSaved, onDelete }) {
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
    stop_warning_seconds: server.stopWarningSeconds,
  });
  const [env, setEnv] = useState(server.env || {});
  const [rawKey, setRawKey] = useState('');
  const [rawVal, setRawVal] = useState('');
  const { busy, run } = useAsync();

  useEffect(() => {
    api.meta().then(setMeta).catch(() => {});
  }, []);

  const set = (k) => (e) => {
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
        stop_warning_seconds: Number(core.stop_warning_seconds),
        env,
        apply,
      });
      onSaved?.();
    }, apply ? 'Saved and container recreated' : 'Saved, not yet applied');

  const catalogKeys = new Set((meta?.envCatalog || []).flatMap((g) => g.vars.map((v) => v.key)));
  const extraEnv = Object.entries(env).filter(([k]) => !catalogKeys.has(k));

  return (
    <div className="stack">
      <section className="card">
        <div className="card-head"><h3>Identity</h3></div>
        <div className="field">
          <label>Display name</label>
          <input value={core.name} onChange={set('name')} />
        </div>
        <dl className="kv">
          <dt>Short name</dt><dd className="mono">{server.slug}</dd>
          <dt>Container</dt><dd className="mono">{server.container}</dd>
        </dl>
        <div className="hint">
          The short name also names the container and its data volume, so it stays fixed. Create a
          new server to change it.
        </div>
      </section>

      <section className="card">
        <div className="card-head"><h3>Connection</h3></div>
        <div className="field">
          <label>Join address</label>
          <input
            className="mono"
            value={core.hostname}
            onChange={set('hostname')}
            placeholder={server.hostname}
            autoCapitalize="off"
            spellCheck={false}
          />
          <div className="hint">
            {core.hostname.trim()
              ? 'A custom address. Make sure DNS for it points at this host.'
              : 'Empty means it follows the base domain automatically.'}{' '}
            Applied immediately, without restarting.
          </div>
        </div>

        <div className="field">
          <label>Direct port</label>
          <input
            className="mono"
            type="number"
            min="1024"
            max="65535"
            style={{ maxWidth: 160 }}
            value={core.host_port}
            onChange={set('host_port')}
            placeholder="none"
          />
          <div className="hint">
            {core.host_port
              ? <>Also reachable at <code className="mono">{me?.publicHost || 'your-host'}:{core.host_port}</code>, no DNS needed.</>
              : <>Only reachable by hostname on port {me?.publicMcPort ?? 25565}. Set a port to publish it directly as well.</>}
            {' '}Changing this recreates the container.
          </div>
        </div>
      </section>

      <section className="card">
        <div className="card-head"><h3>Runtime</h3></div>
        <div className="row wrap" style={{ gap: 12 }}>
          <div className="field grow">
            <label>Type</label>
            <select value={core.type} onChange={set('type')}>
              {(meta?.types || []).map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
            </select>
          </div>
          <div className="field grow">
            <label>Version</label>
            <input value={core.version} onChange={set('version')} />
          </div>
          <div className="field grow">
            <label>Memory</label>
            <input value={core.memory} onChange={set('memory')} />
          </div>
        </div>
        <div className="hint">Changing any of these recreates the container against the same world.</div>
      </section>

      <section className="card">
        <div className="card-head"><h3>Behaviour</h3></div>
        <div className="checkbox">
          <input id="wake" type="checkbox" checked={core.autostart_on_join} onChange={set('autostart_on_join')} />
          <label htmlFor="wake">Start automatically when a player connects</label>
        </div>
        <div className="hint" style={{ marginBottom: 12 }}>
          With this off, players are told the server is offline instead of waking it.
        </div>
        <div className="row wrap" style={{ gap: 12 }}>
          <div className="field" style={{ maxWidth: 220, marginBottom: 0 }}>
            <label>Stop after idle, in minutes</label>
            <input type="number" min="0" value={core.idle_timeout_minutes} onChange={set('idle_timeout_minutes')} />
            <div className="hint">0 keeps it running forever.</div>
          </div>
          <div className="field" style={{ maxWidth: 220, marginBottom: 0 }}>
            <label>Warn players before stopping, in seconds</label>
            <input
              type="number"
              min="0"
              max="120"
              value={core.stop_warning_seconds}
              onChange={set('stop_warning_seconds')}
            />
            <div className="hint">
              Broadcast over RCON before a stop or restart. Skipped when nobody is online, so the
              idle stop stays immediate. 0 turns it off.
            </div>
          </div>
        </div>
      </section>

      {(meta?.envCatalog || []).map((group) => (
        <section className="card" key={group.group}>
          <div className="card-head"><h3>{group.group}</h3></div>
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
                {v.hint && <div className="hint">{v.hint}</div>}
              </div>
            ))}
          </div>
        </section>
      ))}

      <section className="card">
        <div className="card-head"><h3>Advanced</h3></div>
        <div className="hint" style={{ marginTop: 0, marginBottom: 10 }}>
          Any other variable the itzg image supports. <code>EULA</code>, <code>TYPE</code>,{' '}
          <code>VERSION</code> and the RCON settings are managed for you.
        </div>
        {extraEnv.map(([k, v]) => (
          <div className="row" key={k} style={{ gap: 8, marginBottom: 8 }}>
            <input className="mono" style={{ maxWidth: 220 }} value={k} readOnly />
            <input className="grow mono" value={v} onChange={(e) => setEnvVar(k, e.target.value)} />
            <button className="sm danger" onClick={() => setEnvVar(k, '')}>remove</button>
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
            onClick={() => { setEnvVar(rawKey.trim(), rawVal); setRawKey(''); setRawVal(''); }}
          >
            add
          </button>
        </div>
      </section>

      <div className="save-bar">
        <span className="muted small">
          Applying recreates the container against the same data volume. Worlds, mods and configs stay.
        </span>
        <div className="row" style={{ gap: 8 }}>
          <button disabled={busy} onClick={() => save(false)}>Save only</button>
          <button className="primary" disabled={busy} onClick={() => save(true)}>Save and apply</button>
        </div>
      </div>

      <section className="card danger-zone">
        <div className="card-head"><h3>Danger</h3></div>
        <div className="row between wrap" style={{ gap: 10 }}>
          <span className="small muted">
            Deleting removes the container and its route, and optionally the world.
          </span>
          <button className="danger" onClick={onDelete}>Delete this server</button>
        </div>
      </section>
    </div>
  );
}
