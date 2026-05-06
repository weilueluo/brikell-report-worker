import { randomUUID } from "node:crypto";
import type { AddressCandidate } from "@brikell/shared";
import { createStores } from "../storage";
import {
  assignmentSchema,
  defaultDDScope,
  type Assignment,
  type AssignmentStatus,
  type DDScope,
} from "@brikell/shared";

export type CreateAssignmentInput = {
  ownerClientId: string;
  address?: AddressCandidate;
  scope?: DDScope;
};

export async function createAssignment(input: CreateAssignmentInput): Promise<Assignment> {
  const { assignments } = createStores();
  const now = new Date().toISOString();
  const draft: Assignment = assignmentSchema.parse({
    id: randomUUID(),
    ownerClientId: input.ownerClientId,
    status: "draft",
    address: input.address,
    scope: input.scope ?? defaultDDScope(),
    documents: [],
    createdAt: now,
    updatedAt: now,
  });
  return assignments.create(draft);
}

export async function getAssignmentForOwner(
  id: string,
  ownerClientId: string,
): Promise<Assignment | undefined> {
  const { assignments } = createStores();
  const record = await assignments.get(id);
  if (!record) return undefined;
  if (record.ownerClientId !== ownerClientId) return undefined;
  return record;
}

export async function listAssignmentsForOwner(
  ownerClientId: string,
  options: { limit?: number } = {},
): Promise<Assignment[]> {
  const { assignments } = createStores();
  return assignments.list({ ownerClientId, limit: options.limit ?? 50 });
}

export async function setAssignmentProperty(
  id: string,
  ownerClientId: string,
  address: AddressCandidate,
): Promise<Assignment> {
  return mutateOwnedAssignment(id, ownerClientId, (current) => {
    if (current.status !== "draft") {
      throw assignmentImmutableError(current.status);
    }
    return { ...current, address };
  });
}

export async function setAssignmentScope(
  id: string,
  ownerClientId: string,
  scope: DDScope,
): Promise<Assignment> {
  return mutateOwnedAssignment(id, ownerClientId, (current) => {
    if (current.status !== "draft") {
      throw assignmentImmutableError(current.status);
    }
    return { ...current, scope };
  });
}

export async function linkAssignmentReportJob(
  id: string,
  ownerClientId: string,
  reportJobId: string,
): Promise<Assignment> {
  return mutateOwnedAssignment(id, ownerClientId, (current) => {
    if (!current.address) {
      throw new Error("Cannot launch report: assignment has no property address.");
    }
    return { ...current, reportJobId, status: "running" };
  });
}

export async function applyAssignmentReportStatus(
  id: string,
  status: Extract<AssignmentStatus, "running" | "awaiting_review" | "complete" | "rejected" | "failed">,
): Promise<Assignment | undefined> {
  const { assignments } = createStores();
  const current = await assignments.get(id);
  if (!current) return undefined;
  return assignments.mutate(id, (record) => ({ ...record, status }));
}

export async function markAssignmentVaultRecorded(id: string, when: string = new Date().toISOString()): Promise<Assignment | undefined> {
  const { assignments } = createStores();
  const current = await assignments.get(id);
  if (!current) return undefined;
  if (current.vaultRecordedAt) return current;
  return assignments.mutate(id, (record) => ({ ...record, vaultRecordedAt: when }));
}

async function mutateOwnedAssignment(
  id: string,
  ownerClientId: string,
  mutation: (current: Assignment) => Assignment,
): Promise<Assignment> {
  const { assignments } = createStores();
  const current = await assignments.get(id);
  if (!current || current.ownerClientId !== ownerClientId) {
    throw new AssignmentNotFoundError(id);
  }
  return assignments.mutate(id, (record) => {
    if (record.ownerClientId !== ownerClientId) throw new AssignmentNotFoundError(id);
    return mutation(record);
  });
}

export class AssignmentNotFoundError extends Error {
  readonly code = "assignment_not_found";

  constructor(id: string) {
    super(`Assignment not found: ${id}`);
    this.name = "AssignmentNotFoundError";
  }
}

function assignmentImmutableError(status: AssignmentStatus): Error {
  return new Error(`Assignment is ${status}; only draft assignments can be edited.`);
}
