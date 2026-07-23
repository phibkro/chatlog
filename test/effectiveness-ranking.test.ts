import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { deriveEffectivenessRanking, loadEffectivenessRanking } from "../src/effectiveness-ranking";
import type { Conversation } from "../src/types";

const sha = (text: string) => new Bun.CryptoHasher("sha256").update(text).digest("hex");

test("promotion-v1 metrics rank an evidence-bound role pattern without default egress", async () => {
  const root = await mkdtemp(join(tmpdir(), "chatlog-effectiveness-")); const conversationHash = "a".repeat(64);
  const conversation: Conversation = { id: "worker", provider: "test", harness: "test", project: "/test", cwd: "/test", model: "transient", startedAt: "2026-07-01T00:00:00Z", endedAt: "2026-07-01T00:01:00Z", sourcePath: "/test", contentHash: conversationHash, turns: [{ role: "user", content: "Build the tracer as sole writer and stop-and-report at a wall." }] };
  const corpusDir = join(root, "corpus", "objects", "aa"); await mkdir(corpusDir, { recursive: true }); await writeFile(join(corpusDir, `${conversationHash}.json`), JSON.stringify(conversation));

  const pointer = `chatlog://conversation/${conversationHash}/turn/0`;
  const roleArtifact = { profiles: [{ role: "worker", evidence: [{ pointer, snippet: conversation.turns[0].content, signal: "one-writer", pole: "determinism-impose" }] }, { role: "advisor", evidence: [{ pointer, snippet: conversation.turns[0].content, signal: "one-writer", pole: "determinism-impose" }] }] };
  const roleText = JSON.stringify(roleArtifact) + "\n"; const roleHash = sha(roleText); const roleRel = `orchestration-roles/${roleHash}.json`;
  await mkdir(join(root, "derived", "orchestration-roles"), { recursive: true }); await writeFile(join(root, "derived", roleRel), roleText);
  await writeFile(join(root, "derived", "orchestration-roles-manifest.json"), JSON.stringify({ version: 1, current: { artifactPath: roleRel, contentHash: roleHash } }));

  const runs = ["1", "2", "3"].flatMap((pairId) => [
    { pairId, arm: "control", gatePassed: true, tokensToGate: 100, wallClockMs: 20, interventions: 0, rederivationCount: 1 },
    { pairId, arm: "treatment", gatePassed: true, tokensToGate: 70, wallClockMs: 20, interventions: 0, rederivationCount: 1 },
  ]);
  const treatmentText = "---\nname: bounded-worker\ndescription: evaluation only\n---\n"; const treatmentPath = join(root, "bounded-worker.md"); await writeFile(treatmentPath, treatmentText);
  const experiment = { schema: "agent-eval/promotion-v1", candidate: { id: "worker-pattern", contentHash: roleHash, channel: "skill" }, curation: { accepted: true, installedArtifact: treatmentPath, installedContentHash: sha(treatmentText) }, runs };
  await mkdir(join(root, "analysis", "pilot", "traces"), { recursive: true }); await writeFile(join(root, "analysis", "pilot", "promotion-results.json"), JSON.stringify(experiment));
  for (const pairId of ["1", "2", "3"]) await writeFile(join(root, "analysis", "pilot", "traces", `pair-${pairId}-treatment.jsonl`), '{"name":"Skill","input":{"skill":"bounded-worker"}}\n');
  const harness = join(root, "fake-agent-eval"); await mkdir(join(harness, "src"), { recursive: true }); await writeFile(join(harness, "src", "promotion-runner.ts"), "// local runner fixture\n");
  await writeFile(join(harness, "src", "promotion-score.ts"), `const e=await Bun.file(Bun.argv[2]).json(); console.log(JSON.stringify({schema:e.schema,candidate:e.candidate,control:{runs:3,gatePassRate:1,medianTokensToGate:100,censoredTokenRuns:0,medianWallClockMs:20,medianInterventions:0,medianRederivationCount:1},treatment:{runs:3,gatePassRate:1,medianTokensToGate:70,censoredTokenRuns:0,medianWallClockMs:20,medianInterventions:0,medianRederivationCount:1},comparison:{gateRegressed:false,rederivationImproved:false,tokensImproved:true},recommendation:'keep'}));\n`);
  const config = { schema: "chatlog/orchestration-effectiveness-pilot-v1", role: "worker", candidatePattern: "bounded-worker", alternative: "baseline", experimentPath: "analysis/pilot/promotion-results.json", agentEvalRoot: harness, realTaskReferencePath: join(root, "analysis", "pilot", "promotion-results.json"), minimumPairs: 3, pilotEgress: { performed: true, hostedCalls: 6, surface: "synthetic fixture only", authorization: "test", maxBudgetUsdPerCall: 1 } };
  await mkdir(join(root, "eval"), { recursive: true }); await writeFile(join(root, "eval", "effectiveness-pilot.json"), JSON.stringify(config));

  const first = await deriveEffectivenessRanking(root); const second = await deriveEffectivenessRanking(root); const report = await loadEffectivenessRanking(root);
  expect(first.processed).toBe(true); expect(second).toMatchObject({ processed: false, contentHash: first.contentHash });
  expect(new Bun.CryptoHasher("sha256").update(await readFile(first.artifactPath, "utf8")).digest("hex")).toBe(first.contentHash);
  expect(report.ranking).toMatchObject({ winner: "bounded-worker", loser: "baseline", metrics: { recommendation: "keep" } });
  expect(report.ranking.evidence[0].pointer).toBe(pointer);
  expect(report.egress.defaultDerivation).toEqual({ performed: false, surface: "none", hostedCalls: 0 });
  expect(report.scaleUp.oneCandidatePerRole).toMatchObject({ candidates: 2, hostedCalls: 12, maximumBudgetUsd: 12 });
  expect(report.scaleUp.realTaskReference.oneCandidatePerRole).toMatchObject({ hostedCalls: 12, retainedWorktreesAndTabs: 12 });
  expect(report.policy).toMatchObject({ autoPromotion: false, slice4ProfileGeneration: "not started" });
  expect(JSON.stringify(report)).not.toContain("transient");
});
