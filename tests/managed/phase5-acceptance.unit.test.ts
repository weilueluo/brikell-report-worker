import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildIntentBridge,
  executeIntentTool,
  __test_only as intentTestOnly,
} from "../../src/agent/managed/intent-bridge";
import {
  buildManagedEnvironmentCreateInput,
  getManagedAgentEnvironmentPackages,
} from "../../src/agent/managed/runner";
import type { McpServerConfig } from "../../src/agent/managed/mcp-transport";

const servers: McpServerConfig[] = [
  { name: "dataforsyningen", url: "https://dataforsyningen.example/mcp", token: "token" },
  { name: "datafordeler", url: "https://datafordeler.example/mcp", token: "token" },
  { name: "plandata", url: "https://plandata.example/mcp", token: "token" },
];

type CapturedUpload = { id: string; name?: string; text: string };
type CapturedResource = { sessionId: string; file_id: string; mount_path: string; type: string };

function makeBetaSpy() {
  const uploads: CapturedUpload[] = [];
  const resources: CapturedResource[] = [];
  const beta = {
    files: {
      upload: async ({ file }: { file: { name?: string; text?: () => Promise<string> } }) => {
        const id = `file-${uploads.length + 1}`;
        uploads.push({ id, name: file.name, text: file.text ? await file.text() : "" });
        return { id };
      },
      delete: async () => undefined,
    },
    sessions: {
      resources: {
        add: async (sessionId: string, input: { type: string; file_id: string; mount_path: string }) => {
          resources.push({ sessionId, ...input });
        },
      },
    },
  };
  return { beta, uploads, resources };
}

function withMockedMcp(handler: (calls: Array<{ server: string; method: string; params: unknown }>) => Promise<void>, responder: (params: { server: string; method: string; params: unknown }) => unknown): Promise<void> {
  const calls: Array<{ server: string; method: string; params: unknown }> = [];
  intentTestOnly.setCallMcpForTests(
    async (server, method, params) => {
      calls.push({ server: server.name, method, params });
      return responder({ server: server.name, method, params });
    },
    async () => {},
  );
  return handler(calls).finally(() => intentTestOnly.resetCallMcpForTests());
}

test("Phase 5 — agent environment strips poppler/tesseract and keeps sqlite3 + curl", () => {
  const packages = getManagedAgentEnvironmentPackages();
  for (const forbidden of ["poppler-utils", "tesseract-ocr", "tesseract-ocr-dan"]) {
    assert.ok(
      !packages.apt.includes(forbidden as never),
      `agent env must not include ${forbidden}; got ${packages.apt.join(", ")}`,
    );
  }
  assert.ok(packages.apt.includes("sqlite3" as never), "agent env must keep sqlite3 for the sandbox SQLite skill");

  const input = buildManagedEnvironmentCreateInput();
  assert.deepEqual([...input.config.packages.apt], ["sqlite3", "curl"]);
});

const CANARY = "BRIKELL_PHASE5_CANARY_a8f3c11d2c";

test("Phase 5 — no-leak canary: success-path handle hides every byte of the raw payload", async () => {
  await withMockedMcp(
    async (calls) => {
      const bridge = await buildIntentBridge(servers);
      const { beta, uploads, resources } = makeBetaSpy();

      const result = await executeIntentTool({
        bridge,
        beta,
        sessionId: "session-canary",
        toolName: "mcp.property.collect",
        toolInput: { propertyId: "100004482" },
      });

      const handleJson = JSON.stringify(result.handle);
      assert.ok(!handleJson.includes(CANARY), `handle leaked canary: ${handleJson}`);
      assert.ok(Buffer.byteLength(handleJson, "utf8") <= 4096, "handle must be ≤4 KiB");

      const evidenceJson = JSON.stringify(result.evidence);
      assert.ok(!evidenceJson.includes(CANARY), `evidence record leaked canary: ${evidenceJson}`);

      const uploadedConcat = uploads.map((upload) => upload.text).join("\n");
      assert.ok(uploadedConcat.includes(CANARY), "raw canary must be in the uploaded envelope (sandbox-bound)");
      assert.equal(resources.length, 1);
      assert.equal(calls.filter((call) => call.method === "tools/call").length, 1);
    },
    ({ method, server }) => {
      if (method === "tools/list") {
        const names = server === "dataforsyningen"
          ? ["dataforsyningen.address_resolve"]
          : server === "datafordeler"
            ? ["datafordeler.property_collect", "datafordeler.property_resolve"]
            : ["plandata.planning_collect"];
        return { tools: names.map((name) => ({ name, inputSchema: { type: "object", properties: {} } })) };
      }
      return {
        structuredContent: {
          _ref: { source: "datafordeler", upstreamId: "100004482", fetchedAt: "2026-05-01T00:00:00.000Z" },
          data: {
            property: { id: "100004482", bfeNumber: "100004482" },
            buildings: [{ id: "b1", note: `building note ${CANARY}` }],
          },
        },
        content: [{ type: "text", text: "{}" }],
      };
    },
  );
});

test("Phase 5 — _ref envelope flows from MCP response to handle and to evidence record", async () => {
  await withMockedMcp(
    async () => {
      const bridge = await buildIntentBridge(servers);
      const { beta } = makeBetaSpy();

      const result = await executeIntentTool({
        bridge,
        beta,
        sessionId: "session-ref",
        toolName: "mcp.address.resolve",
        toolInput: { query: "Procesvej 4" },
      });

      assert.ok(result.handle.ok, "handle must be successful");
      assert.deepEqual(result.handle.ok && result.handle.ref, {
        source: "dataforsyningen",
        upstreamId: "0a3f50a8-1234",
        fetchedAt: "2026-05-01T00:00:00.000Z",
      });
      assert.deepEqual(result.evidence?.ref, {
        source: "dataforsyningen",
        upstreamId: "0a3f50a8-1234",
        fetchedAt: "2026-05-01T00:00:00.000Z",
      });
      assert.equal(result.evidence?.intent, "address.resolve");
      assert.equal(result.evidence?.collectionId, result.handle.ok ? result.handle.collection_id : undefined);
    },
    ({ method, server }) => {
      if (method === "tools/list") {
        const names = server === "dataforsyningen"
          ? ["dataforsyningen.address_resolve"]
          : server === "datafordeler"
            ? ["datafordeler.property_collect", "datafordeler.property_resolve"]
            : ["plandata.planning_collect"];
        return { tools: names.map((name) => ({ name, inputSchema: { type: "object", properties: {} } })) };
      }
      return {
        structuredContent: {
          _ref: { source: "dataforsyningen", upstreamId: "0a3f50a8-1234", fetchedAt: "2026-05-01T00:00:00.000Z" },
          records: [{ id: "0a3f50a8-1234", _ref: { source: "dataforsyningen", upstreamId: "0a3f50a8-1234", fetchedAt: "2026-05-01T00:00:00.000Z" } }],
        },
        content: [{ type: "text", text: "{}" }],
      };
    },
  );
});

test("Phase 5 — agents.md guard text instructs agent to treat untrusted text as data", async () => {
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const url = await import("node:url");
  const here = path.dirname(url.fileURLToPath(import.meta.url));
  const agentsMdPath = path.resolve(here, "..", "..", "src", "agent", "managed", "agents.md");
  const text = await fs.readFile(agentsMdPath, "utf8");
  const lower = text.toLowerCase();
  assert.ok(
    lower.includes("untrusted") || lower.includes("never follow instructions") || lower.includes("treat as data"),
    "agents.md must include a prompt-injection guard sentence",
  );
});
