import { describe, expect, test } from "bun:test";
import { buildHandoffSummary, serializePiBridge } from "../src/bridge";
import type { Conversation } from "../src/types";
import type { DerivedConversation } from "../src/derive";

const hash = "a".repeat(64);
const conversation: Conversation = {
  id: "source-session", provider: "anthropic", harness: "claude-code", project: "/work/project", cwd: "/work/project",
  model: "claude-test", startedAt: "2026-01-01T00:00:00Z", endedAt: "2026-01-01T00:01:00Z", resumeId: "source-session",
  sourcePath: "/secret/source.jsonl", contentHash: hash,
  turns: [
    { role: "system", content: "SECRET SOURCE POLICY" },
    { role: "user", content: "Fix the build with api_key=supersecretvalue" },
    { role: "assistant", content: "I will inspect it.", toolCalls: [{ id: "call-1", name: "Bash", arguments: "npm test", output: "passed" }] },
    { role: "tool", content: "raw tool result" },
    { role: "assistant", content: "Done." },
  ],
};

const derived: DerivedConversation = {
  schemaVersion: 1, conversationHash: hash, sessionId: conversation.id, provider: conversation.provider, project: conversation.project,
  harness: conversation.harness, model: conversation.model, startedAt: conversation.startedAt, endedAt: conversation.endedAt,
  metrics: { turns: 5, characters: 20, roles: {}, tokens: {}, toolCalls: [{ name: "Bash", count: 1 }] },
  topics: [], problems: [], decisions: [{ pointer: { turnIndex: 2, uri: `chatlog://conversation/${hash}/turn/2` }, snippet: "Inspect first" }],
  gates: [], attempts: [{ pointer: { turnIndex: 2, uri: `chatlog://conversation/${hash}/turn/2` }, snippet: "Ran the gate", tools: ["Bash"], outcome: "success" }],
  outcome: { status: "success", evidence: [{ pointer: { turnIndex: 4, uri: `chatlog://conversation/${hash}/turn/4` }, snippet: "Done" }] },
};

describe("Pi bridge", () => {
  test("emits deterministic Pi v3 history without source policy or active tool calls", () => {
    const first = serializePiBridge(conversation, "history");
    const second = serializePiBridge(conversation, "history");
    expect(first.text).toBe(second.text);
    const lines = first.text.trim().split("\n").map(JSON.parse);
    expect(lines[0]).toMatchObject({ type: "session", version: 3, cwd: "/work/project" });
    expect(lines.slice(1).every((line, index) => line.id.match(/^[a-f0-9]{8}$/) && line.parentId === (index ? lines[index].id : null))).toBe(true);
    expect(first.text).not.toContain("SECRET SOURCE POLICY");
    expect(first.text).not.toContain("supersecretvalue");
    expect(first.text).not.toContain("/secret/source.jsonl");
    expect(first.text).not.toContain('"type":"toolCall"');
    expect(first.text).toContain("[historical tool activity; inert]");
    expect(first.receipt.transformation).toMatchObject({ droppedRoles: { system: 1, tool: 1 }, flattenedToolCalls: 1 });
  });

  test("distills a small pointer-rich handoff", () => {
    const summary = buildHandoffSummary(conversation, derived);
    expect(summary).toContain("Outcome classification: success");
    expect(summary).toContain("chatlog://conversation/");
    expect(summary).toContain("Decision points:");
    expect(summary).not.toContain("supersecretvalue");
    const built = serializePiBridge(conversation, "summary", derived);
    expect(built.receipt.target.messages).toBe(1);
    expect(built.text).not.toContain("SECRET SOURCE POLICY");
  });
});
