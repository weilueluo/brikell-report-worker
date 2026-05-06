import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { getSupabaseSecretKey, readAppEnv } from "../validation/env";

let cachedClient: SupabaseClient | undefined;
let cachedClientKey = "";

/**
 * App-side factory for the admin Supabase client. The shared package's stores
 * accept any SupabaseClient via constructor injection (no env coupling), so the
 * app and worker each own their own client construction with their own env
 * conventions.
 */
export function getSupabaseAdminClient(): SupabaseClient {
  const env = readAppEnv();
  const secretKey = getSupabaseSecretKey(env);
  if (!env.SUPABASE_URL || !secretKey) {
    throw new Error(
      "Supabase storage is required but SUPABASE_URL or SUPABASE_SECRET_KEY (or legacy SUPABASE_SERVICE_ROLE_KEY) is missing.",
    );
  }
  const key = `${env.SUPABASE_URL}|${secretKey}`;
  if (cachedClient && cachedClientKey === key) return cachedClient;
  cachedClient = createClient(env.SUPABASE_URL, secretKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  cachedClientKey = key;
  return cachedClient;
}

export function resetSupabaseAdminClientForTests(): void {
  cachedClient = undefined;
  cachedClientKey = "";
}
