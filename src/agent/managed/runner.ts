import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Anthropic, { toFile } from "@anthropic-ai/sdk";
import {
  buildLongLivedFetch,
  getManagedAgentFetchLoadError,
  getManagedAgentFetchPath,
  getManagedAgentUndiciVersion,
  primeManagedAgentDispatcher,
} from "./streaming-fetch";
import { iterateSessionEventsResilient } from "./session-stream-resilience";
import { sendSessionEventsWithTimeout } from "./session-events-send";
import { isRealTerminalSessionEvent } from "./terminal-events";
import {
  selectRequiredCustomToolUseEvents,
  type ManagedCustomToolUseEvent,
} from "./custom-tool-results";
import { normalizeManagedInputSchema, type ManagedToolInputSchema } from "./managed-tool-schema";
import {
  formatSessionTimelineEntry,
  formatTimelinePayload,
  type ManagedSessionTimelineKind,
} from "./session-timeline";
import { defaultSessionSqlDbPath, sanitizeDiagnosticMessage, SessionSqlStore } from "./sql/session-store";
import { sanitizeEventPayload, structuredEvent } from "./structured-events";

type McpServerConfig = {
  name: string;
  url: string;
  token: string;
  origin?: string;
};

type JsonRpcResponse = {
  result?: unknown;
  error?: {
    code?: number;
    message?: string;
    data?: unknown;
  };
};

type McpToolDefinition = {
  name: string;
  description?: string;
  inputSchema?: unknown;
  input_schema?: unknown;
};

type ManagedToolDefinition = {
  type: "custom";
  name: string;
  description: string;
  input_schema: ManagedToolInputSchema;
};

type ToolBridgeEntry = {
  managedName: string;
  mcpName: string;
  server: McpServerConfig;
};

type ToolBridge = {
  tools: ManagedToolDefinition[];
  entries: Map<string, ToolBridgeEntry>;
};

type LocalSkillDefinition = {
  key: string;
  displayTitle: string;
  directoryPath: string;
  skillIdEnv: string;
  versionEnv: string;
};

type SkillFileMetadata = {
  name?: string;
  displayTitle?: string;
};

type SkillRegistryEntry = {
  skillId: string;
  version: string;
  hash: string;
};

type SkillRegistry = Record<string, SkillRegistryEntry>;

type ManagedAgentBuiltinToolName = "bash" | "edit" | "read" | "write" | "glob" | "grep" | "web_fetch" | "web_search";

type RetryableToolErrorInfo = {
  code?: string;
  message?: string;
  reason: string;
};

type ManagedSkillReference = { type: "custom"; skill_id: string; version: string };
type ResolvedManagedSkillReference = {
  skillId: string;
  version: string;
};

type ManagedOutputOperation =
  | { kind: "write"; managedPath: string; localPath: string; content: string }
  | { kind: "edit"; managedPath: string; localPath: string; oldString: string; newString: string };

type ManagedOutputSnapshot = {
  managedPath: string;
  localPath: string;
  content: string;
};

type ManagedRunAttemptOptions = {
  beta: any;
  managedSkills: ManagedSkillReference[];
  agentTools: unknown[];
  toolBridge: ToolBridge;
  datasourceToolNames: Set<string>;
  inputMessage: string;
  workflowInstructions: string;
  sessionTitle?: string;
};

export type ManagedRunEvent = {
  kind: ManagedSessionTimelineKind;
  message: string;
  details?: unknown;
  elapsedMs: number;
};

export type ManagedRunEventSink = (event: ManagedRunEvent) => void | Promise<void>;

export type ManagedRunOutput = ManagedOutputSnapshot;

export type ManagedMessageRunResult = {
  dryRun: boolean;
  runLogPath: string;
  agentId?: string;
  environmentId?: string;
  sessionId?: string;
  eventCount: number;
  outputs: ManagedRunOutput[];
};

export type RunManagedMessageOptions = {
  dryRun?: boolean;
  outputMirrorDir?: string;
  runOutputDir?: string;
  runOutputFile?: string;
  environmentName?: string;
  sessionTitle?: string;
  onEvent?: ManagedRunEventSink;
};

const DEFAULT_MODEL = "claude-sonnet-4-5";
const DEFAULT_DATAFORDELER_BASE_URL = "https://brikell-mcp-datafordeler-production.up.railway.app";
const DEFAULT_DATAFORSYNINGEN_BASE_URL = "https://brikell-mcp-dataforsyningen-production.up.railway.app";
const DEFAULT_OUTPUT_MIRROR_DIR = ".managed-agent-outputs";
const DEFAULT_RUN_OUTPUT_DIR = ".managed-agent-runs";
const DEFAULT_SKILL_REGISTRY_FILE = ".managed-agent-skills.json";
const DEFAULT_SKILLS_DIR = "skills";
const AGENTS_FILE_NAME = "agents.md";
const DEFAULT_WORKFLOW_INSTRUCTION_MAX_CHARS = 18_000;
const SKILL_FILE_NAME = "SKILL.md";
const DEFAULT_MCP_TOOL_RETRY_ATTEMPTS = 3;
const DEFAULT_MCP_TOOL_RETRY_BASE_DELAY_MS = 1_000;
/**
 * Per-MCP-call wall-clock cap. Datafordeler can hang on ambiguous-property
 * lookups (observed: 55+ minute hang on `get_property_context` for an
 * address with two candidates). Without this cap the bridge sits on a
 * dead socket until Vercel kills the function at the 60-min duration
 * limit, leaving the agent session orphaned. With this cap the fetch is
 * aborted, an error is surfaced to the agent as is_error: true, and the
 * agent can either skip, retry, or fail gracefully.
 *
 * 90s is comfortable headroom for the slowest legitimate Datafordeler
 * responses we've observed (~30s) while staying well under any sane
 * function-duration cap.
 */
const DEFAULT_MCP_CALL_TIMEOUT_MS = 90_000;
const ENABLED_AGENT_BUILTIN_TOOLS: ManagedAgentBuiltinToolName[] = ["read", "write", "edit", "bash", "web_search"];
const RETRYABLE_MCP_ERROR_CODES = new Set(["upstream_unavailable", "upstream_timeout", "timeout", "temporarily_unavailable", "rate_limited"]);
const MANAGED_SESSION_OUTPUT_PREFIX = "/mnt/session/outputs/";
const ALWAYS_ALLOW_PERMISSION = { type: "always_allow" as const };
export const MANAGED_AGENT_ENVIRONMENT_PACKAGES = {
  type: "packages",
  apt: ["sqlite3", "curl", "poppler-utils", "tesseract-ocr", "tesseract-ocr-dan"],
} as const;
export const MANAGED_AGENT_ENVIRONMENT_CONFIG = {
  type: "cloud",
  packages: MANAGED_AGENT_ENVIRONMENT_PACKAGES,
} as const;
const MANAGED_AGENT_TOOLSET = {
  type: "agent_toolset_20260401",
  default_config: {
    enabled: false,
    permission_policy: { type: "always_ask" as const },
  },
  configs: ENABLED_AGENT_BUILTIN_TOOLS.map((name) => ({
    name,
    enabled: true,
    permission_policy: ALWAYS_ALLOW_PERMISSION,
  })),
};
const IMPORTANT_FIELD_NAMES = new Set([
  "adressebetegnelse",
  "address",
  "bfeNumber",
  "bfeNummer",
  "byg021BygningensAnvendelse",
  "byg026Opfoerelsesaar",
  "doklink",
  "ejerlavKode",
  "enh020EnhedensAnvendelse",
  "enh023Boligtype",
  "enh026EnhedensSamledeAreal",
  "enh027ArealTilBeboelse",
  "enh028ArealTilErhverv",
  "enh031AntalVaerelser",
  "etage",
  "kommunekode",
  "kommune",
  "matrikelnummer",
  "opgang",
  "planid",
  "planId",
  "plannavn",
  "plannr",
  "plantype",
  "propertyId",
  "status",
  "warnings",
]);

/**
 * Anchor for runtime-loaded assets (skills/, agents.md, docs/agents/).
 *
 * The runner's runtime assets sit alongside this module in source — historically
 * under `brikell-report-app/lib/agent/managed/`, after extraction under
 * `brikell-report-worker/src/managed/`. We resolve the asset directory by the
 * module's own URL, walking up until we find `agents.md`. This makes the runner
 * package-layout-independent and survives the worker extraction without code
 * changes. `MANAGED_AGENT_ROOT` overrides for deploy-image use cases.
 */
const managedRoot = resolveManagedRoot();
// Kept as `workspaceDir` so existing helpers (isWorkspacePath, relative(...)) work without rename.
// Bound the workspace to the managed dir so loadWorkflowInstructions cannot follow markdown links
// outside the managed runner's docs.
const workspaceDir = managedRoot;

function resolveManagedRoot(): string {
  const override = process.env.MANAGED_AGENT_ROOT;
  if (override && override.length > 0) return resolve(override);
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    if (existsSync(resolve(dir, AGENTS_FILE_NAME))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return resolve(process.cwd(), "lib", "agent", "managed");
}

const ts = () => new Date().toISOString().split("T")[1]!.replace("Z", "");
let runOutputFilePath: string | undefined;
let activeRunEventSink: ManagedRunEventSink | undefined;
let managedSkillEnvironmentPromise: Promise<ManagedSkillReference[]> | undefined;

export function buildManagedEnvironmentCreateInput(): {
  name: string;
  config: typeof MANAGED_AGENT_ENVIRONMENT_CONFIG;
} {
  return {
    name: process.env.MANAGED_AGENT_ENVIRONMENT_NAME ?? "brikell-mcp-message-env",
    config: MANAGED_AGENT_ENVIRONMENT_CONFIG,
  };
}

function timestampFileSegment(date = new Date()): string {
  return date.toISOString().replace(/[:.]/g, "-");
}

function initializeRunOutputFile(): string {
  if (runOutputFilePath) return runOutputFilePath;

  const configuredFile = process.env.MANAGED_AGENT_RUN_OUTPUT_FILE?.trim();
  runOutputFilePath = configuredFile
    ? resolve(process.cwd(), configuredFile)
    : resolve(
        process.cwd(),
        process.env.MANAGED_AGENT_RUN_OUTPUT_DIR?.trim() || DEFAULT_RUN_OUTPUT_DIR,
        `run-${timestampFileSegment()}.log`,
      );

  mkdirSync(resolve(runOutputFilePath, ".."), { recursive: true });
  writeFileSync(runOutputFilePath, "", "utf8");
  return runOutputFilePath;
}

function appendRunOutput(text: string): void {
  if (!runOutputFilePath) return;
  appendFileSync(runOutputFilePath, text, "utf8");
}

function writeStdout(text: string): void {
  process.stdout.write(text);
  appendRunOutput(text);
}

function writeStderr(text: string): void {
  process.stderr.write(text);
  appendRunOutput(text);
}

function log(tag: string, obj: unknown = "") {
  const body = formatTimelinePayload(obj, 500);
  writeStdout(`[${ts()}] ${tag}${body ? " " + body : ""}\n`);
}

function logJsonEvent(name: string, payload?: unknown): void {
  writeStdout(structuredEvent(name, payload));
}

let fetchPathLogged = false;

/**
 * Log once per process which fetch path the managed-agent client is using.
 * Helps operators distinguish between the long-lived undici path (good) and
 * the global fallback path (still works but caps long sessions at 5 min).
 */
function logFetchPathOnce(): void {
  if (fetchPathLogged) return;
  fetchPathLogged = true;
  primeManagedAgentDispatcher();
  const path = getManagedAgentFetchPath();
  const undiciVersion = getManagedAgentUndiciVersion();
  if (path === "global-fallback") {
    const cause = getManagedAgentFetchLoadError();
    const detail = cause instanceof Error ? `${cause.name}: ${cause.message}` : cause ? String(cause) : undefined;
    logJsonEvent("managed_agent_fetch_path", { path, ...(detail ? { cause: detail } : {}) });
  } else {
    logJsonEvent("managed_agent_fetch_path", { path, ...(undiciVersion ? { undiciVersion } : {}) });
  }
}

function createManagedAnthropicClient(apiKey: string): Anthropic {
  // Connection resilience: managed-agent SSE streams stay open for the
  // full agent run, with multi-minute silent windows during server-side
  // tool execution. Node's built-in undici defaults to a 5-min
  // bodyTimeout that terminates the socket. We route managed-agent calls
  // through npm undici's fetch end-to-end (bodyTimeout: 0); see
  // src/streaming-fetch.ts for the full rationale.
  // SDK timeout = 30 min covers the response-headers timeout (default 10).
  return new Anthropic({
    apiKey,
    fetch: buildLongLivedFetch(),
    timeout: 30 * 60 * 1000,
  });
}

export function createManagedRunnerErrorDiagnostic(error: unknown): {
  name?: string;
  message: string;
  stack?: string;
  causes?: Array<{ name?: string; message: string; code?: string; errno?: number; stack?: string }>;
} {
  const raw =
    error instanceof Error
      ? { name: error.name, message: error.message, stack: error.stack }
      : { message: String(error) };
  const sanitized = sanitizeEventPayload(raw, 8_000);
  if (!isRecord(sanitized)) return { message: String(sanitized) };

  const message = typeof sanitized.message === "string" ? sanitized.message : "Unknown managed runner error.";
  const result: ReturnType<typeof createManagedRunnerErrorDiagnostic> = {
    name: typeof sanitized.name === "string" ? sanitized.name : undefined,
    message,
    stack: typeof sanitized.stack === "string" ? sanitized.stack : undefined,
  };

  // The Anthropic SDK wraps low-level fetch failures as APIConnectionError with the
  // generic message "Connection error.", losing the underlying cause. Walking the
  // full cause chain is essential for diagnosing transport-level problems (DNS,
  // TLS, dispatcher mismatch, ECONNRESET, ENOTFOUND, etc.). We cap depth so a
  // self-referential cause cannot run away.
  const causes: NonNullable<ReturnType<typeof createManagedRunnerErrorDiagnostic>["causes"]> = [];
  let current: unknown = error instanceof Error ? error.cause : undefined;
  const seen = new Set<unknown>();
  for (let depth = 0; depth < 5 && current && !seen.has(current); depth++) {
    seen.add(current);
    const c = current as { name?: string; message?: string; code?: string; errno?: number; stack?: string; cause?: unknown };
    causes.push({
      name: typeof c.name === "string" ? c.name : undefined,
      message: typeof c.message === "string" ? c.message : String(c),
      code: typeof c.code === "string" ? c.code : undefined,
      errno: typeof c.errno === "number" ? c.errno : undefined,
      stack: typeof c.stack === "string" ? c.stack.slice(0, 4_000) : undefined,
    });
    current = c.cause;
  }
  if (causes.length > 0) result.causes = causes;
  return result;
}

function logTimeline(
  kind: ManagedSessionTimelineKind,
  message: string,
  startedAt: number,
  details?: unknown,
): void {
  const elapsedMs = Date.now() - startedAt;
  writeStdout(
    `${formatSessionTimelineEntry(
      {
        kind,
        message,
        details,
        elapsedMs,
      },
      { columns: process.stdout.columns },
    )}\n`,
  );
  void activeRunEventSink?.({ kind, message, details, elapsedMs });
}

function safeToolErrorMessage(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message : String(error || fallback);
  const sanitized = sanitizeEventPayload({ message });
  return isRecord(sanitized) && typeof sanitized.message === "string" ? sanitized.message : fallback;
}

function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
  return values.find((value) => value?.trim())?.trim();
}

function normalizeMcpUrl(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;

  const withoutTrailingSlash = trimmed.replace(/\/+$/, "");
  return withoutTrailingSlash.endsWith("/mcp") ? withoutTrailingSlash : `${withoutTrailingSlash}/mcp`;
}

function requireValue(value: string | undefined, description: string): string {
  if (value) return value;
  throw new Error(`Missing ${description}. Set the matching environment variable.`);
}

function getMcpServers(): McpServerConfig[] {
  const servers = [
    {
      name: process.env.PLANDATA_MCP_NAME ?? "plandata",
      token: firstNonEmpty(process.env.PLANDATA_MCP_API_TOKEN, process.env.PLANDATA_MCP_TOKEN),
      url: normalizeMcpUrl(firstNonEmpty(process.env.PLANDATA_MCP_URL, process.env.PLANDATA_REMOTE_BASE_URL)),
      origin: firstNonEmpty(process.env.PLANDATA_MCP_ORIGIN),
    },
    {
      name: process.env.DATAFORDELER_MCP_NAME ?? "datafordeler",
      token: firstNonEmpty(process.env.DATAFORDELER_MCP_API_TOKEN, process.env.DATAFORDELER_MCP_TOKEN),
      url: normalizeMcpUrl(
        firstNonEmpty(
          process.env.DATAFORDELER_MCP_URL,
          process.env.DATAFORDELER_REMOTE_BASE_URL,
          DEFAULT_DATAFORDELER_BASE_URL,
        ),
      ),
      origin: undefined,
    },
    {
      name: process.env.DATAFORSYNINGEN_MCP_NAME ?? "dataforsyningen",
      token: firstNonEmpty(process.env.DATAFORSYNINGEN_MCP_API_TOKEN, process.env.DATAFORSYNINGEN_MCP_TOKEN),
      url: normalizeMcpUrl(
        firstNonEmpty(
          process.env.DATAFORSYNINGEN_MCP_URL,
          process.env.DATAFORSYNINGEN_REMOTE_BASE_URL,
          DEFAULT_DATAFORSYNINGEN_BASE_URL,
        ),
      ),
      origin: firstNonEmpty(process.env.DATAFORSYNINGEN_MCP_ORIGIN),
    },
  ];

  const enabledNames = process.env.MANAGED_AGENT_MCP_SERVERS?.split(",")
    .map((name) => name.trim().toLowerCase())
    .filter(Boolean);

  return servers
    .filter((server) => !enabledNames?.length || enabledNames.includes(server.name.toLowerCase()))
    .map((server) => ({
      name: server.name,
      token: requireValue(server.token, `${server.name} datasource bearer token`),
      url: requireValue(server.url, `${server.name} datasource URL`),
      origin: server.origin,
    }));
}

function truncate(value: unknown, maxLength = 500): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (!text) return "";
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}

function tokenCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function formatTokenCount(value: number): string {
  return value.toLocaleString("en-US");
}

function formatModelUsageSummary(usage: unknown): string {
  if (!isRecord(usage)) return "Model request end";

  const inputTokens = tokenCount(usage.input_tokens);
  const outputTokens = tokenCount(usage.output_tokens);
  const cacheReadTokens = tokenCount(usage.cache_read_input_tokens);
  const cacheWriteTokens = tokenCount(usage.cache_creation_input_tokens);
  const parts: string[] = [];

  if (inputTokens !== undefined || outputTokens !== undefined) {
    parts.push(`${formatTokenCount(inputTokens ?? 0)} input -> ${formatTokenCount(outputTokens ?? 0)} output`);
  }
  if (cacheReadTokens !== undefined) {
    parts.push(`${formatTokenCount(cacheReadTokens)} cache read`);
  }
  if (cacheWriteTokens !== undefined) {
    parts.push(`${formatTokenCount(cacheWriteTokens)} cache write`);
  }

  return parts.length ? parts.join(" | ") : "Model request end";
}

function extractText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .filter((block): block is { type: "text"; text: string } => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeFileSegment(value: string, fallback = "artifact"): string {
  const safe = value.replace(/[^a-zA-Z0-9_-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 120);
  return safe || fallback;
}

function stringifyJson(value: unknown): string {
  return JSON.stringify(value, null, 2) ?? String(value);
}

function tryParseJson(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

function getPositiveIntegerEnv(name: string, defaultValue: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return defaultValue;

  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer.`);
  }

  return value;
}

function getNonNegativeIntegerEnv(name: string, defaultValue: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return defaultValue;

  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer.`);
  }

  return value;
}

function wait(delayMs: number): Promise<void> {
  return new Promise((resolveWait) => setTimeout(resolveWait, delayMs));
}

function relativeDisplayPath(filePath: string): string {
  return relative(process.cwd(), filePath) || ".";
}

function isWorkspacePath(filePath: string): boolean {
  const relativePath = relative(workspaceDir, filePath);
  return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}

function extractInstructionLinks(filePath: string, content: string): string[] {
  const links: string[] = [];
  for (const match of content.matchAll(/\[[^\]]+\]\(([^)#]+\.md)(?:#[^)]+)?\)/gi)) {
    const rawLink = match[1]?.trim();
    if (!rawLink || /^[a-z][a-z0-9+.-]*:/i.test(rawLink)) continue;
    const targetPath = resolve(resolve(filePath, ".."), rawLink);
    if (isWorkspacePath(targetPath)) links.push(targetPath);
  }
  return links;
}

function loadWorkflowInstructions(): string {
  const maxChars = getPositiveIntegerEnv("MANAGED_AGENT_WORKFLOW_INSTRUCTION_MAX_CHARS", DEFAULT_WORKFLOW_INSTRUCTION_MAX_CHARS);
  const queue = [resolve(workspaceDir, AGENTS_FILE_NAME)];
  const seen = new Set<string>();
  const sections: string[] = [];
  let chars = 0;

  while (queue.length && chars < maxChars) {
    const filePath = queue.shift()!;
    if (seen.has(filePath) || !isWorkspacePath(filePath) || !existsSync(filePath)) continue;
    seen.add(filePath);

    const content = readFileSync(filePath, "utf8");
    const remainingChars = maxChars - chars;
    const body = content.length > remainingChars ? `${content.slice(0, remainingChars)}\n[workflow instructions truncated]` : content;
    const section = `--- ${relativeDisplayPath(filePath)} ---\n${body}`;
    sections.push(section);
    chars += section.length;

    if (content.length <= remainingChars) queue.push(...extractInstructionLinks(filePath, content));
  }

  return sections.join("\n\n");
}

function safeOutputPathSegment(value: string, fallback = "output"): string {
  const safe = value.replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 120);
  if (!safe || safe === "." || safe === "..") return fallback;
  return safe;
}

function localManagedOutputPath(managedPath: string): string | undefined {
  if (!managedPath.startsWith(MANAGED_SESSION_OUTPUT_PREFIX)) return undefined;

  const relativePath = managedPath.slice(MANAGED_SESSION_OUTPUT_PREFIX.length);
  const segments = relativePath
    .split("/")
    .filter(Boolean)
    .map((segment, index) => safeOutputPathSegment(segment, `output-${index + 1}`));
  if (!segments.length) segments.push("output.txt");

  return resolve(process.cwd(), process.env.MANAGED_AGENT_OUTPUT_MIRROR_DIR ?? DEFAULT_OUTPUT_MIRROR_DIR, ...segments);
}

function getManagedOutputOperation(event: unknown): ManagedOutputOperation | undefined {
  if (!isRecord(event) || !isRecord(event.input)) return undefined;

  const managedPath = event.input.file_path;
  if (typeof managedPath !== "string") return undefined;

  const localPath = localManagedOutputPath(managedPath);
  if (!localPath) return undefined;

  if (event.name === "write") {
    const content = event.input.content;
    return typeof content === "string" ? { kind: "write", managedPath, localPath, content } : undefined;
  }

  if (event.name === "edit") {
    const oldString = event.input.old_string;
    const newString = event.input.new_string;
    return typeof oldString === "string" && typeof newString === "string"
      ? { kind: "edit", managedPath, localPath, oldString, newString }
      : undefined;
  }

  return undefined;
}

function applyManagedOutputOperation(
  operation: ManagedOutputOperation,
  snapshots: Map<string, ManagedOutputSnapshot>,
): ManagedOutputSnapshot | undefined {
  if (operation.kind === "write") return operation;

  const current = snapshots.get(operation.managedPath);
  if (!current) {
    log("MANAGED_OUTPUT_EDIT_SKIPPED", {
      managedPath: operation.managedPath,
      reason: "no tracked prior write content",
    });
    return undefined;
  }

  const index = current.content.indexOf(operation.oldString);
  if (index < 0) {
    log("MANAGED_OUTPUT_EDIT_SKIPPED", {
      managedPath: operation.managedPath,
      reason: "old_string not found in tracked content",
    });
    return undefined;
  }

  return {
    managedPath: operation.managedPath,
    localPath: operation.localPath,
    content: `${current.content.slice(0, index)}${operation.newString}${current.content.slice(index + operation.oldString.length)}`,
  };
}

function mirrorManagedOutput(output: ManagedOutputSnapshot): void {
  mkdirSync(resolve(output.localPath, ".."), { recursive: true });
  writeFileSync(output.localPath, output.content, "utf8");
  log("MANAGED_OUTPUT_MIRRORED", {
    managedPath: output.managedPath,
    localPath: relativeDisplayPath(output.localPath),
    chars: output.content.length,
  });
}

function getMcpContentText(result: unknown): string | undefined {
  if (!isRecord(result)) return undefined;

  const text = extractText(result.content);
  return text || undefined;
}

function buildJsonOutline(value: unknown, depth = 3): unknown {
  if (value === null) return { type: "null" };
  if (Array.isArray(value)) {
    return {
      type: "array",
      length: value.length,
      ...(depth > 0 && value.length ? { item: buildJsonOutline(value[0], depth - 1) } : {}),
    };
  }

  if (isRecord(value)) {
    const keys = Object.keys(value);
    const shownKeys = keys.slice(0, 20);
    const properties =
      depth > 0
        ? Object.fromEntries(shownKeys.map((key) => [key, buildJsonOutline(value[key], depth - 1)]))
        : undefined;

    return {
      type: "object",
      keyCount: keys.length,
      keys: shownKeys,
      ...(keys.length > shownKeys.length ? { omittedKeyCount: keys.length - shownKeys.length } : {}),
      ...(properties ? { properties } : {}),
    };
  }

  if (typeof value === "string") return { type: "string", chars: value.length };
  return { type: typeof value };
}

function isNotableScalar(value: unknown): value is string | number | boolean | null {
  return value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

function truncateScalar(value: string | number | boolean | null): string | number | boolean | null {
  if (typeof value !== "string") return value;
  return value.length > 160 ? `${value.slice(0, 160)}...` : value;
}

function collectNotableFields(value: unknown, maxFields = 40): Array<{ path: string; value: string | number | boolean | null }> {
  const fields: Array<{ path: string; value: string | number | boolean | null }> = [];
  const stack: Array<{ path: string; value: unknown }> = [{ path: "$", value }];

  while (stack.length && fields.length < maxFields) {
    const current = stack.pop()!;
    if (Array.isArray(current.value)) {
      for (let index = current.value.length - 1; index >= 0; index--) {
        stack.push({ path: `${current.path}[${index}]`, value: current.value[index] });
      }
      continue;
    }

    if (!isRecord(current.value)) continue;

    const entries = Object.entries(current.value);
    for (const [key, nestedValue] of entries) {
      const path = `${current.path}.${key}`;
      if (IMPORTANT_FIELD_NAMES.has(key) && isNotableScalar(nestedValue)) {
        fields.push({ path, value: truncateScalar(nestedValue) });
        if (fields.length >= maxFields) break;
      }
    }

    for (let index = entries.length - 1; index >= 0; index--) {
      const [key, nestedValue] = entries[index]!;
      if (nestedValue && typeof nestedValue === "object") {
        stack.push({ path: `${current.path}.${key}`, value: nestedValue });
      }
    }
  }

  return fields;
}

function managedToolName(serverName: string, mcpToolName: string): string {
  const name = `${serverName}_${mcpToolName}`.replace(/[^a-zA-Z0-9_-]/g, "_");
  if (name.length <= 120) return name;
  return name.slice(0, 120);
}

function datasourceToolDescription(serverName: string, mcpTool: McpToolDefinition): string {
  return `[${serverName}] ${mcpTool.description ?? `Calls ${mcpTool.name} on the ${serverName} datasource.`}`.slice(0, 1024);
}

function parseMcpResponse(text: string): JsonRpcResponse {
  const dataLine = text.split(/\r?\n/).find((line) => line.startsWith("data: "));
  const jsonText = dataLine ? dataLine.slice("data: ".length) : text;
  return JSON.parse(jsonText) as JsonRpcResponse;
}

async function callMcp(server: McpServerConfig, method: string, params: unknown): Promise<unknown> {
  const headers: Record<string, string> = {
    accept: "application/json, text/event-stream",
    authorization: `Bearer ${server.token}`,
    "content-type": "application/json",
  };

  if (server.origin) {
    headers.origin = server.origin;
  }

  const timeoutMs = getPositiveIntegerEnv("MANAGED_AGENT_MCP_CALL_TIMEOUT_MS", DEFAULT_MCP_CALL_TIMEOUT_MS);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response: Response;
  let text: string;
  try {
    response = await fetch(server.url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method,
        params,
      }),
      signal: controller.signal,
    });
    text = await response.text();
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(
        `${server.name} MCP ${method} timed out after ${timeoutMs}ms (set MANAGED_AGENT_MCP_CALL_TIMEOUT_MS to override).`,
      );
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    throw new Error(`${server.name} MCP ${method} failed with HTTP ${response.status}: ${truncate(text, 500)}`);
  }

  const json = parseMcpResponse(text);
  if (json.error) {
    throw new Error(`${server.name} MCP ${method} returned JSON-RPC error ${json.error.code ?? ""}: ${json.error.message ?? "unknown error"}`);
  }

  return json.result;
}

async function initializeMcp(server: McpServerConfig): Promise<void> {
  await callMcp(server, "initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: {
      name: "brikell-report-worker",
      version: "1.0.0",
    },
  });
}

function getToolsFromResult(result: unknown): McpToolDefinition[] {
  if (!isRecord(result) || !Array.isArray(result.tools)) return [];

  return result.tools.filter((tool): tool is McpToolDefinition => {
    return isRecord(tool) && typeof tool.name === "string" && tool.name.trim().length > 0;
  });
}

async function buildToolBridge(servers: McpServerConfig[]): Promise<ToolBridge> {
  const entries = new Map<string, ToolBridgeEntry>();
  const managedTools: ManagedToolDefinition[] = [];

  for (const server of servers) {
    log("Checking datasource backend", {
      name: server.name,
      url: server.url,
      origin: server.origin ?? "<none>",
      token: "set",
    });

    await initializeMcp(server);
    const result = await callMcp(server, "tools/list", {});
    const mcpTools = getToolsFromResult(result);

    if (!mcpTools.length) {
      throw new Error(`${server.name} datasource backend did not return any operations.`);
    }

    for (const mcpTool of mcpTools) {
      const name = managedToolName(server.name, mcpTool.name);
      if (entries.has(name)) {
        throw new Error(`Duplicate managed tool name after normalization: ${name}`);
      }

      entries.set(name, {
        managedName: name,
        mcpName: mcpTool.name,
        server,
      });

      managedTools.push({
        type: "custom",
        name,
        description: datasourceToolDescription(server.name, mcpTool),
        input_schema: normalizeManagedInputSchema(mcpTool.inputSchema ?? mcpTool.input_schema, {
          serverName: server.name,
          toolName: mcpTool.name,
        }),
      });
    }
  }

  return {
    tools: managedTools,
    entries,
  };
}

async function executeBridgeTool(entry: ToolBridgeEntry, input: unknown): Promise<unknown> {
  return callMcp(entry.server, "tools/call", {
    name: entry.mcpName,
    arguments: isRecord(input) ? input : {},
  });
}

function getBridgeEntryByManagedName(toolBridge: ToolBridge, managedToolName: string): ToolBridgeEntry {
  const entry = toolBridge.entries.get(managedToolName);
  if (!entry) {
    throw new Error(`Datasource operation is not available from the configured backends: ${managedToolName}`);
  }
  return entry;
}

function readErrorFields(value: unknown): { code?: string; message?: string } | undefined {
  if (!isRecord(value)) return undefined;
  const error = isRecord(value.error) ? value.error : value;
  const code = typeof error.code === "string" ? error.code : undefined;
  const message = typeof error.message === "string" ? error.message : undefined;
  return code || message ? { code, message } : undefined;
}

function getMcpToolResultError(result: unknown): { code?: string; message?: string } | undefined {
  if (!isRecord(result) || result.isError !== true) return undefined;

  const structuredError = readErrorFields(result.structuredContent);
  const contentText = getMcpContentText(result);
  const parsedContent = contentText ? tryParseJson(contentText) : { ok: false as const };
  const contentError = parsedContent.ok ? readErrorFields(parsedContent.value) : undefined;
  const code = structuredError?.code ?? contentError?.code;
  const message = structuredError?.message ?? contentError?.message ?? "MCP tool result was marked as an error.";
  return { code, message };
}

function isRetryableMessage(message: string): boolean {
  const normalized = message.toLocaleLowerCase();
  return (
    /\b(429|5\d\d)\b/.test(normalized) ||
    normalized.includes("upstream") ||
    normalized.includes("timeout") ||
    normalized.includes("temporar") ||
    normalized.includes("rate limit") ||
    normalized.includes("fetch failed") ||
    normalized.includes("econnreset")
  );
}

function getRetryableMcpToolResultError(result: unknown): RetryableToolErrorInfo | undefined {
  const error = getMcpToolResultError(result);
  if (!error) return undefined;

  const code = error.code?.toLocaleLowerCase();
  const message = error.message ?? "";
  if (code && RETRYABLE_MCP_ERROR_CODES.has(code)) {
    return { ...error, reason: code };
  }

  if (isRetryableMessage(message)) {
    return { ...error, reason: truncate(message, 200) };
  }

  return undefined;
}

function getRetryableThrownError(error: unknown): RetryableToolErrorInfo | undefined {
  const message = error instanceof Error ? error.message : String(error);
  if (!isRetryableMessage(message)) return undefined;
  return { message, reason: truncate(message, 200) };
}

function getMcpToolRetryConfig(): { maxAttempts: number; baseDelayMs: number } {
  // Backward compat: honour the legacy PLANDATA_GEOMETRY_RETRY_* env vars when
  // set, but prefer the generic MANAGED_AGENT_TOOL_RETRY_* names. Default is
  // to retry up to 3 times for any MCP tool that fails with a transient error
  // (per isRetryableMessage / RETRYABLE_MCP_ERROR_CODES).
  const legacyAttempts = process.env.PLANDATA_GEOMETRY_RETRY_ATTEMPTS;
  const legacyDelay = process.env.PLANDATA_GEOMETRY_RETRY_BASE_DELAY_MS;
  const attemptsKey = process.env.MANAGED_AGENT_TOOL_RETRY_ATTEMPTS !== undefined
    ? "MANAGED_AGENT_TOOL_RETRY_ATTEMPTS"
    : (legacyAttempts !== undefined ? "PLANDATA_GEOMETRY_RETRY_ATTEMPTS" : "MANAGED_AGENT_TOOL_RETRY_ATTEMPTS");
  const delayKey = process.env.MANAGED_AGENT_TOOL_RETRY_BASE_DELAY_MS !== undefined
    ? "MANAGED_AGENT_TOOL_RETRY_BASE_DELAY_MS"
    : (legacyDelay !== undefined ? "PLANDATA_GEOMETRY_RETRY_BASE_DELAY_MS" : "MANAGED_AGENT_TOOL_RETRY_BASE_DELAY_MS");
  return {
    maxAttempts: getPositiveIntegerEnv(attemptsKey, DEFAULT_MCP_TOOL_RETRY_ATTEMPTS),
    baseDelayMs: getNonNegativeIntegerEnv(delayKey, DEFAULT_MCP_TOOL_RETRY_BASE_DELAY_MS),
  };
}

function getRetryDelayMs(attempt: number, baseDelayMs: number): number {
  return baseDelayMs * 2 ** Math.max(0, attempt - 1);
}

async function executeBridgeToolWithRetries(entry: ToolBridgeEntry, action: string, input: unknown): Promise<unknown> {
  const { maxAttempts, baseDelayMs } = getMcpToolRetryConfig();

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const result = await executeBridgeTool(entry, input);
      const retryableError = getRetryableMcpToolResultError(result);
      if (!retryableError) return result;

      if (attempt >= maxAttempts) {
        log("DATASOURCE_TOOL_RETRY_EXHAUSTED", {
          datasource: entry.server.name,
          action,
          mcpToolName: entry.mcpName,
          attempts: attempt,
          reason: retryableError.reason,
        });
        return result;
      }

      const delayMs = getRetryDelayMs(attempt, baseDelayMs);
      log("DATASOURCE_TOOL_RETRY", {
        datasource: entry.server.name,
        action,
        mcpToolName: entry.mcpName,
        attempt,
        maxAttempts,
        delayMs,
        reason: retryableError.reason,
      });
      if (delayMs > 0) await wait(delayMs);
    } catch (error) {
      const retryableError = getRetryableThrownError(error);
      if (!retryableError) throw error;

      if (attempt >= maxAttempts) {
        log("DATASOURCE_TOOL_RETRY_EXHAUSTED", {
          datasource: entry.server.name,
          action,
          mcpToolName: entry.mcpName,
          attempts: attempt,
          reason: retryableError.reason,
        });
        throw error;
      }

      const delayMs = getRetryDelayMs(attempt, baseDelayMs);
      log("DATASOURCE_TOOL_RETRY", {
        datasource: entry.server.name,
        action,
        mcpToolName: entry.mcpName,
        attempt,
        maxAttempts,
        delayMs,
        reason: retryableError.reason,
      });
      if (delayMs > 0) await wait(delayMs);
    }
  }

  throw new Error(`Unexpected retry loop exit for ${entry.mcpName}.`);
}

async function executeManagedDatasourceTool(
  toolBridge: ToolBridge,
  managedToolName: string,
  input: unknown,
): Promise<{ entry: ToolBridgeEntry; result: unknown }> {
  const entry = getBridgeEntryByManagedName(toolBridge, managedToolName);
  // Retry transient failures (timeouts, ECONNRESET, 5xx, MCP retryable codes)
  // for ALL MCP tools, not just Plandata geometry. The Datafordeler hang
  // incident (2026-05-03 19:01 UTC) showed that fetch-level network blips
  // hit any tool, and isRetryableMessage already filters retryable failures
  // from logical errors so this is safe across all three datasources.
  const result = await executeBridgeToolWithRetries(entry, entry.mcpName, input);

  return { entry, result };
}

function requireLocalSkill(skills: LocalSkillDefinition[], key: string): LocalSkillDefinition {
  const skill = skills.find((candidate) => candidate.key === key);
  if (!skill) {
    throw new Error(`Missing required local skill: ${key}. Add ${SKILL_FILE_NAME} under ${getLocalSkillsDirectory()}\\${key}.`);
  }
  return skill;
}

function listFilesRecursive(directoryPath: string): string[] {
  const entries = readdirSync(directoryPath, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const path = resolve(directoryPath, entry.name);
    if (entry.isDirectory()) {
      files.push(...listFilesRecursive(path));
    } else if (entry.isFile()) {
      files.push(path);
    }
  }

  return files.sort();
}

function getLocalSkillsDirectory(): string {
  return process.env.MANAGED_AGENT_SKILLS_DIR
    ? resolve(process.cwd(), process.env.MANAGED_AGENT_SKILLS_DIR)
    : resolve(managedRoot, DEFAULT_SKILLS_DIR);
}

function stripYamlScalarQuotes(value: string): string {
  const trimmed = value.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function readSkillFileMetadata(skillFilePath: string): SkillFileMetadata {
  const content = readFileSync(skillFilePath, "utf8");
  const frontmatter = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!frontmatter) return {};

  const metadata: SkillFileMetadata = {};
  for (const line of frontmatter[1]!.split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.+)$/);
    if (!match) continue;

    const key = match[1]!;
    const value = stripYamlScalarQuotes(match[2]!);
    if (key === "name" && value) metadata.name = value;
    if (key === "display_title" && value) metadata.displayTitle = value;
  }

  return metadata;
}

function titleCaseSkillKey(key: string): string {
  return key
    .split(/[_-]+/)
    .filter(Boolean)
    .map((segment) => (segment.length <= 3 ? segment.toUpperCase() : `${segment[0]!.toUpperCase()}${segment.slice(1)}`))
    .join(" ");
}

function skillEnvPrefix(skillKey: string): string {
  const prefix = skillKey.replace(/[^a-zA-Z0-9]+/g, "_").replace(/^_+|_+$/g, "").toUpperCase();
  if (!prefix) throw new Error(`Skill key cannot produce an environment variable prefix: ${skillKey}`);
  return prefix;
}

function loadLocalSkills(): LocalSkillDefinition[] {
  const skillsDirectory = getLocalSkillsDirectory();
  if (!existsSync(skillsDirectory) || !statSync(skillsDirectory).isDirectory()) {
    throw new Error(`Missing local skills directory: ${skillsDirectory}`);
  }

  return readdirSync(skillsDirectory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => {
      const directoryPath = resolve(skillsDirectory, entry.name);
      const skillFilePath = resolve(directoryPath, SKILL_FILE_NAME);
      if (!existsSync(skillFilePath)) {
        throw new Error(`Missing ${SKILL_FILE_NAME} for local skill directory: ${directoryPath}`);
      }

      const metadata = readSkillFileMetadata(skillFilePath);
      const key = metadata.name?.trim() || entry.name;
      const envPrefix = skillEnvPrefix(key);
      return {
        key,
        displayTitle: metadata.displayTitle ?? titleCaseSkillKey(key),
        directoryPath,
        skillIdEnv: `${envPrefix}_SKILL_ID`,
        versionEnv: `${envPrefix}_SKILL_VERSION`,
      };
    })
    .sort((left, right) => left.key.localeCompare(right.key));
}

function requireSkillFiles(skill: LocalSkillDefinition): string[] {
  if (!existsSync(skill.directoryPath) || !statSync(skill.directoryPath).isDirectory()) {
    throw new Error(`Missing local skill directory: ${skill.directoryPath}`);
  }

  const skillFile = resolve(skill.directoryPath, SKILL_FILE_NAME);
  if (!existsSync(skillFile)) {
    throw new Error(`Missing ${SKILL_FILE_NAME} for ${skill.key}: ${skillFile}`);
  }

  return listFilesRecursive(skill.directoryPath);
}

function skillUploadName(skill: LocalSkillDefinition, filePath: string): string {
  const localName = relative(skill.directoryPath, filePath).replace(/\\/g, "/");
  return `${skill.key}/${localName}`;
}

function hashSkillFiles(skill: LocalSkillDefinition, filePaths: string[]): string {
  const hash = createHash("sha256");
  for (const filePath of filePaths) {
    hash.update(skillUploadName(skill, filePath));
    hash.update("\0");
    hash.update(readFileSync(filePath));
    hash.update("\0");
  }

  return hash.digest("hex");
}

async function buildSkillUploadFiles(skill: LocalSkillDefinition, filePaths: string[]): Promise<File[]> {
  return Promise.all(
    filePaths.map((filePath) => toFile(readFileSync(filePath), skillUploadName(skill, filePath))),
  );
}

export function getSkillRegistryPath(): string {
  if (process.env.MANAGED_AGENT_SKILL_REGISTRY_FILE) {
    return resolve(process.cwd(), process.env.MANAGED_AGENT_SKILL_REGISTRY_FILE);
  }

  return process.env.VERCEL === "1"
    ? resolve("/tmp", DEFAULT_SKILL_REGISTRY_FILE)
    : resolve(process.cwd(), DEFAULT_SKILL_REGISTRY_FILE);
}

export function managedSkillUploadDisplayTitle(displayTitle: string, hash: string): string {
  const hashSegment = hash.replace(/[^a-fA-F0-9]/g, "").slice(0, 12) || "unhashed";
  const normalizedTitle = displayTitle.trim() || "Skill";
  const maxTitleLength = 64 - hashSegment.length - 1;
  return `${normalizedTitle.slice(0, Math.max(1, maxTitleLength)).trim()} ${hashSegment}`;
}

function isTruthyEnv(value: string | undefined): boolean {
  return /^(1|true|yes|on)$/i.test(value?.trim() ?? "");
}

function requiresConfiguredManagedSkillIds(): boolean {
  return isTruthyEnv(process.env.MANAGED_AGENT_REQUIRE_CONFIGURED_SKILLS);
}

function configuredManagedSkillReference(
  skill: LocalSkillDefinition,
): { type: "custom"; skill_id: string; version: string } | undefined {
  const configuredSkillId = process.env[skill.skillIdEnv]?.trim();
  if (!configuredSkillId) return undefined;
  const configuredVersion = process.env[skill.versionEnv]?.trim() || "latest";
  return { type: "custom", skill_id: configuredSkillId, version: configuredVersion };
}

function wireManagedSkillEnvironment(skill: LocalSkillDefinition, reference: ResolvedManagedSkillReference): void {
  process.env[skill.skillIdEnv] = reference.skillId;
  process.env[skill.versionEnv] = reference.version;
}

function managedSkillReference(reference: ResolvedManagedSkillReference): ManagedSkillReference {
  return { type: "custom", skill_id: reference.skillId, version: reference.version };
}

function loadSkillRegistry(registryPath: string): SkillRegistry {
  if (!existsSync(registryPath)) return {};
  const data = JSON.parse(readFileSync(registryPath, "utf8"));
  if (!isRecord(data)) throw new Error(`Skill registry must be a JSON object: ${registryPath}`);

  const registry: SkillRegistry = {};
  for (const [key, value] of Object.entries(data)) {
    if (
      isRecord(value) &&
      typeof value.skillId === "string" &&
      typeof value.version === "string" &&
      typeof value.hash === "string"
    ) {
      registry[key] = {
        skillId: value.skillId,
        version: value.version,
        hash: value.hash,
      };
    }
  }

  return registry;
}

function saveSkillRegistry(registryPath: string, registry: SkillRegistry): void {
  writeFileSync(registryPath, stringifyJson(registry), "utf8");
}

async function findManagedSkillByDisplayTitle(
  beta: any,
  displayTitle: string,
): Promise<ResolvedManagedSkillReference | undefined> {
  for await (const skill of beta.skills.list({ source: "custom" }, { maxRetries: 0 })) {
    if (!isRecord(skill) || skill.display_title !== displayTitle || typeof skill.id !== "string") {
      continue;
    }
    return {
      skillId: skill.id,
      version: typeof skill.latest_version === "string" && skill.latest_version ? skill.latest_version : "latest",
    };
  }
  return undefined;
}

function isDisplayTitleReuseError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("display_title") && message.includes("reuse");
}

async function createOrReuseManagedSkill(
  beta: any,
  skill: LocalSkillDefinition,
  filePaths: string[],
  displayTitle: string,
): Promise<ResolvedManagedSkillReference> {
  const existing = await findManagedSkillByDisplayTitle(beta, displayTitle);
  if (existing) {
    log("Using existing skill", { key: skill.key, skillId: existing.skillId, version: existing.version, displayTitle });
    return existing;
  }

  const files = await buildSkillUploadFiles(skill, filePaths);
  try {
    const created = await beta.skills.create(
      {
        display_title: displayTitle,
        files,
      },
      // Skill display_title must be unique. If a create succeeds server-side
      // but the response is lost, an SDK retry replays the same title and the
      // run fails before a managed session exists.
      { maxRetries: 0 },
    );
    const version = created.latest_version ?? "latest";
    log("Uploaded skill", { key: skill.key, skillId: created.id, version, displayTitle });
    return { skillId: created.id, version };
  } catch (error) {
    if (!isDisplayTitleReuseError(error)) throw error;

    const recovered = await findManagedSkillByDisplayTitle(beta, displayTitle);
    if (!recovered) throw error;
    log("Using existing skill after create collision", {
      key: skill.key,
      skillId: recovered.skillId,
      version: recovered.version,
      displayTitle,
    });
    return recovered;
  }
}

async function prepareManagedSkills(
  beta: any,
  localSkills: LocalSkillDefinition[],
): Promise<Array<{ type: "custom"; skill_id: string; version: string }>> {
  const requireConfiguredSkillIds = requiresConfiguredManagedSkillIds();
  let registryPath: string | undefined;
  let registry: SkillRegistry | undefined;
  let registryChanged = false;
  const managedSkills: Array<{ type: "custom"; skill_id: string; version: string }> = [];
  const missingRequiredSkillEnvVars: string[] = [];

  for (const skill of localSkills) {
    const configured = configuredManagedSkillReference(skill);
    if (configured) {
      wireManagedSkillEnvironment(skill, { skillId: configured.skill_id, version: configured.version });
      managedSkills.push(configured);
      log("Using configured skill", { key: skill.key, skillId: configured.skill_id, version: configured.version });
      continue;
    }

    if (requireConfiguredSkillIds) {
      missingRequiredSkillEnvVars.push(`${skill.key}: ${skill.skillIdEnv}`);
      continue;
    }

    registryPath ??= getSkillRegistryPath();
    registry ??= loadSkillRegistry(registryPath);
    const filePaths = requireSkillFiles(skill);
    const hash = hashSkillFiles(skill, filePaths);
    const displayTitle = managedSkillUploadDisplayTitle(skill.displayTitle, hash);
    const existing = registry[skill.key];
    if (existing?.skillId && existing.hash === hash) {
      const reference = { skillId: existing.skillId, version: existing.version };
      wireManagedSkillEnvironment(skill, reference);
      managedSkills.push(managedSkillReference(reference));
      log("Using cached skill", { key: skill.key, skillId: existing.skillId, version: existing.version });
      continue;
    }

    if (existing?.skillId) {
      log("Creating replacement skill for changed local files", { key: skill.key, previousSkillId: existing.skillId });
    }

    const resolved = await createOrReuseManagedSkill(beta, skill, filePaths, displayTitle);
    wireManagedSkillEnvironment(skill, resolved);
    registry[skill.key] = { skillId: resolved.skillId, version: resolved.version, hash };
    managedSkills.push(managedSkillReference(resolved));
    registryChanged = true;
  }

  if (missingRequiredSkillEnvVars.length > 0) {
    throw new Error(
      [
        "Managed agent runtime requires pre-provisioned skill IDs in this environment; runtime skill upload is disabled.",
        `Missing: ${missingRequiredSkillEnvVars.join(", ")}.`,
        "Upload/version skills during setup and set each *_SKILL_ID env var before starting report jobs.",
      ].join(" "),
    );
  }

  if (registryChanged && registryPath && registry) {
    saveSkillRegistry(registryPath, registry);
    log("Skill registry updated", { path: relativeDisplayPath(registryPath) });
  }

  return managedSkills;
}

function getLocalSkillSummaries(localSkills: LocalSkillDefinition[]): Array<{ key: string; directory: string; fileCount: number; hash: string }> {
  return localSkills.map((skill) => {
    const filePaths = requireSkillFiles(skill);
    return {
      key: skill.key,
      directory: relativeDisplayPath(skill.directoryPath),
      fileCount: filePaths.length,
      hash: hashSkillFiles(skill, filePaths),
    };
  });
}

function requireManagedReportSkills(localSkills: LocalSkillDefinition[]): void {
  for (const skillKey of ["datafordeler", "dataforsyningen", "plandata", "sql"]) {
    requireLocalSkill(localSkills, skillKey);
  }
}

async function provisionManagedSkillEnvironment(): Promise<ManagedSkillReference[]> {
  const localSkills = loadLocalSkills();
  requireManagedReportSkills(localSkills);
  const apiKey = requireValue(process.env.ANTHROPIC_API_KEY, "ANTHROPIC_API_KEY");
  const client = createManagedAnthropicClient(apiKey);
  logFetchPathOnce();
  const beta: any = (client as any).beta;
  return prepareManagedSkills(beta, localSkills);
}

export async function ensureManagedSkillEnvironment(): Promise<ManagedSkillReference[]> {
  managedSkillEnvironmentPromise ??= provisionManagedSkillEnvironment().catch((error) => {
    managedSkillEnvironmentPromise = undefined;
    throw error;
  });
  return managedSkillEnvironmentPromise;
}

function printUsage() {
  writeStdout(`Usage:
  npm run start -- "your input message"
  $env:AGENT_INPUT_MESSAGE = "your input message"; npm run start
  "your input message" | npm run start

Options:
  --dry-run    Validate input and datasource configuration without creating remote resources.

Environment:
  ANTHROPIC_API_KEY              Required for non-dry runs.
  MANAGED_AGENT_MCP_SERVERS      Optional comma list: plandata,datafordeler,dataforsyningen.
  PLANDATA_MCP_URL               Optional; defaults from ../plandata-server/.env.prod.
  PLANDATA_MCP_API_TOKEN         Optional; defaults from ../plandata-server/.env.prod.
  PLANDATA_MCP_ORIGIN            Optional; defaults from ../plandata-server/.env.prod.
  DATAFORDELER_MCP_URL           Optional; defaults to the deployed Railway health-checked domain.
  DATAFORDELER_MCP_API_TOKEN     Optional; defaults from ../datafordeler-server/.env.prod.
  DATAFORSYNINGEN_MCP_URL        Optional; defaults to the deployed Railway health-checked domain.
  DATAFORSYNINGEN_MCP_API_TOKEN  Optional; defaults from ../dataforsyningen-server/.env.prod.
  DATAFORSYNINGEN_MCP_ORIGIN     Optional; defaults from ../dataforsyningen-server/.env.prod when set.
  DATAFORDELER_SKILL_ID          Optional existing uploaded Datafordeler custom skill ID override.
  DATAFORDELER_SKILL_VERSION     Optional Datafordeler skill version; defaults to latest when ID is set.
  DATAFORSYNINGEN_SKILL_ID       Optional existing uploaded Dataforsyningen custom skill ID override.
  DATAFORSYNINGEN_SKILL_VERSION  Optional Dataforsyningen skill version; defaults to latest when ID is set.
  PLANDATA_SKILL_ID              Optional existing uploaded Plandata custom skill ID override.
  PLANDATA_SKILL_VERSION         Optional Plandata skill version; defaults to latest when ID is set.
  SQL_SKILL_ID                   Optional existing uploaded SQL custom skill ID override.
  SQL_SKILL_VERSION              Optional SQL skill version; defaults to latest when ID is set.
  MANAGED_AGENT_REQUIRE_CONFIGURED_SKILLS Optional; set on to disable app-managed skill bootstrap.
  MANAGED_AGENT_SKILLS_DIR       Optional local skills directory; defaults to skills.
  MANAGED_AGENT_SKILL_REGISTRY_FILE Optional local skill upload cache; defaults to .managed-agent-skills.json.
  MANAGED_AGENT_OUTPUT_MIRROR_DIR             Optional local mirror for files written under /mnt/session/outputs; defaults to .managed-agent-outputs.
  MANAGED_AGENT_RUN_OUTPUT_DIR                Optional run log directory; defaults to .managed-agent-runs.
  MANAGED_AGENT_RUN_OUTPUT_FILE               Optional exact run log file path. Overrides run log directory.
  MANAGED_AGENT_ENVIRONMENT_NAME              Optional managed environment name; defaults to brikell-mcp-message-env.
  MANAGED_AGENT_TOOL_RETRY_ATTEMPTS           Optional retry attempts for any failing MCP tool call (transient errors only); defaults to 3.
  MANAGED_AGENT_TOOL_RETRY_BASE_DELAY_MS      Optional retry base delay in milliseconds; defaults to 1000. Backoff is base * 2^(attempt-1).
  MANAGED_AGENT_MCP_CALL_TIMEOUT_MS           Optional per-MCP-call wall-clock timeout; defaults to 90000.\n`);
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";

  let text = "";
  for await (const chunk of process.stdin) {
    text += String(chunk);
  }
  return text.trim();
}

async function getInputMessage(args: string[]): Promise<string> {
  const fromArgs = args.join(" ").trim();
  const message = firstNonEmpty(fromArgs, process.env.AGENT_INPUT_MESSAGE, await readStdin());

  if (!message) {
    throw new Error("Missing input message. Pass it after --, set AGENT_INPUT_MESSAGE, or pipe it on stdin.");
  }

  return message;
}

async function runManagedSessionAttempt(options: ManagedRunAttemptOptions): Promise<ManagedMessageRunResult> {
  const {
    beta,
    managedSkills,
    agentTools,
    toolBridge,
    datasourceToolNames,
    inputMessage,
    workflowInstructions,
    sessionTitle,
  } = options;

  log("Creating agent...");
  const agent = await beta.agents.create({
    name: process.env.MANAGED_AGENT_NAME ?? "brikell-mcp-message-agent",
    model: process.env.MANAGED_AGENT_MODEL ?? DEFAULT_MODEL,
    system: [
      "Use uploaded skills for generic capabilities and the runtime-discovered custom tool metadata for provider tool contracts. Follow the project workflow instructions loaded from AGENTS.md below. Inspect available tool names, descriptions, and input schemas before use. Never reveal credentials, tokens, raw authorization headers, or restricted personal data.",
      workflowInstructions ? `Project workflow instructions:\n${workflowInstructions}` : "No AGENTS.md workflow instructions were found.",
    ].join("\n\n"),
    skills: managedSkills,
    tools: agentTools,
  });
  log("Agent created", { id: agent.id });

  log("Creating environment...");
  const environment = await beta.environments.create(buildManagedEnvironmentCreateInput());
  log("Environment created", { id: environment.id });

  log("Creating session...");
  const session = await beta.sessions.create({
    agent: agent.id,
    environment_id: environment.id,
    title: sessionTitle ?? "Datasource message demo",
  });
  log("Session created", { id: session.id });
  const sessionSqlStore = new SessionSqlStore({ dbPath: defaultSessionSqlDbPath(session.id), sessionId: session.id });
  sessionSqlStore.init();
  log("Session SQL store ready", { database: relativeDisplayPath(sessionSqlStore.dbPath) });

  log("Opening event stream...");
  const stream = await beta.sessions.events.stream(session.id);
  const pendingManagedOutputOperations = new Map<string, ManagedOutputOperation>();
  const pendingCustomToolUses = new Map<string, ManagedCustomToolUseEvent>();
  const managedOutputSnapshots = new Map<string, ManagedOutputSnapshot>();
  const timelineStartedAt = Date.now();

  log("Sending user.message...");
  logTimeline("user", inputMessage, timelineStartedAt);
  await sendSessionEventsWithTimeout(
    beta,
    session.id,
    {
      events: [
        {
          type: "user.message",
          content: [
            {
              type: "text",
              text: inputMessage,
            },
          ],
        },
      ],
    },
    { kind: "user-message" },
  );

  let eventCount = 0;
  const finishRun = (): ManagedMessageRunResult => ({
    dryRun: false,
    runLogPath: runOutputFilePath ?? "",
    agentId: agent.id,
    environmentId: environment.id,
    sessionId: session.id,
    eventCount,
    outputs: [...managedOutputSnapshots.values()],
  });

  const sendCustomToolResult = async (event: ManagedCustomToolUseEvent) => {
    const toolName = event.name ?? "";
    if (datasourceToolNames.has(toolName)) {
      try {
        const { entry, result } = await executeManagedDatasourceTool(toolBridge, toolName, event.input);
        const toolResultError = getMcpToolResultError(result);
        if (toolResultError) {
          const message = sanitizeDiagnosticMessage(toolResultError.message ?? "Datasource tool returned an error.");
          sessionSqlStore.recordDiagnostic(
            {
              callId: event.id,
              sessionId: session.id,
              datasource: entry.server.name,
              managedToolName: toolName,
              mcpToolName: entry.mcpName,
              input: event.input,
            },
            { code: toolResultError.code, message },
          );
          await sendSessionEventsWithTimeout(
            beta,
            session.id,
            {
              events: [
                {
                  type: "user.custom_tool_result",
                  custom_tool_use_id: event.id,
                  is_error: true,
                  content: [{ type: "text", text: message }],
                },
              ],
            },
            {
              kind: "tool-result",
              contextLog: {
                customToolUseId: event.id,
                toolName,
                branch: "datasource-diagnostic",
                datasource: entry.server.name,
                mcpToolName: entry.mcpName,
                code: toolResultError.code,
              },
            },
          );
          logTimeline("result", `${toolName} diagnostic recorded`, timelineStartedAt, {
            datasource: entry.server.name,
            mcpToolName: entry.mcpName,
            code: toolResultError.code,
          });
          return;
        }

        const context = sessionSqlStore.ingestSuccessfulDatasourceCall(
          {
            callId: event.id,
            sessionId: session.id,
            datasource: entry.server.name,
            managedToolName: toolName,
            mcpToolName: entry.mcpName,
            input: event.input,
          },
          result,
        );
        await sendSessionEventsWithTimeout(
          beta,
          session.id,
          {
            events: [
              {
                type: "user.custom_tool_result",
                custom_tool_use_id: event.id,
                content: [{ type: "text", text: JSON.stringify(context) }],
              },
            ],
          },
          {
            kind: "tool-result",
            contextLog: {
              customToolUseId: event.id,
              toolName,
              branch: "datasource-ok",
              datasource: entry.server.name,
              mcpToolName: entry.mcpName,
            },
          },
        );
        logTimeline("result", `${toolName} ingested into SQL`, timelineStartedAt, {
          datasource: entry.server.name,
          mcpToolName: entry.mcpName,
          callId: event.id,
          facts: context.facts.length,
          limitations: context.limitations.length,
        });
      } catch (error) {
        const message = safeToolErrorMessage(error, "Unknown datasource gateway error.");
        const fallbackEntry = toolBridge.entries.get(toolName);
        if (fallbackEntry) {
          sessionSqlStore.recordDiagnostic(
            {
              callId: event.id,
              sessionId: session.id,
              datasource: fallbackEntry.server.name,
              managedToolName: toolName,
              mcpToolName: fallbackEntry.mcpName,
              input: event.input,
            },
            { message },
          );
        }
        await sendSessionEventsWithTimeout(
          beta,
          session.id,
          {
            events: [
              {
                type: "user.custom_tool_result",
                custom_tool_use_id: event.id,
                is_error: true,
                content: [{ type: "text", text: message }],
              },
            ],
          },
          {
            kind: "tool-result",
            contextLog: {
              customToolUseId: event.id,
              toolName,
              branch: "datasource-error",
            },
          },
        );
        logJsonEvent("sanitized_tool_error", { tool: toolName, message });
        logTimeline("error", `${toolName} error sent`, timelineStartedAt, { message });
      }
      return;
    }

    logTimeline("error", "Unknown custom tool", timelineStartedAt, { name: event.name });
    await sendSessionEventsWithTimeout(
      beta,
      session.id,
      {
        events: [
          {
            type: "user.custom_tool_result",
            custom_tool_use_id: event.id,
            is_error: true,
            content: [{ type: "text", text: `Unknown custom tool: ${event.name}` }],
          },
        ],
      },
      {
        kind: "tool-result",
        contextLog: { customToolUseId: event.id, toolName: event.name, branch: "unknown-custom-tool" },
      },
    );
  };

  const sendRequiredCustomToolResults = async (event: any) => {
    const stopReason = event?.stop_reason;
    if (stopReason?.type !== "requires_action") return;
    const selection = selectRequiredCustomToolUseEvents(event, pendingCustomToolUses);
    for (const missingId of selection.missingIds) {
      logTimeline("error", "Required custom tool event was not seen by the bridge", timelineStartedAt, { customToolUseId: missingId });
    }
    for (const customToolUse of selection.selected) {
      pendingCustomToolUses.delete(customToolUse.id);
      await sendCustomToolResult(customToolUse);
    }
  };

  for await (const event of iterateSessionEventsResilient(beta, session.id, stream as never, {
    onReconnect: (info) => {
      logJsonEvent("managed_session_reconnect", info);
    },
  }) as AsyncIterable<any>) {
    eventCount++;
    const type: string = event?.type ?? "unknown";

    switch (type) {
      case "session.status_running":
        logTimeline("running", "Session running", timelineStartedAt);
        break;
      case "session.status_idle":
        logTimeline(
          "idle",
          event.stop_reason?.type === "requires_action" ? "waiting for custom tool results" : "agent has nothing more to do",
          timelineStartedAt,
        );
        await sendRequiredCustomToolResults(event);
        break;
      case "session.status_rescheduled":
        logTimeline("running", "Session rescheduled", timelineStartedAt);
        break;
      case "session.status_terminated":
        logTimeline("idle", "Session terminated", timelineStartedAt, event);
        break;
      case "session.requires_action":
        logTimeline("event", "Session requires action", timelineStartedAt, event);
        break;
      case "session.error":
        logTimeline("error", "Session error", timelineStartedAt, event);
        break;
      case "span.model_request_start":
        logTimeline("model", "Model request start", timelineStartedAt);
        break;
      case "span.model_request_end":
        logTimeline("model", formatModelUsageSummary(event.usage ?? event.model_usage), timelineStartedAt);
        break;
      case "agent.thinking":
        logTimeline("thinking", formatTimelinePayload(event.thinking ?? event.content, 240), timelineStartedAt);
        break;
      case "agent.message": {
        const text = extractText(event.content);
        if (text) {
          logTimeline("agent", text, timelineStartedAt);
        } else {
          logTimeline("agent", "Agent message", timelineStartedAt, event.content);
        }
        break;
      }
      case "agent.tool_use":
        {
          const managedOutputOperation = getManagedOutputOperation(event);
          if (managedOutputOperation) {
            pendingManagedOutputOperations.set(event.id, managedOutputOperation);
          }
        }
        logTimeline("tool", event.name ?? "Tool call", timelineStartedAt, event.input);
        break;
      case "agent.custom_tool_use": {
        logTimeline("tool", event.name ?? "Custom tool call", timelineStartedAt, event.input);
        pendingCustomToolUses.set(event.id, { id: event.id, name: event.name, input: event.input });
        break;
      }
      case "agent.tool_result":
        {
          const pendingOutputOperation = pendingManagedOutputOperations.get(event.tool_use_id);
          if (pendingOutputOperation) {
            pendingManagedOutputOperations.delete(event.tool_use_id);
            if (!event.is_error) {
              const output = applyManagedOutputOperation(pendingOutputOperation, managedOutputSnapshots);
              if (output) {
                managedOutputSnapshots.set(output.managedPath, output);
                mirrorManagedOutput(output);
              }
            }
          }
        }
        logTimeline("result", event.is_error ? "Tool result error" : "Tool result", timelineStartedAt, event.content ?? event.output);
        break;
      case "user.custom_tool_result":
        logTimeline("result", "Custom tool result accepted", timelineStartedAt, {
          customToolUseId: event.custom_tool_use_id,
          ok: !event.is_error,
        });
        break;
      case "agent.mcp_tool_use":
        logTimeline("tool", event.name ?? "MCP tool call", timelineStartedAt, {
          server: event.mcp_server_name ?? event.server_name,
          input: event.input,
        });
        break;
      case "agent.mcp_tool_result":
        logTimeline("result", event.is_error ? "MCP tool result error" : "MCP tool result", timelineStartedAt, {
          ok: !event.is_error,
          content: event.content,
        });
        break;
      case "agent.thread_context_compacted":
        logTimeline("event", "Context compacted", timelineStartedAt, event);
        break;
      default:
        logTimeline("event", type, timelineStartedAt, event);
    }

    if (type === "session.status_idle" || type === "session.status_terminated") {
      // Use the shared terminal predicate so this loop and the resilient
      // iterator agree on what "done" means. status_idle with
      // stop_reason=requires_action is NOT terminal — the agent is paused
      // waiting for tool results we sent above (or are about to send), and the
      // session will resume after our beta.sessions.events.send call.
      if (!isRealTerminalSessionEvent(event)) {
        continue;
      }
      break;
    }
  }

  log("Stream closed", { eventCount });

  try {
    let total = 0;
    for await (const _ of beta.sessions.events.list(session.id)) total++;
    log("History", { total });
  } catch (error: any) {
    log("Could not fetch history", error?.message ?? String(error));
  }

  log("Done", { agent: agent.id, environment: environment.id, session: session.id });
  return finishRun();
}

async function withTemporaryEnv<T>(overrides: Record<string, string | undefined>, callback: () => Promise<T>): Promise<T> {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) continue;
    previous.set(key, process.env[key]);
    process.env[key] = value;
  }

  try {
    return await callback();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

export async function runManagedMessage(
  inputMessage: string,
  options: RunManagedMessageOptions = {},
): Promise<ManagedMessageRunResult> {
  return withTemporaryEnv(
    {
      MANAGED_AGENT_OUTPUT_MIRROR_DIR: options.outputMirrorDir,
      MANAGED_AGENT_RUN_OUTPUT_DIR: options.runOutputDir,
      MANAGED_AGENT_RUN_OUTPUT_FILE: options.runOutputFile,
      MANAGED_AGENT_ENVIRONMENT_NAME: options.environmentName,
    },
    async () => {
      runOutputFilePath = undefined;
      const previousSink = activeRunEventSink;
      activeRunEventSink = options.onEvent;
      let phase = "initialize-run-output-file";
      try {
        const runLogPath = initializeRunOutputFile();
        log("Run output file", { path: relativeDisplayPath(runLogPath) });

        phase = "discover-mcp-servers";
        const mcpServers = getMcpServers();
        phase = "build-tool-bridge";
        const toolBridge = await buildToolBridge(mcpServers);
        phase = "load-local-skills";
        const localSkills = loadLocalSkills();
        phase = "validate-required-skills";
        requireManagedReportSkills(localSkills);
        phase = "prepare-managed-tools";
        const datasourceToolNames = new Set(toolBridge.entries.keys());
        const managedTools = [...toolBridge.tools];
        const agentTools = [MANAGED_AGENT_TOOLSET, ...managedTools];

        log("Input message", inputMessage);
        log("Local skills", getLocalSkillSummaries(localSkills));
        log("Managed tools", [
          ...ENABLED_AGENT_BUILTIN_TOOLS,
          ...managedTools.map((tool) => tool.name),
        ]);

        if (options.dryRun) {
          log("Dry run complete");
          return {
            dryRun: true,
            runLogPath,
            eventCount: 0,
            outputs: [],
          };
        }

        phase = "require-api-key";
        const apiKey = requireValue(process.env.ANTHROPIC_API_KEY, "ANTHROPIC_API_KEY");
        phase = "create-anthropic-client";
        const client = createManagedAnthropicClient(apiKey);
        logFetchPathOnce();
        const beta: any = (client as any).beta;
        phase = "prepare-managed-skills";
        const managedSkills = await prepareManagedSkills(beta, localSkills);
        phase = "load-workflow-instructions";
        const workflowInstructions = loadWorkflowInstructions();

        phase = "run-managed-session";
        return await runManagedSessionAttempt({
          beta,
          managedSkills,
          agentTools,
          toolBridge,
          datasourceToolNames,
          inputMessage,
          workflowInstructions,
          sessionTitle: options.sessionTitle,
        });
      } catch (error) {
        logJsonEvent("managed_runner_phase_failure", {
          phase,
          error: createManagedRunnerErrorDiagnostic(error),
        });
        throw error;
      } finally {
        activeRunEventSink = previousSink;
      }
    },
  );
}

async function main() {
  const rawArgs = process.argv.slice(2);
  const dryRun = rawArgs.includes("--dry-run");
  const args = rawArgs.filter((arg) => arg !== "--dry-run");

  if (args.includes("--help") || args.includes("-h")) {
    printUsage();
    return;
  }

  const inputMessage = await getInputMessage(args);
  await runManagedMessage(inputMessage, { dryRun });
}

const isMainModule = (() => {
  if (!process.argv[1]) return false;
  try {
    const mainUrl = new URL(`file://${process.argv[1].replace(/\\/g, "/")}`).href;
    return import.meta.url === mainUrl;
  } catch {
    return false;
  }
})();

if (isMainModule) {
  main().catch((error) => {
    initializeRunOutputFile();
    writeStderr(`\nFATAL: ${error?.stack || error}\n`);
    process.exit(1);
  });
}

export const __test_only = {
  applyManagedOutputOperation,
  findManagedSkillByDisplayTitle,
  getManagedOutputOperation,
  localManagedOutputPath,
  mirrorManagedOutput,
  prepareManagedSkills,
  provisionManagedSkillEnvironment,
  resetManagedSkillEnvironmentForTests: () => {
    managedSkillEnvironmentPromise = undefined;
  },
  requiresConfiguredManagedSkillIds,
  safeOutputPathSegment,
};
