# ADR-003 Backend Architecture

## Decision
Use .NET 8 Clean Architecture with Domain, Application, Infrastructure, API, and Tests projects.

## Alternatives
Single ASP.NET Core project, vertical slice only.

## Rationale
ETL, tenancy, connectors, AI guardrails, and audit behavior need testable boundaries. The layered solution keeps domain contracts independent from HTTP and database details.
