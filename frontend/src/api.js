async function request(method, url, body, opts = {}) {
  const res = await fetch(url, {
    method,
    headers: body && !(body instanceof FormData) ? { 'content-type': 'application/json' } : undefined,
    body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined,
    credentials: 'include',
    ...opts,
  });
  if (res.status === 401) {
    throw new Error('Not authenticated — Cloudflare Access did not pass an identity header.');
  }
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(data?.error || `${res.status} ${res.statusText}`);
  return data;
}

const q = (params) => {
  const s = new URLSearchParams(
    Object.entries(params || {}).filter(([, v]) => v !== undefined && v !== null)
  ).toString();
  return s ? `?${s}` : '';
};

export const api = {
  me: () => request('GET', '/api/me'),
  health: () => request('GET', '/api/health'),
  meta: () => request('GET', '/api/servers/meta'),
  routerInfo: () => request('GET', '/api/router'),
  routerSync: () => request('POST', '/api/router/sync'),

  listServers: () => request('GET', '/api/servers'),
  getServer: (id) => request('GET', `/api/servers/${id}`),
  createServer: (body) => request('POST', '/api/servers', body),
  updateServer: (id, body) => request('PATCH', `/api/servers/${id}`, body),
  deleteServer: (id, slug, keepData) =>
    request('DELETE', `/api/servers/${id}${q({ confirm: slug, keepData: keepData ? 'true' : undefined })}`),

  start: (id) => request('POST', `/api/servers/${id}/start`),
  stop: (id) => request('POST', `/api/servers/${id}/stop`),
  restart: (id) => request('POST', `/api/servers/${id}/restart`),
  recreate: (id) => request('POST', `/api/servers/${id}/recreate`),

  rcon: (id, command) => request('POST', `/api/servers/${id}/rcon`, { command }),
  players: (id) => request('GET', `/api/servers/${id}/players`),
  playerAction: (id, action, body) => request('POST', `/api/servers/${id}/players/${action}`, body),
  banIp: (id, ip, reason) => request('POST', `/api/servers/${id}/ban-ip`, { ip, reason }),
  stats: (id, disk) => request('GET', `/api/servers/${id}/stats${q({ disk: disk ? 'true' : undefined })}`),

  files: (id, path) => request('GET', `/api/servers/${id}/files${q({ path })}`),
  readFile: (id, path) => request('GET', `/api/servers/${id}/files/read${q({ path })}`),
  writeFile: (id, path, content) => request('PUT', `/api/servers/${id}/files/write`, { path, content }),
  deleteFile: (id, path) => request('DELETE', `/api/servers/${id}/files${q({ path })}`),
  mkdir: (id, path) => request('POST', `/api/servers/${id}/files/mkdir`, { path }),
  renameFile: (id, from, to) => request('POST', `/api/servers/${id}/files/rename`, { from, to }),
  uploadFiles: (id, path, formData) =>
    request('POST', `/api/servers/${id}/files/upload${q({ path })}`, formData),
  downloadUrl: (id, path, zip) => `/api/servers/${id}/files/download${q({ path, zip: zip ? 'true' : undefined })}`,

  backups: (id) => request('GET', `/api/servers/${id}/backups`),
  createBackup: (id, scope, note) => request('POST', `/api/servers/${id}/backups`, { scope, note }),
  deleteBackup: (id, bid) => request('DELETE', `/api/servers/${id}/backups/${bid}`),
  restoreBackup: (id, bid, slug) =>
    request('POST', `/api/servers/${id}/backups/${bid}/restore${q({ confirm: slug })}`),
  setBackupSchedule: (id, body) => request('PUT', `/api/servers/${id}/backups/schedule`, body),
  backupUrl: (id, bid, format) => `/api/servers/${id}/backups/${bid}/download${q({ format })}`,

  mods: (id) => request('GET', `/api/servers/${id}/mods`),
  searchMods: (id, query) => request('GET', `/api/servers/${id}/mods/search${q({ q: query })}`),
  installMod: (id, body) => request('POST', `/api/servers/${id}/mods/install`, body),
  uploadMods: (id, formData) => request('POST', `/api/servers/${id}/mods/upload`, formData),
  toggleMod: (id, file, enabled) => request('POST', `/api/servers/${id}/mods/toggle`, { file, enabled }),
  removeMod: (id, file) => request('DELETE', `/api/servers/${id}/mods${q({ file })}`),
};

export function wsUrl(path) {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}${path}`;
}
