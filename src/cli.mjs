import { parseArgs } from "node:util";

import { ArcheryClient } from "./client.mjs";
import { ConfigError, loadSettings, publicSummary, validateForLogin } from "./config.mjs";
import { McpServer } from "./mcp.mjs";

const VERSION = "0.1.0";

export async function main(argv = process.argv.slice(2)) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: false,
      options: {
        config: { type: "string" },
        check: { type: "boolean" },
        version: { type: "boolean" },
      },
    });
  } catch (error) {
    console.error(`参数错误: ${error.message}`);
    return 2;
  }
  const { values } = parsed;

  if (values.version) {
    console.log(`archery-mcp ${VERSION}`);
    return 0;
  }

  let settings;
  try {
    settings = await loadSettings(values.config);
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(`配置错误: ${error.message}`);
      return 2;
    }
    throw error;
  }

  if (values.check) {
    try {
      validateForLogin(settings);
      const client = new ArcheryClient(settings);
      await client.login();
      const flavor = await client.detectFlavor();
      const instances = await client.listInstances();
      console.log(
        JSON.stringify(
          {
            ok: true,
            settings: publicSummary(settings),
            flavor,
            instance_count: instances.length,
            instances: instances.slice(0, 20).map((row) => ({
              id: row.id,
              instance_name: row.instance_name,
              db_type: row.db_type,
            })),
          },
          null,
          2,
        ),
      );
      return 0;
    } catch (error) {
      console.error(`检查失败: ${error.message}`);
      return 1;
    }
  }

  const client = new ArcheryClient(settings);
  const server = new McpServer(client, settings);
  await server.serve();
  return 0;
}
