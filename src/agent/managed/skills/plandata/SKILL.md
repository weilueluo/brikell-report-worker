---
name: plandata
description: Retrieves and summarizes public Danish planning data from Plandata. Use for local plans, municipal plan frames, plan documents, WFS layers, geometry intersections, plan IDs, public planning records, layer coverage, and planning restrictions. Prefer this skill whenever the user asks about Plandata or Danish public planning context.
---

# Plandata

Use this skill to work with public Danish planning information from Plandata.

Use the Plandata datasource tools discovered at runtime. Inspect the available tool names, descriptions, and input schemas before calling anything; do not assume a fixed action list or wrap calls in an `action`/`arguments` envelope.

For SQL mechanics, use the generic `sql` skill. For this repository's managed-agent workflow policy, follow `AGENTS.md`.

## Workflow

1. Identify whether the user has a geometry, address-derived geometry, plan ID, layer name, or general coverage question.
2. Choose the narrowest discovered capability that matches the task. Prefer provider-native planning context/coverage capabilities when available, then follow returned `availableExpansions` and `nextActions`.
3. Validate arguments against the selected tool schema. Keep geometry and layer queries bounded.
   - Planning context lookups require one of `geometry`, `planId`, or non-empty `planIds`.
4. Treat document capabilities as document-link metadata unless a discovered tool explicitly returns downloaded/read document content.
5. Summarize public planning records with provenance and note coverage limitations when warnings or exclusions are returned.
6. Do not call a plan current/active unless structured status fields support it. Cancelled, historical, ambiguous, or missing statuses require caveats.
7. If document links include PDFs, distinguish discovered links from downloaded/read content; Plandata currently returns link metadata only.
8. If a Plandata call returns a validation error, correct the arguments and retry when the schema and task indicate a safe correction.

## Capability discovery reference

Read `references/capabilities.md` for runtime capability-discovery guidance, input-shaping rules, and Plandata-specific safety boundaries.
