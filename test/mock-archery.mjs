import http from "node:http";
import { URL } from "node:url";

export const CSRF_TOKEN = "csrf-test-token";
export const SESSION_ID = "good-session";
export const USERNAME = "admin";
export const PASSWORD = "secret";

const INSTANCES = [
  { id: 1, instance_name: "prod-mysql", db_type: "mysql", type: "master" },
  { id: 2, instance_name: "test-mysql", db_type: "mysql", type: "master" },
];
const GROUPS = [{ group_id: 10, group_name: "DBA组" }];
const DATABASES = ["app_db", "log_db"];

function parseCookies(header) {
  const cookies = {};
  for (const part of String(header || "").split(";")) {
    if (!part.includes("=")) continue;
    const index = part.indexOf("=");
    cookies[part.slice(0, index).trim()] = part.slice(index + 1).trim();
  }
  return cookies;
}

function parseForm(body) {
  return Object.fromEntries(new URLSearchParams(body));
}

function parseJson(body) {
  if (!body) return {};
  try {
    const parsed = JSON.parse(body);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export class MockArchery {
  constructor(flavor = "v1") {
    this.state = {
      flavor,
      requests: [],
      workflows: [],
      nextWorkflowId: 100,
      nextAuditId: 900,
      denyWorkflowApi: false,
    };
    this.server = http.createServer((request, response) => {
      this.handle(request, response).catch((error) => {
        response.statusCode = 500;
        response.end(JSON.stringify({ detail: String(error) }));
      });
    });
  }

  async start() {
    await new Promise((resolve) => this.server.listen(0, "127.0.0.1", resolve));
    const address = this.server.address();
    this.baseUrl = `http://127.0.0.1:${address.port}`;
    return this;
  }

  async stop() {
    this.server.closeAllConnections?.();
    await new Promise((resolve) => this.server.close(resolve));
  }

  record(method, path, query, body) {
    this.state.requests.push({ method, path, query, body });
  }

  count(method, path) {
    return this.state.requests.filter((item) => item.method === method && item.path === path).length;
  }

  last(method, path) {
    for (let index = this.state.requests.length - 1; index >= 0; index -= 1) {
      const item = this.state.requests[index];
      if (item.method === method && item.path === path) return item;
    }
    return null;
  }

  async handle(request, response) {
    const url = new URL(request.url, this.baseUrl);
    const path = url.pathname;
    const query = Object.fromEntries(url.searchParams);
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString("utf8");
    this.record(request.method, path, query, body);

    const cookies = parseCookies(request.headers.cookie);
    const send = (status, payload, headers = {}) => {
      const text = typeof payload === "string" ? payload : JSON.stringify(payload);
      response.writeHead(status, {
        "Content-Type": typeof payload === "string" ? "text/html; charset=utf-8" : "application/json; charset=utf-8",
        "Content-Length": Buffer.byteLength(text),
        ...headers,
      });
      response.end(text);
    };
    const sendJson = (payload, status = 200, headers = {}) => send(status, payload, headers);
    const sendHtml = (html, status = 200, headers = {}) => send(status, html, headers);

    if (path === "/login/" && request.method === "GET") {
      const headers = {};
      if (cookies.csrftoken !== CSRF_TOKEN) headers["Set-Cookie"] = `csrftoken=${CSRF_TOKEN}; Path=/`;
      return sendHtml(
        `<html><body><form method="post" action="/authenticate/">` +
          `<input type="hidden" name="csrfmiddlewaretoken" value="${CSRF_TOKEN}">` +
          `<input name="username"><input name="password"></form></body></html>`,
        200,
        headers,
      );
    }

    if (path === "/authenticate/" && request.method === "POST") {
      if (request.headers["x-csrftoken"] !== cookies.csrftoken) {
        return sendJson({ detail: "CSRF Failed" }, 403);
      }
      const form = parseForm(body);
      if (form.csrfmiddlewaretoken !== cookies.csrftoken) {
        return sendJson({ detail: "CSRF Failed" }, 403);
      }
      if (form.username === USERNAME && form.password === PASSWORD) {
        return sendJson(
          { status: 0, msg: "ok", data: null },
          200,
          { "Set-Cookie": `sessionid=${SESSION_ID}; Path=/; HttpOnly` },
        );
      }
      return sendJson({ status: 1, msg: "用户名或密码错误，请重新输入！", data: "" });
    }

    if (cookies.sessionid !== SESSION_ID) {
      if (String(request.headers.accept || "").includes("text/html")) {
        return sendHtml("<html><body>请登录 login</body></html>", 302, { Location: "/login/" });
      }
      return sendJson({ detail: "身份认证信息未提供。" }, 403);
    }

    if (request.method === "POST" && request.headers["x-csrftoken"] !== cookies.csrftoken) {
      return sendJson({ detail: "CSRF Failed: CSRF token missing or incorrect." }, 403);
    }

    if (request.method === "GET") return this.handleGet(path, query, sendJson, sendHtml);
    return this.handlePost(path, query, body, sendJson);
  }

  handleGet(path, query, sendJson, sendHtml) {
    if (path === "/submitsql/") {
      const options = GROUPS.map(
        (group) => `<option value='${group.group_name}' group-id='${group.group_id}'>${group.group_name}</option>`,
      ).join("");
      return sendHtml(`<html><select id="group_name">${options}</select></html>`);
    }
    if (path === "/group/user_all_instances/") {
      if (this.state.flavor === "v2") return sendJson({ detail: "Not found." }, 404);
      return sendJson({ status: 0, msg: "ok", data: INSTANCES });
    }
    if (path === "/instance/instance_resource/") {
      if (this.state.flavor === "v2") return sendJson({ detail: "Not found." }, 404);
      return sendJson({ status: 0, msg: "ok", data: DATABASES });
    }
    if (path === "/api/v1/user/resourcegroup/") {
      return sendJson({ count: GROUPS.length, next: null, previous: null, results: GROUPS });
    }
    if (path === "/api/v1/sqlquery/instances/") {
      if (this.state.flavor !== "v2") return sendJson({ detail: "Not found." }, 404);
      return sendJson({ status: 0, msg: "ok", data: INSTANCES });
    }
    if (path === "/api/v1/sqlquery/resources/") {
      if (this.state.flavor !== "v2") return sendJson({ detail: "Not found." }, 404);
      return sendJson({ status: 0, msg: "ok", data: DATABASES });
    }
    if (path === "/api/v1/workflow/") {
      if (this.state.flavor === "v2") return sendJson({ detail: "Not found." }, 404);
      return this.v1WorkflowList(query, sendJson);
    }
    if (path.startsWith("/api/v1/sql-workflows/")) {
      return this.v2WorkflowGet(path, sendJson);
    }
    return sendJson({ detail: "Not found." }, 404);
  }

  handlePost(path, query, body, sendJson) {
    if (path === "/query/") {
      if (this.state.flavor === "v2") return sendJson({ detail: "Not found." }, 404);
      return this.query(parseForm(body), sendJson);
    }
    if (path === "/api/v1/sqlquery/execute/") {
      if (this.state.flavor !== "v2") return sendJson({ detail: "Not found." }, 404);
      return this.query(parseJson(body), sendJson);
    }
    if (path === "/instance/describetable/") {
      return sendJson({
        status: 0,
        msg: "ok",
        data: [{ Field: "id", Type: "int", Null: "NO" }],
      });
    }
    if (path === "/api/v1/sqlquery/describetable/") {
      if (this.state.flavor !== "v2") return sendJson({ detail: "Not found." }, 404);
      return sendJson({
        status: 0,
        msg: "ok",
        data: [{ Field: "id", Type: "int", Null: "NO" }],
      });
    }
    if (path === "/api/v1/workflow/") {
      if (this.state.denyWorkflowApi) {
        return sendJson({ detail: "您没有访问该 API 的权限。" }, 403);
      }
      if (this.state.flavor === "v2") return sendJson({ detail: "Not found." }, 404);
      const workflow = this.createWorkflow(parseJson(body));
      return sendJson(workflow.content, 201);
    }
    if (path === "/api/v1/workflow/log/") {
      const workflow = this.findByWorkflowId(parseJson(body).workflow_id);
      if (!workflow) return sendJson({ detail: "不存在该工单" }, 400);
      return sendJson({ count: 1, results: [workflow.log] });
    }
    if (path === "/api/v1/workflow/auditlist/") {
      const rows = this.state.workflows.map((workflow) => ({
        audit_id: workflow.audit_id,
        workflow_id: workflow.workflow_id,
        workflow_title: workflow.name,
        group_name: "DBA组",
        current_status: 0,
        current_status_display: "待审核",
        create_time: "2026-10-28T10:00:00",
      }));
      return sendJson({ count: rows.length, results: rows });
    }
    if (path === "/api/v1/sql-workflows/") {
      if (this.state.flavor !== "v2") return sendJson({ detail: "Not found." }, 404);
      const workflow = this.createWorkflow(parseJson(body));
      return sendJson(
        {
          status: 0,
          msg: "提交成功",
          data: {
            audit_id: workflow.audit_id,
            workflow_id: workflow.workflow_id,
            redirect_url: `/detail/${workflow.workflow_id}/`,
          },
        },
        201,
      );
    }
    if (path === "/api/v1/sql-workflows/list/" || path === "/api/v1/sql-workflows/audit-list/") {
      if (this.state.flavor !== "v2") return sendJson({ detail: "Not found." }, 404);
      const rows = this.state.workflows.map((workflow) => ({
        id: workflow.workflow_id,
        workflow_id: workflow.workflow_id,
        audit_id: workflow.audit_id,
        workflow_name: workflow.name,
        engineer_display: "管理员",
        status: "workflow_manreviewing",
        create_time: "2026-10-28T10:00:00",
        instance__instance_name: "prod-mysql",
        db_name: workflow.db_name,
        group_name: "DBA组",
        syntax_type: 2,
        is_backup: true,
      }));
      return sendJson({ total: rows.length, rows });
    }
    return sendJson({ detail: "Not found." }, 404);
  }

  query(payload, sendJson) {
    const sql = Array.isArray(payload.sql_content) ? payload.sql_content[0] : payload.sql_content;
    return sendJson({
      status: 0,
      msg: "ok",
      sql,
      data: {
        column_list: ["id", "name"],
        rows: [
          [1, "alice"],
          [2, "bob"],
        ],
        column_type: ["int", "varchar"],
        affected_rows: 2,
        query_time: "0.012",
        error: null,
        is_masked: false,
        mask_rule_hit: false,
        seconds_behind_master: 0,
      },
    });
  }

  createWorkflow(payload) {
    const data = payload.workflow || {};
    const sqlContent = payload.sql_content || "";
    const workflowId = this.state.nextWorkflowId;
    const auditId = this.state.nextAuditId;
    this.state.nextWorkflowId += 1;
    this.state.nextAuditId += 1;

    const review = [
      {
        id: 0,
        stage: "CHECKED",
        errlevel: 0,
        stagestatus: "Audit completed",
        errormessage: "",
        sql: sqlContent,
        affected_rows: 1,
        sequence: "0_0_0",
        backup_dbname: "",
        execute_time: "",
        sqlsha1: "",
      },
    ];
    const content = {
      id: workflowId,
      workflow_id: workflowId,
      workflow: {
        id: workflowId,
        workflow_name: data.workflow_name || "",
        demand_url: data.demand_url || "",
        group_id: data.group_id,
        group_name: "DBA组",
        instance: data.instance,
        db_name: data.db_name || "",
        syntax_type: 2,
        is_backup: data.is_backup ?? true,
        engineer: USERNAME,
        engineer_display: "管理员",
        status: "workflow_manreviewing",
        audit_auth_groups: "",
        run_date_start: null,
        run_date_end: null,
        create_time: "2026-10-28T10:00:00",
        finish_time: null,
        is_manual: 0,
        is_offline_export: 0,
        export_format: null,
        file_name: null,
      },
      sql_content: sqlContent,
      review_content: JSON.stringify(review),
      execute_result: "",
    };
    const detail = {
      audit_id: auditId,
      workflow_id: workflowId,
      id: workflowId,
      workflow_name: data.workflow_name || "",
      group_id: data.group_id,
      group_name: "DBA组",
      instance: data.instance,
      instance_name: "prod-mysql",
      db_name: data.db_name || "",
      syntax_type: 2,
      is_backup: true,
      engineer: USERNAME,
      engineer_display: "管理员",
      status: "workflow_manreviewing",
      status_display: "待审核",
      create_time: "2026-10-28T10:00:00",
    };
    const record = {
      workflow_id: workflowId,
      audit_id: auditId,
      name: data.workflow_name || "",
      db_name: data.db_name || "",
      content,
      detail,
      review,
      log: {
        operation_type_desc: "提交工单",
        operation_info: "提交SQL上线工单",
        operator_display: "管理员",
        operation_time: "2026-10-28T10:00:00",
      },
    };
    this.state.workflows.push(record);
    return record;
  }

  v1WorkflowList(query, sendJson) {
    let workflows = [...this.state.workflows];
    if (query.workflow_id) {
      workflows = workflows.filter((item) => String(item.workflow_id) === String(query.workflow_id));
    }
    const size = Number(query.size || 20) || 20;
    const page = Number(query.page || 1) || 1;
    const start = Math.max(0, (page - 1) * size);
    return sendJson({
      count: workflows.length,
      next: null,
      previous: null,
      results: workflows.slice(start, start + size).map((item) => item.content),
    });
  }

  v2WorkflowGet(path, sendJson) {
    if (this.state.flavor !== "v2") return sendJson({ detail: "Not found." }, 404);
    const parts = path.split("/").filter(Boolean);
    if (parts.length < 4) return sendJson({ detail: "Not found." }, 404);
    const auditId = Number(parts[3]);
    const workflow = this.state.workflows.find((item) => item.audit_id === auditId);
    if (!workflow) return sendJson({ detail: "工单不存在" }, 404);
    const suffix = parts[4] || "";
    if (suffix === "content") return sendJson({ rows: workflow.review });
    if (suffix === "logs") return sendJson({ total: 1, rows: [workflow.log] });
    return sendJson(workflow.detail);
  }

  findByWorkflowId(workflowId) {
    return this.state.workflows.find((item) => String(item.workflow_id) === String(workflowId));
  }
}
