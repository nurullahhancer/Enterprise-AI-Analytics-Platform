# ADR-010 Observability

## Decision
Plan OpenTelemetry metrics/traces and Prometheus/Grafana dashboards.

## Alternatives
Only application logs, vendor-specific APM first.

## Rationale
OpenTelemetry avoids early vendor lock-in and fits the distributed backend, ML, ETL, and agent services.
