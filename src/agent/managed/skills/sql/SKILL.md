---
name: sql
description: Generic SQL and SQLite workflow guidance. Use for inspecting relational schemas, writing safe bounded queries, validating SQLite availability, handling query diagnostics, preserving provenance, and performing transactional SQL work. This skill is provider-agnostic and workflow-agnostic.
---

# SQL

Use this skill for SQL mechanics only. Apply project-specific workflow policy from the nearest `AGENTS.md`.

## Core workflow

1. Inspect available tables, columns, indexes, and constraints before writing non-trivial queries.
2. Prefer bounded read-only queries unless the task explicitly requires writes.
3. For writes, use transactions and verify row counts or returned records.
4. Keep facts, assumptions, diagnostics, and missing data separate.
5. Preserve provenance: record which database, table, query, timestamp, or artifact produced a result.
6. Surface query failures clearly. Do not convert failed queries into factual evidence.
7. Never log secrets, credentials, authorization headers, or personal data unless the task explicitly requires secure handling of that field.

## References

- `references/sqlite.md`
- `references/query-workflow.md`
- `references/safety.md`
