#!/bin/sh
set -eu

umask 077
backup_dir=/backups
interval_seconds="${POSTGRES_BACKUP_INTERVAL_SECONDS:-86400}"
retention_days="${POSTGRES_BACKUP_RETENTION_DAYS:-14}"

case "$interval_seconds:$retention_days" in
  *[!0-9:]*|:*) echo "Invalid backup interval or retention" >&2; exit 1 ;;
esac

mkdir -p "$backup_dir"

while true; do
  timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
  dump_path="$backup_dir/reai-$timestamp.dump"
  temp_path="$dump_path.partial"
  pg_dump --host=postgres --username="$POSTGRES_USER" --dbname="$POSTGRES_DB" --format=custom --no-owner --no-acl --file="$temp_path"
  pg_restore --list "$temp_path" >/dev/null
  mv "$temp_path" "$dump_path"
  sha256sum "$dump_path" >"$dump_path.sha256"
  find "$backup_dir" -type f \( -name 'reai-*.dump' -o -name 'reai-*.dump.sha256' \) -mtime "+$retention_days" -delete
  echo "Backup verified: $(basename "$dump_path")"
  sleep "$interval_seconds"
done
