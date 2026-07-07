# ADR-005 Connector Secrets

## Decision
Encrypt connector secrets before storing them and decrypt only at runtime. REST connectors use request-time headers for API keys and a small field mapping dictionary so customer-specific APIs can be queried without hard-coded integrations.

## Alternatives
Plaintext storage, external Vault only, or one custom connector per vendor API.

## Rationale
The MVP needs a local-friendly default while preserving the right security boundary. The encryption service can later be replaced by Vault without changing connector APIs. A generic REST fetch-and-map connector keeps the first integration surface flexible while still being simple enough to test deterministically.
