# ADR-008 Vector Store

## Decision
Use Qdrant for RAG vector search in the local stack.

## Alternatives
pgvector, Elasticsearch vector fields.

## Rationale
Qdrant is simple to run locally, has a clear HTTP API, and keeps vector workload separate from transactional PostgreSQL during early development.
