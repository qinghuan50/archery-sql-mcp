import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { MockArchery } from "./mock-archery.mjs";

const NODE_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const BIN = path.join(NODE_ROOT, "bin", "archery-mcp.mjs");

async function writeConfig(baseUrl, extra = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "archery-mcp-"));
  const file = path.join(directory, "config.json");
  await writeFile(
    file,
    JSON.stringify(
      {
        base_url: baseUrl,
        username: "admin",
        password: "secret",
        api_flavor: "auto",
        ...extra,
      },
      null,
      2,
    ),
    "utf8",
  );
  return file;
}

function runServer(configPath, messages) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN, "--config", configPath], {
      cwd: NODE_ROOT,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`MCP 服务未在 15 秒内退出，stderr: ${Buffer.concat(stderr).toString("utf8")}`));
    }, 15000);

    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      try {
        const text = Buffer.concat(stdout).toString("utf8");
        const responses = text
          .split("\n")
          .map((line) => line.trim())
          .filter(Boolean)
          .map((line) => JSON.parse(line));
        resolve({ code, responses, stderr: Buffer.concat(stderr).toString("utf8") });
      } catch (error) {
        reject(error);
      }
    });

    for (const message of messages) {
      child.stdin.write(`${JSON.stringify(message)}\n`);
    }
    child.stdin.end();
  });
}

test("MCP initialize / tools.list / tools.call", async () => {
  const mock = await new MockArchery("v1").start();
  try {
    const config = await writeConfig(mock.baseUrl);
    const { code, responses, stderr } = await runServer(config, [
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "test", version: "1" },
        },
      },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "archery_query",
          arguments: {
            instance: "prod-mysql",
            database: "app_db",
            sql: "select * from users",
            limit: 10,
          },
        },
      },
    ]);

    assert.equal(code, 0, stderr);
    assert.equal(responses.length, 3, stderr);
    const byId = new Map(responses.map((response) => [response.id, response]));
    assert.equal(byId.get(1).result.protocolVersion, "2025-06-18");
    assert.equal(byId.get(1).result.serverInfo.name, "archery-mcp");
    assert.ok(byId.get(1).result.capabilities.tools);

    const tools = byId.get(2).result.tools;
    assert.equal(tools.length, 8);
    assert.ok(tools.some((tool) => tool.name === "archery_submit_workflow"));

    const result = byId.get(3).result;
    assert.equal(result.isError, undefined);
    const payload = JSON.parse(result.content[0].text);
    assert.equal(payload.row_count, 2);
    assert.deepEqual(payload.columns, ["id", "name"]);
  } finally {
    await mock.stop();
  }
});

test("MCP 工具错误以 isError 返回", async () => {
  const mock = await new MockArchery("v1").start();
  try {
    const config = await writeConfig(mock.baseUrl);
    const { responses, stderr } = await runServer(config, [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "archery_query",
          arguments: {
            instance: "prod-mysql",
            database: "app_db",
            sql: "delete from users",
          },
        },
      },
    ]);
    assert.equal(responses.length, 2, stderr);
    const result = responses[1].result;
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /只读/);
    assert.equal(mock.count("POST", "/query/"), 0);
  } finally {
    await mock.stop();
  }
});

test("无凭证也能启动并列出工具", async () => {
  const mock = await new MockArchery("v1").start();
  try {
    const config = await writeConfig(mock.baseUrl, { username: "", password: "" });
    const { responses, stderr } = await runServer(config, [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
    ]);
    assert.equal(responses.length, 2, stderr);
    assert.equal(responses[1].result.tools.length, 8);
  } finally {
    await mock.stop();
  }
});

test("--check 登录并输出实例", async () => {
  const mock = await new MockArchery("v1").start();
  try {
    const config = await writeConfig(mock.baseUrl);
    const result = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [BIN, "--config", config, "--check"], {
        cwd: NODE_ROOT,
        stdio: ["ignore", "pipe", "pipe"],
      });
      const stdout = [];
      const stderr = [];
      child.stdout.on("data", (chunk) => stdout.push(chunk));
      child.stderr.on("data", (chunk) => stderr.push(chunk));
      child.on("error", reject);
      child.on("close", (code) =>
        resolve({
          code,
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: Buffer.concat(stderr).toString("utf8"),
        }),
      );
    });
    assert.equal(result.code, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.ok, true);
    assert.equal(payload.flavor, "v1");
    assert.equal(payload.instance_count, 2);
  } finally {
    await mock.stop();
  }
});
