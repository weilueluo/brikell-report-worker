# Query workflow

## Read path

1. Discover schema.
2. Identify the smallest set of tables needed.
3. Write a bounded query.
4. Check result shape and row counts.
5. Summarize only what the query supports.

## Write path

1. Confirm writes are in scope.
2. Use a transaction.
3. Apply the change with explicit predicates.
4. Verify affected rows.
5. Commit only after verification succeeds.

## Diagnostics

Treat syntax errors, missing tables, constraint failures, and empty result sets as separate states. An empty result is not the same as a failed query.
