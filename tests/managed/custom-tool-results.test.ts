import assert from "node:assert/strict";
import { test } from "node:test";

import {
  requiredCustomToolUseIds,
  selectRequiredCustomToolUseEvents,
  selectRequiredCustomToolUses,
  type ManagedCustomToolUseEvent,
} from "../../src/agent/managed/custom-tool-results";

const datafordelerToolUse: ManagedCustomToolUseEvent = {
  id: "sevt_01M94Araeyec7vBF9LsV292N",
  name: "datafordeler_datafordeler_get_property_context",
  input: {
    detail: "full",
    includeGraph: true,
    includeSourceRecords: true,
    input: {
      type: "dar_address_id",
      value: "0a3f50b4-ab3d-32b8-e044-0003ba298018",
    },
  },
};

const plandataToolUse: ManagedCustomToolUseEvent = {
  id: "sevt_01HUtdoWDkF6Ttb6JFsrmfEr",
  name: "plandata_plandata_get_plan_context",
  input: {
    geometry: {
      coordinates: [591479.11, 6142906.67, 591579.11, 6143006.67],
      crs: "EPSG:25832",
      type: "bbox",
    },
    includeGeometry: true,
    maxDocumentsPerPlan: 100,
    maxPlans: 50,
  },
};

function pendingToolUses(): Map<string, ManagedCustomToolUseEvent> {
  return new Map([
    [datafordelerToolUse.id, datafordelerToolUse],
    [plandataToolUse.id, plandataToolUse],
  ]);
}

test("requiredCustomToolUseIds reads only valid IDs from requires-action idle events", () => {
  assert.deepEqual(
    requiredCustomToolUseIds({
      type: "session.status_idle",
      stop_reason: { type: "requires_action", event_ids: ["tool-1", "tool-2"] },
    }),
    ["tool-1", "tool-2"],
  );
  assert.deepEqual(
    requiredCustomToolUseIds({
      type: "session.status_idle",
      stop_reason: { type: "requires_action", event_ids: ["tool-1", 2, "", null] },
    }),
    ["tool-1"],
  );
  assert.deepEqual(
    requiredCustomToolUseIds({
      type: "session.status_idle",
      stop_reason: { type: "end_turn", event_ids: ["tool-1"] },
    }),
    [],
  );
});

test("requires-action idle selects the exact custom tool calls from the stuck session shape", () => {
  const requiresActionIdle = {
    type: "session.status_idle",
    stop_reason: {
      type: "requires_action",
      event_ids: [datafordelerToolUse.id, plandataToolUse.id],
    },
  };

  const selection = selectRequiredCustomToolUseEvents(requiresActionIdle, pendingToolUses());

  assert.deepEqual(selection.requiredIds, [datafordelerToolUse.id, plandataToolUse.id]);
  assert.deepEqual(selection.selected.map((toolUse) => toolUse.name), [
    "datafordeler_datafordeler_get_property_context",
    "plandata_plandata_get_plan_context",
  ]);
  assert.deepEqual(selection.missingIds, []);
});

test("non-requires-action idle never falls back to pending tool calls", () => {
  const selection = selectRequiredCustomToolUseEvents(
    {
      type: "session.status_idle",
      stop_reason: { type: "end_turn", event_ids: [datafordelerToolUse.id] },
    },
    pendingToolUses(),
  );

  assert.deepEqual(selection, { requiredIds: [], selected: [], missingIds: [] });
});

test("requires-action without event_ids falls back to all pending custom tool calls", () => {
  assert.deepEqual(
    selectRequiredCustomToolUses(
      {
        type: "session.status_idle",
        stop_reason: { type: "requires_action" },
      },
      pendingToolUses(),
    ).map((toolUse) => toolUse.id),
    [datafordelerToolUse.id, plandataToolUse.id],
  );
});

test("missing required IDs are surfaced for bridge observability", () => {
  const selection = selectRequiredCustomToolUseEvents(
    {
      type: "session.status_idle",
      stop_reason: {
        type: "requires_action",
        event_ids: [datafordelerToolUse.id, "sevt_missing"],
      },
    },
    pendingToolUses(),
  );

  assert.deepEqual(selection.selected.map((toolUse) => toolUse.id), [datafordelerToolUse.id]);
  assert.deepEqual(selection.missingIds, ["sevt_missing"]);
});
