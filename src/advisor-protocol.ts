import { sha256, stableStringify } from "./events";
import {
  recordContextEvent,
  type ContextEventError,
  type ContextEventRecord,
} from "./context-events";

const HASH = /^[0-9a-f]{64}$/;
const ACTIONS = ["continue", "annotate", "reconsider", "escalate"] as const;
const CHECKPOINTS = [
  "before-tool-call",
  "before-material-mutation",
  "after-failure",
  "before-commit-or-deployment",
  "before-final-answer",
] as const;

export type AdvisorCheckpoint = (typeof CHECKPOINTS)[number];
export type AdvisorAction = (typeof ACTIONS)[number];
export type AdvisorBasisKind = "evidence" | "active-insight" | "enforced-policy" | "assumption";

export interface ShadowAdvisorBudget {
  maxInterruptions: number;
  maxRecallQueries: number;
  maxReplanRequests: number;
  maxAddedTokens: number;
  deadlineAt: string;
}

export interface ShadowAdvisorConsumed {
  interruptions: number;
  recallQueries: number;
  replanRequests: number;
  addedTokens: number;
}

export interface ShadowAdviceProposal {
  action: AdvisorAction;
  note: string;
  changedPlanHash: string | null;
  escalationReason: string | null;
  evidenceIds: readonly string[];
  recallQueries: number;
  addedTokens: number;
  basis: readonly { kind: AdvisorBasisKind; reference: string }[];
}

export interface ShadowAdviceInput {
  schemaVersion: 1;
  contextSessionId: string;
  checkpoint: AdvisorCheckpoint;
  proposedActionHash: string;
  policyReferences: readonly string[];
  budget: ShadowAdvisorBudget;
  consumed: ShadowAdvisorConsumed;
  priorAdviceHashes: readonly string[];
  priorEvidenceIds: readonly string[];
  parentAdvisorInterventionId: string | null;
  scopeClosed: boolean;
  now: string;
  advice: ShadowAdviceProposal;
}

export type AdvisorStopReason =
  | "continued"
  | "annotated"
  | "new-evidence"
  | "changed-plan"
  | "escalated"
  | "no-novelty"
  | "budget-exhausted"
  | "deadline"
  | "scope-closed";

export interface ShadowAdviceDecision {
  schemaVersion: 1;
  contextSessionId: string;
  checkpoint: AdvisorCheckpoint;
  proposedActionHash: string;
  mode: "shadow";
  status: "accepted" | "stopped";
  action: AdvisorAction | null;
  stopReason: AdvisorStopReason;
  adviceHash: string;
  consumed: ShadowAdvisorConsumed;
  remaining: ShadowAdvisorConsumed;
  policyReferences: readonly string[];
  basis: ShadowAdviceProposal["basis"];
  canBlock: false;
  canMutate: false;
  canInvokeTools: false;
}

export interface AdvisorPersistenceError {
  code: "persistence-error";
  retryable: true;
  phase: "storage";
  message: string;
}

export type ShadowAdviceResult =
  | { ok: true; value: ShadowAdviceDecision }
  | {
      ok: false;
      error: {
        code: "invalid-advice" | "recursive-supervision";
        message: string;
      };
    };
type AdviceValidationError = Extract<ShadowAdviceResult, { ok: false }>["error"];

function nonNegativeIntegerError(value: unknown, label: string): string | undefined {
  return !Number.isInteger(value) || (value as number) < 0
    ? `${label} must be a non-negative integer`
    : undefined;
}

function timestampError(value: unknown, label: string): string | undefined {
  return typeof value !== "string" || !Number.isFinite(Date.parse(value))
    ? `${label} must be an ISO timestamp`
    : undefined;
}

function boundedTextError(value: unknown, label: string, nullable = false): string | undefined {
  if (nullable && value === null) return undefined;
  return typeof value !== "string" || value.trim().length === 0 || value.length > 1_500
    ? `${label} must be bounded non-empty text`
    : undefined;
}

function hashError(value: unknown, label: string): string | undefined {
  return typeof value !== "string" || !HASH.test(value)
    ? `${label} must be a lowercase SHA-256 hash`
    : undefined;
}

function invalidAdvice(message: string): AdviceValidationError {
  return { code: "invalid-advice", message };
}

function validationError(input: ShadowAdviceInput): AdviceValidationError | undefined {
  if (input === null || typeof input !== "object") return invalidAdvice("advice must be an object");
  if (input.schemaVersion !== 1) return invalidAdvice("schemaVersion must be 1");
  const sessionError = hashError(input.contextSessionId, "contextSessionId");
  if (sessionError) return invalidAdvice(sessionError);
  const actionHashError = hashError(input.proposedActionHash, "proposedActionHash");
  if (actionHashError) return invalidAdvice(actionHashError);
  if (!CHECKPOINTS.includes(input.checkpoint)) return invalidAdvice("checkpoint is not supported");
  if (input.parentAdvisorInterventionId !== null) {
    const parentError = hashError(input.parentAdvisorInterventionId, "parentAdvisorInterventionId");
    if (parentError) return invalidAdvice(parentError);
    return {
      code: "recursive-supervision",
      message: "an advisor intervention cannot supervise another advisor intervention",
    };
  }
  if (input.advice === null || typeof input.advice !== "object")
    return invalidAdvice("advice must be an object");
  if (!(ACTIONS as readonly unknown[]).includes(input.advice.action))
    return invalidAdvice(
      `advisor action ${String(input.advice.action)} is not allowed in shadow mode`,
    );
  const noteError = boundedTextError(input.advice.note, "advice.note");
  if (noteError) return invalidAdvice(noteError);
  const normalizedNote = input.advice.note.trim().toLowerCase();
  if (/^think( about it)? more[.!]?$/.test(normalizedNote))
    return invalidAdvice("think more is not actionable advice");
  if (input.advice.changedPlanHash !== null) {
    const changedPlanError = hashError(input.advice.changedPlanHash, "advice.changedPlanHash");
    if (changedPlanError) return invalidAdvice(changedPlanError);
  }
  if (input.advice.action === "reconsider" && input.advice.changedPlanHash === null)
    return invalidAdvice("reconsider advice must identify a changed plan hash");
  const escalationError = boundedTextError(
    input.advice.escalationReason,
    "advice.escalationReason",
    true,
  );
  if (escalationError) return invalidAdvice(escalationError);
  if (input.advice.action === "escalate" && input.advice.escalationReason === null)
    return invalidAdvice("escalation advice must include a reason");
  for (const [values, label] of [
    [input.advice.evidenceIds, "advice.evidenceIds[]"],
    [input.priorAdviceHashes, "priorAdviceHashes[]"],
    [input.priorEvidenceIds, "priorEvidenceIds[]"],
  ] as const) {
    if (!Array.isArray(values)) return invalidAdvice(`${label} must be an array`);
    for (const value of values) {
      const error = hashError(value, label);
      if (error) return invalidAdvice(error);
    }
  }
  if (!Array.isArray(input.advice.basis)) return invalidAdvice("advice.basis must be an array");
  for (const basis of input.advice.basis) {
    if (
      basis === null ||
      typeof basis !== "object" ||
      !["evidence", "active-insight", "enforced-policy", "assumption"].includes(basis.kind)
    )
      return invalidAdvice("advice basis kind is invalid");
    const basisError = boundedTextError(basis.reference, "advice.basis.reference");
    if (basisError) return invalidAdvice(basisError);
  }
  if (input.advice.action !== "continue" && input.advice.basis.length === 0)
    return invalidAdvice("non-continue advice must identify its basis");
  for (const [value, label] of [
    [input.advice.recallQueries, "advice.recallQueries"],
    [input.advice.addedTokens, "advice.addedTokens"],
  ] as const) {
    const error = nonNegativeIntegerError(value, label);
    if (error) return invalidAdvice(error);
  }
  if (input.budget === null || typeof input.budget !== "object")
    return invalidAdvice("budget must be an object");
  for (const [value, label] of [
    [input.budget.maxInterruptions, "budget.maxInterruptions"],
    [input.budget.maxRecallQueries, "budget.maxRecallQueries"],
    [input.budget.maxReplanRequests, "budget.maxReplanRequests"],
    [input.budget.maxAddedTokens, "budget.maxAddedTokens"],
  ] as const) {
    const error = nonNegativeIntegerError(value, label);
    if (error) return invalidAdvice(error);
  }
  const deadlineError = timestampError(input.budget.deadlineAt, "budget.deadlineAt");
  if (deadlineError) return invalidAdvice(deadlineError);
  if (input.consumed === null || typeof input.consumed !== "object")
    return invalidAdvice("consumed must be an object");
  for (const [value, label] of [
    [input.consumed.interruptions, "consumed.interruptions"],
    [input.consumed.recallQueries, "consumed.recallQueries"],
    [input.consumed.replanRequests, "consumed.replanRequests"],
    [input.consumed.addedTokens, "consumed.addedTokens"],
  ] as const) {
    const error = nonNegativeIntegerError(value, label);
    if (error) return invalidAdvice(error);
  }
  const nowError = timestampError(input.now, "now");
  return nowError ? invalidAdvice(nowError) : undefined;
}

function remaining(
  budget: ShadowAdvisorBudget,
  consumed: ShadowAdvisorConsumed,
): ShadowAdvisorConsumed {
  return {
    interruptions: Math.max(0, budget.maxInterruptions - consumed.interruptions),
    recallQueries: Math.max(0, budget.maxRecallQueries - consumed.recallQueries),
    replanRequests: Math.max(0, budget.maxReplanRequests - consumed.replanRequests),
    addedTokens: Math.max(0, budget.maxAddedTokens - consumed.addedTokens),
  };
}

export function evaluateShadowAdvice(input: ShadowAdviceInput): ShadowAdviceResult {
  const error = validationError(input);
  if (error) return { ok: false, error };
  const adviceBody = {
    checkpoint: input.checkpoint,
    proposedActionHash: input.proposedActionHash,
    action: input.advice.action,
    note: input.advice.note,
    changedPlanHash: input.advice.changedPlanHash,
    escalationReason: input.advice.escalationReason,
    evidenceIds: input.advice.evidenceIds.toSorted(),
    basis: input.advice.basis.toSorted((left, right) =>
      `${left.kind}\0${left.reference}`.localeCompare(`${right.kind}\0${right.reference}`),
    ),
  };
  const adviceHash = sha256(stableStringify(adviceBody));
  const base = {
    schemaVersion: 1 as const,
    contextSessionId: input.contextSessionId,
    checkpoint: input.checkpoint,
    proposedActionHash: input.proposedActionHash,
    mode: "shadow" as const,
    adviceHash,
    policyReferences: input.policyReferences,
    basis: input.advice.basis,
    canBlock: false as const,
    canMutate: false as const,
    canInvokeTools: false as const,
  };
  const stopped = (stopReason: AdvisorStopReason): ShadowAdviceResult => ({
    ok: true,
    value: {
      ...base,
      status: "stopped",
      action: null,
      stopReason,
      consumed: input.consumed,
      remaining: remaining(input.budget, input.consumed),
    },
  });
  if (input.scopeClosed) return stopped("scope-closed");
  if (Date.parse(input.now) >= Date.parse(input.budget.deadlineAt)) return stopped("deadline");
  if (
    input.consumed.interruptions >= input.budget.maxInterruptions ||
    input.consumed.recallQueries + input.advice.recallQueries > input.budget.maxRecallQueries ||
    input.consumed.addedTokens + input.advice.addedTokens > input.budget.maxAddedTokens ||
    (input.advice.action === "reconsider" &&
      input.consumed.replanRequests >= input.budget.maxReplanRequests)
  )
    return stopped("budget-exhausted");
  if (input.priorAdviceHashes.includes(adviceHash)) return stopped("no-novelty");

  const newEvidence = input.advice.evidenceIds.some((id) => !input.priorEvidenceIds.includes(id));
  const stopReason: AdvisorStopReason =
    input.advice.action === "continue"
      ? "continued"
      : input.advice.action === "annotate"
        ? newEvidence
          ? "new-evidence"
          : "annotated"
        : input.advice.action === "reconsider"
          ? "changed-plan"
          : "escalated";
  const consumed: ShadowAdvisorConsumed = {
    interruptions: input.consumed.interruptions + 1,
    recallQueries: input.consumed.recallQueries + input.advice.recallQueries,
    replanRequests: input.consumed.replanRequests + (input.advice.action === "reconsider" ? 1 : 0),
    addedTokens: input.consumed.addedTokens + input.advice.addedTokens,
  };
  return {
    ok: true,
    value: {
      ...base,
      status: "accepted",
      action: input.advice.action,
      stopReason,
      consumed,
      remaining: remaining(input.budget, consumed),
    },
  };
}

export interface RecordShadowAdviceInput extends ShadowAdviceInput {
  idempotencyKey: string;
  actorId?: string;
  occurredAt?: string;
}

export type RecordShadowAdviceResult =
  | { ok: true; value: { decision: ShadowAdviceDecision; event: ContextEventRecord } }
  | {
      ok: false;
      error:
        | ContextEventError
        | AdvisorPersistenceError
        | { code: "invalid-advice" | "recursive-supervision"; message: string };
    };

export async function recordShadowAdvice(
  root: string,
  input: RecordShadowAdviceInput,
): Promise<RecordShadowAdviceResult> {
  const evaluated = evaluateShadowAdvice(input);
  if (!evaluated.ok) return evaluated;
  const decision = evaluated.value;
  const recorded = await recordContextEvent(root, {
    kind: "context.advisor.advice",
    contextSessionId: input.contextSessionId,
    idempotencyKey: input.idempotencyKey,
    actor: { kind: "system", id: input.actorId ?? "chatlog-shadow-advisor" },
    actorAuthority: "system",
    inputHash: input.proposedActionHash,
    contentHash: decision.adviceHash,
    bounds: {
      budget: input.budget,
      consumed: decision.consumed,
      remaining: decision.remaining,
    },
    provenance: {
      policyReferences: decision.policyReferences,
      basis: decision.basis,
    },
    payload: {
      checkpoint: decision.checkpoint,
      mode: decision.mode,
      status: decision.status,
      action: decision.action,
      stopReason: decision.stopReason,
      canBlock: decision.canBlock,
      canMutate: decision.canMutate,
      canInvokeTools: decision.canInvokeTools,
    },
    occurredAt: input.occurredAt ?? input.now,
  });
  if (recorded.ok) return { ok: true, value: { decision, event: recorded.value } };
  if (recorded.error.code === "storage-error")
    return {
      ok: false,
      error: {
        code: "persistence-error",
        retryable: true,
        phase: "storage",
        message: recorded.error.message,
      },
    };
  return recorded;
}
