import { createHash, randomUUID } from "node:crypto";
import { toFile } from "@anthropic-ai/sdk";
import {
  checkProvenance,
  mcpCollectionEvidenceRecordSchema,
  type McpCollectionEvidenceRecord,
} from "@brikell/shared";
import type { Provenance } from "@brikell/shared";
import type { ManagedToolDefinition } from "./managed-tool-schema";
import {
  callMcp as defaultCallMcp,
  getToolsFromResult,
  initializeMcp as defaultInitializeMcp,
  type McpServerConfig,
} from "./mcp-transport";

export type IntentName = "address.resolve" | "property.collect" | "planning.collect";
export type IntentToolName = "mcp.address.resolve" | "mcp.property.collect" | "mcp.planning.collect";

export type SuccessHandleEnvelope = {
  ok: true;
  intent: IntentName;
  collection_id: string;
  ref: Provenance;
  raw_path: string;
  documents_dir?: string;
  response_sha256: string;
  response_bytes: number;
  counts: { records: number; documents: number };
};

export type ErrorHandleEnvelope = {
  ok: false;
  code: string;
  message: string;
  retryable: boolean;
  safeDetails?: Record<string, unknown>;
  _ref: Provenance;
};

export type HandleEnvelope = SuccessHandleEnvelope | ErrorHandleEnvelope;

export type AuditMeta = {
  requestKey: string;
  responseSha256: string;
  responseBytes: number;
  code: string;
  durationMs: number;
  intent: IntentName;
  ref: Provenance;
  retryable?: boolean;
};

export type IntentBridge = {
  tools: ManagedToolDefinition[];
  servers: {
    dataforsyningen: McpServerConfig;
    datafordeler: McpServerConfig;
    plandata: McpServerConfig;
  };
};

type IntentRoute = {
  toolName: IntentToolName;
  intent: IntentName;
  serverKey: keyof IntentBridge["servers"];
  mcpName: string;
};

type UploadedFile = { id: string };

type UploadedPayload = {
  fileId: string;
  mountPath: string;
};

type PreparedDocument = {
  documentId: string;
  fileName: string;
  mountPath: string;
  envelope: Record<string, unknown>;
  evidence: NonNullable<McpCollectionEvidenceRecord["documents"]>[number];
};

type PreparedPayload = {
  envelope: unknown;
  documents: PreparedDocument[];
};

const TOOL_ROUTES: Record<IntentToolName, IntentRoute> = {
  "mcp.address.resolve": {
    toolName: "mcp.address.resolve",
    intent: "address.resolve",
    serverKey: "dataforsyningen",
    mcpName: "dataforsyningen.address_resolve",
  },
  "mcp.property.collect": {
    toolName: "mcp.property.collect",
    intent: "property.collect",
    serverKey: "datafordeler",
    mcpName: "datafordeler.property_collect",
  },
  "mcp.planning.collect": {
    toolName: "mcp.planning.collect",
    intent: "planning.collect",
    serverKey: "plandata",
    mcpName: "plandata.planning_collect",
  },
};

const REQUIRED_INTENTS: Array<{ serverKey: keyof IntentBridge["servers"]; toolName: string }> = [
  { serverKey: "dataforsyningen", toolName: "dataforsyningen.address_resolve" },
  { serverKey: "datafordeler", toolName: "datafordeler.property_collect" },
  { serverKey: "plandata", toolName: "plandata.planning_collect" },
];

export const INTENT_TOOL_DEFINITIONS: ManagedToolDefinition[] = [
  {
    type: "custom",
    name: "mcp.address.resolve",
    description: "Resolve a Danish address or DAR identifier into a canonical address collection handle.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Address, access-address, place, or search text." },
        darId: { type: "string", description: "Known DAR address identifier." },
        bfe: { type: "string", description: "BFE/property identifier hint." },
        kommunekode: { type: "string", description: "Optional municipality code filter." },
        postnr: { type: "string", description: "Optional postal code filter." },
        siblingLimit: { type: "integer", description: "Maximum sibling candidates to include." },
      },
    },
  },
  {
    type: "custom",
    name: "mcp.property.collect",
    description: "Collect public property registry context and return a metadata handle to the mounted raw envelope.",
    input_schema: {
      type: "object",
      properties: {
        propertyId: { type: "string", description: "Resolved public property identifier." },
        input: {
          type: "object",
          description: "Public property lookup input such as address, BFE number, DAR id, or parcel identifiers.",
          properties: {
            address: { type: "string" },
            bfeNumber: { type: "string" },
            bfe: { type: "string" },
            darId: { type: "string" },
            municipalityCode: { type: "string" },
            ejerlavKode: { type: "string" },
            matrikelnummer: { type: "string" },
          },
        },
        sourceRecordLimit: { type: "integer", description: "Maximum source records to include." },
        forceRefresh: { type: "boolean", description: "Bypass local cache and refetch public datasource context." },
      },
    },
  },
  {
    type: "custom",
    name: "mcp.planning.collect",
    description: "Collect planning records and extracted document text, returning a metadata handle to mounted raw files.",
    input_schema: {
      type: "object",
      properties: {
        geometry: {
          type: "object",
          description: "Geometry selector accepted by the planning MCP server.",
          properties: {
            type: { type: "string" },
            coordinates: { type: "object", properties: {} },
            bbox: { type: "array", items: { type: "number" } },
            wkt: { type: "string" },
            crs: { type: "string" },
          },
        },
        planId: { description: "Single public plan identifier." },
        planIds: { type: "array", description: "Public plan identifiers.", items: {} },
        maxPlans: { type: "integer" },
        maxDocumentsPerPlan: { type: "integer" },
        limitPerLayer: { type: "integer" },
        includeGeometry: { type: "boolean" },
        includeDocuments: { type: "boolean" },
        batchOptions: {
          type: "object",
          properties: {
            concurrency: { type: "integer" },
            perDocumentTimeoutMs: { type: "integer" },
            totalTimeoutMs: { type: "integer" },
            maxDocuments: { type: "integer" },
          },
        },
      },
    },
  },
];

let callMcpImpl: typeof defaultCallMcp = defaultCallMcp;
let initializeMcpImpl: typeof defaultInitializeMcp = defaultInitializeMcp;

export function isIntentToolName(toolName: string): toolName is IntentToolName {
  return Object.prototype.hasOwnProperty.call(TOOL_ROUTES, toolName);
}

export function intentToolNames(): IntentToolName[] {
  return Object.keys(TOOL_ROUTES) as IntentToolName[];
}

export async function buildIntentBridge(servers: McpServerConfig[]): Promise<IntentBridge> {
  const bridgeServers = {
    dataforsyningen: requireIntentServer(servers, "dataforsyningen"),
    datafordeler: requireIntentServer(servers, "datafordeler"),
    plandata: requireIntentServer(servers, "plandata"),
  };

  for (const [serverKey, server] of Object.entries(bridgeServers) as Array<[keyof IntentBridge["servers"], McpServerConfig]>) {
    await initializeMcpImpl(server);
    const result = await callMcpImpl(server, "tools/list", {});
    const availableTools = new Set(getToolsFromResult(result).map((tool) => tool.name));
    for (const required of REQUIRED_INTENTS.filter((entry) => entry.serverKey === serverKey)) {
      if (!availableTools.has(required.toolName)) {
        throw new Error(`${server.name} MCP server is missing required intent tool ${required.toolName}.`);
      }
    }
    if (serverKey === "datafordeler" && !availableTools.has("datafordeler.property_resolve")) {
      console.warn("Intent bridge warning: datafordeler.property_resolve is not exposed; continuing with property_collect.");
    }
  }

  return {
    tools: INTENT_TOOL_DEFINITIONS,
    servers: bridgeServers,
  };
}

export async function executeIntentTool(args: {
  bridge: IntentBridge;
  beta: any;
  sessionId: string;
  toolName: string;
  toolInput: unknown;
}): Promise<{
  handle: HandleEnvelope;
  evidence?: McpCollectionEvidenceRecord;
  auditMeta: AuditMeta;
  rawResponse?: unknown;
}> {
  const startedAt = Date.now();
  const route = getIntentRoute(args.toolName);
  const server = args.bridge.servers[route.serverKey];
  const collectionId = randomUUID();
  const requestKey = requestKeyFor(route.intent, args.toolInput);
  const fallbackRef = fallbackProvenance(route.serverKey);

  try {
    const result = await callMcpImpl(server, "tools/call", {
      name: route.mcpName,
      arguments: isRecord(args.toolInput) ? args.toolInput : {},
    });

    const mcpError = normalizeMcpToolError(result, fallbackRef);
    if (mcpError) {
      return buildErrorResult({
        error: mcpError,
        intent: route.intent,
        requestKey,
        startedAt,
        rawResponse: result,
      });
    }

    const payload = extractMcpPayload(result);
    const provenance = checkProvenance(payload);
    if (!provenance.ok) {
      return buildErrorResult({
        error: {
          code: "provenance_missing",
          message: "Datasource response did not include valid provenance.",
          retryable: false,
          ref: fallbackRef,
        },
        intent: route.intent,
        requestKey,
        startedAt,
        rawResponse: payload,
      });
    }

    const rawJson = JSON.stringify(payload);
    const responseSha256 = sha256(rawJson);
    const responseBytes = Buffer.byteLength(rawJson, "utf8");
    const prepared = route.intent === "planning.collect"
      ? preparePlanningPayload(payload, collectionId, provenance.ref)
      : { envelope: cloneJson(payload), documents: [] };
    const envelopeMountPath = rawEnvelopePath(collectionId);
    await uploadAndMountJson(args.beta, args.sessionId, [
      {
        payload: prepared.envelope,
        fileName: "envelope.json",
        mountPath: envelopeMountPath,
      },
      ...prepared.documents.map((document) => ({
        payload: document.envelope,
        fileName: document.fileName,
        mountPath: document.mountPath,
      })),
    ]);

    const counts = {
      records: countRecords(prepared.envelope),
      documents: prepared.documents.length,
    };
    const handle: SuccessHandleEnvelope = {
      ok: true,
      intent: route.intent,
      collection_id: collectionId,
      ref: provenance.ref,
      raw_path: envelopeMountPath,
      ...(prepared.documents.length ? { documents_dir: documentDirectoryPath(collectionId) } : {}),
      response_sha256: responseSha256,
      response_bytes: responseBytes,
      counts,
    };
    assertHandleSize(handle);

    const evidence = mcpCollectionEvidenceRecordSchema.parse({
      collectionId,
      intent: route.intent,
      ref: provenance.ref,
      responseSha256,
      counts,
      ...(prepared.documents.length ? { documents: prepared.documents.map((document) => document.evidence) } : {}),
    });

    return {
      handle,
      evidence,
      auditMeta: {
        requestKey,
        responseSha256,
        responseBytes,
        code: "success",
        durationMs: Date.now() - startedAt,
        intent: route.intent,
        ref: provenance.ref,
      },
      rawResponse: payload,
    };
  } catch (error) {
    return buildErrorResult({
      error: normalizeThrownError(error, fallbackRef),
      intent: route.intent,
      requestKey,
      startedAt,
    });
  }
}

function requireIntentServer(servers: McpServerConfig[], expectedName: keyof IntentBridge["servers"]): McpServerConfig {
  const found = servers.find((server) => server.name.toLowerCase() === expectedName || server.name.toLowerCase().includes(expectedName));
  if (!found) {
    throw new Error(`Intent bridge requires configured MCP server: ${expectedName}.`);
  }
  return found;
}

function getIntentRoute(toolName: string): IntentRoute {
  if (!isIntentToolName(toolName)) {
    throw new Error(`Intent tool is not available: ${toolName}`);
  }
  return TOOL_ROUTES[toolName];
}

function fallbackProvenance(source: keyof IntentBridge["servers"]): Provenance {
  return { source, fetchedAt: new Date().toISOString() } as Provenance;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function extractText(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined;
  const text = content
    .filter((block): block is { type: "text"; text: string } => isRecord(block) && block.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("");
  return text || undefined;
}

function extractMcpPayload(result: unknown): unknown {
  if (isRecord(result)) {
    if (isRecord(result.structuredContent)) return result.structuredContent;
    const text = extractText(result.content);
    if (text) {
      try {
        return JSON.parse(text);
      } catch {
        return { data: text };
      }
    }
  }
  return result;
}

function normalizeMcpToolError(result: unknown, fallbackRef: Provenance): NormalizedError | undefined {
  if (!isRecord(result) || result.isError !== true) return undefined;
  const payload = extractMcpPayload(result);
  return normalizeErrorPayload(payload, fallbackRef);
}

type NormalizedError = {
  code: string;
  message: string;
  retryable: boolean;
  safeDetails?: Record<string, unknown>;
  ref: Provenance;
};

function normalizeErrorPayload(payload: unknown, fallbackRef: Provenance): NormalizedError {
  const payloadRecord = isRecord(payload) ? payload : {};
  const errorRecord = isRecord(payloadRecord.error) ? payloadRecord.error : payloadRecord;
  const code = typeof errorRecord.code === "string" && errorRecord.code ? errorRecord.code : "upstream_unavailable";
  const message = typeof errorRecord.message === "string" && errorRecord.message
    ? sanitizeSafeMessage(errorRecord.message)
    : "Datasource tool returned an error.";
  const retryable = typeof errorRecord.retryable === "boolean" ? errorRecord.retryable : isRetryableError(code, message);
  const refCheck = checkProvenance(payloadRecord);
  return {
    code,
    message,
    retryable,
    ...(isRecord(errorRecord.details) ? { safeDetails: safeDetails(errorRecord.details) } : {}),
    ref: refCheck.ok ? refCheck.ref : fallbackRef,
  };
}

function normalizeThrownError(error: unknown, fallbackRef: Provenance): NormalizedError {
  const message = error instanceof Error ? error.message : String(error);
  const timeout = /timeout|timed out|aborted/i.test(message);
  return {
    code: timeout ? "upstream_timeout" : "upstream_unavailable",
    message: timeout ? "Datasource request timed out." : "Datasource request failed before returning a safe response.",
    retryable: true,
    ref: fallbackRef,
  };
}

function sanitizeSafeMessage(message: string): string {
  return message
    .replace(/https?:\/\/[^\s)]+/gi, (url) => {
      try {
        const parsed = new URL(url);
        return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
      } catch {
        return "[url]";
      }
    })
    .replace(/(bearer\s+)[^\s,;]+/gi, "$1[redacted]")
    .replace(/((?:token|secret|password|api[_-]?key|authorization)\s*[:=]\s*)[^\s,;]+/gi, "$1[redacted]")
    .slice(0, 500);
}

function isRetryableError(code: string, message: string): boolean {
  const normalized = `${code} ${message}`.toLowerCase();
  return normalized.includes("timeout") || normalized.includes("upstream") || normalized.includes("temporar") || normalized.includes("rate") || /\b5\d\d\b/.test(normalized);
}

function safeDetails(details: Record<string, unknown>): Record<string, unknown> | undefined {
  const allowed = new Set([
    "documentsCompleted",
    "documentsTotal",
    "documentsTimedOut",
    "documentsFailed",
    "elapsedMs",
    "statusCode",
    "attempts",
  ]);
  const safe = Object.fromEntries(
    Object.entries(details).filter(([key, value]) => allowed.has(key) && (typeof value === "number" || typeof value === "boolean" || value === null)),
  );
  return Object.keys(safe).length ? safe : undefined;
}

function buildErrorResult(args: {
  error: NormalizedError;
  intent: IntentName;
  requestKey: string;
  startedAt: number;
  rawResponse?: unknown;
}): {
  handle: ErrorHandleEnvelope;
  auditMeta: AuditMeta;
  rawResponse?: unknown;
} {
  const responseJson = JSON.stringify({ code: args.error.code, message: args.error.message, retryable: args.error.retryable, _ref: args.error.ref });
  const handle: ErrorHandleEnvelope = {
    ok: false,
    code: args.error.code,
    message: args.error.message,
    retryable: args.error.retryable,
    ...(args.error.safeDetails ? { safeDetails: args.error.safeDetails } : {}),
    _ref: args.error.ref,
  };
  assertHandleSize(handle);
  return {
    handle,
    auditMeta: {
      requestKey: args.requestKey,
      responseSha256: sha256(responseJson),
      responseBytes: Buffer.byteLength(responseJson, "utf8"),
      code: args.error.code,
      durationMs: Date.now() - args.startedAt,
      intent: args.intent,
      ref: args.error.ref,
      retryable: args.error.retryable,
    },
    ...(args.rawResponse === undefined ? {} : { rawResponse: args.rawResponse }),
  };
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function sha256(text: string | Buffer): string {
  return createHash("sha256").update(text).digest("hex");
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, nested]) => `${JSON.stringify(key)}:${stableStringify(nested)}`);
  return `{${entries.join(",")}}`;
}

function requestKeyFor(intent: IntentName, input: unknown): string {
  return sha256(`${intent}${stableStringify(input ?? {})}`);
}

function rawEnvelopePath(collectionId: string): string {
  return `/mnt/session/data/raw/${collectionId}/envelope.json`;
}

function documentDirectoryPath(collectionId: string): string {
  return `/mnt/session/data/raw/${collectionId}/document/`;
}

function documentMountPath(collectionId: string, documentId: string): string {
  return `/mnt/session/data/raw/${collectionId}/document/${documentId}.json`;
}

function assertHandleSize(handle: HandleEnvelope): void {
  if (Buffer.byteLength(JSON.stringify(handle), "utf8") > 4 * 1024) {
    throw new Error("internal_oversized_handle");
  }
}

async function uploadAndMountJson(
  beta: any,
  sessionId: string,
  files: Array<{ payload: unknown; fileName: string; mountPath: string }>,
): Promise<UploadedPayload[]> {
  const uploaded: UploadedPayload[] = [];
  try {
    for (const file of files) {
      const body = Buffer.from(JSON.stringify(file.payload), "utf8");
      const uploadable = await toFile(body, file.fileName);
      const metadata = (await beta.files.upload({ file: uploadable })) as UploadedFile;
      uploaded.push({ fileId: metadata.id, mountPath: file.mountPath });
      await beta.sessions.resources.add(sessionId, {
        type: "file",
        file_id: metadata.id,
        mount_path: file.mountPath,
      });
    }
    return uploaded;
  } catch (error) {
    await cleanupUploadedFiles(beta, uploaded);
    throw error;
  }
}

async function cleanupUploadedFiles(beta: any, uploaded: UploadedPayload[]): Promise<void> {
  for (const file of uploaded) {
    try {
      if (typeof beta.files?.delete === "function") {
        await beta.files.delete(file.fileId);
      }
    } catch (cleanupError) {
      console.warn("Intent bridge cleanup failed for uploaded file.", {
        fileId: file.fileId,
        error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
      });
    }
  }
}

function preparePlanningPayload(payload: unknown, collectionId: string, ref: Provenance): PreparedPayload {
  const envelope = cloneJson(payload);
  const documents = new Map<string, PreparedDocument>();
  const keysToDocumentId = new Map<string, string>();

  function visit(node: unknown): void {
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    if (!isRecord(node)) return;

    if (typeof node.text === "string" && isPlanningDocumentLike(node)) {
      const key = documentDedupKey(node);
      const existingDocumentId = keysToDocumentId.get(key);
      const documentId = existingDocumentId ?? randomUUID();
      keysToDocumentId.set(key, documentId);
      if (!existingDocumentId) {
        const prepared = buildDocumentFile(node, collectionId, documentId, ref);
        documents.set(documentId, prepared);
      }
      const summary = documents.get(documentId)!.evidence;
      node.documentRefId = documentId;
      node.text = {
        documentRefId: documentId,
        sha256: summary.sha256,
        byteSize: summary.byteSize,
        pageCount: summary.pageCount,
        extractionStatus: summary.extractionStatus,
      };
      if ("pages" in node) {
        node.pages = { documentRefId: documentId, pageCount: summary.pageCount };
      }
    }

    for (const child of Object.values(node)) visit(child);
  }

  visit(envelope);
  return { envelope, documents: [...documents.values()] };
}

function isPlanningDocumentLike(node: Record<string, unknown>): boolean {
  return Array.isArray(node.pages) || isRecord(node.extraction) || "contentStatus" in node || "url" in node || "documentId" in node || "id" in node;
}

function documentDedupKey(node: Record<string, unknown>): string {
  const ref = checkProvenance(node);
  if (ref.ok && ref.ref.upstreamId) return `${ref.ref.source}:${ref.ref.upstreamId}`;
  const upstreamId = documentUpstreamId(node);
  const source = documentSource(node, ref.ok ? ref.ref.source : undefined);
  return `${source}:${upstreamId}`;
}

function buildDocumentFile(node: Record<string, unknown>, collectionId: string, documentId: string, envelopeRef: Provenance): PreparedDocument {
  const text = typeof node.text === "string" ? node.text : "";
  const pages = Array.isArray(node.pages) ? node.pages : [];
  const nodeRef = checkProvenance(node);
  const source = documentSource(node, nodeRef.ok ? nodeRef.ref.source : envelopeRef.source);
  const upstreamId = documentUpstreamId(node);
  const extraction = isRecord(node.extraction) ? node.extraction : {};
  const byteSize = readNonNegativeInteger(extraction.byteSize) ?? Buffer.byteLength(text, "utf8");
  const pageCount = readNonNegativeInteger(extraction.pageCount) ?? pages.length;
  const hash = typeof extraction.sha256 === "string" && extraction.sha256 ? extraction.sha256 : sha256(text);
  const extractionStatus = normalizeExtractionStatus(
    firstString(extraction.status, extraction.extractionStatus, node.extractionStatus, node.contentStatus),
    text,
  );
  const metadata = cloneJson(node);
  delete metadata.text;
  delete metadata.pages;

  return {
    documentId,
    fileName: `${documentId}.json`,
    mountPath: documentMountPath(collectionId, documentId),
    envelope: {
      documentId,
      collectionId,
      ref: nodeRef.ok ? nodeRef.ref : { source, upstreamId, fetchedAt: envelopeRef.fetchedAt },
      metadata,
      text,
      pages,
    },
    evidence: {
      documentId,
      source,
      upstreamId,
      sha256: hash,
      byteSize,
      ...(pageCount === undefined ? {} : { pageCount }),
      extractionStatus,
    },
  };
}

function documentSource(node: Record<string, unknown>, fallback?: string): string {
  const source = firstString(node.source, node.provider);
  return source || fallback || "plandata";
}

function documentUpstreamId(node: Record<string, unknown>): string {
  return firstString(node.upstreamId, node.documentId, node.id, node.sourceId, node.url) || randomUUID();
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.length > 0) return value;
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return undefined;
}

function readNonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function normalizeExtractionStatus(raw: string | undefined, text: string): "ok" | "partial" | "timeout" | "error" {
  if (raw === "ok" || raw === "partial" || raw === "timeout" || raw === "error") return raw;
  if (raw === "not_fetched") return "error";
  return text.length > 0 ? "ok" : "error";
}

function countRecords(value: unknown): number {
  let total = 0;
  let sawRecordArray = false;

  function visit(node: unknown, key?: string): void {
    if (Array.isArray(node)) {
      if (key === "records" || key === "geometryRecords" || key === "features") {
        total += node.length;
        sawRecordArray = true;
      }
      for (const item of node) visit(item);
      return;
    }
    if (!isRecord(node)) return;
    for (const [childKey, child] of Object.entries(node)) visit(child, childKey);
  }

  visit(value);
  return sawRecordArray ? total : 1;
}

export const __test_only = {
  getIntentRoute,
  preparePlanningPayload,
  requestKeyFor,
  setCallMcpForTests(callMcp: typeof defaultCallMcp, initializeMcp: typeof defaultInitializeMcp = defaultInitializeMcp) {
    callMcpImpl = callMcp;
    initializeMcpImpl = initializeMcp;
  },
  resetCallMcpForTests() {
    callMcpImpl = defaultCallMcp;
    initializeMcpImpl = defaultInitializeMcp;
  },
};
