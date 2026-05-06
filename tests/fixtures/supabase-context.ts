import { withSupabaseTestContext as runWith, type SupabaseTestContext } from "@brikell/shared/test-helpers";
import { readAppEnv } from "../../src/validation/env";
import { getSupabaseAdminClient } from "../../src/storage/supabase-client";

/**
 * Worker-side wrapper around `@brikell/shared/test-helpers`'s
 * `withSupabaseTestContext` that uses the worker's admin Supabase client and
 * `SUPABASE_STORAGE_BUCKET` env. Each invocation mints a fresh `test-owner-…`
 * id, hands the test real Supabase-backed stores, and tears down every row +
 * artifact written under any test-prefixed owner the test touched.
 */
export async function withSupabaseTestContext(
  callback: (context: SupabaseTestContext) => Promise<void>,
): Promise<void> {
  const client = getSupabaseAdminClient();
  const bucket = readAppEnv().SUPABASE_STORAGE_BUCKET;
  await runWith({ client, bucket }, callback);
}

export type { SupabaseTestContext } from "@brikell/shared/test-helpers";
