/**
 * The window that matters: a server whose container is up but whose RCON has
 * not answered yet has already read whitelist.json and will write its own copy
 * back. A whitelist write during that window must wait for the boot to settle
 * rather than land underneath it and get silently lost.
 */
import { api, server, waitFor, ok, section, phaseOf } from './helpers.mjs';

export default async function raceTests() {
  const s = await server('test');

  section('a whitelist write during the starting window must wait, not race the boot');

  await api('POST', `/api/servers/${s.id}/stop`);
  await waitFor(() => phaseOf(s.id).then((p) => p === 'stopped'), 90);

  // Start it and immediately try to write, which lands mid-boot.
  await api('POST', `/api/servers/${s.id}/start`);
  await waitFor(() => phaseOf(s.id).then((p) => p === 'starting'), 30);
  ok((await phaseOf(s.id)) === 'starting', 'server is mid-boot');

  const started = Date.now();
  const { status, body } = await api('POST', `/api/servers/${s.id}/whitelist`, { player: 'Notch' });
  const waited = Math.round((Date.now() - started) / 1000);

  ok(
    status !== 200 || waited >= 1,
    'the write waited for the boot to settle rather than firing instantly',
    `status=${status} waited=${waited}s`
  );

  if (status === 200) {
    // Whichever way it landed once settled, the change has to be there.
    const lists = (await api('GET', `/api/servers/${s.id}/players/lists`)).body;
    ok(
      lists.whitelist.some((p) => p.name === 'Notch'),
      'and the change survived, rather than being overwritten by the server',
      lists.whitelist.map((p) => p.name).join(', ')
    );
    await api('DELETE', `/api/servers/${s.id}/whitelist/Notch`);
  } else {
    ok(status === 409, 'or it refused honestly instead of guessing', `status=${status} ${body?.error}`);
  }

  section('operators and bans wait out the same window rather than erroring immediately');
  await api('POST', `/api/servers/${s.id}/stop`);
  await waitFor(() => phaseOf(s.id).then((p) => p === 'stopped'), 120);
  await api('POST', `/api/servers/${s.id}/start`);
  await waitFor(() => phaseOf(s.id).then((p) => p === 'starting'), 30);

  const opResult = await api('POST', `/api/servers/${s.id}/ops`, { player: 'Notch' });
  ok(
    opResult.status === 200 || opResult.status === 409,
    'op add either waited for RCON and succeeded, or refused honestly',
    `status=${opResult.status} ${opResult.body?.via || opResult.body?.error}`
  );
  if (opResult.status === 200) await api('DELETE', `/api/servers/${s.id}/ops/Notch`);

  section('a whitelist write to a stopped server still goes to the file');
  await api('POST', `/api/servers/${s.id}/stop`);
  await waitFor(() => phaseOf(s.id).then((p) => p === 'stopped'), 120);
  const stopped = await api('POST', `/api/servers/${s.id}/whitelist`, { player: 'Notch' });
  ok(stopped.status === 200 && stopped.body.via === 'file', 'stopped writes take the file path', stopped.body.via || stopped.body.error);
  const stoppedOp = await api('POST', `/api/servers/${s.id}/ops`, { player: 'Alex' });
  ok(stoppedOp.status === 409, 'while an op add on a stopped server is refused, there is no file fallback', stoppedOp.body.error);
  await api('DELETE', `/api/servers/${s.id}/whitelist/Notch`);
}
