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
CREATE INDEX IF NOT EXISTS idx_datasource_calls_session_status ON datasource_calls(session_id, status);
`);
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
`);
  }

  recordIntentAudit(
    metadata: DatasourceCallMetadata,
    auditMeta: Record<string, unknown>,
    rawResponse?: unknown,
  ): void {
    const request = sanitizeDatasourcePayload(metadata.input);
    const audit = sanitizeDatasourcePayload(auditMeta);
    const rawAuditEnabled = process.env.MANAGED_AGENT_AUDIT_RAW === "1" && rawResponse !== undefined;
    const response = rawAuditEnabled
      ? { audit, rawResponse: sanitizeDatasourcePayload(rawResponse) }
      : { audit };
    const code = typeof auditMeta.code === "string" && auditMeta.code ? auditMeta.code : "success";
    const status = code === "success" ? "success" : "error";
    const message = status === "success" ? "Intent bridge metadata-only audit row." : `Intent bridge error: ${code}`;
    this.exec(`
INSERT OR REPLACE INTO datasource_calls
  (call_id, session_id, datasource, managed_tool_name, mcp_tool_name, status, request_json, response_json, error_code, error_message, summary)
VALUES
  (${sqlString(metadata.callId)}, ${sqlString(metadata.sessionId)}, ${sqlString(metadata.datasource)}, ${sqlString(metadata.managedToolName)}, ${sqlString(metadata.mcpToolName)}, ${sqlString(status)}, ${sqlJson(request)}, ${sqlJson(response)}, ${sqlString(status === "success" ? "" : code)}, ${sqlString(status === "success" ? "" : message)}, ${sqlString(`${metadata.datasource}.${metadata.mcpToolName} ${message}`)});
`);
  }

  private exec(sql: string): string {
    return this.getExecutor().exec(sql);
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