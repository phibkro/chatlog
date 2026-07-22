import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { indexConversation, openAnalysis, querySessionLengths, queryTokenUsage, queryToolFrequency, queryUsageOverTime } from "../src/analysis";
import type { Conversation } from "../src/types";

function conversation(overrides: Partial<Conversation>): Conversation {
  return {
    id: "id", provider: "anthropic", harness: "claude-code", project: "/project",
    cwd: "/project", model: "model", startedAt: "2026-07-01T00:00:00Z",
    endedAt: "2026-07-01T00:01:00Z", turns: [], sourcePath: "/source", contentHash: "hash",
    ...overrides,
  };
}

test("separates provider-specific non-cached and cached token semantics", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chatlog-analysis-"));
  const db = openAnalysis(join(dir, "analysis.sqlite"));
  indexConversation(db, conversation({
    turns: [{ role: "assistant", content: "hello", tokens: { input: 10, output: 5, cachedInput: 20, cacheWrite: 30, total: 65 }, toolCalls: [{ name: "Read" }] }],
  }), 1, 1);
  indexConversation(db, conversation({
    id: "codex", provider: "openai", harness: "codex", sourcePath: "/codex", contentHash: "codex-hash",
    turns: [{ role: "assistant", content: "world", tokens: { input: 100, output: 20, cachedInput: 80, total: 120 }, toolCalls: [{ name: "exec_command" }] }],
  }), 1, 1);
  const rows = queryTokenUsage(db) as any[];
  expect(rows.find((row) => row.harness === "claude-code")).toMatchObject({ non_cached_tokens: 15, cached_tokens: 50, reported_total_tokens: 65 });
  expect(rows.find((row) => row.harness === "codex")).toMatchObject({ non_cached_tokens: 40, cached_tokens: 80, reported_total_tokens: 120 });
  expect(queryToolFrequency(db)).toHaveLength(2);
  expect(queryUsageOverTime(db, "month")).toHaveLength(2);
  expect(querySessionLengths(db)).toEqual([{ turn_bucket: "1-10", sessions: 2, avg_turns: 1, min_turns: 1, max_turns: 1 }]);
  db.close();
});
