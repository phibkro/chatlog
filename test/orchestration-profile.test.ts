import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { classifyOrchestrationTurn, deriveOrchestrationProfile, loadOrchestrationProfile, resolveOrchestrationPointer, type OrchestrationLabel } from "../src/orchestration-profile";
import type { Conversation } from "../src/types";

const hashes = ["a".repeat(64), "b".repeat(64), "c".repeat(64), "d".repeat(64)];
const turns = [
  "Continue autonomously through the tracer bullet, execute it, then self-propel. No need to wait for operator review.",
  "Use the recommended option and proceed with the next bounded implementation.",
  "You are the sole writer. The spec is frozen; run the full gate suite. Stop-and-report at a real wall.",
  "Compare A/B control/treatment options with a recommendation; stop and report before changing the frozen contract.",
];
const labels: OrchestrationLabel[] = [
  { split: "calibration", conversationHash: hashes[0], turnIndex: 0, expectedPole: "autonomy-grant", expectedSignal: "self-propel" },
  { split: "calibration", conversationHash: hashes[2], turnIndex: 0, expectedPole: "determinism-impose", expectedSignal: "one-writer" },
  { split: "held-out", conversationHash: hashes[1], turnIndex: 0, expectedPole: "autonomy-grant", expectedSignal: "recommend-and-proceed" },
  { split: "held-out", conversationHash: hashes[3], turnIndex: 0, expectedPole: "determinism-impose", expectedSignal: "stop-and-report" },
];

test("orchestration lean is local, evidence-bound, validated, and content-idempotent", async () => {
  const root = await mkdtemp(join(tmpdir(), "chatlog-orchestration-"));
  for (let index = 0; index < hashes.length; index++) {
    const conversation: Conversation = { id: `s${index}`, provider: "test", harness: "test", project: "/test", cwd: "/test", model: `snapshot-model-${index}`, startedAt: "2026-07-01T00:00:00Z", endedAt: "2026-07-01T00:01:00Z", sourcePath: `/s${index}`, contentHash: hashes[index], turns: [{ role: "user", content: turns[index] }] };
    const dir = join(root, "corpus", "objects", hashes[index].slice(0, 2)); await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `${hashes[index]}.json`), JSON.stringify(conversation));
  }
  await mkdir(join(root, "derived"), { recursive: true });
  await writeFile(join(root, "derived", "current-hashes.jsonl"), hashes.map((conversationHash) => JSON.stringify({ conversationHash })).join("\n") + "\n");
  const labelsPath = join(root, "labels.json"); await writeFile(labelsPath, JSON.stringify(labels));

  const first = await deriveOrchestrationProfile(root, labelsPath); const second = await deriveOrchestrationProfile(root, labelsPath);
  expect(first.processed).toBe(true); expect(second.processed).toBe(false); expect(second.contentHash).toBe(first.contentHash);
  expect(new Bun.CryptoHasher("sha256").update(await readFile(first.artifactPath, "utf8")).digest("hex")).toBe(first.contentHash);
  const report = await loadOrchestrationProfile(root);
  expect(report.outputKind).toBe("orchestration-lean"); expect(report.egress).toMatchObject({ performed: false, surface: "none", hostedCalls: 0 });
  expect(report.policy).toMatchObject({ autoPromotion: false, roleSegmentation: false });
  expect(report.validation.calibration.signalAgreement).toBe(1); expect(report.validation.heldOut.accuracy).toBeGreaterThan(report.validation.heldOut.baseRate);
  for (const evidence of report.inventories.flatMap((item: any) => item.evidence)) expect((await resolveOrchestrationPointer(root, evidence.pointer)).content).toBeTruthy();
  expect(JSON.stringify(report)).not.toContain("snapshot-model-");
});

test("miner can emit both poles for conditional autonomy", () => {
  const found = classifyOrchestrationTurn("Self-propel through the full gate suite, then stop-and-report at a true decision.");
  expect(new Set(found.map((item) => item.pole))).toEqual(new Set(["autonomy-grant", "determinism-impose"]));
});
