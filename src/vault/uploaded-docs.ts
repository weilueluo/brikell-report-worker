import type { VaultItem } from "@brikell/shared";

/**
 * A document already persisted to Vault that the agent should cite by Vault id rather
 * than inventing a local id. Today this means user-uploaded PDFs (kind: source_document)
 * and the matching extracted_text records, when present.
 */
export type UploadedVaultDoc = {
  readonly vaultItemId: string;
  readonly title: string;
  readonly type: "uploaded_pdf" | "uploaded_extracted_text";
  readonly filename?: string;
  readonly contentType?: string;
};

/**
 * Pick the documents the prompt should surface. Prefers source_document items (the original
 * file) over extracted_text items (the derived text). When both exist for the same upload,
 * we keep the source_document and drop the extracted_text.
 */
export function pickUploadedVaultDocsForPrompt(items: ReadonlyArray<VaultItem>): UploadedVaultDoc[] {
  const sourceDocs: UploadedVaultDoc[] = [];
  const extractedDocs: UploadedVaultDoc[] = [];
  const sourceParents = new Set<string>();

  for (const item of items) {
    if (item.kind === "source_document") {
      sourceDocs.push({
        vaultItemId: item.id,
        title: item.title,
        type: "uploaded_pdf",
        filename: item.filename,
        contentType: item.contentType,
      });
      if (item.id) sourceParents.add(item.id);
      if (item.parentItemId) sourceParents.add(item.parentItemId);
    } else if (item.kind === "extracted_text") {
      extractedDocs.push({
        vaultItemId: item.id,
        title: item.title,
        type: "uploaded_extracted_text",
        filename: item.filename,
        contentType: item.contentType,
      });
    }
  }

  // Drop extracted_text items whose parent (source_document) is already in the list.
  const filteredExtracted = extractedDocs.filter((doc) => {
    const original = items.find((item) => item.id === doc.vaultItemId);
    if (!original) return true;
    return !original.parentItemId || !sourceParents.has(original.parentItemId);
  });

  return [...sourceDocs, ...filteredExtracted];
}
