import { expect, test } from "bun:test";
import {
  candidatesFromEvidenceRows,
  candidatesFromInsightRevisions,
  type ContextEvidenceRow,
} from "../src/context-candidates";
import type { ContextRequest } from "../src/context-types";
import type { InsightRevision } from "../src/insights";

const HASH = "a".repeat(64);
const request: ContextRequest = {
  task: "Fix router lock contention",
  query: "router lock contention",
  contextSessionId: "session",
  target: { provider: "openai", harness: "codex", model: "codex", role: "coding-agent" },
  capabilities: {
    startupHook: true,
    toolRecall: true,
    freshSessionPrompt: true,
    checkpoint: false,
    acknowledgment: false,
    maximumContextTokens: 100_000,
    encodingOverheadTokens: 10,
    receiptEvidence: ["hook-output"],
  },
  scope: {
    user: null,
    organization: null,
    project: "/repo",
    repository: "/repo",
    path: "/repo/src",
    harness: "codex",
    model: "codex",
    tool: null,
    domain: "coding",
  },
  allowedItemKinds: ["evidence", "insight", "procedure", "current-state"],
  riskCeiling: "medium",
  freshAfter: null,
  budget: { tokens: 1_000, results: 10, latencyMs: 100, costUsd: 0 },
  fixedInstructionTokens: 5,
  deliveryMode: "tool-recall",
  exposure: "evidence-only",
  now: "2026-08-03T12:00:00.000Z",
};

const insight: InsightRevision = {
  schemaVersion: 2,
  insightId: "router-lock",
  revisionId: "router-lock-active-1",
  kind: "procedure",
  proposition: "Router writes require serialized lock custody.",
  procedure: "Acquire the router lock before mutating shared state.",
  scope: request.scope,
  supportEvidence: [`chatlog://event/${HASH}/${HASH}`],
  counterEvidence: [],
  observedAt: "2026-08-01T12:00:00.000Z",
  validTime: { start: "2026-08-01T12:00:00.000Z", end: null },
  recordedAt: "2026-08-01T12:00:00.000Z",
  status: "active",
  supersedes: null,
  conflictsWith: [],
  duplicateOf: null,
  riskClass: "medium",
  valence: "positive",
  origin: { kind: "human-review", actor: "operator", sourceHashes: [HASH], proposalId: null },
  authority: [
    {
      kind: "human-review",
      actor: "operator",
      authority: "accept",
      assertedAt: "2026-08-01T12:00:00.000Z",
      sourceHashes: [HASH],
    },
  ],
  derivation: null,
  confidence: [
    {
      assessor: "operator",
      role: "human",
      value: 0.9,
      evidence: [`chatlog://event/${HASH}/${HASH}`],
      assessedAt: "2026-08-01T12:00:00.000Z",
    },
  ],
  authoritativeDocs: [],
};

test("active governed insights become scored context candidates without changing authority", () => {
  const candidates = candidatesFromInsightRevisions([insight], request);
  expect(candidates).toHaveLength(1);
  expect(candidates[0]).toMatchObject({
    id: "router-lock-active-1",
    kind: "procedure",
    authority: "human-review",
    advisory: true,
    riskClass: "medium",
    evidenceReferences: insight.supportEvidence,
  });
  expect(candidates[0]!.scores.lexical).toBeGreaterThan(0);
  expect(candidates[0]!.estimatedTokens).toBeGreaterThan(0);
});

test("canonical event rows remain source-bound evidence candidates", () => {
  const row: ContextEvidenceRow = {
    eventId: HASH,
    batchHash: "b".repeat(64),
    kind: "human.correction",
    payload: '{"content":"Fix router lock contention"}',
    occurredAt: "2026-08-02T12:00:00.000Z",
    project: "/repo",
    cwd: "/repo/src",
    harness: "codex",
    model: "codex",
    domain: "coding",
  };
  const candidates = candidatesFromEvidenceRows([row], request);
  expect(candidates).toHaveLength(1);
  expect(candidates[0]).toMatchObject({
    id: HASH,
    kind: "evidence",
    authority: "source-observation",
    advisory: false,
    evidenceReferences: [`chatlog://event/${row.batchHash}/${row.eventId}`],
  });
});
test("source_path-only matches propagate the exact canonical source path", () => {
  const row: ContextEvidenceRow = {
    eventId: "c".repeat(64),
    batchHash: "d".repeat(64),
    kind: "human.correction",
    payload: '{"content":"Fix router lock contention"}',
    occurredAt: "2026-08-02T12:00:00.000Z",
    project: "/repo",
    cwd: "/other-project",
    sourcePath: "/repo/src/evidence/",
    harness: "codex",
    model: "codex",
    domain: "coding",
  };
  const candidates = candidatesFromEvidenceRows([row], request);
  expect(candidates[0]?.scope.path).toBe("/repo/src/evidence");
});

test("evidence projection drops rows outside the exact recall path scope", () => {
  const row: ContextEvidenceRow = {
    eventId: "e".repeat(64),
    batchHash: "f".repeat(64),
    kind: "human.correction",
    payload: '{"content":"Fix router lock contention"}',
    occurredAt: "2026-08-02T12:00:00.000Z",
    project: "/repo",
    cwd: "/repo-other/src",
    sourcePath: "/repo-archive/src",
    harness: "codex",
    model: "codex",
    domain: "coding",
  };
  expect(candidatesFromEvidenceRows([row], request)).toHaveLength(0);
});
