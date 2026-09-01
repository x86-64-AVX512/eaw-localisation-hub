#!/bin/sh
set -eu

if [ "$#" -ne 1 ]; then
  echo "Usage: ./restore.sh backups/eaw-hub-TIMESTAMP.eawhub.enc" >&2
  exit 1
fi
: "${EAW_HUB_BACKUP_PASSPHRASE:?Set EAW_HUB_BACKUP_PASSPHRASE used for this backup}"
cd "$(dirname "$0")"
BACKUP_NAME="$(basename "$1")"
if [ ! -f "backups/$BACKUP_NAME" ]; then
  echo "Backup must be inside deploy/backups: $BACKUP_NAME" >&2
  exit 1
fi
docker compose stop server
docker compose run --rm --no-deps -e EAW_HUB_BACKUP_PASSPHRASE server \
  node apps/server/src/restore.mjs --backup "/backups/$BACKUP_NAME" --data /data --force
docker compose up -d server
echo "Restore completed; previous state remains in the hub-data volume as a before-restore directory."
