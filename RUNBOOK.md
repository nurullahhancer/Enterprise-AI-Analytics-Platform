# Operations Runbook

## Triage order

1. `docker compose ps`
2. `curl -fsS https://YOUR_HOST/api/health`
3. `docker compose logs --since=30m --tail=300 app ml-service postgres postgres-backup`
4. Check disk (`df -h`) and Docker log/image growth.
5. Use the response `X-Request-Id` to correlate structured app logs.

## Common incidents

### App degraded

Do not weaken health checks. Verify production secrets, PostgreSQL readiness, `reai_app` connectivity and ML health. Recreate the app after environment changes with `docker compose up -d app`.

### Tenant/RLS error

Confirm the request user has an active membership and no client-provided organization was trusted without validation. Never disable RLS. Run the PostgreSQL isolation test against a non-production database.

### ML failures

Check internal key consistency, ML container memory and input-limit warnings. `429 ML_QUEUE_FULL` is capacity protection; do not restart merely to erase counters.

### LLM cost spike

Disable external sharing with `ALLOW_EXTERNAL_AI_DATA=false`, recreate app, then inspect organization/user usage, Prometheus token/cost counters and request IDs. Do not log prompts or API keys.

### Payment mismatch

Do not manually activate a plan from a browser screenshot. Reconcile the provider reference and signed event, retrieve provider state again, and retain the billing audit event. Unknown subscriptions return retryable failure until the verified checkout record exists.

### Backup failure

Check age identity availability, recipient/key pairing, free disk and PostgreSQL credentials. Preserve failed encrypted artifacts for diagnosis. After correction, run `postgres-backup`, then mandatory `postgres-restore-check`.

## Release and rollback

Before release: record commit, verify clean intended diff, run all CI-equivalent tests, create/restore-test backup, then build and start. Roll back code with a known-good tag/image. Schema rollback is a separate approved data operation; never use `git reset --hard` or volume deletion as rollback.
