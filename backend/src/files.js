import path from 'node:path';
import tar from 'tar-stream';
import archiver from 'archiver';
import {
  runHelper,
  readFileFromContainer,
  writeFileToContainer,
  getArchiveStream,
  putArchiveStream,
} from './docker.js';
import { httpError } from './servers.js';

const ROOT = '/data';

/** Resolve a user-supplied path inside /data, refusing anything that escapes. */
export function safePath(rel = '') {
  const clean = path.posix.normalize('/' + String(rel).replace(/\\/g, '/')).replace(/\/+$/, '');
  const full = path.posix.join(ROOT, clean);
  if (full !== ROOT && !full.startsWith(ROOT + '/')) throw httpError(400, 'path escapes /data');
  return full;
}

const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

const TEXT_EXT = new Set([
  '.properties', '.json', '.yml', '.yaml', '.txt', '.md', '.conf', '.cfg',
  '.toml', '.log', '.sh', '.ini', '.xml', '.mcmeta', '.env',
]);
const MAX_EDIT_BYTES = 2 * 1024 * 1024;

export const isTextFile = (name) =>
  TEXT_EXT.has(path.posix.extname(String(name).toLowerCase())) || !path.posix.extname(name);

export async function listDir(server, rel = '') {
  const dir = safePath(rel);
  const script =
    `[ -d ${shq(dir)} ] || { echo "__NODIR__"; exit 0; }; ` +
    `cd ${shq(dir)} && find . -mindepth 1 -maxdepth 1 -exec stat -c '%F|%s|%Y|%n' {} + 2>/dev/null`;
  const { output } = await runHelper(server.volume_name, script);
  if (output.includes('__NODIR__')) throw httpError(404, `no such directory: ${rel || '/'}`);

  const entries = [];
  for (const line of output.split('\n')) {
    const t = line.trim();
    if (!t || !t.includes('|')) continue;
    const [kind, size, mtime, ...nameParts] = t.split('|');
    const name = nameParts.join('|').replace(/^\.\//, '');
    if (!name || name === '.') continue;
    entries.push({
      name,
      path: path.posix.join(rel || '', name),
      dir: kind.includes('directory'),
      size: Number(size) || 0,
      mtime: Number(mtime) * 1000 || null,
      editable: !kind.includes('directory') && Number(size) <= MAX_EDIT_BYTES && isTextFile(name),
    });
  }
  entries.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));
  return { path: rel || '', entries };
}

export async function readFile(server, rel) {
  const full = safePath(rel);
  if (full === ROOT) throw httpError(400, 'that is a directory');
  return readFileFromContainer(server.container_name, full);
}

export async function readText(server, rel) {
  const buf = await readFile(server, rel);
  if (buf.length > MAX_EDIT_BYTES) throw httpError(413, 'file too large to edit in the browser');
  return buf.toString('utf8');
}

export async function writeText(server, rel, content) {
  const full = safePath(rel);
  await writeFileToContainer(server.container_name, full, Buffer.from(String(content), 'utf8'));
}

export async function uploadFile(server, relDir, filename, buffer) {
  const base = path.posix.basename(String(filename));
  if (!base || base === '.' || base === '..') throw httpError(400, 'bad filename');
  const full = safePath(path.posix.join(relDir || '', base));
  await writeFileToContainer(server.container_name, full, buffer);
  return { path: full.slice(ROOT.length + 1), size: buffer.length };
}

export async function remove(server, rel) {
  const full = safePath(rel);
  if (full === ROOT) throw httpError(400, 'refusing to delete /data');
  const { code, output } = await runHelper(server.volume_name, `rm -rf ${shq(full)} && echo OK`);
  if (code !== 0) throw httpError(500, output.trim() || 'delete failed');
}

export async function mkdir(server, rel) {
  const full = safePath(rel);
  const { code, output } = await runHelper(server.volume_name, `mkdir -p ${shq(full)} && echo OK`);
  if (code !== 0) throw httpError(500, output.trim() || 'mkdir failed');
}

export async function rename(server, from, to) {
  const a = safePath(from);
  const b = safePath(to);
  if (a === ROOT || b === ROOT) throw httpError(400, 'bad rename target');
  const { code, output } = await runHelper(
    server.volume_name,
    `mkdir -p "$(dirname ${shq(b)})" && mv ${shq(a)} ${shq(b)} && echo OK`
  );
  if (code !== 0) throw httpError(500, output.trim() || 'rename failed');
}

/** Stream a directory (or file) out as a zip - used for world downloads. */
export async function zipStream(server, rel, res) {
  const full = safePath(rel);
  const source = await getArchiveStream(server.container_name, full);
  const zip = archiver('zip', { zlib: { level: 6 } });
  zip.pipe(res);
  await pipeTarIntoZip(source, zip);
  await zip.finalize();
}

export function pipeTarIntoZip(tarStream, zip, stripFirstSegment = false) {
  return new Promise((resolve, reject) => {
    const extract = tar.extract();
    extract.on('entry', (header, stream, next) => {
      if (header.type === 'file') {
        let name = header.name;
        if (stripFirstSegment) name = name.split('/').slice(1).join('/');
        if (name) zip.append(stream, { name, date: header.mtime });
        else stream.resume();
        stream.on('end', next);
      } else {
        stream.on('end', next);
        stream.resume();
      }
    });
    extract.on('finish', resolve);
    extract.on('error', reject);
    tarStream.on('error', reject);
    tarStream.pipe(extract);
  });
}

export async function putTar(server, relDir, stream) {
  const full = safePath(relDir || '');
  await putArchiveStream(server.container_name, full, stream);
}

export const WELL_KNOWN = [
  'server.properties',
  'whitelist.json',
  'ops.json',
  'banned-players.json',
  'banned-ips.json',
  'bukkit.yml',
  'spigot.yml',
  'paper-global.yml',
];
