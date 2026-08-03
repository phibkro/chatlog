#!/usr/bin/env bun
import { resolve } from "node:path";
import { McpData } from "./mcp/data";
import { runMcpStdio } from "./mcp/server";

const root = resolve(process.env.CHATLOG_DATA_ROOT ?? process.cwd());
const data = new McpData(root);
try {
  await runMcpStdio(data);
} finally {
  data.close();
}
