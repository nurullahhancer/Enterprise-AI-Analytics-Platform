#!/bin/sh
set -eu

umask 077
backup_dir=/backups
interval_seconds="${POSTGRES_BACKUP_INTERVAL_SECONDS:-86400}"
retention_days="${POSTGRES_BACKUP_RETENTION_DAYS:-14}"

case "${BACKUP_AGE_RECIPIENT:-}" in
  age1*) ;;
  *) echo "BACKUP_AGE_RECIPIENT must be a valid age public recipient" >&2; exit 1 ;;
esac
if [ "${#BACKUP_AGE_RECIPIENT}" -lt 50 ]; then
  echo "BACKUP_AGE_RECIPIENT is too short" >&2
  exit 1
fi

case "$interval_seconds:$retention_days" in
  *[!0-9:]*|:*) echo "Invalid backup interval or retention" >&2; exit 1 ;;
esac

mkdir -p "$backup_dir"
temp_path=""
cleanup_partial() {
  if [ -n "$temp_path" ]; then
    rm -f "$temp_path"
  fi
}
trap cleanup_partial EXIT INT TERM

while true; do
  timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
  dump_path="$backup_dir/reai-$timestamp.dump.age"
  temp_path="$dump_path.partial"
  pg_dump --host=postgres --username="$POSTGRES_USER" --dbname="$POSTGRES_DB" --format=custom --no-owner --no-acl \
    | age --recipient "$BACKUP_AGE_RECIPIENT" --output "$temp_path"
  age --decrypt --identity /run/secrets/backup_age_identity "$temp_path" | pg_restore --list >/dev/null
  mv "$temp_path" "$dump_path"
  temp_path=""
  sha256sum "$dump_path" >"$dump_path.sha256"
  date -u +%Y-%m-%dT%H:%M:%SZ >"$backup_dir/last-success"
  find "$backup_dir" -type f \( -name 'reai-*.dump.age' -o -name 'reai-*.dump.age.sha256' \) -mtime "+$retention_days" -delete
  echo "Backup verified: $(basename "$dump_path")"
  sleep "$interval_seconds"
done
