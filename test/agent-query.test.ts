import { expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { agentAsk, agentGet, agentGrok, agentSearch, agentSemanticSearch } from "../src/agent-query";
import { indexConversation, openAnalysis } from "../src/analysis";
import { deriveCorpus } from "../src/derive";
import { reconcileActiveSources } from "../src/source-authority";
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
      { role: "tool", content: "failure forbiddenpayload from tool output" },
    ],
  };
  const objectDir = join(root, "corpus", "objects", "cc");
  await mkdir(objectDir, { recursive: true });
  await writeFile(join(objectDir, `${hash}.json`), JSON.stringify(conversation));
  await writeFile(join(root, "corpus", "manifest.json"), JSON.stringify({ version: 1, sources: { "/source": { contentHash: hash } } }));
  const db = openAnalysis(join(root, "analysis", "chatlog.sqlite"));
  try {
    const staleHash = "d".repeat(64);
    indexConversation(db, {
      ...conversation,
      contentHash: staleHash,
      endedAt: "2026-06-30T00:01:00Z",
      turns: [{ role: "user", content: "Superseded historical content." }],
    }, 0, 1);
    indexConversation(db, conversation, 1, 1);
    reconcileActiveSources(db, { "/source": { contentHash: hash } });
    await deriveCorpus(root);
    const search = agentSearch(db, "DuckDB", 5);
    expect(search.hits).toHaveLength(1);
    expect(search.hits[0].snippet).toContain("[DuckDB]");
    expect(search.hits[0].pointer.uri).toBe(`chatlog://conversation/${hash}/turn/0`);
    expect((await agentGet(db, root, hash.slice(0, 12), 0) as any).turn.content).toContain("DuckDB");
    await expect(agentGet(db, root, staleHash, 0)).rejects.toThrow("conversation not found");
    const grok = await agentGrok(db, root, "DuckDB", 1) as any;
    expect(grok.sessions[0].shape.turns).toBe(3);
    expect(grok.sessions[0].turns).toBeUndefined();
    expect(grok.sessions[0].conversation).toBeUndefined();
    let semanticCandidates: any[] = [];
    const semantic = await agentSemanticSearch(db, root, "DuckDB failure", 1, 5, (async (_root: string, _query: string, candidates: any[]) => {
      semanticCandidates = candidates;
      return {
        rankings: candidates.map((candidate, index) => ({ id: candidate.id, score: 90 - index, reason: "same meaning" })),
        provider: "test", requestedModel: "test", responseModel: "test", cached: false, requestHash: "d".repeat(64),
        egress: { performed: true, queryChars: 20, candidateCount: candidates.length, candidateChars: 20, maxCandidateChars: 600, sentFields: [], excluded: [] },
      };
    }) as any) as any;
    expect(semantic.mode).toBe("hosted-llm-rerank");
    expect(semantic.hits[0].semanticScore).toBe(90);
    expect(JSON.stringify(semanticCandidates)).not.toContain("forbiddenpayload");
    const ask = await agentAsk(db, root, "what did I try last time for DuckDB failure", 1, (async (_root: string, _query: string, candidates: any[]) => ({
      rankings: candidates.map((candidate) => ({ id: candidate.id, score: 95, reason: "same failure" })),
      provider: "test", requestedModel: "test", responseModel: "test", cached: false, requestHash: "e".repeat(64),
      egress: { performed: true, queryChars: 20, candidateCount: candidates.length, candidateChars: 20, maxCandidateChars: 600, sentFields: [], excluded: [] },
    })) as any) as any;
    expect(ask.mode).toBe("hosted-llm-rerank");
    expect(ask.sessions[0].semanticMatches[0].reason).toBe("same failure");
  } finally {
    db.close();
  }
});
