import { expect, test } from "bun:test";
import type { PromotionCandidate, PromotionEvidence } from "../src/refinery";
import {
  dispositionForValidatedVerdicts,
  validateSemanticVerdicts,
  type SemanticVerdict,
} from "../src/refinery-judge";

function evidence(
  index: number,
  sessionId = `session-${index}`,
  project = "/project",
): PromotionEvidence {
  return {
    conversationHash: String(index + 1).repeat(64),
    sessionId,
    project,
    harness: index % 2 === 0 ? "codex" : "claude-code",
    model: "model",
    pointer: {
      turnIndex: index,
      uri: `chatlog://conversation/${String(index + 1).repeat(64)}/turn/${index}`,
    },
    snippet: `distinct evidence wording ${index}`,
  };
}

function candidate(overrides: Partial<PromotionCandidate> = {}): PromotionCandidate {
  return {
    id: "candidate",
    type: "gotcha-skill",
    signature: "signature",
    title: "title",
    status: "curation-required",
    frequency: {
      occurrences: 117,
      distinctSnippets: 38,
      conversations: 95,
      sessions: 19,
      projects: 10,
      harnesses: 2,
      threshold: 3,
    },
    evidence: Array.from({ length: 6 }, (_, index) => evidence(index)),
    curation: { principle: "principle", route: "route", checks: [] },
    evaluation: {
      contract: "agent-eval/promotion-v1",
      status: "unmeasured",
      minimumRunsPerArm: 3,
      control: "control",
      treatment: "treatment",
      metrics: [],
      keepRule: "keep",
      cutRule: "cut",
    },
    ...overrides,
  };
}

function verdict(
  item: PromotionCandidate,
  name: SemanticVerdict["verdict"],
  indices: number[],
): SemanticVerdict {
  return {
    id: item.id,
    verdict: name,
    reasoning: "reasoning",
    genuineEvidenceIndices: indices,
  };
}

test("Nix mixed regression is manual-only and never inherits mined frequency", () => {
  const item = candidate({
    id: "707c237feeef2547ca2f",
    signature: "nix-dirty-or-untracked-input",
  });
  const result = dispositionForValidatedVerdicts(item ? [item] : [], [verdict(item, "mixed", [3])]);
  expect(result.policy.autoPromotion).toBe(false);
  expect(result.promotionReview).toHaveLength(0);
  expect(result.manualReview).toHaveLength(1);
  expect(result.manualReview[0]).toMatchObject({
    dispositionReason: "mixed-evidence",
    support: { evidenceItems: 1, sessions: 1, conversations: 1, threshold: 3 },
    evidencePointers: [item.evidence[3]!.pointer.uri],
  });
  expect(result.manualReview[0]).not.toHaveProperty("frequency");
  expect(result.manualReview[0]!.support.evidenceItems).not.toBe(item.frequency.occurrences);
});

test("wait-monitor dispatch regression rejects boilerplate without fallback evidence", () => {
  const item = candidate({
    id: "1ad36ba6c1fb7fb08211",
    signature: "/project:wait-monitor-and-timeout",
    type: "claude-md",
  });
  const result = dispositionForValidatedVerdicts([item], [verdict(item, "boilerplate", [])]);
  expect(result.rejected).toHaveLength(1);
  expect(result.rejected[0]).toMatchObject({
    dispositionReason: "boilerplate",
    support: { evidenceItems: 0, sessions: 0 },
    evidencePointers: [],
  });
  expect(result.manualReview).toHaveLength(0);
  expect(result.promotionReview).toHaveLength(0);
});

test("documentation lookup versus authoring regression keeps mixed evidence manual", () => {
  const item = candidate({
    id: "813434c9909b44190093",
    signature: "Claude Web:reference-and-documentation-lookup",
    type: "memory-or-adr",
  });
  const result = dispositionForValidatedVerdicts([item], [verdict(item, "mixed", [1, 4])]);
  expect(result.manualReview[0]).toMatchObject({
    dispositionReason: "mixed-evidence",
    support: { evidenceItems: 2, sessions: 2 },
    evidencePointers: [item.evidence[1]!.pointer.uri, item.evidence[4]!.pointer.uri],
  });
});

test("genuine requires selected evidence from the configured session threshold", () => {
  const item = candidate();
  const enough = dispositionForValidatedVerdicts([item], [verdict(item, "genuine", [0, 1, 2])]);
  expect(enough.promotionReview).toHaveLength(1);
  expect(enough.promotionReview[0]).toMatchObject({
    dispositionReason: "genuine-support-meets-threshold",
    support: { evidenceItems: 3, sessions: 3, threshold: 3 },
  });

  const repeatedSession = candidate({
    evidence: [evidence(0, "same"), evidence(1, "same"), evidence(2, "other"), evidence(3)],
  });
  const insufficient = dispositionForValidatedVerdicts(
    [repeatedSession],
    [verdict(repeatedSession, "genuine", [0, 1, 2])],
  );
  expect(insufficient.promotionReview).toHaveLength(0);
  expect(insufficient.manualReview[0]).toMatchObject({
    dispositionReason: "genuine-support-below-threshold",
    support: { evidenceItems: 3, sessions: 2 },
  });
});

test("empty genuine evidence never falls back to the candidate sample", () => {
  const item = candidate();
  const result = dispositionForValidatedVerdicts([item], [verdict(item, "genuine", [])]);
  expect(result.manualReview[0]).toMatchObject({
    dispositionReason: "genuine-support-below-threshold",
    support: { evidenceItems: 0, sessions: 0 },
    evidencePointers: [],
  });
});

test("reference wiki remains deferred after a supported genuine verdict", () => {
  const item = candidate({
    type: "wiki-page-later",
    status: "deferred-follow-up",
  });
  const result = dispositionForValidatedVerdicts([item], [verdict(item, "genuine", [0, 1, 2])]);
  expect(result.promotionReview).toHaveLength(0);
  expect(result.manualReview[0]).toMatchObject({
    dispositionReason: "reference-wiki-deferred",
    support: { sessions: 3 },
  });
});

test("semantic verdict validation accepts exactly one complete valid row", () => {
  const item = candidate();
  const result = validateSemanticVerdicts([item], {
    verdicts: [
      {
        id: item.id,
        verdict: "mixed",
        reasoning: "real minority",
        genuineEvidenceIndices: [3, 1],
      },
    ],
  });
  expect(result).toEqual({
    ok: true,
    verdicts: [
      {
        id: item.id,
        verdict: "mixed",
        reasoning: "real minority",
        genuineEvidenceIndices: [1, 3],
      },
    ],
  });
});

test("semantic verdict validation fails closed on malformed candidate coverage", () => {
  const first = candidate({ id: "first" });
  const second = candidate({ id: "second" });
  const result = validateSemanticVerdicts([first, second], {
    verdicts: [
      {
        id: first.id,
        verdict: "genuine",
        reasoning: "reason",
        genuineEvidenceIndices: [0, 0],
      },
      {
        id: first.id,
        verdict: "mixed",
        reasoning: "duplicate",
        genuineEvidenceIndices: [1],
      },
      {
        id: "unknown",
        verdict: "mixed",
        reasoning: "unknown",
        genuineEvidenceIndices: [],
      },
    ],
  });
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.errors.map((error) => error.code)).toEqual([
    "duplicate-evidence-index",
    "duplicate-candidate",
    "unknown-candidate",
    "missing-candidate",
  ]);
});

test("semantic verdict validation rejects fractional, out-of-range, and inconsistent evidence", () => {
  const fractional = candidate({ id: "fractional" });
  const outOfRange = candidate({ id: "out-of-range" });
  const boilerplate = candidate({ id: "boilerplate" });
  const result = validateSemanticVerdicts([fractional, outOfRange, boilerplate], {
    verdicts: [
      {
        id: fractional.id,
        verdict: "mixed",
        reasoning: "reason",
        genuineEvidenceIndices: [1.5],
      },
      {
        id: outOfRange.id,
        verdict: "mixed",
        reasoning: "reason",
        genuineEvidenceIndices: [-1],
      },
      {
        id: boilerplate.id,
        verdict: "boilerplate",
        reasoning: "reason",
        genuineEvidenceIndices: [0],
      },
    ],
  });
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.errors.map((error) => error.code)).toEqual([
    "invalid-evidence-indices",
    "out-of-range-evidence-index",
    "inconsistent-boilerplate",
  ]);
});

test("semantic verdict validation rejects values that only stringify to a verdict", () => {
  for (const malformedVerdict of [["genuine"], { toString: () => "genuine" }, 1, null]) {
    const item = candidate({ id: `coerced-${String(malformedVerdict)}` });
    const result = validateSemanticVerdicts([item], {
      verdicts: [
        {
          id: item.id,
          verdict: malformedVerdict,
          reasoning: "must not be coerced",
          genuineEvidenceIndices: [0, 1, 2],
        },
      ],
    });
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.errors.some((error) => error.code === "invalid-verdict")).toBe(true);
  }
});
