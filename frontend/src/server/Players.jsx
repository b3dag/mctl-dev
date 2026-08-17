import React, { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import { useAsync, useToast } from '../ui.jsx';

/** A name field with an add button, used by each of the lists below. */
function AddRow({ placeholder, onAdd, busy, withReason, extra }) {
  const [value, setValue] = useState('');
  const [reason, setReason] = useState('');

  const submit = (e) => {
    e.preventDefault();
    if (!value.trim()) return;
    onAdd(value.trim(), reason.trim());
    setValue('');
    setReason('');
  };

  return (
    <form className="row wrap" style={{ gap: 8, marginTop: 10 }} onSubmit={submit}>
      <input
        className="grow"
        style={{ minWidth: 150 }}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder={placeholder}
        autoCapitalize="off"
        spellCheck={false}
      />
      {withReason && (
        <input
          className="grow"
          style={{ minWidth: 150 }}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="reason (optional)"
        />
      )}
      {extra}
      <button className="primary" disabled={busy || !value.trim()}>Add</button>
    </form>
  );
}

function ListCard({ title, note, rows, columns, empty, children }) {
  return (
    <section className="card">
      <div className="card-head">
        <h3>{title}</h3>
        {note}
      </div>
      <table>
        {columns && (
          <thead>
            <tr>{columns.map((c, i) => <th key={i} style={c.width ? { width: c.width } : undefined}>{c.label}</th>)}</tr>
          </thead>
        )}
        <tbody>
          {rows}
          {rows.length === 0 && (
            <tr><td colSpan={columns?.length || 2} className="muted small">{empty}</td></tr>
          )}
        </tbody>
      </table>
      {children}
    </section>
  );
}

export default function Players({ server, state }) {
  const [lists, setLists] = useState(null);
  const [online, setOnline] = useState(null);
  const [error, setError] = useState(null);
  const [opLevel, setOpLevel] = useState('4');
  const { busy, run } = useAsync();
  const toast = useToast();

  const load = useCallback(() => {
    api.playerLists(server.id).then(setLists).catch((e) => setError(e.message));
    if (state.phase === 'ready') {
      api.players(server.id).then(setOnline).catch(() => setOnline(null));
    } else {
      setOnline(null);
    }
  }, [server.id, state.phase]);

  useEffect(() => {
    load();
    const t = setInterval(load, 20000);
    return () => clearInterval(t);
  }, [load]);

  if (error) return <div className="card err-text">{error}</div>;
  if (!lists) return <div className="empty">Loading</div>;

  const act = (fn, msg) => run(async () => { const r = await fn(); load(); if (r?.via === 'file') toast(r.output); }, msg);
  const live = lists.live;

  return (
    <div className="stack">
      {!live && (
        <div className="card hint" style={{ marginTop: 0 }}>
          The server is not running. Changes here are written straight into its files and take
          effect when it starts. Adding someone new needs a Mojang lookup for their UUID.
        </div>
      )}

      <ListCard
        title="Online now"
        note={<span className="muted small">{online ? `${online.online}${online.max ? ` of ${online.max}` : ''}` : 'server not running'}</span>}
        columns={[{ label: 'Player' }, { label: '', width: 210 }]}
        empty={live ? 'Nobody is online.' : 'The server is not running.'}
        rows={(online?.players || []).map((name) => (
          <tr key={name}>
            <td className="mono">{name}</td>
            <td className="actions">
              <button className="sm" disabled={busy} onClick={() => act(() => api.kickPlayer(server.id, name), `${name} kicked`)}>Kick</button>
              <button className="sm" disabled={busy} onClick={() => act(() => api.addOp(server.id, name), `${name} opped`)}>Op</button>
              <button className="sm danger" disabled={busy} onClick={() => act(() => api.banPlayer(server.id, name), `${name} banned`)}>Ban</button>
            </td>
          </tr>
        ))}
      />

      <ListCard
        title="Whitelist"
        note={
          <div className="row" style={{ gap: 8 }}>
            <span className="pill">
              <span className={`dot ${lists.whitelistEnabled ? 'ready' : ''}`} />
              {lists.whitelistEnabled ? 'enforced' : 'not enforced'}
            </span>
            <button
              className="sm"
              disabled={busy || !live}
              title={live ? '' : 'the server must be running to switch this'}
              onClick={() =>
                act(() => api.setWhitelistEnabled(server.id, !lists.whitelistEnabled),
                    lists.whitelistEnabled ? 'Whitelist off' : 'Whitelist on')
              }
            >
              {lists.whitelistEnabled ? 'Turn off' : 'Turn on'}
            </button>
          </div>
        }
        columns={[{ label: 'Player' }, { label: '', width: 100 }]}
        empty="Nobody is whitelisted."
        rows={lists.whitelist.map((p) => (
          <tr key={p.uuid || p.name}>
            <td>
              <span className="mono">{p.name}</span>
              <div className="muted small mono">{p.uuid}</div>
            </td>
            <td className="actions">
              <button className="sm" disabled={busy} onClick={() => act(() => api.removeFromWhitelist(server.id, p.name), `${p.name} removed`)}>Remove</button>
            </td>
          </tr>
        ))}
      >
        <AddRow
          placeholder="Minecraft name"
          busy={busy}
          onAdd={(name) => act(() => api.addToWhitelist(server.id, name), `${name} whitelisted`)}
        />
      </ListCard>

      <ListCard
        title="Operators"
        columns={[{ label: 'Player' }, { label: 'Level', width: 70 }, { label: '', width: 100 }]}
        empty="No operators."
        rows={lists.ops.map((p) => (
          <tr key={p.uuid || p.name}>
            <td>
              <span className="mono">{p.name}</span>
              <div className="muted small mono">{p.uuid}</div>
            </td>
            <td>{p.level}</td>
            <td className="actions">
              <button className="sm" disabled={busy} onClick={() => act(() => api.removeOp(server.id, p.name), `${p.name} deopped`)}>Remove</button>
            </td>
          </tr>
        ))}
      >
        <AddRow
          placeholder="Minecraft name"
          busy={busy}
          extra={
            <select style={{ width: 130 }} value={opLevel} onChange={(e) => setOpLevel(e.target.value)}>
              <option value="1">1 bypass spawn</option>
              <option value="2">2 commands</option>
              <option value="3">3 moderation</option>
              <option value="4">4 full</option>
            </select>
          }
          onAdd={(name) => act(() => api.addOp(server.id, name, Number(opLevel)), `${name} opped`)}
        />
        {live && (
          <div className="hint">
            While the server is running it assigns the level from its own
            <code> op-permission-level</code>; the choice above applies when it is stopped.
          </div>
        )}
      </ListCard>

      <ListCard
        title="Banned players"
        columns={[{ label: 'Player' }, { label: 'Reason' }, { label: '', width: 100 }]}
        empty="Nobody is banned."
        rows={lists.bannedPlayers.map((p) => (
          <tr key={p.uuid || p.name}>
            <td>
              <span className="mono">{p.name}</span>
              <div className="muted small">{p.created}</div>
            </td>
            <td className="small">{p.reason}</td>
            <td className="actions">
              <button className="sm" disabled={busy} onClick={() => act(() => api.pardonPlayer(server.id, p.name), `${p.name} unbanned`)}>Unban</button>
            </td>
          </tr>
        ))}
      >
        <AddRow
          placeholder="Minecraft name"
          withReason
          busy={busy}
          onAdd={(name, reason) => act(() => api.banPlayer(server.id, name, reason), `${name} banned`)}
        />
      </ListCard>

      <ListCard
        title="Banned IPs"
        columns={[{ label: 'Address' }, { label: 'Reason' }, { label: '', width: 100 }]}
        empty="No banned addresses."
        rows={lists.bannedIps.map((p) => (
          <tr key={p.ip}>
            <td>
              <span className="mono">{p.ip}</span>
              <div className="muted small">{p.created}</div>
            </td>
            <td className="small">{p.reason}</td>
            <td className="actions">
              <button className="sm" disabled={busy} onClick={() => act(() => api.pardonIp(server.id, p.ip), `${p.ip} unbanned`)}>Unban</button>
            </td>
          </tr>
        ))}
      >
        <AddRow
          placeholder="203.0.113.4"
          withReason
          busy={busy}
          onAdd={(ip, reason) => act(() => api.banIp(server.id, ip, reason), `${ip} banned`)}
        />
      </ListCard>
    </div>
  );
}
