# Managed agent runner

Use this file as the table of contents for workflow-specific instructions for the managed-agent runner. Keep generic SQL, MCP, and provider capability guidance in their own skills or provider code; keep this file focused on how the runner composes those parts.

## Read first

- [Managed agent workflow](docs/agents/managed-agent-workflow.md)
- [Evidence context](docs/agents/evidence-context.md)
- [Document review](docs/agents/document-review.md)
- [Tool schema boundary](docs/agents/tool-schema-boundary.md)

## Ownership rules

- The generic `sql` skill owns SQL and SQLite mechanics only.
- Provider skills own provider capability guidance only.
- MCP servers own generic tool descriptions and input schemas.
- The managed-agent runner (in `brikell-report-worker/src/agent/managed/`) owns:
  - authentication and runtime tool bridging
  - app-managed skill bootstrap: resolve deterministic uploaded skill references, wire them into process env, and fail loudly before session creation if bootstrap cannot complete
  - SQL ingestion
  - datasource diagnostics
  - passive managed-output mirroring for files written under `/mnt/session/outputs/`
  - **connection resilience** for the managed-agent client: long-lived undici fetch in `src/agent/managed/streaming-fetch.ts` and stream-disconnect → polling fallback in `src/agent/managed/session-stream-resilience.ts`
  - **structured error diagnostics** with full cause-chain walking (`createManagedRunnerErrorDiagnostic`) so the app layer can surface friendly user-facing messages instead of opaque "Connection error." strings
- The Railway report worker owns durable report-job claiming, heartbeats, stale-job recovery, and invoking `startReportJob(jobId)` outside the Vercel request lifecycle.
- This `agents.md` layer owns workflow-specific guidance for the managed-agent runner.

Schema compatibility: any custom tool exposed to the agent must NOT include `additionalProperties` or other JSON-Schema keys Anthropic's tools API rejects. See `src/agent/managed/managed-tool-schema.ts:COMPATIBILITY_DROPPED_SCHEMA_KEYS` and the managed-tool-schema regression tests.
