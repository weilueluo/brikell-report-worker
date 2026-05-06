type McpConfig = {
  url: string;
  token?: string;
  origin?: string;
};

type JsonRpcResponse = {
  result?: unknown;
  error?: {
    code?: number | string;
    message?: string;
  };
};

export async function callMcpTool(config: McpConfig, name: string, args: Record<string, unknown>): Promise<unknown> {
  await callMcp(config, "initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "brikell-report-worker", version: "0.1.0" },
  });

  return callMcp(config, "tools/call", { name, arguments: args });
}

async function callMcp(config: McpConfig, method: string, params: unknown): Promise<unknown> {
  const headers: Record<string, string> = {
    accept: "application/json, text/event-stream",
    "content-type": "application/json",
  };
  if (config.token) headers.authorization = `Bearer ${config.token}`;
  if (config.origin) headers.origin = config.origin;

  const response = await fetch(config.url, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Datasource request failed with HTTP ${response.status}.`);
  }

  const payload = parseJsonRpcResponse(text);
  if (payload.error) {
    throw new Error(payload.error.message ?? "Datasource request failed.");
  }

  return payload.result;
}

function parseJsonRpcResponse(text: string): JsonRpcResponse {
  const dataLine = text.split(/\r?\n/).find((line) => line.startsWith("data: "));
  return JSON.parse(dataLine ? dataLine.slice("data: ".length) : text) as JsonRpcResponse;
}
