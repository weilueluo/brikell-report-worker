import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { defaultSessionSqlDbPath, sanitizeDatasourcePayload, SessionSqlStore } from "../../src/agent/managed/sql/session-store";

const __dirname = dirname(fileURLToPath(import.meta.url));
function resetDbPath(dbPath: string): void {
  rmSync(dbPath, { force: true });
  rmSync(`${dbPath}-shm`, { force: true });
  rmSync(`${dbPath}-wal`, { force: true });
}

function makeCliStore(name: string): SessionSqlStore {
  const dbPath = resolve(__dirname, ".generated", `${name}.json`);
  mkdirSync(resolve(dbPath, ".."), { recursive: true });
  resetDbPath(dbPath);
  const store = new SessionSqlStore({
    dbPath,
    sessionId: "session-1",
    sqliteCommand: process.execPath,
    sqliteArgs: [resolve(__dirname, "fixtures", "fake-sqlite3.js")],
  });
  store.init();
  return store;
}

function makeDefaultStore(name: string): SessionSqlStore {
  const dbPath = resolve(__dirname, ".generated", `${name}.db`);
  mkdirSync(resolve(dbPath, ".."), { recursive: true });
  resetDbPath(dbPath);
  const store = new SessionSqlStore({
    dbPath,
    sessionId: "session-1",
  });
  store.init();
  return store;
}

function withEmptyPath(callback: () => void): void {
  const previousPath = process.env.PATH;
  const previousWindowsPath = process.env.Path;
  process.env.PATH = "";
  process.env.Path = "";
  try {
    callback();
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    if (previousWindowsPath === undefined) delete process.env.Path;
    else process.env.Path = previousWindowsPath;
  }
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
    assert.match(defaultSessionSqlDbPath("session:one").replace(/\\/g, "/"), /\/tmp\/\.managed-agent-sql\/session_one\.db$/);
  });
});

test("default session SQL store does not require sqlite3 on PATH", () => {
  withEmptyPath(() => {
    const store = makeDefaultStore("default-runtime");
    const context = store.ingestSuccessfulDatasourceCall(
      {
        callId: "call-default",
        sessionId: "session-1",
        datasource: "datafordeler",
        managedToolName: "datafordeler_get_property_context",
        mcpToolName: "get_property_context",
        input: { input: { type: "address", value: "Frederiksdalsvej 80" } },
      },
      { structuredContent: { propertyId: "123", bfeNummer: 456, warnings: ["BBR details require explicit expansion."] } },
    );

    assert.equal(context.status, "success");
    assert.ok(context.facts.some((fact) => fact.key === "bfeNummer" && fact.value === 456));
    assert.ok(context.limitations.some((message) => /BBR details/.test(message)));
  });
});

test("session SQL ingestion returns SQL datasource context without host paths", () => {
  const store = makeCliStore("success");
  const context = store.ingestSuccessfulDatasourceCall(
    {
      callId: "call-1",
      sessionId: "session-1",
      datasource: "datafordeler",
      managedToolName: "datafordeler_get_property_context",
      mcpToolName: "get_property_context",
      input: { input: { type: "address", value: "Frederiksdalsvej 80" }, token: "secret" },
    },
    {
      structuredContent: {
        propertyId: "123",
        bfeNummer: 456,
        units: 70,
        warnings: ["BBR details require explicit expansion."],
        nextActions: ["Call unit expansion only if exact distribution is required."],
        owner: { name: "restricted" },
      },
    },
  );

  assert.equal(context.type, "sql_datasource_context");
  assert.equal(context.status, "success");
  assert.equal(context.datasource, "datafordeler");
  assert.ok(context.facts.some((fact) => fact.key === "bfeNummer" && fact.value === 456));
  assert.ok(context.limitations.some((message) => /BBR details/.test(message)));
  assert.ok(context.followups.some((message) => /unit expansion/.test(message)));
  assert.doesNotMatch(JSON.stringify(context), /managed-agent|\.db|restricted|secret/i);
});

test("session SQL ingestion indexes public BBR detail fields", () => {
  const store = makeCliStore("bbr-detail-fields");
  const context = store.ingestSuccessfulDatasourceCall(
    {
      callId: "call-bbr-detail",
      sessionId: "session-1",
      datasource: "datafordeler",
      managedToolName: "datafordeler_property_get_units",
      mcpToolName: "property.get_units",
      input: { propertyId: "2074700" },
    },
    {
      structuredContent: {
        data: {
          buildings: [
            {
              attributes: {
                byg021BygningensAnvendelse: "140",
                byg026Opfoerelsesaar: 1932,
              },
            },
          ],
          units: [
            {
              attributes: {
                etage: "1",
                enh020EnhedensAnvendelse: "140",
                enh026EnhedensSamledeAreal: 72,
                enh027ArealTilBeboelse: 72,
                enh028ArealTilErhverv: 0,
                enh031AntalVaerelser: 3,
              },
            },
          ],
        },
      },
    },
  );

  const factKeys = new Set(context.facts.map((fact) => fact.key));
  assert.ok(factKeys.has("byg026Opfoerelsesaar"));
  assert.ok(factKeys.has("etage"));
  assert.ok(factKeys.has("enh026EnhedensSamledeAreal"));
  assert.ok(factKeys.has("enh027ArealTilBeboelse"));
  assert.ok(factKeys.has("enh028ArealTilErhverv"));
  assert.ok(factKeys.has("enh031AntalVaerelser"));
});

test("diagnostics are recorded but excluded from evidence-backed facts", () => {
  const store = makeCliStore("diagnostic");
  store.recordDiagnostic(
    {
      callId: "call-error",
      sessionId: "session-1",
      datasource: "plandata",
      managedToolName: "plandata_get_plan_context",
      mcpToolName: "get_plan_context",
      input: { planIds: [] },
    },
    { code: "validation_error", message: "geometry, planId, or non-empty planIds is required" },
  );

  const calls = store.listDatasourceCalls();
  assert.deepEqual(store.listDatasourceFacts(), []);
  assert.equal(calls[0]?.datasource, "plandata");
  assert.equal(calls[0]?.status, "error");
  assert.match(calls[0]?.error_message ?? "", /planIds/);
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

