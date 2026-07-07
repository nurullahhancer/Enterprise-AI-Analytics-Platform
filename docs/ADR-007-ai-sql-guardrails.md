# ADR-007 AI SQL Guardrails

## Decision
Allow only read-only SQL through the AI query path.

## Alternatives
Let the LLM execute arbitrary tool calls, rely only on prompts.

## Rationale
Prompt-only safety is insufficient. A deterministic SQL guard blocks write and DDL verbs before any query execution path can run.
