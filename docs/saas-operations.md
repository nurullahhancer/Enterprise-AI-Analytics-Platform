# SaaS Operations

## Production roles

PostgreSQL starts with two roles:

- `POSTGRES_USER`: database administration, backup and recovery only.
- `POSTGRES_APP_USER`: application owner with `NOBYPASSRLS`; this is the user in `DATABASE_URL`.

The application sets `app.current_organization_id` inside every tenant transaction. Business tables use explicit `organization_id` predicates and forced PostgreSQL row-level security.

## SQLite to PostgreSQL migration

1. Stop application writes and keep the ML and PostgreSQL services running.
2. Archive the `app-data` volume before changing the database URL.
3. Start the current build once with SQLite so the idempotent SaaS schema backfills personal organizations.
4. Initialize an empty PostgreSQL schema with the application role.
5. Run:

```bash
SOURCE_DB_PATH=/source/reai.db DATABASE_URL=postgresql://... npm run db:migrate:postgres
```

The migration refuses a non-empty target by default, copies only shared columns, updates sequences, checks row counts and commits only after verification. Keep the SQLite archive until application and backup restore checks pass.

## Backup and recovery

Compose runs `postgres-backup`, which creates a verified custom-format dump and SHA-256 checksum every day, retaining 14 days by default. Run the non-destructive isolated restore check after releases and at least monthly:

```bash
docker compose up -d postgres-backup
docker compose --profile maintenance run --rm postgres-restore-check
```

The check restores into `reai_restore_check`, queries the organization and user tables, and drops that temporary database. The named backup volume is local to the VDS, so copy dumps to encrypted off-host storage under a separately managed retention policy. After an actual disaster restore, start one application instance to apply idempotent schema changes, then verify `/api/health`, member access and cross-organization denial before routing traffic.

## Monitoring and data governance

Prometheus is bound to `127.0.0.1:9090` and scrapes application and ML metrics over the internal Docker network. Alert rules cover service availability, sustained server-error rate and application memory. Nginx returns 404 for the internal metrics endpoint. Configure an authenticated tunnel or an external alert receiver before operational use; never publish port 9090 directly.

Organization administrators can configure a 30-3650 day retention policy and export tenant data from the governance screen. The daily policy job removes only dated operational history (analysis, KPI evaluation, connector run, notification and audit rows); it does not automatically delete raw datasets or documents.

## E-mail

Set `RESEND_API_KEY` and a verified `EMAIL_FROM`, then enable `REQUIRE_EMAIL_VERIFICATION=true`. Registration verification links expire after 24 hours, password reset links after 60 minutes and invitations after 72 hours. Only token hashes are stored.

## Billing

Configure the iyzico sandbox first:

- `IYZICO_API_KEY`
- `IYZICO_SECRET_KEY`
- `IYZICO_BASE_URL`
- `IYZICO_MERCHANT_ID`
- `IYZICO_PLAN_PROFESSIONAL`
- `IYZICO_PLAN_ENTERPRISE`

Register `POST /api/saas/billing/webhook` as the subscription webhook. The main SPA never receives or renders provider HTML; the hosted form is served on an isolated same-origin page. A browser redirect does not grant entitlements. The server retrieves and validates the checkout result or verifies the V3 webhook before changing a plan.
