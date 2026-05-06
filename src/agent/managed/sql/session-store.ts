import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

export type SqliteRuntime = "auto" | "cli" | "node";

export type SqliteCliOptions = {
  sqliteCommand?: string;
  sqliteArgs?: string[];
  sqliteRuntime?: SqliteRuntime;
};

export type SessionSqlStoreOptions = SqliteCliOptions & {
  dbPath: string;
  sessionId: string;
};

export type DatasourceCallMetadata = {
  callId: string;
  sessionId: string;
  datasource: string;
  managedToolName: string;
  mcpToolName: string;
  input: unknown;
};

export type SqlDatasourceFact = {
  path: string;
  key: string;
  value: string | number | boolean | null;
};

export type SqlDatasourceContext = {
  type: "sql_datasource_context";
  sessionId: string;
  callId: string;
  datasource: string;
  managedToolName: string;
  mcpToolName: string;
  status: "success";
  summary: string;
  facts: SqlDatasourceFact[];
  limitations: string[];
  provenance: Array<{ datasource: string; mcpToolName: string; path?: string; detail?: string }>;
  followups: string[];
};

export type SqlDatasourceCallRow = {
  datasource: string;
  mcp_tool_name: string;
  status: "success" | "error";
  error_message?: string | null;
};

export type SqlDatasourceLimitationRow = {
  message: string;
};

const DEFAULT_SQL_DIR = ".managed-agent-sql";
const NODE_SQLITE_SMOKE_SCRIPT = "require('node:sqlite');";
const NODE_SQLITE_RUNNER_SCRIPT = `
const { DatabaseSync } = require("node:sqlite");
const dbPath = process.argv[process.argv.length - 1];
let sql = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  sql += chunk;
});
process.stdin.on("end", () => {
  let db;
  try {
    db = new DatabaseSync(dbPath);
    const trimmed = sql.trimStart();
    if (trimmed.startsWith(".mode json")) {
      const query = trimmed.replace(/^\\.mode\\s+json\\s*/i, "");
      process.stdout.write(JSON.stringify(db.prepare(query).all()));
      return;
    }
    db.exec(sql);
  } catch (error) {
    console.error(error && error.stack ? error.stack : String(error));
    process.exitCode = 1;
  } finally {
    if (db) db.close();
  }
});
`;
const SECRET_KEY_PATTERN = /(authorization|bearer|api[_-]?key|password|secret|token|credential)/i;
const RESTRICTED_KEY_PATTERN = /^(owner|owners|person|persons|personname|cpr|email|phone|telephone|ejf)$/i;
const SECRET_VALUE_PATTERN = /(bearer\s+[a-z0-9._-]+|authorization\s*:|api[_-]?key\s*[=:]|password\s*[=:]|secret\s*[=:]|token\s*[=:])/i;
const IMPORTANT_FIELD_NAMES = new Set([
  "adressebetegnelse",
  "address",
  "anvendelseskode",
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
  "unitCount",
  "units",
  "warnings",
]);

export function defaultSessionSqlDbPath(sessionId: string): string {
  const safe = sessionId.replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 120) || "session";
  if (process.env.MANAGED_AGENT_SESSION_SQL_DIR) {
    return resolve(process.cwd(), process.env.MANAGED_AGENT_SESSION_SQL_DIR, `${safe}.db`);
  }

  const defaultDir = process.env.VERCEL === "1" ? resolve("/tmp", DEFAULT_SQL_DIR) : resolve(process.cwd(), DEFAULT_SQL_DIR);
  return resolve(defaultDir, `${safe}.db`);
}

export function sanitizeDatasourcePayload(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => sanitizeDatasourcePayload(item));
  if (!value || typeof value !== "object") {
    if (typeof value === "string" && SECRET_VALUE_PATTERN.test(value)) return "[REDACTED]";
    return value;
  }

  const sanitized: Record<string, unknown> = {};
  for (const [key, nestedValue] of Object.entries(value)) {
    if (SECRET_KEY_PATTERN.test(key) || RESTRICTED_KEY_PATTERN.test(key)) {
      sanitized[key] = "[REDACTED]";
    } else {
      sanitized[key] = sanitizeDatasourcePayload(nestedValue);
    }
  }
  return sanitized;
}

export class SessionSqlStore {
  readonly dbPath: string;
  readonly sessionId: string;
  private readonly sqliteCommand?: string;
  private readonly sqliteArgs: string[];
  private readonly sqliteRuntime: SqliteRuntime;
  private executor?: SqliteExecutor;

  constructor(options: SessionSqlStoreOptions) {
    if (options.sqliteRuntime === "node" && (options.sqliteCommand || options.sqliteArgs?.length)) {
      throw new Error("sqliteCommand and sqliteArgs require sqliteRuntime 'cli' or 'auto'.");
    }

    this.dbPath = options.dbPath;
    this.sessionId = options.sessionId;
    this.sqliteCommand = options.sqliteCommand;
    this.sqliteArgs = options.sqliteArgs ?? [];
    this.sqliteRuntime = options.sqliteRuntime ?? (this.sqliteCommand || this.sqliteArgs.length ? "cli" : "auto");
  }

  init(): void {
    mkdirSync(resolve(this.dbPath, ".."), { recursive: true });
    this.exec(`
PRAGMA journal_mode=WAL;
CREATE TABLE IF NOT EXISTS datasource_calls (
  call_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  datasource TEXT NOT NULL,
  managed_tool_name TEXT NOT NULL,
  mcp_tool_name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('success', 'error')),
  request_json TEXT NOT NULL,
  response_json TEXT,
  error_code TEXT,
  error_message TEXT,
  summary TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS datasource_facts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  call_id TEXT NOT NULL REFERENCES datasource_calls(call_id),
  path TEXT NOT NULL,
  key TEXT NOT NULL,
  value_json TEXT NOT NULL,
  value_text TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS datasource_limitations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  call_id TEXT NOT NULL REFERENCES datasource_calls(call_id),
  message TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS datasource_followups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  call_id TEXT NOT NULL REFERENCES datasource_calls(call_id),
  message TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_datasource_calls_session_status ON datasource_calls(session_id, status);
CREATE INDEX IF NOT EXISTS idx_datasource_facts_call ON datasource_facts(call_id);
`);
  }

  ingestSuccessfulDatasourceCall(metadata: DatasourceCallMetadata, rawResult: unknown): SqlDatasourceContext {
    const response = sanitizeDatasourcePayload(rawResult);
    const request = sanitizeDatasourcePayload(metadata.input);
    const facts = collectFacts(response);
    const limitations = collectMessagesByKey(response, /^(warning|warnings|limitation|limitations|omitted|unavailable|notAvailable)$/i);
    const followups = collectMessagesByKey(response, /^(nextActions|availableExpansions|followups|followUps)$/i);
    const summary = `${metadata.datasource}.${metadata.mcpToolName} succeeded; ${facts.length} SQL-indexed facts; ${limitations.length} limitations.`;

    this.exec(`
BEGIN;
INSERT OR REPLACE INTO datasource_calls
  (call_id, session_id, datasource, managed_tool_name, mcp_tool_name, status, request_json, response_json, summary)
VALUES
  (${sqlString(metadata.callId)}, ${sqlString(metadata.sessionId)}, ${sqlString(metadata.datasource)}, ${sqlString(metadata.managedToolName)}, ${sqlString(metadata.mcpToolName)}, 'success', ${sqlJson(request)}, ${sqlJson(response)}, ${sqlString(summary)});
DELETE FROM datasource_facts WHERE call_id = ${sqlString(metadata.callId)};
DELETE FROM datasource_limitations WHERE call_id = ${sqlString(metadata.callId)};
DELETE FROM datasource_followups WHERE call_id = ${sqlString(metadata.callId)};
${facts
  .map(
    (fact) =>
      `INSERT INTO datasource_facts (call_id, path, key, value_json, value_text) VALUES (${sqlString(metadata.callId)}, ${sqlString(fact.path)}, ${sqlString(fact.key)}, ${sqlJson(fact.value)}, ${sqlString(String(fact.value ?? ""))});`,
  )
  .join("\n")}
${limitations
  .map((message) => `INSERT INTO datasource_limitations (call_id, message) VALUES (${sqlString(metadata.callId)}, ${sqlString(message)});`)
  .join("\n")}
${followups
  .map((message) => `INSERT INTO datasource_followups (call_id, message) VALUES (${sqlString(metadata.callId)}, ${sqlString(message)});`)
  .join("\n")}
COMMIT;
`);

    return this.getDatasourceContext(metadata.callId);
  }

  recordDiagnostic(
    metadata: DatasourceCallMetadata,
    error: { code?: string; message: string },
  ): void {
    const request = sanitizeDatasourcePayload(metadata.input);
    const message = sanitizeDiagnosticMessage(error.message);
    this.exec(`
INSERT OR REPLACE INTO datasource_calls
  (call_id, session_id, datasource, managed_tool_name, mcp_tool_name, status, request_json, error_code, error_message, summary)
VALUES
  (${sqlString(metadata.callId)}, ${sqlString(metadata.sessionId)}, ${sqlString(metadata.datasource)}, ${sqlString(metadata.managedToolName)}, ${sqlString(metadata.mcpToolName)}, 'error', ${sqlJson(request)}, ${sqlString(error.code ?? "")}, ${sqlString(message)}, ${sqlString(`${metadata.datasource}.${metadata.mcpToolName} failed: ${message}`)});
DELETE FROM datasource_facts WHERE call_id = ${sqlString(metadata.callId)};
DELETE FROM datasource_limitations WHERE call_id = ${sqlString(metadata.callId)};
DELETE FROM datasource_followups WHERE call_id = ${sqlString(metadata.callId)};
`);
  }

  getDatasourceContext(callId: string): SqlDatasourceContext {
    const rows = this.queryJson<Record<string, unknown>>(`SELECT * FROM datasource_calls WHERE call_id = ${sqlString(callId)} LIMIT 1;`);
    const row = rows[0];
    if (!row || row.status !== "success") throw new Error(`Missing successful SQL datasource call: ${callId}`);
    const facts = this.queryJson<{ path: string; key: string; value_json: string }>(
      `SELECT path, key, value_json FROM datasource_facts WHERE call_id = ${sqlString(callId)} ORDER BY id LIMIT 80;`,
    ).map((fact) => ({ path: fact.path, key: fact.key, value: parseJsonScalar(fact.value_json) }));
    const limitations = this.queryJson<{ message: string }>(
      `SELECT message FROM datasource_limitations WHERE call_id = ${sqlString(callId)} ORDER BY id LIMIT 40;`,
    ).map((item) => item.message);
    const followups = this.queryJson<{ message: string }>(
      `SELECT message FROM datasource_followups WHERE call_id = ${sqlString(callId)} ORDER BY id LIMIT 40;`,
    ).map((item) => item.message);

    return {
      type: "sql_datasource_context",
      sessionId: String(row.session_id),
      callId: String(row.call_id),
      datasource: String(row.datasource),
      managedToolName: String(row.managed_tool_name),
      mcpToolName: String(row.mcp_tool_name),
      status: "success",
      summary: String(row.summary),
      facts,
      limitations,
      provenance: [{ datasource: String(row.datasource), mcpToolName: String(row.mcp_tool_name), detail: "session SQLite datasource_calls row" }],
      followups,
    };
  }

  listDatasourceCalls(): SqlDatasourceCallRow[] {
    return this.queryJson<SqlDatasourceCallRow>(
      `SELECT datasource, mcp_tool_name, status, error_message FROM datasource_calls WHERE session_id = ${sqlString(this.sessionId)} ORDER BY created_at, call_id;`,
    );
  }

  listDatasourceFacts(limit = 400): SqlDatasourceFact[] {
    const factRows = this.queryJson<{ path: string; key: string; value_json: string }>(
      `SELECT f.path, f.key, f.value_json FROM datasource_facts f JOIN datasource_calls c ON c.call_id = f.call_id WHERE c.session_id = ${sqlString(this.sessionId)} AND c.status = 'success' ORDER BY f.id LIMIT ${sqlInteger(limit)};`,
    );
    return factRows.map((fact) => ({ path: fact.path, key: fact.key, value: parseJsonScalar(fact.value_json) }));
  }

  listDatasourceLimitations(limit = 200): string[] {
    return this.queryJson<SqlDatasourceLimitationRow>(
      `SELECT l.message FROM datasource_limitations l JOIN datasource_calls c ON c.call_id = l.call_id WHERE c.session_id = ${sqlString(this.sessionId)} AND c.status = 'success' ORDER BY l.id LIMIT ${sqlInteger(limit)};`,
    ).map((row) => row.message);
  }

  private exec(sql: string): string {
    return this.getExecutor().exec(sql);
  }

  private queryJson<T>(sql: string): T[] {
    const stdout = this.exec(`.mode json\n${sql}\n`);
    const trimmed = stdout.trim();
    if (!trimmed) return [];
    return JSON.parse(trimmed) as T[];
  }

  private getExecutor(): SqliteExecutor {
    this.executor ??= createSqliteExecutor({
      dbPath: this.dbPath,
      runtime: this.sqliteRuntime,
      sqliteCommand: this.sqliteCommand,
      sqliteArgs: this.sqliteArgs,
    });
    return this.executor;
  }
}

type SqliteExecutorOptions = {
  dbPath: string;
  runtime: SqliteRuntime;
  sqliteCommand?: string;
  sqliteArgs: string[];
};

interface SqliteExecutor {
  exec(sql: string): string;
}

function createSqliteExecutor(options: SqliteExecutorOptions): SqliteExecutor {
  if (options.runtime === "node") return new NodeSqliteExecutor(options.dbPath);
  if (options.runtime === "cli") return new CliSqliteExecutor(options.dbPath, options.sqliteCommand ?? "sqlite3", options.sqliteArgs);
  if (isNodeSqliteAvailable()) return new NodeSqliteExecutor(options.dbPath);
  return new CliSqliteExecutor(options.dbPath, options.sqliteCommand ?? "sqlite3", options.sqliteArgs);
}

class NodeSqliteExecutor implements SqliteExecutor {
  constructor(private readonly dbPath: string) {}

  exec(sql: string): string {
    try {
      return execFileSync(process.execPath, ["--no-warnings", "-e", NODE_SQLITE_RUNNER_SCRIPT, this.dbPath], {
        input: sql,
        encoding: "utf8",
        maxBuffer: 10 * 1024 * 1024,
        windowsHide: true,
      });
    } catch (error) {
      throw new Error(`Node SQLite session store execution failed: ${formatExecutionError(error)}`);
    }
  }
}

class CliSqliteExecutor implements SqliteExecutor {
  constructor(
    private readonly dbPath: string,
    private readonly sqliteCommand: string,
    private readonly sqliteArgs: string[],
  ) {}

  exec(sql: string): string {
    try {
      return execFileSync(this.sqliteCommand, [...this.sqliteArgs, this.dbPath], {
        input: sql,
        encoding: "utf8",
        maxBuffer: 10 * 1024 * 1024,
        windowsHide: true,
      });
    } catch (error) {
      if (isErrorWithCode(error, "ENOENT")) {
        throw new Error(
          `SQLite CLI command "${this.sqliteCommand}" was not found. Install sqlite3 on PATH or use a Node.js version with node:sqlite support for the default session SQL runtime.`,
        );
      }
      throw new Error(`SQLite CLI session store execution failed: ${formatExecutionError(error)}`);
    }
  }
}

let cachedNodeSqliteAvailable: boolean | undefined;

function isNodeSqliteAvailable(): boolean {
  cachedNodeSqliteAvailable ??=
    spawnSync(process.execPath, ["--no-warnings", "-e", NODE_SQLITE_SMOKE_SCRIPT], {
      stdio: "ignore",
      windowsHide: true,
    }).status === 0;
  return cachedNodeSqliteAvailable;
}

function isErrorWithCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === code;
}

function formatExecutionError(error: unknown): string {
  if (typeof error !== "object" || error === null) return String(error);
  const candidate = error as { message?: unknown; stderr?: unknown; status?: unknown };
  const stderr =
    Buffer.isBuffer(candidate.stderr)
      ? candidate.stderr.toString("utf8").trim()
      : typeof candidate.stderr === "string"
        ? candidate.stderr.trim()
        : "";
  const status = typeof candidate.status === "number" ? `exit status ${candidate.status}` : undefined;
  const message = typeof candidate.message === "string" ? candidate.message : undefined;
  return [status, stderr || message].filter(Boolean).join(": ") || String(error);
}

export function sanitizeDiagnosticMessage(message: string): string {
  return String(sanitizeDatasourcePayload(message)).slice(0, 500);
}

function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function sqlJson(value: unknown): string {
  return sqlString(JSON.stringify(value));
}

function sqlInteger(value: number): string {
  if (!Number.isInteger(value) || value < 0) throw new Error("SQL integer limit must be a non-negative integer.");
  return String(value);
}

function parseJsonScalar(value: string): string | number | boolean | null {
  const parsed = JSON.parse(value) as unknown;
  if (parsed === null || typeof parsed === "string" || typeof parsed === "number" || typeof parsed === "boolean") return parsed;
  return JSON.stringify(parsed).slice(0, 240);
}

function collectFacts(value: unknown): SqlDatasourceFact[] {
  const facts: SqlDatasourceFact[] = [];
  const stack: Array<{ path: string; value: unknown }> = [{ path: "$", value }];
  while (stack.length && facts.length < 120) {
    const current = stack.pop()!;
    if (Array.isArray(current.value)) {
      for (let index = current.value.length - 1; index >= 0; index--) stack.push({ path: `${current.path}[${index}]`, value: current.value[index] });
      continue;
    }
    if (!current.value || typeof current.value !== "object") continue;
    for (const [key, nestedValue] of Object.entries(current.value)) {
      const path = `${current.path}.${key}`;
      if (
        isFactScalar(nestedValue) &&
        (IMPORTANT_FIELD_NAMES.has(key) ||
          /count|status|plan|address|bfe|matrikel|kommune|doklink|room|unit|anvendelse|areal|area|vaerel|værel|opfoer|opfør|year|etage|floor|beloeb|beløb|vurdering/i.test(
            key,
          ))
      ) {
        facts.push({ path, key, value: nestedValue });
      }
    }
    for (const [key, nestedValue] of Object.entries(current.value).reverse()) {
      if (nestedValue && typeof nestedValue === "object") stack.push({ path: `${current.path}.${key}`, value: nestedValue });
    }
  }
  return facts;
}

function isFactScalar(value: unknown): value is string | number | boolean | null {
  return value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

function collectMessagesByKey(value: unknown, keyPattern: RegExp): string[] {
  const messages: string[] = [];
  const stack: unknown[] = [value];
  while (stack.length && messages.length < 80) {
    const current = stack.pop();
    if (Array.isArray(current)) {
      for (const item of current) stack.push(item);
      continue;
    }
    if (!current || typeof current !== "object") continue;
    for (const [key, nestedValue] of Object.entries(current)) {
      if (keyPattern.test(key)) collectMessageValues(nestedValue, messages);
      else if (nestedValue && typeof nestedValue === "object") stack.push(nestedValue);
    }
  }
  return [...new Set(messages.map((message) => message.slice(0, 500)))];
}

function collectMessageValues(value: unknown, messages: string[]): void {
  if (messages.length >= 80) return;
  if (typeof value === "string") {
    messages.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) collectMessageValues(item, messages);
  } else if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const text = record.message ?? record.description ?? record.action ?? record.name ?? record.code;
    if (typeof text === "string") messages.push(text);
  }
}

