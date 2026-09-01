#!/bin/sh
set -eu

cd "$(dirname "$0")"
: "${EAW_HUB_ADMIN_TOKEN:?Set EAW_HUB_ADMIN_TOKEN to an administrator session token}"
: "${EAW_HUB_BACKUP_PASSPHRASE:?Set EAW_HUB_BACKUP_PASSPHRASE for AES-256-GCM encryption}"
KEEP="${EAW_HUB_BACKUP_KEEP:-14}"
mkdir -p backups
TARGET="/backups/eaw-hub-$(date -u +%Y%m%d-%H%M%S).eawhub.enc"
docker compose run --rm --no-deps \
  -e EAW_HUB_ADMIN_TOKEN -e EAW_HUB_BACKUP_PASSPHRASE \
  server node scripts/manage-server.mjs backup \
  --server http://server:3210 --output "$TARGET"
ls -1t backups/eaw-hub-*.eawhub.enc 2>/dev/null | awk "NR>${KEEP}" | xargs -r rm --
echo "$TARGET"
