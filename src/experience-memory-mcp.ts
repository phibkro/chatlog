#!/usr/bin/env bun
import { resolvePluginDataRoot } from "./data-root";
import { McpData } from "./mcp/data";
import { runMcpStdio } from "./mcp/server";

const resolvedRoot = resolvePluginDataRoot(process.cwd());
if (!resolvedRoot.ok) {
  console.error(`chatlog-mcp: ${resolvedRoot.error.message}`);
  process.exitCode = 1;
} else {
  const data = new McpData(resolvedRoot.value);
  try {
    await runMcpStdio(data);
  } finally {
    data.close();
  }
}
