# Dataforsyningen runtime capability discovery

Do not assume a fixed action list. The managed runtime exposes Dataforsyningen capabilities from the MCP server's current tool metadata. Select tools from the runtime-provided names, descriptions, and input schemas.

## Selection loop

1. Inspect the discovered Dataforsyningen tool metadata before the first call.
2. Prefer coverage, capability, service-discovery, or descriptor metadata capabilities when service support, limits, token policy, or layer/collection shape is unclear.
3. Read returned `structuredContent`, `meta`, service summaries, capabilities, descriptors, safety metadata, warnings, and provenance before deciding on follow-up calls.
4. For follow-up calls, choose the narrowest discovered capability that directly matches the needed address/place, service, feature, or descriptor task.
5. Stop once the returned metadata is sufficient for the user-facing answer or the next bounded retrieval step.

## Input shaping

- Pass the selected tool's schema directly. Do not use an `action`/`arguments` wrapper unless the runtime-discovered schema explicitly requires it.
- Validate required fields, enum values, service identifiers, layer/collection names, CRS, bbox, limits, and pagination fields against the selected schema.
- Keep feature requests bounded with small bboxes, limits, and provider-supported filters.
- Do not pass upstream URLs, headers, raw query strings, tokens, or arbitrary service names.
- Use provider-supported address/place search capabilities for Danish address, access-address, or place candidates; do not assume a deprecated endpoint or exact tool name.

## Retrieval guidance

- Confirm service/layer/collection metadata before feature retrieval whenever the service is not already known from a trusted prior response.
- Treat WMS/WMTS responses as map/tile descriptor metadata unless the selected tool explicitly returns image or tile bytes.
- Treat coverage/raster support as metadata-only unless the selected tool explicitly supports bounded raster retrieval.
- Attribute Dataforsyningen-derived geometry, address candidates, and service metadata when they drive another datasource lookup.

## Result metadata handoff

Capture metadata that helps downstream consumers preserve context: source service ID/type, layer or collection, CRS, bbox, request hash or request ID, observed/retrieved timestamps, token/credential policy, safety warnings, provenance, and any returned expansion or descriptor hints.
