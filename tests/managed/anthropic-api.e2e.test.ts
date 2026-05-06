/**
 * Live Anthropic Messages-API smoke test.
 *
 * Runs as part of `pnpm test:e2e` (worker). Requires `ANTHROPIC_API_KEY`.
 * Fails loud — no skip — when the env is missing so the missing config is
 * visible at the place that ran the suite, instead of silently passing.
 *
 * Goal: prove that ANTHROPIC_API_KEY + the npm undici fetch path + the SDK can
 * complete a real Messages call end-to-end. This is the smallest signal that
 * the bridge's auth/network/dependency surface is healthy. It is NOT a
 * functional test of the managed-agent runner — there are unit/integration
 * tests for the runner's behaviour. This test only catches regressions in the
 * key/SDK/network chain.
 *
 * Cost budget: one Haiku call, max_tokens=8, ~$0.0001 per run.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { requireEnv } from "@brikell/shared";

const MODEL = process.env.ANTHROPIC_LIVE_MODEL ?? "claude-haiku-4-5";

test("Anthropic Messages API: minimal Haiku round-trip succeeds", async () => {
  const apiKey = requireEnv(
    "ANTHROPIC_API_KEY",
    "Required for the live Anthropic e2e test (~$0.0001/run).",
  );
  const Anthropic = (await import("@anthropic-ai/sdk")).default;
  const client = new Anthropic({ apiKey });
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 8,
    messages: [
      {
        role: "user",
        content: "Reply with exactly 'OK'.",
      },
    ],
  });

  assert.equal(response.role, "assistant");
  assert.ok(Array.isArray(response.content), "response.content should be an array");
  assert.ok(response.content.length > 0, "response.content should be non-empty");

  // First content block should be text. We don't assert the exact text since
  // model output can include whitespace/punctuation around "OK"; we only
  // need the network round-trip + auth + SDK shape to be sound.
  const firstBlock = response.content[0];
  assert.equal(firstBlock?.type, "text", "first content block should be text");
  if (firstBlock?.type === "text") {
    assert.ok(firstBlock.text.length > 0, "text block should be non-empty");
  }
});
