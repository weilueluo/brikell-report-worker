import assert from "node:assert/strict";
import { test } from "node:test";
import { resolve } from "node:path";
import {
  createManagedRunnerErrorDiagnostic,
  getSkillRegistryPath,
} from "../../src/agent/managed/runner";

async function withEnv(overrides: Record<string, string | undefined>, callback: () => Promise<void>): Promise<void> {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(overrides)) {
    previous.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
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

test("createManagedRunnerErrorDiagnostic captures name, message, and stack from a plain Error", () => {
  const error = new Error("boom");
  const diag = createManagedRunnerErrorDiagnostic(error);
  assert.equal(diag.message, "boom");
  assert.equal(diag.name, "Error");
  assert.ok(diag.stack);
  assert.equal(diag.causes, undefined);
});

test("createManagedRunnerErrorDiagnostic falls back to String(error) for non-Error values", () => {
  assert.equal(createManagedRunnerErrorDiagnostic("simple string").message, "simple string");
  assert.equal(createManagedRunnerErrorDiagnostic(42).message, "42");
  assert.equal(createManagedRunnerErrorDiagnostic(undefined).message, "undefined");
});

test("createManagedRunnerErrorDiagnostic walks the cause chain (depth-capped) and includes errno/code", () => {
  const root = Object.assign(new Error("root cause"), { code: "ENOTFOUND", errno: -3008 });
  const middle = Object.assign(new Error("middle"), { cause: root });
  const top = new Error("top", { cause: middle });
  const diag = createManagedRunnerErrorDiagnostic(top);
  assert.equal(diag.message, "top");
  assert.ok(diag.causes);
  assert.equal(diag.causes!.length, 2);
  assert.equal(diag.causes![0]!.message, "middle");
  assert.equal(diag.causes![1]!.message, "root cause");
  assert.equal(diag.causes![1]!.code, "ENOTFOUND");
  assert.equal(diag.causes![1]!.errno, -3008);
});

test("createManagedRunnerErrorDiagnostic stops walking when a cause cycles back on itself", () => {
  const a: { name: string; message: string; cause?: unknown } = { name: "A", message: "a" };
  a.cause = a;
  const error = new Error("outer", { cause: a });
  const diag = createManagedRunnerErrorDiagnostic(error);
  // Single non-circular cause is captured; the self-referential link breaks the walk.
  assert.equal(diag.causes?.length, 1);
});

test("getSkillRegistryPath uses MANAGED_AGENT_SKILL_REGISTRY_FILE when provided", async () => {
  await withEnv({ MANAGED_AGENT_SKILL_REGISTRY_FILE: "tmp/custom-registry.json", VERCEL: undefined }, async () => {
    assert.equal(getSkillRegistryPath(), resolve(process.cwd(), "tmp/custom-registry.json"));
  });
});

test("getSkillRegistryPath uses /tmp on Vercel and cwd elsewhere when no override is set", async () => {
  await withEnv({ MANAGED_AGENT_SKILL_REGISTRY_FILE: undefined, VERCEL: "1" }, async () => {
    assert.match(getSkillRegistryPath(), /[\\/]tmp[\\/]/);
  });
  await withEnv({ MANAGED_AGENT_SKILL_REGISTRY_FILE: undefined, VERCEL: undefined }, async () => {
    const path = getSkillRegistryPath();
    assert.ok(path.startsWith(process.cwd()), `expected ${path} to start with ${process.cwd()}`);
  });
});
