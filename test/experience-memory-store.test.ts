import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AcceptedMemoryEntry, AcceptedMemoryLedger } from "../src/experience-memory";
import {
  publishAcceptedMemory,
  readPublishedMemory,
  recallPublishedMemory,
} from "../src/experience-memory-store";

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

test("publishing is deterministic and pinned hashes retain their original cards", async () => {
  const root = await mkdtemp(join(tmpdir(), "chatlog-memory-store-"));
  const firstPath = await writeLedger(root, ledger(entry("memory-a", "C001")));
  const first = await publishAcceptedMemory(root, firstPath);
  const repeated = await publishAcceptedMemory(root, firstPath);
  expect(first.ok).toBe(true);
  expect(repeated.ok).toBe(true);
  if (!first.ok || !repeated.ok) return;
  expect(repeated.value.pointer).toEqual(first.value.pointer);

  const secondPath = await writeLedger(root, ledger(entry("memory-b", "C002")));
  const second = await publishAcceptedMemory(root, secondPath);
  expect(second.ok).toBe(true);
  if (!second.ok) return;
  expect(second.value.pointer.snapshotHash).not.toBe(first.value.pointer.snapshotHash);

  const current = await readPublishedMemory(root);
  expect(current.ok && current.value.published.ledger.entries[0]!.id).toBe("memory-b");

  const pinned = await recallPublishedMemory(root, first.value.pointer.snapshotHash, "memory-a");
  expect(pinned.ok && pinned.value.lesson).toBe("lesson memory-a");
  expect((await recallPublishedMemory(root, first.value.pointer.snapshotHash, "memory-b")).ok).toBe(
    false,
  );
});

test("published snapshots fail closed when the requested hash is malformed", async () => {
  const root = await mkdtemp(join(tmpdir(), "chatlog-memory-store-invalid-"));
  await writeLedger(root, ledger(entry("memory-a", "C001")));
  expect((await publishAcceptedMemory(root)).ok).toBe(true);
  expect((await readPublishedMemory(root, "../current")).ok).toBe(false);
});

test("publishing fails closed when finalized source provenance is fabricated", async () => {
  const root = await mkdtemp(join(tmpdir(), "chatlog-memory-store-provenance-"));
  const value = ledger(entry("memory-a", "C001"));
  const path = await writeLedger(root, value);
  value.entries[0]!.provenance.candidateId = "f".repeat(20);
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  const result = await publishAcceptedMemory(root, path);
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error.message).toContain("source-bound provenance");
});
