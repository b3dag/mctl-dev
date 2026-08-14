import React, { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { Confirm, Modal, bytes, useAsync, useToast } from '../ui.jsx';

const QUICK = ['server.properties', 'whitelist.json', 'ops.json', 'banned-players.json', 'banned-ips.json'];

export default function Files({ server }) {
  const [path, setPath] = useState('');
  const [listing, setListing] = useState(null);
  const [error, setError] = useState(null);
  const [editing, setEditing] = useState(null); // {path, content, dirty}
  const [confirm, setConfirm] = useState(null);
  const { busy, run } = useAsync();
  const toast = useToast();
  const fileInput = useRef(null);

  const load = useCallback(
    (p = path) => {
      setError(null);
      api
        .files(server.id, p)
        .then((d) => {
          setListing(d);
          setPath(d.path);
        })
        .catch((e) => setError(e.message));
    },
    [server.id, path]
  );

  useEffect(() => {
    load('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [server.id]);

  const open = (entry) => {
    if (entry.dir) return load(entry.path);
    if (!entry.editable) return toast('Not a text file — use download instead');
    run(async () => {
      const { content } = await api.readFile(server.id, entry.path);
      setEditing({ path: entry.path, content, dirty: false });
    });
  };

  const openByName = (name) =>
    run(async () => {
      const { content } = await api.readFile(server.id, name);
      setEditing({ path: name, content, dirty: false });
    });

  const save = () =>
    run(async () => {
      await api.writeFile(server.id, editing.path, editing.content);
      setEditing((e) => ({ ...e, dirty: false }));
    }, 'Saved — restart the server to apply');

  const upload = (files) => {
    if (!files?.length) return;
    const fd = new FormData();
    for (const f of files) fd.append('file', f, f.name);
    run(async () => {
      await api.uploadFiles(server.id, path, fd);
      load();
    }, `Uploaded ${files.length} file(s)`);
  };

  const crumbs = ['', ...path.split('/').filter(Boolean)];

  return (
    <div className="stack">
      <div className="card stack">
        <div className="row wrap small" style={{ gap: 6 }}>
          <span className="muted">quick edit:</span>
          {QUICK.map((f) => (
            <button key={f} className="sm ghost" onClick={() => openByName(f)}>{f}</button>
          ))}
        </div>
      </div>

      <div className="row wrap between">
        <div className="breadcrumb">
          {crumbs.map((c, i) => {
            const target = crumbs.slice(1, i + 1).join('/');
            return (
              <React.Fragment key={i}>
                {i > 0 && <span className="muted">/</span>}
                <button onClick={() => load(target)}>{i === 0 ? '/data' : c}</button>
              </React.Fragment>
            );
          })}
        </div>
        <div className="row" style={{ gap: 8 }}>
          <button className="sm" onClick={() => fileInput.current?.click()} disabled={busy}>Upload</button>
          <button
            className="sm"
            onClick={() => {
              const name = prompt('New folder name');
              if (name) run(async () => { await api.mkdir(server.id, `${path}/${name}`); load(); });
            }}
          >
            New folder
          </button>
          <a href={api.downloadUrl(server.id, path || '.', true)} className="btn sm" download>
            Download zip
          </a>
        </div>
        <input
          ref={fileInput}
          type="file"
          multiple
          style={{ display: 'none' }}
          onChange={(e) => {
            upload(e.target.files);
            e.target.value = '';
          }}
        />
      </div>

      {error && <div className="card badge-error">{error}</div>}

      <div className="card" style={{ padding: 0, overflowX: 'auto' }}>
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th style={{ width: 90 }}>Size</th>
              <th style={{ width: 150 }}>Modified</th>
              <th style={{ width: 190 }}></th>
            </tr>
          </thead>
          <tbody>
            {path && (
              <tr>
                <td colSpan={4}>
                  <button className="ghost sm" onClick={() => load(path.split('/').slice(0, -1).join('/'))}>
                    ‥ up one level
                  </button>
                </td>
              </tr>
            )}
            {(listing?.entries || []).map((e) => (
              <tr key={e.path}>
                <td>
                  <button className="ghost sm" style={{ padding: 0 }} onClick={() => open(e)}>
                    {e.dir ? '📁' : '📄'} {e.name}
                  </button>
                </td>
                <td className="muted small">{e.dir ? '—' : bytes(e.size)}</td>
                <td className="muted small">{e.mtime ? new Date(e.mtime).toLocaleString() : '—'}</td>
                <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                  <a className="btn sm" href={api.downloadUrl(server.id, e.path, e.dir)} download>get</a>{' '}
                  <button
                    className="sm danger"
                    onClick={() => setConfirm({ path: e.path, name: e.name, dir: e.dir })}
                  >
                    del
                  </button>
                </td>
              </tr>
            ))}
            {listing && listing.entries.length === 0 && (
              <tr><td colSpan={4} className="muted small">Empty folder.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {editing && (
        <Modal
          title={editing.path}
          onClose={() => {
            if (editing.dirty && !window.confirm('Discard unsaved changes?')) return;
            setEditing(null);
          }}
          actions={
            <>
              <button onClick={() => setEditing(null)}>Close</button>
              <button className="primary" disabled={busy || !editing.dirty} onClick={save}>Save</button>
            </>
          }
        >
          <textarea
            className="mono"
            value={editing.content}
            spellCheck={false}
            onChange={(e) => setEditing({ ...editing, content: e.target.value, dirty: true })}
          />
        </Modal>
      )}

      {confirm && (
        <Confirm
          title={`Delete ${confirm.name}?`}
          message={confirm.dir ? 'This deletes the folder and everything inside it.' : 'This deletes the file.'}
          onClose={() => setConfirm(null)}
          onConfirm={() =>
            run(async () => {
              await api.deleteFile(server.id, confirm.path);
              setConfirm(null);
              load();
            }, 'Deleted')
          }
        />
      )}
    </div>
  );
}
