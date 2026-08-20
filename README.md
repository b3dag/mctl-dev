# mctl

mctl is a self-hosted web manager for multiple Minecraft servers. It runs each
server as an
[`itzg/docker-minecraft-server`](https://github.com/itzg/docker-minecraft-server)
container behind a single [`itzg/mc-router`](https://github.com/itzg/mc-router)
entry point.

The setup exposes one public game port and one public web UI, authenticated by
Cloudflare Access. Each server gets its own hostname and its own container, and
none of them publish a port directly.

```
                    ┌──────────────────────────────────────────────┐
  players           │  host                                         │
  :25565 ─────────► │  mc-router ──┬─► mc-survival:25565            │
  survival.mc.…     │              ├─► mc-creative:25565            │
  creative.mc.…     │              └─► manager:25566  (waker)       │
                    │                                               │
  browser           │  cloudflared ─► manager:8080 ─► Docker API    │
  mc.example.com    │                              └► RCON :25575   │
                    │                              └► webhook out ─►┼─► Discord etc.
                    └──────────────────────────────────────────────┘
                       internal network - nothing else is published
```

## How it fits together

**mc-router** reads the hostname from the Minecraft handshake and forwards the
connection to the matching backend container. Players connect to
`survival.mc.example.com`, never to a port number, and the host opens only
port 25565.

**Each server** runs as its own container on the internal `mctl-net` network,
with a named data volume. No server publishes its game port or RCON directly.
The manager reaches RCON at `mc-<slug>:25575` over Docker's internal DNS,
which gives it full RCON control without opening anything on the host.

**The manager** owns `/routes/routes.json`, and mc-router watches that file
(`ROUTES_CONFIG_WATCH`). Every lifecycle change rewrites it. If the watcher
hasn't caught up within a few seconds, the manager pushes the same mapping
through mc-router's REST API instead, and a background check resyncs the two
if they ever drift apart.

**Wake on join.** A stopped server keeps its hostname registered, pointed at
the manager's *waker* on port 25566. The waker answers a server-list ping with
a "sleeping, join to start" MOTD, and turns a join attempt into three steps:
start the container, then disconnect the player with "reconnect in about
30 seconds". Once RCON responds, the route switches straight to the
container, so the reconnect goes direct with no extra hop. Unknown hostnames
also land on the waker and get a readable error instead of a dropped
connection.

**Auto-stop.** Once a minute, the manager asks each running server for `list`
over RCON. If a server has been empty longer than its idle timeout, the
manager stops it and returns its route to the waker. The same one-minute tick
also detects a container that exited on its own (see **Crash detection**
below), resyncs mc-router if its live routes have drifted from what mctl
expects, and, every 30 minutes, checks free space on the backups volume.

## Quick start

```bash
git clone <this repo> mctl && cd mctl
./install.sh
```

`install.sh` creates `.env` from `.env.example`, asks for your base domain
and Cloudflare Tunnel token, and brings up mc-router, the manager, and the
tunnel. It's safe to rerun; it only changes the keys you answer. To set up
manually instead:

```bash
cp .env.example .env
$EDITOR .env          # set DOMAIN and TUNNEL_TOKEN
docker compose up -d --build
```

Either way, there are no default servers; create the first one in the UI.

### DNS

Point a wildcard record at the host running mc-router:

```
*.mc.example.com   A   <host ip>
```

A server with the slug `survival` is then reachable at
`survival.mc.example.com` on the default port. The manager UI is served
through the tunnel instead, so give the tunnel its own hostname (for example,
`mc.example.com` → `http://manager:8080`).

### Cloudflare Access

The app has no login of its own. Put the tunnel hostname behind a Cloudflare
Access application. The backend trusts the
`Cf-Access-Authenticated-User-Email` header that Access injects, and rejects
any request that doesn't have it.

That trust is safe only because port 8080 is never published to the host; the
tunnel is the only way in. If you expose the manager some other way, put an
equivalent authenticating proxy in front of it, and optionally set
`ALLOWED_EMAILS` as a second check.

With enforcement off (local development only; see below), requests fall back
to a fixed local identity, `DEV_USER`, instead of a real header. Audit log
entries and `created_by` values recorded that way carry whatever `DEV_USER`
is set to, not a real address. Set it to a placeholder such as `dev@local`
rather than a real email address.

## Configuration

Configuration lives in `.env`, but you can override every value below from the
UI on the Network page. Settings you change there are stored in a `settings`
table in SQLite, and a value stored there always takes precedence over its
`.env` counterpart. `.env` provides only the starting defaults for a fresh
install.

| Variable | Purpose |
| --- | --- |
| `DOMAIN` | Base domain; each server's hostname is `<slug>.<DOMAIN>` |
| `MC_PORT` | Shared host port for mc-router (default 25565) |
| `PUBLIC_HOST` | Address shown for directly published servers; see below. Empty by default |
| `TUNNEL_TOKEN` | Cloudflare Tunnel token |
| `COMPOSE_PROFILES` | `tunnel` to run cloudflared; empty to skip it |
| `REQUIRE_CF_ACCESS` | Enforce the identity header (keep `true`) |
| `ALLOWED_EMAILS` | Optional comma-separated allowlist |
| `DEV_USER` | Local-dev identity, used only when enforcement is off |
| `MC_IMAGE` | Minecraft image (default `itzg/minecraft-server:latest`) |
| `HELPER_IMAGE` | Short-lived image used for volume operations |
| `DEFAULT_MEMORY` | Default heap for new servers |
| `CONTAINER_LOG_MAX_SIZE` | Per-file log cap on server containers (default 10m) |
| `CONTAINER_LOG_MAX_FILE` | Number of rotated log files to keep (default 3) |
| `RESTIC_IMAGE` | Image used to run backups (default `restic/restic:latest`) |

`PUBLIC_HOST` is left empty in the shipped `docker-compose.yml`. An empty
value does **not** mean "use `DOMAIN`"; see the next section for why that
would usually be the wrong address to advertise. The webhook URL used for
notifications has no `.env` equivalent at all; it exists only in the
database, and you set it from the Network page.

### Changing the domain later

Open **Network** in the UI and edit the base domain. mctl re-derives every
server's address, rewrites mc-router's table immediately, and lists what
moved. Containers, worlds, and volumes stay untouched.

### Per-server join addresses

A server's **Join address**, on that server's own **Settings** tab,
overrides the derived name, so one server can live outside the wildcard: for
example, `play.example.com` alongside `creative.mc.example.com`. It applies
immediately, since mc-router updates without touching the container. Clearing
it reverts the server to `<slug>.<DOMAIN>` and to following future `DOMAIN`
changes. Make sure DNS for a custom address points at the host running
mc-router.

The slug itself stays fixed, because it also names the container and its
data volume. The address players type is independent of the slug.

### Three ways to reach a server

**By hostname, through mc-router.** This is the default. Every server shares
port 25565 and mc-router tells them apart by the hostname in the handshake.
It needs only one port forwarded, but requires DNS; a single wildcard record
covers every server.

**On its own port, from anywhere.** Set a **Direct port** on a server, and
mctl also publishes its container on that host port, bypassing mc-router
entirely. Players connect to `<host>:25570` with no DNS involved. The address
mctl shows for this is not just `DOMAIN`: the game port usually isn't
reachable through whatever fronts the web UI, because Cloudflare doesn't
proxy arbitrary TCP. Instead, mctl auto-detects the host's public IP (using
`api.ipify.org`, rechecked every 15 minutes) and advertises
`<public-ip>:port`. Set `PUBLIC_HOST`, or the equivalent field on the Network
page, to override that detection with a static IP, a different public
hostname, or a LAN address if you don't want this exposed publicly. mctl
falls back to the domain only if IP detection has never succeeded.

**On its own port, same network only.** The same host port as above, but
advertised using the host's own LAN IP rather than its public one. This works
for anyone on the same local network, with no port forwarding and no public
exposure. The Network page shows this address alongside the direct one.

mctl validates a port when you set it, and refuses one that's out of range,
already taken by another server, or in conflict with mc-router's own port,
with a reason, rather than failing later at container start.

## What the UI does

The UI is monospace throughout, flat and sharp-cornered rather than
skeuomorphic, and uses a single accent color for things you can act on:
buttons, links, active tabs, and focus rings. The accent color never appears
as decoration or background.

The sidebar has exactly two sections: the **servers** you manage, and the
**system** that runs them. Every page belongs to one of them. On a phone, the
sidebar collapses into a drawer.

### System

**Servers** is the home screen: every server with its status, both
addresses, start/stop/restart controls, and checkboxes for bulk actions
(start, stop, restart, or stop-and-keep-off) across however many servers you
select. Bulk actions run concurrently and report partial failure rather than
stopping at the first error, so selecting five servers when one is already
mid-restart doesn't block the other four.

**Network** answers "can players reach this, and how" in one place: the base
domain and the direct-port host address (both editable here), a webhook URL
for notifications, each server's router, direct, and same-network addresses,
what's actually open on the host, whether mc-router agrees with mctl, and
which ports stay internal. This page replaces a separate Ports page, Router
page, and Settings page from earlier versions. All three covered the same
subject, organized differently, so they're one page now.

**Backups** covers the repository, which every server shares: its size on
disk against its restored size, and a row per server showing snapshot count,
most recent snapshot, and schedule. Per-server snapshot lists live on the
server itself.

**Activity** is the audit trail. You can filter it by person and search it.

### Inside a server

Each server has seven tabs, and each tab does one job.

**Overview** is the landing page: where to connect, CPU, memory and disk
usage, the container's facts, and recent activity for that server. A server
that exited on its own shows as **Crashed**, not **Stopped**; see **Crash
detection** below.

**Console** streams the container log and sends commands over RCON. If the
server isn't running, it still shows the last 200 lines from the container's
log on disk before explaining why nothing new is coming, so a crash trace
stays visible without you having to check the raw Docker log separately. If a
console you're watching goes down mid-session, you get an explicit inline
notice instead of the stream going quiet.

**Players** manages who's online, the whitelist, the operators, and both ban
lists as real lists rather than comma-separated text, and none of it needs a
restart from you. See **Whitelist, operators, and bans** below for how each
list works.

**Files** browses `/data`, edits configs in place, and uploads, deletes,
renames, and downloads folders as a zip.

**Content** manages mods and plugins: what's installed, enable, disable,
remove, upload a JAR, install from a URL, or search Modrinth filtered to this
server.

**Backups** covers this server's snapshots, its backup schedule, and moving a
world to or from another server; see **Moving a world** below.

**Settings** is grouped rather than one long form: Identity, Connection,
Runtime, Behaviour (wake-on-join, idle stop, and how long to warn players
before a shutdown), Schedules (recurring restarts or RCON commands; see
**Scheduled tasks** below), the game's own settings, Advanced for any other
environment variable, and Danger for deleting the server.

### Whitelist, operators, and bans

Vanilla Minecraft gives only the whitelist a way to reload itself from disk
without a restart (`whitelist reload`). Operators and bans have no
equivalent, so mctl handles them differently:

- **Whitelist** entries are always written straight to `whitelist.json` on
  the container's volume, whether the server is stopped or running. If the
  server happens to be running, mctl also issues `whitelist reload` over
  RCON right after, so the change takes effect immediately with no restart.
  If that RCON call fails, or the server isn't running, the file write still
  succeeded; the UI reports that the change takes effect at the next start
  instead of claiming it reloaded when it didn't.
- **Operators and bans** (both player and IP) apply only over RCON, using
  `op`, `deop`, `ban`, `pardon`, `ban-ip`, and `pardon-ip`, and need the
  server running. There's no file fallback for these. Since vanilla can't
  reload them from disk, a file write would only take effect at the next
  restart, which the RCON path already delivers immediately whenever the
  server is up.

Adding a whitelist entry requires a UUID. For a server running in online
mode, mctl looks it up from the Mojang API
(`api.mojang.com/users/profiles/minecraft/<name>`), retrying up to three
times against transient network failures. For a server running with
`ONLINE_MODE=false`, mctl instead computes Minecraft's own offline UUID: a
version-3 UUID derived from the MD5 hash of `OfflinePlayer:<name>`. This is
the UUID an offline-mode server actually assigns to connecting players, so a
real Mojang UUID would never match. This mismatch previously caused the same
player to appear twice on the whitelist under two different UUIDs.

A write never races a server that's mid-boot. If the container is up but
RCON hasn't come up yet, mctl waits, up to two minutes, for the server to
settle one way or the other before writing, rather than writing a file the
server would silently overwrite a few seconds later with its own copy.

Because mctl owns these lists, the `OPS`, `WHITELIST`, and `MEMORY`
environment variables are deliberately unavailable in Settings. A second,
environment-driven copy of any of them would conflict with what mctl just
wrote every time the container was recreated. `MEMORY` is reserved for the
same reason: it's a dedicated field on the server rather than a free-form
environment variable, so a stale copy of it can't silently override a real
change.

### Crash detection

mctl distinguishes a container that stops on its own from one that mctl
stopped deliberately. Whenever the manager notices a container is no longer
running, it reads the container's exit code (`docker inspect`'s
`State.ExitCode`). A nonzero code, when nothing had asked the server to
stop, marks it **Crashed** rather than **Stopped**, keeps that exit code
visible, and sends a notification if a webhook is configured. This check
covers both a container that fails during startup and one that dies later
while otherwise healthy. The crashed state persists until you start the
server again; it doesn't revert to "stopped" on the next poll a minute
later.

### Scheduled tasks

Each server can have any number of cron-scheduled tasks: a clean **restart**,
which goes through the same "warn players first" countdown as a manual
restart, or a one-line **RCON command** run on a schedule. `stop` and
`restart` commands are refused here; use a restart schedule instead. mctl
validates schedules as standard five-field cron expressions using
`node-cron`, and runs them in the container's timezone (`TZ`, default UTC).
A run against a server that isn't running is skipped rather than starting it;
a schedule maintains a server that's already up, and never starts one on its
own. A failed scheduled run sends a notification if a webhook is configured.

### Notifications

An optional webhook, set on the Network page, receives a plain
`{"content": "**title**\ndescription"}` POST request. This is the shape
Discord's webhook endpoint renders directly, and any other receiver can
treat it as a plain text field with no embed parsing required. mctl sends a
notification when: a server crashes or fails to start, a scheduled backup or
task fails, or the backups volume runs low on space. The disk check runs
every 30 minutes, warns once the volume is 90% or more full, and is
throttled to at most one notification every 6 hours. The Network page has a
"Send test" button that sends a fixed test message to whatever URL is
currently saved.

### Moving a world

This feature is independent of the snapshot system described below. A
server's Backups tab can download its current world as a zip, or replace it
with one uploaded from elsewhere, optionally setting a new seed at the same
time. The upload path stops the server if it's running, extracts the zip
into the container's volume with the same uid and gid the Minecraft image
itself runs as (uid 1000), and restarts the server if it had been running.

Ownership is applied to every intermediate directory in the archive, not
just the files. A directory created implicitly during extraction without its
own explicit ownership entry stays root-owned, and later breaks saving new
data into it; this is usually the cause of "new player can't save" errors
after a manual world copy. Downloaded world zips and the "download as zip"
links on individual restic snapshots use the same flattened layout, so a zip
from either source uploads cleanly into a different server.

## Deployment notes

**Docker socket.** The manager talks to the Docker API directly through
`/var/run/docker.sock`, with no shelling out to the CLI, so it behaves the
same on Oracle Cloud Free Tier, a Debian box, or anywhere else. It runs as
root inside its container to reach the socket. Mounting the socket is
equivalent to giving the manager root on the host; that's inherent to
managing containers this way, and the reason the authentication story
matters.

**File ownership.** The manager runs as root, but the Minecraft image runs
as uid 1000, so mctl assigns the container's ownership to anything it writes
into a data volume. A root-owned file there is unwritable by the server and
surfaces later as a permission error on its next boot. To prevent that,
starting a server also sweeps the top of `/data` for root-owned files and
hands them back.

**Data.** Server worlds live in per-server named volumes
(`mctl-<slug>-data`). Manager state (SQLite) and backups live in the
`manager-data` and `backups` volumes. Deleting a server through the UI
removes its container and volume; backups already taken are kept.

**Memory.** mctl sets a server's container memory limit to its heap size
times 1.4, to leave room for JVM overhead.

**Backup storage.** One restic repository holds every server's snapshots,
which is what makes deduplication work across them. As a result, on-disk
size is a repository-wide figure rather than a per-server one. The Backups
tab reports both: this server's own snapshot count and restored size, and
the shared repository's totals.

The repository lives in the `backups` volume, and its password sits beside
it as `restic-password` rather than only in the database, so that volume
alone is enough to recover. Copy both somewhere off the host if the backups
matter to you. Snapshots taken before restic was introduced are still
`.tar.gz` files, and remain listed, downloadable, and restorable through the
old path.

**Resource limits.** Each server gets a memory ceiling derived from its
heap. Container logs are capped and rotated, because Docker's default keeps
every line forever and slowly fills the disk.

**Stopping politely.** A stop or restart broadcasts a countdown over RCON
before pulling the server down. You set the countdown per server, alongside
the idle timeout, since a test box and a survival world call for different
answers. mctl skips the countdown when nobody is online, so idle auto-stop
stays immediate. Overlapping stops collapse into one, so a manual stop
racing the idle auto-stop can't double the countdown.

**Stop and keep off.** A plain stop leaves wake-on-join armed, so the next
player to connect starts the server again. **Stop and keep off** stops the
server and disarms wake-on-join in the same action: connecting players are
told the server is offline until you re-enable it from the server page.

**Resource footprint.** Each running Minecraft server is a JVM; the manager
itself is a small Node process. Wake-on-join together with idle auto-stop is
what makes a handful of servers practical on a small box.

## Local development

```bash
cp .env.example .env    # set REQUIRE_CF_ACCESS=false, DEV_USER=dev@local,
                        # COMPOSE_PROFILES=
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d --build
```

The dev overlay publishes the manager on `127.0.0.1:8080`. With enforcement
off, anyone who can reach that port controls every server, so don't use the
overlay on an exposed host. Keep `DEV_USER` a placeholder rather than a real
address: it's recorded as the actor for everything you do while enforcement
is off.

For frontend work, run `cd frontend && npm run dev`, which proxies `/api`
and the WebSocket connection to `http://localhost:8080`.

## Known constraints

**TLS-intercepting proxies.** On a network with a corporate MITM proxy, the
Minecraft container can't verify download endpoints, and server-type
downloads fail with `PKIX path building failed`. Mojang's endpoints are
often left alone while PaperMC's aren't, so vanilla may work where Paper
doesn't. This happens because the proxy's CA is missing from the container's
trust store; it isn't a bug in the stack.

**mc-router now has its own auto-scale.** Recent mc-router builds ship
`AUTO_SCALE_UP` and `AUTO_SCALE_DOWN`, which can start and stop Docker
containers on access. mctl keeps its own waker instead, so a single
component owns lifecycle: the manager decides when to stop a server based on
the RCON player count rather than TCP connection count, and it controls the
sleeping and starting MOTDs. If you'd rather let mc-router handle this, turn
off wake-on-join for each server and give mc-router the Docker socket.

**Minecraft traffic doesn't go through the tunnel.** Cloudflare Tunnel
doesn't carry arbitrary TCP for unauthenticated clients, so port 25565 is a
direct port mapping. Only the web UI goes through the tunnel.
