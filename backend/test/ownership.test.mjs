/**
 * The manager runs as root and the image runs as uid 1000, so anything written
 * into a data volume has to carry the container's ownership. A root-owned file
 * is unwritable by the server and only surfaces on its next boot.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { api, server, ok, section, waitReady, waitFor, phaseOf } from './helpers.mjs';

const run = promisify(execFile);

async function stat(volume, path) {
  const { stdout } = await run('docker', [
    'run', '--rm', '-v', `${volume}:/d`, 'alpine:3.20', 'stat', '-c', '%u:%g', `/d/${path}`,
  ]);
  return stdout.trim();
}

export default async function ownershipTests() {
  const s = await server('test');
  const volume = `mctl-${s.slug}-data`;

  section('files mctl writes carry the container user');
  await api('POST', `/api/servers/${s.id}/stop`);
  ok(await waitFor(async () => (await phaseOf(s.id)) === 'stopped', 120), 'server stopped');

  await api('PUT', `/api/servers/${s.id}/files/write`, {
    path: 'ownership-probe.txt',
    content: 'written by the test',
  });
  ok((await stat(volume, 'ownership-probe.txt')) === '1000:1000', 'an edited file is not root-owned');

  section('a root-owned file left by an older version is repaired on start');
  await run('docker', [
    'run', '--rm', '-v', `${volume}:/d`, 'alpine:3.20', 'sh', '-c',
    'echo legacy > /d/legacy-root.json && chown 0:0 /d/legacy-root.json',
  ]);
  ok((await stat(volume, 'legacy-root.json')) === '0:0', 'planted as root');

  await api('POST', `/api/servers/${s.id}/start`);
  ok(await waitReady(s.id), 'server started');
  ok((await stat(volume, 'legacy-root.json')) === '1000:1000', 'and the file was handed back');

  section('the boot itself is clean');
  const { stdout, stderr } = await run('docker', ['logs', '--since', '10m', `mc-${s.slug}`], {
    maxBuffer: 32 * 1024 * 1024,
  });
  const thisBoot = (stdout + stderr).split('Starting the Minecraft server').pop();
  ok(!thisBoot.includes('Permission denied'), 'no permission errors during startup');

  await api('DELETE', `/api/servers/${s.id}/files?path=ownership-probe.txt`);
  await api('DELETE', `/api/servers/${s.id}/files?path=legacy-root.json`);
}
