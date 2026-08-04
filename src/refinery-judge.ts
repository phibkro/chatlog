import {
  frequencyFromPromotionEvidence,
  type PromotionCandidate,
  type PromotionEvidence,
} from "./refinery";

export type SemanticVerdictName = "genuine" | "boilerplate" | "mixed";

export interface SemanticVerdict {
  id: string;
  verdict: SemanticVerdictName;
  reasoning: string;
  genuineEvidenceIndices: number[];
}

export interface JudgeValidationError {
  code:
    | "invalid-envelope"
    | "invalid-row"
    | "unknown-candidate"
    | "duplicate-candidate"
    | "invalid-verdict"
    | "invalid-reasoning"
    | "invalid-evidence-indices"
    | "duplicate-evidence-index"
    | "out-of-range-evidence-index"
    | "inconsistent-boilerplate"
    | "missing-candidate";
  message: string;
  candidateId?: string;
}

export type JudgeValidationResult =
  | { ok: true; verdicts: SemanticVerdict[] }
  | { ok: false; errors: JudgeValidationError[] };

export const REFINERY_JUDGE_SCHEMA = {
  type: "object",
  properties: {
    verdicts: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          verdict: { type: "string", enum: ["genuine", "boilerplate", "mixed"] },
          reasoning: { type: "string" },
          genuineEvidenceIndices: { type: "array", items: { type: "integer" } },
        },
        required: ["id", "verdict", "reasoning", "genuineEvidenceIndices"],
        additionalProperties: false,
      },
    },
  },
  required: ["verdicts"],
  additionalProperties: false,
} as const;

export interface SelectedSupport {
  evidenceItems: number;
  distinctSnippets: number;
  conversations: number;
  sessions: number;
  projects: number;
  harnesses: number;
  threshold: number;
}

export interface JudgedCandidateBase {
  id: string;
  type: PromotionCandidate["type"];
  signature: string;
  title: string;
  verdict: SemanticVerdictName;
  reasoning: string;
  support: SelectedSupport;
  evidencePointers: string[];
}

export interface PromotionReviewCandidate extends JudgedCandidateBase {
  disposition: "promotion-review";
  dispositionReason: "genuine-support-meets-threshold";
}

export interface ManualReviewCandidate extends JudgedCandidateBase {
  disposition: "manual-review";
  dispositionReason:
    | "mixed-evidence"
    | "genuine-support-below-threshold"
    | "reference-wiki-deferred";
}

export interface RejectedCandidate extends JudgedCandidateBase {
  disposition: "rejected";
  dispositionReason: "boilerplate";
}

export interface UnjudgedCandidate {
  id: string;
  type: PromotionCandidate["type"];
  signature: string;
  title: string;
  disposition: "unjudged";
  dispositionReason: "missing-valid-verdict";
}

export interface RefineryDisposition {
  policy: {
    autoPromotion: false;
    mixedRequiresManualReview: true;
    supportDerivedFromSelectedEvidence: true;
  };
  promotionReview: PromotionReviewCandidate[];
  manualReview: ManualReviewCandidate[];
  rejected: RejectedCandidate[];
  unjudged: UnjudgedCandidate[];
}

function rowObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function validateSemanticVerdicts(
  candidates: readonly PromotionCandidate[],
  value: unknown,
): JudgeValidationResult {
  if (!rowObject(value) || !Array.isArray(value.verdicts))
    return {
      ok: false,
      errors: [{ code: "invalid-envelope", message: "judge result must contain verdicts[]" }],
    };

  const candidatesById = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  const order = new Map(candidates.map((candidate, index) => [candidate.id, index]));
  const seen = new Set<string>();
  const verdicts: SemanticVerdict[] = [];
  const errors: JudgeValidationError[] = [];

  for (const rawRow of value.verdicts) {
    if (!rowObject(rawRow)) {
      errors.push({ code: "invalid-row", message: "judge verdict must be an object" });
      continue;
    }
    const id = rawRow.id;
    if (typeof id !== "string" || !candidatesById.has(id)) {
      errors.push({
        code: "unknown-candidate",
        message: "judge verdict references an unknown candidate",
        candidateId: typeof id === "string" ? id : undefined,
      });
      continue;
    }
    if (seen.has(id)) {
      errors.push({
        code: "duplicate-candidate",
        message: `judge returned candidate ${id} more than once`,
        candidateId: id,
      });
      continue;
    }
    seen.add(id);
    if (
      typeof rawRow.verdict !== "string" ||
      !["genuine", "boilerplate", "mixed"].includes(rawRow.verdict)
    ) {
      errors.push({
        code: "invalid-verdict",
        message: `judge returned an invalid verdict for ${id}`,
        candidateId: id,
      });
      continue;
    }
    if (typeof rawRow.reasoning !== "string" || rawRow.reasoning.trim() === "") {
      errors.push({
        code: "invalid-reasoning",
        message: `judge returned no reasoning for ${id}`,
        candidateId: id,
      });
      continue;
    }
    if (!Array.isArray(rawRow.genuineEvidenceIndices)) {
      errors.push({
        code: "invalid-evidence-indices",
        message: `judge returned no evidence-index array for ${id}`,
        candidateId: id,
      });
      continue;
    }
    const indices = rawRow.genuineEvidenceIndices;
    if (!indices.every((index) => Number.isInteger(index))) {
      errors.push({
        code: "invalid-evidence-indices",
        message: `judge returned a non-integer evidence index for ${id}`,
        candidateId: id,
      });
      continue;
    }
    if (new Set(indices).size !== indices.length) {
      errors.push({
        code: "duplicate-evidence-index",
        message: `judge returned duplicate evidence indices for ${id}`,
        candidateId: id,
      });
      continue;
    }
    const evidenceCount = candidatesById.get(id)!.evidence.length;
    if (indices.some((index) => Number(index) < 0 || Number(index) >= evidenceCount)) {
      errors.push({
        code: "out-of-range-evidence-index",
        message: `judge returned an out-of-range evidence index for ${id}`,
        candidateId: id,
      });
      continue;
    }
    if (rawRow.verdict === "boilerplate" && indices.length > 0) {
      errors.push({
        code: "inconsistent-boilerplate",
        message: `boilerplate verdict ${id} must not cite genuine evidence`,
        candidateId: id,
      });
      continue;
    }
    verdicts.push({
      id,
      verdict: rawRow.verdict as SemanticVerdictName,
      reasoning: rawRow.reasoning,
      genuineEvidenceIndices: (indices as number[]).toSorted((a, b) => a - b),
    });
  }

  for (const candidate of candidates)
    if (!seen.has(candidate.id))
      errors.push({
        code: "missing-candidate",
        message: `judge omitted candidate ${candidate.id}`,
        candidateId: candidate.id,
      });

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    verdicts: verdicts.toSorted((a, b) => order.get(a.id)! - order.get(b.id)!),
  };
}

function selectedEvidence(
  candidate: PromotionCandidate,
  verdict: SemanticVerdict,
): PromotionEvidence[] {
  return verdict.genuineEvidenceIndices.map((index) => candidate.evidence[index]!);
}

function support(
  candidate: PromotionCandidate,
  evidence: readonly PromotionEvidence[],
): SelectedSupport {
  const frequency = frequencyFromPromotionEvidence(
    evidence,
    Math.max(3, candidate.frequency.threshold),
  );
  return {
    evidenceItems: frequency.occurrences,
    distinctSnippets: frequency.distinctSnippets,
    conversations: frequency.conversations,
    sessions: frequency.sessions,
    projects: frequency.projects,
    harnesses: frequency.harnesses,
    threshold: frequency.threshold,
  };
}

function judgedBase(candidate: PromotionCandidate, verdict: SemanticVerdict): JudgedCandidateBase {
  const evidence = selectedEvidence(candidate, verdict);
  return {
    id: candidate.id,
    type: candidate.type,
    signature: candidate.signature,
    title: candidate.title,
    verdict: verdict.verdict,
    reasoning: verdict.reasoning,
    support: support(candidate, evidence),
    evidencePointers: evidence.map((item) => item.pointer.uri),
  };
}

export function dispositionForValidatedVerdicts(
  candidates: readonly PromotionCandidate[],
  verdicts: readonly SemanticVerdict[],
): RefineryDisposition {
  const verdictById = new Map(verdicts.map((verdict) => [verdict.id, verdict]));
  const result: RefineryDisposition = {
    policy: {
      autoPromotion: false,
      mixedRequiresManualReview: true,
      supportDerivedFromSelectedEvidence: true,
    },
    promotionReview: [],
    manualReview: [],
    rejected: [],
    unjudged: [],
  };

  for (const candidate of candidates) {
    const verdict = verdictById.get(candidate.id);
    if (!verdict) {
      result.unjudged.push({
        id: candidate.id,
        type: candidate.type,
        signature: candidate.signature,
        title: candidate.title,
        disposition: "unjudged",
        dispositionReason: "missing-valid-verdict",
      });
      continue;
    }
    const base = judgedBase(candidate, verdict);
    if (verdict.verdict === "boilerplate") {
      result.rejected.push({
        ...base,
        disposition: "rejected",
        dispositionReason: "boilerplate",
      });
      continue;
    }
    if (verdict.verdict === "mixed") {
      result.manualReview.push({
        ...base,
        disposition: "manual-review",
        dispositionReason: "mixed-evidence",
      });
      continue;
    }
    if (candidate.type === "wiki-page-later") {
      result.manualReview.push({
        ...base,
        disposition: "manual-review",
        dispositionReason: "reference-wiki-deferred",
      });
      continue;
    }
    if (base.support.sessions < base.support.threshold) {
      result.manualReview.push({
        ...base,
        disposition: "manual-review",
        dispositionReason: "genuine-support-below-threshold",
      });
      continue;
    }
    result.promotionReview.push({
      ...base,
      disposition: "promotion-review",
      dispositionReason: "genuine-support-meets-threshold",
    });
  }
  return result;
}
