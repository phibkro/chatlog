import {
  canonicalMetricsEqual,
  isTrustedClosedLoopEvaluatorSource,
  isUntrustedEvaluatorActor,
  type ClosedLoopCanonicalMetrics,
} from "./closed-loop-evaluation";
export type { ClosedLoopCanonicalMetrics } from "./closed-loop-evaluation";

export type ClosedLoopRecommendation = "keep" | "revise" | "retire" | "inconclusive";
export type ClosedLoopTreatmentArm =
  | "no-memory"
  | "raw-evidence"
  | "active-insight"
  | "insight-procedure";

export interface ClosedLoopEvidencePointer {
  batchHash: string;
  eventId: string;
}

export interface ClosedLoopRun {
  arm: ClosedLoopTreatmentArm;
  contextSessionId: string;
  intervention: ClosedLoopEvidencePointer | null;
  outcome: ClosedLoopEvidencePointer;
  gatePassed: boolean;
  userCorrections: number;
  rederivationCount: number;
  tokensToGate: number | null;
  unresolved: boolean;
}

export interface ClosedLoopGateArtifact {
  schema: "chatlog/closed-loop-gate-v1";
  evaluationId: string;
  stage: "shadow" | "evidence-only" | "limited-insight";
  candidate: { id: string; contentHash: string };
  pairs: Array<{ pairId: string; control: ClosedLoopRun; treatment: ClosedLoopRun }>;
  findings: {
    harmfulScope: ClosedLoopEvidencePointer[];
    staleContext: ClosedLoopEvidencePointer[];
  };
  recommendation: ClosedLoopRecommendation;
  review: {
    kind: "human-review";
    actor: string;
    reviewedAt: string;
  };
}

export type ClosedLoopEvidenceKind =
  | "context.recall.returned"
  | "context.bundle.emitted"
  | "context.bundle.acknowledged"
  | "context.outcome.observed";

export type ClosedLoopSourceEventKind =
  | "evaluation.recorded"
  | "tool.result.observed"
  | "message.created"
  | "human.correction"
  | "artifact.created"
  | "artifact.modified";

export interface ClosedLoopSourceObservation {
  pointer: ClosedLoopEvidencePointer;
  kind: ClosedLoopSourceEventKind;
  contextSessionId: string;
  originKind: "observed" | "chatlog";
  captureDisposition: "normalized" | "opaque" | "redacted" | "omitted";
  actorKind: string;
  sourceKind: string;
  adapterRecipe: string;
  recordedAt: string | null;
  metrics: ClosedLoopCanonicalMetrics | null;
}

export interface ClosedLoopEvidenceObservation {
  pointer: ClosedLoopEvidencePointer;
  kind: ClosedLoopEvidenceKind;
  contextSessionId: string;
  evidenceGrade:
    | "gate-observed"
    | "provider-observed"
    | "human-asserted"
    | "heuristic"
    | "agent-self-report"
    | null;
  originKind: "observed" | "chatlog";
  captureDisposition: "normalized" | "opaque" | "redacted" | "omitted";
  actorKind: string;
  recordedAt: string | null;
  metrics: ClosedLoopCanonicalMetrics | null;
  interventionId: string | null;
  inputEventIds: readonly string[];
  sources: readonly ClosedLoopSourceObservation[];
  candidateId: string | null;
  candidateContentHash: string | null;
}

export type ClosedLoopEvidenceResolution =
  | { ok: true; value: ClosedLoopEvidenceObservation }
  | { ok: false; error: string };

export type ClosedLoopEvidenceResolver = (
  pointer: ClosedLoopEvidencePointer,
) => Promise<ClosedLoopEvidenceResolution>;

export interface ClosedLoopGateMetrics {
  controlGatePassRate: number;
  treatmentGatePassRate: number;
  gateRegression: boolean;
  controlMedianCorrections: number;
  treatmentMedianCorrections: number;
  correctionRegression: boolean;
  controlMedianRederivation: number;
  treatmentMedianRederivation: number;
  rederivationImproved: boolean;
  controlMedianTokens: number | null;
  treatmentMedianTokens: number | null;
  tokensImproved: boolean;
}

export type ClosedLoopGateResult =
  | {
      ok: true;
      value: {
        verdict: ClosedLoopRecommendation;
        metrics: ClosedLoopGateMetrics;
        sourceEvidence: number;
        artifact: ClosedLoopGateArtifact;
      };
    }
  | { ok: false; error: { code: "invalid-gate" | "missing-evidence"; message: string } };

const HASH = /^[a-f0-9]{64}$/u;
export const MAX_CLOSED_LOOP_ARTIFACT_BYTES = 1_048_576;
export const MAX_CLOSED_LOOP_PAIRS = 256;
export const MAX_CLOSED_LOOP_FINDINGS = 512;
export const MAX_CLOSED_LOOP_EVIDENCE_POINTERS = 2_048;
export const MAX_CLOSED_LOOP_INPUT_EVENT_IDS = 256;
export const MAX_CLOSED_LOOP_SOURCE_OBSERVATIONS = 256;

function fail(code: "invalid-gate" | "missing-evidence", message: string): ClosedLoopGateResult {
  return { ok: false, error: { code, message } };
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function finiteNonnegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function validPointer(value: unknown): value is ClosedLoopEvidencePointer {
  return (
    record(value) &&
    typeof value.batchHash === "string" &&
    HASH.test(value.batchHash) &&
    typeof value.eventId === "string" &&
    HASH.test(value.eventId)
  );
}
const SOURCE_EVENT_KINDS: Record<ClosedLoopSourceEventKind, true> = {
  "evaluation.recorded": true,
  "tool.result.observed": true,
  "message.created": true,
  "human.correction": true,
  "artifact.created": true,
  "artifact.modified": true,
};

export function isClosedLoopSourceEventKind(value: string): value is ClosedLoopSourceEventKind {
  return SOURCE_EVENT_KINDS[value as ClosedLoopSourceEventKind] === true;
}
const CAPTURE_DISPOSITIONS: Record<"normalized" | "opaque" | "redacted" | "omitted", true> = {
  normalized: true,
  opaque: true,
  redacted: true,
  omitted: true,
};

function validRecordedAt(value: unknown): value is string | null {
  return value === null || (typeof value === "string" && Number.isFinite(Date.parse(value)));
}

function validCanonicalMetrics(value: unknown): value is ClosedLoopCanonicalMetrics {
  return (
    record(value) &&
    typeof value.gatePassed === "boolean" &&
    finiteNonnegative(value.userCorrections) &&
    Number.isSafeInteger(value.userCorrections) &&
    finiteNonnegative(value.rederivationCount) &&
    Number.isSafeInteger(value.rederivationCount) &&
    (value.tokensToGate === null ||
      (finiteNonnegative(value.tokensToGate) && Number.isSafeInteger(value.tokensToGate))) &&
    typeof value.unresolved === "boolean"
  );
}

function validSourceObservation(value: unknown): value is ClosedLoopSourceObservation {
  return (
    record(value) &&
    validPointer(value.pointer) &&
    typeof value.kind === "string" &&
    isClosedLoopSourceEventKind(value.kind) &&
    typeof value.contextSessionId === "string" &&
    HASH.test(value.contextSessionId) &&
    (value.originKind === "observed" || value.originKind === "chatlog") &&
    typeof value.captureDisposition === "string" &&
    CAPTURE_DISPOSITIONS[value.captureDisposition as keyof typeof CAPTURE_DISPOSITIONS] === true &&
    typeof value.actorKind === "string" &&
    !!value.actorKind.trim() &&
    typeof value.sourceKind === "string" &&
    !!value.sourceKind.trim() &&
    typeof value.adapterRecipe === "string" &&
    !!value.adapterRecipe.trim() &&
    validRecordedAt(value.recordedAt) &&
    (value.metrics === null || validCanonicalMetrics(value.metrics))
  );
}

function validObservation(value: unknown): value is ClosedLoopEvidenceObservation {
  if (!record(value)) return false;
  const inputEventIds = value.inputEventIds;
  if (
    !Array.isArray(inputEventIds) ||
    inputEventIds.length > MAX_CLOSED_LOOP_INPUT_EVENT_IDS ||
    !inputEventIds.every(
      (eventId): eventId is string => typeof eventId === "string" && HASH.test(eventId),
    )
  )
    return false;
  const sourcesValue = value.sources;
  if (
    !Array.isArray(sourcesValue) ||
    sourcesValue.length > MAX_CLOSED_LOOP_SOURCE_OBSERVATIONS ||
    !sourcesValue.every(validSourceObservation)
  )
    return false;
  const sources = sourcesValue as ClosedLoopSourceObservation[];
  const kind = value.kind;
  const evidenceGrade = value.evidenceGrade;
  if (
    !validPointer(value.pointer) ||
    typeof value.contextSessionId !== "string" ||
    !HASH.test(value.contextSessionId) ||
    typeof kind !== "string" ||
    (kind !== "context.recall.returned" &&
      kind !== "context.bundle.emitted" &&
      kind !== "context.bundle.acknowledged" &&
      kind !== "context.outcome.observed") ||
    !(
      evidenceGrade === null ||
      evidenceGrade === "gate-observed" ||
      evidenceGrade === "provider-observed" ||
      evidenceGrade === "human-asserted" ||
      evidenceGrade === "heuristic" ||
      evidenceGrade === "agent-self-report"
    ) ||
    (value.originKind !== "observed" && value.originKind !== "chatlog") ||
    typeof value.captureDisposition !== "string" ||
    !CAPTURE_DISPOSITIONS[value.captureDisposition as keyof typeof CAPTURE_DISPOSITIONS] ||
    typeof value.actorKind !== "string" ||
    !value.actorKind.trim() ||
    !validRecordedAt(value.recordedAt) ||
    new Set(inputEventIds).size !== inputEventIds.length ||
    sources.length !== inputEventIds.length ||
    new Set(sources.map((source) => source.pointer.eventId)).size !== sources.length ||
    !sources.every((source) => inputEventIds.includes(source.pointer.eventId)) ||
    new Set(sources.map((source) => source.pointer.eventId)).size !== new Set(inputEventIds).size ||
    (value.interventionId !== null &&
      (typeof value.interventionId !== "string" || !HASH.test(value.interventionId))) ||
    (value.candidateId !== null &&
      (typeof value.candidateId !== "string" || !value.candidateId.trim())) ||
    (value.candidateContentHash !== null &&
      (typeof value.candidateContentHash !== "string" || !HASH.test(value.candidateContentHash)))
  )
    return false;
  if (kind === "context.outcome.observed") return validCanonicalMetrics(value.metrics);
  return (
    value.metrics === null &&
    value.interventionId === null &&
    inputEventIds.length === 0 &&
    sources.length === 0
  );
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = values.toSorted((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!;
}

function validateRun(value: unknown, expectedArm: "control" | "treatment"): value is ClosedLoopRun {
  if (!record(value)) return false;
  const arm = value.arm;
  if (
    typeof arm !== "string" ||
    (arm !== "no-memory" &&
      arm !== "raw-evidence" &&
      arm !== "active-insight" &&
      arm !== "insight-procedure")
  )
    return false;
  if (expectedArm === "control" && arm !== "no-memory") return false;
  if (expectedArm === "treatment" && arm === "no-memory") return false;
  return (
    typeof value.contextSessionId === "string" &&
    HASH.test(value.contextSessionId) &&
    (value.intervention === null || validPointer(value.intervention)) &&
    validPointer(value.outcome) &&
    typeof value.gatePassed === "boolean" &&
    finiteNonnegative(value.userCorrections) &&
    Number.isSafeInteger(value.userCorrections) &&
    finiteNonnegative(value.rederivationCount) &&
    Number.isSafeInteger(value.rederivationCount) &&
    (value.tokensToGate === null || finiteNonnegative(value.tokensToGate)) &&
    typeof value.unresolved === "boolean"
  );
}

function validateArtifact(value: unknown): value is ClosedLoopGateArtifact {
  if (!record(value) || value.schema !== "chatlog/closed-loop-gate-v1") return false;
  const stage = value.stage;
  const recommendation = value.recommendation;
  if (
    typeof value.evaluationId !== "string" ||
    !value.evaluationId.trim() ||
    typeof stage !== "string" ||
    (stage !== "shadow" && stage !== "evidence-only" && stage !== "limited-insight") ||
    !record(value.candidate) ||
    typeof value.candidate.id !== "string" ||
    typeof value.candidate.contentHash !== "string" ||
    !HASH.test(value.candidate.contentHash) ||
    !Array.isArray(value.pairs) ||
    value.pairs.length < 3 ||
    value.pairs.length > MAX_CLOSED_LOOP_PAIRS ||
    !record(value.findings) ||
    !Array.isArray(value.findings.harmfulScope) ||
    value.findings.harmfulScope.length > MAX_CLOSED_LOOP_FINDINGS ||
    !Array.isArray(value.findings.staleContext) ||
    value.findings.staleContext.length > MAX_CLOSED_LOOP_FINDINGS ||
    typeof recommendation !== "string" ||
    (recommendation !== "keep" &&
      recommendation !== "revise" &&
      recommendation !== "retire" &&
      recommendation !== "inconclusive") ||
    !record(value.review) ||
    value.review.kind !== "human-review" ||
    typeof value.review.actor !== "string" ||
    !value.review.actor.trim() ||
    typeof value.review.reviewedAt !== "string" ||
    !Number.isFinite(Date.parse(value.review.reviewedAt))
  )
    return false;
  if (
    !value.findings.harmfulScope.every(validPointer) ||
    !value.findings.staleContext.every(validPointer)
  )
    return false;
  const pairIds = new Set<string>();
  for (const pair of value.pairs) {
    if (
      !record(pair) ||
      typeof pair.pairId !== "string" ||
      !pair.pairId.trim() ||
      pairIds.has(pair.pairId) ||
      !validateRun(pair.control, "control") ||
      !validateRun(pair.treatment, "treatment") ||
      pair.treatment.intervention === null
    )
      return false;
    pairIds.add(pair.pairId);
  }
  return true;
}

function computeMetrics(artifact: ClosedLoopGateArtifact): ClosedLoopGateMetrics {
  const controls = artifact.pairs.map((pair) => pair.control);
  const treatments = artifact.pairs.map((pair) => pair.treatment);
  const controlGatePassRate = controls.filter((run) => run.gatePassed).length / controls.length;
  const treatmentGatePassRate =
    treatments.filter((run) => run.gatePassed).length / treatments.length;
  const controlMedianCorrections = median(controls.map((run) => run.userCorrections))!;
  const treatmentMedianCorrections = median(treatments.map((run) => run.userCorrections))!;
  const controlMedianRederivation = median(controls.map((run) => run.rederivationCount))!;
  const treatmentMedianRederivation = median(treatments.map((run) => run.rederivationCount))!;
  const controlMedianTokens = median(
    controls.flatMap((run) => (run.tokensToGate === null ? [] : [run.tokensToGate])),
  );
  const treatmentMedianTokens = median(
    treatments.flatMap((run) => (run.tokensToGate === null ? [] : [run.tokensToGate])),
  );
  return {
    controlGatePassRate,
    treatmentGatePassRate,
    gateRegression: treatmentGatePassRate < controlGatePassRate,
    controlMedianCorrections,
    treatmentMedianCorrections,
    correctionRegression: treatmentMedianCorrections > controlMedianCorrections,
    controlMedianRederivation,
    treatmentMedianRederivation,
    rederivationImproved: treatmentMedianRederivation < controlMedianRederivation,
    controlMedianTokens,
    treatmentMedianTokens,
    tokensImproved:
      controlMedianTokens !== null &&
      treatmentMedianTokens !== null &&
      treatmentMedianTokens < controlMedianTokens,
  };
}

function expectedVerdict(
  artifact: ClosedLoopGateArtifact,
  metrics: ClosedLoopGateMetrics,
): ClosedLoopRecommendation {
  if (artifact.findings.harmfulScope.length || artifact.findings.staleContext.length)
    return "retire";
  if (metrics.gateRegression || metrics.correctionRegression) return "revise";
  if (artifact.pairs.some((pair) => pair.control.unresolved || pair.treatment.unresolved))
    return "inconclusive";
  if (!metrics.rederivationImproved && !metrics.tokensImproved) return "inconclusive";
  return "keep";
}

type PointerExpectation = {
  pointer: ClosedLoopEvidencePointer;
  expected: "outcome" | "intervention";
  session: string | null;
  run: ClosedLoopRun | null;
};

function pointerKey(pointer: ClosedLoopEvidencePointer): string {
  return `${pointer.batchHash}:${pointer.eventId}`;
}

function authoritativeRun(run: ClosedLoopRun, metrics: ClosedLoopCanonicalMetrics): ClosedLoopRun {
  return {
    ...run,
    gatePassed: metrics.gatePassed,
    userCorrections: metrics.userCorrections,
    rederivationCount: metrics.rederivationCount,
    tokensToGate: metrics.tokensToGate,
    unresolved: metrics.unresolved,
  };
}

export async function verifyClosedLoopGate(
  input: unknown,
  resolveEvidence: ClosedLoopEvidenceResolver,
): Promise<ClosedLoopGateResult> {
  if (!validateArtifact(input))
    return fail("invalid-gate", "closed-loop gate artifact is malformed or incomplete");
  const pointerCount =
    input.pairs.length * 3 +
    input.findings.harmfulScope.length +
    input.findings.staleContext.length;
  if (pointerCount > MAX_CLOSED_LOOP_EVIDENCE_POINTERS)
    return fail("invalid-gate", "closed-loop evidence pointer collection exceeds its bound");

  const pairPointerKeys = new Set<string>();
  const pointers: PointerExpectation[] = [];
  const addPairPointer = (
    pointer: ClosedLoopEvidencePointer,
    expected: "outcome" | "intervention",
    session: string,
    run: ClosedLoopRun,
  ): boolean => {
    const key = pointerKey(pointer);
    if (pairPointerKeys.has(key)) return false;
    pairPointerKeys.add(key);
    pointers.push({ pointer, expected, session, run });
    return true;
  };
  for (const pair of input.pairs) {
    if (
      !addPairPointer(
        pair.control.outcome,
        "outcome",
        pair.control.contextSessionId,
        pair.control,
      ) ||
      !addPairPointer(
        pair.treatment.intervention!,
        "intervention",
        pair.treatment.contextSessionId,
        pair.treatment,
      ) ||
      !addPairPointer(
        pair.treatment.outcome,
        "outcome",
        pair.treatment.contextSessionId,
        pair.treatment,
      )
    )
      return fail("invalid-gate", "closed-loop evidence pointers are duplicated across pairs");
  }
  pointers.push(
    ...input.findings.harmfulScope.map((pointer) => ({
      pointer,
      expected: "outcome" as const,
      session: null,
      run: null,
    })),
    ...input.findings.staleContext.map((pointer) => ({
      pointer,
      expected: "outcome" as const,
      session: null,
      run: null,
    })),
  );

  const resolved: Array<{
    expected: PointerExpectation;
    result: ClosedLoopEvidenceResolution;
  }> = [];
  for (const expected of pointers) {
    let result: ClosedLoopEvidenceResolution;
    try {
      result = await resolveEvidence(expected.pointer);
    } catch (error) {
      result = {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
    resolved.push({ expected, result });
  }
  const observations = new Map<string, ClosedLoopEvidenceObservation>();
  const canonicalMetrics = new Map<string, ClosedLoopCanonicalMetrics>();
  for (const { expected, result } of resolved) {
    if (!result.ok) return fail("missing-evidence", `${expected.pointer.eventId}: ${result.error}`);
    if (!validObservation(result.value))
      return fail("invalid-gate", "evidence resolver returned malformed canonical evidence");
    if (
      result.value.pointer.batchHash !== expected.pointer.batchHash ||
      result.value.pointer.eventId !== expected.pointer.eventId
    )
      return fail("invalid-gate", "evidence resolver returned a different evidence pointer");
    if (expected.session !== null && result.value.contextSessionId !== expected.session)
      return fail("invalid-gate", "evidence context session does not match its declared run");
    if (
      result.value.sources.some(
        (source) =>
          source.contextSessionId !== result.value.contextSessionId ||
          source.originKind !== "observed" ||
          (source.captureDisposition !== "normalized" && source.captureDisposition !== "redacted"),
      )
    )
      return fail("invalid-gate", "outcome input evidence is not canonical observed evidence");
    if (expected.expected === "intervention") {
      if (
        result.value.kind !== "context.bundle.emitted" &&
        result.value.kind !== "context.bundle.acknowledged"
      )
        return fail("invalid-gate", "treatment intervention is not a context delivery event");
      if (result.value.originKind !== "chatlog" || result.value.captureDisposition !== "normalized")
        return fail("invalid-gate", "treatment intervention is not a canonical Chatlog event");
    } else {
      if (result.value.kind !== "context.outcome.observed")
        return fail("invalid-gate", "run outcome is not an observed outcome event");
      if (result.value.originKind !== "chatlog" || result.value.captureDisposition !== "normalized")
        return fail("invalid-gate", "run outcome is not a canonical Chatlog event");
      if (!result.value.metrics)
        return fail("invalid-gate", "run outcome has no canonical metrics");
      if (result.value.evidenceGrade !== "gate-observed" || result.value.sources.length === 0)
        return fail("invalid-gate", "gate outcomes require gate-observed evaluator evidence");
      const metrics = result.value.metrics;
      if (
        result.value.sources.some(
          (source) =>
            !isTrustedClosedLoopEvaluatorSource(source) ||
            isUntrustedEvaluatorActor(source.actorKind) ||
            source.recordedAt === null ||
            source.metrics === null ||
            !canonicalMetricsEqual(source.metrics, metrics),
        )
      )
        return fail(
          "invalid-gate",
          "gate outcome sources must be trusted evaluators with matching canonical metrics and timestamps",
        );
      if (expected.run !== null) {
        const run = expected.run;
        if (
          run.gatePassed !== metrics.gatePassed ||
          run.userCorrections !== metrics.userCorrections ||
          run.rederivationCount !== metrics.rederivationCount ||
          run.tokensToGate !== metrics.tokensToGate ||
          run.unresolved !== metrics.unresolved
        )
          return fail("invalid-gate", "artifact metrics do not match canonical outcome metrics");
        if (run.arm === "no-memory" && result.value.interventionId !== null)
          return fail("invalid-gate", "control outcome unexpectedly names an intervention");
        canonicalMetrics.set(pointerKey(expected.pointer), metrics);
      }
    }
    observations.set(pointerKey(expected.pointer), result.value);
  }

  for (const pair of input.pairs) {
    const intervention = observations.get(pointerKey(pair.treatment.intervention!));
    const outcome = observations.get(pointerKey(pair.treatment.outcome));
    if (!intervention || !outcome)
      return fail("invalid-gate", "treatment intervention lineage is incomplete");
    if (outcome.interventionId !== pair.treatment.intervention!.eventId)
      return fail("invalid-gate", "treatment outcome names a different intervention");
    if (intervention.contextSessionId !== pair.treatment.contextSessionId)
      return fail("invalid-gate", "treatment intervention session does not match its run");
    if (intervention.candidateId !== input.candidate.id)
      return fail("invalid-gate", "treatment intervention candidate does not match the gate");
    if (intervention.candidateContentHash !== input.candidate.contentHash)
      return fail("invalid-gate", "treatment intervention content does not match the gate");
    if (intervention.recordedAt === null)
      return fail("invalid-gate", "treatment intervention has no canonical timestamp");
    const interventionTime = Date.parse(intervention.recordedAt);
    if (
      outcome.sources.some(
        (source) => source.recordedAt === null || Date.parse(source.recordedAt) <= interventionTime,
      )
    )
      return fail("invalid-gate", "outcome evaluator evidence is not strictly post-intervention");
  }

  const authoritativePairs: ClosedLoopGateArtifact["pairs"] = [];
  for (const pair of input.pairs) {
    const controlMetrics = canonicalMetrics.get(pointerKey(pair.control.outcome));
    const treatmentMetrics = canonicalMetrics.get(pointerKey(pair.treatment.outcome));
    if (!controlMetrics || !treatmentMetrics)
      return fail("invalid-gate", "canonical pair metrics are incomplete");
    authoritativePairs.push({
      ...pair,
      control: authoritativeRun(pair.control, controlMetrics),
      treatment: authoritativeRun(pair.treatment, treatmentMetrics),
    });
  }
  const authoritativeArtifact: ClosedLoopGateArtifact = {
    ...input,
    pairs: authoritativePairs,
  };
  const metrics = computeMetrics(authoritativeArtifact);
  const verdict = expectedVerdict(authoritativeArtifact, metrics);
  if (input.recommendation !== verdict)
    return fail(
      "invalid-gate",
      `review recommendation ${input.recommendation} contradicts measured verdict ${verdict}`,
    );
  return {
    ok: true,
    value: { verdict, metrics, sourceEvidence: resolved.length, artifact: input },
  };
}
