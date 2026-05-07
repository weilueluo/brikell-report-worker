import { z } from "zod";

const STATUS_LINE_BYTE_CAP = 4 * 1024;

export const skillStatusIntentSchema = z.enum([
  "property.collect",
  "planning.collect",
  "address.resolve",
]);

export const skillStatusRefSchema = z.object({
  source: z.string().min(1),
  upstreamId: z.string().min(1).optional(),
  fetchedAt: z.string().datetime(),
});

export const skillStatusCountsSchema = z.object({
  records: z.number().int().nonnegative(),
  documents: z.number().int().nonnegative(),
});

export const skillSuccessStatusLineSchema = z.object({
  ok: z.literal(true),
  intent: skillStatusIntentSchema,
  collection_id: z.string().min(1),
  request_key: z.string().min(1),
  status: z.enum(["success", "partial", "error"]),
  ref: skillStatusRefSchema,
  counts: skillStatusCountsSchema,
  response_sha256: z.string().min(1),
  response_bytes: z.number().int().nonnegative(),
});

export const skillFailureStatusLineSchema = z.object({
  ok: z.literal(false),
  intent: skillStatusIntentSchema,
  code: z.string().min(1),
  retryable: z.boolean(),
  safe_message: z.string().min(1),
  partial_collection_id: z.string().min(1).nullable(),
});

export const skillStatusLineSchema = z.discriminatedUnion("ok", [
  skillSuccessStatusLineSchema,
  skillFailureStatusLineSchema,
]);

export type SkillSuccessStatusLine = z.infer<typeof skillSuccessStatusLineSchema>;
export type SkillFailureStatusLine = z.infer<typeof skillFailureStatusLineSchema>;
export type SkillStatusLine = z.infer<typeof skillStatusLineSchema>;

export type SkillStatusParseResult =
  | { ok: true; status: SkillStatusLine }
  | { ok: false; code: "internal_oversized_status" | "invalid_status_line" };

export function parseSkillStatusLine(line: string): SkillStatusParseResult {
  if (Buffer.byteLength(line, "utf8") > STATUS_LINE_BYTE_CAP) {
    return { ok: false, code: "internal_oversized_status" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return { ok: false, code: "invalid_status_line" };
  }

  const status = skillStatusLineSchema.safeParse(parsed);
  if (!status.success) {
    return { ok: false, code: "invalid_status_line" };
  }

  return { ok: true, status: status.data };
}
