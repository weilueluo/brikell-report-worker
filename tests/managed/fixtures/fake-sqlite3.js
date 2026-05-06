const { existsSync, readFileSync, writeFileSync } = require("node:fs");

const dbPath = process.argv[2];
let sql = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  sql += chunk;
});
process.stdin.on("end", () => {
  const db = existsSync(dbPath)
    ? JSON.parse(readFileSync(dbPath, "utf8"))
    : { calls: {}, facts: [], limitations: [], followups: [] };

  if (sql.trimStart().startsWith(".mode json")) {
    process.stdout.write(JSON.stringify(query(db, sql)));
    return;
  }

  applyStatements(db, sql);
  writeFileSync(dbPath, JSON.stringify(db), "utf8");
});

function query(db, sql) {
  const callId = readWhere(sql, "call_id");
  const sessionId = readWhere(sql, "session_id");
  if (/SELECT \* FROM datasource_calls/i.test(sql)) return db.calls[callId] ? [db.calls[callId]] : [];
  if (/FROM datasource_facts WHERE call_id/i.test(sql)) return db.facts.filter((row) => row.call_id === callId);
  if (/FROM datasource_followups WHERE call_id/i.test(sql)) return db.followups.filter((row) => row.call_id === callId);
  if (/FROM datasource_limitations WHERE call_id/i.test(sql)) return db.limitations.filter((row) => row.call_id === callId);
  if (/SELECT datasource, mcp_tool_name, status, error_message FROM datasource_calls/i.test(sql)) {
    return Object.values(db.calls)
      .filter((row) => row.session_id === sessionId)
      .map((row) => ({ datasource: row.datasource, mcp_tool_name: row.mcp_tool_name, status: row.status, error_message: row.error_message }));
  }
  if (/FROM datasource_facts f JOIN datasource_calls/i.test(sql)) {
    return db.facts.filter((row) => db.calls[row.call_id]?.session_id === sessionId && db.calls[row.call_id]?.status === "success");
  }
  if (/FROM datasource_limitations l JOIN datasource_calls/i.test(sql)) {
    return db.limitations.filter((row) => db.calls[row.call_id]?.session_id === sessionId && db.calls[row.call_id]?.status === "success");
  }
  return [];
}

function applyStatements(db, sql) {
  for (const statement of sql.split(/;\s*\n?/)) {
    if (/INSERT OR REPLACE INTO datasource_calls/i.test(statement)) {
      const values = readQuoted(statement);
      const isError = values[5] === "error";
      db.calls[values[0]] = isError
        ? {
            call_id: values[0],
            session_id: values[1],
            datasource: values[2],
            managed_tool_name: values[3],
            mcp_tool_name: values[4],
            status: values[5],
            request_json: values[6],
            error_code: values[7],
            error_message: values[8],
            summary: values[9],
          }
        : {
            call_id: values[0],
            session_id: values[1],
            datasource: values[2],
            managed_tool_name: values[3],
            mcp_tool_name: values[4],
            status: values[5],
            request_json: values[6],
            response_json: values[7],
            summary: values[8],
          };
    } else if (/DELETE FROM datasource_facts/i.test(statement)) {
      const callId = readWhere(statement, "call_id");
      db.facts = db.facts.filter((row) => row.call_id !== callId);
    } else if (/DELETE FROM datasource_limitations/i.test(statement)) {
      const callId = readWhere(statement, "call_id");
      db.limitations = db.limitations.filter((row) => row.call_id !== callId);
    } else if (/DELETE FROM datasource_followups/i.test(statement)) {
      const callId = readWhere(statement, "call_id");
      db.followups = db.followups.filter((row) => row.call_id !== callId);
    } else if (/INSERT INTO datasource_facts/i.test(statement)) {
      const values = readValues(statement);
      db.facts.push({ call_id: values[0], path: values[1], key: values[2], value_json: values[3], value_text: values[4] });
    } else if (/INSERT INTO datasource_limitations/i.test(statement)) {
      const values = readValues(statement);
      db.limitations.push({ call_id: values[0], message: values[1] });
    } else if (/INSERT INTO datasource_followups/i.test(statement)) {
      const values = readValues(statement);
      db.followups.push({ call_id: values[0], message: values[1] });
    }
  }
}

function readWhere(sql, column) {
  const match = sql.match(new RegExp(`${column}\\s*=\\s*'((?:''|[^'])*)'`, "i"));
  return match ? match[1].replace(/''/g, "'") : "";
}

function readValues(statement) {
  const match = statement.match(/VALUES\s*\(([\s\S]*)\)/i);
  if (!match) return [];
  const values = [];
  const text = match[1];
  let current = "";
  let inString = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (char === "'") {
      if (inString && text[index + 1] === "'") {
        current += "'";
        index++;
      } else {
        inString = !inString;
      }
    } else if (char === "," && !inString) {
      values.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }
  values.push(current.trim());
  return values;
}

function readQuoted(statement) {
  const values = [];
  let current = "";
  let inString = false;
  for (let index = 0; index < statement.length; index++) {
    const char = statement[index];
    if (char !== "'") {
      if (inString) current += char;
      continue;
    }
    if (inString && statement[index + 1] === "'") {
      current += "'";
      index++;
      continue;
    }
    if (inString) {
      values.push(current);
      current = "";
      inString = false;
    } else {
      inString = true;
    }
  }
  return values;
}
