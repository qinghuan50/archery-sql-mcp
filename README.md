# Archery MCP

[![test](https://github.com/qinghuan50/archery-sql-mcp/actions/workflows/test.yml/badge.svg)](https://github.com/qinghuan50/archery-sql-mcp/actions/workflows/test.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-18.3%2B-339933?logo=node.js&logoColor=white)](https://nodejs.org)

把开源 SQL 审核平台 [Archery](https://github.com/hhyo/Archery) 的日常操作封装成
[MCP](https://modelcontextprotocol.io) 服务：**账号密码登录 → 查实例/库/表 → 执行只读 SQL →
提交 SQL 上线工单 → 查看工单与审核结果**。

**Node.js 实现，零第三方依赖**，不需要 Python。任何支持 MCP stdio 的客户端都可以接入，
例如 Claude Desktop、Cursor、DeepSeek Harness 以及自研 Agent。项目不修改 Archery，
只调用它现有的 HTTP 接口。

---

## 功能

| 能力 | 说明 |
| --- | --- |
| 登录 | 用户名密码自动登录，处理 Django CSRF 与 session；支持复用浏览器 Cookie（2FA / SSO 场景） |
| 实例与结构 | 列出有权限的实例、数据库、表结构 |
| SQL 查询 | 默认只读白名单（SELECT / SHOW / DESCRIBE / EXPLAIN），拦截写操作、锁语句、文件导出、`/*! */` 版本注释；限制并截断返回行数 |
| 工单提交 | 真实创建 Archery SQL 上线工单（进入审批流，不直接执行 SQL） |
| 工单查看 | 我的工单 / 待我审核工单、工单详情、SQL 内容、自动审核结果、操作日志 |
| 版本兼容 | Archery 1.x（最新 release v1.14 的 REST + 页面接口）与 master（2.x 开发版 REST API）自动探测 |

> **Archery 1.14 注意**：`/api/v1/workflow*` 工单接口受 `API_USER_WHITELIST` 限制。
> 使用 `archery_submit_workflow`、`archery_list_workflows`、`archery_get_workflow` 前，
> 请让管理员在 **系统设置 → API_USER_WHITELIST** 中加入该账号，否则会返回 403。
> 查询、实例、库表接口不受此限制。

### 明确不做的事

- 不直接执行工单（不会自动 approve / execute / 上线），避免 Agent 误操作生产库；
- 不绕过 Archery 自身的权限、查询审核、脱敏与工单流程；
- 不内置任何账号、密码或公司地址，全部由本地配置提供。

---

## 快速开始

要求：**Node.js 18.3+**，无需 `npm install`，无第三方依赖。

```bash
cd archery-mcp
# 复制并编辑配置
cp config.example.json config.json      # Windows: copy config.example.json config.json

node bin/archery-mcp.mjs --config config.json --check
```

`--check` 会实际登录一次并输出版本类型、可访问实例数量：

```json
{
  "ok": true,
  "settings": {
    "base_url": "https://archery.example.com",
    "username": "agent-bot",
    "api_flavor": "auto",
    "auth_mode": "password"
  },
  "flavor": "v1",
  "instance_count": 12,
  "instances": [
    { "id": 1, "instance_name": "prod-mysql", "db_type": "mysql" }
  ]
}
```

检查通过后，启动 MCP 服务（stdio，由客户端拉起，一般不需要手动运行）：

```bash
node bin/archery-mcp.mjs --config config.json
```

---

## 本地测试（不连真实数据库）

项目自带 mock Archery（`test/mock-archery.mjs`），可以验证登录、查询、工单与 MCP 协议，
不会碰生产库。

```bash
node --test test/client.test.mjs test/mcp.test.mjs
# 或
npm test
```

当前 **15 个测试**全部通过，覆盖：

- 账号密码登录、CSRF、会话复用、错误密码；
- v1 查询参数、行数限制与结果截断；
- 只读校验（写语句、多语句、`FOR UPDATE`、`OUTFILE`、`/*! */`、`LOAD_FILE`）；
- v1/v2 提交工单、列表、详情、审核结果与日志；
- v1 工单接口 403 时的 `API_USER_WHITELIST` 提示；
- Session Cookie 模式；
- MCP stdio 协议：`initialize`、`tools/list`、`tools/call` 成功与错误路径；
- `--check` 自检命令。

另外已在真实 Archery 1.x 环境验证：登录、24 个实例、库/表列表、表结构、`SELECT 1` / `SHOW` 查询、
工单列表（2.6 万条）与工单详情。**真实工单提交没有执行**，避免产生审批单；表级 `SELECT`
是否可用取决于 Archery 查询权限配置。

---

## 接入 MCP 客户端

### 通用 JSON 配置（Claude Desktop / Cursor 等）

```json
{
  "mcpServers": {
    "archery": {
      "command": "node",
      "args": [
        "C:\\path\\to\\archery-mcp\\bin\\archery-mcp.mjs",
        "--config",
        "C:\\path\\to\\archery-mcp\\config.json"
      ]
    }
  }
}
```

把 `command` 换成真实 Node 可执行文件路径（Windows 上不建议依赖 Microsoft Store 的别名），
`args` 指向本项目。

### DeepSeek Harness（DSH）

仓库内的 `dsh-bundle/` 是一个只做 MCP 连接的 DSH bundle，安装后会在插件列表中出现
“Archery 数据库工单”连接，并把 8 个 `archery_*` 工具注册为 `mcp__archery__*`。
安装前先把 `dsh-bundle/cordis.patch.yml` 中的 Node 路径、脚本路径、配置文件路径改成自己的，然后：

```text
plugin_manager(action="install_bundle", target="C:\\path\\to\\archery-mcp\\dsh-bundle")
```

修改 `config.json` 后需要重启 DSH（或重新加载该 MCP 连接），因为配置在进程启动时读取。

> 安装 bundle 会写入当前 DSH profile，并影响该 profile 下的所有会话；请确认路径后再安装。

### 环境变量方式（不写配置文件）

```bash
export ARCHERY_BASE_URL="https://archery.example.com"
export ARCHERY_USERNAME="agent-bot"
export ARCHERY_PASSWORD="******"
node bin/archery-mcp.mjs
```

PowerShell：

```powershell
$env:ARCHERY_BASE_URL = "https://archery.example.com"
$env:ARCHERY_USERNAME = "agent-bot"
$env:ARCHERY_PASSWORD = "******"
node bin/archery-mcp.mjs
```

环境变量优先级高于配置文件。

---

## 配置项

| 配置键 | 环境变量 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `base_url` | `ARCHERY_BASE_URL` | 必填 | Archery 站点地址，如 `https://archery.example.com` |
| `username` | `ARCHERY_USERNAME` | 空 | 登录账号 |
| `password` | `ARCHERY_PASSWORD` | 空 | 登录密码 |
| `session_cookie` | `ARCHERY_SESSION_COOKIE` | 空 | 浏览器中的 `sessionid`，配置后跳过账号密码登录 |
| `csrf_cookie` | `ARCHERY_CSRF_COOKIE` | 空 | 浏览器中的 `csrftoken`，与 `session_cookie` 搭配 |
| `verify_tls` | `ARCHERY_VERIFY_TLS` | `true` | 是否校验 HTTPS 证书；仅内网自签证书时设为 `false` |
| `timeout` | `ARCHERY_TIMEOUT` | `30` | HTTP 超时秒数 |
| `api_flavor` | `ARCHERY_API_FLAVOR` | `auto` | `auto` / `v1` / `v2`；自动探测失败时手动指定 |
| `default_limit` | `ARCHERY_DEFAULT_LIMIT` | `100` | 查询默认行数 |
| `max_limit` | `ARCHERY_MAX_LIMIT` | `5000` | 查询行数硬上限 |
| `max_rows` | `ARCHERY_MAX_ROWS` | `200` | 返回给模型的预览行数，超出截断并标记 |
| `allow_write_sql` | `ARCHERY_ALLOW_WRITE_SQL` | `false` | 是否允许查询工具执行非只读 SQL；**强烈不建议开启** |

配置文件路径用 `--config` 或 `ARCHERY_MCP_CONFIG` 指定。

---

## 工具列表

| 工具 | 用途 | 关键参数 |
| --- | --- | --- |
| `archery_list_instances` | 列出可访问实例 | `tag`=`can_read`/`can_write`，`search` |
| `archery_list_databases` | 列出实例下数据库 | `instance` |
| `archery_describe_table` | 查看表结构 | `instance`、`database`、`table`、`schema` |
| `archery_query` | 执行只读 SQL | `instance`、`database`、`sql`、`limit` |
| `archery_list_groups` | 列出可提交的资源组 | — |
| `archery_submit_workflow` | 创建 SQL 上线工单 | `instance`、`database`、`sql`、`workflow_name`、`group`、`backup` 等 |
| `archery_list_workflows` | 工单列表 / 待审列表 | `scope`=`mine`/`audit`、`status`、`search`、`limit`、`offset` |
| `archery_get_workflow` | 工单详情、SQL、审核结果、日志 | `workflow_id`（v1）或 `audit_id`（v2）、`include_logs` |

### 返回示例

查询：

```json
{
  "instance": "prod-mysql",
  "database": "app_db",
  "statement_count": 1,
  "limit": 100,
  "columns": ["id", "name"],
  "row_count": 2,
  "total_rows": 2,
  "truncated": false,
  "query_time": "0.012",
  "is_masked": false,
  "rows": [
    { "id": 1, "name": "alice" },
    { "id": 2, "name": "bob" }
  ]
}
```

提交工单：

```json
{
  "workflow_id": 1234,
  "audit_id": 5678,
  "workflow_name": "增加 age 字段",
  "instance": "prod-mysql",
  "database": "app_db",
  "group_id": 10,
  "group_name": "DBA组",
  "status": "workflow_manreviewing",
  "message": "提交成功"
}
```

---

## 使用示例

```text
帮我查一下 prod-mysql 的 app_db，users 表最近注册的 20 个用户，只看 id、name、created_at。

把下面这条 SQL 提交成 DBA组 的工单，名称“订单表增加索引”：
ALTER TABLE orders ADD INDEX idx_user_id (user_id);

看看我待审核的工单，以及每条工单的自动审核结果。
```

模型会先调用 `archery_list_instances` / `archery_list_databases` 确认目标，再执行查询或提交。

---

## Archery 接口适配

不同版本的 Archery 接口不同，客户端会自动探测，也可以手动指定：

| 操作 | Archery 1.x（v1.14） | Archery master（2.x 开发版） |
| --- | --- | --- |
| 登录 | `GET /login/` + `POST /authenticate/` | 同左 |
| 实例列表 | `GET /group/user_all_instances/` | `GET /api/v1/sqlquery/instances/` |
| 数据库/表 | `GET /instance/instance_resource/`、`POST /instance/describetable/` | `GET /api/v1/sqlquery/resources/`、`POST /api/v1/sqlquery/describetable/` |
| 查询 | `POST /query/`（表单） | `POST /api/v1/sqlquery/execute/`（JSON） |
| 提交工单 | `POST /api/v1/workflow/` | `POST /api/v1/sql-workflows/` |
| 工单列表 | `GET /api/v1/workflow/` / `POST /api/v1/workflow/auditlist/` | `POST /api/v1/sql-workflows/list/` / `audit-list/` |
| 工单详情 | `GET /api/v1/workflow/?workflow_id=` + `POST /api/v1/workflow/log/` | `GET /api/v1/sql-workflows/<audit_id>/` + `/content/` + `/logs/` |

如果贵司的 Archery 版本与以上不同，优先设置 `api_flavor`；仍不兼容时，只需修改
`src/client.mjs` 中对应的路径与参数。

### 2FA / SSO / CAS

启用了二次验证或统一登录时，账号密码登录不会直接得到会话。处理方式：

1. 浏览器正常登录 Archery；
2. 开发者工具 → Application → Cookies → 复制 `sessionid`（以及 `csrftoken`）；
3. 写入配置：

```json
{
  "base_url": "https://archery.example.com",
  "session_cookie": "xxxxxxxx",
  "csrf_cookie": "yyyyyyyy",
  "verify_tls": true
}
```

Cookie 会过期，适合本地临时使用；长期运行建议为 Agent 申请独立的只读/工单账号并关闭该账号 2FA，
或通过企业 SSO 网关提供固定会话。

---

## 安全说明

- **最小权限**：给 Agent 单独建 Archery 账号，只授予需要的实例 `can_read` / `can_write` 标签和资源组；
  查询与工单权限仍由 Archery 控制。
- **只读优先**：查询工具默认拒绝写语句；`allow_write_sql` 仅用于特殊场景，开启后仍受 Archery 账号权限约束。
- **写操作**：`archery_submit_workflow` 会真实创建工单并通知审批人；调用前确认实例、库、工单名与 SQL。
- **数据外泄**：查询结果会进入模型上下文。生产库敏感字段请依赖 Archery 的数据脱敏配置，或限制返回列。
- **凭证保管**：优先用环境变量或仅本人可读的配置文件；不要把 `config.json`、Cookie 提交到 Git。
- **TLS**：默认校验证书；关闭校验只应在受控内网使用。
- **审计**：Archery 会记录查询日志与工单操作日志；MCP 服务自身只向 stderr 输出工具名与错误，不打印密码和 SQL。

SQL 只读校验是**额外护栏，不是安全边界**；真正的权限边界是 Archery 账号和数据库账号。

---

## 目录结构

```text
archery-mcp/
├── bin/archery-mcp.mjs   # CLI 入口
├── src/
│   ├── config.mjs        # JSON + 环境变量配置
│   ├── http.mjs          # 标准库 HTTP 客户端（Cookie/CSRF/gzip/TLS/重定向）
│   ├── client.mjs        # Archery v1/v2 接口封装
│   ├── sqlguard.mjs      # 只读 SQL 校验与语句拆分
│   ├── tools.mjs         # 8 个 MCP 工具定义与处理
│   ├── mcp.mjs           # MCP stdio JSON-RPC 服务
│   └── cli.mjs           # 命令行入口
├── test/
│   ├── mock-archery.mjs  # 本地模拟 Archery
│   ├── client.test.mjs
│   └── mcp.test.mjs
├── dsh-bundle/           # 可选的 DSH MCP 连接 bundle
├── config.example.json
└── package.json
```

## 后续可扩展

- 审批 / 执行工单工具（默认不开放，建议加二次确认与独立开关）；
- Streamable HTTP 传输与多租户（按请求切换账号）；
- 与 Archery 的 Swagger（`/api/schema/`）自动生成工具，减少版本适配成本。
