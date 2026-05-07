import { getAssignmentForOwner, markAssignmentVaultRecorded } from "../assignments/assignment-service";
import { createStores } from "../storage";
import {
  makeReportVaultItemId,
  reportVaultItemTitle,
  vaultItemSchema,
  type ReportArtifactInput,
  type VaultItem,
} from "@brikell/shared";

export type RecordReportArtifactsInput = {
  assignmentId: string;
  ownerClientId: string;
  jobId: string;
  artifacts: ReportArtifactInput[];
};

export async function recordReportArtifacts(input: RecordReportArtifactsInput): Promise<VaultItem[]> {
  const { vault } = createStores();
  const now = new Date().toISOString();
  const created: VaultItem[] = [];

  for (const artifact of input.artifacts) {
    const id = makeReportVaultItemId({
      assignmentId: input.assignmentId,
      jobId: input.jobId,
      kind: artifact.kind,
    });
    const existing = await vault.get(id);
    if (existing) {
      created.push(existing);
      continue;
    }
    const item: VaultItem = vaultItemSchema.parse({
      id,
      ownerClientId: input.ownerClientId,
      assignmentId: input.assignmentId,
      kind: artifact.kind,
      title: reportVaultItemTitle(artifact.kind),
      artifactKey: artifact.artifactKey,
      sourceJobId: input.jobId,
      filename: artifact.filename,
      contentType: artifact.contentType,
      byteSize: artifact.byteSize,
      metadata: {},
      createdAt: now,
      updatedAt: now,
    });
    created.push(await vault.create(item));
  }

  await markAssignmentVaultRecorded(input.assignmentId, now);
  return created;
}

export async function listVaultItemsForAssignment(
  ownerClientId: string,
  assignmentId: string,
): Promise<VaultItem[]> {
  const { vault } = createStores();
  return vault.list({ ownerClientId, assignmentId });
}

export async function listVaultItemsForOwner(ownerClientId: string): Promise<VaultItem[]> {
  const { vault } = createStores();
  return vault.list({ ownerClientId });
}

/**
 * Server-side query path. Returns list-summary projections only — never full
 * item blobs. Caller fetches details via `getVaultItemForOwner`.
 */
export async function queryVaultItems(
  filter: import("@brikell/shared").VaultQueryFilter,
): Promise<import("@brikell/shared").VaultListItem[]> {
  const { vault } = createStores();
  if (typeof vault.query === "function") {
    return vault.query(filter);
  }
  // Defensive fallback: no concrete store should rely on this — both InMemoryVaultStore
  // and SupabaseVaultStore implement `query` directly.
  const { applyVaultQuery } = await import("@brikell/shared");
  const all = await vault.list({ ownerClientId: filter.ownerClientId });
  return applyVaultQuery(all, filter);
}

export async function getVaultItemForOwner(
  itemId: string,
  ownerClientId: string,
): Promise<VaultItem | undefined> {
  const { vault } = createStores();
  const item = await vault.get(itemId);
  if (!item) return undefined;
  if (item.ownerClientId !== ownerClientId) return undefined;
  return item;
}

export async function ensureVaultRecordedForAssignment(
  assignmentId: string,
  ownerClientId: string,
): Promise<VaultItem[]> {
  const assignment = await getAssignmentForOwner(assignmentId, ownerClientId);
  if (!assignment || assignment.status !== "complete" || !assignment.reportJobId) return [];
  if (assignment.vaultRecordedAt) {
    return listVaultItemsForAssignment(ownerClientId, assignmentId);
  }

  const { jobs } = createStores();
  const job = await jobs.get(assignment.reportJobId);
  if (!job || job.status !== "complete") return listVaultItemsForAssignment(ownerClientId, assignmentId);

  const artifacts: ReportArtifactInput[] = [];
  if (job.markdownArtifactKey) {
    artifacts.push({
      kind: "report_markdown",
      artifactKey: job.markdownArtifactKey,
      contentType: "text/markdown; charset=utf-8",
      filename: `${job.id}.md`,
    });
  }
  if (job.pdfArtifactKey) {
    artifacts.push({
      kind: "report_pdf",
      artifactKey: job.pdfArtifactKey,
      contentType: "application/pdf",
      filename: `${job.id}.pdf`,
    });
  }
  if (job.canonicalArtifactKey) {
    artifacts.push({
      kind: "report_canonical_json",
      artifactKey: job.canonicalArtifactKey,
      contentType: "application/json; charset=utf-8",
      filename: `${job.id}.canonical.json`,
    });
  }
  if (artifacts.length === 0) return [];

  return recordReportArtifacts({
    assignmentId,
    ownerClientId,
    jobId: job.id,
    artifacts,
  });
}
