# ADR-004 Tenant Isolation

## Decision
Combine application tenant context with PostgreSQL Row-Level Security policies.

## Alternatives
Manual `WHERE tenant_id` filters, separate database per tenant.

## Rationale
Manual filters are easy to forget. Database RLS gives a second enforcement layer while keeping the MVP simpler than database-per-tenant operations.
