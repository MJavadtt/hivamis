#!/usr/bin/env bash
# Database + uploaded-document backup. Run from cron; keeps RETENTION_DAYS of history.
set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-./backups}"
RETENTION_DAYS="${RETENTION_DAYS:-30}"
STAMP="$(date +%Y%m%d-%H%M%S)"
mkdir -p "$BACKUP_DIR"

: "${DATABASE_URL:?DATABASE_URL must be set}"

echo "→ dumping database …"
pg_dump --format=custom --no-owner --no-acl "$DATABASE_URL" \
  > "$BACKUP_DIR/hiva-db-$STAMP.dump"

if [ -d "${STORAGE_DIR:-./storage}" ]; then
  echo "→ archiving documents …"
  tar -czf "$BACKUP_DIR/hiva-storage-$STAMP.tar.gz" -C "$(dirname "${STORAGE_DIR:-./storage}")" \
    "$(basename "${STORAGE_DIR:-./storage}")"
fi

echo "→ pruning backups older than $RETENTION_DAYS days …"
find "$BACKUP_DIR" -name 'hiva-*' -type f -mtime "+$RETENTION_DAYS" -delete

echo "✓ backup complete: $BACKUP_DIR/hiva-db-$STAMP.dump"
