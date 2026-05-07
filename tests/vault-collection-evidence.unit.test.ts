import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildMcpCollectionEvidenceVaultItems,
  recordMcpCollectionEvidenceWithVault,
} from "../src/vault/collection-evidence";
import type { McpCollectionEvidenceRecord, VaultItem } from "@brikell/shared";

class FakeVault {
  readonly items = new Map<string, VaultItem>();
  createCalls = 0;

  async get(id: string): Promise<VaultItem | undefined> {
    return this.items.get(id);
  }

  async create(item: VaultItem): Promise<VaultItem> {
    this.createCalls++;
    this.items.set(item.id, item);
    return item;
  }
}

const baseInput = {
  assignmentId: "assignment-1",
  ownerClientId: "owner-1",
  jobId: "job-1",
};

test("recordMcpCollectionEvidence creates one Vault item for a simple address.resolve record", async () => {
  const vault = new FakeVault();
  const records: McpCollectionEvidenceRecord[] = [
    {
      collectionId: "collection-address",
      intent: "address.resolve",
      ref: { source: "dataforsyningen", upstreamId: "dar-1", fetchedAt: "2026-05-01T00:00:00.000Z" },
      responseSha256: "sha-address",
      counts: { records: 1, documents: 0 },
    },
  ];

  const items = await recordMcpCollectionEvidenceWithVault(vault, { ...baseInput, records });

  assert.equal(items.length, 1);
  assert.equal(items[0]!.kind, "mcp_tool_result");
  assert.equal(items[0]!.metadata.provider, "dataforsyningen");
  assert.deepEqual(items[0]!.metadata.dataSources, ["dataforsyningen"]);
  assert.deepEqual(items[0]!.metadata.upstreamIds, ["dar-1"]);
});

test("recordMcpCollectionEvidence creates one collection item and one item per planning document", async () => {
  const vault = new FakeVault();
  const records: McpCollectionEvidenceRecord[] = [
    {
      collectionId: "collection-planning",
      intent: "planning.collect",
      ref: { source: "plandata", upstreamId: "plan-1", fetchedAt: "2026-05-01T00:00:00.000Z" },
      responseSha256: "sha-planning",
      counts: { records: 5, documents: 3 },
      documents: [
        { documentId: "doc-1", source: "plandata", upstreamId: "doc-up-1", sha256: "sha-doc-1", byteSize: 10, pageCount: 1, extractionStatus: "ok" },
        { documentId: "doc-2", source: "plandata", upstreamId: "doc-up-2", sha256: "sha-doc-2", byteSize: 20, pageCount: 2, extractionStatus: "partial" },
        { documentId: "doc-3", source: "plandata", upstreamId: "doc-up-3", sha256: "sha-doc-3", byteSize: 30, pageCount: 3, extractionStatus: "timeout" },
      ],
    },
  ];

  const items = await recordMcpCollectionEvidenceWithVault(vault, { ...baseInput, records });

  assert.equal(items.length, 4);
  const collection = items.find((item) => item.metadata.toolName === "mcp.planning.collect");
  assert.ok(collection);
  assert.deepEqual(collection!.metadata.upstreamIds, ["plan-1", "doc-up-1", "doc-up-2", "doc-up-3"]);
  const docs = items.filter((item) => item.metadata.toolName === "mcp.planning.collect.document");
  assert.equal(docs.length, 3);
  assert.ok(docs.every((item) => item.parentItemId === collection!.id));
});

test("recordMcpCollectionEvidence is idempotent for the same input", async () => {
  const vault = new FakeVault();
  const records: McpCollectionEvidenceRecord[] = [
    {
      collectionId: "collection-address",
      intent: "address.resolve",
      ref: { source: "dataforsyningen", upstreamId: "dar-1", fetchedAt: "2026-05-01T00:00:00.000Z" },
      responseSha256: "sha-address",
      counts: { records: 1, documents: 0 },
    },
  ];

  const first = await recordMcpCollectionEvidenceWithVault(vault, { ...baseInput, records });
  const second = await recordMcpCollectionEvidenceWithVault(vault, { ...baseInput, records });

  assert.equal(first.length, 1);
  assert.equal(second.length, 1);
  assert.equal(first[0]!.id, second[0]!.id);
  assert.equal(vault.createCalls, 1);
  assert.equal(vault.items.size, 1);
  const plannedIds = buildMcpCollectionEvidenceVaultItems({ ...baseInput, records }).map((plan) => plan.id);
  assert.deepEqual(plannedIds, [first[0]!.id]);
});
