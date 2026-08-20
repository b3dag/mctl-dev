#!/usr/bin/env bash
# Interactive setup for mctl: creates .env from .env.example, asks for the two
# values that actually need a human (DOMAIN and the Cloudflare Tunnel token),
# and starts the stack. Safe to rerun - it only edits keys you answer, and
# never overwrites an existing .env wholesale.
set -euo pipefail
cd "$(dirname "$0")"

if ! command -v docker >/dev/null 2>&1; then
  echo "Docker is required: https://docs.docker.com/engine/install/" >&2
  exit 1
fi
if ! docker compose version >/dev/null 2>&1; then
  echo "Docker Compose v2 is required (the 'docker compose' plugin, not the old 'docker-compose')." >&2
  exit 1
fi
if ! docker info >/dev/null 2>&1; then
  echo "Docker is installed but not reachable. Is the daemon running, and can this user reach it?" >&2
  exit 1
fi

if [ ! -f .env ]; then
  cp .env.example .env
  echo "Created .env from .env.example."
fi

get_env() { grep -E "^$1=" .env | head -n1 | cut -d= -f2-; }
set_env() {
  if grep -qE "^$1=" .env; then
    sed -i.bak -E "s|^$1=.*|$1=$2|" .env && rm -f .env.bak
  else
    printf '%s=%s\n' "$1" "$2" >> .env
  fi
}

echo
echo "== mctl setup =="
echo

current_domain=$(get_env DOMAIN)
read -rp "Base domain for your servers, e.g. mc.example.com [$current_domain]: " domain
domain="${domain:-$current_domain}"
[ -n "$domain" ] && set_env DOMAIN "$domain"

echo
echo "mctl publishes its web UI through a Cloudflare Tunnel, so the manager is never"
echo "exposed directly. Create one under Cloudflare Zero Trust -> Networks -> Tunnels,"
echo "point its public hostname at http://manager:8080, and paste the token here."
current_token=$(get_env TUNNEL_TOKEN)
prompt="Cloudflare Tunnel token"
[ -n "$current_token" ] && prompt="$prompt [leave empty to keep the one already in .env]"
read -rp "$prompt: " token
if [ -n "$token" ]; then
  set_env TUNNEL_TOKEN "$token"
  set_env COMPOSE_PROFILES "tunnel"
elif [ -z "$current_token" ]; then
  echo
  read -rp "No token given. Run locally without a tunnel for now (unauthenticated, dev only)? [y/N] " local_dev
  if [[ "$local_dev" =~ ^[Yy] ]]; then
    set_env COMPOSE_PROFILES ""
    set_env REQUIRE_CF_ACCESS "false"
    set_env DEV_USER "dev@local"
    echo "Set REQUIRE_CF_ACCESS=false and DEV_USER=dev@local. Do not use this on a reachable host -"
    echo "anyone who can reach port 8080 controls every server. Add a real TUNNEL_TOKEN and rerun"
    echo "this script before exposing mctl to anything but your own machine."
  else
    echo "Leaving TUNNEL_TOKEN empty. Add it to .env and rerun this script when you have one -"
    echo "the tunnel container won't start without it."
  fi
fi

echo
read -rp "Start mctl now with 'docker compose up -d --build'? [Y/n] " go
if [[ "$go" =~ ^[Nn] ]]; then
  echo "Skipped. Review .env, then run: docker compose up -d --build"
  exit 0
fi

docker compose up -d --build
echo
echo "Started. Check status with: docker compose ps"
echo
echo "Next steps:"
echo "  - Point a wildcard DNS record (*.$( [ -n "$domain" ] && echo "$domain" || echo "your-domain")) at this host, DNS only, not proxied."
echo "  - Put the tunnel hostname behind a Cloudflare Access application."
echo "  - Open the manager through that hostname and create your first server."
