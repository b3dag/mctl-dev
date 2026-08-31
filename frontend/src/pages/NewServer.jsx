import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api.js';
import { useAsync } from '../ui.jsx';

const slugify = (s) =>
  s.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);

export default function NewServer({ onCreated }) {
  const nav = useNavigate();
  const { busy, run } = useAsync();
  const [meta, setMeta] = useState(null);
  const [me, setMe] = useState(null);
  const [form, setForm] = useState({
    name: '',
    slug: '',
    hostPort: '',
    upnpEnabled: false,
    type: 'PAPER',
    version: 'LATEST',
    memory: '2G',
    seed: '',
    motd: '',
    difficulty: 'easy',
    mode: 'survival',
    maxPlayers: '20',
    autostart_on_join: true,
    idle_timeout_minutes: 30,
    start: true,
  });

  useEffect(() => {
    api.meta().then(setMeta).catch(() => {});
    api.me().then(setMe).catch(() => {});
  }, []);

  const set = (k) => (e) => {
    const v = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
    setForm((f) => ({ ...f, [k]: v }));
  };

  const slug = form.slug || slugify(form.name);

  const submit = (e) => {
    e.preventDefault();
    run(async () => {
      const { server } = await api.createServer({
        name: form.name,
        slug,
        host_port: form.hostPort === '' ? null : Number(form.hostPort),
        upnp_enabled: form.upnpEnabled,
        type: form.type,
        version: form.version,
        memory: form.memory,
        seed: form.seed || undefined,
        autostart_on_join: form.autostart_on_join,
        idle_timeout_minutes: Number(form.idle_timeout_minutes),
        start: form.start,
        env: {
          MOTD: form.motd || form.name,
          DIFFICULTY: form.difficulty,
          MODE: form.mode,
          MAX_PLAYERS: form.maxPlayers,
        },
      });
      onCreated?.();
      nav(`/servers/${server.id}`);
    }, 'Server created');
  };

  return (
    <form className="stack" onSubmit={submit}>
      <div className="row between">
        <h2>New server</h2>
        <button type="button" className="ghost" onClick={() => nav('/')}>Cancel</button>
      </div>

      <div className="card">
        <div className="field">
          <label>Name</label>
          <input value={form.name} onChange={set('name')} placeholder="Survival" required autoFocus />
        </div>

        <div className="field">
          <label>Hostname</label>
          <input value={form.slug} onChange={set('slug')} placeholder={slugify(form.name) || 'survival'} />
          <div className="hint mono">{slug || 'name'}.{me?.domain || 'your-domain'}</div>
          <div className="hint">
            With a wildcard DNS record pointed at this host, players join with that address and no
            port number.
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
            value={form.hostPort}
            onChange={set('hostPort')}
            placeholder="none"
          />
          <div className="hint">
            {form.hostPort ? (
              <>
                Also reachable at <code className="mono">{me?.publicHost || 'your-host'}:{form.hostPort}</code>, no DNS needed.
                {me?.lanHost && <> Players on the same network can use <code className="mono">{me.lanHost}:{form.hostPort}</code> instead.</>}
              </>
            ) : (
              <>Leave empty to use the hostname above. Set a port to publish this server directly as well - the simplest option if you don't want to configure DNS.</>
            )}
          </div>
        </div>

        {form.hostPort && (
          <div className="checkbox">
            <input id="upnp" type="checkbox" checked={form.upnpEnabled} onChange={set('upnpEnabled')} />
            <label htmlFor="upnp">Forward this port automatically via UPnP</label>
          </div>
        )}
        {form.hostPort && form.upnpEnabled && (
          <div className="small muted" style={{ marginTop: -6 }}>
            Asks the router on this host's local network to open the port on its own. Only works on a
            LAN with a UPnP-capable router - it does nothing on a VPS or cloud host, since there is no
            such router to ask.
          </div>
        )}

        <div className="row wrap" style={{ gap: 12 }}>
          <div className="field grow">
            <label>Server type</label>
            <select value={form.type} onChange={set('type')}>
              {(meta?.types || []).map((t) => (
                <option key={t.value} value={t.value}>{t.label}</option>
              ))}
            </select>
          </div>
          <div className="field grow">
            <label>Version</label>
            <input value={form.version} onChange={set('version')} placeholder="LATEST or 1.21.1" />
          </div>
          <div className="field grow">
            <label>Memory</label>
            <input value={form.memory} onChange={set('memory')} placeholder="2G" />
          </div>
        </div>

        <div className="row wrap" style={{ gap: 12 }}>
          <div className="field grow">
            <label>Difficulty</label>
            <select value={form.difficulty} onChange={set('difficulty')}>
              {['peaceful', 'easy', 'normal', 'hard'].map((d) => <option key={d}>{d}</option>)}
            </select>
          </div>
          <div className="field grow">
            <label>Game mode</label>
            <select value={form.mode} onChange={set('mode')}>
              {['survival', 'creative', 'adventure', 'spectator'].map((d) => <option key={d}>{d}</option>)}
            </select>
          </div>
          <div className="field grow">
            <label>Max players</label>
            <input type="number" min="1" value={form.maxPlayers} onChange={set('maxPlayers')} />
          </div>
        </div>

        <div className="field">
          <label>MOTD</label>
          <input value={form.motd} onChange={set('motd')} placeholder={form.name || 'A Minecraft Server'} />
        </div>

        <div className="field">
          <label>World seed (optional)</label>
          <input value={form.seed} onChange={set('seed')} placeholder="leave empty for random" />
        </div>
      </div>

      <div className="card stack">
        <div className="checkbox">
          <input id="wake" type="checkbox" checked={form.autostart_on_join} onChange={set('autostart_on_join')} />
          <label htmlFor="wake">Start automatically when a player joins</label>
        </div>
        <div className="small muted" style={{ marginTop: -6 }}>
          While stopped, the hostname stays registered and points at the manager, which boots the
          container on a join attempt and asks the player to reconnect.
        </div>

        <div className="field" style={{ maxWidth: 220 }}>
          <label>Stop after idle (minutes, 0 = never)</label>
          <input type="number" min="0" value={form.idle_timeout_minutes} onChange={set('idle_timeout_minutes')} />
        </div>

        <div className="checkbox">
          <input id="start" type="checkbox" checked={form.start} onChange={set('start')} />
          <label htmlFor="start">Start it right away</label>
        </div>
      </div>

      <div className="row">
        <button className="primary" disabled={busy || !form.name}>
          {busy ? 'Creating…' : 'Create server'}
        </button>
      </div>
    </form>
  );
}
