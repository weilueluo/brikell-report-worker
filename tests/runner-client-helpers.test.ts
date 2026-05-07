import assert from "node:assert/strict";
import { test } from "node:test";
import { staticReportRunner, failingReportRunner } from "./fixtures/runners/static-runner";

test("staticReportRunner.ensureReady is a noop and does not require Anthropic creds", async () => {
  // Intentionally leave Anthropic creds out of the environment; the static runner
  // must not touch managed-skill setup.
  const previousKey = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  try {
    const runner = staticReportRunner({ mcpCollectionEvidence: [] });
    await runner.ensureReady();
  } finally {
    if (previousKey !== undefined) process.env.ANTHROPIC_API_KEY = previousKey;
  }
});

test("staticReportRunner.run yields the supplied result and emits progress messages", async () => {
  const messages: string[] = [];
  const runner = staticReportRunner(
    { markdown: "# stub", mcpCollectionEvidence: [] },
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
