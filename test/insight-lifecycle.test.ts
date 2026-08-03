import { expect, test } from "bun:test";
import { insightScope, projectInsightState, type InsightRevision } from "../src/insights";
import {
  appendInsightTransition,
  createEmptyInsightLedger,
  type InsightCommandInput,
} from "../src/insight-ledger";
import { compileInsightProjection } from "../src/insight-compiler";

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
