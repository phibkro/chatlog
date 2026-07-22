import { expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { deriveCorpus } from "../src/derive";
import { loadRefinery, refineCorpus } from "../src/refinery";
import { agentRefinery, agentRefineryEvalPlan } from "../src/refinery-query";
import type { Conversation } from "../src/types";

function conversation(hash: string, index: number): Conversation {
  return {
    id: `session-${index}`, provider: "openai", harness: "codex", project: "/project", cwd: "/project", model: "model",
    startedAt: `2026-07-0${index}T00:00:00Z`, endedAt: `2026-07-0${index}T00:01:00Z`, sourcePath: `/source-${index}`, contentHash: hash,
    turns: [
      { role: "user", content: "The Nix flake build failed because the newly created source file is untracked and invisible." },
      { role: "assistant", content: "I decided the fix is to git add the new file so Nix can evaluate it.", toolCalls: [{ name: "exec" }] },
      { role: "tool", content: "exit code 0; build passed" },
      { role: "assistant", content: "Look up the documentation reference at https://nix.dev/manual/ for the API option.", toolCalls: [{ name: "WebSearch" }] },
      { role: "tool", content: "exit code 0; documentation fetched" },
      { role: "assistant", content: "Fixed and verified." },
    ],
  };
}

test("refinery enforces rule-of-three and emits curation/evaluation candidates without promotion", async () => {
  const root = await mkdtemp(join(tmpdir(), "chatlog-refinery-")); const sources: Record<string, { contentHash: string }> = {};
  for (let index = 1; index <= 3; index++) {
    const hash = String(index).repeat(64); const item = conversation(hash, index); const dir = join(root, "corpus", "objects", hash.slice(0, 2));
    await mkdir(dir, { recursive: true }); await writeFile(join(dir, `${hash}.json`), JSON.stringify(item)); sources[item.sourcePath] = { contentHash: hash };
  }
  await writeFile(join(root, "corpus", "manifest.json"), JSON.stringify({ version: 1, sources })); await deriveCorpus(root);
  expect(await refineCorpus(root, 3)).toMatchObject({ inputConversations: 3, processed: true });
  expect(await refineCorpus(root, 3)).toMatchObject({ processed: false });
  const artifact = await loadRefinery(root);
  expect(artifact.policy).toEqual({ autoPromotion: false, frequencyIsSignalNotDecision: true, referenceWikiDeferred: true });
  expect(artifact.candidates.length).toBeGreaterThanOrEqual(3);
  expect(artifact.candidates.every((candidate) => candidate.frequency.sessions >= 3)).toBe(true);
  expect(artifact.candidates.every((candidate) => candidate.status !== ("promoted" as any))).toBe(true);
  expect(artifact.candidates.find((candidate) => candidate.type === "wiki-page-later")?.status).toBe("deferred-follow-up");
  const listing = await agentRefinery(root) as any; expect(listing.policy.autoPromotion).toBe(false);
  const plan = await agentRefineryEvalPlan(root, artifact.candidates[0].id) as any;
  expect(plan.evaluation.metrics).toContain("rederivationCount");
  expect(plan.evaluation.minimumRunsPerArm).toBe(3);
  expect(plan.eligibility.eligible).toBe(false);
  expect(plan.candidate.contentHash).toMatch(/^[0-9a-f]{64}$/);
  expect(new Set(artifact.candidates[0].evidence.map((item) => item.sessionId)).size).toBe(artifact.candidates[0].evidence.length);
});
