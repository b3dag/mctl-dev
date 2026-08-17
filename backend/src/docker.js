import Docker from 'dockerode';
import tar from 'tar-stream';
import { PassThrough } from 'node:stream';
import { config } from './config.js';

export const docker = new Docker({ socketPath: '/var/run/docker.sock' });

export async function ping() {
  await docker.ping();
}

/** Make sure the internal network exists (compose normally creates it). */
export async function ensureNetwork() {
  const nets = await docker.listNetworks({ filters: { name: [config.network] } });
  if (nets.some((n) => n.Name === config.network)) return;
  await docker.createNetwork({ Name: config.network, Driver: 'bridge' });
}

export async function ensureImage(image, onProgress) {
  const tag = image.includes(':') ? image : `${image}:latest`;
  const local = await docker.listImages({ filters: { reference: [tag] } });
  if (local.length) return;
  await new Promise((resolve, reject) => {
    docker.pull(tag, (err, stream) => {
      if (err) return reject(err);
      docker.modem.followProgress(
        stream,
        (e) => (e ? reject(e) : resolve()),
        (ev) => onProgress?.(ev)
      );
    });
  });
}

export function containerOf(name) {
  return docker.getContainer(name);
}

export async function inspectSafe(name) {
  try {
    return await docker.getContainer(name).inspect();
  } catch (e) {
    if (e.statusCode === 404) return null;
    throw e;
  }
}

export async function containerState(name) {
  const info = await inspectSafe(name);
  if (!info) return { exists: false, state: 'missing', running: false };
  return {
    exists: true,
    state: info.State.Status, // created|running|paused|restarting|removing|exited|dead
    running: info.State.Running,
    startedAt: info.State.StartedAt,
    health: info.State.Health?.Status || null,
    id: info.Id,
  };
}

export async function ensureVolume(name, labels = {}) {
  try {
    await docker.getVolume(name).inspect();
  } catch (e) {
    if (e.statusCode !== 404) throw e;
    await docker.createVolume({ Name: name, Labels: labels });
  }
}

export async function removeVolume(name) {
  try {
    await docker.getVolume(name).remove({ force: true });
  } catch (e) {
    if (e.statusCode !== 404) throw e;
  }
}

/**
 * Run a throwaway container with the server's data volume mounted at /data.
 * Works whether or not the Minecraft container is running, which is why file
 * listings and disk usage go through here instead of `exec`.
 */
export async function runHelper(volumeName, script, { timeoutMs = 60000 } = {}) {
  await ensureImage(config.helperImage);
  const c = await docker.createContainer({
    Image: config.helperImage,
    Cmd: ['sh', '-c', script],
    Tty: true, // raw (non-multiplexed) log stream
    WorkingDir: '/data',
    Labels: { 'mctl.helper': 'true' },
    HostConfig: {
      Binds: [`${volumeName}:/data`],
      AutoRemove: false,
      NetworkMode: 'none',
    },
  });
  try {
    await c.start();
    const timer = setTimeout(() => c.kill().catch(() => {}), timeoutMs);
    const res = await c.wait();
    clearTimeout(timer);
    return { code: res.StatusCode, output: await collectLogs(c) };
  } finally {
    await c.remove({ force: true }).catch(() => {});
  }
}

/**
 * Read a finished container's output. `follow: true` is deliberate even though
 * the container has already exited: it makes dockerode always hand back a
 * stream, whereas the non-following form returns a Buffer, a string or a
 * wrapped body depending on the dockerode/Docker API version.
 */
async function collectLogs(container) {
  const out = await container.logs({ stdout: true, stderr: true, follow: true });
  if (Buffer.isBuffer(out)) return out.toString('utf8');
  if (typeof out === 'string') return out;
  if (typeof out?.on !== 'function') return String(out ?? '');
  return new Promise((resolve, reject) => {
    const chunks = [];
    out.on('data', (d) => chunks.push(d));
    out.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    out.on('error', reject);
  });
}

/** Read a single file out of a container path as a Buffer. */
export async function readFileFromContainer(containerName, filePath) {
  const stream = await docker.getContainer(containerName).getArchive({ path: filePath });
  return await new Promise((resolve, reject) => {
    const extract = tar.extract();
    let found = null;
    extract.on('entry', (header, s, next) => {
      if (header.type === 'file' && found === null) {
        const chunks = [];
        s.on('data', (d) => chunks.push(d));
        s.on('end', () => {
          found = Buffer.concat(chunks);
          next();
        });
        s.resume();
      } else {
        s.on('end', next);
        s.resume();
      }
    });
    extract.on('finish', () => (found ? resolve(found) : reject(new Error('not a file'))));
    extract.on('error', reject);
    stream.pipe(extract);
  });
}

/** Write a Buffer to a container path (works on stopped containers too). */
export async function writeFileToContainer(containerName, filePath, buffer, mode = 0o644) {
  const dir = filePath.replace(/\/[^/]*$/, '') || '/';
  const base = filePath.split('/').pop();
  const pack = tar.pack();
  pack.entry({ name: base, mode, size: buffer.length }, buffer);
  pack.finalize();
  await docker.getContainer(containerName).putArchive(pack, { path: dir });
}

/** Raw tar stream of a container path - used for backups and folder downloads. */
export async function getArchiveStream(containerName, dirPath) {
  return docker.getContainer(containerName).getArchive({ path: dirPath });
}

/** Push a tar stream into a container path - used for restores and uploads. */
export async function putArchiveStream(containerName, dirPath, stream) {
  await docker.getContainer(containerName).putArchive(stream, { path: dirPath });
}

/** Follow container logs; returns the (already demuxed) stream. */
export async function followLogs(containerName, { tail = 300 } = {}) {
  const container = docker.getContainer(containerName);
  const info = await container.inspect();
  const stream = await container.logs({
    follow: true,
    stdout: true,
    stderr: true,
    tail,
    timestamps: false,
  });
  if (info.Config.Tty) return stream;
  const out = new PassThrough();
  docker.modem.demuxStream(stream, out, out);
  stream.on('end', () => out.end());
  stream.on('error', (e) => out.destroy(e));
  out.on('close', () => stream.destroy?.());
  return out;
}

/** One-shot resource sample for a container. */
export async function sampleStats(containerName) {
  const s = await docker.getContainer(containerName).stats({ stream: false });
  const cpuDelta = s.cpu_stats.cpu_usage.total_usage - (s.precpu_stats.cpu_usage?.total_usage || 0);
  const sysDelta = s.cpu_stats.system_cpu_usage - (s.precpu_stats.system_cpu_usage || 0);
  const cores = s.cpu_stats.online_cpus || s.cpu_stats.cpu_usage.percpu_usage?.length || 1;
  const cpuPercent = sysDelta > 0 && cpuDelta > 0 ? (cpuDelta / sysDelta) * cores * 100 : 0;
  const cache = s.memory_stats.stats?.inactive_file ?? s.memory_stats.stats?.cache ?? 0;
  const memUsed = Math.max(0, (s.memory_stats.usage || 0) - cache);
  return {
    at: Date.now(),
    cpuPercent: Number(cpuPercent.toFixed(2)),
    memUsed,
    memLimit: s.memory_stats.limit || 0,
    netRx: Object.values(s.networks || {}).reduce((a, n) => a + n.rx_bytes, 0),
    netTx: Object.values(s.networks || {}).reduce((a, n) => a + n.tx_bytes, 0),
  };
}
