import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createReport,
  formatProgressMessageForUser,
  getReport,
  reviewReportJob,
  startReportJob,
} from "../src/reports/report-service";
import { createAssignment } from "../src/assignments/assignment-service";
import { createStores } from "../src/storage";
import type { AddressCandidate } from "@brikell/shared";
import { withSupabaseTestContext, type SupabaseTestContext } from "./fixtures/supabase-context";
import { staticReportRunner } from "./fixtures/runners/static-runner";
import {
  buildFixtureCanonicalRunnerResult,
  buildFixtureEmptyRunnerResult,
  buildFixtureMarkdownOnlyResult,
  buildFixtureMarkdownRunnerResult,
} from "./fixtures/runners/fixture-results";
import type { ManagedRunnerResult, ReportRunner } from "../src/agent/runner-client";

/**
 * Worker-side tests for `src/reports/report-service.ts`.
 *
 * These exercise the run/agent half of the report lifecycle that lives in
 * the worker process: starting a job, runner output handling, canonical V1
 * generation, vault provenance linking, and failure-mode user-facing
 * translation.
 *
 * Tests inject a `staticReportRunner(...)` so production never touches the
 * managed-skill runtime or Anthropic. The pure create/list/review flow is
 * covered by the app-side suite at `brikell-report-app/tests/report-service.test.ts`.
 */

test("static report run stores generated Markdown and PDF artifacts awaiting review", async () => {
  await withSupabaseTestContext(async (ctx) => {
    const reviewReady = await createAndRunReport(ctx, candidate(), (address) =>
      buildFixtureMarkdownRunnerResult("ignored", address),
    );
    assert.equal(reviewReady.status, "awaiting_review");
    assert.ok(reviewReady.markdownArtifactKey);
    assert.ok(reviewReady.pdfArtifactKey);

    const { artifacts } = createStores();
    const markdown = await artifacts.getArtifact(reviewReady.markdownArtifactKey!);
    const pdf = await artifacts.getArtifact(reviewReady.pdfArtifactKey!);
    assert.equal(markdown?.contentType, "text/markdown; charset=utf-8");
    assert.equal(pdf?.contentType, "application/pdf");
  });
});

test("direct report execution stores review-ready inline artifacts", async () => {
  await withSupabaseTestContext(async (ctx) => {
    const job = await createAndRunReport(ctx, candidate(), (address) =>
      buildFixtureMarkdownRunnerResult("ignored", address),
    );
    assert.equal(job.status, "awaiting_review");
    assert.equal(job.markdownArtifact?.encoding, "utf8");
    assert.match(job.markdownArtifact?.content ?? "", /# Brikell Property Intelligence Report/);
    assert.doesNotMatch(job.markdownArtifact?.content ?? "", /MCP|SQL|runtime session|Datasource provenance/i);
    assert.equal(job.pdfArtifact?.encoding, "base64");
    assert.ok(job.pdfArtifact?.content);
  });
});

test("agent progress messages are user-facing", () => {
  assert.equal(formatProgressMessageForUser("read"), "Reading datasource guidance.");
  assert.equal(formatProgressMessageForUser("Tool result"), "Datasource response received.");
  assert.equal(formatProgressMessageForUser("bash"), "Running report workspace check.");
  assert.equal(formatProgressMessageForUser("write"), "Writing report file.");
  assert.equal(formatProgressMessageForUser("edit"), "Updating report file.");
  assert.equal(formatProgressMessageForUser("grep"), "Checking report notes.");
  assert.equal(formatProgressMessageForUser("view"), "Reviewing collected report context.");
  assert.equal(formatProgressMessageForUser("Tool call: plandata.query_layer"), "Querying a datasource.");
  assert.equal(
    formatProgressMessageForUser("sqlite3 -json sql/session.db failed: unable to open database"),
    "Report workspace lookup was unavailable; continuing with datasource context.",
  );
  assert.equal(
    formatProgressMessageForUser("datafordeler_datafordeler_get_property_context ingested into SQL"),
    "Datafordeler property context saved for report generation.",
  );
  assert.equal(
    formatProgressMessageForUser("dataforsyningen_dataforsyningen_search_address_or_place"),
    "Searching Dataforsyningen for the confirmed address.",
  );
  assert.equal(
    formatProgressMessageForUser("plandata_plandata_query_layer diagnostic recorded"),
    "Planning layer lookup returned a datasource diagnostic.",
  );
});

test("canonical static runner renders V1 facts-first Markdown and persists a canonical JSON artifact", async () => {
  await withSupabaseTestContext(async (ctx) => {
    const ownerClientId = ctx.ownerClientId;
    const assignment = await createAssignment({ ownerClientId, address: candidate() });
    const job = await createAndRunReport(
      ctx,
      candidate(),
      (address) => buildFixtureCanonicalRunnerResult("ignored", address),
      { assignmentId: assignment.id },
    );
    assert.equal(job.status, "awaiting_review");
    assert.ok(job.canonicalArtifactKey, "canonicalArtifactKey should be populated");
    assert.ok(job.canonicalArtifact?.content);
    assert.equal(job.canonicalArtifact?.contentType, "application/json; charset=utf-8");
    assert.equal(job.canonicalArtifact?.encoding, "utf8");

    const parsedCanonical = JSON.parse(job.canonicalArtifact!.content) as {
      schemaVersion: string;
      subject: { inputAddress: string };
    };
    assert.equal(parsedCanonical.schemaVersion, "v1");
    assert.equal(parsedCanonical.subject.inputAddress, candidate().label);

    assert.ok(job.markdownArtifact?.content);
    assert.match(job.markdownArtifact!.content, /^# Brikell V1 fact compilation/);
    assert.match(job.markdownArtifact!.content, /Property identification/);

    const renderedEvent = job.events.find((event) => /Rendered facts-first report from canonical V1 output/.test(event.message));
    assert.ok(renderedEvent, "should record the canonical-render event");

    const { listVaultItemsForAssignment } = await import("../src/vault/vault-service");
    const beforeApproval = await listVaultItemsForAssignment(ownerClientId, assignment.id);
    assert.equal(beforeApproval.filter((item) => item.kind.startsWith("report_")).length, 0);

    await reviewReportJob(job.id, ownerClientId, { action: "approve" });
    const items = await listVaultItemsForAssignment(ownerClientId, assignment.id);
    assert.equal(items.length, 3, "three vault kinds should be recorded when canonical JSON is present");
    const kinds = new Set(items.map((item) => item.kind));
    assert.ok(kinds.has("report_markdown"));
    assert.ok(kinds.has("report_pdf"));
    assert.ok(kinds.has("report_canonical_json"));
  });
});

test("when canonical output is not produced the report falls back to runner Markdown", async () => {
  await withSupabaseTestContext(async (ctx) => {
    const job = await createAndRunReport(ctx, candidate(), (address) =>
      buildFixtureMarkdownOnlyResult("ignored", address, "Static fixture did not emit canonical V1."),
    );
    assert.equal(job.status, "awaiting_review");
    assert.equal(job.canonicalArtifactKey, undefined);
    assert.equal(job.canonicalArtifact, undefined);
    const fallbackEvent = job.events.find((event) => /Canonical V1 output not available/.test(event.message));
    assert.ok(fallbackEvent, "should record the canonical-not-available fallback event");
    assert.match(job.markdownArtifact!.content, /^# Brikell Property Intelligence Report/);
  });
});

test("require-canonical mode fails the job with an actionable error when canonical output is missing", async () => {
  await withEnv({ BRIKELL_REPORT_REQUIRE_CANONICAL: "on" }, () =>
    withSupabaseTestContext(async (ctx) => {
      const job = await createAndRunReport(ctx, candidate(), () =>
        buildFixtureEmptyRunnerResult("Static fixture did not emit canonical V1 (require-canonical assertion)."),
      );
      assert.equal(job.status, "failed");
      assert.ok(job.errorMessage, "errorMessage should be populated");
      assert.match(job.errorMessage!, /required.*not produced/i);
      assert.match(job.errorMessage!, /Static fixture did not emit canonical V1/i);
      assert.equal(job.markdownArtifactKey, undefined);
      assert.equal(job.canonicalArtifactKey, undefined);
    }),
  );
});

test("require-canonical mode completes normally when the runner produces a valid canonical V1 report", async () => {
  await withEnv({ BRIKELL_REPORT_REQUIRE_CANONICAL: "on" }, () =>
    withSupabaseTestContext(async (ctx) => {
      const job = await createAndRunReport(ctx, candidate(), (address) =>
        buildFixtureCanonicalRunnerResult("ignored", address),
      );
      assert.equal(job.status, "awaiting_review");
      assert.ok(job.canonicalArtifactKey, "canonicalArtifactKey should be populated");
      assert.ok(job.markdownArtifact?.content);
      assert.match(job.markdownArtifact!.content, /^# Brikell V1 fact compilation/);
    }),
  );
});

test("end-to-end vault link: uploaded source_document is cited as vault:<id>", async () => {
  await withEnv({ BRIKELL_REPORT_REQUIRE_CANONICAL: "on" }, () =>
    withSupabaseTestContext(async (ctx) => {
      const ownerClientId = ctx.ownerClientId;
      const assignment = await createAssignment({ ownerClientId, address: candidate() });

      const vaultItemId = ctx.uniqueId("vault-pdf");
      const seededAt = new Date().toISOString();
      const { vault } = createStores();
      await vault.create({
        id: vaultItemId,
        ownerClientId,
        assignmentId: assignment.id,
        kind: "source_document",
        title: "Source document — Delta_Park_Fact_Sheet.pdf",
        filename: "Delta_Park_Fact_Sheet.pdf",
        contentType: "application/pdf",
        metadata: {},
        createdAt: seededAt,
        updatedAt: seededAt,
      });

      const job = await createAndRunReport(
        ctx,
        candidate(),
        (address) =>
          buildFixtureCanonicalRunnerResult("ignored", address, {
            uploadedDocuments: [
              {
                vaultItemId,
                title: "Source document — Delta_Park_Fact_Sheet.pdf",
                type: "uploaded_pdf",
                filename: "Delta_Park_Fact_Sheet.pdf",
                contentType: "application/pdf",
              },
            ],
          }),
        { assignmentId: assignment.id },
      );
      assert.equal(job.status, "awaiting_review");
      assert.ok(job.canonicalArtifact?.content, "canonical artifact must be inlined on success");

      const persistedReport = JSON.parse(job.canonicalArtifact!.content) as {
        sourceDocuments: Array<{ id: string; vaultItemId?: string }>;
      };
      const linked = persistedReport.sourceDocuments.find((doc) => doc.id === `vault:${vaultItemId}`);
      assert.ok(linked, `expected canonical sourceDocuments to contain vault:${vaultItemId}`);
      assert.equal(linked.vaultItemId, vaultItemId, "linkSourceDocumentsToVault should have stamped vaultItemId");

      const linkEvent = job.events.find((event) => /Linked \d+ canonical source document/.test(event.message));
      assert.ok(linkEvent, "service should emit a 'Linked N canonical source document' event");
    }),
  );
});

test("end-to-end vault link: dangling vault:<id> is harmless when no canonical doc references it", async () => {
  await withEnv({ BRIKELL_REPORT_REQUIRE_CANONICAL: "on" }, () =>
    withSupabaseTestContext(async (ctx) => {
      const ownerClientId = ctx.ownerClientId;
      const assignment = await createAssignment({ ownerClientId, address: candidate() });
      const realVaultId = ctx.uniqueId("vault-real");

      const seededAt = new Date().toISOString();
      const { vault } = createStores();
      await vault.create({
        id: realVaultId,
        ownerClientId,
        assignmentId: assignment.id,
        kind: "source_document",
        title: "Source document — real.pdf",
        filename: "real.pdf",
        metadata: { fakeId: ctx.uniqueId("vault-dangling") },
        createdAt: seededAt,
        updatedAt: seededAt,
      });

      const job = await createAndRunReport(
        ctx,
        candidate(),
        (address) =>
          buildFixtureCanonicalRunnerResult("ignored", address, {
            uploadedDocuments: [
              {
                vaultItemId: realVaultId,
                title: "Source document — real.pdf",
                type: "uploaded_pdf",
                filename: "real.pdf",
                contentType: "application/pdf",
              },
            ],
          }),
        { assignmentId: assignment.id },
      );
      assert.equal(job.status, "awaiting_review");
      assert.ok(job.canonicalArtifact?.content);

      const persistedReport = JSON.parse(job.canonicalArtifact!.content) as {
        sourceDocuments: Array<{ id: string; vaultItemId?: string }>;
      };
      const linked = persistedReport.sourceDocuments.find((doc) => doc.id === `vault:${realVaultId}`);
      assert.ok(linked);
      assert.equal(linked.vaultItemId, realVaultId, "real upload must still resolve");
    }),
  );
});

test("when the runner produces neither markdown nor canonical, the job fails with warnings (no fake artifact)", async () => {
  await withSupabaseTestContext(async (ctx) => {
    const job = await createAndRunReport(ctx, candidate(), () =>
      buildFixtureEmptyRunnerResult(
        "Static fixture finished without writing final output files (empty-runner branch).",
      ),
    );
    assert.equal(job.status, "failed", "no-artifact outcomes are non-final");
    assert.equal(job.markdownArtifact, undefined, "must NOT persist a fake markdown artifact");
    assert.equal(job.markdownArtifactKey, undefined);
    assert.equal(job.pdfArtifactKey, undefined);
    assert.equal(job.canonicalArtifact, undefined);
    assert.equal(job.canonicalArtifactKey, undefined);
    assert.ok(job.warnings && job.warnings.length > 0, "warnings populated");
    assert.equal(job.warnings![0].code, "no_artifact_submitted");
    assert.ok(job.userFacingMessage, "userFacingMessage populated for the UI");
    assert.match(job.userFacingMessage!, /regenerate|finished without/i);
    assert.ok(job.errorMessage, "technical detail is retained for support");
  });
});

test("markJobFailed populates userFacingMessage with a friendly translation", async () => {
  await withEnv({ BRIKELL_REPORT_REQUIRE_CANONICAL: "on" }, () =>
    withSupabaseTestContext(async (ctx) => {
      const job = await createAndRunReport(ctx, candidate(), () =>
        buildFixtureEmptyRunnerResult("Static fixture did not emit canonical V1 (require-canonical assertion)."),
      );
      assert.equal(job.status, "failed");
      assert.ok(job.errorMessage, "raw errorMessage retained for support");
      assert.ok(job.userFacingMessage, "userFacingMessage set on failed jobs");
      assert.doesNotMatch(job.userFacingMessage!, /report\.md|report\.json|canonical V1|Static fixture did not emit/i);
    }),
  );
});

async function createAndRunReport(
  ctx: SupabaseTestContext,
  address: AddressCandidate,
  buildResult: (address: AddressCandidate) => ManagedRunnerResult,
  extra?: { assignmentId?: string },
) {
  const queued = await createReport(address, {
    ownerClientId: ctx.ownerClientId,
    assignmentId: extra?.assignmentId,
  });
  assert.equal(queued.status, "queued");
  const runner: ReportRunner = staticReportRunner(buildResult(address));
  await startReportJob(queued.id, undefined, { runner });
  return waitForReviewReady(queued.id);
}

async function waitForReviewReady(id: string) {
  for (let attempt = 0; attempt < 30; attempt++) {
    const job = await getReport(id);
    if (job?.status === "awaiting_review" || job?.status === "failed") return job;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Report job did not reach review.");
}

async function withEnv(overrides: Record<string, string>, callback: () => Promise<void>): Promise<void> {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(overrides)) {
    previous.set(key, process.env[key]);
    process.env[key] = value;
  }
  try {
    await callback();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function candidate(): AddressCandidate {
  return {
    id: "frederiksdalsvej-80a",
    label: "Frederiksdalsvej 80A, 2830 Virum",
    postalCode: "2830",
    city: "Virum",
    coordinates: { x: 724000, y: 6182000, srid: "EPSG:25832" },
    coordinateSource: "selected-candidate",
    source: { provider: "Dataforsyningen", serviceId: "gsearch" },
  };
}
