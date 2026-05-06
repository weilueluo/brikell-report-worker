# SQL safety

- Do not interpolate untrusted text into SQL. Use bound parameters where available; otherwise use a well-scoped escaping helper.
- Bound large scans with `LIMIT` during exploration.
- Avoid destructive writes unless explicitly requested and recoverable.
- Do not silently ignore failed writes or constraint errors.
- Redact secrets and personal data in logs and summaries.
- Keep raw dumps out of user-facing output unless the user asked for raw data.
