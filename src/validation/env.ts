import { z } from "zod";

const emptyStringToUndefined = (value: unknown) => {
  return typeof value === "string" && value.trim() === "" ? undefined : value;
};

const optionalNonEmptyString = z.preprocess(emptyStringToUndefined, z.string().min(1).optional());
const defaultedNonEmptyString = (defaultValue: string) =>
  z.preprocess(emptyStringToUndefined, z.string().min(1).default(defaultValue));
const defaultedUrl = (defaultValue: string) => z.preprocess(emptyStringToUndefined, z.string().url().default(defaultValue));
const defaultedPositiveInteger = (defaultValue: number) =>
  z.preprocess(emptyStringToUndefined, z.coerce.number().int().positive().default(defaultValue));

const envSchema = z.object({
  ANTHROPIC_API_KEY: optionalNonEmptyString,
  DATAFORSYNINGEN_MCP_URL: defaultedUrl("https://brikell-mcp-dataforsyningen-production.up.railway.app/mcp"),
  DATAFORSYNINGEN_MCP_API_TOKEN: optionalNonEmptyString,
  DATAFORSYNINGEN_MCP_ORIGIN: optionalNonEmptyString,
  BRIKELL_DEMO_PASSWORD: optionalNonEmptyString,
  BRIKELL_REPORT_REQUIRE_CANONICAL: z.enum(["on", "off"]).default("off"),
  SUPABASE_URL: optionalNonEmptyString,
  /**
   * Modern Supabase secret key (sb_secret_…). Server-only — bypasses RLS.
   * Replaces the legacy JWT-based service_role key. The legacy
   * SUPABASE_SERVICE_ROLE_KEY is accepted as a fallback because the local
   * `supabase status -o env` CLI still emits the legacy field name.
   */
  SUPABASE_SECRET_KEY: optionalNonEmptyString,
  SUPABASE_SERVICE_ROLE_KEY: optionalNonEmptyString,
  /**
   * Modern Supabase publishable key (sb_publishable_…). Browser-safe — RLS
   * enforced. Captured for forward compatibility; not used at runtime today
   * since all Supabase access is server-side via the admin client.
   */
  SUPABASE_PUBLISHABLE_KEY: optionalNonEmptyString,
  SUPABASE_ANON_KEY: optionalNonEmptyString,
  SUPABASE_STORAGE_BUCKET: defaultedNonEmptyString("brikell-artifacts"),
  BRIKELL_APP_BASE_URL: defaultedUrl("http://localhost:3000"),
  MANAGED_AGENT_OUTPUT_MIRROR_DIR: optionalNonEmptyString,
  MANAGED_AGENT_RUN_OUTPUT_DIR: optionalNonEmptyString,
  BRIKELL_REPORT_WORKER_ID: optionalNonEmptyString,
  BRIKELL_REPORT_WORKER_POLL_MS: defaultedPositiveInteger(5_000),
  BRIKELL_REPORT_WORKER_HEARTBEAT_MS: defaultedPositiveInteger(15_000),
  BRIKELL_REPORT_WORKER_STALE_MS: defaultedPositiveInteger(30 * 60_000),
  BRIKELL_REPORT_WORKER_CONCURRENCY: defaultedPositiveInteger(1),
});

export type AppEnv = z.infer<typeof envSchema>;

export function readAppEnv(): AppEnv {
  return envSchema.parse(process.env);
}

/**
 * Resolve the server-side Supabase admin key. Prefers the modern
 * SUPABASE_SECRET_KEY (sb_secret_…); falls back to the legacy
 * SUPABASE_SERVICE_ROLE_KEY so existing local Supabase CLI output and old
 * environments keep working until the migration is complete.
 */
export function getSupabaseSecretKey(env: AppEnv): string | undefined {
  return env.SUPABASE_SECRET_KEY ?? env.SUPABASE_SERVICE_ROLE_KEY;
}

/**
 * Resolve the browser-safe Supabase publishable key. Prefers the modern
 * SUPABASE_PUBLISHABLE_KEY (sb_publishable_…); falls back to the legacy
 * SUPABASE_ANON_KEY.
 */
export function getSupabasePublishableKey(env: AppEnv): string | undefined {
  return env.SUPABASE_PUBLISHABLE_KEY ?? env.SUPABASE_ANON_KEY;
}
