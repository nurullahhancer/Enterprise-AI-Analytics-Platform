# Enterprise AI Analytics Platform

Multi-tenant AI analytics monorepo with a .NET 8 backend, FastAPI ML service, Next.js frontend, and Docker Compose development infrastructure.

## Structure

- `backend/` - .NET 8 Clean Architecture solution: Domain, Application, Infrastructure, API, Tests
- `ml-service/` - FastAPI prediction/anomaly service
- `frontend/` - Next.js dashboard
- `infra/` - Docker Compose dependencies and service wiring
- `docs/` - Architecture Decision Records

## Local Run

Backend:

```powershell
cd backend
dotnet test
dotnet run --project EnterpriseAI.Api
```

ML service:

```powershell
cd ml-service
pip install -r requirements.txt
uvicorn app.main:app --reload
```

Frontend:

```powershell
cd frontend
npm install
npm run dev
```

All services:

```powershell
docker compose up --build
```

Service URLs:

- Backend API: `http://localhost:3010`
- Swagger: `http://localhost:3010/swagger`
- ML service: `http://localhost:8000`
- Frontend: `http://localhost:3001`
- Keycloak: `http://localhost:8081`
- RabbitMQ UI: `http://localhost:15672`
- MLflow: `http://localhost:5001`
- Prometheus: `http://localhost:9090`
- Grafana: `http://localhost:3002`

## Security Baseline

The backend issues JWTs with `tenant_id` and `role` claims, protects endpoints with RBAC, filters tenant data in the API and EF Core query layer, includes a PostgreSQL RLS bootstrap script, encrypts SQL connector secrets, supports a generic REST fetch-and-map connector, and blocks non-SELECT AI SQL.

Agent guardrails are part of the MVP baseline: `/ai/guardrails/inspect` rejects obvious prompt-injection payloads from user/RAG content and masks email/card-like PII before audit logging. Audit entries are modeled as append-only in the PostgreSQL bootstrap SQL.

## MVP Coverage

- Faz 0: monorepo, CI, Docker Compose, health checks
- Faz 1: JWT auth, RBAC, tenant isolation, PostgreSQL RLS bootstrap
- Faz 2: CSV schema preview, encrypted SQL connector storage, generic REST connector
- Faz 3: ETL job endpoint with idempotency and dead-letter capture
- Faz 4: FastAPI sales forecast and anomaly endpoints
- Faz 5: read-only SQL guardrail, prompt-injection/PII guardrail, tenant-scoped RAG citations, agent workflow endpoint
- Faz 6: Next.js dashboard with metrics, import preview, charts, record table, AI/RAG status, PDF/CSV export backend
- Faz 7: audit, tenant AI-token usage counters, notification outbox
- Faz 8: backend Prometheus metrics endpoint, Prometheus and Grafana compose services
- Faz 9: CI plus backend, ML, and frontend verification commands

## Verification

```powershell
dotnet test backend\EnterpriseAIAnalytics.sln
pytest ml-service
python -m ruff check ml-service
cd frontend
npm run lint
npm run build
```
