import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  compileMemorySnapshot,
  estimateMemoryTokens,
  prepareStartupMemory,
  recallMemoryCard,
  TIER_ONE_MAX_TOKENS,
  validateAcceptedMemoryLedger,
  type AcceptedMemoryEntry,
  type AcceptedMemoryLedger,
} from "../src/experience-memory";

function entry(id: string, overrides: Partial<AcceptedMemoryEntry> = {}): AcceptedMemoryEntry {
  return {
    id,
    status: "accepted",
    judgment: "correct",
    valence: "positive",
    provenance: {
      packetHash: "a".repeat(64),
      proposalSetHash: "b".repeat(64),
      operatorReviewHash: "c".repeat(64),
      candidateAlias: "C001",
      candidateId: "d".repeat(20),
    },
    trigger: `working on trigger ${id}`,
    scope: { kind: "repository", value: "git:chatlog" },
    polarity: "prefer",
    action: `Recall ${id}, then run its smallest verification.`,
    situation: `Situation for ${id} includes PRIVATE-EVIDENCE-${id}.`,
    outcome: `Observed outcome for ${id}.`,
    lesson: `Lesson for ${id}.`,
    confidence: 0.9,
    freshness: "current",
    canonicalDocs: [`design-specs/${id}.md`],
    evidencePointers: [`chatlog://conversation/${id}`],
    ...overrides,
  };
}

function ledger(entries: Array<AcceptedMemoryEntry>): AcceptedMemoryLedger {
  return {
    schemaVersion: 1,
    ledgerId: "tracer-v1",
    projectIdentity: "git:chatlog",
    entries,
  };
}

test("strict validation accepts only a complete v1 accepted ledger", () => {
  expect(validateAcceptedMemoryLedger(ledger([entry("memory-a")])).ok).toBe(true);
  expect(
    validateAcceptedMemoryLedger({ ...ledger([entry("memory-a")]), unexpected: true }).ok,
  ).toBe(false);
});

test("strict validation requires exact operator-review provenance", () => {
  const invalid = entry("memory-a") as unknown as Record<string, unknown>;
  invalid.provenance = {
    packetHash: "a".repeat(64),
    proposalSetHash: "b".repeat(64),
    operatorReviewHash: "not-a-hash",
    candidateAlias: "C001",
    candidateId: "d".repeat(20),
  };
  expect(validateAcceptedMemoryLedger(ledger([invalid as unknown as AcceptedMemoryEntry])).ok).toBe(
    false,
  );
});

test.each([
  ["non-accepted", { status: "rejected" }],
  ["stale", { freshness: "stale" }],
  ["mixed", { valence: "mixed" }],
  ["unjudged", { judgment: "unjudged" }],
])("strict validation rejects %s entries", (_label, override) => {
  const invalid = entry("memory-a") as unknown as Record<string, unknown>;
  Object.assign(invalid, override);
  const result = validateAcceptedMemoryLedger(ledger([invalid as unknown as AcceptedMemoryEntry]));
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error.code).toBe("invalid-ledger");
});

test("compilation is byte-identical and independent of ledger entry order", () => {
  const first = compileMemorySnapshot(ledger([entry("memory-b"), entry("memory-a")]));
  const second = compileMemorySnapshot(ledger([entry("memory-a"), entry("memory-b")]));
  expect(first.ok).toBe(true);
  expect(second.ok).toBe(true);
  if (!first.ok || !second.ok) return;
  expect(first.value.content).toBe(second.value.content);
  expect(first.value.sha256).toBe(second.value.sha256);
  expect(first.value.entryIds).toEqual(["memory-a", "memory-b"]);
  expect(createHash("sha256").update(first.value.content).digest("hex")).toBe(first.value.sha256);
});

test("Tier 1 excludes evidence, card details, confidence, and incidental metadata", () => {
  const result = compileMemorySnapshot(ledger([entry("memory-a")]));
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.value.content).toContain("USE WHEN: working on trigger memory-a");
  expect(result.value.content).toContain("Polarity: prefer");
  expect(result.value.content).not.toContain("PRIVATE-EVIDENCE");
  expect(result.value.content).not.toContain("chatlog://");
  expect(result.value.content).not.toContain("Observed outcome");
  expect(result.value.content).not.toContain("0.9");
  expect(result.value.estimatedTokens).toBe(estimateMemoryTokens(result.value.content));
});

test("compiler fails closed above the 2,000-token conservative bound", () => {
  const entries = Array.from({ length: 24 }, (_, index) =>
    entry(`memory-${String(index).padStart(2, "0")}`, {
      trigger: "t".repeat(480),
      action: "a".repeat(480),
    }),
  );
  const result = compileMemorySnapshot(ledger(entries));
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.error.code).toBe("snapshot-too-large");
    expect(result.error.message).toContain(String(TIER_ONE_MAX_TOKENS));
  }
});

test("bounded direct recall returns the complete current Tier 2 card", () => {
  const source = entry("memory-a");
  const result = recallMemoryCard(ledger([source]), "memory-a");
  expect(result).toEqual({
    ok: true,
    value: {
      id: source.id,
      situation: source.situation,
      outcome: source.outcome,
      lesson: source.lesson,
      action: source.action,
      scope: source.scope,
      confidence: source.confidence,
      freshness: "current",
      status: "accepted",
      canonicalDocs: source.canonicalDocs,
      evidencePointers: source.evidencePointers,
    },
  });
  expect(recallMemoryCard(ledger([source]), "unknown").ok).toBe(false);
  expect(recallMemoryCard(ledger([source]), "../memory-a").ok).toBe(false);
});

test("startup emits once, then pins exact bytes for the session", async () => {
  const pinDirectory = await mkdtemp(join(tmpdir(), "chatlog-memory-pins-"));
  const firstSnapshot = compileMemorySnapshot(ledger([entry("memory-a")]));
  const nextSnapshot = compileMemorySnapshot(ledger([entry("memory-b")]));
  expect(firstSnapshot.ok).toBe(true);
  expect(nextSnapshot.ok).toBe(true);
  if (!firstSnapshot.ok || !nextSnapshot.ok) return;

  const ignored = await prepareStartupMemory({
    source: "resume",
    sessionId: "session-1",
    snapshot: firstSnapshot.value,
    pinDirectory,
  });
  expect(ignored).toEqual({ ok: true, value: { emitted: false, reason: "not-startup" } });

  const first = await prepareStartupMemory({
    source: "startup",
    sessionId: "session-1",
    snapshot: firstSnapshot.value,
    pinDirectory,
  });
  expect(first).toEqual({
    ok: true,
    value: {
      emitted: true,
      snapshotHash: firstSnapshot.value.sha256,
      content: firstSnapshot.value.content,
      pinned: false,
    },
  });

  const pinned = await prepareStartupMemory({
    source: "startup",
    sessionId: "session-1",
    snapshot: nextSnapshot.value,
    pinDirectory,
  });
  expect(pinned).toEqual({
    ok: true,
    value: {
      emitted: true,
      snapshotHash: firstSnapshot.value.sha256,
      content: firstSnapshot.value.content,
      pinned: true,
    },
  });

  const pinFiles = Array.from(new Bun.Glob("*.json").scanSync(pinDirectory));
  expect(pinFiles).toHaveLength(1);
  const persisted = JSON.parse(await readFile(join(pinDirectory, pinFiles[0]!), "utf8"));
  expect(persisted.content).toBe(firstSnapshot.value.content);
  expect(persisted.snapshotHash).toBe(firstSnapshot.value.sha256);
});
