# Datafordeler runtime capability discovery

Do not assume a fixed action list. The managed runtime exposes Datafordeler capabilities from the MCP server's current tool metadata. Select tools from the runtime-provided names, descriptions, and input schemas.

## Selection loop

1. Inspect the discovered Datafordeler tool metadata before the first call.
2. Prefer provider-native overview, context, coverage, or status capabilities when they are available.
3. Read returned `meta`, `graphSummary`, `included`, `omitted`, `availableExpansions`, `nextActions`, warnings, and provenance before deciding on follow-up calls.
4. For follow-up calls, choose the narrowest discovered capability that directly matches the needed expansion.
5. Stop once the returned metadata is sufficient for the user-facing answer or the next bounded retrieval step.

## Input shaping

- Pass the selected tool's schema directly. Do not use an `action`/`arguments` wrapper unless the runtime-discovered schema explicitly requires it.
- Validate required fields, enum values, limits, pagination fields, and public-data flags against the selected schema.
- Use public lookup inputs only: address text, DAR address ids from confirmed address candidates, BFE/property identifiers, or cadastral identifiers when supported.
- Keep page sizes and graph/source-record expansions bounded.
- Do not request owner, person, EJF, or restricted data.

## Retrieval guidance

- Use overview/context metadata as the navigation map for graph, building, unit, parcel, and source-record detail.
- Treat broad graph/source-record capabilities as explicit expansion or debugging tools, not as the default path.
- Preserve source-family provenance when available: BBR, DAR, MAT, EBR, and any provider-returned request/source trace identifiers.
- Do not infer exact unit counts or distributions from address records, spatial hints, or compact summaries. Require explicit structured BBR unit/source-record evidence.

## Result metadata handoff

Capture metadata that helps downstream consumers preserve context: canonical property identifiers, source register, request ID, observed/retrieved timestamps, confidence/warnings, omitted sections, provenance, and any provider-returned expansion hints.
