import assert from "node:assert/strict";
import { test } from "node:test";
import { callMcpTool } from "../src/datasources/mcp";

type FetchCall = { url: string; init: RequestInit };

function withStubbedFetch(handler: (call: FetchCall) => Promise<Response> | Response) {
  const calls: FetchCall[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const call = { url, init: init ?? {} };
    calls.push(call);
    return handler(call);
  }) as typeof fetch;
  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: body }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

test("callMcpTool sends initialize then tools/call and returns the parsed JSON-RPC result", async () => {
  let initialized = false;
  const { calls, restore } = withStubbedFetch((call) => {
    const body = JSON.parse(String(call.init.body));
    if (body.method === "initialize") {
      initialized = true;
      return jsonResponse({ ok: true });
    }
    assert.equal(initialized, true, "initialize must be sent before tools/call");
    assert.equal(body.method, "tools/call");
    assert.equal(body.params.name, "datafordeler.property.resolve_property");
    assert.deepEqual(body.params.arguments, { bfeNumber: "12345" });
    return jsonResponse({ propertyId: "12345" });
  });
  try {
    const out = await callMcpTool(
      { url: "https://mcp.example.com/rpc", token: "tok-abc", origin: "https://app.example.com" },
      "datafordeler.property.resolve_property",
      { bfeNumber: "12345" },
    );
    assert.deepEqual(out, { propertyId: "12345" });
    assert.equal(calls.length, 2);
    const initInit = calls[0]!.init as RequestInit & { headers?: Record<string, string> };
    assert.equal(initInit.method, "POST");
    assert.equal(initInit.headers!.authorization, "Bearer tok-abc");
    assert.equal(initInit.headers!.origin, "https://app.example.com");
    assert.match(initInit.headers!.accept ?? "", /application\/json/);
    assert.match(initInit.headers!.accept ?? "", /text\/event-stream/);
  } finally {
    restore();
  }
});

test("callMcpTool omits authorization and origin headers when not provided", async () => {
  const { calls, restore } = withStubbedFetch(() => jsonResponse({ ok: true }));
  try {
    await callMcpTool({ url: "https://mcp.example.com/rpc" }, "tool", {});
    const headers = (calls[0]!.init as RequestInit & { headers?: Record<string, string> }).headers!;
    assert.equal(headers.authorization, undefined);
    assert.equal(headers.origin, undefined);
  } finally {
    restore();
  }
});

test("callMcpTool throws with the JSON-RPC error message when the upstream returns one", async () => {
  let seenInitialize = false;
  const { restore } = withStubbedFetch((call) => {
    const body = JSON.parse(String(call.init.body));
    if (body.method === "initialize") {
      seenInitialize = true;
      return jsonResponse({});
    }
    return new Response(
      JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32602, message: "Invalid params" } }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  });
  try {
    await assert.rejects(
      () => callMcpTool({ url: "https://mcp.example.com/rpc" }, "tool", {}),
      /Invalid params/,
    );
    assert.equal(seenInitialize, true);
  } finally {
    restore();
  }
});

test("callMcpTool throws a generic message when the JSON-RPC error has no message", async () => {
  const { restore } = withStubbedFetch((call) => {
    const body = JSON.parse(String(call.init.body));
    if (body.method === "initialize") return jsonResponse({});
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32000 } }), {
      status: 200,
    });
  });
  try {
    await assert.rejects(
      () => callMcpTool({ url: "https://mcp.example.com/rpc" }, "tool", {}),
      /Datasource request failed\./,
    );
  } finally {
    restore();
  }
});

test("callMcpTool throws with HTTP status when the response is not OK", async () => {
  const { restore } = withStubbedFetch(() => new Response("upstream error", { status: 503 }));
  try {
    await assert.rejects(
      () => callMcpTool({ url: "https://mcp.example.com/rpc" }, "tool", {}),
      /Datasource request failed with HTTP 503\./,
    );
  } finally {
    restore();
  }
});

test("callMcpTool parses SSE-style `data:` lines from text/event-stream responses", async () => {
  const { restore } = withStubbedFetch((call) => {
    const body = JSON.parse(String(call.init.body));
    if (body.method === "initialize") {
      return new Response(`event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{}}\n\n`, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }
    return new Response(
      `event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"hello":"world"}}\n\n`,
      { status: 200, headers: { "content-type": "text/event-stream" } },
    );
  });
  try {
    const out = await callMcpTool({ url: "https://mcp.example.com/rpc" }, "tool", {});
    assert.deepEqual(out, { hello: "world" });
  } finally {
    restore();
  }
});
