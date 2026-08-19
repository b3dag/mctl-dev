/**
 * Whitelist, operators and bans. The whitelist always writes its file and
 * reloads a running server live; ops and bans only ever apply over RCON,
 * since vanilla has no reload command for those.
 */
import { api, server, ok, section, waitReady, phaseOf, waitFor } from './helpers.mjs';

const listsOf = async (id) => (await api('GET', `/api/servers/${id}/players/lists`)).body;

export default async function listsTests() {
  const s = await server('test');

  section('with the server running, the whitelist writes the file and reloads live');
  if ((await phaseOf(s.id)) !== 'ready') {
    await api('POST', `/api/servers/${s.id}/start`);
    ok(await waitReady(s.id), 'server started');
  }

  let r = await api('POST', `/api/servers/${s.id}/whitelist`, { player: 'Notch' });
  ok(r.status === 200 && r.body.via === 'file', 'whitelist add reports via: file', r.body.via || r.body.error);
  ok(/reload/i.test(r.body.output || ''), 'and says it reloaded live rather than needing a restart', r.body.output);

  let lists = await listsOf(s.id);
  const notch = lists.whitelist.find((p) => p.name === 'Notch');
  ok(!!notch, 'the player is on the list');
  ok(notch?.uuid?.length === 36, 'with a UUID resolved by mctl itself', notch?.uuid);

  section('operators and bans apply live over RCON');
  r = await api('POST', `/api/servers/${s.id}/ops`, { player: 'Notch' });
  ok(r.status === 200 && r.body.via === 'rcon', 'op add used RCON', r.body.via || r.body.error);
  ok((await listsOf(s.id)).ops.some((p) => p.name === 'Notch'), 'and the server actually opped them');

  r = await api('DELETE', `/api/servers/${s.id}/ops/Notch`);
  ok(r.status === 200 && r.body.via === 'rcon', 'and deop the same way');
  ok(!(await listsOf(s.id)).ops.some((p) => p.name === 'Notch'), 'leaving no operators behind');

  r = await api('POST', `/api/servers/${s.id}/bans`, { player: 'Herobrine', reason: 'not real' });
  ok(r.status === 200, 'ban accepted');
  lists = await listsOf(s.id);
  ok(
    lists.bannedPlayers.some((p) => p.name === 'Herobrine' && p.reason === 'not real'),
    'the ban records its reason'
  );

  section('enforcement toggles live, no restart needed');
  const before = (await listsOf(s.id)).whitelistEnabled;
  r = await api('PUT', `/api/servers/${s.id}/whitelist/enabled`, { enabled: !before });
  ok(/applied live/i.test(r.body.output || ''), 'reports it applied live', r.body.output);
  ok((await listsOf(s.id)).whitelistEnabled === !before, 'toggled', `${before} to ${!before}`);
  await api('PUT', `/api/servers/${s.id}/whitelist/enabled`, { enabled: before });
  ok((await listsOf(s.id)).whitelistEnabled === before, 'and toggled back');

  section('bad input is refused rather than written');
  r = await api('POST', `/api/servers/${s.id}/whitelist`, { player: 'not a name!' });
  ok(r.status === 400, 'an invalid name is rejected', r.body.error);
  r = await api('POST', `/api/servers/${s.id}/ban-ips`, { ip: 'nope' });
  ok(r.status === 400, 'an invalid address is rejected', r.body.error);

  section('cleanup leaves the lists as they were');
  await api('DELETE', `/api/servers/${s.id}/whitelist/Notch`);
  await api('DELETE', `/api/servers/${s.id}/bans/Herobrine`);
  lists = await listsOf(s.id);
  ok(!lists.whitelist.some((p) => p.name === 'Notch'), 'removal worked');
  ok(!lists.bannedPlayers.some((p) => p.name === 'Herobrine'), 'pardon worked');

  section('ops and bans refuse once the server is stopped, there is no file to fall back to');
  await api('POST', `/api/servers/${s.id}/stop`);
  ok(await waitFor(async () => (await phaseOf(s.id)) === 'stopped', 120), 'server stopped');

  r = await api('POST', `/api/servers/${s.id}/ops`, { player: 'Alex' });
  ok(r.status === 409, 'op add on a stopped server is refused', r.body.error);
  r = await api('POST', `/api/servers/${s.id}/bans`, { player: 'Alex' });
  ok(r.status === 409, 'so is a ban', r.body.error);

  section('the whitelist still works while stopped, it only takes effect on the next start');
  const stopped = await listsOf(s.id);
  ok(stopped.live === false, 'the lists report it as not live');
  ok(Array.isArray(stopped.whitelist), 'and are still readable while stopped');

  r = await api('POST', `/api/servers/${s.id}/whitelist`, { player: 'Alex' });
  ok(r.status === 200 && r.body.via === 'file', 'whitelist add still writes the file', r.body.via || r.body.error);
  ok(/next time|next start/i.test(r.body.output || ''), 'and says it takes effect on the next start', r.body.output);
  ok((await listsOf(s.id)).whitelist.some((p) => p.name === 'Alex'), 'and the entry is there');

  r = await api('DELETE', `/api/servers/${s.id}/whitelist/Alex`);
  ok(r.status === 200, 'and can be removed again while stopped');
  ok(!(await listsOf(s.id)).whitelist.some((p) => p.name === 'Alex'), 'leaving the list clean');
}
