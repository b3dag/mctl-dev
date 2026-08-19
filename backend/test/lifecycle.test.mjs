/** Start, stop and the guards around them. */
import { api, server, ok, section, waitReady, waitFor, phaseOf } from './helpers.mjs';

const auditCount = async (q) => (await api('GET', `/api/audit?q=${encodeURIComponent(q)}`)).body.entries.length;

export default async function lifecycleTests() {
  const s = await server('test');

  section('start');
  if ((await phaseOf(s.id)) !== 'ready') {
    await api('POST', `/api/servers/${s.id}/start`);
  }
  ok(await waitReady(s.id), 'server reaches ready', await phaseOf(s.id));

  section('overlapping stops collapse into one');
  // Two stops used to run two countdowns, which players saw doubled.
  const before = await auditCount('server.stop');
  const [a, b, c] = await Promise.all([
    api('POST', `/api/servers/${s.id}/stop`),
    api('POST', `/api/servers/${s.id}/stop`),
    api('POST', `/api/servers/${s.id}/stop`),
  ]);
  ok([a, b, c].every((r) => r.status === 200), 'all three requests succeed');
  ok((await auditCount('server.stop')) - before === 1, 'but only one stop is performed');
  ok((await phaseOf(s.id)) === 'stopped', 'and the server is stopped');

  section('stop and keep off disarms waking');
  await api('POST', `/api/servers/${s.id}/start`);
  ok(await waitReady(s.id), 'started again');
  await api('POST', `/api/servers/${s.id}/stop`, { keepOff: true });
  let srv = (await api('GET', `/api/servers/${s.id}`)).body.server;
  ok(srv.autostartOnJoin === false, 'wake-on-join is off');
  ok((await phaseOf(s.id)) === 'stopped', 'and it is stopped');

  await api('PATCH', `/api/servers/${s.id}`, { autostart_on_join: true, apply: false });
  srv = (await api('GET', `/api/servers/${s.id}`)).body.server;
  ok(srv.autostartOnJoin === true, 'and can be armed again');

  section('the console refuses commands that would desync state');
  await api('POST', `/api/servers/${s.id}/start`);
  ok(await waitReady(s.id), 'running for the RCON checks');
  const blocked = await api('POST', `/api/servers/${s.id}/rcon`, { command: 'stop' });
  ok(blocked.status === 400, 'stop over RCON is refused', blocked.body.error);
  const allowed = await api('POST', `/api/servers/${s.id}/rcon`, { command: 'list' });
  ok(allowed.status === 200, 'an ordinary command is allowed');

  section('port validation happens before Docker sees it');
  const dup = await api('PATCH', `/api/servers/${s.id}`, { host_port: 80, apply: false });
  ok(dup.status === 400, 'a privileged port is refused', dup.body.error);
  const shared = (await api('GET', '/api/me')).body.publicMcPort;
  const clash = await api('PATCH', `/api/servers/${s.id}`, { host_port: shared, apply: false });
  ok(clash.status === 400, "the router's own port is refused", clash.body.error);
}
