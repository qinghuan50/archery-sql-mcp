import { HttpClient, HttpTransportError } from "./http.mjs";
import { clampLimit, validateReadonly } from "./sqlguard.mjs";
import { validateForLogin } from "./config.mjs";

export class ArcheryError extends Error {
  constructor(message, { status = null, payload = null } = {}) {
    super(message);
    this.name = "ArcheryError";
    this.status = status;
    this.payload = payload;
  }
}

function flattenMessage(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "object") {
    if (Array.isArray(value)) return value.map(flattenMessage).filter(Boolean).join("; ");
    return Object.entries(value)
      .map(([key, item]) => {
        const text = flattenMessage(item);
        if (!text) return "";
        return ["msg", "detail"].includes(key) ? text : `${key}: ${text}`;
      })
      .filter(Boolean)
      .join("; ");
  }
  return String(value);
}

function payloadMessage(payload) {
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    for (const key of ["msg", "detail", "errors", "error", "message", "non_field_errors"]) {
      if (key in payload) {
        const text = flattenMessage(payload[key]);
        if (text) return text;
      }
    }
    return JSON.stringify(payload).slice(0, 500);
  }
  return flattenMessage(payload).slice(0, 500);
}

function isHtml(result) {
  const contentType = result.header("content-type").toLowerCase();
  if (contentType.includes("text/html")) return true;
  const head = result.text.replace(/^\s+/, "").slice(0, 200).toLowerCase();
  return head.startsWith("<!doctype") || head.startsWith("<html");
}

function decodeHtml(text) {
  return String(text)
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)));
}

export class ArcheryClient {
  constructor(settings) {
    this.settings = settings;
    this.http = new HttpClient(settings.base_url, {
      verifyTls: settings.verify_tls,
      timeout: settings.timeout,
    });
    this._loggedIn = false;
    this._reloginAttempted = false;
    this._flavor = null;
    this._instances = new Map();
    this._groups = null;
  }

  get flavor() {
    if (["v1", "v2"].includes(this.settings.api_flavor)) return this.settings.api_flavor;
    return this._flavor || "v1";
  }

  async login() {
    if (this._loggedIn) return;
    validateForLogin(this.settings);

    if (this.settings.session_cookie) {
      this.http.setCookie("sessionid", this.settings.session_cookie);
      if (this.settings.csrf_cookie) {
        this.http.setCookie("csrftoken", this.settings.csrf_cookie);
      } else {
        try {
          await this.http.get("/", { headers: { Accept: "text/html" } });
        } catch {
          // 拿不到 csrftoken 就交给后续请求报错
        }
      }
      this._loggedIn = true;
      return;
    }

    const loginPage = await this.http.get("/login/", {
      headers: { Accept: "text/html,application/xhtml+xml" },
    });
    let token = this.http.csrfToken;
    if (!token) {
      const match = loginPage.text.match(/name=["']csrfmiddlewaretoken["']\s+value=["']([^"']+)/);
      if (match) token = match[1];
    }
    if (!token) {
      throw new ArcheryError(
        `无法从 ${this.settings.base_url}/login/ 获取 CSRF token，请确认该地址是 Archery 站点且可访问`,
      );
    }

    const response = await this.http.postForm(
      "/authenticate/",
      {
        username: this.settings.username,
        password: this.settings.password,
        csrfmiddlewaretoken: token,
      },
      {
        headers: {
          "X-CSRFToken": token,
          Referer: `${this.settings.base_url}/login/`,
          Accept: "application/json, text/javascript, */*; q=0.01",
        },
      },
    );
    let payload;
    try {
      payload = response.json();
    } catch {
      throw new ArcheryError("登录接口返回了非 JSON 内容，可能站点地址错误或登录页结构不兼容", {
        status: response.status,
      });
    }
    if (payload.status !== 0) {
      throw new ArcheryError(`Archery 登录失败: ${payloadMessage(payload)}`, { payload });
    }
    if (payload.data) {
      throw new ArcheryError(
        "该账号启用了二次验证（2FA）或 SSO，账号密码登录未完成。请在浏览器登录 Archery 后，将 sessionid（以及 csrftoken）配置为 ARCHERY_SESSION_COOKIE / ARCHERY_CSRF_COOKIE。",
      );
    }
    if (!this.http.sessionCookie) {
      throw new ArcheryError("登录响应未返回会话 Cookie，无法继续访问 Archery");
    }
    this._loggedIn = true;
    this._reloginAttempted = false;
  }

  _looksLikeLogin(result) {
    if (result.status === 401) return true;
    if (result.status === 403) {
      const text = result.text.toLowerCase();
      return text.includes("csrf") || text.includes("身份认证");
    }
    if (result.status === 200 && isHtml(result)) {
      let path = "";
      try {
        path = new URL(result.url).pathname.toLowerCase();
      } catch {
        path = "";
      }
      if (path.includes("login")) return true;
      const text = result.text.toLowerCase();
      return text.includes("请登录") && text.includes("csrfmiddlewaretoken");
    }
    return false;
  }

  async _callJson(method, path, options = {}) {
    await this.login();
    let result = await this.http.request(method, path, options);
    if (this._looksLikeLogin(result) && !this._reloginAttempted) {
      this._reloginAttempted = true;
      this._loggedIn = false;
      await this.login();
      result = await this.http.request(method, path, options);
    }
    if (this._looksLikeLogin(result)) {
      const hint = this.settings.session_cookie
        ? "请更新 ARCHERY_SESSION_COOKIE / ARCHERY_CSRF_COOKIE。"
        : "请检查账号权限，或改用 ARCHERY_SESSION_COOKIE。";
      throw new ArcheryError(`Archery 会话无效或已过期，且自动重新登录未成功。${hint}`, {
        status: result.status,
      });
    }
    return result;
  }

  _json(result, { action, whitelistHint = false }) {
    if (result.status >= 400) {
      let payload = null;
      try {
        payload = result.json();
      } catch {
        payload = null;
      }
      let message = payload !== null ? payloadMessage(payload) : result.text.replace(/\s+/g, " ").slice(0, 300);
      if (whitelistHint && [401, 403].includes(result.status)) {
        message +=
          "（若为 Archery 1.x，REST 工单接口还要求账号出现在“系统设置 → API_USER_WHITELIST”中）";
      }
      throw new ArcheryError(`${action}失败：HTTP ${result.status}，${message}`, {
        status: result.status,
        payload,
      });
    }
    let payload;
    try {
      payload = result.json();
    } catch (error) {
      throw new ArcheryError(`${action}失败：HTTP ${result.status}，${error.message}`, {
        status: result.status,
      });
    }
    if (payload && typeof payload === "object" && "status" in payload) {
      const code = Number(payload.status);
      if (Number.isInteger(code) && code !== 0) {
        throw new ArcheryError(`${action}失败：${payloadMessage(payload)}`, { payload });
      }
    }
    return payload;
  }

  async detectFlavor() {
    if (["v1", "v2"].includes(this.settings.api_flavor)) {
      this._flavor = this.settings.api_flavor;
      return this._flavor;
    }
    if (this._flavor) return this._flavor;
    const result = await this._callJson("GET", "/api/v1/sqlquery/instances/");
    if (result.status === 200) {
      try {
        const payload = result.json();
        if (payload && payload.status === 0) {
          this._flavor = "v2";
          return this._flavor;
        }
      } catch {
        // 404/HTML 时按 v1 处理
      }
    }
    this._flavor = "v1";
    return this._flavor;
  }

  async listInstances(tag = "can_read", search = null) {
    const cacheKey = tag || "can_read";
    if (!this._instances.has(cacheKey)) {
      const path =
        (await this.detectFlavor()) === "v2"
          ? "/api/v1/sqlquery/instances/"
          : "/group/user_all_instances/";
      const result = await this._callJson("GET", path, {
        params: [
          ["tag_codes[]", cacheKey],
          ["type", ""],
        ],
      });
      const payload = this._json(result, { action: "获取实例列表" });
      const data = Array.isArray(payload?.data) ? payload.data : [];
      this._instances.set(cacheKey, data.filter((row) => row && typeof row === "object"));
    }
    let rows = this._instances.get(cacheKey) || [];
    if (search) {
      const needle = String(search).toLowerCase();
      rows = rows.filter((row) => String(row.instance_name || "").toLowerCase().includes(needle));
    }
    return rows;
  }

  async resolveInstance(ref, { tag = "can_read" } = {}) {
    const rows = await this.listInstances(tag);
    const text = String(ref ?? "").trim();
    if (!text) throw new ArcheryError("instance 参数不能为空，请传实例名称或 ID");
    if (/^\d+$/.test(text)) {
      const found = rows.find((row) => String(row.id) === text);
      if (found) return found;
    }
    const exact = rows.find((row) => String(row.instance_name) === text);
    if (exact) return exact;
    const folded = text.toLowerCase();
    const insensitive = rows.find(
      (row) => String(row.instance_name || "").toLowerCase() === folded,
    );
    if (insensitive) return insensitive;
    const names = rows.slice(0, 30).map((row) => row.instance_name).join(", ");
    throw new ArcheryError(`找不到你有权限的实例 ${JSON.stringify(ref)}（tag=${tag}）。可用实例: ${names || "无"}`);
  }

  async listDatabases(instance) {
    const record = await this.resolveInstance(instance, { tag: "can_read" });
    const name = record.instance_name;
    const path =
      (await this.detectFlavor()) === "v2"
        ? "/api/v1/sqlquery/resources/"
        : "/instance/instance_resource/";
    const result = await this._callJson("GET", path, {
      params: [
        ["instance_name", name],
        ["resource_type", "database"],
      ],
    });
    const payload = this._json(result, { action: `获取实例 ${name} 的数据库列表` });
    const data = Array.isArray(payload?.data) ? payload.data : [];
    const names = [];
    for (const item of data) {
      if (typeof item === "string") names.push(item);
      else if (item && typeof item === "object") {
        const value = item.db_name || item.name;
        if (value) names.push(String(value));
      }
    }
    return names;
  }

  async describeTable(instance, database, table, schema = "") {
    const record = await this.resolveInstance(instance, { tag: "can_read" });
    const payloadBody = {
      instance_name: record.instance_name,
      db_name: database,
      tb_name: table,
      schema_name: schema || "",
    };
    let result;
    if ((await this.detectFlavor()) === "v2") {
      result = await this._callJson("POST", "/api/v1/sqlquery/describetable/", {
        jsonBody: payloadBody,
      });
    } else {
      result = await this._callJson("POST", "/instance/describetable/", {
        form: payloadBody,
      });
    }
    const payload = this._json(result, { action: `获取表 ${database}.${table} 的结构` });
    let data = payload && typeof payload === "object" && "data" in payload ? payload.data : payload;
    if (data && typeof data === "object" && !Array.isArray(data) && "rows" in data) {
      const columns = Array.isArray(data.column_list) ? data.column_list : [];
      const rows = Array.isArray(data.rows) ? data.rows : [];
      if (rows.length && Array.isArray(rows[0])) {
        return rows.map((row) => Object.fromEntries(columns.map((column, index) => [column, row[index]])));
      }
      return rows;
    }
    return data;
  }

  async query(instance, database, sql, { limit = null, schema = "", table = "" } = {}) {
    const statements = validateReadonly(sql, { allowWrite: this.settings.allow_write_sql });
    const effectiveLimit = clampLimit(limit, {
      defaultLimit: this.settings.default_limit,
      maximum: this.settings.max_limit,
    });
    const record = await this.resolveInstance(instance, { tag: "can_read" });
    const name = record.instance_name;
    const body = {
      instance_name: name,
      db_name: database,
      schema_name: schema || "",
      tb_name: table || "",
      sql_content: sql,
      limit_num: effectiveLimit,
    };
    let result;
    if ((await this.detectFlavor()) === "v2") {
      result = await this._callJson("POST", "/api/v1/sqlquery/execute/", { jsonBody: body });
    } else {
      result = await this._callJson("POST", "/query/", { form: body });
    }
    const payload = this._json(result, { action: "执行查询" });
    const data = payload && typeof payload.data === "object" && payload.data ? payload.data : {};
    const columns = Array.isArray(data.column_list) ? data.column_list : [];
    const rawRows = Array.isArray(data.rows) ? data.rows : [];
    const normalized = rawRows.map((row) => {
      if (row && typeof row === "object" && !Array.isArray(row)) return row;
      if (Array.isArray(row)) {
        return Object.fromEntries(columns.map((column, index) => [column, row[index]]));
      }
      return { value: row };
    });
    const finalColumns = columns.length ? columns : normalized.length ? Object.keys(normalized[0]) : [];
    const total = normalized.length;
    const rows = normalized.slice(0, this.settings.max_rows);
    return {
      instance: name,
      database,
      statement_count: statements.length,
      limit: effectiveLimit,
      columns: finalColumns,
      row_count: rows.length,
      total_rows: total,
      truncated: total > this.settings.max_rows,
      query_time: data.query_time ?? "",
      is_masked: Boolean(data.is_masked),
      rows,
    };
  }

  async listGroups() {
    if (this._groups !== null) return this._groups;
    const groups = [];
    if ((await this.detectFlavor()) === "v2") {
      let page = 1;
      while (page <= 10) {
        const result = await this._callJson("GET", "/api/v1/user/resourcegroup/", {
          params: [
            ["page", page],
            ["size", 100],
          ],
        });
        const payload = this._json(result, { action: "获取资源组列表" });
        const rows = Array.isArray(payload?.results) ? payload.results : [];
        for (const row of rows) {
          if (row && typeof row === "object") {
            groups.push({ group_id: row.group_id, group_name: row.group_name || "" });
          }
        }
        if (!payload?.next || !rows.length) break;
        page += 1;
      }
    } else {
      let pageResult = null;
      try {
        pageResult = await this._callJson("GET", "/submitsql/");
      } catch {
        pageResult = null;
      }
      if (pageResult && pageResult.status < 400 && isHtml(pageResult)) {
        groups.push(...this._parseGroupOptions(pageResult.text));
      }
      if (!groups.length) {
        const result = await this._callJson("GET", "/api/v1/user/resourcegroup/", {
          params: [
            ["page", 1],
            ["size", 100],
          ],
        });
        const payload = this._json(result, { action: "获取资源组列表" });
        for (const row of Array.isArray(payload?.results) ? payload.results : []) {
          if (row && typeof row === "object") {
            groups.push({ group_id: row.group_id, group_name: row.group_name || "" });
          }
        }
      }
    }
    this._groups = groups;
    return groups;
  }

  _parseGroupOptions(page) {
    const groups = [];
    const seen = new Set();
    const pattern = /<option[^>]*group-id=["'](\d+)["'][^>]*>(.*?)<\/option>/gis;
    let match;
    while ((match = pattern.exec(page)) !== null) {
      const groupId = Number(match[1]);
      const name = decodeHtml(match[2].replace(/<[^>]+>/g, "")).trim();
      if (!seen.has(groupId)) {
        seen.add(groupId);
        groups.push({ group_id: groupId, group_name: name });
      }
    }
    return groups;
  }

  async resolveGroup(ref) {
    let groups;
    try {
      groups = await this.listGroups();
    } catch (error) {
      if (/^\d+$/.test(String(ref ?? "").trim())) {
        return { group_id: Number(String(ref).trim()), group_name: "" };
      }
      throw error;
    }
    if (ref === undefined || ref === null || ref === "") {
      if (groups.length === 1) return groups[0];
      const listing = groups.slice(0, 30).map((g) => `${g.group_name}(${g.group_id})`).join(", ");
      throw new ArcheryError(
        `未指定 group，且当前账号可用的资源组不是唯一一个。请传 group（ID 或名称）。可用资源组: ${listing || "无"}`,
      );
    }
    const text = String(ref).trim();
    if (/^\d+$/.test(text)) {
      const found = groups.find((group) => String(group.group_id) === text);
      if (found) return found;
    }
    const exact = groups.find((group) => String(group.group_name) === text);
    if (exact) return exact;
    const folded = text.toLowerCase();
    const insensitive = groups.find(
      (group) => String(group.group_name || "").toLowerCase() === folded,
    );
    if (insensitive) return insensitive;
    const listing = groups.slice(0, 30).map((g) => `${g.group_name}(${g.group_id})`).join(", ");
    throw new ArcheryError(`找不到资源组 ${JSON.stringify(ref)}。可用资源组: ${listing || "无"}`);
  }

  async submitWorkflow({
    instance,
    database,
    sql,
    workflowName,
    group = null,
    demandUrl = "",
    backup = true,
    runDateStart = "",
    runDateEnd = "",
  }) {
    if (!sql || !sql.trim()) throw new ArcheryError("sql 不能为空");
    const name = String(workflowName || "").trim();
    if (!name) throw new ArcheryError("workflow_name 不能为空");
    if (name.length > 50) throw new ArcheryError(`workflow_name 最多 50 个字符，当前 ${name.length} 个`);

    const record = await this.resolveInstance(instance, { tag: "can_write" });
    const groupRecord = await this.resolveGroup(group);
    const body = {
      workflow: {
        workflow_name: name,
        demand_url: demandUrl || "",
        group_id: groupRecord.group_id,
        instance: record.id,
        db_name: database,
        is_backup: Boolean(backup),
        run_date_start: runDateStart || "",
        run_date_end: runDateEnd || "",
        is_offline_export: 0,
      },
      sql_content: sql,
    };

    let payload;
    if ((await this.detectFlavor()) === "v2") {
      const result = await this._callJson("POST", "/api/v1/sql-workflows/", { jsonBody: body });
      payload = this._json(result, { action: "提交 SQL 工单" });
    } else {
      const result = await this._callJson("POST", "/api/v1/workflow/", { jsonBody: body });
      payload = this._json(result, { action: "提交 SQL 工单", whitelistHint: true });
    }

    const data = {
      workflow_id: this._extractWorkflowId(payload),
      audit_id: this._extractAuditId(payload),
      workflow_name: name,
      instance: record.instance_name,
      database,
      group_id: groupRecord.group_id,
      group_name: groupRecord.group_name,
      status: this._extractStatus(payload) || ((await this.detectFlavor()) === "v2" ? "submitted" : ""),
      message: payload && typeof payload === "object" ? payloadMessage(payload) : "",
    };
    if ((await this.detectFlavor()) === "v1" && payload && typeof payload === "object") {
      const review = this._parseJsonRows(payload.review_content);
      if (review.length) data.review = review;
    }
    return data;
  }

  _extractWorkflowId(payload) {
    if (!payload || typeof payload !== "object") return null;
    const data = payload.data && typeof payload.data === "object" ? payload.data : {};
    const workflow = payload.workflow && typeof payload.workflow === "object" ? payload.workflow : {};
    for (const candidate of [data.workflow_id, payload.workflow_id, payload.id, workflow.id]) {
      if (candidate !== undefined && candidate !== null && candidate !== "") {
        const number = Number(candidate);
        if (Number.isInteger(number)) return number;
      }
    }
    return null;
  }

  _extractAuditId(payload) {
    if (!payload || typeof payload !== "object") return null;
    const data = payload.data && typeof payload.data === "object" ? payload.data : {};
    for (const candidate of [data.audit_id, payload.audit_id]) {
      if (candidate !== undefined && candidate !== null && candidate !== "") {
        const number = Number(candidate);
        if (Number.isInteger(number)) return number;
      }
    }
    return null;
  }

  _extractStatus(payload) {
    if (!payload || typeof payload !== "object") return "";
    const data = payload.data && typeof payload.data === "object" ? payload.data : {};
    const workflow = payload.workflow && typeof payload.workflow === "object" ? payload.workflow : {};
    return String(data.status || payload.status_text || workflow.status || "");
  }

  async listWorkflows({ scope = "mine", status = "", search = "", limit = 20, offset = 0 } = {}) {
    const safeLimit = Math.max(1, Math.min(Number(limit) || 20, 100));
    const safeOffset = Math.max(0, Number(offset) || 0);
    if (!["mine", "audit"].includes(scope)) throw new ArcheryError("scope 只能是 mine 或 audit");

    if ((await this.detectFlavor()) === "v2") {
      const path =
        scope === "audit" ? "/api/v1/sql-workflows/audit-list/" : "/api/v1/sql-workflows/list/";
      const result = await this._callJson("POST", path, {
        jsonBody: {
          limit: safeLimit,
          offset: safeOffset,
          navStatus: status || "",
          search: search || "",
        },
      });
      const payload = this._json(result, { action: "获取工单列表" });
      const rows = Array.isArray(payload?.rows) ? payload.rows : [];
      return {
        total: payload?.total ?? rows.length,
        limit: safeLimit,
        offset: safeOffset,
        items: rows.filter((row) => row && typeof row === "object").map((row) => this._normalizeV2Workflow(row)),
      };
    }

    if (scope === "audit") {
      const result = await this._callJson("POST", "/api/v1/workflow/auditlist/", {
        jsonBody: { engineer: this.settings.username },
      });
      const payload = this._json(result, { action: "获取待审核工单", whitelistHint: true });
      const rows = Array.isArray(payload?.results) ? payload.results : [];
      return {
        total: payload?.count ?? rows.length,
        limit: safeLimit,
        offset: safeOffset,
        items: rows.filter((row) => row && typeof row === "object").map((row) => this._normalizeV1Audit(row)),
      };
    }

    const page = Math.floor(safeOffset / safeLimit) + 1;
    const params = [
      ["page", page],
      ["size", safeLimit],
    ];
    if (status) params.push(["workflow__status", status]);
    if (search) params.push(["workflow__workflow_name", search]);
    const result = await this._callJson("GET", "/api/v1/workflow/", { params });
    const payload = this._json(result, { action: "获取工单列表", whitelistHint: true });
    const rows = Array.isArray(payload?.results) ? payload.results : [];
    let items = await Promise.all(
      rows
        .filter((row) => row && typeof row === "object")
        .map((row) => this._normalizeV1Workflow(row)),
    );
    const remainder = safeOffset % safeLimit;
    if (remainder) items = items.slice(remainder);
    return { total: payload?.count ?? rows.length, limit: safeLimit, offset: safeOffset, items };
  }

  async _normalizeV1Workflow(item) {
    const workflow = item.workflow && typeof item.workflow === "object" ? item.workflow : {};
    return {
      workflow_id: item.workflow_id || workflow.id,
      workflow_name: workflow.workflow_name || "",
      status: workflow.status || "",
      engineer: workflow.engineer || "",
      instance: await this._instanceName(workflow.instance),
      database: workflow.db_name || "",
      group_id: workflow.group_id,
      group_name: workflow.group_name || "",
      create_time: workflow.create_time || "",
      syntax_type: workflow.syntax_type,
      is_backup: workflow.is_backup,
    };
  }

  _normalizeV1Audit(item) {
    return {
      audit_id: item.audit_id,
      workflow_id: item.workflow_id,
      workflow_title: item.workflow_title || "",
      group_name: item.group_name || "",
      current_status: item.current_status,
      current_status_display: item.current_status_display || "",
      create_time: item.create_time || "",
    };
  }

  _normalizeV2Workflow(row) {
    return {
      workflow_id: row.workflow_id || row.id,
      audit_id: row.audit_id,
      workflow_name: row.workflow_name || "",
      status: row.status || "",
      engineer: row.engineer_display || row.engineer || "",
      instance: row.instance__instance_name || row.instance_name || "",
      database: row.db_name || "",
      group_id: row.group_id,
      group_name: row.group_name || "",
      create_time: row.create_time || "",
      syntax_type: row.syntax_type,
      is_backup: row.is_backup,
    };
  }

  async _instanceName(instanceId) {
    if (instanceId === undefined || instanceId === null) return "";
    try {
      const rows = await this.listInstances("can_read");
      const found = rows.find((row) => String(row.id) === String(instanceId));
      return found ? found.instance_name : instanceId;
    } catch {
      return instanceId;
    }
  }

  async getWorkflow({ workflowId = null, auditId = null, includeLogs = true } = {}) {
    if ((await this.detectFlavor()) === "v2") {
      return this._getWorkflowV2({ workflowId, auditId, includeLogs });
    }
    return this._getWorkflowV1({ workflowId, auditId, includeLogs });
  }

  async _getWorkflowV1({ workflowId, auditId, includeLogs }) {
    if (!workflowId && auditId) throw new ArcheryError("v1 接口请传 workflow_id（audit_id 仅 v2 支持）");
    if (!workflowId) throw new ArcheryError("缺少 workflow_id");
    const result = await this._callJson("GET", "/api/v1/workflow/", {
      params: [
        ["workflow_id", Number(workflowId)],
        ["size", 1],
      ],
    });
    const payload = this._json(result, { action: `获取工单 ${workflowId}`, whitelistHint: true });
    const rows = Array.isArray(payload?.results) ? payload.results : [];
    if (!rows.length) throw new ArcheryError(`工单 ${workflowId} 不存在或无权限查看`);
    const item = rows[0] && typeof rows[0] === "object" ? rows[0] : {};
    const detail = await this._normalizeV1Workflow(item);
    detail.audit_id = null;
    detail.sql_content = item.sql_content || "";
    detail.review = this._parseJsonRows(item.review_content);
    detail.execute_result = this._parseJsonRows(item.execute_result);
    if (includeLogs) detail.logs = await this._getLogsV1(Number(workflowId));
    return detail;
  }

  async _getLogsV1(workflowId) {
    try {
      const result = await this._callJson("POST", "/api/v1/workflow/log/", {
        jsonBody: { workflow_id: workflowId, workflow_type: 2 },
      });
      const payload = this._json(result, { action: "获取工单日志", whitelistHint: true });
      return (Array.isArray(payload?.results) ? payload.results : []).slice(0, 100);
    } catch {
      return [];
    }
  }

  async _getWorkflowV2({ workflowId, auditId, includeLogs }) {
    let targetAuditId = auditId;
    if (!targetAuditId) {
      if (workflowId) targetAuditId = await this._findAuditId(Number(workflowId));
      if (!targetAuditId) throw new ArcheryError("v2 接口需要 audit_id（可由提交工单或工单列表获得）");
    }
    const result = await this._callJson("GET", `/api/v1/sql-workflows/${Number(targetAuditId)}/`);
    const payload = this._json(result, { action: `获取工单 ${targetAuditId}` });
    const detail = payload && typeof payload === "object" ? { ...payload } : {};

    let content = {};
    try {
      const contentResult = await this._callJson(
        "GET",
        `/api/v1/sql-workflows/${Number(targetAuditId)}/content/`,
      );
      content = this._json(contentResult, { action: "获取工单 SQL 内容" }) || {};
    } catch {
      content = {};
    }
    const reviewRows = Array.isArray(content.rows) ? content.rows : [];
    detail.review = reviewRows;
    let sqlContent = detail.sql_content || content.sql_content || "";
    if (!sqlContent && Array.isArray(reviewRows)) {
      sqlContent = reviewRows
        .filter((row) => row && typeof row === "object" && String(row.sql || "").trim())
        .map((row) => String(row.sql).trim())
        .join("\n");
    }
    detail.sql_content = sqlContent;
    detail.audit_id = detail.audit_id ?? targetAuditId;
    if (includeLogs) detail.logs = await this._getLogsV2(Number(targetAuditId));
    return detail;
  }

  async _getLogsV2(auditId) {
    try {
      const result = await this._callJson("GET", `/api/v1/sql-workflows/${Number(auditId)}/logs/`);
      const payload = this._json(result, { action: "获取工单日志" });
      return (Array.isArray(payload?.rows) ? payload.rows : []).slice(0, 100);
    } catch {
      return [];
    }
  }

  async _findAuditId(workflowId) {
    const listing = await this.listWorkflows({ scope: "mine", limit: 100 });
    const found = (listing.items || []).find((item) => Number(item.workflow_id) === Number(workflowId));
    return found ? found.audit_id : null;
  }

  _parseJsonRows(value) {
    if (!value) return [];
    if (Array.isArray(value)) return value.slice(0, 100);
    if (typeof value === "string") {
      try {
        const parsed = JSON.parse(value);
        return Array.isArray(parsed) ? parsed.slice(0, 100) : [];
      } catch {
        return [];
      }
    }
    return [];
  }
}

export { HttpTransportError };
