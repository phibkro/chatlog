#!/usr/bin/env bun
import { readBoundedInputLines } from "../bounded-input";
import { EVIDENCE_URI_PATTERN } from "../evidence-uri";
import { redact } from "../redact";
import { resolveDataRoot } from "../data-root";
import { McpData, isMcpDataFailure, MCP_RECALL_MAXIMUMS, MCP_TEXT_MAXIMUMS } from "./data";

const SERVER_NAME = "chatlog";
const SERVER_VERSION = "0.1.0-rc.1";
export const MCP_MAX_LINE_BYTES = 256 * 1024;
const LATEST_STABLE_PROTOCOL = "2025-11-25";
const SUPPORTED_PROTOCOLS = new Set([
  LATEST_STABLE_PROTOCOL,
  "2025-06-18",
  "2025-03-26",
  "2024-11-05",
]);

type JsonRpcId = string | number | null;
interface JsonRpcMessage {
  jsonrpc?: string;
  id?: JsonRpcId;
  method?: string;
  params?: any;
}

export interface McpState {
  initializeReceived: boolean;
  initialized: boolean;
  protocolVersion: string;
}

export function createMcpState(): McpState {
  return {
    initializeReceived: false,
    initialized: false,
    protocolVersion: LATEST_STABLE_PROTOCOL,
  };
}

const DOMAIN_PROPERTY = {
  type: "array",
  maxItems: MCP_TEXT_MAXIMUMS.domainCount,
  items: { type: "string", minLength: 1, maxLength: MCP_TEXT_MAXIMUMS.domain },
  description: "Optional subset of the server's configured conversation domains.",
} as const;

export const MCP_TOOLS = [
  {
    name: "chatlog_search",
    description:
      "Search policy-visible Chatlog turns locally and return bounded snippets with stable evidence URIs.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          minLength: 1,
          maxLength: MCP_TEXT_MAXIMUMS.query,
          description: "Concrete lexical search terms.",
        },
        limit: { type: "number", minimum: 1, maximum: 20, default: 8 },
        domains: DOMAIN_PROPERTY,
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "chatlog_get_evidence",
    description:
      "Resolve one policy-visible chatlog:// turn pointer, bounded to 12,000 text characters.",
    inputSchema: {
      type: "object",
      properties: {
        uri: {
          type: "string",
          maxLength: MCP_TEXT_MAXIMUMS.evidenceUri,
          pattern: EVIDENCE_URI_PATTERN,
        },
        domains: DOMAIN_PROPERTY,
      },
      required: ["uri"],
      additionalProperties: false,
    },
  },
  {
    name: "chatlog_recent_work",
    description: "Return recent policy-visible session metadata for one exact project path.",
    inputSchema: {
      type: "object",
      properties: {
        project: {
          type: "string",
          minLength: 1,
          maxLength: MCP_TEXT_MAXIMUMS.path,
          description: "Exact canonical project path.",
        },
        limit: { type: "number", minimum: 1, maximum: 20, default: 8 },
        domains: DOMAIN_PROPERTY,
      },
      required: ["project"],
      additionalProperties: false,
    },
  },
  {
    name: "chatlog_project_brief",
    description:
      "Return a bounded local activity and derived-evidence brief for one exact project path.",
    inputSchema: {
      type: "object",
      properties: {
        project: {
          type: "string",
          minLength: 1,
          maxLength: MCP_TEXT_MAXIMUMS.path,
          description: "Exact canonical project path.",
        },
        domains: DOMAIN_PROPERTY,
      },
      required: ["project"],
      additionalProperties: false,
    },
  },
  {
    name: "chatlog_context",
    description:
      "Return the single operator-authorized context item relevant to this task, encoded for the current provider. Records a tool-result delivery receipt and spends the pinned session budget.",
    inputSchema: {
      type: "object",
      properties: {
        contextSessionId: {
          type: "string",
          pattern: "^[a-f0-9]{64}$",
          description: "Hook-issued context session ID bound to provider, scope, and budget.",
        },
        task: {
          type: "string",
          minLength: 1,
          maxLength: MCP_TEXT_MAXIMUMS.task,
          description: "Current task statement.",
        },
        query: {
          type: "string",
          minLength: 1,
          maxLength: MCP_TEXT_MAXIMUMS.query,
          description: "Concrete task-relevant lookup terms.",
        },
      },
      required: ["contextSessionId", "task", "query"],
      additionalProperties: false,
    },
  },
  {
    name: "chatlog_bounded_recall",
    description:
      "Run finite provider-neutral recall inside one existing context session. Returns immutable evidence references plus explicit budget, contradiction, novelty, stability, and termination traces.",
    inputSchema: {
      type: "object",
      properties: {
        contextSessionId: {
          type: "string",
          pattern: "^[a-f0-9]{64}$",
          description: "Parent context session ID returned by chatlog_context.",
        },
        invocationId: {
          type: "string",
          minLength: 1,
          maxLength: 256,
          description: "Stable caller key for retries; omit to create a new invocation.",
        },
        query: {
          type: "string",
          minLength: 1,
          maxLength: MCP_TEXT_MAXIMUMS.query,
        },
        budget: {
          type: "object",
          properties: {
            maxDepth: {
              type: "integer",
              minimum: 0,
              maximum: MCP_RECALL_MAXIMUMS.maxDepth,
            },
            maxBranches: {
              type: "integer",
              minimum: 0,
              maximum: MCP_RECALL_MAXIMUMS.maxBranches,
            },
            maxQueries: {
              type: "integer",
              minimum: 0,
              maximum: MCP_RECALL_MAXIMUMS.maxQueries,
            },
            maxResults: {
              type: "integer",
              minimum: 0,
              maximum: MCP_RECALL_MAXIMUMS.maxResults,
            },
            maxTokens: {
              type: "integer",
              minimum: 0,
              maximum: MCP_RECALL_MAXIMUMS.maxTokens,
            },
            maxLatencyMs: {
              type: "number",
              minimum: 0,
              maximum: MCP_RECALL_MAXIMUMS.maxLatencyMs,
            },
            maxCostUsd: {
              type: "number",
              minimum: 0,
              maximum: MCP_RECALL_MAXIMUMS.maxCostUsd,
            },
          },
          required: [
            "maxDepth",
            "maxBranches",
            "maxQueries",
            "maxResults",
            "maxTokens",
            "maxLatencyMs",
            "maxCostUsd",
          ],
          additionalProperties: false,
        },
      },
      required: ["contextSessionId", "query", "budget"],
      additionalProperties: false,
    },
  },
] as const;

function response(id: JsonRpcId, result: unknown): JsonRpcMessage {
  return { jsonrpc: "2.0", id, ...({ result } as any) };
}

function errorResponse(id: JsonRpcId, code: number, message: string): JsonRpcMessage {
  return { jsonrpc: "2.0", id, ...({ error: { code, message: redact(message) } } as any) };
}

function toolResult(value: unknown, isError = false): unknown {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return {
    content: [{ type: "text", text }],
    ...(typeof value === "object" && value !== null ? { structuredContent: value } : {}),
    ...(isError ? { isError: true } : {}),
  };
}

function argumentsRecord(value: unknown): Record<string, unknown> {
  if (value == null) return {};
  if (typeof value !== "object" || Array.isArray(value))
    throw new Error("tool arguments must be an object");
  return value as Record<string, unknown>;
}

function unwrapMcpDataResult(value: unknown): unknown {
  if (isMcpDataFailure(value)) throw value.error;
  return value;
}

async function callTool(
  data: McpData,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  if (name === "chatlog_search") return unwrapMcpDataResult(data.search(args));
  if (name === "chatlog_get_evidence") return unwrapMcpDataResult(await data.evidence(args));
  if (name === "chatlog_recent_work") return unwrapMcpDataResult(data.recentWork(args));
  if (name === "chatlog_project_brief") return unwrapMcpDataResult(await data.projectBrief(args));
  if (name === "chatlog_context") return unwrapMcpDataResult(await data.deliverContext(args));
  if (name === "chatlog_bounded_recall") return unwrapMcpDataResult(await data.boundedRecall(args));
  throw new Error(`unknown tool: ${name}`);
}

export async function handleMcpMessage(
  data: McpData,
  message: JsonRpcMessage,
  state = createMcpState(),
): Promise<JsonRpcMessage | null> {
  const hasId = Object.prototype.hasOwnProperty.call(message, "id");
  const id = hasId ? (message.id ?? null) : null;
  if (message.jsonrpc !== "2.0" || typeof message.method !== "string")
    return hasId ? errorResponse(id, -32600, "invalid JSON-RPC request") : null;

  if (message.method === "notifications/initialized") {
    if (state.initializeReceived) state.initialized = true;
    return null;
  }
  if (!hasId) return null;

  if (message.method === "initialize") {
    state.initializeReceived = true;
    const requested = message.params?.protocolVersion;
    state.protocolVersion =
      typeof requested === "string" && SUPPORTED_PROTOCOLS.has(requested)
        ? requested
        : LATEST_STABLE_PROTOCOL;
    return response(id, {
      protocolVersion: state.protocolVersion,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      instructions:
        "Search first, resolve only needed evidence, and request Chatlog context only for a concrete task. Results are local, bounded, redacted, domain-filtered, and operator-gated.",
    });
  }
  if (message.method === "ping") return response(id, {});
  if (!state.initialized) return errorResponse(id, -32002, "server not initialized");
  if (message.method === "tools/list") return response(id, { tools: MCP_TOOLS });
  if (message.method === "tools/call") {
    const name = message.params?.name;
    if (typeof name !== "string" || !MCP_TOOLS.some((tool) => tool.name === name))
      return errorResponse(id, -32602, "unknown or missing tool name");
    try {
      const value = await callTool(data, name, argumentsRecord(message.params?.arguments));
      return response(id, toolResult(value));
    } catch (error: any) {
      return response(id, toolResult(redact(String(error?.message ?? error)), true));
    }
  }
  return errorResponse(id, -32601, `method not found: ${message.method}`);
}

export async function processMcpLine(
  data: McpData,
  line: string,
  state: McpState,
): Promise<JsonRpcMessage | null> {
  if (Buffer.byteLength(line, "utf8") > MCP_MAX_LINE_BYTES)
    return errorResponse(null, -32600, `JSON-RPC request exceeds ${MCP_MAX_LINE_BYTES} bytes`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return errorResponse(null, -32700, "parse error");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    return errorResponse(null, -32600, "invalid JSON-RPC request");
  return handleMcpMessage(data, parsed as JsonRpcMessage, state);
}

export async function runMcpStdio(data: McpData): Promise<void> {
  const state = createMcpState();
  const lines = readBoundedInputLines(process.stdin, MCP_MAX_LINE_BYTES, "Chatlog MCP request");
  for await (const framed of lines) {
    if (!framed.ok) throw framed.error;
    const line = framed.value;
    if (!line.trim()) continue;
    const reply = await processMcpLine(data, line, state);
    if (reply) process.stdout.write(`${JSON.stringify(reply)}\n`);
  }
}

if (import.meta.main) {
  const root = resolveDataRoot();
  let data: McpData | undefined;
  try {
    data = new McpData(root);
    await runMcpStdio(data);
  } catch (error: any) {
    console.error(`chatlog-mcp: ${redact(String(error?.message ?? error))}`);
    process.exitCode = 1;
  } finally {
    data?.close();
  }
}
