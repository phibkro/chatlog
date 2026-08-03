import { expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { insightScope, validateInsightRevision, type InsightRevision } from "../src/insights";
import {
  appendInsightTransition,
  applyInsightCommand,
  createEmptyInsightLedger,
  type InsightCommandInput,
} from "../src/insight-ledger";

const HASH = "a".repeat(64);
const EVIDENCE = `chatlog://conversation/${HASH}/turn/0` as const;

function revision(
  status: InsightRevision["status"] = "active",
  insightId = "claim-one",
): InsightRevision {
  return {
    schemaVersion: 2,
    insightId,
    revisionId: `revision-${insightId}`,
    kind: "fact",
    proposition: "A bounded claim",
    procedure: null,
    scope: insightScope({ domain: "coding" }),
    supportEvidence: [EVIDENCE],
    counterEvidence: [],
    observedAt: "2026-01-01T00:00:00.000Z",
    validTime: { start: "2026-01-01T00:00:00.000Z", end: null },
    recordedAt: "2026-01-01T00:00:00.000Z",
    status,
    supersedes: null,
    conflictsWith: [],
    duplicateOf: null,
    riskClass: "low",
    valence: "neutral",
    origin: {
      kind: "model-proposal",
      actor: "model",
      sourceHashes: [HASH],
      proposalId: "proposal-one",
    },
    authority: [
      {
        kind: "human-review",
        actor: "operator",
        authority: "reviewed",
        assertedAt: "2026-01-01T00:00:00.000Z",
        sourceHashes: [HASH],
      },
    ],
    derivation: { activity: "test", recipe: HASH, model: "model", inputHashes: [HASH] },
    confidence: [
      {
        assessor: "model",
        role: "model",
        value: 0.5,
        evidence: [EVIDENCE],
        assessedAt: "2026-01-01T00:00:00.000Z",
      },
    ],
    authoritativeDocs: [],
  };
}

function command(
  revisionValue: InsightRevision,
  ledgerHash: string | null,
  commandName: InsightCommandInput["command"] = "accept",
): InsightCommandInput {
  return {
    command: commandName,
    insightId: revisionValue.insightId,
    revision: revisionValue,
    priorRevisionId: null,
    actor: { id: "operator", kind: "operator" },
    authority: revisionValue.authority[0]!,
    recordedAt: revisionValue.recordedAt,
    reason: "explicit operator decision",
    sourceHashes: [HASH],
    priorLedgerHash: ledgerHash,
    idempotencyKey: "operator-command-one",
  };
}

test("insight revisions validate semantic, temporal, authority, and evidence fields", () => {
  const result = validateInsightRevision(revision());
  expect(result.ok).toBe(true);
  if (result.ok) expect(result.value.scope.domain).toBe("coding");
  expect(
    validateInsightRevision({ ...revision(), supportEvidence: ["not-an-evidence-uri"] }).ok,
  ).toBe(false);
});

test("ledger append is content addressed and repeated commands are idempotent", () => {
  const empty = createEmptyInsightLedger("project");
  const first = appendInsightTransition(empty, command(revision(), null));
  expect(first.ok).toBe(true);
  if (!first.ok) return;
  const repeated = appendInsightTransition(first.value, command(revision(), null));
  expect(repeated.ok).toBe(true);
  if (repeated.ok) {
    expect(repeated.idempotent).toBe(true);
    expect(repeated.value.ledgerHash).toBe(first.value.ledgerHash);
  }
  const stale = appendInsightTransition(first.value, {
    ...command(revision("active", "claim-two"), HASH),
    priorLedgerHash: "b".repeat(64),
  });
  expect(stale.ok).toBe(false);
});

test("a live ledger lock fails with a typed conflict and performs no transition", async () => {
  const root = await mkdtemp(join(tmpdir(), "chatlog-insight-lock-"));
  const lockDirectory = join(root, "memory", "insight-ledgers");
  await mkdir(lockDirectory, { recursive: true });
  await writeFile(
    join(lockDirectory, ".lock"),
    JSON.stringify({
      pid: process.pid,
      runId: "held-by-test",
      startedAt: new Date().toISOString(),
    }),
  );
  const result = await applyInsightCommand(root, command(revision(), null));
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error.code).toBe("lock-conflict");
});
