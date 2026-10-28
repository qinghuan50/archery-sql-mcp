export const READONLY_KEYWORDS = new Set(["select", "show", "describe", "desc", "explain", "with"]);

const FORBIDDEN = [
  [/\bfor\s+update\b/i, "SELECT ... FOR UPDATE 会加锁"],
  [/\binto\s+(outfile|dumpfile)\b/i, "INTO OUTFILE / DUMPFILE 会写文件"],
  [/\block\s+in\s+share\s+mode\b/i, "LOCK IN SHARE MODE 会加锁"],
  [/\binto\s+@/i, "SELECT ... INTO @变量 会修改会话变量"],
  [/\/\*!/, "MySQL 版本注释 /*! ... */ 可能隐藏可执行语句"],
  [/\bload_file\s*\(/i, "LOAD_FILE 可读取数据库服务器上的文件"],
];

const DML_PATTERN = /\b(insert|update|delete|replace|merge)\b/i;

export class UnsafeSQLError extends Error {}

export function splitStatements(sql) {
  const statements = [];
  let start = 0;
  let index = 0;
  let inSingle = false;
  let inDouble = false;
  let inBacktick = false;
  let inLineComment = false;
  let inBlockComment = false;

  while (index < sql.length) {
    const char = sql[index];
    const next = index + 1 < sql.length ? sql[index + 1] : "";

    if (inLineComment) {
      if (char === "\n") inLineComment = false;
      index += 1;
      continue;
    }
    if (inBlockComment) {
      if (char === "*" && next === "/") {
        inBlockComment = false;
        index += 2;
        continue;
      }
      index += 1;
      continue;
    }
    if (inSingle) {
      if (char === "\\") {
        index += 2;
        continue;
      }
      if (char === "'") {
        if (next === "'") {
          index += 2;
          continue;
        }
        inSingle = false;
      }
      index += 1;
      continue;
    }
    if (inDouble) {
      if (char === "\\") {
        index += 2;
        continue;
      }
      if (char === '"') {
        if (next === '"') {
          index += 2;
          continue;
        }
        inDouble = false;
      }
      index += 1;
      continue;
    }
    if (inBacktick) {
      if (char === "`") {
        if (next === "`") {
          index += 2;
          continue;
        }
        inBacktick = false;
      }
      index += 1;
      continue;
    }

    if (char === "-" && next === "-" && (index + 2 >= sql.length || /[ \t\r\n]/.test(sql[index + 2]))) {
      inLineComment = true;
      index += 2;
      continue;
    }
    if (char === "#") {
      inLineComment = true;
      index += 1;
      continue;
    }
    if (char === "/" && next === "*") {
      inBlockComment = true;
      index += 2;
      continue;
    }
    if (char === "'") {
      inSingle = true;
      index += 1;
      continue;
    }
    if (char === '"') {
      inDouble = true;
      index += 1;
      continue;
    }
    if (char === "`") {
      inBacktick = true;
      index += 1;
      continue;
    }
    if (char === ";") {
      const statement = sql.slice(start, index).trim();
      if (statement) statements.push(statement);
      start = index + 1;
    }
    index += 1;
  }

  const tail = sql.slice(start).trim();
  if (tail) statements.push(tail);
  return statements;
}

function stripLeadingComments(statement) {
  let text = statement.replace(/^\s+/, "");
  for (;;) {
    if (text.startsWith("--") || text.startsWith("#")) {
      const newline = text.indexOf("\n");
      if (newline < 0) return "";
      text = text.slice(newline + 1).replace(/^\s+/, "");
      continue;
    }
    if (text.startsWith("/*")) {
      const end = text.indexOf("*/", 2);
      if (end < 0) return "";
      text = text.slice(end + 2).replace(/^\s+/, "");
      continue;
    }
    return text;
  }
}

export function firstKeyword(statement) {
  let text = stripLeadingComments(statement);
  while (text.startsWith("(")) {
    text = stripLeadingComments(text.slice(1));
  }
  const match = text.match(/^([A-Za-z]+)/);
  return match ? match[1].toLowerCase() : "";
}

export function validateReadonly(sql, { allowWrite = false } = {}) {
  if (!sql || !sql.trim()) throw new UnsafeSQLError("SQL 不能为空");
  const statements = splitStatements(sql);
  if (!statements.length) throw new UnsafeSQLError("SQL 不能为空");
  if (allowWrite) return statements;

  for (const statement of statements) {
    const keyword = firstKeyword(statement);
    if (!READONLY_KEYWORDS.has(keyword)) {
      throw new UnsafeSQLError(
        `检测到非只读语句（${keyword || "未知类型"}）。当前 MCP 默认只允许 SELECT/SHOW/DESCRIBE/EXPLAIN 查询；` +
          "如确需执行变更，请改用工单流程，或由管理员显式开启 allow_write_sql。",
      );
    }
    for (const [pattern, reason] of FORBIDDEN) {
      if (pattern.test(statement)) {
        throw new UnsafeSQLError(`SQL 未通过只读校验：${reason}`);
      }
    }
    if (keyword === "with" && DML_PATTERN.test(statement)) {
      throw new UnsafeSQLError("WITH 语句中包含写操作关键字，已拒绝执行");
    }
    if (keyword === "explain" && /\banalyze\b/i.test(statement) && DML_PATTERN.test(statement)) {
      throw new UnsafeSQLError("EXPLAIN ANALYZE 会真实执行写语句，已拒绝");
    }
  }
  return statements;
}

export function clampLimit(requested, { defaultLimit, maximum }) {
  const value = requested === undefined || requested === null ? defaultLimit : Number(requested);
  if (!Number.isFinite(value) || value <= 0) return defaultLimit;
  return Math.min(Math.floor(value), maximum);
}
