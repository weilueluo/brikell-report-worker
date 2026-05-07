# SQLite

## Runtime checks

Validate SQLite availability before starting workflows that depend on it:

```bash
sqlite3 --version
sqlite3 ':memory:' 'select sqlite_version();'
```

The command output should include a SQLite version. Empty output or a non-zero exit means the runtime is not ready for SQLite-dependent work.

## Brikell session store

The canonical sandbox database is `/mnt/session/data/store.db`. It is created by `data-collection/scripts/init_store.py` and auto-migrated by `ingest_collection.py` when missing.

Core tables:

- `collections` — one row per `mcp.*` collection attempt; raw JSON lives in `response_json` with planning document text stripped to refs.
- `collection_keys` — index-only lookup rows for address, property, parcel, building, unit, plan, and document ids.
- `documents` — canonical extracted planning document text and page offsets.
- `documents_fts` — FTS5 external-content index over `documents.text`.

## Operational notes

- Use `/mnt/session/data/store.db` for collection exploration.
- Use `:memory:` only for throwaway checks and isolated tests.
- Prefer WAL mode for local session stores that may receive multiple sequential writes.
- Keep schema migrations deterministic and idempotent.
