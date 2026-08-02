# Changelog

## Unreleased — production hardening

### Security

- Added fail-closed production configuration validation and mandatory internal ML authentication.
- Added short-lived access tokens, refresh rotation/reuse detection and session revocation.
- Enforced PostgreSQL forced RLS across tenant data-plane, usage and billing tables.
- Replaced e-mail-based demo bypasses with organization entitlements and atomic quotas.
- Hardened CSV/XLSX upload validation and removed the vulnerable `xlsx` dependency.
- Hashed provider checkout tokens and normalized subscription state transitions.

### Operations

- Hardened Compose isolation/resources/log rotation and removed PostgreSQL from the edge network.
- Added encrypted age PostgreSQL backups, backup health and isolated restore checks.
- Added structured request correlation and ML/LLM Prometheus metrics.
- Added pinned Trivy container/repository security gates.

### Clients and AI

- Removed the Android hardcoded API IP; production mobile builds require an explicit HTTPS endpoint.
- Added client-wide access-token refresh support.
- Added bounded LLM retry, token accounting and micro-USD cost audit records.
