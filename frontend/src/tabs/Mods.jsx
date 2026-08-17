import React, { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { bytes, useAsync } from '../ui.jsx';

export default function Mods({ server }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState(null);
  const [url, setUrl] = useState('');
  const { busy, run } = useAsync();
  const fileInput = useRef(null);

  const load = useCallback(() => {
    api.mods(server.id).then(setData).catch((e) => setError(e.message));
  }, [server.id]);

  useEffect(load, [load]);

  if (error)
    return (
      <div className="card">
        <div className="err-text">{error}</div>
        <p className="small muted">
          Vanilla servers have no mod or plugin folder. Switch the server type under Settings to
          Paper, Fabric, Forge or similar.
        </p>
      </div>
    );

  if (!data) return <div className="empty">Loading…</div>;

  const search = (e) => {
    e.preventDefault();
    run(async () => setResults(await api.searchMods(server.id, query)));
  };

  const install = (body, label) =>
    run(async () => {
      await api.installMod(server.id, body);
      load();
    }, `${label} installed - restart to apply`);

  return (
    <div className="stack">
      <div className="card stack">
        <div className="row between">
          <strong>Installed ({data.mods.length})</strong>
          <div className="row" style={{ gap: 8 }}>
            <span className="pill">/data/{data.dir}</span>
            <button className="sm" onClick={() => fileInput.current?.click()} disabled={busy}>Upload jar</button>
          </div>
        </div>
        <input
          ref={fileInput}
          type="file"
          accept=".jar"
          multiple
          style={{ display: 'none' }}
          onChange={(e) => {
            const files = e.target.files;
            e.target.value = '';
            if (!files?.length) return;
            const fd = new FormData();
            for (const f of files) fd.append('file', f, f.name);
            run(async () => {
              await api.uploadMods(server.id, fd);
              load();
            }, 'Uploaded - restart to apply');
          }}
        />

        {data.mods.length === 0 ? (
          <div className="muted small">Nothing installed yet.</div>
        ) : (
          <table>
            <tbody>
              {data.mods.map((m) => (
                <tr key={m.file}>
                  <td className={m.enabled ? '' : 'muted'} style={{ wordBreak: 'break-all' }}>
                    {m.name} {!m.enabled && <span className="pill">disabled</span>}
                  </td>
                  <td className="muted small">{bytes(m.size)}</td>
                  <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                    <button
                      className="sm"
                      disabled={busy}
                      onClick={() => run(async () => { await api.toggleMod(server.id, m.file, !m.enabled); load(); })}
                    >
                      {m.enabled ? 'disable' : 'enable'}
                    </button>{' '}
                    <button
                      className="sm danger"
                      disabled={busy}
                      onClick={() => run(async () => { await api.removeMod(server.id, m.file); load(); }, 'Removed')}
                    >
                      del
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="card stack">
        <strong>Search Modrinth</strong>
        <form className="row" onSubmit={search} style={{ gap: 8 }}>
          <input
            className="grow"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={`for ${data.loader || server.type} ${server.version}`}
          />
          <button className="primary" disabled={busy}>Search</button>
        </form>

        {results && results.hits.length === 0 && (
          <div className="muted small">No results for this loader and game version.</div>
        )}
        {results?.hits.map((h) => (
          <div className="row between" key={h.id} style={{ gap: 10, borderTop: '1px solid var(--line)', paddingTop: 10 }}>
            <div className="grow" style={{ minWidth: 0 }}>
              <div style={{ fontWeight: 600 }}>{h.title}</div>
              <div className="small muted" style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {h.description}
              </div>
              <div className="small muted">{h.downloads.toLocaleString()} downloads {h.author}</div>
            </div>
            <button className="sm primary" disabled={busy} onClick={() => install({ projectId: h.id }, h.title)}>
              install
            </button>
          </div>
        ))}
      </div>

      <div className="card stack">
        <strong>Install from URL</strong>
        <div className="row" style={{ gap: 8 }}>
          <input
            className="grow mono"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://…/plugin.jar"
          />
          <button disabled={busy || !url.trim()} onClick={() => install({ url: url.trim() }, 'Jar')}>
            Install
          </button>
        </div>
      </div>
    </div>
  );
}
