import path from 'node:path';
import { modDirFor } from './envcatalog.js';
import { httpError } from './servers.js';
import { runHelper, writeFileToContainer, volumeOwner } from './docker.js';
import { listDir, safePath } from './files.js';

const UA = 'mctl/0.1 (self-hosted minecraft manager)';
const MODRINTH = 'https://api.modrinth.com/v2';

const LOADER_OF = {
  FABRIC: 'fabric',
  FORGE: 'forge',
  NEOFORGE: 'neoforge',
  QUILT: 'quilt',
  PAPER: 'paper',
  SPIGOT: 'spigot',
  PURPUR: 'purpur',
};

export function modContext(server) {
  const dir = modDirFor(server.type);
  if (!dir) throw httpError(400, `${server.type} servers do not support mods or plugins`);
  return { dir, loader: LOADER_OF[server.type] || null };
}

export async function listMods(server) {
  const { dir, loader } = modContext(server);
  let entries = [];
  try {
    entries = (await listDir(server, dir)).entries;
  } catch (e) {
    if (e.status !== 404) throw e;
  }
  const mods = entries
    .filter((e) => !e.dir && /\.jar(\.disabled)?$/i.test(e.name))
    .map((e) => ({
      name: e.name.replace(/\.disabled$/i, ''),
      file: e.name,
      path: e.path,
      size: e.size,
      mtime: e.mtime,
      enabled: !/\.disabled$/i.test(e.name),
    }));
  return { dir, loader, mods };
}

async function ensureDir(server, dir) {
  await runHelper(server.volume_name, `mkdir -p '/data/${dir}'`);
}

function safeJarName(name) {
  const base = path.posix.basename(String(name)).replace(/[^\w.\- ]+/g, '_');
  if (!/\.jar$/i.test(base)) throw httpError(400, 'only .jar files are accepted');
  return base;
}

export async function installFromBuffer(server, filename, buffer) {
  const { dir } = modContext(server);
  const base = safeJarName(filename);
  await ensureDir(server, dir);
  await writeFileToContainer(
    server.container_name,
    safePath(path.posix.join(dir, base)),
    buffer,
    await volumeOwner(server.volume_name)
  );
  return { file: base, size: buffer.length, dir };
}

export async function installFromUrl(server, url, filename) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw httpError(400, 'invalid URL');
  }
  if (parsed.protocol !== 'https:') throw httpError(400, 'only https:// downloads are allowed');

  const res = await fetch(parsed, { headers: { 'user-agent': UA }, redirect: 'follow' });
  if (!res.ok) throw httpError(502, `download failed: ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > 256 * 1024 * 1024) throw httpError(413, 'file too large');
  const name = filename || path.posix.basename(parsed.pathname) || 'mod.jar';
  return installFromBuffer(server, name, buf);
}

export async function setEnabled(server, file, enabled) {
  const { dir } = modContext(server);
  const base = path.posix.basename(String(file));
  const from = safePath(path.posix.join(dir, base));
  const target = enabled ? base.replace(/\.disabled$/i, '') : `${base.replace(/\.disabled$/i, '')}.disabled`;
  if (target === base) return { file: base, enabled };
  const to = safePath(path.posix.join(dir, target));
  const q = (s) => `'${s.replace(/'/g, `'\\''`)}'`;
  const { code, output } = await runHelper(server.volume_name, `mv ${q(from)} ${q(to)} && echo OK`);
  if (code !== 0) throw httpError(500, output.trim() || 'rename failed');
  return { file: target, enabled };
}

export async function removeMod(server, file) {
  const { dir } = modContext(server);
  const base = path.posix.basename(String(file));
  const full = safePath(path.posix.join(dir, base));
  const q = (s) => `'${s.replace(/'/g, `'\\''`)}'`;
  await runHelper(server.volume_name, `rm -f ${q(full)}`);
  return { removed: base };
}

// --- Modrinth ---------------------------------------------------------------

export async function searchModrinth(server, query, { limit = 20, offset = 0 } = {}) {
  const { loader } = modContext(server);
  const projectType = ['paper', 'spigot', 'purpur'].includes(loader) ? 'plugin' : 'mod';
  const facets = [[`project_type:${projectType}`]];
  if (loader) facets.push([`categories:${loader}`]);
  if (server.version && server.version !== 'LATEST') facets.push([`versions:${server.version}`]);

  const url = new URL(`${MODRINTH}/search`);
  url.searchParams.set('query', query || '');
  url.searchParams.set('limit', String(Math.min(50, limit)));
  url.searchParams.set('offset', String(offset));
  url.searchParams.set('facets', JSON.stringify(facets));

  const res = await fetch(url, { headers: { 'user-agent': UA } });
  if (!res.ok) throw httpError(502, `Modrinth search failed: ${res.status}`);
  const data = await res.json();
  return {
    total: data.total_hits,
    hits: data.hits.map((h) => ({
      id: h.project_id,
      slug: h.slug,
      title: h.title,
      description: h.description,
      downloads: h.downloads,
      icon: h.icon_url,
      versions: h.versions,
      author: h.author,
    })),
  };
}

export async function modrinthVersions(server, projectId) {
  const { loader } = modContext(server);
  const url = new URL(`${MODRINTH}/project/${encodeURIComponent(projectId)}/version`);
  if (loader) url.searchParams.set('loaders', JSON.stringify([loader]));
  if (server.version && server.version !== 'LATEST')
    url.searchParams.set('game_versions', JSON.stringify([server.version]));

  const res = await fetch(url, { headers: { 'user-agent': UA } });
  if (!res.ok) throw httpError(502, `Modrinth version lookup failed: ${res.status}`);
  const data = await res.json();
  return data.map((v) => ({
    id: v.id,
    name: v.name,
    versionNumber: v.version_number,
    gameVersions: v.game_versions,
    loaders: v.loaders,
    datePublished: v.date_published,
    file: v.files.find((f) => f.primary) || v.files[0],
  }));
}

export async function installFromModrinth(server, { projectId, versionId }) {
  let file;
  if (versionId) {
    const res = await fetch(`${MODRINTH}/version/${encodeURIComponent(versionId)}`, {
      headers: { 'user-agent': UA },
    });
    if (!res.ok) throw httpError(502, `Modrinth version fetch failed: ${res.status}`);
    const v = await res.json();
    file = v.files.find((f) => f.primary) || v.files[0];
  } else {
    const versions = await modrinthVersions(server, projectId);
    if (!versions.length) throw httpError(404, 'no compatible version found for this server');
    file = versions[0].file;
  }
  if (!file?.url) throw httpError(404, 'no downloadable file on that version');
  return installFromUrl(server, file.url, file.filename);
}
