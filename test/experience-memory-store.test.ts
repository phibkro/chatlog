import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AcceptedMemoryEntry, AcceptedMemoryLedger } from "../src/experience-memory";
import { publishAcceptedMemory, readPublishedMemory } from "../src/experience-memory-store";

function entry(id: string, alias: string): AcceptedMemoryEntry {
  return {
    id,
    status: "accepted",
    judgment: "correct",
    valence: "positive",
    provenance: {
      packetHash: "a".repeat(64),
      proposalSetHash: "b".repeat(64),
      operatorReviewHash: "c".repeat(64),
      candidateAlias: alias,
      candidateId: "d".repeat(20),
    },
    trigger: `trigger ${id}`,
    scope: { kind: "global", value: null },
    polarity: "check",
    action: `recall ${id}`,
    situation: `situation ${id}`,
    outcome: `outcome ${id}`,
    lesson: `lesson ${id}`,
    confidence: 0.9,
    freshness: "current",
    canonicalDocs: ["design-specs/experience-memory.md"],
    evidencePointers: [`chatlog://conversation/${"e".repeat(64)}/turn/1`],
  };
}

function ledger(memory: AcceptedMemoryEntry): AcceptedMemoryLedger {
  return {
    schemaVersion: 1,
    ledgerId: "store-test",
    projectIdentity: "/project",
    entries: [memory],
  };
}

async function writeLedger(root: string, value: AcceptedMemoryLedger): Promise<string> {
  const entries = value.entries;
  const packetHash = entries[0]!.provenance.packetHash;
  const proposals = {
    schemaVersion: 1,
    packetHash,
    generator: { provider: "test" },
    proposals: Object.fromEntries(
      entries.map((memory) => [
        memory.provenance.candidateAlias,
        { lesson: memory.lesson, suggestedValence: memory.valence, rationale: "test" },
      ]),
    ),
  };
  const proposalBytes = `${JSON.stringify(proposals, null, 2)}\n`;
  const proposalSetHash = createHash("sha256").update(proposalBytes).digest("hex");
  const reviews = {
    schemaVersion: 1,
    packetHash,
    proposalSetHash,
    reviewer: { id: "test" },
    reviews: Object.fromEntries(
      entries.map((memory) => [
        memory.provenance.candidateAlias,
        {
          status: "reviewed",
          judgment: "correct",
          valence: memory.valence,
          feedback: "",
        },
      ]),
    ),
  };
  const reviewBytes = `${JSON.stringify(reviews, null, 2)}\n`;
  const operatorReviewHash = createHash("sha256").update(reviewBytes).digest("hex");
  for (const memory of entries) {
    memory.provenance.proposalSetHash = proposalSetHash;
    memory.provenance.operatorReviewHash = operatorReviewHash;
  }
  const publicDirectory = join(root, "derived", "adjudication", "refinery", packetHash, "public");
  const privateDirectory = join(root, "derived", "adjudication", "refinery-private", packetHash);
  await Promise.all([
    mkdir(publicDirectory, { recursive: true }),
    mkdir(privateDirectory, { recursive: true }),
  ]);
  await Promise.all([
    writeFile(join(publicDirectory, "proposals.json"), proposalBytes),
    writeFile(join(publicDirectory, "operator-reviews.json"), reviewBytes),
    writeFile(
      join(privateDirectory, "manifest.json"),
      `${JSON.stringify({
        schemaVersion: 1,
        packetHash,
        candidates: entries.map((memory) => ({
          candidateAlias: memory.provenance.candidateAlias,
          candidateId: memory.provenance.candidateId,
        })),
      })}\n`,
    ),
  ]);
  const directory = join(root, "memory");
  await mkdir(directory, { recursive: true });
  const path = join(directory, "accepted-ledger.json");
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  return path;
}

test("v1 publishing is disabled and requires an explicit v2 migration", async () => {
  const root = await mkdtemp(join(tmpdir(), "chatlog-memory-store-"));
  const path = await writeLedger(root, ledger(entry("memory-a", "C001")));
  const result = await publishAcceptedMemory(root, path);
  expect(result.ok).toBe(false);
  if (!result.ok)
    expect(result.error.message).toContain("migrate and apply an insight ledger explicitly");
  expect((await readPublishedMemory(root)).ok).toBe(false);
});

test("published snapshots fail closed when the requested hash is malformed", async () => {
  const root = await mkdtemp(join(tmpdir(), "chatlog-memory-store-invalid-"));
  expect((await readPublishedMemory(root, "../current")).ok).toBe(false);
});

test("disabled v1 publishing does not evaluate or publish fabricated provenance", async () => {
  const root = await mkdtemp(join(tmpdir(), "chatlog-memory-store-provenance-"));
  const value = ledger(entry("memory-a", "C001"));
  const path = await writeLedger(root, value);
  value.entries[0]!.provenance.candidateId = "f".repeat(20);
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  const result = await publishAcceptedMemory(root, path);
  expect(result.ok).toBe(false);
  if (!result.ok)
    expect(result.error.message).toContain("v1 accepted-memory publishing is disabled");
});
