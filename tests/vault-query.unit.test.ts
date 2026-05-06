import assert from "node:assert/strict";
import { test } from "node:test";
import { applyVaultQuery, type VaultItem } from "@brikell/shared";

const baseItem = (overrides: Partial<VaultItem>): VaultItem => ({
  id: overrides.id ?? "vault-1",
  ownerClientId: overrides.ownerClientId ?? "owner-a",
  assignmentId: overrides.assignmentId ?? "asn-1",
  kind: overrides.kind ?? "mcp_tool_result",
  title: overrides.title ?? "Untitled",
  createdAt: overrides.createdAt ?? new Date().toISOString(),
  updatedAt: overrides.updatedAt ?? overrides.createdAt ?? new Date().toISOString(),
  metadata: overrides.metadata ?? {},
  artifactKey: overrides.artifactKey,
  sourceJobId: overrides.sourceJobId,
});

test("applyVaultQuery filters by owner", () => {
  const a = baseItem({ id: "1", ownerClientId: "owner-a", title: "Alpha" });
  const b = baseItem({ id: "2", ownerClientId: "owner-b", title: "Beta" });
  const out = applyVaultQuery([a, b], { ownerClientId: "owner-a" });
  assert.deepEqual(out.map((i) => i.id), ["1"]);
});

test("applyVaultQuery filters by assignmentId, kind, and provider", () => {
  const items: VaultItem[] = [
    baseItem({
      id: "1",
      assignmentId: "asn-1",
      kind: "mcp_tool_result",
      metadata: { provider: "datafordeler" },
    }),
    baseItem({
      id: "2",
      assignmentId: "asn-1",
      kind: "report_markdown",
      metadata: { provider: "report" },
    }),
    baseItem({
      id: "3",
      assignmentId: "asn-2",
      kind: "mcp_tool_result",
      metadata: { provider: "plandata" },
    }),
  ];
  assert.deepEqual(
    applyVaultQuery(items, { ownerClientId: "owner-a", assignmentId: "asn-1" }).map((i) => i.id),
    ["1", "2"],
  );
  assert.deepEqual(
    applyVaultQuery(items, { ownerClientId: "owner-a", kind: "report_markdown" }).map((i) => i.id),
    ["2"],
  );
  assert.deepEqual(
    applyVaultQuery(items, { ownerClientId: "owner-a", provider: "plandata" }).map((i) => i.id),
    ["3"],
  );
});

test("applyVaultQuery substring-searches title/kind/provider/toolName via q (case-insensitive)", () => {
  const items: VaultItem[] = [
    baseItem({ id: "1", title: "Roof analysis", metadata: { provider: "datafordeler" } }),
    baseItem({ id: "2", title: "Boundary check", metadata: { provider: "plandata", toolName: "matrikel.lookup" } }),
  ];
  assert.deepEqual(
    applyVaultQuery(items, { ownerClientId: "owner-a", q: "ROOF" }).map((i) => i.id),
    ["1"],
  );
  assert.deepEqual(
    applyVaultQuery(items, { ownerClientId: "owner-a", q: "matrikel" }).map((i) => i.id),
    ["2"],
  );
  assert.deepEqual(
    applyVaultQuery(items, { ownerClientId: "owner-a", q: "nope" }).map((i) => i.id),
    [],
  );
});

test("applyVaultQuery sorts newest first and respects limit", () => {
  const items: VaultItem[] = [
    baseItem({ id: "old", createdAt: "2024-01-01T00:00:00.000Z" }),
    baseItem({ id: "new", createdAt: "2025-01-01T00:00:00.000Z" }),
    baseItem({ id: "mid", createdAt: "2024-06-01T00:00:00.000Z" }),
  ];
  const out = applyVaultQuery(items, { ownerClientId: "owner-a", limit: 2 });
  assert.deepEqual(out.map((i) => i.id), ["new", "mid"]);
});
