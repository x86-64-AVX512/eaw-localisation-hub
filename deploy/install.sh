#!/bin/sh
set -eu

cd "$(dirname "$0")"
if ! command -v docker >/dev/null 2>&1; then
  echo "Docker is required: https://docs.docker.com/engine/install/" >&2
  exit 1
fi
if ! docker compose version >/dev/null 2>&1; then
  echo "Docker Compose v2 is required." >&2
  exit 1
fi
if [ ! -f .env ]; then
  cp .env.example .env
  echo "Created deploy/.env. Review HUB_DOMAIN and ports before public TLS deployment."
fi
mkdir -p backups

if [ "${1:-}" = "--tls" ]; then
  docker compose --profile tls up -d --build
else
  docker compose up -d --build server
fi

echo "EaW Localisation Hub is running."
echo "Health: http://127.0.0.1:${HUB_PORT:-3210}/health"
echo "Bootstrap administrator invitation:"
docker compose exec -T server sh -c 'cat /data/bootstrap-invite.txt 2>/dev/null || echo "already redeemed"'
