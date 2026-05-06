import assert from "node:assert/strict";
import { test } from "node:test";
import { deriveProvider } from "../src/agent/runner-client";
import { staticReportRunner, failingReportRunner } from "./fixtures/runners/static-runner";

test("deriveProvider recognizes the four known provider prefixes via dot, underscore, and substring", () => {
  assert.equal(deriveProvider("plandata.get_plan"), "plandata");
  assert.equal(deriveProvider("plandata_get_plan"), "plandata");
  assert.equal(deriveProvider("datafordeler.property.resolve_property"), "datafordeler");
  assert.equal(deriveProvider("dataforsyningen.search_address_or_place"), "dataforsyningen");
  assert.equal(deriveProvider("supabase.assignments.list"), "supabase");
  // Substring match (e.g. when provider name appears mid-name)
  assert.equal(deriveProvider("brikell-datafordeler-cache"), "datafordeler");
});

test("deriveProvider falls back to URL/dot-path heuristics for unknown providers", () => {
  assert.equal(deriveProvider("github/repo/list"), "github");
  assert.equal(deriveProvider("acme.tool"), "acme");
});

test("deriveProvider returns 'managed-agent' as the safe default when no provider can be inferred", () => {
  assert.equal(deriveProvider("doSomething"), "managed-agent");
  assert.equal(deriveProvider(""), "managed-agent");
});

test("staticReportRunner.ensureReady is a noop and does not require Anthropic creds", async () => {
  // Intentionally leave Anthropic creds out of the environment; the static runner
  // must not touch managed-skill setup.
  const previousKey = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  try {
    const runner = staticReportRunner({ mcpToolCalls: [] });
    await runner.ensureReady();
  } finally {
    if (previousKey !== undefined) process.env.ANTHROPIC_API_KEY = previousKey;
  }
});

test("staticReportRunner.run yields the supplied result and emits progress messages", async () => {
  const messages: string[] = [];
  const runner = staticReportRunner(
    { markdown: "# stub", mcpToolCalls: [] },
    { progressMessages: ["one", "two"] },
  );
  const result = await runner.run(
    "job-1",
    {
      id: "addr-1",
      label: "Test 1, 1000 København",
      postalCode: "1000",
      city: "København",
      coordinateSource: "selected-candidate",
      source: { provider: "Dataforsyningen", serviceId: "test" },
    },
    async (msg) => {
      messages.push(msg);
    },
    {},
  );
  assert.equal(result.markdown, "# stub");
  assert.deepEqual(messages, ["one", "two"]);
});

test("failingReportRunner throws on the configured phase", async () => {
  const error = new Error("boom");
  const runEnsureFails = failingReportRunner(error, { failOn: "ensureReady" });
  await assert.rejects(() => runEnsureFails.ensureReady(), /boom/);

  const runRunFails = failingReportRunner(error, { failOn: "run" });
  await runRunFails.ensureReady(); // ok
  await assert.rejects(
    () =>
      runRunFails.run(
        "job-1",
        {
          id: "addr-1",
          label: "Test 1, 1000 København",
          postalCode: "1000",
          city: "København",
          coordinateSource: "selected-candidate",
          source: { provider: "Dataforsyningen", serviceId: "test" },
        },
        async () => {},
        {},
      ),
    /boom/,
  );
});
