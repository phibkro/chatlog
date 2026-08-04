import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { assembleInsightCommand } from "../src/insight-assembler";
import { compileInsightProjection } from "../src/insight-compiler";
import {
  appendInsightTransition,
  createEmptyInsightLedger,
  type InsightCommandInput,
} from "../src/insight-ledger";
import { insightScope, projectInsightState, type InsightRevision } from "../src/insights";
import {
  ADJUDICATION_SELECTION_RECIPE,
  type AdjudicationPacket,
  type AdjudicationPrivateManifest,
  type HumanAdjudicationAnswers,
} from "../src/refinery-adjudication";
import type { PromotionCandidate, RefineryArtifact } from "../src/refinery";
import type { MemoryProposalSet, OperatorReviews } from "../src/workbench/memory-lab";

const HASH = "c".repeat(64);
const EVIDENCE = `chatlog://conversation/${HASH}/turn/0`;

function makeRevision(
  status: InsightRevision["status"],
  insightId: string,
  counterEvidence: string[] = [],
): InsightRevision {
  return {
    schemaVersion: 2,
    insightId,
    revisionId: `${insightId}-${status}-${counterEvidence.length}`,
    kind: "preference",
    proposition: "Prefer explicit operator confirmation",
    procedure: "Ask before activation",
    scope: insightScope({ domain: "coding", project: "project" }),
    supportEvidence: [EVIDENCE],
    counterEvidence,
    observedAt: "2026-01-01T00:00:00.000Z",
    validTime: { start: "2026-01-01T00:00:00.000Z", end: null },
    recordedAt: "2026-01-01T00:00:00.000Z",
    status,
    supersedes: null,
    conflictsWith: [],
    duplicateOf: null,
    riskClass: "low",
    valence: "positive",
    origin: { kind: "model-proposal", actor: "model", sourceHashes: [HASH], proposalId: insightId },
    authority: [
      {
        kind: "human-assertion",
        actor: "operator",
        authority: "explicit",
        assertedAt: "2026-01-01T00:00:00.000Z",
        sourceHashes: [HASH],
      },
    ],
    derivation: { activity: "test", recipe: HASH, model: null, inputHashes: [HASH] },
    confidence: [
      {
        assessor: "operator",
        role: "human",
        value: 1,
        evidence: [EVIDENCE],
        assessedAt: "2026-01-01T00:00:00.000Z",
      },
    ],
    authoritativeDocs: [],
  };
}

function next(
  revision: InsightRevision,
  ledgerHash: string,
  priorRevisionId: string | null,
  command: InsightCommandInput["command"],
  relatedInsightId?: string,
): InsightCommandInput {
  return {
    command,
    insightId: relatedInsightId ?? revision.insightId,
    revision,
    priorRevisionId,
    relatedInsightId: relatedInsightId ?? null,
    relatedRevisionId: relatedInsightId ? priorRevisionId : null,
    actor: { id: "operator", kind: "operator" },
    authority: revision.authority[0]!,
    recordedAt: "2026-01-01T00:00:00.000Z",
    reason: command,
    sourceHashes: [HASH],
    priorLedgerHash: ledgerHash,
    idempotencyKey: `${command}-${revision.revisionId}`,
  };
}

test("dispute and resolve-dispute preserve history and current state", () => {
  let ledger = createEmptyInsightLedger("project");
  const accepted = appendInsightTransition(
    ledger,
    next(makeRevision("active", "old"), ledger.ledgerHash, null, "accept"),
  );
  expect(accepted.ok).toBe(true);
  if (!accepted.ok) return;
  ledger = accepted.value;
  const disputed = appendInsightTransition(
    ledger,
    next(makeRevision("disputed", "old", [EVIDENCE]), ledger.ledgerHash, "old-active-0", "dispute"),
  );
  expect(disputed.ok).toBe(true);
  if (!disputed.ok) return;
  ledger = disputed.value;
  const resolved = appendInsightTransition(
    ledger,
    next(makeRevision("active", "old"), ledger.ledgerHash, "old-disputed-1", "resolve-dispute"),
  );
  expect(resolved.ok).toBe(true);
  if (resolved.ok) expect(projectInsightState(resolved.value).current.old?.status).toBe("active");
});

test("supersession marks old insight inactive without deleting its revision", () => {
  let ledger = createEmptyInsightLedger("project");
  const accepted = appendInsightTransition(
    ledger,
    next(makeRevision("active", "old"), ledger.ledgerHash, null, "accept"),
  );
  expect(accepted.ok).toBe(true);
  if (!accepted.ok) return;
  ledger = accepted.value;
  const replacement = makeRevision("active", "new");
  const result = appendInsightTransition(
    ledger,
    next(replacement, ledger.ledgerHash, "old-active-0", "supersede", "old"),
  );
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  const projection = projectInsightState(result.value);
  expect(projection.current.old?.status).toBe("superseded");
  expect(projection.current.new?.status).toBe("active");
  expect(projection.history).toHaveLength(2);
});

test("operator rejection and expiry can close external candidates without activating them", () => {
  const empty = createEmptyInsightLedger("project");
  const rejected = appendInsightTransition(
    empty,
    next(makeRevision("rejected", "rejected-candidate"), empty.ledgerHash, null, "reject"),
  );
  expect(rejected.ok).toBe(true);
  if (!rejected.ok) return;
  expect(projectInsightState(rejected.value).current["rejected-candidate"]?.status).toBe(
    "rejected",
  );

  const expired = appendInsightTransition(
    rejected.value,
    next(makeRevision("expired", "expired-candidate"), rejected.value.ledgerHash, null, "expire"),
  );
  expect(expired.ok).toBe(true);
  if (expired.ok)
    expect(projectInsightState(expired.value).current["expired-candidate"]?.status).toBe("expired");
});

test("conflicting active revisions do not both enter compiled startup context", () => {
  let ledger = createEmptyInsightLedger("project");
  const firstRevision = {
    ...makeRevision("active", "first"),
    conflictsWith: ["second"],
  };
  const first = appendInsightTransition(
    ledger,
    next(firstRevision, ledger.ledgerHash, null, "accept"),
  );
  expect(first.ok).toBe(true);
  if (!first.ok) return;
  ledger = first.value;
  const second = appendInsightTransition(
    ledger,
    next(makeRevision("active", "second"), ledger.ledgerHash, null, "accept"),
  );
  expect(second.ok).toBe(true);
  if (!second.ok) return;
  const compiled = compileInsightProjection(projectInsightState(second.value), {
    now: new Date("2026-02-01T00:00:00.000Z"),
    supportedRiskClasses: new Set(["low", "medium", "high"]),
  });
  expect(compiled.ok).toBe(true);
  if (compiled.ok) expect(compiled.value.entryIds).toEqual(["second"]);
});

test("assembled retirement is a distinct idempotent revision that removes startup context", () => {
  const packetHash = "a".repeat(64);
  const sourceBindingHash = "b".repeat(64);
  const candidateId = "operator-boundary";
  const evidenceUri = `chatlog://conversation/${HASH}/turn/0`;
  const candidate: PromotionCandidate = {
    id: candidateId,
    type: "memory-or-adr",
    signature: "operator boundary",
    title: "Operator boundary",
    status: "curation-required",
    frequency: {
      occurrences: 3,
      distinctSnippets: 3,
      conversations: 3,
      sessions: 3,
      projects: 1,
      harnesses: 1,
      threshold: 3,
    },
    evidence: [
      {
        pointer: { turnIndex: 0, uri: evidenceUri },
        snippet: "Ask before crossing the operator boundary.",
        conversationHash: HASH,
        sessionId: "session",
        project: "project",
        harness: "codex",
        model: "model",
      },
    ],
    curation: { principle: "ask first", route: "memory", checks: [] },
    evaluation: {
      contract: "agent-eval/promotion-v1",
      status: "unmeasured",
      minimumRunsPerArm: 3,
      control: "without",
      treatment: "with",
      metrics: ["completion"],
      keepRule: "keep",
      cutRule: "cut",
    },
  };
  const refinery: RefineryArtifact = {
    schemaVersion: 1,
    inputProjectionHash: "c".repeat(64),
    recipeHash: "d".repeat(64),
    threshold: 3,
    policy: {
      autoPromotion: false,
      frequencyIsSignalNotDecision: true,
      referenceWikiDeferred: true,
    },
    candidates: [candidate],
  };
  const packet: AdjudicationPacket = {
    schemaVersion: 2,
    packetHash,
    sourceBindingHash,
    blinded: true,
    selectionRecipe: ADJUDICATION_SELECTION_RECIPE,
    instructions: {
      untrustedEvidence: true,
      verdicts: { genuine: "genuine", mixed: "mixed", boilerplate: "boilerplate" },
      evidence: "select evidence",
      insufficientContext: "ask",
    },
    candidates: [
      {
        candidateAlias: "C001",
        signatureTheme: "operator boundary",
        evidence: [
          {
            evidenceId: "E01",
            sessionAlias: "S01",
            projectAlias: "P01",
            harnessAlias: "H01",
            snippet: "Ask before crossing the boundary.",
          },
        ],
      },
    ],
  };
  const privateManifest: AdjudicationPrivateManifest = {
    schemaVersion: 2,
    packetHash,
    sourceBindingHash,
    source: {
      inputProjectionHash: refinery.inputProjectionHash,
      refineryRecipeHash: refinery.recipeHash,
      refineryThreshold: 3,
      refineryCandidates: 1,
    },
    selection: {
      recipe: ADJUDICATION_SELECTION_RECIPE,
      seed: "seed",
      requested: 1,
      selected: 1,
      fixedChallengeCandidatesAvailable: 0,
      artifactStratumSizes: { low: 0, middle: 1, high: 0 },
      selectedStrata: { low: 0, middle: 1, high: 0 },
      selectedTypes: { "memory-or-adr": 1 },
      targetTypes: { "memory-or-adr": 1 },
      shortages: [],
    },
    artifacts: {
      packetSha256: createHash("sha256")
        .update(`${JSON.stringify(packet, null, 2)}\n`)
        .digest("hex"),
      markdownSha256: HASH,
      answersTemplateSha256: HASH,
      answersSchemaSha256: HASH,
    },
    candidates: [
      {
        candidateAlias: "C001",
        candidateId,
        type: "memory-or-adr",
        stratum: "middle",
        signatureFamily: "operator boundary",
        evidence: [
          {
            evidenceId: "E01",
            sourceIndex: 0,
            pointerUri: evidenceUri,
            conversationHash: HASH,
            sessionId: "session",
            project: "project",
            harness: "codex",
          },
        ],
      },
    ],
  };
  const proposalSet: MemoryProposalSet = {
    schemaVersion: 1,
    packetHash,
    generator: { provider: "test", model: "test", effort: "medium", recipe: "test" },
    proposals: {
      C001: {
        lesson: "Ask before crossing an operator boundary.",
        suggestedValence: "positive",
        rationale: "Repeated evidence.",
      },
    },
  };
  const proposalSetHash = createHash("sha256")
    .update(`${JSON.stringify(proposalSet, null, 2)}\n`)
    .digest("hex");
  const operatorReviews: OperatorReviews = {
    schemaVersion: 1,
    packetHash,
    proposalSetHash,
    reviewer: { id: "operator" },
    reviews: {
      C001: {
        status: "reviewed",
        judgment: "correct",
        valence: "positive",
        feedback: "",
      },
    },
  };
  const adjudicationAnswers: HumanAdjudicationAnswers = {
    schemaVersion: 2,
    packetHash,
    adjudicator: { id: "adjudicator" },
    answers: {
      C001: {
        status: "decided",
        verdict: "genuine",
        genuineEvidenceIds: ["E01"],
        confidence: "high",
        reasoning: "The evidence directly supports the lesson.",
      },
    },
  };
  const common = {
    projectIdentity: "project",
    candidate,
    refinery,
    packet,
    privateManifest,
    proposalSet,
    operatorReviews,
    adjudicationAnswers,
    proposalSetHash,
    operatorReviewHash: "e".repeat(64),
    adjudicationAnswersHash: "f".repeat(64),
    actor: { id: "operator", kind: "operator" as const },
    activeEvidence: new Set([evidenceUri]),
    recordedAt: "2026-08-03T12:00:00.000Z",
  };
  const accepted = assembleInsightCommand({ ...common, transitionCommand: "accept" });
  expect(accepted).toMatchObject({ ok: true });
  const staleRefineryBinding = assembleInsightCommand({
    ...common,
    privateManifest: {
      ...privateManifest,
      source: { ...privateManifest.source, inputProjectionHash: "0".repeat(64) },
    },
    transitionCommand: "accept",
  });
  expect(staleRefineryBinding).toMatchObject({
    ok: false,
    error: { code: "packet-mismatch" },
  });
  if (!accepted.ok) return;
  const retired = assembleInsightCommand({
    ...common,
    transitionCommand: "retire",
    priorRevisionId: accepted.value.revision.revisionId,
    priorLedgerHash: HASH,
    correctedProposition: accepted.value.revision.proposition,
    correctedProcedure: accepted.value.revision.procedure,
    scope: accepted.value.revision.scope,
  });
  expect(retired).toMatchObject({ ok: true });
  if (!retired.ok) return;
  expect(retired.value.revision.status).toBe("retired");
  expect(retired.value.revision.revisionId).not.toBe(accepted.value.revision.revisionId);
  expect(retired.value.idempotencyKey).not.toBe(accepted.value.idempotencyKey);

  let ledger = createEmptyInsightLedger("project");
  const appended = appendInsightTransition(ledger, {
    ...accepted.value,
    priorLedgerHash: ledger.ledgerHash,
  });
  expect(appended.ok).toBe(true);
  if (!appended.ok) return;
  ledger = appended.value;
  const removed = appendInsightTransition(ledger, {
    ...retired.value,
    priorLedgerHash: ledger.ledgerHash,
  });
  expect(removed.ok).toBe(true);
  if (!removed.ok) return;
  expect(projectInsightState(removed.value).current[candidateId]?.status).toBe("retired");
  const compiled = compileInsightProjection(projectInsightState(removed.value), {
    now: new Date("2026-08-03T12:01:00.000Z"),
  });
  expect(compiled.ok).toBe(true);
  if (compiled.ok) expect(compiled.value.entryIds).not.toContain(candidateId);
});
