# ADR-011 - MVP Completion Scope

## Decision

The MVP ships a working monorepo with testable implementations for authentication, tenant isolation, data import, ETL jobs, ML prediction, anomaly detection, RAG-style document citations, guarded AI SQL, report export, notifications, billing counters, and observability.

## Alternatives

- Build every production subsystem fully before exposing any end-to-end flow.
- Keep only skeleton services and defer integration behavior.

## Why This Was Chosen

The instruction set asks for a complete, runnable system rather than skeleton code. A pragmatic MVP keeps production boundaries visible while using lightweight in-memory implementations where full infrastructure would slow local delivery: notification outbox instead of SMTP, simple tenant-scoped document chunks instead of a full embedding pipeline, and minimal PDF/CSV export instead of a dedicated reporting service.

## Consequences

The system is runnable and covered by automated tests, but several components are intentionally MVP-grade. Production hardening should replace in-memory stores with PostgreSQL migrations, connect RabbitMQ consumers, add real embedding generation for Qdrant, configure Grafana dashboards, and wire Keycloak as the external OIDC issuer.
