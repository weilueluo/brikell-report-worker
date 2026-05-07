import assert from "node:assert/strict";
import { test } from "node:test";

import {
  vaultItemSchema,
  type ReportV1,
  type VaultItem,
} from "@brikell/shared";

import { linkSourceDocumentsToVault } from "../src/vault/link-source-documents";

/**
 * End-to-end provenance contract:
 *   stamped MCP collection-evidence record  →  vault item metadata  →  linked V1 citation
 *
 * Locks the chain so adding a new MCP source or renaming a vault metadata key trips one
 * test instead of leaking unstamped data into a vault item or canonical citation.
 */
test("provenance flows from a stamped MCP collection-evidence record into a linked V1 citation", () => {
  const vaultItem: VaultItem = vaultItemSchema.parse({
    id: "vault-1",
    ownerClientId: "owner",
    assignmentId: "assign",
    kind: "mcp_tool_result",
    title: "mcp.property.collect",
    sourceJobId: "job-1",
    metadata: {
      provider: "datafordeler.property",
      toolName: "mcp.property.collect",
      ok: true,
      collectionId: "col_property_1",
      intent: "property.collect",
      dataSources: ["datafordeler.property"],
      upstreamIds: ["123"],
    },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  });

  const report: ReportV1 = {
    schemaVersion: "v1",
    reportId: "rpt-1",
    generatedAt: "2026-01-01T00:00:00.000Z",
    subject: { inputAddress: "Some Road 1, 1000 Town" },
    sections: {
      propertyIdentification: {
        bfeNumber: { availability: "found", value: "123", citations: [{ sourceDocumentId: "mcp:datafordeler.property:123" }] },
        bbrAddress: { availability: "not_available" },
        numberOfGrunde: { availability: "not_available" },
        formerMunicipalPropertyNumber: { availability: "not_available" },
        parcel: { availability: "not_available" },
        parcelArea: { availability: "not_available" },
        waterSupply: { availability: "not_available" },
        drainage: { availability: "not_available" },
        additionalFacts: [],
      },
      buildings: { availability: "not_available" },
      technicalInstallations: { availability: "not_available" },
      residentialUnitGroups: { availability: "not_available" },
      lokalplaner: { availability: "not_available" },
      kommuneplan: { availability: "not_available" },
    },
    sourceDocuments: [
      { id: "mcp:datafordeler.property:123", type: "other", title: "datafordeler.property" },
    ],
  };

  const { report: linked, linked: count } = linkSourceDocumentsToVault(report, [vaultItem]);
  assert.equal(count, 1);
  assert.equal(linked.sourceDocuments[0]!.vaultItemId, "vault-1");
});

test("link-source-documents resolves mcp:<source> when no upstreamId is present", () => {
  const vaultItem: VaultItem = vaultItemSchema.parse({
    id: "vault-cov",
    ownerClientId: "owner",
    assignmentId: "assign",
    kind: "mcp_tool_result",
    title: "plandata.coverage_status",
    sourceJobId: "job-cov",
    metadata: { dataSources: ["plandata"], upstreamIds: [] },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  });
  const report: ReportV1 = {
    schemaVersion: "v1",
    reportId: "rpt-2",
    generatedAt: "2026-01-01T00:00:00.000Z",
    subject: { inputAddress: "X" },
    sections: {
      propertyIdentification: {
        bfeNumber: { availability: "not_available" },
        bbrAddress: { availability: "not_available" },
        numberOfGrunde: { availability: "not_available" },
        formerMunicipalPropertyNumber: { availability: "not_available" },
        parcel: { availability: "not_available" },
        parcelArea: { availability: "not_available" },
        waterSupply: { availability: "not_available" },
        drainage: { availability: "not_available" },
        additionalFacts: [],
      },
      buildings: { availability: "not_available" },
      technicalInstallations: { availability: "not_available" },
      residentialUnitGroups: { availability: "not_available" },
      lokalplaner: { availability: "not_available" },
      kommuneplan: { availability: "not_available" },
    },
    sourceDocuments: [{ id: "mcp:plandata", type: "other", title: "plandata.coverage_status" }],
  };
  const { report: linked, linked: count } = linkSourceDocumentsToVault(report, [vaultItem]);
  assert.equal(count, 1);
  assert.equal(linked.sourceDocuments[0]!.vaultItemId, "vault-cov");
});
