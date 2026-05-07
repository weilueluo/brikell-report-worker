export type McpServerConfig = {
  name: string;
  url: string;
  token: string;
  origin?: string;
};

export type JsonRpcResponse = {
  result?: unknown;
  error?: {
    code?: number;
    message?: string;
    data?: unknown;
  };
};

export type McpToolDefinition = {
  name: string;
  description?: string;
  inputSchema?: unknown;
  input_schema?: unknown;
};

const DEFAULT_MCP_CALL_TIMEOUT_MS = 90_000;

function truncate(value: unknown, maxLength = 500): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (!text) return "";
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseMcpResponse(text: string): JsonRpcResponse {
  const dataLine = text.split(/\r?\n/).find((line) => line.startsWith("data: "));
  const jsonText = dataLine ? dataLine.slice("data: ".length) : text;
  return JSON.parse(jsonText) as JsonRpcResponse;
}

export async function callMcp(server: McpServerConfig, method: string, params: unknown): Promise<unknown> {
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

export async function initializeMcp(server: McpServerConfig): Promise<void> {
  await callMcp(server, "initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: {
      name: "brikell-report-worker",
      version: "1.0.0",
    },
  });
}

export function getToolsFromResult(result: unknown): McpToolDefinition[] {
  if (!isRecord(result) || !Array.isArray(result.tools)) return [];

  return result.tools.filter((tool): tool is McpToolDefinition => {
    return isRecord(tool) && typeof tool.name === "string" && tool.name.trim().length > 0;
  });
}
