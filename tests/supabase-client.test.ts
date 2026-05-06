import assert from "node:assert/strict";
import { test } from "node:test";
import {
  getSupabaseAdminClient,
  resetSupabaseAdminClientForTests,
} from "../src/storage/supabase-client";

async function withEnv(overrides: Record<string, string | undefined>, callback: () => Promise<void>): Promise<void> {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(overrides)) {
    previous.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetSupabaseAdminClientForTests();
  try {
    await callback();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    resetSupabaseAdminClientForTests();
  }
}

test("getSupabaseAdminClient returns a client when SUPABASE_URL and SUPABASE_SECRET_KEY are present", async () => {
  await withEnv(
    {
      SUPABASE_URL: "https://stub.supabase.co",
      SUPABASE_SECRET_KEY: "sb_secret_test",
      SUPABASE_SERVICE_ROLE_KEY: undefined,
    },
    async () => {
      const client = getSupabaseAdminClient();
      assert.ok(client);
      // The factory caches a single instance per (url, key) pair.
      assert.equal(getSupabaseAdminClient(), client);
    },
  );
});

test("getSupabaseAdminClient falls back to the legacy SUPABASE_SERVICE_ROLE_KEY", async () => {
  await withEnv(
    {
      SUPABASE_URL: "https://stub.supabase.co",
      SUPABASE_SECRET_KEY: undefined,
      SUPABASE_SERVICE_ROLE_KEY: "service-role-test",
    },
    async () => {
      const client = getSupabaseAdminClient();
      assert.ok(client);
    },
  );
});

test("getSupabaseAdminClient throws a clear error when neither URL nor key is set", async () => {
  await withEnv(
    {
      SUPABASE_URL: undefined,
      SUPABASE_SECRET_KEY: undefined,
      SUPABASE_SERVICE_ROLE_KEY: undefined,
    },
    async () => {
      assert.throws(() => getSupabaseAdminClient(), /SUPABASE_URL or SUPABASE_SECRET_KEY/);
    },
  );
});

test("getSupabaseAdminClient rebuilds the client when the url or key changes", async () => {
  let firstClient: unknown;
  await withEnv(
    { SUPABASE_URL: "https://stub-a.supabase.co", SUPABASE_SECRET_KEY: "sb_secret_a", SUPABASE_SERVICE_ROLE_KEY: undefined },
    async () => {
      firstClient = getSupabaseAdminClient();
    },
  );
  await withEnv(
    { SUPABASE_URL: "https://stub-b.supabase.co", SUPABASE_SECRET_KEY: "sb_secret_b", SUPABASE_SERVICE_ROLE_KEY: undefined },
    async () => {
      const next = getSupabaseAdminClient();
      assert.notEqual(next, firstClient);
    },
  );
});

test("resetSupabaseAdminClientForTests forces the next call to construct a new client", async () => {
  await withEnv(
    {
      SUPABASE_URL: "https://stub.supabase.co",
      SUPABASE_SECRET_KEY: "sb_secret_test",
      SUPABASE_SERVICE_ROLE_KEY: undefined,
    },
    async () => {
      const a = getSupabaseAdminClient();
      resetSupabaseAdminClientForTests();
      const b = getSupabaseAdminClient();
      assert.notEqual(a, b, "expected the cache to invalidate after reset");
    },
  );
});
