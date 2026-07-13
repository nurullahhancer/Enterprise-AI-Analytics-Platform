#!/bin/sh
set -eu

umask 077
chmod 700 /app/data
find /app/data -maxdepth 1 -type f \
  \( -name 'reai.db' -o -name 'reai.db-wal' -o -name 'reai.db-shm' \) \
  -exec chmod 600 {} +

exec node server-dist/server.cjs
