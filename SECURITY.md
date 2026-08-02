# Security Policy and Controls

## Reporting

Do not open a public issue containing customer data, credentials or an exploit. Report privately to the repository owner with affected version, reproduction steps and impact. Rotate any credential that appeared in chat, logs or Git history.

## Authentication

- Passwords use memory-hard scrypt (`N=32768`, 64-byte output); legacy PBKDF2 hashes are upgraded on successful login.
- Access JWT lifetime is 5–60 minutes (`1800` seconds default), with fixed issuer/audience/algorithm.
- Opaque refresh tokens are stored only as SHA-256 hashes, rotate on every use, and revoke their whole family plus access-token version when reuse is detected.
- Password reset and verification tokens are opaque, hashed, expiring and atomically single-use.
- Logout, password reset and password change revoke previous refresh families and access-token versions.
- Login and email actions have brute-force limits; unlimited commercial entitlements do not bypass abuse limits.

Web sessions use `HttpOnly; SameSite=Lax; Secure` cookies in production. Native/API clients receive bearer and refresh tokens. Mobile tokens are never compiled into the application.

## Authorization and tenancy

RBAC is enforced in Express, not only in React. Organization context comes from authenticated membership. PostgreSQL forced RLS is the second enforcement layer. RLS policies and pool-context cleanup are integration-tested against PostgreSQL.

The two global billing scope tables contain opaque routing material only. They enable signed provider callbacks to discover a tenant; subsequent billing reads/writes run in a tenant transaction.

## Secrets

Production startup fails if database URL, JWT secret, ML key, encryption key or HTTPS app URL is unsafe. Partial billing configuration also fails. External AI/email secrets become mandatory when those features are enabled. Never commit `.env`, age identities, signing keys or provider credentials.

## Uploads

Dataset uploads are bounded by bytes, rows, columns and parse time. Extension, declared MIME and file signatures must agree. XLSX archives reject traversal, encryption, macros, suspicious compression ratios and formulas. CSV/Excel formula prefixes are neutralized. Temporary files use server-generated names and are removed after processing.

Virus scanning is not bundled in the application image. Environments that require malware scanning must place a scanning/quarantine gateway before `/api/upload`; this remains a release gate for regulated deployments.

## Payments

Card fields are rejected and checkout is provider-hosted. Subscription webhooks require iyzico V3 HMAC, use provider event IDs for idempotency, and re-fetch subscription state from the provider. AI-credit completion validates token, conversation, basket, TRY amount, paid amount, fraud status and response signature. Provider tokens are hashed at rest.

The iyzico subscription webhook exposes renewal success/failure events; refunds and chargebacks require an operational reconciliation job/provider report because the subscription webhook contract does not provide dedicated events. Do not claim automated refund/chargeback handling until that reconciliation is implemented and tested.

## Logging

Production logs are structured and include request ID, endpoint, status, duration and authenticated organization/user when known. Logger redaction removes password, token, cookie, authorization, key and secret fields. Public errors omit stack traces, SQL and filesystem paths.

## Release gates

CI runs TypeScript, unit/integration tests, npm audits, PostgreSQL RLS tests, Ruff/pytest/pip-audit, .NET build/tests, Next build/audit, Docker builds and pinned Trivy scans. A high/critical result is a failed gate, not a warning-only job.
