#!/bin/sh
set -eu

case "${POSTGRES_APP_USER:-}" in
  ''|*[!a-zA-Z0-9_]*) echo "POSTGRES_APP_USER is invalid" >&2; exit 1 ;;
esac

if [ "${#POSTGRES_APP_PASSWORD}" -lt 32 ]; then
  echo "POSTGRES_APP_PASSWORD must be at least 32 characters" >&2
  exit 1
fi

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  --set=app_user="$POSTGRES_APP_USER" \
  --set=app_password="$POSTGRES_APP_PASSWORD" <<-'EOSQL'
SELECT format(
  'CREATE ROLE %I LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS',
  :'app_user', :'app_password'
) \gexec
SELECT format('GRANT CONNECT ON DATABASE %I TO %I', current_database(), :'app_user') \gexec
SELECT format('GRANT USAGE, CREATE ON SCHEMA public TO %I', :'app_user') \gexec
EOSQL
