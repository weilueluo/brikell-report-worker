import assert from "node:assert/strict";
import { test } from "node:test";
import type { AddressCandidate } from "@brikell/shared";
import { defaultDDScope } from "@brikell/shared";
import {
  AssignmentNotFoundError,
  applyAssignmentReportStatus,
  createAssignment,
  linkAssignmentReportJob,
  markAssignmentVaultRecorded,
  setAssignmentProperty,
  setAssignmentScope,
} from "../src/assignments/assignment-service";
import { createStores } from "../src/storage";
import { withSupabaseTestContext } from "./fixtures/supabase-context";

const ADDRESS: AddressCandidate = {
  id: "asn-svc-test",
  label: "Hovedgaden 1, 1234 Test",
  postalCode: "1234",
  city: "Test",
  coordinates: { x: 724000, y: 6182000, srid: "EPSG:25832" },
  coordinateSource: "selected-candidate",
  source: { provider: "Dataforsyningen", serviceId: "gsearch" },
};

test("setAssignmentScope updates the scope of a draft assignment", async () => {
  await withSupabaseTestContext(async (ctx) => {
    const created = await createAssignment({ ownerClientId: ctx.ownerClientId, address: ADDRESS });
    const scope = { ...defaultDDScope(), notes: "focus on roof" };
    const updated = await setAssignmentScope(created.id, ctx.ownerClientId, scope);
    assert.deepEqual(updated.scope, scope);
  });
});

test("setAssignmentScope rejects edits once the assignment has left draft", async () => {
  await withSupabaseTestContext(async (ctx) => {
    const created = await createAssignment({ ownerClientId: ctx.ownerClientId, address: ADDRESS });
    const { assignments } = createStores();
    await assignments.mutate(created.id, (record) => ({ ...record, status: "running" }));
    await assert.rejects(
      () => setAssignmentScope(created.id, ctx.ownerClientId, defaultDDScope()),
      /only draft assignments can be edited/,
    );
  });
});

test("setAssignmentProperty rejects edits once the assignment has left draft", async () => {
  await withSupabaseTestContext(async (ctx) => {
    const created = await createAssignment({ ownerClientId: ctx.ownerClientId, address: ADDRESS });
    const { assignments } = createStores();
    await assignments.mutate(created.id, (record) => ({ ...record, status: "running" }));
    await assert.rejects(
      () => setAssignmentProperty(created.id, ctx.ownerClientId, ADDRESS),
      /only draft assignments can be edited/,
    );
  });
});

test("setAssignmentScope throws AssignmentNotFoundError for the wrong owner", async () => {
  await withSupabaseTestContext(async (ctx) => {
    const stranger = ctx.uniqueOwnerId("stranger");
    const created = await createAssignment({ ownerClientId: ctx.ownerClientId, address: ADDRESS });
    await assert.rejects(
      () => setAssignmentScope(created.id, stranger, defaultDDScope()),
      AssignmentNotFoundError,
    );
  });
});

test("linkAssignmentReportJob refuses to launch a report when no address is set", async () => {
  await withSupabaseTestContext(async (ctx) => {
    const created = await createAssignment({ ownerClientId: ctx.ownerClientId, address: ADDRESS });
    const { assignments } = createStores();
    await assignments.mutate(created.id, (record) => ({ ...record, address: undefined }));
    await assert.rejects(
      () => linkAssignmentReportJob(created.id, ctx.ownerClientId, ctx.uniqueId("job")),
      /no property address/,
    );
  });
});

test("applyAssignmentReportStatus updates a real assignment and returns undefined for missing ones", async () => {
  await withSupabaseTestContext(async (ctx) => {
    const created = await createAssignment({ ownerClientId: ctx.ownerClientId, address: ADDRESS });
    const updated = await applyAssignmentReportStatus(created.id, "running");
    assert.equal(updated?.status, "running");

    const missing = await applyAssignmentReportStatus(ctx.uniqueId("missing"), "running");
    assert.equal(missing, undefined);
  });
});

test("markAssignmentVaultRecorded short-circuits when vaultRecordedAt is already set", async () => {
  await withSupabaseTestContext(async (ctx) => {
    const created = await createAssignment({ ownerClientId: ctx.ownerClientId, address: ADDRESS });
    const { assignments } = createStores();
    await assignments.mutate(created.id, (record) => ({
      ...record,
      vaultRecordedAt: "2026-01-01T00:00:00.000Z",
    }));
    const updated = await markAssignmentVaultRecorded(created.id, "2026-04-01T00:00:00.000Z");
    assert.equal(updated?.vaultRecordedAt, "2026-01-01T00:00:00.000Z");
  });
});

test("markAssignmentVaultRecorded sets the timestamp on first record and returns undefined for missing ids", async () => {
  await withSupabaseTestContext(async (ctx) => {
    const created = await createAssignment({ ownerClientId: ctx.ownerClientId, address: ADDRESS });
    const stamp = "2026-04-29T12:00:00.000Z";
    const updated = await markAssignmentVaultRecorded(created.id, stamp);
    assert.equal(updated?.vaultRecordedAt, stamp);

    const missing = await markAssignmentVaultRecorded(ctx.uniqueId("missing"));
    assert.equal(missing, undefined);
  });
});

test("AssignmentNotFoundError carries the assignment_not_found code", () => {
  const error = new AssignmentNotFoundError("abc");
  assert.equal(error.code, "assignment_not_found");
  assert.match(error.message, /Assignment not found: abc/);
});
