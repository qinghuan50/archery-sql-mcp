import { ArcheryError } from "./client.mjs";

function schema(properties, required = []) {
  const result = { type: "object", properties, additionalProperties: false };
  if (required.length) result.required = required;
  return result;
}

export const TOOLS = [
  {
    name: "archery_list_instances",
    description:
      "列出当前 Archery 账号可访问的数据库实例（含实例 ID、名称、数据库类型）。查询或提交工单前先用它确认实例名称。",
    inputSchema: schema({
      tag: {
        type: "string",
        enum: ["can_read", "can_write"],
        description: "can_read 查可查询实例；can_write 查可提交工单的实例。",
        default: "can_read",
      },
      search: { type: "string", description: "按实例名模糊过滤（可选）。" },
    }),
  },
  {
    name: "archery_list_databases",
    description: "列出指定实例下当前账号可见的数据库名。",
    inputSchema: schema({ instance: { type: "string", description: "实例名称或实例 ID。" } }, [
      "instance",
    ]),
  },
  {
    name: "archery_describe_table",
    description: "查看指定实例、库、表的字段结构（列名、类型、注释等）。",
    inputSchema: schema(
      {
        instance: { type: "string", description: "实例名称或实例 ID。" },
        database: { type: "string", description: "数据库名。" },
        table: { type: "string", description: "表名。" },
        schema: {
          type: "string",
          description: "schema 名，仅 PostgreSQL/Oracle 等引擎需要。",
        },
      },
      ["instance", "database", "table"],
    ),
  },
  {
    name: "archery_query",
    description:
      "通过 Archery 在生产实例上执行 SQL 查询并返回列名与行数据。默认只允许 SELECT/SHOW/DESCRIBE/EXPLAIN 等只读语句，拒绝写操作、锁语句和文件导出；结果超过行数上限会被截断。",
    inputSchema: schema(
      {
        instance: { type: "string", description: "实例名称或实例 ID。" },
        database: { type: "string", description: "数据库名。" },
        sql: { type: "string", description: "要执行的只读 SQL。" },
        limit: {
          type: "integer",
          description: "最大返回行数，默认取服务端 default_limit，上限受 max_limit 限制。",
          minimum: 1,
        },
        schema: { type: "string", description: "schema 名，仅部分数据库引擎需要。" },
        table: { type: "string", description: "表名，部分引擎执行查询时需要。" },
      },
      ["instance", "database", "sql"],
    ),
  },
  {
    name: "archery_list_groups",
    description: "列出当前账号可提交工单的资源组（group_id 与名称）。",
    inputSchema: schema({}),
  },
  {
    name: "archery_submit_workflow",
    description:
      "提交一条 Archery SQL 上线工单，会真实创建工单并进入审批流；本工具只创建工单，不直接执行 SQL。需要实例的 can_write 权限，workflow_name 最多 50 字。",
    inputSchema: schema(
      {
        instance: { type: "string", description: "实例名称或实例 ID。" },
        database: { type: "string", description: "数据库名。" },
        sql: { type: "string", description: "工单 SQL 内容。" },
        workflow_name: { type: "string", description: "工单名称，最多 50 个字符。", maxLength: 50 },
        group: { type: "string", description: "资源组 ID 或名称；账号只有一个资源组时可省略。" },
        demand_url: { type: "string", description: "需求链接（可选）。" },
        backup: {
          type: "boolean",
          description: "是否备份（默认 true，实际以 Archery 配置为准）。",
          default: true,
        },
        run_date_start: {
          type: "string",
          description: "可执行时间起点（可选，如 2026-01-01 09:00:00）。",
        },
        run_date_end: { type: "string", description: "可执行时间终点（可选）。" },
      },
      ["instance", "database", "sql", "workflow_name"],
    ),
  },
  {
    name: "archery_list_workflows",
    description:
      "列出 SQL 上线工单。scope=mine 查看我有权查看的工单，scope=audit 查看待我审核的工单。返回 workflow_id（v1 详情用）与 audit_id（v2 详情用）。",
    inputSchema: schema({
      scope: {
        type: "string",
        enum: ["mine", "audit"],
        default: "mine",
        description: "mine=工单列表，audit=待审核列表。",
      },
      status: {
        type: "string",
        description:
          "按状态过滤，如 workflow_manreviewing（待审核）、workflow_review_pass（审核通过）、workflow_executing、workflow_finish、workflow_abort。",
      },
      search: { type: "string", description: "按工单名称或提交人模糊搜索。" },
      limit: { type: "integer", description: "返回条数，默认 20，最大 100。", minimum: 1, maximum: 100 },
      offset: { type: "integer", description: "偏移量，默认 0。", minimum: 0 },
    }),
  },
  {
    name: "archery_get_workflow",
    description:
      "查看工单详情：元数据、SQL 内容、自动审核结果和操作日志。v1 平台传 workflow_id，v2 平台传 audit_id；v2 只传 workflow_id 时会尝试在最近工单中查找对应 audit_id。",
    inputSchema: schema({
      workflow_id: { type: "integer", description: "工单 ID（v1 必填）。", minimum: 1 },
      audit_id: { type: "integer", description: "审核流程 ID（v2）。", minimum: 1 },
      include_logs: { type: "boolean", default: true, description: "是否包含操作日志，默认 true。" },
    }),
  },
];

function requireArg(args, key) {
  const value = args[key];
  if (value === undefined || value === null || (typeof value === "string" && !value.trim())) {
    throw new ArcheryError(`缺少必填参数 ${key}`);
  }
  return value;
}

function asInt(value, key) {
  const number = Number(value);
  if (!Number.isInteger(number)) throw new ArcheryError(`参数 ${key} 需要整数，收到: ${JSON.stringify(value)}`);
  return number;
}

async function handleListInstances(client, args) {
  const tag = args.tag || "can_read";
  if (!["can_read", "can_write"].includes(tag)) throw new ArcheryError("tag 只能是 can_read 或 can_write");
  const rows = await client.listInstances(tag, args.search || null);
  return {
    tag,
    count: rows.length,
    instances: rows.map((row) => ({
      id: row.id,
      instance_name: row.instance_name,
      db_type: row.db_type,
    })),
  };
}

async function handleListDatabases(client, args) {
  const instance = requireArg(args, "instance");
  const databases = await client.listDatabases(instance);
  return { instance, count: databases.length, databases };
}

async function handleDescribeTable(client, args) {
  const instance = requireArg(args, "instance");
  const database = requireArg(args, "database");
  const table = requireArg(args, "table");
  const data = await client.describeTable(instance, database, table, args.schema || "");
  return { instance, database, table, definition: data };
}

async function handleQuery(client, args) {
  const instance = requireArg(args, "instance");
  const database = requireArg(args, "database");
  const sql = requireArg(args, "sql");
  const limit = args.limit === undefined || args.limit === null ? null : asInt(args.limit, "limit");
  return client.query(instance, database, sql, {
    limit,
    schema: args.schema || "",
    table: args.table || "",
  });
}

async function handleListGroups(client) {
  const groups = await client.listGroups();
  return { count: groups.length, groups };
}

async function handleSubmitWorkflow(client, args) {
  const instance = requireArg(args, "instance");
  const database = requireArg(args, "database");
  const sql = requireArg(args, "sql");
  const workflowName = requireArg(args, "workflow_name");
  let backup = args.backup ?? true;
  if (typeof backup !== "boolean") backup = ["1", "true", "yes", "on"].includes(String(backup).toLowerCase());
  return client.submitWorkflow({
    instance,
    database,
    sql,
    workflowName: String(workflowName),
    group: args.group ?? null,
    demandUrl: args.demand_url || "",
    backup,
    runDateStart: args.run_date_start || "",
    runDateEnd: args.run_date_end || "",
  });
}

async function handleListWorkflows(client, args) {
  return client.listWorkflows({
    scope: args.scope || "mine",
    status: args.status || "",
    search: args.search || "",
    limit: args.limit === undefined ? 20 : asInt(args.limit, "limit"),
    offset: args.offset === undefined ? 0 : asInt(args.offset, "offset"),
  });
}

async function handleGetWorkflow(client, args) {
  let workflowId = args.workflow_id;
  let auditId = args.audit_id;
  if (workflowId === undefined && auditId === undefined) {
    throw new ArcheryError("请至少提供 workflow_id 或 audit_id 之一");
  }
  if (workflowId !== undefined) workflowId = asInt(workflowId, "workflow_id");
  if (auditId !== undefined) auditId = asInt(auditId, "audit_id");
  let includeLogs = args.include_logs ?? true;
  if (typeof includeLogs !== "boolean") {
    includeLogs = ["1", "true", "yes", "on"].includes(String(includeLogs).toLowerCase());
  }
  return client.getWorkflow({ workflowId, auditId, includeLogs });
}

const HANDLERS = {
  archery_list_instances: handleListInstances,
  archery_list_databases: handleListDatabases,
  archery_describe_table: handleDescribeTable,
  archery_query: handleQuery,
  archery_list_groups: handleListGroups,
  archery_submit_workflow: handleSubmitWorkflow,
  archery_list_workflows: handleListWorkflows,
  archery_get_workflow: handleGetWorkflow,
};

export async function callTool(client, name, args) {
  const handler = HANDLERS[name];
  if (!handler) throw new ArcheryError(`未知工具: ${name}`);
  const result = await handler(client, args || {});
  return JSON.stringify(result, null, 2);
}
