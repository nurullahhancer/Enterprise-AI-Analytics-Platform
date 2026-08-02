# API Contract Overview

The canonical API is Express under `/api`. Responses are JSON except reports, hosted checkout HTML and optional SSE chat. Protected calls require the session cookie or `Authorization: Bearer ...`; native clients also send `X-Client-Type: mobile`. `X-Organization-Id` selects only an organization in the authenticated user's active memberships.

Every response includes `X-Request-Id`. Error responses use:

```json
{"error":{"code":"STABLE_CODE","message":"Safe user message","requestId":"uuid"}}
```

## Authentication

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/register` | Controlled registration/invitation/bootstrap |
| POST | `/api/login` | Access + rotating refresh session |
| POST | `/api/refresh` | Atomic refresh rotation; reuse revokes family |
| POST | `/api/logout` | Revoke user sessions |
| GET | `/api/me` | Current user and memberships |
| POST | `/api/forgot-password` | Enumeration-safe reset request |
| POST | `/api/reset-password` | Single-use password reset |

## Data and analysis

- `POST /api/upload`, `GET /api/dataset/list`, `DELETE /api/dataset/:id`
- `GET /api/dashboard/dynamic`, `GET /api/insights/auto`
- `GET /api/ml/forecast`, `POST /api/ml/analyze`
- `GET/DELETE /api/ml/analyses/:id`, `POST /api/ml/analyses/:id/interpret`
- `GET /api/ml/job/:id`
- `POST /api/chat`
- `/reports/*` for bounded CSV/report downloads

## SaaS and billing

`/api/saas` contains organizations, invitations, members, usage, entitlements and hosted checkout. Administrative mutations require the `admin` role. Provider callbacks/webhooks are public only because they verify opaque records and provider signatures/results server-side.

## Enterprise

`/api/enterprise` contains encrypted REST/SQL connections, sync history, documents, notification settings, audit logs and data-governance controls. Connector hosts must be allowlisted. SQL connectors are read-only, timed and row-limited.

## Internal ML API

FastAPI is not exposed on a host port. `/predict`, `/anomalies`, `/clusters`, `/analyze` and `/ml/cache*` require `X-Internal-Api-Key`; model requests also receive `X-Tenant-Id` from Express. `/health` and Prometheus `/metrics` expose no customer/model data and remain reachable only on the internal Docker network.

## Pagination and versioning

List endpoints enforce bounded limits but the current API is not yet namespaced under `/api/v1` and does not expose a generated OpenAPI contract for Express. Those are remaining compatibility tasks; breaking changes require a documented migration until versioning is introduced.
