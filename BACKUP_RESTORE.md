# Backup and Restore

## Backup design

`postgres-backup` creates a PostgreSQL custom-format dump once per configured interval. The dump is streamed into age encryption, verified by decrypting into `pg_restore --list`, checksummed, atomically renamed and marked by `/backups/last-success`. Plain database dumps are never persisted.

Required values:

- `BACKUP_AGE_RECIPIENT`: public age recipient.
- `BACKUP_AGE_IDENTITY_FILE`: host path to the `0400`, UID/GID `70:70` private identity mounted for the non-root backup user.
- `POSTGRES_BACKUP_RETENTION_DAYS`: local retention, default 14.

Generate the key exactly as shown in `DEPLOYMENT.md`. Keep a tested private-key copy outside the VDS. Copy encrypted `.dump.age` and checksum files to independent off-site storage.

## Routine verification

```bash
docker compose ps postgres-backup
docker compose logs --tail=50 postgres-backup
docker compose --profile maintenance run --rm postgres-restore-check
```

The restore check creates and later removes only `reai_restore_check`; it never overwrites `reai`. Run it monthly and before each release. Alert when the backup container is unhealthy or `last-success` is older than the backup interval plus grace.

## Disaster restore

1. Declare a maintenance window and stop the application, not PostgreSQL.
2. Preserve a new safety backup of the current database.
3. Verify the selected encrypted backup checksum and age decryption.
4. Restore into a new empty database, never directly over the existing database.
5. Point a staging application at the restored database and validate schema, RLS, login and tenant boundaries.
6. Switch `DATABASE_URL` only after approval; restart the app and run the smoke suite.
7. Retain the former database and safety backup through the rollback window.

Never use `docker compose down -v`, delete a database volume, or drop the production database as a shortcut.
