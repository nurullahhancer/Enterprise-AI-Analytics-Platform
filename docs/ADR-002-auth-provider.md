# ADR-002 Auth Provider

## Decision
Use Keycloak as the self-hosted OAuth2/OIDC provider in Docker Compose.

## Alternatives
IdentityServer, hosted Auth0/Entra ID.

## Rationale
Keycloak is free, self-hostable, supports tenant-aware claims and roles, and fits enterprise pilots that cannot send identity data to a hosted provider.
