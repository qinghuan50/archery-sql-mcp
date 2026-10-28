# Archery MCP

**English** | [简体中文](README.zh-CN.md)

[![test](https://github.com/qinghuan50/archery-sql-mcp/actions/workflows/test.yml/badge.svg)](https://github.com/qinghuan50/archery-sql-mcp/actions/workflows/test.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-18.3%2B-339933?logo=node.js&logoColor=white)](https://nodejs.org)

Wrap the everyday operations of the open-source SQL audit platform
[Archery](https://github.com/hhyo/Archery) into an [MCP](https://modelcontextprotocol.io) server:
**password login → browse instances / databases / tables → run read-only SQL →
submit SQL release tickets → inspect tickets and audit results**.

**Pure Node.js, zero third-party dependencies** — no Python required. Works with any MCP stdio
client, such as Claude Desktop, Cursor, DeepSeek Harness or your own agent. The project does not
modify Archery; it only calls Archery's existing HTTP APIs.

---

## Features

| Capability | Description |
| --- | --- |
| Login | username/password login with Django CSRF and session handling; can reuse browser cookies for 2FA / SSO setups |
| Instances & schema | list the instances you can access, plus databases and table schemas |
| SQL queries | read-only whitelist by default (SELECT / SHOW / DESCRIBE / EXPLAIN); blocks writes, lock reads, file export and `/*! */` version comments; caps and truncates returned rows |
| Ticket submission | creates real Archery SQL release tickets (enters the approval flow; never executes SQL directly) |
| Ticket inspection | my tickets / tickets awaiting my review, details, SQL, automated audit results and operation logs |
| Version support | auto-detects Archery 1.x (latest release v1.14: REST + page endpoints) and master (2.x dev: REST API) |

> **Archery 1.14 note**: the `/api/v1/workflow*` endpoints are gated by `API_USER_WHITELIST`.
> Before using `archery_submit_workflow`, `archery_list_workflows` or `archery_get_workflow`,
> ask an admin to add the account under **System Settings → API_USER_WHITELIST**, otherwise
> those calls return 403. Query, instance and schema endpoints are not affected.

### Out of scope

- Never executes tickets (no auto approve / execute / release), so an agent cannot accidentally touch production;
- Never bypasses Archery's own permissions, query auditing, data masking or ticket workflow;
- Ships no accounts, passwords or company addresses — everything comes from local configuration.

---

## Quick start

Requirements: **Node.js 18.3+**. No `npm install` needed, no third-party dependencies.

```bash
cd archery-mcp
# copy and edit the configuration
cp config.example.json config.json      # Windows: copy config.example.json config.json

node bin/archery-mcp.mjs --config config.json --check
```

`--check` performs a real login and prints the detected flavor and the number of accessible instances:

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

Once the check passes, start the MCP server (stdio; normally launched by the client, so you rarely
need to run it by hand):

```bash
node bin/archery-mcp.mjs --config config.json
```

---

## Local testing (no real database)

The project ships a mock Archery (`test/mock-archery.mjs`) so you can exercise login, queries,
tickets and the MCP protocol without touching a production database.

```bash
node --test test/client.test.mjs test/mcp.test.mjs
# or
npm test
```

All **15 tests** pass, covering:

- password login, CSRF, session reuse and wrong passwords;
- v1 query parameters, row limits and result truncation;
- read-only validation (writes, multiple statements, `FOR UPDATE`, `OUTFILE`, `/*! */`, `LOAD_FILE`);
- v1/v2 ticket submission, listing, details, audit results and logs;
- the `API_USER_WHITELIST` hint when v1 ticket endpoints return 403;
- session-cookie mode;
- MCP stdio protocol: `initialize`, `tools/list`, `tools/call` success and error paths;
- the `--check` self-test command.

The project has also been validated against a real Archery 1.x deployment: login, 24 instances,
database/table listing, table schemas, `SELECT 1` / `SHOW` queries, ticket list (26k tickets) and
ticket details. **Real ticket submission was never performed**, to avoid creating approval requests;
whether table-level `SELECT` works depends on your Archery query permissions.

---

## Connect an MCP client

### Generic JSON config (Claude Desktop / Cursor, etc.)

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

Replace `command` with the real Node executable path (on Windows, avoid the Microsoft Store alias)
and point `args` at this project.

### DeepSeek Harness (DSH)

`dsh-bundle/` is a DSH bundle that only wires up the MCP connection. After installation, an
"Archery 数据库工单" connection appears in the plugin list and the 8 `archery_*` tools are registered
as `mcp__archery__*`. Before installing, update the Node path, script path and config path in
`dsh-bundle/cordis.patch.yml`, then run:

```text
plugin_manager(action="install_bundle", target="C:\\path\\to\\archery-mcp\\dsh-bundle")
```

After editing `config.json`, restart DSH (or reload the MCP connection), because configuration is
read at process start.

> Installing the bundle writes to the current DSH profile and affects every session in that
> profile; double-check the paths before installing.

### Environment variables (no config file)

```bash
export ARCHERY_BASE_URL="https://archery.example.com"
export ARCHERY_USERNAME="agent-bot"
export ARCHERY_PASSWORD="******"
node bin/archery-mcp.mjs
```

PowerShell:

```powershell
$env:ARCHERY_BASE_URL = "https://archery.example.com"
$env:ARCHERY_USERNAME = "agent-bot"
$env:ARCHERY_PASSWORD = "******"
node bin/archery-mcp.mjs
```

Environment variables take precedence over the config file.

---

## Configuration

| Key | Env var | Default | Description |
| --- | --- | --- | --- |
| `base_url` | `ARCHERY_BASE_URL` | required | Archery site URL, e.g. `https://archery.example.com` |
| `username` | `ARCHERY_USERNAME` | empty | login account |
| `password` | `ARCHERY_PASSWORD` | empty | login password |
| `session_cookie` | `ARCHERY_SESSION_COOKIE` | empty | browser `sessionid`; skips password login when set |
| `csrf_cookie` | `ARCHERY_CSRF_COOKIE` | empty | browser `csrftoken`, paired with `session_cookie` |
| `verify_tls` | `ARCHERY_VERIFY_TLS` | `true` | verify HTTPS certificates; set to `false` only for self-signed intranet certs |
| `timeout` | `ARCHERY_TIMEOUT` | `30` | HTTP timeout in seconds |
| `api_flavor` | `ARCHERY_API_FLAVOR` | `auto` | `auto` / `v1` / `v2`; set manually if auto-detection fails |
| `default_limit` | `ARCHERY_DEFAULT_LIMIT` | `100` | default query row limit |
| `max_limit` | `ARCHERY_MAX_LIMIT` | `5000` | hard row limit for queries |
| `max_rows` | `ARCHERY_MAX_ROWS` | `200` | preview rows returned to the model; extra rows are truncated and flagged |
| `allow_write_sql` | `ARCHERY_ALLOW_WRITE_SQL` | `false` | allow non-read-only SQL in the query tool; **strongly discouraged** |

Set the config path with `--config` or `ARCHERY_MCP_CONFIG`.

---

## Tools

| Tool | Purpose | Key parameters |
| --- | --- | --- |
| `archery_list_instances` | list accessible instances | `tag`=`can_read`/`can_write`, `search` |
| `archery_list_databases` | list databases on an instance | `instance` |
| `archery_describe_table` | show a table schema | `instance`, `database`, `table`, `schema` |
| `archery_query` | run read-only SQL | `instance`, `database`, `sql`, `limit` |
| `archery_list_groups` | list resource groups you can submit to | — |
| `archery_submit_workflow` | create a SQL release ticket | `instance`, `database`, `sql`, `workflow_name`, `group`, `backup` |
| `archery_list_workflows` | ticket list / awaiting review | `scope`=`mine`/`audit`, `status`, `search`, `limit`, `offset` |
| `archery_get_workflow` | ticket details, SQL, audit results and logs | `workflow_id` (v1) or `audit_id` (v2), `include_logs` |

### Sample responses

Query:

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

Ticket submission:

```json
{
  "workflow_id": 1234,
  "audit_id": 5678,
  "workflow_name": "add age column",
  "instance": "prod-mysql",
  "database": "app_db",
  "group_id": 10,
  "group_name": "DBA",
  "status": "workflow_manreviewing",
  "message": "submitted"
}
```

---

## Usage examples

```text
Show me the 20 most recently registered users in app_db.users on prod-mysql,
only id, name and created_at.

Submit the following SQL as a ticket in the DBA group named "add index on orders":
ALTER TABLE orders ADD INDEX idx_user_id (user_id);

List the tickets awaiting my review, with the automated audit result for each.
```

The model typically calls `archery_list_instances` / `archery_list_databases` to confirm the target
before querying or submitting.

---

## Archery API compatibility

Archery versions expose different APIs; the client auto-detects the flavor, or you can pin it:

| Action | Archery 1.x (v1.14) | Archery master (2.x dev) |
| --- | --- | --- |
| Login | `GET /login/` + `POST /authenticate/` | same |
| Instance list | `GET /group/user_all_instances/` | `GET /api/v1/sqlquery/instances/` |
| Databases / tables | `GET /instance/instance_resource/`, `POST /instance/describetable/` | `GET /api/v1/sqlquery/resources/`, `POST /api/v1/sqlquery/describetable/` |
| Query | `POST /query/` (form) | `POST /api/v1/sqlquery/execute/` (JSON) |
| Submit ticket | `POST /api/v1/workflow/` | `POST /api/v1/sql-workflows/` |
| Ticket list | `GET /api/v1/workflow/` / `POST /api/v1/workflow/auditlist/` | `POST /api/v1/sql-workflows/list/` / `audit-list/` |
| Ticket details | `GET /api/v1/workflow/?workflow_id=` + `POST /api/v1/workflow/log/` | `GET /api/v1/sql-workflows/<audit_id>/` + `/content/` + `/logs/` |

If your Archery version differs, set `api_flavor` first; if it is still incompatible, adjust the
paths and parameters in `src/client.mjs`.

### 2FA / SSO / CAS

With two-factor authentication or a unified login portal, username/password login does not yield a
session. Workarounds:

1. Log in to Archery in your browser normally;
2. DevTools → Application → Cookies → copy `sessionid` (and `csrftoken`);
3. Put them into the configuration:

```json
{
  "base_url": "https://archery.example.com",
  "session_cookie": "xxxxxxxx",
  "csrf_cookie": "yyyyyyyy",
  "verify_tls": true
}
```

Cookies expire, so this suits short-lived local use. For long-running setups, create a dedicated
read-only/ticketing account for the agent with 2FA disabled, or provide a fixed session through
your SSO gateway.

---

## Security

- **Least privilege**: create a dedicated Archery account for the agent, granting only the required
  instance `can_read` / `can_write` tags and resource groups; query and ticket permissions are still
  enforced by Archery.
- **Read-only first**: the query tool rejects writes by default; `allow_write_sql` is for edge cases
  and is still bounded by the Archery account permissions.
- **Writes**: `archery_submit_workflow` really creates tickets and notifies approvers — verify the
  instance, database, name and SQL before calling it.
- **Data exposure**: query results enter the model context. Rely on Archery data masking for sensitive
  production fields, or limit the returned columns.
- **Credentials**: prefer environment variables or a config file readable only by you; never commit
  `config.json` or cookies to Git.
- **TLS**: certificates are verified by default; disabling verification should only happen on a
  controlled intranet.
- **Auditing**: Archery records query and ticket operation logs; the MCP server itself only prints tool
  names and errors to stderr, never passwords or SQL.

The read-only SQL check is an **extra guardrail, not a security boundary**; the real boundary is the
Archery account and the database account.

---

## Project layout

```text
archery-mcp/
├── bin/archery-mcp.mjs   # CLI entry
├── src/
│   ├── config.mjs        # JSON + env configuration
│   ├── http.mjs          # stdlib HTTP client (Cookie/CSRF/gzip/TLS/redirects)
│   ├── client.mjs        # Archery v1/v2 API wrapper
│   ├── sqlguard.mjs      # read-only SQL validation and statement splitting
│   ├── tools.mjs         # the 8 MCP tool definitions and handlers
│   ├── mcp.mjs           # MCP stdio JSON-RPC server
│   └── cli.mjs           # command-line entry
├── test/
│   ├── mock-archery.mjs  # local Archery mock
│   ├── client.test.mjs
│   └── mcp.test.mjs
├── dsh-bundle/           # optional DSH MCP connection bundle
├── config.example.json
├── README.zh-CN.md
└── package.json
```

## Roadmap

- Approve / execute ticket tools (closed by default; requires explicit confirmation and a separate switch);
- Streamable HTTP transport and multi-tenancy (per-request account switching);
- Generate tools automatically from Archery's Swagger (`/api/schema/`) to reduce version adaptation work.
