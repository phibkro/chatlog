import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { deriveRoleSegmentation, inferAgentRole, loadRoleSegmentation, type AgentRole, type RoleLabel } from "../src/role-segmentation";
import { deriveCorpus } from "../src/derive";
import type { Conversation } from "../src/types";

const rolePrompts: Record<Exclude<AgentRole, "unclassified">, string> = {
  manager: "Take on the role as agent manager-orchestrator and keep the lane moving.",
  advisor: "Web research only. Act as the read-only advisor; do not implement.",
  reviewer: "Launching skill: code-review. You are the independent reviewer.",
  worker: "Implement Task 2. You are the sole writer in the isolated worktree.",
};
const signalPrompts: Record<Exclude<AgentRole, "unclassified">, string> = {
  manager: "Continue autonomously until a true operator decision is needed.",
  advisor: "Great! Continue autonomously through the next bounded tracer bullet and execute it.",
  reviewer: "Read-only verifier: require the full gate suite before acceptance.",
  worker: "Build only in this tree as sole writer; stop-and-report at a wall.",
};

function fixture(hash: string, role: Exclude<AgentRole, "unclassified">, index: number): Conversation {
  return {
    id: `${role}-${index}`, provider: "test", harness: index % 2 ? "harness-a" : "harness-b", project: `/project-${index % 2}`, cwd: "/test", model: `ephemeral-${index}`,
    startedAt: "2026-07-01T00:00:00Z", endedAt: "2026-07-01T00:01:00Z", sourcePath: `/${role}-${index}`, contentHash: hash,
    turns: [{ role: "user", content: rolePrompts[role] }, ...Array.from({ length: 10 }, () => ({ role: "user", content: signalPrompts[role] }))],
  };
}

test("explicit launch anchors outrank later interaction vocabulary", () => {
  const conversation = fixture("f".repeat(64), "manager", 0);
  conversation.turns.push({ role: "user", content: "Ask an independent reviewer to try to falsify it." });
  expect(inferAgentRole(conversation)).toMatchObject({ role: "manager", confidence: "high" });
});

test("role segmentation is labelled, distinguishable, local, and idempotent", async () => {
  const root = await mkdtemp(join(tmpdir(), "chatlog-roles-")); const labels: RoleLabel[] = []; const hashes: string[] = [];
  const sources: Record<string, { contentHash: string }> = {};
  let index = 1;
  for (const role of ["manager", "worker", "reviewer", "advisor"] as const) for (let sample = 0; sample < 2; sample++) {
    const hash = index.toString(16).padStart(64, role.charCodeAt(0).toString(16)[0]); index++; hashes.push(hash);
    const conversation = fixture(hash, role, sample); const dir = join(root, "corpus", "objects", hash.slice(0, 2)); await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `${hash}.json`), JSON.stringify(conversation)); labels.push({ conversationHash: hash, evidenceTurnIndex: 0, expectedRole: role });
    sources[conversation.sourcePath] = { contentHash: conversation.contentHash };
  }
  await writeFile(join(root, "corpus", "manifest.json"), JSON.stringify({ version: 1, sources }));
  await deriveCorpus(root);
  const labelsPath = join(root, "role-labels.json"); await writeFile(labelsPath, JSON.stringify(labels));
  const first = await deriveRoleSegmentation(root, labelsPath); const second = await deriveRoleSegmentation(root, labelsPath);
  expect(first.processed).toBe(true); expect(second).toMatchObject({ processed: false, contentHash: first.contentHash });
  expect(new Bun.CryptoHasher("sha256").update(await readFile(first.artifactPath, "utf8")).digest("hex")).toBe(first.contentHash);
  const report = await loadRoleSegmentation(root);
  expect(report.validation.roleInference).toMatchObject({ sampleSize: 8, accuracy: 1, contradictionRate: 0 });
  expect(report.validation.distinguishability.distinguishablePairs.length).toBeGreaterThan(0);
  expect(report.taxonomy.map((item: any) => item.role)).toEqual(["reviewer", "advisor", "manager", "worker"]);
  expect(report.egress).toMatchObject({ performed: false, surface: "none", hostedCalls: 0 });
  expect(report.policy).toMatchObject({ autoPromotion: false, slice3EffectivenessRanking: "not started" });
  expect(JSON.stringify(report)).not.toContain("ephemeral-");
});
