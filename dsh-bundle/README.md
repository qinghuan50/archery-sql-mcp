# DSH MCP Bundle

这是一个只做 MCP 连接、不含 Host/Client 代码的 DSH bundle。安装后会在当前 profile
中出现 “Archery 数据库工单” 连接，并把 8 个 `archery_*` 工具提供给 Agent。

## 安装前修改

编辑 `cordis.patch.yml`：

- `command`：Node.js 可执行文件绝对路径（要求 Node 18.3+）；
- `args`：`archery-mcp` 项目里 `bin/archery-mcp.mjs` 的绝对路径；
- `ARCHERY_MCP_CONFIG`：配置文件路径（可复制上级目录的 `config.example.json` 为 `config.json`）；
- `cwd`：项目根目录。

## 安装

在 DSH 中执行（需要 profile 写权限）：

```text
plugin_manager(action="install_bundle", target="C:\\path\\to\\archery-mcp\\dsh-bundle")
```

安装后重启会话或刷新页面，确认出现 `mcp__archery__*` 工具。

## 卸载

```text
plugin_manager(action="remove_bundle", target="@local/archery-mcp")
```
