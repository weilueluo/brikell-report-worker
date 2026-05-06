# Managed agent workflow

The bridge accepts a user message, discovers MCP tools from configured datasource providers, resolves app-managed skill references, creates a managed session, and handles custom tool calls locally. For report jobs, that bridge runs inside the Railway report worker, not inside the Vercel request that created the queued job.

## Runtime flow

1. Discover MCP tools with `tools/list`.
2. Convert each discovered tool into a managed custom tool using the MCP server's name, description, and input schema.
3. Bootstrap local skills from `skills/`: hash each skill, reuse the matching uploaded skill by deterministic title, create it only when absent, and wire the resolved ID/version into the app process env.
4. Start a new managed session with built-in file/search tools plus custom datasource tools.
5. Buffer datasource custom tool calls until `session.status_idle` reports `stop_reason.type = "requires_action"`, then execute and answer the exact `stop_reason.event_ids` through the local bridge so credentials stay local.
6. Ingest successful datasource results into session SQLite before returning bounded context to the managed runtime.
7. Record datasource validation or tool errors as diagnostics, not facts.
8. Mirror successful managed-output writes under `/mnt/session/outputs/` host-side after the runtime completes tool calls.

Freshness comes from creating a new managed session. Do not delete host-side run logs, mirrored outputs, SQL captures, or document artifacts to make a run fresh.

## Worker boundary

Vercel owns report-job creation and polling only. The Railway worker owns durable job claims, heartbeats, stale-job recovery, managed-session execution, datasource tool bridging, output mirroring, and app-owned artifact persistence through `startReportJob(jobId)`. Do not add managed-session loops back into API routes.

## Protocol boundary

The managed runner under `brikell-report-worker/src/agent/managed/` is the only supported managed-session bridge in this workspace. Do not add standalone demo bridges or duplicate session loops. Shared session protocol rules, including custom-tool result selection from `requires_action.event_ids`, belong in small modules under `src/agent/managed/` and must have deterministic replay tests.

## Document-link workflow

When a datasource result or user input includes relevant document links or attachments:

1. Preserve and report the link metadata: URL, title/name, source field, source record, and provenance.
2. For property, planning, capacity, due-diligence, or similar reports, follow relevant explicit document links to gather more information when the link is likely to contain requested facts.
3. Fetch explicit URLs inside the managed session with the configured document tools. Keep intermediate downloads in the session workspace, not host-side artifact directories.
4. Extract native text first with PDF text tooling, then OCR only when native text is missing or insufficient.
5. Record source URL, final URL, file hash, content type, extraction method, warnings, and page numbers before using document text.
6. Use page-referenced extracted text as evidence for document-derived claims.
7. If document content was not fetched or reviewed, label the URL as metadata only.

## Instruction sources

Use uploaded skills for generic capabilities. Use this `AGENTS.md` tree for app-specific workflow policy. Do not copy this policy into generic skills or provider MCP tool descriptions.

## Output policy

Write final deliverables under `/mnt/session/outputs/<jobId>/`. Report runs use `report.md` for the mandatory Markdown deliverable and `report.json` for optional canonical V1 JSON.

Final evidence, citation, and consistency checks belong in the managed-runtime workflow before writing those final files. The bridge passively mirrors successful output writes; it does not validate, reject, repair, or acknowledge report finalization content. Host-side mirrors and run logs are bridge-managed artifacts, not managed-runtime workspace inputs. Do not inspect host-side artifact directories from the managed session.
