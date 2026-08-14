# mctl

Self-hosted web manager for multiple Minecraft servers running as
[`itzg/docker-minecraft-server`](https://github.com/itzg/docker-minecraft-server)
containers behind a single [`itzg/mc-router`](https://github.com/itzg/mc-router)
entry point.

One public game port. One public web UI, authenticated by Cloudflare Access.
Every server gets its own hostname, its own container, and no published ports at
all.

```
                    ┌──────────────────────────────────────────────┐
  players           │  host                                         │
  :25565 ─────────► │  mc-router ──┬─► mc-survival:25565            │
  survival.mc.…     │              ├─► mc-creative:25565            │
  creative.mc.…     │              └─► manager:25566  (waker)       │
                    │                                               │
  browser           │  cloudflared ─► manager:8080 ─► Docker API    │
  mc.example.com    │                              └► RCON :25575   │
                    └──────────────────────────────────────────────┘
                       internal network — nothing else is published
```

## How it fits together

**mc-router** reads the hostname out of the Minecraft handshake and forwards the
connection to the matching backend container. Players connect to
`survival.mc.example.com`, never to a port number, and only 25565 is open on the
host.

**Each server** is its own container on the internal `mctl-net` network with a
named data volume. Nothing is published — not the game port, not RCON. The
manager reaches RCON at `mc-<slug>:25575` over Docker's internal DNS, which is
how you get full RCON control without opening anything.

**The manager** owns `/routes/routes.json`, which mc-router watches
(`ROUTES_CONFIG_WATCH`). Every lifecycle change rewrites it; if the watcher
hasn't caught up within a few seconds the manager pushes the same mapping
through mc-router's REST API instead, and a background check re-syncs if the two
ever drift apart.

**Wake on join.** A stopped server keeps its hostname registered, pointed at the
manager's *waker* on port 25566. The waker speaks just enough of the protocol to
answer a server-list ping with a "sleeping, join to start" MOTD, and to turn a
join attempt into: start the container, disconnect the player with "reconnect in
about 30 seconds". Once RCON answers, the route flips straight to the container,
so the reconnect goes direct with no extra hop. Unknown hostnames land there too
and get a readable error instead of a dropped connection.

**Auto-stop.** Once a minute the manager asks each running server for `list` over
RCON. A server that has been empty for longer than its idle timeout is stopped
and its route parked back on the waker.

## Quick start

```bash
git clone <this repo> mctl && cd mctl
cp .env.example .env
$EDITOR .env          # set DOMAIN and TUNNEL_TOKEN
docker compose up -d
```

That brings up mc-router, the manager and the Cloudflare tunnel. There are no
default servers — create the first one in the UI.

### DNS

Point a wildcard record at the host running mc-router:

```
*.mc.example.com   A   <host ip>
```

A server with slug `survival` is then reachable at `survival.mc.example.com`
on the default port. The manager UI is served through the tunnel instead, so
give the tunnel its own hostname (for example `mc.example.com` → `http://manager:8080`).

### Cloudflare Access

The app has no login of its own. Put the tunnel hostname behind a Cloudflare
Access application; the backend trusts the `Cf-Access-Authenticated-User-Email`
header Access injects, and rejects any request without it.

That trust is only safe because port 8080 is never published to the host — the
tunnel is the only way in. If you expose it some other way, put an equivalent
authenticating proxy in front, and optionally set `ALLOWED_EMAILS` as a second
check.

## Configuration

Everything lives in `.env`:

| Variable | Purpose |
| --- | --- |
| `DOMAIN` | Base domain; each server's hostname is `<slug>.<DOMAIN>` |
| `MC_PORT` | Host port for mc-router (default 25565) |
| `TUNNEL_TOKEN` | Cloudflare Tunnel token |
| `COMPOSE_PROFILES` | `tunnel` to run cloudflared; empty to skip it |
| `REQUIRE_CF_ACCESS` | Enforce the identity header (keep `true`) |
| `ALLOWED_EMAILS` | Optional comma-separated allowlist |
| `DEV_USER` | Local-dev identity, only used when enforcement is off |
| `MC_IMAGE` | Minecraft image (default `itzg/minecraft-server:latest`) |
| `HELPER_IMAGE` | Short-lived image used for volume operations |
| `DEFAULT_MEMORY` | Default heap for new servers |

### Changing the domain later

Hostnames are always derived as `<slug>.<DOMAIN>`, so moving every server to a
new domain is one edit:

```bash
sed -i 's/^DOMAIN=.*/DOMAIN=mc.example.com/' .env
docker compose up -d
```

On boot the manager re-derives each server's hostname, rewrites mc-router's
table (dropping the old names and registering the new ones), and logs what it
moved. Containers, worlds and volumes are untouched — only the name players
connect to changes. Point the new wildcard record at the host and you're done.

### Per-server join addresses

A server's **Join address** under Settings overrides the derived name, so one
server can live outside the wildcard — `play.example.com` alongside
`creative.mc.example.com`. It applies immediately (mc-router is updated without
touching the container), and clearing it goes back to `<slug>.<DOMAIN>` and to
following future `DOMAIN` changes. Make sure DNS for a custom address points at
the host running mc-router.

The slug itself stays fixed, because it also names the container and its data
volume — the address players type is independent of that.

## What the UI does

**Dashboard** — every server with live status, player count, and start / stop /
restart / console.

**Console** — the container's log stream over a WebSocket, with a command input
that goes out over RCON. `stop` and `restart` are refused here so the manager
stays the only thing driving lifecycle; use the buttons.

**Players** — online list, kick, ban, ban-ip, pardon, op/deop, whitelist add and
remove, all RCON.

**Files** — browse `/data`, edit `server.properties`, `whitelist.json`,
`ops.json`, `banned-players.json` and friends in the browser, upload, delete,
rename, and download any folder (including the world) as a zip.

**Mods** — for Paper/Spigot/Purpur/Fabric/Forge/NeoForge/Quilt: list installed
jars, enable/disable (rename to `.disabled`), remove, upload, install from a
direct HTTPS URL, or search Modrinth filtered to the server's loader and game
version.

**Backups** — snapshot the world (or all of `/data`) straight out of the
container filesystem; running servers get `save-off` + `save-all flush` first so
the snapshot is consistent. Schedule with cron, keep the last N, download as
`.tar.gz` or `.zip`, restore with confirmation.

**Stats** — CPU and memory from Docker stats with a rolling history, plus disk
usage of the data volume on demand.

**Settings** — a form over the environment variables the itzg image supports
(difficulty, gamemode, MOTD, view distance, …) plus an escape hatch for any
other variable. Applying recreates the container against the same volume, so
worlds, mods and configs survive.

## Deployment notes

**Docker socket.** The manager talks to the Docker API directly through
`/var/run/docker.sock` — no shelling out to the CLI — so it behaves the same on
Oracle Cloud Free Tier, a Debian box, or anywhere else. It runs as root inside
its container to reach the socket. Mounting the socket is equivalent to giving
the manager root on the host; that is inherent to managing containers this way,
and the reason the auth story matters.

**Data.** Server worlds live in per-server named volumes (`mctl-<slug>-data`).
Manager state (SQLite) and backups live in the `manager-data` and `backups`
volumes. Deleting a server through the UI removes its container and volume;
backups already taken are kept.

**Memory.** A server's container limit is set to its heap times 1.4 to leave room
for JVM overhead.

**Resource footprint.** Each running Minecraft server is a JVM; the manager
itself is a small Node process. Wake-on-join plus idle auto-stop is what makes a
handful of servers practical on a small box.

## Local development

```bash
cp .env.example .env    # set REQUIRE_CF_ACCESS=false, DEV_USER=you@example.com,
                        # COMPOSE_PROFILES=
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d --build
```

The dev overlay publishes the manager on `127.0.0.1:8080`. With enforcement off,
anyone who can reach that port controls every server — don't use the overlay on
an exposed host.

For frontend work, `cd frontend && npm run dev` proxies `/api` (and the
WebSockets) to `http://localhost:8080`.

## Known constraints

**TLS-intercepting proxies.** On a network with a corporate MITM proxy, the
Minecraft container can't verify download endpoints and server-type downloads
fail with `PKIX path building failed`. Mojang's endpoints are often left alone
while PaperMC's are not, so vanilla may work where Paper doesn't. This is the
proxy's CA missing from the container's trust store, not a bug in the stack.

**mc-router now has its own auto-scale.** Recent mc-router builds ship
`AUTO_SCALE_UP` / `AUTO_SCALE_DOWN`, which can start and stop Docker containers
on access. mctl keeps its own waker instead, so that a single component owns
lifecycle: the manager decides when to stop based on the RCON player count
rather than TCP connection count, and it controls the sleeping/starting MOTDs.
If you'd rather let mc-router do it, turn wake-on-join off per server and give
mc-router the Docker socket.

**Minecraft traffic doesn't go through the tunnel.** Cloudflare Tunnel doesn't
carry arbitrary TCP for unauthenticated clients, so 25565 is a direct port
mapping. The web UI is the part that goes through the tunnel.
