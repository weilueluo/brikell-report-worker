import assert from "node:assert/strict";
import { test } from "node:test";

import type { AddressCandidate, McpCollectionEvidenceRecord } from "@brikell/shared";

import { createAssignment } from "../src/assignments/assignment-service";
import { createReport, __testOnly } from "../src/reports/report-service";
import { listVaultItemsForAssignment } from "../src/vault/vault-service";
import { withSupabaseTestContext } from "./fixtures/supabase-context";

const ADDRESS: AddressCandidate = {
  id: "report-svc-evidence-1",
  label: "Nørrebrogade 17, 2200 København N",
  postalCode: "2200",
  city: "København N",
  coordinates: { x: 725_000, y: 6_180_000, srid: "EPSG:25832" },
  coordinateSource: "selected-candidate",
  source: { provider: "Dataforsyningen", serviceId: "adresser" },
};

test("recordMcpCollectionEvidenceForJob writes one Vault item per evidence record for a job", async () => {
  await withSupabaseTestContext(async (ctx) => {
    const assignment = await createAssignment({
      ownerClientId: ctx.ownerClientId,
      address: ADDRESS,
    });
    const job = await createReport(ADDRESS, {
      ownerClientId: ctx.ownerClientId,
      assignmentId: assignment.id,
    });
    const records: McpCollectionEvidenceRecord[] = [
      {
        collectionId: "col_address_resolve_1",
        intent: "address.resolve",
        ref: {
          source: "dataforsyningen.adresser",
          upstreamId: "addr-001",
          fetchedAt: "2026-05-07T10:00:00.000Z",
        },
        responseSha256: "b".repeat(64),
        counts: { records: 1, documents: 0 },
      },
    ];

    const created = await __testOnly.recordMcpCollectionEvidenceForJob(job, records);
    assert.equal(created.length, 1);
    const [item] = created;
    assert.equal(item!.kind, "mcp_tool_result");
    assert.equal(item!.metadata?.toolName, "mcp.address.resolve");
    assert.equal(item!.metadata?.intent, "address.resolve");
    assert.equal(item!.metadata?.provider, "dataforsyningen.adresser");
    assert.equal(item!.assignmentId, assignment.id);
    assert.equal(item!.ownerClientId, ctx.ownerClientId);

    const persisted = await listVaultItemsForAssignment(ctx.ownerClientId, assignment.id);
    const mcpItems = persisted.filter((entry) => entry.kind === "mcp_tool_result");
    assert.equal(mcpItems.length, 1);
    assert.equal(mcpItems[0]!.metadata?.intent, "address.resolve");
  });
});

test("recordMcpCollectionEvidenceForJob is a no-op when no records or no assignment", async () => {
  await withSupabaseTestContext(async (ctx) => {
    const assignment = await createAssignment({
      ownerClientId: ctx.ownerClientId,
      address: ADDRESS,
    });
    const job = await createReport(ADDRESS, {
      ownerClientId: ctx.ownerClientId,
      assignmentId: assignment.id,
    });

    const empty = await __testOnly.recordMcpCollectionEvidenceForJob(job, []);
    assert.deepEqual(empty, []);

    const detached = { ...job, assignmentId: undefined } as typeof job;
    const skipped = await __testOnly.recordMcpCollectionEvidenceForJob(detached, [
      {
        collectionId: "col_no_assignment",
        intent: "address.resolve",
        ref: {
          source: "dataforsyningen.adresser",
          upstreamId: "addr-002",
          fetchedAt: "2026-05-07T10:01:00.000Z",
        },
        responseSha256: "c".repeat(64),
        counts: { records: 1, documents: 0 },
      },
    ]);
    assert.deepEqual(skipped, []);
  });
});
