import { readFile } from "node:fs/promises";

export class ConfigError extends Error {}

const DEFAULTS = {
  base_url: "",
  username: "",
  password: "",
  session_cookie: "",
  csrf_cookie: "",
  verify_tls: true,
  timeout: 30,
  api_flavor: "auto",
  default_limit: 100,
  max_limit: 5000,
  max_rows: 200,
  allow_write_sql: false,
};

const ENV_MAP = {
  ARCHERY_BASE_URL: "base_url",
  ARCHERY_USERNAME: "username",
  ARCHERY_PASSWORD: "password",
  ARCHERY_SESSION_COOKIE: "session_cookie",
  ARCHERY_CSRF_COOKIE: "csrf_cookie",
  ARCHERY_VERIFY_TLS: "verify_tls",
  ARCHERY_TIMEOUT: "timeout",
  ARCHERY_API_FLAVOR: "api_flavor",
  ARCHERY_DEFAULT_LIMIT: "default_limit",
  ARCHERY_MAX_LIMIT: "max_limit",
  ARCHERY_MAX_ROWS: "max_rows",
  ARCHERY_ALLOW_WRITE_SQL: "allow_write_sql",
};

function asBool(value, key) {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") {
    const text = value.trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(text)) return true;
    if (["0", "false", "no", "off", ""].includes(text)) return false;
  }
  throw new ConfigError(`配置项 ${key} 需要布尔值，收到: ${JSON.stringify(value)}`);
}

function asInt(value, key, minimum = 1) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < minimum) {
    throw new ConfigError(`配置项 ${key} 需要不小于 ${minimum} 的整数，收到: ${JSON.stringify(value)}`);
  }
  return number;
}

function asNumber(value, key) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    throw new ConfigError(`配置项 ${key} 需要大于 0 的数字，收到: ${JSON.stringify(value)}`);
  }
  return number;
}

export async function loadSettings(configPath) {
  let data = {};
  const file = configPath || process.env.ARCHERY_MCP_CONFIG || "";
  if (file) {
    let text;
    try {
      text = await readFile(file, "utf8");
    } catch (error) {
      throw new ConfigError(`配置文件不存在或无法读取: ${file} (${error.message})`);
    }
    try {
      data = JSON.parse(text);
    } catch (error) {
      throw new ConfigError(`配置文件不是合法 JSON: ${file}: ${error.message}`);
    }
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      throw new ConfigError(`配置文件顶层必须是对象: ${file}`);
    }
  }

  for (const [envName, key] of Object.entries(ENV_MAP)) {
    if (process.env[envName] !== undefined) data[key] = process.env[envName];
  }

  const known = new Set(Object.keys(DEFAULTS));
  const unknown = Object.keys(data).filter((key) => !known.has(key));
  if (unknown.length) throw new ConfigError(`未知配置项: ${unknown.join(", ")}`);

  const settings = { ...DEFAULTS, ...data };
  settings.base_url = String(settings.base_url || "").trim().replace(/\/+$/, "");
  settings.username = String(settings.username || "").trim();
  settings.password = String(settings.password || "");
  settings.session_cookie = String(settings.session_cookie || "").trim();
  settings.csrf_cookie = String(settings.csrf_cookie || "").trim();
  settings.verify_tls = asBool(settings.verify_tls, "verify_tls");
  settings.timeout = asNumber(settings.timeout, "timeout");
  settings.default_limit = asInt(settings.default_limit, "default_limit");
  settings.max_limit = asInt(settings.max_limit, "max_limit");
  settings.max_rows = asInt(settings.max_rows, "max_rows");
  settings.allow_write_sql = asBool(settings.allow_write_sql, "allow_write_sql");
  settings.api_flavor = String(settings.api_flavor || "auto").toLowerCase();
  if (!["auto", "v1", "v2"].includes(settings.api_flavor)) {
    throw new ConfigError("api_flavor 只能是 auto、v1 或 v2");
  }
  if (settings.max_limit < settings.default_limit) settings.max_limit = settings.default_limit;
  if (settings.max_rows > settings.max_limit) settings.max_rows = settings.max_limit;
  return settings;
}

export function validateForLogin(settings) {
  if (!settings.base_url) {
    throw new ConfigError("缺少配置 ARCHERY_BASE_URL（Archery 站点地址）");
  }
  let url;
  try {
    url = new URL(settings.base_url);
  } catch {
    throw new ConfigError(`ARCHERY_BASE_URL 不是合法的 http(s) 地址: ${settings.base_url}`);
  }
  if (!["http:", "https:"].includes(url.protocol) || !url.hostname) {
    throw new ConfigError(`ARCHERY_BASE_URL 不是合法的 http(s) 地址: ${settings.base_url}`);
  }
  if (!settings.session_cookie && !(settings.username && settings.password)) {
    throw new ConfigError(
      "缺少登录凭证：请配置 ARCHERY_USERNAME 与 ARCHERY_PASSWORD，或提供浏览器中的 ARCHERY_SESSION_COOKIE",
    );
  }
}

export function publicSummary(settings) {
  return {
    base_url: settings.base_url,
    username: settings.username,
    api_flavor: settings.api_flavor,
    verify_tls: settings.verify_tls,
    default_limit: settings.default_limit,
    max_limit: settings.max_limit,
    max_rows: settings.max_rows,
    allow_write_sql: settings.allow_write_sql,
    auth_mode: settings.session_cookie ? "session_cookie" : "password",
  };
}
