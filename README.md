# Brikell Report Worker (`@brikell/report-worker`)

Long-running Railway service that claims queued report jobs from Supabase, executes a managed Anthropic agent over the Datafordeler / Plandata / Dataforsyningen MCP tools, mirrors the agent's output files, persists draft artifacts and MCP evidence, then transitions the job to `awaiting_review` for the human reviewer in `brikell-report-app`.

## Boundaries

- **Owns** — managed-agent runner, MCP tool bridge, prompt + agents.md, skill provisioning, canonical V1 evaluation, draft artifact persistence, PDF rendering, job-pipeline transitions (running → rendering_pdf → awaiting_review / failed).
- **Does not own** — the UI, address autocomplete, vault read/search APIs, the assistant, the human approval endpoint. Those live in `brikell-report-app`.
- **Shared via `@brikell/shared`** — schemas (`ReportJob`, `VaultItem`, `Assignment`, `Address`, canonical V1), Supabase stores, error/format helpers, and the per-record provenance contract (`_ref` stamping + validation).

The worker only ever talks to the app indirectly, through Supabase tables and the artifact bucket. It must not import from `brikell-report-app`, and `brikell-report-app` must not import from this package.

## Local development

From the monorepo root:

```powershell
pnpm install
pnpm --filter @brikell/report-worker typecheck
pnpm --filter @brikell/report-worker test
pnpm --filter @brikell/report-worker start          # run the worker loop locally
```

Required env (the same set on Railway in production):

- `SUPABASE_URL`
- `SUPABASE_SECRET_KEY` (or legacy `SUPABASE_SERVICE_ROLE_KEY`)
- `SUPABASE_STORAGE_BUCKET`
- `ANTHROPIC_API_KEY`
- datasource MCP URLs/tokens/origins (`DATAFORDELER_MCP_URL`, `PLANDATA_MCP_URL`, `DATAFORSYNINGEN_MCP_URL`, etc.)
- optional pacing/staleness: `BRIKELL_REPORT_WORKER_ID`, `BRIKELL_REPORT_WORKER_POLL_MS`, `BRIKELL_REPORT_WORKER_HEARTBEAT_MS`, `BRIKELL_REPORT_WORKER_STALE_MS`, `BRIKELL_REPORT_WORKER_CONCURRENCY=1`

For UI work that doesn't need a real agent run, leave the live worker stopped and start the test-fixture runner instead:

```powershell
pnpm --filter @brikell/report-worker start:e2e-fixture
```

That entrypoint exists only for tests and Playwright smoke runs — production deploys never reference it.

## Verification

```powershell
pnpm typecheck
pnpm test          # unit + integration (no external creds required)
pnpm test:unit     # pure logic only
pnpm test:integration
pnpm test:e2e      # Anthropic + live network — requires ANTHROPIC_API_KEY
```

The worker test suite covers:

- managed-agent runner unit tests (`streaming-fetch`, `session-stream-resilience`, `terminal-events`, `session-events-send`, managed-output mirroring, managed-tool-schema, session SQL store);
- canonical V1 evaluation, PDF blocks/render, format-error;
- the worker-side `report-service` execution path (`startReportJob`, `formatProgressMessageForUser`, vault-link resolution, no-artifact failure semantics).

`tests/managed/streaming-fetch.e2e.test.ts` and `tests/managed/anthropic-api.e2e.test.ts` are real-network/real-API tests that run only via `pnpm test:e2e`. The Anthropic test requires `ANTHROPIC_API_KEY` and costs roughly $0.0001 per run via Haiku.

### Replay runner and recorded transcripts

Worker integration tests that need a realistic runner — and the Playwright `webServer` for the app — drive a `replayReportRunner` instead of the live Anthropic agent. Recorded transcripts live in `tests/fixtures/transcripts/*.jsonl` and follow the NDJSON contract exported from `@brikell/shared/test-helpers` (`parseTranscript`, `serializeTranscript`).

To capture a new transcript from a real run:

```powershell
pnpm tsx scripts/record-agent-transcript.ts --scenario <name> --address-id <id> --address-label "<label>"
```

The recorder calls `runReportAgent` against the live runner, sanitises Windows paths and any `sk-(ant|live)-...` API keys before writing, and emits a single JSONL file. The synthetic builder used to seed the canonical fixtures is `tests/fixtures/transcripts/build-fixtures.ts` and produces `basic-success.jsonl` (two stamped tool calls → canonical V1 final) plus `runner-error.jsonl` (one failed tool call, canonical absent). Replay tests refuse a transcript whose tool-call results are not stamped with `_ref`, so recordings are guaranteed post-stamping.

### Cancellation

The worker loop owns one `CancellationState` per claimed job (`src/cancellation.ts`) and forwards its `signal` into `runner.run`. The live runner short-circuits the managed-message Promise.race on abort. Pure unit tests for the state machine live in `tests/cancellation.unit.test.ts`.

## Provenance contract (statically enforced)

Every record returned by an MCP tool must carry a `_ref` field — `{ source: DataSourceName, upstreamId?, fetchedAt, endpoint? }` — defined in `@brikell/shared/src/provenance/`.

1. The MCP servers stamp `_ref` at the service boundary (`stampProvenance`).
2. The runtime tool bridge in `src/agent/managed/` validates every response against `provenancedRecordSchema`. An unstamped record short-circuits the agent's tool call with `is_error: true` and the structured event `bridge_missing_provenance`. The agent never sees an unstamped record.
3. The vault projection (`metadata.dataSources`, `metadata.upstreamIds`) is filled at write time, so search/filter does not have to walk full payloads.
4. Canonical V1 citations of the form `mcp:<source>:<upstreamId>` are resolved by `linkSourceDocumentsToVault` to the corresponding vault item's `vault:<id>` after the run.

## Managed skill provisioning

The worker bootstraps managed skills before creating a managed session. It hashes each checked-in skill directory under `src/agent/managed/skills/`, reuses an existing uploaded skill with the deterministic title `<Display title> <hash>`, creates it only when absent, and wires the resolved ID/version into `process.env`. The bridge requires both `data-collection` and `sql`. If bootstrap cannot resolve every required skill, the claimed report job fails loudly before a managed session is attempted.

`DATA_COLLECTION_SKILL_ID` and `SQL_SKILL_ID` are optional overrides, not hand-maintained deployment requirements. Set `MANAGED_AGENT_REQUIRE_CONFIGURED_SKILLS=on` only for environments where runtime skill creation/listing must be disabled; then every active `*_SKILL_ID` must be provided and non-empty.

## Managed-agent connection resilience

The Anthropic managed-agent SSE stream stays open for the full agent run, with multi-minute silent windows during server-side tool execution. Two layers of resilience handle this:

1. **Long-lived undici fetch** (`src/agent/managed/streaming-fetch.ts`): managed-agent calls go through npm undici's `fetch` with `bodyTimeout: 0` so the socket survives long quiet windows. Node's built-in fetch (with its 5-minute `bodyTimeout` default) is bypassed only on this path.
2. **Stream-disconnect → polling fallback** (`src/agent/managed/session-stream-resilience.ts`): if the SSE stream throws mid-iteration (transient network blip), the iterator switches to polling `events.list({ order: "asc" })` and dedupes by event ID until the session reaches a terminal status. Capped at 30 minutes of polling.

If the long-lived dispatcher cannot be loaded (bundler stripping, missing native binding, etc.) the wrapper logs a structured `managed_agent_fetch_fallback` error and degrades to the default fetch (5-min cap restored). Watch for that event in production logs.

## Report file handoff

The agent writes final outputs to deterministic managed-runtime paths: `/mnt/session/outputs/<jobId>/report.md` for the required Markdown report and `/mnt/session/outputs/<jobId>/report.json` for optional canonical V1 JSON. The bridge passively mirrors successful `write`/`edit` operations under `/mnt/session/outputs/` into the worker's local output mirror; it does not validate, reject, or repair report content and it does not send a finalization tool result back to the managed session.

After the managed run ends, `src/agent/runner-client.ts` reads the mirrored files and `src/reports/report-service.ts` persists draft artifacts, job metadata, MCP evidence, and optional canonical JSON, then moves the job to `awaiting_review`. If the agent finishes without writing `report.md`, the report-service marks the job `failed` with a `no_artifact_submitted` warning and a regenerate prompt; no fake report artifact is persisted.

The human reviewer in `brikell-report-app` then approves or rejects. There is no deterministic verifier gate — the human reviewer is the gate.

## Deployment

Railway service `brikell-report-worker` is built from this package's `Dockerfile` against the **monorepo root** as build context. `railway.json` already points at `brikell-report-worker/Dockerfile`. The Railway service must be configured with:

- Root directory: monorepo root (or unset).
- Dockerfile path: `brikell-report-worker/Dockerfile`.
- Start command: provided by the Dockerfile (`pnpm --filter @brikell/report-worker start`).

Run `pnpm cicd --railway-only report-worker` from `brikell-report-app/` (which still owns the deploy script) to deploy just this service after the predeploy checks defined in `brikell-report-app/scripts/railway-deploy.mjs`.
