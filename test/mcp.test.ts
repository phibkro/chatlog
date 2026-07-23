import { expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { indexConversation, openAnalysis } from "../src/analysis";
import { deriveCorpus } from "../src/derive";
import { McpData, parseDomainPolicy } from "../src/mcp/data";
import { createMcpState, handleMcpMessage, processMcpLine } from "../src/mcp/server";
import type { Conversation } from "../src/types";

async function fixture(): Promise<{ root: string; coding: Conversation; personal: Conversation }> {
  const root = await mkdtemp(join(tmpdir(), "chatlog-mcp-"));
  const coding: Conversation = {
    id: "coding-session",
    title: "Projection repair",
    provider: "openai",
    harness: "codex",
    domain: "coding",
    sourceKind: "session-log",
    project: "/project",
    cwd: "/project",
    model: "model",
    startedAt: "2026-07-01T00:00:00Z",
    endedAt: "2026-07-01T00:01:00Z",
    sourcePath: "/coding",
    contentHash: "a".repeat(64),
    turns: [
      { role: "user", content: `Remember the projection repair. ${"x".repeat(13_000)}` },
      { role: "assistant", content: "I decided to rebuild the index and the tests passed." },
    ],
  };
  const personal: Conversation = {
    id: "personal-session",
    title: "Private memory",
    provider: "anthropic",
    harness: "claude-web",
    domain: "personal",
    sourceKind: "anthropic-data-export",
    project: "/project",
    cwd: "",
    model: "model",
    startedAt: "2026-07-02T00:00:00Z",
    endedAt: "2026-07-02T00:01:00Z",
    sourcePath: "/personal",
    contentHash: "b".repeat(64),
    turns: [{ role: "user", content: "Remember an extremely private family memory." }],
  };
  const db = openAnalysis(join(root, "analysis", "chatlog.sqlite"));
  indexConversation(db, coding, 1, 1);
  indexConversation(db, personal, 1, 1);
  db.close();
  for (const conversation of [coding, personal]) {
    const directory = join(root, "corpus", "objects", conversation.contentHash.slice(0, 2));
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, `${conversation.contentHash}.json`), JSON.stringify(conversation));
  }
  await writeFile(join(root, "corpus", "manifest.json"), JSON.stringify({
    version: 1,
    sources: {
      "/coding": { contentHash: coding.contentHash },
      "/personal": { contentHash: personal.contentHash },
    },
  }));
  await deriveCorpus(root);
  return { root, coding, personal };
}

test("MCP data applies domain policy before limits and rechecks canonical evidence", async () => {
  expect(parseDomainPolicy("")).toEqual(["coding"]);
  expect(parseDomainPolicy("research,coding,research")).toEqual(["coding", "research"]);
  expect(() => parseDomainPolicy("*")).toThrow("wildcard");

  const { root, coding, personal } = await fixture();
  const data = new McpData(root);
  try {
    const search = data.search({ query: "remember", limit: 1 }) as any;
    expect(search.policy).toEqual({ configuredDomains: ["coding"], effectiveDomains: ["coding"] });
    expect(search.hits).toHaveLength(1);
    expect(search.hits[0].sessionId).toBe(coding.id);
    expect(JSON.stringify(search)).not.toContain("private family");

    const recent = data.recentWork({ project: "/project", limit: 20 }) as any;
    expect(recent.sessions).toHaveLength(1);
    expect(recent.sessions[0].sessionId).toBe(coding.id);

    const brief = await data.projectBrief({ project: "/project" }) as any;
    expect(brief.overview.sessions).toBe(1);
    expect(JSON.stringify(brief)).not.toContain(personal.id);

    const codingEvidence = await data.evidence({
      uri: `chatlog://conversation/${coding.contentHash}/turn/0`,
    }) as any;
    expect(codingEvidence.truncated).toBe(true);
    expect(codingEvidence.turn.content).toHaveLength(12_000);
    expect(codingEvidence.fullLength).toBeGreaterThan(12_000);
    expect(codingEvidence.turn.toolCalls).toBeUndefined();

    await expect(data.evidence({
      uri: `chatlog://conversation/${personal.contentHash}/turn/0`,
    })).rejects.toThrow("domain access denied");
    expect(() => data.search({ query: "memory", domains: ["personal"] })).toThrow("domain access denied");
  } finally {
    data.close();
  }
});

test("MCP protocol initializes, lists bounded tools, calls them, and reports structured errors", async () => {
  const { root, personal } = await fixture();
  const data = new McpData(root);
  const state = createMcpState();
  try {
    const initialized = await handleMcpMessage(data, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "test", version: "1" } },
    }, state) as any;
    expect(initialized.result).toMatchObject({
      protocolVersion: "2025-11-25",
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "chatlog" },
    });
    expect(await handleMcpMessage(data, {
      jsonrpc: "2.0",
      method: "notifications/initialized",
    }, state)).toBeNull();
    expect(state.initialized).toBe(true);

    const listed = await handleMcpMessage(data, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
    }, state) as any;
    expect(listed.result.tools.map((tool: any) => tool.name)).toEqual([
      "chatlog_search",
      "chatlog_get_evidence",
      "chatlog_recent_work",
      "chatlog_project_brief",
    ]);

    const called = await handleMcpMessage(data, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "chatlog_search", arguments: { query: "projection" } },
    }, state) as any;
    expect(called.result.isError).toBeUndefined();
    expect(called.result.structuredContent.hits).toHaveLength(1);

    const denied = await handleMcpMessage(data, {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: {
        name: "chatlog_get_evidence",
        arguments: { uri: `chatlog://conversation/${personal.contentHash}/turn/0` },
      },
    }, state) as any;
    expect(denied.result.isError).toBe(true);
    expect(denied.result.content[0].text).toContain("domain access denied");

    const unknownMethod = await handleMcpMessage(data, {
      jsonrpc: "2.0",
      id: 5,
      method: "archive/everything",
    }, state) as any;
    expect(unknownMethod.error.code).toBe(-32601);
    expect((await processMcpLine(data, "{", state) as any).error.code).toBe(-32700);
  } finally {
    data.close();
  }
});

test("MCP stdio emits one JSON-RPC message per line and no diagnostic stdout", async () => {
  const { root } = await fixture();
  const transcript = [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "test", version: "1" } } },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 2, method: "tools/list" },
    { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "chatlog_search", arguments: { query: "projection" } } },
  ].map((message) => JSON.stringify(message)).join("\n") + "\n";
  const child = Bun.spawn([process.execPath, "run", "src/mcp/server.ts"], {
    cwd: join(import.meta.dir, ".."),
    env: { ...process.env, CHATLOG_DATA_ROOT: root, CHATLOG_MCP_DOMAINS: "coding" },
    stdin: new Blob([transcript]),
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(exitCode).toBe(0);
  expect(stderr).toBe("");
  const lines = stdout.trim().split("\n");
  expect(lines).toHaveLength(3);
  const messages = lines.map((line) => JSON.parse(line));
  expect(messages.map((message) => message.id)).toEqual([1, 2, 3]);
  expect(messages[2].result.structuredContent.hits).toHaveLength(1);
});
