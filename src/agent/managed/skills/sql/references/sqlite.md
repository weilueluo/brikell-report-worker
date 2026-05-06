# SQLite

## Runtime checks

Validate SQLite availability before starting workflows that depend on it:

```bash
sqlite3 --version
sqlite3 ':memory:' 'select sqlite_version();'
```

The command output should include a SQLite version. Empty output or a non-zero exit means the runtime is not ready for SQLite-dependent work.

## Operational notes

- Use a file-backed database for session state that must outlive one process.
- Use `:memory:` only for throwaway checks and isolated tests.
- Prefer WAL mode for local session stores that may receive multiple sequential writes.
- Keep schema migrations deterministic and idempotent.
