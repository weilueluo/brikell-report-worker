# Query workflow

## Read path

1. Ensure the relevant `mcp.*` handle has been ingested with the `data-collection` skill.
2. Discover schema in `/mnt/session/data/store.db`.
3. Identify the smallest set of tables needed.
4. Write a bounded query.
5. Check result shape and row counts.
6. Summarize only what the query supports.

## Brikell patterns

Latest successful property collection:

```sql
SELECT *
FROM collections
WHERE intent='property.collect' AND status='success'
ORDER BY fetched_at DESC
LIMIT 1;
```

Lookup by a collected id:

```sql
SELECT collections.*
FROM collections
JOIN collection_keys USING (collection_id)
WHERE key_kind=? AND key_value=?
ORDER BY fetched_at DESC
LIMIT 10;
```

Search document text with FTS:

```sql
SELECT documents.upstream_id,
       snippet(documents_fts, 0, '[', ']', ' … ', 12) AS snippet
FROM documents_fts
JOIN documents ON documents_fts.rowid = documents.rowid
WHERE documents_fts MATCH ?
LIMIT 10;
```

Use `json_extract(collections.response_json, '$.path')` and `json_each` for envelope exploration.

## Write path

1. Confirm writes are in scope.
2. Use a transaction.
3. Apply the change with explicit predicates.
4. Verify affected rows.
5. Commit only after verification succeeds.

## Diagnostics

Treat syntax errors, missing tables, constraint failures, and empty result sets as separate states. An empty result is not the same as a failed query.
