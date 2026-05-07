import {
  makeMcpToolCallVaultItemId,
  mcpCollectionEvidenceRecordSchema,
  vaultItemSchema,
  type McpCollectionEvidenceDocument,
  type McpCollectionEvidenceRecord,
  type VaultItem,
  type VaultStore,
} from "@brikell/shared";
import { createStores } from "../storage";

export type RecordMcpCollectionEvidenceInput = {
  assignmentId: string;
  ownerClientId: string;
  jobId: string;
  records: ReadonlyArray<McpCollectionEvidenceRecord>;
};

type CollectionEvidenceItemPlan = {
  id: string;
  item: VaultItem;
};

export async function recordMcpCollectionEvidence(
  input: RecordMcpCollectionEvidenceInput,
): Promise<VaultItem[]> {
  const { vault } = createStores();
  return recordMcpCollectionEvidenceWithVault(vault, input);
}

export async function recordMcpCollectionEvidenceWithVault(
  vault: Pick<VaultStore, "get" | "create">,
  input: RecordMcpCollectionEvidenceInput,
): Promise<VaultItem[]> {
  if (input.records.length === 0) return [];
  const plans = buildMcpCollectionEvidenceVaultItems(input);
  const created: VaultItem[] = [];

  for (const plan of plans) {
    const existing = await vault.get(plan.id);
    if (existing) {
      created.push(existing);
      continue;
    }
    created.push(await vault.create(plan.item));
  }

  return created;
}

export function buildMcpCollectionEvidenceVaultItems(
  input: RecordMcpCollectionEvidenceInput,
): CollectionEvidenceItemPlan[] {
  const now = new Date().toISOString();
  const plans: CollectionEvidenceItemPlan[] = [];
  let index = 0;

  for (const rawRecord of input.records) {
    const record = mcpCollectionEvidenceRecordSchema.parse(rawRecord);
    const toolName = `mcp.${record.intent}`;
    const recordId = makeMcpToolCallVaultItemId({
      assignmentId: input.assignmentId,
      jobId: input.jobId,
      index,
      toolName,
    });
    const documentUpstreamIds = (record.documents ?? []).map((document) => document.upstreamId);
    const upstreamIds = uniqueStrings([
      record.ref.upstreamId,
      ...documentUpstreamIds,
    ]);
    plans.push({
      id: recordId,
      item: vaultItemSchema.parse({
        id: recordId,
        ownerClientId: input.ownerClientId,
        assignmentId: input.assignmentId,
        kind: "mcp_tool_result",
        title: toolName.slice(0, 240),
        sourceJobId: input.jobId,
        metadata: {
          provider: record.ref.source,
          toolName,
          fetchedAt: record.ref.fetchedAt,
          ok: true,
          collectionId: record.collectionId,
          intent: record.intent,
          responseSha256: record.responseSha256,
          counts: record.counts,
          dataSources: [record.ref.source],
          upstreamIds,
          index,
        },
        createdAt: now,
        updatedAt: now,
      }),
    });
    index++;

    for (const document of record.documents ?? []) {
      const documentToolName = `${toolName}.document`;
      const documentId = makeMcpToolCallVaultItemId({
        assignmentId: input.assignmentId,
        jobId: input.jobId,
        index,
        toolName: documentToolName,
      });
      plans.push({
        id: documentId,
        item: vaultItemSchema.parse({
          id: documentId,
          ownerClientId: input.ownerClientId,
          assignmentId: input.assignmentId,
          kind: "mcp_tool_result",
          title: collectionDocumentTitle(record.intent, document),
          sourceJobId: input.jobId,
          parentItemId: recordId,
          metadata: {
            provider: document.source,
            toolName: documentToolName,
            fetchedAt: record.ref.fetchedAt,
            ok: true,
            collectionId: record.collectionId,
            intent: record.intent,
            documentId: document.documentId,
            responseSha256: record.responseSha256,
            documentSha256: document.sha256,
            byteSize: document.byteSize,
            pageCount: document.pageCount,
            extractionStatus: document.extractionStatus,
            dataSources: [document.source],
            upstreamIds: [document.upstreamId],
            index,
          },
          createdAt: now,
          updatedAt: now,
        }),
      });
      index++;
    }
  }

  return plans;
}

function collectionDocumentTitle(
  intent: McpCollectionEvidenceRecord["intent"],
  document: McpCollectionEvidenceDocument,
): string {
  return `mcp.${intent}.document ${document.upstreamId}`.slice(0, 240);
}

function uniqueStrings(values: Array<string | undefined>): string[] {
  return Array.from(new Set(values.filter((value): value is string => typeof value === "string" && value.length > 0)));
}
