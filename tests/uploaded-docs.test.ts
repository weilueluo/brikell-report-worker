import assert from "node:assert/strict";
import { test } from "node:test";
import type { VaultItem } from "@brikell/shared";
import { pickUploadedVaultDocsForPrompt } from "../src/vault/uploaded-docs";

function vaultItem(overrides: Partial<VaultItem> & Pick<VaultItem, "id" | "kind" | "title">): VaultItem {
  return {
    ownerClientId: "owner",
    assignmentId: "asn",
    metadata: {},
    createdAt: "2026-04-29T00:00:00Z",
    updatedAt: "2026-04-29T00:00:00Z",
    ...overrides,
  } as VaultItem;
}

test("pickUploadedVaultDocsForPrompt returns an empty list when no source/extracted items are present", () => {
  const out = pickUploadedVaultDocsForPrompt([
    vaultItem({ id: "v1", kind: "report_markdown", title: "Report MD" }),
    vaultItem({ id: "v2", kind: "report_pdf", title: "Report PDF" }),
  ]);
  assert.deepEqual(out, []);
});

test("pickUploadedVaultDocsForPrompt surfaces source_document items and tags them as uploaded_pdf", () => {
  const out = pickUploadedVaultDocsForPrompt([
    vaultItem({
      id: "src-1",
      kind: "source_document",
      title: "Plot plan",
      filename: "plot.pdf",
      contentType: "application/pdf",
    }),
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0]!.vaultItemId, "src-1");
  assert.equal(out[0]!.type, "uploaded_pdf");
  assert.equal(out[0]!.filename, "plot.pdf");
  assert.equal(out[0]!.contentType, "application/pdf");
});

test("pickUploadedVaultDocsForPrompt drops extracted_text whose source_document parent is already in the list", () => {
  const out = pickUploadedVaultDocsForPrompt([
    vaultItem({ id: "src-1", kind: "source_document", title: "Survey" }),
    vaultItem({
      id: "ext-1",
      kind: "extracted_text",
      title: "Survey (text)",
      parentItemId: "src-1",
    }),
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0]!.vaultItemId, "src-1");
  assert.equal(out[0]!.type, "uploaded_pdf");
});

test("pickUploadedVaultDocsForPrompt keeps an extracted_text item when its parent isn't in the list", () => {
  const out = pickUploadedVaultDocsForPrompt([
    vaultItem({
      id: "ext-orphan",
      kind: "extracted_text",
      title: "Orphan extract",
      parentItemId: "missing-source",
    }),
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0]!.vaultItemId, "ext-orphan");
  assert.equal(out[0]!.type, "uploaded_extracted_text");
});
