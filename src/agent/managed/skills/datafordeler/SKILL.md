---
name: datafordeler
description: Retrieves and summarizes public Danish property registry data from Datafordeler. Use for property identity, BFE, address resolution, buildings, units, parcels, BBR/DAR/MAT/EBR source records, registry status, coverage, and public property context. Prefer this skill whenever the user asks about Datafordeler or Danish property registry information.
---

# Datafordeler

Use this skill to work with public Danish property registry information from Datafordeler.

Use the Datafordeler datasource tools discovered at runtime. Inspect the available tool names, descriptions, and input schemas before calling anything; do not assume a fixed action list or wrap calls in an `action`/`arguments` envelope.

For SQL mechanics, use the generic `sql` skill. For this repository's managed-agent workflow policy, follow `AGENTS.md`.

## Workflow

1. Choose the narrowest discovered capability that matches the task. Prefer provider-native overview/context capabilities when available, then follow returned `availableExpansions` and `nextActions`.
2. Validate arguments against the selected tool schema. Keep requests bounded and pass only public lookup inputs such as address, DAR address id, BFE, or cadastral identifiers.
   - `get_property_context` requires exactly one of `input` or `propertyId`.
   - `input.type: "address"`, `input.type: "dar_address_id"`, and `input.type: "bfe"` require `value`.
   - `input.type: "jordstykke"` requires `ejerlavKode` and `matrikelnummer`.
3. Use deeper graph, building, unit, parcel, or source-record capabilities only when the overview metadata says they are needed.
4. Summarize only public-data facts. State that owner, person, EJF, and restricted data are not enabled when relevant.
5. Preserve provenance by mentioning the register/source family when available: BBR, DAR, MAT, or EBR.
6. Do not infer exact unit counts or distributions from spatial hints, summaries, or address records; require explicit BBR unit/source-record evidence.
7. If a Datafordeler call returns a validation error, correct the arguments and retry when the schema and task indicate a safe correction.

## Capability discovery reference

Read `references/capabilities.md` for runtime capability-discovery guidance, input-shaping rules, and Datafordeler-specific safety boundaries.
