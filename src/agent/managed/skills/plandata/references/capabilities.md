# Plandata runtime capability discovery

Do not assume a fixed action list. The managed runtime exposes Plandata capabilities from the MCP server's current tool metadata. Select tools from the runtime-provided names, descriptions, and input schemas.

## Selection loop

1. Inspect the discovered Plandata tool metadata before the first call.
2. Prefer provider-native planning context, coverage, layer-description, or status capabilities when they are available.
3. Read returned `meta`, `records`, public source `properties`, `fieldProvenance`, `plans`, `documents`, `included`, `omitted`, `availableExpansions`, `nextActions`, warnings, and provenance before deciding on follow-up calls.
4. For follow-up calls, choose the narrowest discovered capability that directly matches the needed layer, geometry, plan, document-link, or public-record detail.
5. Stop once the returned metadata is sufficient for the user-facing answer or the next bounded retrieval step.

## Input shaping

- Pass the selected tool's schema directly. Do not use an `action`/`arguments` wrapper unless the runtime-discovered schema explicitly requires it.
- Validate required fields, geometry shape, layer selectors, plan identifiers, limits, pagination fields, and inclusion flags against the selected schema.
- Use the most precise bounded geometry available. If the user gives only an address, derive geometry through a property/address datasource first.
- Narrow broad results by geometry, plan ID, municipality, layer group, cursor, or structured filters.

## Retrieval guidance

- Use planning context metadata as the navigation map for layer, geometry, plan, public-record, and document-link detail.
- Treat layer/geometry/public-record capabilities as explicit expansion or debugging tools after context metadata is insufficient.
- Treat document outputs as link metadata unless the selected tool explicitly returns downloaded, extracted, or OCRed content.
- Do not call a plan current/active unless structured status fields support it. Cancelled, historical, ambiguous, or missing statuses require caveats.

## Result metadata handoff

Capture metadata that helps downstream consumers preserve context: plan identifiers, layer/source identifiers, public source properties, field provenance, status fields, geometry metadata, document links, observed/retrieved timestamps, warnings, omitted sections, provenance, and any provider-returned expansion hints.
