# Production Architecture

## Canonical runtime

```text
Browser / Capacitor Android
          |
       HTTPS
          v
  Host Nginx (80/443)
          |
  127.0.0.1:3000
          v
React/Vite static UI + Express API
       |                 |
       | backend network | X-Internal-Api-Key
       v                 v
PostgreSQL 17       FastAPI ML service
  forced RLS         (not host-published)
       |
encrypted age backups + isolated restore check
```

`server.ts`, `src/`, root `Dockerfile` and root `docker-compose.yml` are the production application. Nginx is host-managed from `deploy/nginx/`. PostgreSQL and FastAPI have no host port. The application port is loopback-only.

## Non-production workspaces

- `backend/`: .NET reference API. It is built/tested in CI but not started by production Compose.
- `frontend/`: Next.js reference frontend. It has its own audit/build CI job and is not deployed.
- `android/`: Capacitor shell for the canonical Express API. A production build requires explicit `VITE_MOBILE_API_BASE_URL=https://...` and stores rotating mobile refresh tokens.
- SQLite: test and one-time legacy migration source only. Production requires `DATABASE_URL`.

These workspaces remain in place to preserve examples and regression coverage. Moving them to `examples/` would break current Docker contexts, solution paths and documentation links without adding runtime security, so they are separated by CI/profile instead.

## Trust boundaries

1. Nginx terminates TLS, enforces body/rate limits and forwards a bounded trusted-proxy chain.
2. Express authenticates access tokens, resolves organization membership server-side and never trusts a body/header organization without membership validation.
3. Every tenant data-plane transaction sets `SET LOCAL app.current_organization_id`; PostgreSQL `FORCE ROW LEVEL SECURITY` fails closed when context is missing.
4. FastAPI accepts model/cache work only with the shared internal key and compares it in constant time.
5. External LLMs are optional and disabled unless both a provider key and `ALLOW_EXTERNAL_AI_DATA=true` exist.

## Data ownership

Tenant data-plane tables use `organization_id`, a foreign key, an index and forced RLS. Global identity/control-plane tables (`users`, refresh/action tokens, memberships and invitations) are intentionally resolved before a tenant transaction. Billing callback lookup tables contain only opaque hashes/references and organization routing; financial records remain RLS protected.

## Availability model

This repository targets a single VDS/single Express replica. Database quotas are atomic, but brute-force and security rate-limit windows are process-local. Horizontal scaling requires a shared limiter/queue such as Redis before adding replicas.
