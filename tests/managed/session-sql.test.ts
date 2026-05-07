import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  defaultSessionSqlDbPath,
  sanitizeDatasourcePayload,
  SessionSqlStore,
} from "../../src/agent/managed/sql/session-store";

const __dirname = dirname(fileURLToPath(import.meta.url));

function resetDbPath(dbPath: string): void {
  rmSync(dbPath, { force: true });
  rmSync(`${dbPath}-shm`, { force: true });
  rmSync(`${dbPath}-wal`, { force: true });
}

function makeDefaultStore(name: string): { store: SessionSqlStore; dbPath: string } {
  const dbPath = resolve(__dirname, ".generated", `${name}.db`);
  mkdirSync(resolve(dbPath, ".."), { recursive: true });
  resetDbPath(dbPath);
  const store = new SessionSqlStore({
    dbPath,
    sessionId: "session-1",
  });
  store.init();
  return { store, dbPath };
}

type DatasourceCallRow = {
  call_id: string;
  session_id: string;
  datasource: string;
  status: "success" | "error";
  request_json: string;
  response_json: string | null;
  error_code: string | null;
  error_message: string | null;
  summary: string;
};

function selectCallRow(dbPath: string, callId: string): DatasourceCallRow {
  // Reuse the same node:sqlite executor the store uses, but for read-only
  // verification rather than DDL/DML. Keeping reads in the test (rather than
  // exposing a list helper on the store) avoids leaking debug surface into
  // production code.
  const script = `
const { DatabaseSync } = require("node:sqlite");
const dbPath = process.argv[process.argv.length - 1];
const db = new DatabaseSync(dbPath);
const callId = process.env.READ_CALL_ID;
const row = db.prepare("SELECT call_id, session_id, datasource, status, request_json, response_json, error_code, error_message, summary FROM datasource_calls WHERE call_id = ?").get(callId);
db.close();
process.stdout.write(JSON.stringify(row));
`;
  const stdout = execFileSync(process.execPath, ["--no-warnings", "-e", script, dbPath], {
    encoding: "utf8",
    env: { ...process.env, READ_CALL_ID: callId },
  });
  const parsed = JSON.parse(stdout);
  if (!parsed) throw new Error(`no datasource_calls row for call_id=${callId}`);
  return parsed as DatasourceCallRow;
}

function withEnv(overrides: Record<string, string | undefined>, callback: () => void): void {
  const previousValues = new Map<string, string | undefined>();
  for (const key of Object.keys(overrides)) {
    previousValues.set(key, process.env[key]);
    const value = overrides[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    callback();
  } finally {
    for (const [key, value] of previousValues) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("default session SQL path uses tmp storage on Vercel", () => {
  withEnv({ VERCEL: "1", MANAGED_AGENT_SESSION_SQL_DIR: undefined }, () => {
    assert.match(
      defaultSessionSqlDbPath("session:one").replace(/\\/g, "/"),
      /\/tmp\/\.managed-agent-sql\/session_one\.db$/,
    );
  });
});

test("recordDiagnostic writes an error row with redacted request payload and bounded message", () => {
  const { store, dbPath } = makeDefaultStore("diagnostic");
  store.recordDiagnostic(
    {
      callId: "call-error",
      sessionId: "session-1",
      datasource: "plandata",
      managedToolName: "plandata_get_plan_context",
      mcpToolName: "get_plan_context",
      input: { planIds: [], token: "secret" },
    },
    { code: "validation_error", message: "geometry, planId, or non-empty planIds is required" },
  );
  const row = selectCallRow(dbPath, "call-error");
  assert.equal(row.status, "error");
  assert.equal(row.error_code, "validation_error");
  assert.equal(row.error_message, "geometry, planId, or non-empty planIds is required");
  assert.equal(row.datasource, "plandata");
  assert.equal(row.session_id, "session-1");
  // Token is REDACTED by sanitizeDatasourcePayload; no raw secret persisted.
  const request = JSON.parse(row.request_json);
  assert.equal(request.token, "[REDACTED]");
  assert.deepEqual(request.planIds, []);
  assert.match(row.summary, /^plandata\.get_plan_context failed: /);
  // Diagnostic rows do not carry response_json.
  assert.equal(row.response_json, null);
});

test("recordIntentAudit writes a metadata-only audit row by default (no rawResponse)", () => {
  const { store, dbPath } = makeDefaultStore("intent-audit-default");
  withEnv({ MANAGED_AGENT_AUDIT_RAW: undefined }, () => {
    store.recordIntentAudit(
      {
        callId: "call-success",
        sessionId: "session-1",
        datasource: "datafordeler",
        managedToolName: "mcp_property_collect",
        mcpToolName: "property.collect",
        input: { propertyId: "12345" },
      },
      { code: "success", durationMs: 12, intent: "property.collect" },
      { large: "raw payload that must NOT appear in the audit row by default" },
    );
  });
  const row = selectCallRow(dbPath, "call-success");
  assert.equal(row.status, "success");
  assert.equal(row.error_code, "");
  assert.equal(row.error_message, "");
  assert.equal(row.datasource, "datafordeler");
  const response = JSON.parse(row.response_json ?? "{}");
  assert.deepEqual(Object.keys(response), ["audit"]);
  assert.equal(response.audit.code, "success");
  assert.equal(response.audit.intent, "property.collect");
  assert.ok(!("rawResponse" in response), "default audit row must not carry rawResponse");
  // The literal raw payload string never appears in the persisted JSON.
  assert.ok(!(row.response_json ?? "").includes("raw payload that must NOT appear"));
});

test("recordIntentAudit includes rawResponse only when MANAGED_AGENT_AUDIT_RAW=1", () => {
  const { store, dbPath } = makeDefaultStore("intent-audit-raw");
  withEnv({ MANAGED_AGENT_AUDIT_RAW: "1" }, () => {
    store.recordIntentAudit(
      {
        callId: "call-success-raw",
        sessionId: "session-1",
        datasource: "datafordeler",
        managedToolName: "mcp_property_collect",
        mcpToolName: "property.collect",
        input: { propertyId: "12345" },
      },
      { code: "success", durationMs: 12, intent: "property.collect" },
      { propertyId: "12345", buildings: [{ id: "b1" }] },
    );
  });
  const row = selectCallRow(dbPath, "call-success-raw");
  const response = JSON.parse(row.response_json ?? "{}");
  assert.deepEqual(Object.keys(response).sort(), ["audit", "rawResponse"]);
  assert.equal(response.rawResponse.propertyId, "12345");
});

test("recordIntentAudit writes an error row when audit code is non-success", () => {
  const { store, dbPath } = makeDefaultStore("intent-audit-error");
  store.recordIntentAudit(
    {
      callId: "call-fail",
      sessionId: "session-1",
      datasource: "plandata",
      managedToolName: "mcp_planning_collect",
      mcpToolName: "planning.collect",
      input: { planId: "123" },
    },
    { code: "upstream_timeout", durationMs: 60_000, intent: "planning.collect" },
  );
  const row = selectCallRow(dbPath, "call-fail");
  assert.equal(row.status, "error");
  assert.equal(row.error_code, "upstream_timeout");
  assert.match(row.error_message ?? "", /Intent bridge error: upstream_timeout/);
});

test("sanitization redacts secrets and restricted person fields while keeping cadastral keys", () => {
  const sanitized = sanitizeDatasourcePayload({
    authorization: "Bearer abc.def",
    ejerlavKode: "123456",
    person: { name: "private" },
    nested: { apiKey: "hidden" },
  });

  assert.deepEqual(sanitized, {
    authorization: "[REDACTED]",
    ejerlavKode: "123456",
    person: "[REDACTED]",
    nested: { apiKey: "[REDACTED]" },
  });
});
