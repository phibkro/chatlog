import { expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { agentGet, agentGrok, agentSearch } from "../src/agent-query";
import { indexConversation, openAnalysis } from "../src/analysis";
import { deriveCorpus } from "../src/derive";
import type { Conversation } from "../src/types";

test("agent queries return bounded structure and dereference pointers on demand", async () => {
  const root = await mkdtemp(join(tmpdir(), "chatlog-query-"));
  const hash = "c".repeat(64);
  const conversation: Conversation = {
    id: "session-1", provider: "openai", harness: "codex", project: "/project", cwd: "/project",
    model: "model", startedAt: "2026-07-01T00:00:00Z", endedAt: "2026-07-01T00:01:00Z",
    sourcePath: "/source", contentHash: hash,
    turns: [
      { role: "user", content: "Repair the DuckDB projection failure" },
      { role: "assistant", content: "I decided to regenerate the projection, then tests passed." },
    ],
  };
  const objectDir = join(root, "corpus", "objects", "cc");
  await mkdir(objectDir, { recursive: true });
  await writeFile(join(objectDir, `${hash}.json`), JSON.stringify(conversation));
  await writeFile(join(root, "corpus", "manifest.json"), JSON.stringify({ version: 1, sources: { "/source": { contentHash: hash } } }));
  const db = openAnalysis(join(root, "analysis", "chatlog.sqlite"));
  try {
    indexConversation(db, conversation, 1, 1);
    await deriveCorpus(root);
    const search = agentSearch(db, "DuckDB", 5);
    expect(search.hits).toHaveLength(1);
    expect(search.hits[0].snippet).toContain("[DuckDB]");
    expect(search.hits[0].pointer.uri).toBe(`chatlog://conversation/${hash}/turn/0`);
    expect((await agentGet(db, root, hash.slice(0, 12), 0) as any).turn.content).toContain("DuckDB");
    const grok = await agentGrok(db, root, "DuckDB", 1) as any;
    expect(grok.sessions[0].shape.turns).toBe(2);
    expect(grok.sessions[0].turns).toBeUndefined();
    expect(grok.sessions[0].conversation).toBeUndefined();
  } finally {
    db.close();
  }
});
