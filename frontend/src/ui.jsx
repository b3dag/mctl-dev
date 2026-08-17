import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';

const ToastCtx = createContext(() => {});
export const useToast = () => useContext(ToastCtx);

export function ToastProvider({ children }) {
  const [toast, setToast] = useState(null);
  const push = useCallback((message, kind = 'info') => {
    setToast({ message: String(message), kind, key: Date.now() });
  }, []);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), toast.kind === 'error' ? 6000 : 3000);
    return () => clearTimeout(t);
  }, [toast]);

  return (
    <ToastCtx.Provider value={push}>
      {children}
      {toast && <div className={`toast ${toast.kind}`}>{toast.message}</div>}
    </ToastCtx.Provider>
  );
}

/** Wrap an async handler so failures surface as a toast instead of a dead click. */
export function useAsync() {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const run = useCallback(
    async (fn, successMessage) => {
      setBusy(true);
      try {
        const out = await fn();
        if (successMessage) toast(successMessage);
        return out;
      } catch (e) {
        toast(e.message, 'error');
        return null;
      } finally {
        setBusy(false);
      }
    },
    [toast]
  );
  return { busy, run };
}

export function Modal({ title, children, onClose, actions }) {
  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <div className="row between" style={{ marginBottom: 12 }}>
          <strong>{title}</strong>
          <button className="ghost sm" onClick={onClose}>✕</button>
        </div>
        {children}
        {actions && <div className="row wrap" style={{ marginTop: 16, justifyContent: 'flex-end' }}>{actions}</div>}
      </div>
    </div>
  );
}

export function StatusDot({ state }) {
  const phase = state?.phase || 'stopped';
  return <span className={`dot ${phase}`} title={phase} />;
}

export const PHASE_LABEL = {
  ready: 'Running',
  starting: 'Starting',
  stopping: 'Stopping',
  stopped: 'Stopped',
  unhealthy: 'No RCON',
  missing: 'No container',
  unknown: '-',
};

export function StatusPill({ state }) {
  const phase = state?.phase || 'stopped';
  return (
    <span className="pill">
      <StatusDot state={state} />
      {PHASE_LABEL[phase] || phase}
      {phase === 'ready' && state?.online !== undefined && (
        <span className="muted"> {state.online}{state.max ? `/${state.max}` : ''}</span>
      )}
    </span>
  );
}

export function bytes(n) {
  if (n === null || n === undefined) return '-';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = Number(n);
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v < 10 && i > 0 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

export function when(iso) {
  if (!iso) return '-';
  const d = new Date(iso);
  const diff = (Date.now() - d.getTime()) / 1000;
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return d.toLocaleDateString();
}

export function Confirm({ title, message, confirmWord, onConfirm, onClose, danger = true }) {
  const [typed, setTyped] = useState('');
  const ok = !confirmWord || typed === confirmWord;
  return (
    <Modal
      title={title}
      onClose={onClose}
      actions={
        <>
          <button onClick={onClose}>Cancel</button>
          <button className={danger ? 'danger' : 'primary'} disabled={!ok} onClick={() => onConfirm()}>
            Confirm
          </button>
        </>
      }
    >
      <p className="small">{message}</p>
      {confirmWord && (
        <div className="field">
          <label>Type <code>{confirmWord}</code> to confirm</label>
          <input value={typed} onChange={(e) => setTyped(e.target.value)} autoFocus />
        </div>
      )}
    </Modal>
  );
}
