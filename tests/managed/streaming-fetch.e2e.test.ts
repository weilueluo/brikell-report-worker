/**
 * Streaming-fetch protocol regression test.
 *
 * Lives in `pnpm test:e2e` because each test sleeps for ~12s while a local
 * HTTP server emits a slow-streaming body. Adds enough wall time that we
 * deliberately keep it out of the default `pnpm test` runs. No external
 * services — purely local HTTP + undici dispatcher behaviour.
 */

import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { test } from "node:test";

import { Agent } from "undici";

import {
  __resetManagedAgentFetchAgentForTests,
  buildLongLivedFetch,
  managedAgentDispatcherDefaults,
} from "../../src/agent/managed/streaming-fetch";

type TestServer = {
  server: Server;
  url: string;
  close: () => Promise<void>;
};

async function startServer(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<TestServer> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("server.address() did not return AddressInfo");
  }
  return {
    server,
    url: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

test("long-lived undici fetch reads a slow-streaming response past a strict bodyTimeout", async () => {
  __resetManagedAgentFetchAgentForTests();
  // Server that emits 3 chunks with a 4-second pause between each. With a
  // dispatcher whose bodyTimeout is 3000 ms, this would terminate; with the
  // long-lived dispatcher (bodyTimeout: 0) it must complete cleanly.
  const totalChunks = 3;
  const interChunkDelayMs = 4_000;
  const expected = Array.from({ length: totalChunks }, (_, i) => `chunk-${i}\n`);
  const ts = await startServer((_req, res) => {
    res.statusCode = 200;
    res.setHeader("Content-Type", "text/plain");
    res.flushHeaders();
    let i = 0;
    const writeNext = () => {
      if (i >= totalChunks) {
        res.end();
        return;
      }
      res.write(expected[i++]);
      setTimeout(writeNext, interChunkDelayMs);
    };
    // First chunk after a small delay to exercise headers vs body separately.
    setTimeout(writeNext, 100);
  });
  try {
    const longLived = buildLongLivedFetch();
    const response = await longLived(ts.url);
    assert.equal(response.status, 200);
    const body = await response.text();
    assert.equal(body, expected.join(""));
  } finally {
    await ts.close();
  }
});

test("a strict-bodyTimeout dispatcher times out on the same slow stream", async () => {
  // Sanity check: if you DON'T use the long-lived dispatcher, the same
  // server response fails. This proves the long-lived path is what makes
  // the difference, not server quirks.
  const totalChunks = 3;
  const interChunkDelayMs = 4_000;
  const ts = await startServer((_req, res) => {
    res.statusCode = 200;
    res.flushHeaders();
    let i = 0;
    const writeNext = () => {
      if (i >= totalChunks) {
        res.end();
        return;
      }
      res.write(`chunk-${i++}\n`);
      setTimeout(writeNext, interChunkDelayMs);
    };
    setTimeout(writeNext, 100);
  });
  try {
    const strictAgent = new Agent({
      bodyTimeout: 1_500, // shorter than interChunkDelayMs
      headersTimeout: managedAgentDispatcherDefaults.headersTimeout,
      keepAliveTimeout: managedAgentDispatcherDefaults.keepAliveTimeout,
    });
    const undiciFetch = (await import("undici")).fetch;
    await assert.rejects(
      async () => {
        // undici's RequestInit accepts dispatcher; use a typed-as-any cast
        // to avoid clashing with Node's global RequestInit types.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const response = await undiciFetch(ts.url, { dispatcher: strictAgent } as any);
        await response.text();
      },
      /terminated|aborted|UND_ERR_BODY_TIMEOUT|HeadersTimeoutError|BodyTimeoutError/i,
    );
  } finally {
    await ts.close();
  }
});
