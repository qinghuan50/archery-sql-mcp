import http from "node:http";
import https from "node:https";
import zlib from "node:zlib";

export class HttpTransportError extends Error {}

export class HttpResult {
  constructor(status, url, headers, body) {
    this.status = status;
    this.url = url;
    this.headers = headers;
    this.body = body;
  }

  header(name) {
    return this.headers[String(name).toLowerCase()] || "";
  }

  get text() {
    return this.body.toString("utf8");
  }

  json() {
    try {
      return JSON.parse(this.text);
    } catch {
      const snippet = this.text.replace(/\s+/g, " ").slice(0, 300);
      throw new Error(`响应不是合法 JSON（HTTP ${this.status}）: ${snippet}`);
    }
  }
}

function encodeParams(params) {
  const search = new URLSearchParams();
  const entries = Array.isArray(params)
    ? params
    : Object.entries(params || {});
  for (const [key, value] of entries) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item !== undefined && item !== null) search.append(key, String(item));
      }
    } else {
      search.append(key, String(value));
    }
  }
  return search.toString();
}

export class HttpClient {
  constructor(baseUrl, { verifyTls = true, timeout = 30 } = {}) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.origin = new URL(baseUrl).origin;
    this.verifyTls = verifyTls;
    this.timeout = timeout;
    this.cookies = new Map();
  }

  get csrfToken() {
    return this.cookies.get("csrftoken") || "";
  }

  get sessionCookie() {
    return this.cookies.get("sessionid") || "";
  }

  setCookie(name, value) {
    this.cookies.set(name, value);
  }

  cookieHeader() {
    return [...this.cookies.entries()]
      .map(([key, value]) => `${key}=${value}`)
      .join("; ");
  }

  storeSetCookies(setCookies) {
    const lines = Array.isArray(setCookies)
      ? setCookies
      : setCookies
        ? [String(setCookies)]
        : [];
    for (const line of lines) {
      const pair = String(line).split(";")[0];
      const index = pair.indexOf("=");
      if (index <= 0) continue;
      const name = pair.slice(0, index).trim();
      const value = pair.slice(index + 1).trim();
      if (name) this.cookies.set(name, value);
    }
  }

  async request(method, path, options = {}) {
    const {
      params = null,
      form = null,
      jsonBody = null,
      headers = {},
      timeout = null,
      redirects = 5,
    } = options;

    let url = this.baseUrl + (String(path).startsWith("/") ? path : `/${path}`);
    if (params) {
      const query = encodeParams(params);
      if (query) url += (url.includes("?") ? "&" : "?") + query;
    }

    let currentMethod = String(method).toUpperCase();
    let body = null;
    const baseHeaders = {
      "User-Agent": "archery-mcp/0.1 (+https://github.com/hhyo/Archery)",
      Accept: "application/json, text/plain, */*",
      "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.6",
      "Accept-Encoding": "gzip",
      Referer: `${this.origin}/`,
      ...headers,
    };

    if (form !== null) {
      body = Buffer.from(encodeParams(form), "utf8");
      baseHeaders["Content-Type"] = "application/x-www-form-urlencoded; charset=UTF-8";
    } else if (jsonBody !== null) {
      body = Buffer.from(JSON.stringify(jsonBody), "utf8");
      baseHeaders["Content-Type"] = "application/json; charset=UTF-8";
    }

    for (let attempt = 0; attempt <= redirects; attempt += 1) {
      const requestHeaders = { ...baseHeaders };
      if (currentMethod !== "GET" && currentMethod !== "HEAD") {
        requestHeaders.Origin = this.origin;
        const token = this.csrfToken;
        if (token) requestHeaders["X-CSRFToken"] = token;
        requestHeaders["X-Requested-With"] = "XMLHttpRequest";
      }
      const cookie = this.cookieHeader();
      if (cookie) requestHeaders.Cookie = cookie;
      if (body) requestHeaders["Content-Length"] = String(body.length);

      const result = await this._send(url, currentMethod, body, requestHeaders, timeout);
      this.storeSetCookies(result.headers["set-cookie"]);

      const location = result.header("location");
      if ([301, 302, 303, 307, 308].includes(result.status) && location && attempt < redirects) {
        url = new URL(location, url).toString();
        if ([301, 302, 303].includes(result.status)) {
          currentMethod = "GET";
          body = null;
          delete baseHeaders["Content-Type"];
        }
        continue;
      }
      return result;
    }
    throw new HttpTransportError("重定向次数过多");
  }

  _send(url, method, body, headers, timeout) {
    return new Promise((resolve, reject) => {
      let target;
      try {
        target = new URL(url);
      } catch (error) {
        reject(new HttpTransportError(`非法 URL: ${url}`));
        return;
      }
      const transport = target.protocol === "https:" ? https : http;
      const request = transport.request(
        target,
        {
          method,
          headers,
          timeout: (timeout ?? this.timeout) * 1000,
          ...(target.protocol === "https:" ? { rejectUnauthorized: this.verifyTls } : {}),
        },
        (response) => {
          const chunks = [];
          response.on("data", (chunk) => chunks.push(chunk));
          response.on("error", (error) => {
            reject(new HttpTransportError(`读取响应失败: ${error.message}`));
          });
          response.on("end", () => {
            let raw = Buffer.concat(chunks);
            if (String(response.headers["content-encoding"] || "").toLowerCase() === "gzip") {
              try {
                raw = zlib.gunzipSync(raw);
              } catch {
                // 保留原始内容，让上层报出可读错误
              }
            }
            resolve(new HttpResult(response.statusCode || 0, url, response.headers, raw));
          });
        },
      );
      request.on("timeout", () => {
        request.destroy(new Error("请求超时"));
      });
      request.on("error", (error) => {
        reject(new HttpTransportError(`请求 ${url} 失败: ${error.message}`));
      });
      if (body) request.write(body);
      request.end();
    });
  }

  get(path, options = {}) {
    return this.request("GET", path, options);
  }

  postForm(path, form, options = {}) {
    return this.request("POST", path, { ...options, form });
  }

  postJson(path, jsonBody, options = {}) {
    return this.request("POST", path, { ...options, jsonBody });
  }
}
