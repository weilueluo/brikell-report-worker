import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildIntentBridge,
  executeIntentTool,
  __test_only,
  type IntentBridge,
} from "../../src/agent/managed/intent-bridge";
import type { McpServerConfig } from "../../src/agent/managed/mcp-transport";

const servers: McpServerConfig[] = [
  { name: "dataforsyningen", url: "https://dataforsyningen.example/mcp", token: "token" },
  { name: "datafordeler", url: "https://datafordeler.example/mcp", token: "token" },
  { name: "plandata", url: "https://plandata.example/mcp", token: "token" },
];

function makeBeta(options: { failAddAt?: number } = {}) {
  const uploads: Array<{ id: string; name?: string; text: string }> = [];
  const resources: Array<{ sessionId: string; file_id: string; mount_path: string; type: string }> = [];
  const deleted: string[] = [];
  let addCount = 0;
  const beta = {
    files: {
      upload: async ({ file }: { file: { name?: string; text?: () => Promise<string> } }) => {
        const id = `file-${uploads.length + 1}`;
        uploads.push({ id, name: file.name, text: file.text ? await file.text() : "" });
        return { id };
      },
      delete: async (id: string) => {
        deleted.push(id);
      },
    },
    sessions: {
      resources: {
        add: async (sessionId: string, input: { type: string; file_id: string; mount_path: string }) => {
          addCount++;
          if (options.failAddAt === addCount) throw new Error("resource add failed");
          resources.push({ sessionId, ...input });
        },
      },
    },
  };
  return { beta, uploads, resources, deleted };
}

async function withMockedBridge<T>(handler: (state: { calls: Array<{ server: string; method: string; params: unknown }> }) => Promise<T>): Promise<T> {
  const calls: Array<{ server: string; method: string; params: unknown }> = [];
  __test_only.setCallMcpForTests(
    async (server, method, params) => {
      calls.push({ server: server.name, method, params });
      if (method === "tools/list") {
        const names = server.name === "dataforsyningen"
          ? ["dataforsyningen.address_resolve"]
          : server.name === "datafordeler"
            ? ["datafordeler.property_collect", "datafordeler.property_resolve"]
            : ["plandata.planning_collect"];
        return { tools: names.map((name) => ({ name, inputSchema: { type: "object", properties: {} } })) };
      }
      if (method === "tools/call") {
        const name = (params as { name: string }).name;
        const source = name.startsWith("dataforsyningen") ? "dataforsyningen" : name.startsWith("datafordeler") ? "datafordeler" : "plandata";
        return {
          structuredContent: {
            _ref: { source, upstreamId: `${source}-upstream`, fetchedAt: "2026-05-01T00:00:00.000Z" },
            records: [{ id: "record-1" }],
          },
          content: [{ type: "text", text: "{}" }],
        };
      }
      return {};
    },
    async () => {},
  );
  try {
    return await handler({ calls });
  } finally {
    __test_only.resetCallMcpForTests();
  }
}

test("buildIntentBridge validates required intent tools at startup", async () => {
  await withMockedBridge(async () => {
    const bridge = await buildIntentBridge(servers);
    assert.deepEqual(Object.keys(bridge.servers).sort(), ["datafordeler", "dataforsyningen", "plandata"]);
    assert.deepEqual(bridge.tools.map((tool) => tool.name).sort(), [
      "mcp.address.resolve",
      "mcp.planning.collect",
      "mcp.property.collect",
    ]);
  });
});

test("executeIntentTool maps public intent tools to provider MCP tool names", async () => {
  await withMockedBridge(async ({ calls }) => {
    const bridge = await buildIntentBridge(servers);
    const { beta } = makeBeta();

    await executeIntentTool({ bridge, beta, sessionId: "session-1", toolName: "mcp.address.resolve", toolInput: { query: "A" } });
    await executeIntentTool({ bridge, beta, sessionId: "session-1", toolName: "mcp.property.collect", toolInput: { propertyId: "P" } });
    await executeIntentTool({ bridge, beta, sessionId: "session-1", toolName: "mcp.planning.collect", toolInput: { planId: "L" } });

    const toolCallNames = calls
      .filter((call) => call.method === "tools/call")
      .map((call) => (call.params as { name: string }).name);
    assert.deepEqual(toolCallNames, [
      "dataforsyningen.address_resolve",
      "datafordeler.property_collect",
      "plandata.planning_collect",
    ]);
  });
});

test("executeIntentTool refuses non-intent custom tool names before contacting MCP", async () => {
  let called = false;
  __test_only.setCallMcpForTests(
    async () => {
      called = true;
      return {};
    },
    async () => {},
  );
  try {
    const bridge: IntentBridge = {
      tools: [],
      servers: { dataforsyningen: servers[0]!, datafordeler: servers[1]!, plandata: servers[2]! },
    };
    const { beta } = makeBeta();
    await assert.rejects(
      executeIntentTool({ bridge, beta, sessionId: "session-1", toolName: "not.intent", toolInput: {} }),
      /Intent tool is not available/,
    );
    assert.equal(called, false);
  } finally {
    __test_only.resetCallMcpForTests();
  }
});

test("executeIntentTool preserves envelope _ref, returns a small handle, and mounts envelope file", async () => {
  await withMockedBridge(async () => {
    const bridge = await buildIntentBridge(servers);
    const { beta, resources } = makeBeta();
    const result = await executeIntentTool({
      bridge,
      beta,
      sessionId: "session-1",
      toolName: "mcp.address.resolve",
      toolInput: { query: "Procesvej 4" },
    });

    assert.equal(result.handle.ok, true);
    assert.deepEqual(result.handle.ok && result.handle.ref, {
      source: "dataforsyningen",
      upstreamId: "dataforsyningen-upstream",
      fetchedAt: "2026-05-01T00:00:00.000Z",
    });
    assert.ok(Buffer.byteLength(JSON.stringify(result.handle), "utf8") <= 4096);
    assert.equal(resources.length, 1);
    assert.equal(resources[0]!.sessionId, "session-1");
    assert.match(resources[0]!.mount_path, /^\/mnt\/session\/data\/raw\/[0-9a-f-]+\/envelope\.json$/);
  });
});

test("executeIntentTool normalizes MCP error responses without leaking payload details", async () => {
  const calls: Array<{ method: string; params: unknown }> = [];
  __test_only.setCallMcpForTests(
    async (_server, method, params) => {
      calls.push({ method, params });
      if (method === "tools/list") return { tools: [{ name: "dataforsyningen.address_resolve" }, { name: "datafordeler.property_collect" }, { name: "plandata.planning_collect" }] };
      return {
        isError: true,
        structuredContent: {
          error: {
            code: "upstream_timeout",
            message: "Datasource timed out.",
            details: { documentsCompleted: 1, documentsTotal: 2, snippet: "RAW_PAYLOAD_CANARY" },
          },
        },
      };
    },
    async () => {},
  );
  try {
    const bridge: IntentBridge = {
      tools: [],
      servers: { dataforsyningen: servers[0]!, datafordeler: servers[1]!, plandata: servers[2]! },
    };
    const { beta, uploads } = makeBeta();
    const result = await executeIntentTool({ bridge, beta, sessionId: "session-1", toolName: "mcp.address.resolve", toolInput: {} });
    assert.equal(result.handle.ok, false);
    assert.equal(result.handle.ok || result.handle.code, "upstream_timeout");
    assert.equal(JSON.stringify(result.handle).includes("RAW_PAYLOAD_CANARY"), false);
    assert.equal(uploads.length, 0);
  } finally {
    __test_only.resetCallMcpForTests();
  }
});

test("executeIntentTool strips planning document text into per-document files and evidence", async () => {
  __test_only.setCallMcpForTests(
    async (_server, method) => {
      if (method === "tools/list") return { tools: [{ name: "dataforsyningen.address_resolve" }, { name: "datafordeler.property_collect" }, { name: "plandata.planning_collect" }] };
      return {
        structuredContent: {
          _ref: { source: "plandata", upstreamId: "plan-1", fetchedAt: "2026-05-01T00:00:00.000Z" },
          records: [{ id: "plan-record" }],
          documents: [
            {
              id: "doc-up-1",
              url: "https://example.test/doc.pdf",
              extraction: { sha256: "doc-sha", byteSize: 123, pageCount: 2, status: "ok" },
              pages: [{ page: 1, text: "FULL DOC TEXT" }],
              text: "FULL DOC TEXT",
            },
          ],
          plans: [
            {
              planId: "plan-1",
              documents: [
                {
                  id: "doc-up-1",
                  extraction: { sha256: "doc-sha", byteSize: 123, pageCount: 2, status: "ok" },
                  pages: [{ page: 1, text: "FULL DOC TEXT" }],
                  text: "FULL DOC TEXT",
                },
              ],
            },
          ],
        },
      };
    },
    async () => {},
  );
  try {
    const bridge: IntentBridge = {
      tools: [],
      servers: { dataforsyningen: servers[0]!, datafordeler: servers[1]!, plandata: servers[2]! },
    };
    const { beta, uploads, resources } = makeBeta();
    const result = await executeIntentTool({ bridge, beta, sessionId: "session-1", toolName: "mcp.planning.collect", toolInput: { planId: "plan-1" } });

    assert.equal(result.handle.ok, true);
    assert.equal(result.handle.ok && result.handle.counts.documents, 1);
    assert.equal(result.evidence?.documents?.length, 1);
    assert.equal(result.evidence?.documents?.[0]?.upstreamId, "doc-up-1");
    const envelopeUpload = uploads.find((upload) => upload.name === "envelope.json");
    assert.ok(envelopeUpload);
    assert.equal(envelopeUpload!.text.includes("FULL DOC TEXT"), false);
    assert.match(envelopeUpload!.text, /documentRefId/);
    const documentUpload = uploads.find((upload) => upload.name?.endsWith(".json") && upload.name !== "envelope.json");
    assert.ok(documentUpload);
    assert.equal(documentUpload!.text.includes("FULL DOC TEXT"), true);
    assert.ok(resources.some((resource) => /\/document\/[0-9a-f-]+\.json$/.test(resource.mount_path)));
  } finally {
    __test_only.resetCallMcpForTests();
  }
});

test("executeIntentTool deletes uploaded files when a later mount fails", async () => {
  __test_only.setCallMcpForTests(
    async (_server, method) => {
      if (method === "tools/list") return { tools: [{ name: "dataforsyningen.address_resolve" }, { name: "datafordeler.property_collect" }, { name: "plandata.planning_collect" }] };
      return {
        structuredContent: {
          _ref: { source: "plandata", upstreamId: "plan-1", fetchedAt: "2026-05-01T00:00:00.000Z" },
          documents: [
            {
              id: "doc-up-1",
              extraction: { sha256: "doc-sha", byteSize: 123, pageCount: 1, status: "ok" },
              pages: [{ page: 1, text: "text" }],
              text: "text",
            },
          ],
        },
      };
    },
    async () => {},
  );
  try {
    const bridge: IntentBridge = {
      tools: [],
      servers: { dataforsyningen: servers[0]!, datafordeler: servers[1]!, plandata: servers[2]! },
    };
    const { beta, deleted } = makeBeta({ failAddAt: 2 });
    const result = await executeIntentTool({ bridge, beta, sessionId: "session-1", toolName: "mcp.planning.collect", toolInput: { planId: "plan-1" } });

    assert.equal(result.handle.ok, false);
    assert.deepEqual(deleted, ["file-1", "file-2"]);
  } finally {
    __test_only.resetCallMcpForTests();
  }
});

test("buildIntentBridge fails when a required intent tool is missing", async () => {
  __test_only.setCallMcpForTests(
    async (server, method) => {
      if (method !== "tools/list") return {};
      const names = server.name === "dataforsyningen"
        ? ["dataforsyningen.address_resolve"]
        : server.name === "datafordeler"
          ? ["datafordeler.property_collect"]
          : [];
      return { tools: names.map((name) => ({ name, inputSchema: { type: "object", properties: {} } })) };
    },
    async () => {},
  );
  try {
    await assert.rejects(() => buildIntentBridge(servers), /missing required intent tool plandata\.planning_collect/);
  } finally {
    __test_only.resetCallMcpForTests();
  }
});
