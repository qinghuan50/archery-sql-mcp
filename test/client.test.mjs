import assert from "node:assert/strict";
import test from "node:test";

import { ArcheryClient, ArcheryError } from "../src/client.mjs";
import { UnsafeSQLError } from "../src/sqlguard.mjs";
import { MockArchery } from "./mock-archery.mjs";

function makeSettings(mock, overrides = {}) {
  return {
    base_url: mock.baseUrl,
    username: "admin",
    password: "secret",
    session_cookie: "",
    csrf_cookie: "",
    verify_tls: true,
    timeout: 15,
    api_flavor: "auto",
    default_limit: 100,
    max_limit: 5000,
    max_rows: 200,
    allow_write_sql: false,
    ...overrides,
  };
}

async function withMock(flavor, callback) {
  const mock = await new MockArchery(flavor).start();
  try {
    await callback(mock);
  } finally {
    await mock.stop();
  }
}

test("v1 登录、查询与会话复用", async () => {
  await withMock("v1", async (mock) => {
    const client = new ArcheryClient(makeSettings(mock));
    const result = await client.query("prod-mysql", "app_db", "select id, name from users", {
      limit: 50,
    });
    assert.deepEqual(result.columns, ["id", "name"]);
    assert.equal(result.row_count, 2);
    assert.deepEqual(result.rows[0], { id: 1, name: "alice" });

    const request = mock.last("POST", "/query/");
    const form = new URLSearchParams(request.body);
    assert.equal(form.get("limit_num"), "50");
    assert.equal(form.get("db_name"), "app_db");

    await client.listInstances();
    assert.equal(mock.count("POST", "/authenticate/"), 1);
  });
});

test("登录失败返回明确错误", async () => {
  await withMock("v1", async (mock) => {
    const client = new ArcheryClient(makeSettings(mock, { password: "wrong" }));
    await assert.rejects(client.query("prod-mysql", "app_db", "select 1"), /用户名或密码错误/);
  });
});

test("只读校验在请求前拦截", async () => {
  await withMock("v1", async (mock) => {
    const client = new ArcheryClient(makeSettings(mock));
    const cases = [
      "delete from users",
      "update users set name='x'",
      "select 1; drop table users",
      "select * from users for update",
      "select * into outfile '/tmp/x' from users",
      "with x as (select 1) delete from users",
      "select 1 /*!50000 ; drop table users */",
      "select load_file('/etc/passwd')",
    ];
    for (const sql of cases) {
      await assert.rejects(client.query("prod-mysql", "app_db", sql), UnsafeSQLError);
    }
    assert.equal(mock.count("POST", "/query/"), 0);
  });
});

test("allow_write_sql 可选放开", async () => {
  await withMock("v1", async (mock) => {
    const client = new ArcheryClient(makeSettings(mock, { allow_write_sql: true }));
    await client.query("prod-mysql", "app_db", "update users set name='x'");
    assert.equal(mock.count("POST", "/query/"), 1);
  });
});

test("limit 被上限截断", async () => {
  await withMock("v1", async (mock) => {
    const client = new ArcheryClient(makeSettings(mock));
    const result = await client.query("prod-mysql", "app_db", "select * from users", {
      limit: 99999,
    });
    assert.equal(result.limit, 5000);
    const form = new URLSearchParams(mock.last("POST", "/query/").body);
    assert.equal(form.get("limit_num"), "5000");
  });
});

test("实例、数据库、表结构", async () => {
  await withMock("v1", async (mock) => {
    const client = new ArcheryClient(makeSettings(mock));
    const instances = await client.listInstances();
    assert.equal(instances[0].instance_name, "prod-mysql");
    assert.deepEqual(await client.listDatabases("prod-mysql"), ["app_db", "log_db"]);
    const schema = await client.describeTable("prod-mysql", "app_db", "users");
    assert.equal(schema[0].Field, "id");
  });
});

test("提交工单、列表与详情", async () => {
  await withMock("v1", async (mock) => {
    const client = new ArcheryClient(makeSettings(mock));
    const submitted = await client.submitWorkflow({
      instance: "prod-mysql",
      database: "app_db",
      sql: "alter table users add column age int",
      workflowName: "增加 age 字段",
      backup: false,
    });
    assert.equal(submitted.workflow_id, 100);
    assert.equal(submitted.status, "workflow_manreviewing");
    assert.equal(submitted.review[0].stage, "CHECKED");

    const body = JSON.parse(mock.last("POST", "/api/v1/workflow/").body);
    assert.equal(body.workflow.group_id, 10);
    assert.equal(body.workflow.instance, 1);
    assert.equal(body.workflow.db_name, "app_db");
    assert.equal(body.workflow.is_backup, false);

    const listing = await client.listWorkflows({ scope: "mine", limit: 10 });
    assert.equal(listing.total, 1);
    assert.equal(listing.items[0].workflow_id, 100);
    assert.equal(listing.items[0].instance, "prod-mysql");

    const detail = await client.getWorkflow({ workflowId: 100, includeLogs: true });
    assert.equal(detail.workflow_name, "增加 age 字段");
    assert.ok(detail.sql_content.includes("alter table"));
    assert.equal(detail.review[0].sql, "alter table users add column age int");
    assert.equal(detail.logs.length, 1);

    const audits = await client.listWorkflows({ scope: "audit" });
    assert.equal(audits.items[0].audit_id, 900);
  });
});

test("资源组从提交页解析", async () => {
  await withMock("v1", async (mock) => {
    const client = new ArcheryClient(makeSettings(mock));
    assert.deepEqual(await client.listGroups(), [{ group_id: 10, group_name: "DBA组" }]);
  });
});

test("Session Cookie 模式", async () => {
  await withMock("v1", async (mock) => {
    const client = new ArcheryClient(
      makeSettings(mock, {
        username: "",
        password: "",
        session_cookie: "good-session",
        csrf_cookie: "csrf-test-token",
      }),
    );
    const result = await client.query("prod-mysql", "app_db", "select 1");
    assert.equal(result.row_count, 2);
    assert.equal(mock.count("POST", "/authenticate/"), 0);
  });
});

test("v1 工单接口 403 时提示 API_USER_WHITELIST", async () => {
  await withMock("v1", async (mock) => {
    mock.state.denyWorkflowApi = true;
    const client = new ArcheryClient(makeSettings(mock));
    await assert.rejects(
      client.submitWorkflow({
        instance: "prod-mysql",
        database: "app_db",
        sql: "create table t (id int)",
        workflowName: "建表",
      }),
      (error) => error instanceof ArcheryError && /API_USER_WHITELIST/.test(error.message),
    );
  });
});

test("v2 查询、工单与详情", async () => {
  await withMock("v2", async (mock) => {
    const client = new ArcheryClient(makeSettings(mock, { api_flavor: "v2" }));
    assert.equal(await client.detectFlavor(), "v2");

    const result = await client.query("prod-mysql", "app_db", "select 1", { limit: 7 });
    assert.equal(result.row_count, 2);
    const body = JSON.parse(mock.last("POST", "/api/v1/sqlquery/execute/").body);
    assert.equal(body.limit_num, 7);

    const submitted = await client.submitWorkflow({
      instance: "prod-mysql",
      database: "app_db",
      sql: "create table t (id int)",
      workflowName: "建表",
    });
    assert.equal(submitted.workflow_id, 100);
    assert.equal(submitted.audit_id, 900);

    const listing = await client.listWorkflows({ limit: 10 });
    assert.equal(listing.items[0].audit_id, 900);
    assert.equal(listing.items[0].instance, "prod-mysql");

    const detail = await client.getWorkflow({ auditId: 900 });
    assert.equal(detail.workflow_name, "建表");
    assert.ok(detail.sql_content.includes("create table"));
    assert.equal(detail.logs.length, 1);
  });
});
