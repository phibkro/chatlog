import { sha256, stableStringify } from "./events";

const HASH = /^[0-9a-f]{64}$/;
export const PROCEDURE_TRANSFER_SCORING_RULE = "chatlog/procedure-transfer-v1" as const;

export interface ProcedureTransferMetrics {
  gatePassed: boolean;
  recognizedPreconditions: number;
  totalPreconditions: number;
  repeatedExploration: number;
  toolCalls: number;
  tokens: number;
  latencyMs: number;
  corrections: number;
  environmentMistakes: number;
}

export interface ProcedureTransferEvaluationInput {
  schemaVersion: 1;
  evaluationId: string;
  scoringRule: string;
  sourceHashes: readonly string[];
  taskIds: readonly string[];
  source: { readonly provider: string; readonly harness: string };
  target: { readonly provider: string; readonly harness: string };
  arms: {
    noMemory: ProcedureTransferMetrics;
    evidenceOnly: ProcedureTransferMetrics;
    procedure: ProcedureTransferMetrics;
  };
}

export type ProcedureTransferMeasure =
  | "precondition-recognition"
  | "repeated-exploration"
  | "tool-calls"
  | "tokens"
  | "latency";

export type ProcedureTransferRegression =
  | "task-gate"
  | "correction-burden"
  | "environment-mistakes";

export interface ProcedureTransferEvaluation {
  schemaVersion: 1;
  evaluationId: string;
  scoringRule: typeof PROCEDURE_TRANSFER_SCORING_RULE;
  recommendation: "keep" | "adapt" | "reject";
  improved: readonly ProcedureTransferMeasure[];
  regressions: readonly ProcedureTransferRegression[];
  sourceHashes: readonly string[];
  source: { readonly provider: string; readonly harness: string };
  target: { readonly provider: string; readonly harness: string };
  taskIds: readonly string[];
  artifactHash: string;
}

export type ProcedureTransferEvaluationResult =
  | { ok: true; value: ProcedureTransferEvaluation }
  | { ok: false; error: { code: "invalid-evaluation"; message: string } };

function boundedError(value: unknown, label: string): string | undefined {
  return typeof value !== "number" || !Number.isFinite(value) || value < 0
    ? `${label} must be a non-negative finite number`
    : undefined;
}

function identityError(
  value: { readonly provider: string; readonly harness: string },
  label: string,
): string | undefined {
  return value === null ||
    typeof value !== "object" ||
    typeof value.provider !== "string" ||
    value.provider.trim().length === 0 ||
    typeof value.harness !== "string" ||
    value.harness.trim().length === 0
    ? `${label} must identify one provider and harness`
    : undefined;
}

function metricsError(value: ProcedureTransferMetrics, label: string): string | undefined {
  if (typeof value?.gatePassed !== "boolean") return `${label}.gatePassed must be boolean`;
  const recognizedError = boundedError(
    value.recognizedPreconditions,
    `${label}.recognizedPreconditions`,
  );
  if (recognizedError) return recognizedError;
  const totalError = boundedError(value.totalPreconditions, `${label}.totalPreconditions`);
  if (totalError) return totalError;
  if (
    !Number.isInteger(value.recognizedPreconditions) ||
    !Number.isInteger(value.totalPreconditions) ||
    value.recognizedPreconditions > value.totalPreconditions
  )
    return `${label} precondition counts are invalid`;
  for (const key of [
    "repeatedExploration",
    "toolCalls",
    "tokens",
    "latencyMs",
    "corrections",
    "environmentMistakes",
  ] as const) {
    const error = boundedError(value[key], `${label}.${key}`);
    if (error) return error;
  }
  return undefined;
}

function validationError(input: ProcedureTransferEvaluationInput): string | undefined {
  if (input.schemaVersion !== 1) return "schemaVersion must be 1";
  if (typeof input.evaluationId !== "string" || input.evaluationId.trim().length === 0)
    return "evaluationId must be non-empty";
  if (input.scoringRule !== PROCEDURE_TRANSFER_SCORING_RULE)
    return `scoringRule must be ${PROCEDURE_TRANSFER_SCORING_RULE}`;
  if (input.sourceHashes.length === 0 || !input.sourceHashes.every((hash) => HASH.test(hash)))
    return "sourceHashes must contain lowercase SHA-256 hashes";
  if (
    input.taskIds.length < 2 ||
    !input.taskIds.every((task) => typeof task === "string" && task.trim().length > 0)
  )
    return "taskIds must identify at least two provider tasks";
  const sourceError = identityError(input.source, "source");
  if (sourceError) return sourceError;
  const targetError = identityError(input.target, "target");
  if (targetError) return targetError;
  if (
    input.source.provider === input.target.provider &&
    input.source.harness === input.target.harness
  )
    return "procedure transfer must cross a provider or harness boundary";
  const noMemoryError = metricsError(input.arms.noMemory, "arms.noMemory");
  if (noMemoryError) return noMemoryError;
  const evidenceOnlyError = metricsError(input.arms.evidenceOnly, "arms.evidenceOnly");
  if (evidenceOnlyError) return evidenceOnlyError;
  const procedureError = metricsError(input.arms.procedure, "arms.procedure");
  if (procedureError) return procedureError;
  if (
    input.arms.noMemory.totalPreconditions !== input.arms.procedure.totalPreconditions ||
    input.arms.evidenceOnly.totalPreconditions !== input.arms.procedure.totalPreconditions
  )
    return "all treatment arms must score the same preconditions";
  return undefined;
}

export function evaluateProcedureTransfer(
  input: ProcedureTransferEvaluationInput,
): ProcedureTransferEvaluationResult {
  const error = validationError(input);
  if (error)
    return {
      ok: false,
      error: { code: "invalid-evaluation", message: error },
    };
  const baseline = input.arms.evidenceOnly;
  const procedure = input.arms.procedure;
  const improved: ProcedureTransferMeasure[] = [];
  if (procedure.recognizedPreconditions > baseline.recognizedPreconditions)
    improved.push("precondition-recognition");
  if (procedure.repeatedExploration < baseline.repeatedExploration)
    improved.push("repeated-exploration");
  if (procedure.toolCalls < baseline.toolCalls) improved.push("tool-calls");
  if (procedure.tokens < baseline.tokens) improved.push("tokens");
  if (procedure.latencyMs < baseline.latencyMs) improved.push("latency");

  const regressions: ProcedureTransferRegression[] = [];
  if (!procedure.gatePassed) regressions.push("task-gate");
  if (procedure.corrections > Math.min(input.arms.noMemory.corrections, baseline.corrections))
    regressions.push("correction-burden");
  if (
    procedure.environmentMistakes >
    Math.min(input.arms.noMemory.environmentMistakes, baseline.environmentMistakes)
  )
    regressions.push("environment-mistakes");

  const recommendation: ProcedureTransferEvaluation["recommendation"] = !procedure.gatePassed
    ? "reject"
    : regressions.length > 0 || improved.length === 0
      ? "adapt"
      : "keep";
  const body = {
    schemaVersion: 1 as const,
    evaluationId: input.evaluationId,
    scoringRule: PROCEDURE_TRANSFER_SCORING_RULE,
    recommendation,
    improved,
    regressions,
    sourceHashes: input.sourceHashes.toSorted(),
    taskIds: input.taskIds.toSorted(),
    source: { ...input.source },
    target: { ...input.target },
  };
  return { ok: true, value: { ...body, artifactHash: sha256(stableStringify(body)) } };
}
