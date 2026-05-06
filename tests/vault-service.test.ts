import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ensureVaultRecordedForAssignment,
  getVaultItemForOwner,
  listVaultItemsForAssignment,
  listVaultItemsForOwner,
  queryVaultItems,
  recordMcpToolCallEvidence,
  recordReportArtifacts,
} from "../src/vault/vault-service";
import { createAssignment } from "../src/assignments/assignment-service";
import { createReport, getReport, startReportJob } from "../src/reports/report-service";
import { createStores } from "../src/storage";
import type { AddressCandidate } from "@brikell/shared";
import { withSupabaseTestContext } from "./fixtures/supabase-context";
import { staticReportRunner } from "./fixtures/runners/static-runner";
import { buildFixtureMarkdownRunnerResult } from "./fixtures/runners/fixture-results";

const ADDRESS: AddressCandidate = {
  id: "vault-svc-test-1",
  label: "Vesterbrogade 5, 1620 København V",
  postalCode: "1620",
  city: "København V",
  coordinates: { x: 720_000, y: 6_175_000, srid: "EPSG:25832" },
  coordinateSource: "selected-candidate",
  source: { provider: "Dataforsyningen", serviceId: "adresser" },
};

test("recordReportArtifacts persists vault items per artifact and is idempotent on the same id", async () => {
  await withSupabaseTestContext(async (ctx) => {
    const owner = ctx.ownerClientId;
    const assignment = await createAssignment({ ownerClientId: owner, address: ADDRESS });
    const jobId = ctx.uniqueId("job");
    const created = await recordReportArtifacts({
      assignmentId: assignment.id,
      ownerClientId: owner,
      jobId,
      artifacts: [
        {
          kind: "report_markdown",
          artifactKey: `${jobId}.md`,
          contentType: "text/markdown; charset=utf-8",
          filename: "report.md",
        },
        {
          kind: "report_pdf",
          artifactKey: `${jobId}.pdf`,
          contentType: "application/pdf",
          filename: "report.pdf",
        },
      ],
    });
    assert.equal(created.length, 2);
    const kinds = created.map((item) => item.kind).sort();
    assert.deepEqual(kinds, ["report_markdown", "report_pdf"]);

    const second = await recordReportArtifacts({
      assignmentId: assignment.id,
      ownerClientId: owner,
      jobId,
      artifacts: [
        {
          kind: "report_markdown",
          artifactKey: `${jobId}.md`,
          contentType: "text/markdown; charset=utf-8",
          filename: "report.md",
        },
      ],
    });
    assert.equal(second.length, 1);
    assert.equal(second[0]!.id, created[0]!.id);
  });
});

test("recordMcpToolCallEvidence skips when there are no calls and stamps source URLs when derivable", async () => {
  await withSupabaseTestContext(async (ctx) => {
    const assignment = await createAssignment({ ownerClientId: ctx.ownerClientId, address: ADDRESS });
    const empty = await recordMcpToolCallEvidence({
      assignmentId: assignment.id,
      ownerClientId: ctx.ownerClientId,
      jobId: ctx.uniqueId("job-empty"),
      toolCalls: [],
    });
    assert.deepEqual(empty, []);

    const items = await recordMcpToolCallEvidence({
      assignmentId: assignment.id,
      ownerClientId: ctx.ownerClientId,
      jobId: ctx.uniqueId("job-mcp"),
      toolCalls: [
        {
          toolName: "datafordeler.property.resolve_property",
          provider: "datafordeler",
          args: { bfeNumber: "12345" },
          result: { propertyId: "12345" },
          fetchedAt: "2026-04-29T00:00:00Z",
          ok: true,
        },
        {
          toolName: "unknown.tool",
          provider: "unknown",
          args: {},
          result: {},
          fetchedAt: "2026-04-29T00:00:01Z",
          ok: true,
        },
      ],
    });
    assert.equal(items.length, 2);
    const datafordelerItem = items.find(
      (i) => i.metadata?.toolName === "datafordeler.property.resolve_property",
    );
    assert.ok(datafordelerItem, "expected datafordeler item");
    assert.equal(datafordelerItem!.kind, "mcp_tool_result");
    assert.equal(
      datafordelerItem!.metadata?.sourceUrl,
      "https://datafordeler.dk/dataoversigt/ejendomsbeliggenhed/?bfeNumber=12345",
    );
    const unknownItem = items.find((i) => i.metadata?.toolName === "unknown.tool");
    assert.ok(unknownItem);
    assert.equal(unknownItem!.metadata?.sourceUrl, undefined);
  });
});

test("listVaultItemsForAssignment and listVaultItemsForOwner return owner-scoped items", async () => {
  await withSupabaseTestContext(async (ctx) => {
    const owner = ctx.ownerClientId;
    const stranger = ctx.uniqueOwnerId("stranger");
    const assignment = await createAssignment({ ownerClientId: owner, address: ADDRESS });
    const jobId = ctx.uniqueId("job");
    await recordReportArtifacts({
      assignmentId: assignment.id,
      ownerClientId: owner,
      jobId,
      artifacts: [
        {
          kind: "report_markdown",
          artifactKey: `${jobId}.md`,
          contentType: "text/markdown; charset=utf-8",
          filename: "k.md",
        },
      ],
    });

    const byAssignment = await listVaultItemsForAssignment(owner, assignment.id);
    assert.equal(byAssignment.length, 1);

    const byOwner = await listVaultItemsForOwner(owner);
    assert.equal(byOwner.length, 1);

    const otherOwner = await listVaultItemsForOwner(stranger);
    assert.equal(otherOwner.length, 0);
  });
});

test("getVaultItemForOwner returns undefined when the owner does not match", async () => {
  await withSupabaseTestContext(async (ctx) => {
    const owner = ctx.ownerClientId;
    const stranger = ctx.uniqueOwnerId("stranger");
    const assignment = await createAssignment({ ownerClientId: owner, address: ADDRESS });
    const jobId = ctx.uniqueId("job");
    const [item] = await recordReportArtifacts({
      assignmentId: assignment.id,
      ownerClientId: owner,
      jobId,
      artifacts: [
        {
          kind: "report_markdown",
          artifactKey: `${jobId}.md`,
          contentType: "text/markdown; charset=utf-8",
          filename: "g.md",
        },
      ],
    });
    assert.ok(item);

    const own = await getVaultItemForOwner(item.id, owner);
    assert.equal(own?.id, item.id);

    const other = await getVaultItemForOwner(item.id, stranger);
    assert.equal(other, undefined);

    const missing = await getVaultItemForOwner(ctx.uniqueId("missing-id"), owner);
    assert.equal(missing, undefined);
  });
});

test("queryVaultItems returns owner-scoped results filtered by provider when configured", async () => {
  await withSupabaseTestContext(async (ctx) => {
    const owner = ctx.ownerClientId;
    const assignment = await createAssignment({ ownerClientId: owner, address: ADDRESS });
    await recordMcpToolCallEvidence({
      assignmentId: assignment.id,
      ownerClientId: owner,
      jobId: ctx.uniqueId("job-query"),
      toolCalls: [
        {
          toolName: "datafordeler.property.resolve_property",
          provider: "datafordeler",
          args: { bfeNumber: "1" },
          result: { propertyId: "1" },
          fetchedAt: "2026-04-29T00:00:00Z",
          ok: true,
        },
      ],
    });

    const all = await queryVaultItems({ ownerClientId: owner });
    assert.equal(all.length, 1);
    assert.equal(all[0]!.kind, "mcp_tool_result");

    const filteredByProvider = await queryVaultItems({
      ownerClientId: owner,
      provider: "datafordeler",
    });
    assert.equal(filteredByProvider.length, 1);

    const filteredByMissingProvider = await queryVaultItems({
      ownerClientId: owner,
      provider: "plandata",
    });
    assert.equal(filteredByMissingProvider.length, 0);
  });
});

test("ensureVaultRecordedForAssignment returns [] for missing or non-complete assignments", async () => {
  await withSupabaseTestContext(async (ctx) => {
    const owner = ctx.ownerClientId;
    const stranger = ctx.uniqueOwnerId("stranger");

    assert.deepEqual(
      await ensureVaultRecordedForAssignment(ctx.uniqueId("missing"), owner),
      [],
    );

    const assignment = await createAssignment({ ownerClientId: owner, address: ADDRESS });
    assert.deepEqual(await ensureVaultRecordedForAssignment(assignment.id, stranger), []);

    assert.deepEqual(await ensureVaultRecordedForAssignment(assignment.id, owner), []);
  });
});

test("ensureVaultRecordedForAssignment records artifacts when the assignment has a complete job", async () => {
  await withSupabaseTestContext(async (ctx) => {
    const owner = ctx.ownerClientId;
    const assignment = await createAssignment({ ownerClientId: owner, address: ADDRESS });
    const report = await createReport(ADDRESS, {
      ownerClientId: owner,
      assignmentId: assignment.id,
    });
    await startReportJob(report.id, undefined, {
      runner: staticReportRunner(buildFixtureMarkdownRunnerResult(report.id, ADDRESS)),
    });
    const reviewReady = await getReport(report.id);
    assert.equal(reviewReady?.status, "awaiting_review");

    const { jobs, assignments } = createStores();
    await jobs.mutate(report.id, (job) => ({ ...job, status: "complete" as const }));
    await assignments.mutate(assignment.id, (current) => ({
      ...current,
      status: "complete" as const,
      reportJobId: report.id,
      vaultRecordedAt: undefined,
    }));

    const recorded = await ensureVaultRecordedForAssignment(assignment.id, owner);
    assert.ok(recorded.length >= 2, `expected at least markdown+pdf, got ${recorded.length}`);
    const kinds = recorded.map((item) => item.kind).sort();
    assert.ok(kinds.includes("report_markdown"));
    assert.ok(kinds.includes("report_pdf"));

    const replay = await ensureVaultRecordedForAssignment(assignment.id, owner);
    assert.ok(replay.length >= 2);
  });
});
