#!/bin/sh
set -eu

source_db="${POSTGRES_DB:-reai}"
restore_db="${POSTGRES_RESTORE_CHECK_DB:-reai_restore_check}"
case "$source_db:$restore_db" in
  *[!A-Za-z0-9_:]*|:*) echo "Invalid database name" >&2; exit 1 ;;
esac
if [ "$source_db" = "$restore_db" ]; then
  echo "Restore-check database must differ from production" >&2
  exit 1
fi

latest_dump="$(find /backups -maxdepth 1 -type f -name 'reai-*.dump' | sort | tail -n 1)"
if [ -z "$latest_dump" ]; then
  echo "No backup found" >&2
  exit 1
fi
sha256sum -c "$latest_dump.sha256"

cleanup() {
  dropdb --host=postgres --username="$POSTGRES_USER" --if-exists "$restore_db" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM
cleanup
createdb --host=postgres --username="$POSTGRES_USER" "$restore_db"
pg_restore --host=postgres --username="$POSTGRES_USER" --dbname="$restore_db" --no-owner --no-acl "$latest_dump"
psql --host=postgres --username="$POSTGRES_USER" --dbname="$restore_db" --set=ON_ERROR_STOP=1 --tuples-only --command="SELECT COUNT(*) FROM saas_organizations; SELECT COUNT(*) FROM users;" >/dev/null
echo "Restore check passed: $(basename "$latest_dump")"
