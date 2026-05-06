import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { validateReportV1, type ReportV1 } from "@brikell/shared";
import type { ReportRunnerProgress } from "./runner-types";

export type ManagedRunnerOutput = {
  managedPath: string;
  localPath?: string;
  content: string;
};

export type ExtractCanonicalOutcome =
  | { kind: "absent" }
  | { kind: "found"; report: ReportV1 }
  | { kind: "unreadable" }
  | { kind: "parse_failed" }
  | { kind: "validation_failed"; issues: ReturnType<typeof validateReportV1> };

const PROGRESS_MESSAGES = {
  unreadable: "Canonical V1 JSON file could not be read; falling back to Markdown.",
  parse_failed: "Canonical V1 JSON failed to parse; falling back to Markdown.",
  validation_failed: "Canonical V1 JSON failed validation; falling back to Markdown.",
} as const;

export async function extractCanonicalReportFromOutputs(
  outputs: ManagedRunnerOutput[],
  expectedManagedPath: string,
  onProgress?: ReportRunnerProgress,
): Promise<ExtractCanonicalOutcome> {
  const output = outputs.find((entry) => entry.managedPath === expectedManagedPath);
  if (!output) return { kind: "absent" };

  const raw = await readOutputContent(output);
  if (raw === undefined) {
    await onProgress?.(PROGRESS_MESSAGES.unreadable);
    return { kind: "unreadable" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    await onProgress?.(PROGRESS_MESSAGES.parse_failed);
    return { kind: "parse_failed" };
  }

  const validation = validateReportV1(parsed);
  if (!validation.ok) {
    await onProgress?.(PROGRESS_MESSAGES.validation_failed);
    return { kind: "validation_failed", issues: validation };
  }

  return { kind: "found", report: validation.report };
}

async function readOutputContent(output: ManagedRunnerOutput): Promise<string | undefined> {
  if (typeof output.content === "string" && output.content.length > 0) return output.content;
  if (!output.localPath) return undefined;
  try {
    return await readFile(resolve(output.localPath), "utf8");
  } catch {
    return undefined;
  }
}
