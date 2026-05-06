---
name: dataforsyningen
description: Retrieves and summarizes public Danish geodata from Dataforsyningen. Use for address/place search, approved WFS and OGC API Features queries, WMS/WMTS map descriptors, service capabilities, coverage, and safety-boundary checks. Prefer this skill whenever the user asks about Dataforsyningen, Danish base maps, geodata layers, administrative boundaries, terrain/rain layers, or address/place lookup.
---

# Dataforsyningen

Use this skill to work with public Danish geodata from Dataforsyningen.

Use the Dataforsyningen datasource tools discovered at runtime. Inspect the available tool names, descriptions, and input schemas before calling anything; do not assume a fixed action list or wrap calls in an `action`/`arguments` envelope.

For SQL mechanics, use the generic `sql` skill. For this repository's managed-agent workflow policy, follow `AGENTS.md`.

## Workflow

1. Choose the narrowest discovered capability that matches the task. Prefer coverage/capability/service-discovery operations when service type, token policy, limits, or layer support are unclear.
2. Validate arguments against the selected tool schema. Keep requests bounded with small limits, bounding boxes, or provider-supported filters.
3. Use provider-supported address/place search capabilities for Danish address, access-address, or place candidates; do not assume a deprecated endpoint or exact tool name.
4. Query WFS/OGC features only after a discovered capability confirms the service, layer/collection, and required bounded parameters.
5. Treat WMS/WMTS outputs as descriptor metadata unless a discovered tool explicitly returns image or tile bytes.
6. Summarize public geodata facts with provenance and state coverage/safety limits when relevant.
7. When Dataforsyningen geometry or address candidates are used to drive another lookup, include Dataforsyningen attribution in the final answer.

## Capability discovery reference

Read `references/capabilities.md` for runtime capability-discovery guidance, input-shaping rules, and Dataforsyningen-specific safety boundaries.
