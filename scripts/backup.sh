#!/usr/bin/env bash
# Paper Hoard — Postgres backup helper.
#
# Streams pg_dump out of the running postgres container into a gzipped,
# timestamped file. Designed to be run as a TrueNAS Cron Job (System
# Settings → Advanced → Cron Jobs) under root, but works ad-hoc too.
#
# Usage:
#   ./scripts/backup.sh                                # uses defaults below
#   BACKUP_DIR=/mnt/POOL/apps/paperhoard/backups ./scripts/backup.sh
#   PG_CONTAINER=ix-paperhoard-postgres-1 ./scripts/backup.sh
#
# Restore (with the app stopped or in a different DB):
#   gunzip -c paperhoard-2026-04-27.sql.gz | \
#     docker exec -i ix-paperhoard-postgres-1 psql -U paperhoard paperhoard

set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-/mnt/HDDs-1/ServerShare/apps/paperhoard/backups}"
PG_CONTAINER="${PG_CONTAINER:-ix-paperhoard-postgres-1}"
PG_USER="${PG_USER:-paperhoard}"
PG_DB="${PG_DB:-paperhoard}"
RETAIN_DAYS="${RETAIN_DAYS:-30}"

mkdir -p "$BACKUP_DIR"
ts=$(date -u +%Y-%m-%dT%H-%M-%SZ)
out="$BACKUP_DIR/paperhoard-$ts.sql.gz"

echo "Dumping to $out…"
docker exec -t "$PG_CONTAINER" pg_dump -U "$PG_USER" "$PG_DB" | gzip > "$out"

if [ ! -s "$out" ]; then
  echo "ERROR: dump file is empty" >&2
  exit 1
fi
size=$(du -h "$out" | cut -f1)
echo "OK: $out ($size)"

if [ "$RETAIN_DAYS" -gt 0 ]; then
  echo "Pruning backups older than $RETAIN_DAYS days…"
  find "$BACKUP_DIR" -maxdepth 1 -name 'paperhoard-*.sql.gz' -type f -mtime +"$RETAIN_DAYS" -delete -print
fi
