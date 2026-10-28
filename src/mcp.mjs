import readline from "node:readline";

import { ArcheryError } from "./client.mjs";
import { TOOLS, callTool } from "./tools.mjs";

const VERSION = "0.1.0";
const SUPPORTED_PROTOCOLS = new Set(["2024-11-05", "2025-03-26", "2025-06-18"]);
const MAX_TEXT_CHARS = 200_000;

const INSTRUCTIONS =
  "该服务连接企业 Archery SQL 审核平台，可查询生产库（默认只读）、查看实例/库/表结构并提交 SQL 上线工单。" +
  "执行查询前先用 archery_list_instances 确认实例，用 archery_list_databases 确认库名；" +
  "提交工单前先确认资源组与实例写权限。";

function errorResponse(id, code, message) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function textResult(text, isError = false) {
  let value = text;
  if (value.length > MAX_TEXT_CHARS) {
    value = `${value.slice(0, MAX_TEXT_CHARS)}\n...（输出过长，已截断）`;
  }
  const result = { content: [{ type: "text", text: value }] };
  if (isError) result.isError = true;
  return result;
}

export class McpServer {
  constructor(client, settings, { stdin = process.stdin, stdout = process.stdout } = {}) {
    this.client = client;
    this.settings = settings;
    this.stdin = stdin;
    this.stdout = stdout;
  }

  send(message) {
    this.stdout.write(`${JSON.stringify(message)}\n`);
  }

  async serve() {
    const rl = readline.createInterface({ input: this.stdin, crlfDelay: Infinity });
    for await (const line of rl) {
      const text = line.trim();
      if (!text) continue;
      let message;
      try {
        message = JSON.parse(text);
      } catch (error) {
        console.error(`无法解析客户端消息: ${error.message}`);
        this.send(errorResponse(null, -32700, "Parse error"));
        continue;
      }
      if (Array.isArray(message)) {
        for (const item of message) {
          if (item && typeof item === "object") await this.handleMessage(item);
        }
      } else if (message && typeof message === "object") {
        await this.handleMessage(message);
      }
    }
  }

  async handleMessage(message) {
    const id = message.id;
    const hasId = Object.prototype.hasOwnProperty.call(message, "id");
    const method = message.method;

    if (typeof method !== "string") {
      if (hasId) this.send(errorResponse(id, -32600, "Invalid Request"));
      return;
    }

    try {
      if (method === "initialize") {
        this.send({ jsonrpc: "2.0", id, result: this.initializeResult(message.params || {}) });
        return;
      }
      if (method.startsWith("notifications/")) return;
      if (method === "ping") {
        this.send({ jsonrpc: "2.0", id, result: {} });
        return;
      }
      if (method === "tools/list") {
        this.send({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
        return;
      }
      if (method === "tools/call") {
        const result = await this.callTool(message.params || {});
        this.send({ jsonrpc: "2.0", id, result });
        return;
      }
      if (["logging/setLevel", "completion/complete"].includes(method)) {
        this.send({ jsonrpc: "2.0", id, result: {} });
        return;
      }
      if (hasId) this.send(errorResponse(id, -32601, `Method not found: ${method}`));
    } catch (error) {
      console.error(`处理 ${method} 失败: ${error.stack || error.message}`);
      if (hasId) this.send(errorResponse(id, -32603, "Internal error"));
    }
  }

  initializeResult(params) {
    const requested = params.protocolVersion;
    const version =
      typeof requested === "string" && SUPPORTED_PROTOCOLS.has(requested) ? requested : "2024-11-05";
    return {
      protocolVersion: version,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "archery-mcp", version: VERSION },
      instructions: INSTRUCTIONS,
    };
  }

  async callTool(params) {
    const name = params.name;
    const args = params.arguments || {};
    if (typeof name !== "string") return textResult("tools/call 缺少 name", true);
    if (!args || typeof args !== "object" || Array.isArray(args)) {
      return textResult("tools/call 的 arguments 必须是对象", true);
    }
    try {
      const text = await callTool(this.client, name, args);
      return textResult(text);
    } catch (error) {
      if (error instanceof ArcheryError) {
        console.error(`工具 ${name} 失败: ${error.message}`);
        return textResult(`错误: ${error.message}`, true);
      }
      if (error instanceof Error) {
        console.error(`工具 ${name} 失败: ${error.message}`);
        return textResult(`错误: ${error.message}`, true);
      }
      console.error(`工具 ${name} 异常: ${String(error)}`);
      return textResult(`错误: 调用 Archery 时发生未预期异常（${String(error)}）`, true);
    }
  }
}
