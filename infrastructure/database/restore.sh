#!/usr/bin/env bash
# Restore from a backup produced by backup.sh.
# Refuses to run without explicit confirmation — restoring overwrites the target database.
set -euo pipefail

DUMP="${1:?usage: restore.sh <dump-file> [storage-archive]}"
ARCHIVE="${2:-}"
: "${DATABASE_URL:?DATABASE_URL must be set}"

echo "This will OVERWRITE the database at: ${DATABASE_URL%%\?*}"
read -r -p "Type RESTORE to continue: " confirm
[ "$confirm" = "RESTORE" ] || { echo "aborted"; exit 1; }

pg_restore --clean --if-exists --no-owner --no-acl --dbname "$DATABASE_URL" "$DUMP"

if [ -n "$ARCHIVE" ]; then
  tar -xzf "$ARCHIVE" -C "$(dirname "${STORAGE_DIR:-./storage}")"
fi

echo "✓ restore complete — verify with: curl \$API_URL/health/ready"
