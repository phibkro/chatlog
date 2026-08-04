import { randomUUID } from "node:crypto";
import { Effect } from "effect";
import {
  RecallBudgetLedger,
  type BudgetValidation,
  type RecallBudget,
  type RecallChildBudgetInput,
  type RecallScope,
  type ScopeValidation,
  defaultChildBudget,
  deriveChildBudget,
  inheritRecallScope,
  validateRecallBudget,
  validateRecallScope,
} from "./recall-budget";
import {
  validateBoundedRecord as validateRecordWithin,
  type BoundedRecordLimits,
  type BoundedRecordValidation,
} from "./bounded-input";
import {
  consolidateRecall,
  type RecallBranchFailureCode,
  type RecallBranchFailureObservation,
  type RecallBranchObservation,
  type RecallBranchStatus,
  type RecallConsolidationOptions,
  type RecallQueryTrace,
  type RecallResult,
  type RecallTerminationReason,
  type RecallBranchTrace,
} from "./recall-consolidation";
import { MAX_STAGED_RECALL_EVENT_BATCHES } from "./context-types";

export type {
  ConfidenceAssessment,
  Contradiction,
  EvidenceItem,
  InsightItem,
  ProcedureReference,
  RecallBranchFailure,
  RecallBranchFailureCode,
  RecallBranchObservation,
  RecallBranchStatus,
  RecallBranchSuccessObservation,
  RecallResult,
  RecallTerminationReason,
  RecallTrace,
  RecallBranchTrace,
} from "./recall-consolidation";
export type { RecallBudget, RecallScope } from "./recall-budget";
export const MAX_RECALL_ADAPTERS = Math.floor((MAX_STAGED_RECALL_EVENT_BATCHES - 2) / 2);
export const MAX_RECALL_VECTOR_ITEMS = 256;
export const MAX_RECALL_TEXT_LENGTH = 4_096;
export const MAX_RECALL_RECORD_DEPTH = 8;
export const MAX_RECALL_RECORD_KEYS = 512;
export const MAX_RECALL_RECORD_ARRAY_ITEMS = 256;
export const MAX_RECALL_RECORD_BYTES = 256 * 1024;
export const MAX_RECALL_ROUNDS = 256;
const DEFAULT_RECALL_RECORD_LIMITS: BoundedRecordLimits = {
  maxDepth: MAX_RECALL_RECORD_DEPTH,
  maxKeys: MAX_RECALL_RECORD_KEYS,
  maxArrayItems: MAX_RECALL_RECORD_ARRAY_ITEMS,
  maxStringLength: MAX_RECALL_TEXT_LENGTH,
  maxBytes: MAX_RECALL_RECORD_BYTES,
};

export type { BoundedRecordLimits, BoundedRecordValidation } from "./bounded-input";

export function validateBoundedRecord(
  value: unknown,
  label: string,
  limits: BoundedRecordLimits = DEFAULT_RECALL_RECORD_LIMITS,
): BoundedRecordValidation {
  return validateRecordWithin(value, label, limits);
}

export type RecallErrorCode =
  | "invalid-request"
  | "invalid-budget"
  | "scope-denied"
  | "persistence-error"
  | "finalization-error";

export type RecallErrorPhase =
  | "parent-read"
  | "stage"
  | "lock"
  | "debit"
  | "publish"
  | "outbox-clear"
  | "storage";

export interface RecallErrorOptions {
  readonly phase?: RecallErrorPhase;
  readonly cause?: unknown;
}

export class RecallError extends Error {
  readonly _tag = "RecallError" as const;
  readonly code: RecallErrorCode;
  readonly retryable: boolean;
  readonly phase?: RecallErrorPhase;

  constructor(code: RecallErrorCode, message: string, options: RecallErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "RecallError";
    this.code = code;
    this.retryable = code === "persistence-error" || code === "finalization-error";
    this.phase = options.phase;
  }
}

export interface RecallDeadline {
  readonly at: number;
  readonly isExpired: (now?: number) => boolean;
  readonly remainingMs: (now?: number) => number;
}

export interface RecallClock {
  readonly now: () => number;
  readonly waitUntil: (timestamp: number) => Effect.Effect<void>;
}

const systemRecallClock: RecallClock = {
  now: () => Date.now(),
  waitUntil: (timestamp) =>
    Effect.callback((resume, signal) => {
      const delay = Math.max(0, timestamp - Date.now());
      const timer = setTimeout(() => resume(Effect.void), delay);
      const clear = (): void => clearTimeout(timer);
      signal.addEventListener("abort", clear, { once: true });
      return Effect.sync(() => {
        clear();
        signal.removeEventListener("abort", clear);
      });
    }),
};

export function recallDeadline(clock: RecallClock, latencyMs: number): RecallDeadline {
  const at = clock.now() + Math.max(0, latencyMs);
  return {
    at,
    isExpired: (now = clock.now()): boolean => now >= at,
    remainingMs: (now = clock.now()): number => Math.max(0, at - now),
  };
}

export interface RecallRequest {
  readonly invocationId?: string;
  readonly query: string;
  readonly scope: RecallScope;
  readonly budget: RecallBudget;
  readonly parentSignal?: AbortSignal;
  readonly signal?: AbortSignal;
  readonly scopeClosed?: boolean | (() => boolean);
  readonly visitedEvidenceIds?: readonly string[];
  readonly visitedInsightRevisions?: readonly string[];
  readonly queryAncestry?: readonly string[];
  readonly priorConsolidationHashes?: readonly string[];
  readonly previousResultHash?: string;
  readonly previousUnresolved?: readonly string[];
  readonly minimumEvidence?: number;
  readonly maxRounds?: number;
  readonly contextSessionId: string;
  readonly adapters?: readonly RecallBranchAdapter[];
}

export interface RecallBranchContext {
  readonly contextSessionId: string;
  readonly branchId: string;
  readonly query: string;
  readonly normalizedQuery: string;
  readonly depth: number;
  readonly budget: RecallBudget;
  readonly scope: RecallScope;
  readonly queryAncestry: readonly string[];
  readonly visitedEvidenceIds: ReadonlySet<string>;
  readonly visitedInsightRevisions: ReadonlySet<string>;
  readonly clock: RecallClock;
  readonly deadline: RecallDeadline;
  readonly signal: AbortSignal;
  readonly deriveChildBudget: (child: RecallChildBudgetInput) => BudgetValidation;
  readonly inheritScope: (child?: RecallScope) => ScopeValidation;
}

export type RecallAdapterEffect =
  | RecallBranchObservation
  | Effect.Effect<RecallBranchObservation, unknown, never>
  | PromiseLike<RecallBranchObservation>;

export type RecallBranchAdapter = (context: RecallBranchContext) => RecallAdapterEffect;

export interface RecallBranchDefinition {
  readonly id: string;
  readonly run: RecallBranchAdapter;
}

export interface RecallRuntimeOptions {
  readonly adapters?: readonly (RecallBranchAdapter | RecallBranchDefinition)[];
  readonly branches?: readonly (RecallBranchAdapter | RecallBranchDefinition)[];
  readonly clock?: RecallClock;
}

export interface RecallRuntime {
  readonly recall: (request: RecallRequest) => Effect.Effect<RecallResult, RecallError>;
}

interface RuntimeState {
  readonly observations: RecallBranchObservation[];
  readonly branchTraces: RecallBranchTrace[];
  readonly queryTraces: RecallQueryTrace[];
  readonly queryLineage: Set<string>;
  readonly visitedEvidenceIds: Set<string>;
  readonly visitedInsightRevisions: Set<string>;
  readonly baselineEvidenceIds: Set<string>;
  readonly baselineInsightRevisions: Set<string>;
  readonly priorHashes: Set<string>;
  readonly unresolved: Set<string>;
  readonly cancelledBranches: Set<string>;
  readonly omissions: Set<string>;
  parentRequestedCancellation: boolean;
  timedOut: boolean;
  scopeClosed: boolean;
  cycleDetected: boolean;
  maxDepthReached: number;
}

interface BranchCompletion {
  readonly adapter: RecallBranchDefinition;
  readonly result: RecallBranchObservation | { readonly timedOut: true };
  readonly startedAt: number;
  readonly finishedAt: number;
  readonly budget?: RecallBudget;
}

interface RoundOutcome {
  readonly nextQueries: readonly string[];
  readonly timedOut: boolean;
  readonly scopeClosed: boolean;
  readonly launched: number;
}

function normalizeQuery(query: string): string {
  return query
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[\p{P}\p{S}]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

export function normalizeRecallQuery(query: string): string {
  return normalizeQuery(query);
}

const CONTEXT_SESSION_ID = /^[a-f0-9]{64}$/u;

export function queryCycle(queryAncestry: readonly string[], query: string): boolean {
  const normalized = normalizeQuery(query);
  return queryAncestry.some((candidate) => normalizeQuery(candidate) === normalized);
}
function boundedStringVectorError(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return `${label} must be an array`;
  if (value.length > MAX_RECALL_VECTOR_ITEMS)
    return `${label} must contain at most ${MAX_RECALL_VECTOR_ITEMS} items`;
  for (const [index, item] of value.entries()) {
    if (typeof item !== "string") return `${label}[${index}] must be text`;
    if (item.length > MAX_RECALL_TEXT_LENGTH)
      return `${label}[${index}] must be at most ${MAX_RECALL_TEXT_LENGTH} characters`;
  }
  return undefined;
}

function boundedTextError(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") return `${label} must be text`;
  if (value.length > MAX_RECALL_TEXT_LENGTH)
    return `${label} must be at most ${MAX_RECALL_TEXT_LENGTH} characters`;
  return undefined;
}

function boundedRecordError(value: unknown, label: string): string | undefined {
  const validation = validateBoundedRecord(value, label);
  return validation.ok ? undefined : validation.error;
}

type RecallItemKind = "evidence" | "insight" | "procedure" | "contradiction" | "confidence";

function recallItemError(value: unknown, label: string, kind: RecallItemKind): string | undefined {
  const bounded = boundedRecordError(value, label);
  if (bounded) return bounded;
  const record = value as Record<string, unknown>;
  const idError =
    kind === "confidence"
      ? boundedTextError(record.id, `${label}.id`)
      : typeof record.id !== "string" || record.id.length === 0
        ? `${label}.id must be non-empty text`
        : record.id.length > MAX_RECALL_TEXT_LENGTH
          ? `${label}.id must be at most ${MAX_RECALL_TEXT_LENGTH} characters`
          : undefined;
  if (idError) return idError;
  for (const [key, field] of [
    ["references", "references"],
    ["support", "support"],
    ["counterevidence", "counterevidence"],
    ["supportEvidence", "supportEvidence"],
    ["counterEvidence", "counterEvidence"],
    ["preconditions", "preconditions"],
    ["actions", "actions"],
    ["successObservations", "successObservations"],
    ["failureObservations", "failureObservations"],
    ["requiredAuthority", "requiredAuthority"],
    ["evidenceHashes", "evidenceHashes"],
    ["evaluationHashes", "evaluationHashes"],
    ["evidence", "evidence"],
  ] as const) {
    if (record[key] === undefined) continue;
    const vectorError = boundedStringVectorError(record[key], `${label}.${field}`);
    if (vectorError) return vectorError;
  }
  for (const [key, field] of [
    ["revisionId", "revisionId"],
    ["procedureId", "procedureId"],
    ["version", "version"],
    ["sourceUri", "sourceUri"],
    ["contentHash", "contentHash"],
    ["trigger", "trigger"],
    ["proposition", "proposition"],
    ["content", "content"],
    ["reference", "reference"],
    ["assessor", "assessor"],
    ["rationale", "rationale"],
    ["left", "left"],
    ["right", "right"],
    ["claimA", "claimA"],
    ["claimB", "claimB"],
  ] as const) {
    const textError = boundedTextError(record[key], `${label}.${field}`);
    if (textError) return textError;
  }
  if (record.scope !== undefined) {
    const scopeError = boundedRecordError(record.scope, `${label}.scope`);
    if (scopeError) return scopeError;
  }
  if (record.validTime !== undefined) {
    const validTimeError = boundedRecordError(record.validTime, `${label}.validTime`);
    if (validTimeError) return validTimeError;
  }
  if (record.authority !== undefined && typeof record.authority !== "string") {
    const authorityError = boundedRecordError(record.authority, `${label}.authority`);
    if (authorityError) return authorityError;
  }
  if (record.authoredBy !== undefined) {
    const authoredByError = boundedRecordError(record.authoredBy, `${label}.authoredBy`);
    if (authoredByError) return authoredByError;
  }
  if (record.environment !== undefined && typeof record.environment !== "string") {
    const environmentError = boundedRecordError(record.environment, `${label}.environment`);
    if (environmentError) return environmentError;
  }
  if (kind === "confidence") {
    if (typeof record.value !== "number" || !Number.isFinite(record.value))
      return `${label}.value must be finite`;
  }
  return undefined;
}

function boundedItemVectorError(
  value: unknown,
  label: string,
  kind: RecallItemKind,
): string | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return `${label} must be an array`;
  if (value.length > MAX_RECALL_VECTOR_ITEMS)
    return `${label} must contain at most ${MAX_RECALL_VECTOR_ITEMS} items`;
  for (const [index, item] of value.entries()) {
    const itemError = recallItemError(item, `${label}[${index}]`, kind);
    if (itemError) return itemError;
  }
  return undefined;
}

function recallUsageError(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  const bounded = boundedRecordError(value, label);
  if (bounded) return bounded;
  const usage = value as Record<string, unknown>;
  for (const key of [
    "maxDepth",
    "maxBranches",
    "maxQueries",
    "maxResults",
    "maxTokens",
    "maxLatencyMs",
    "maxCostUsd",
  ] as const) {
    if (usage[key] === undefined) continue;
    if (typeof usage[key] !== "number" || !Number.isFinite(usage[key]) || usage[key] < 0)
      return `${label}.${key} must be finite and non-negative`;
    if (
      ["maxDepth", "maxBranches", "maxQueries", "maxResults", "maxTokens"].includes(key) &&
      !Number.isInteger(usage[key])
    )
      return `${label}.${key} must be an integer`;
  }
  return undefined;
}

function observationError(value: unknown): string | undefined {
  const bounded = boundedRecordError(value, "branch observation");
  if (bounded) return bounded;
  const record = value as Record<string, unknown>;
  if (typeof record.ok !== "boolean") return "branch observation.ok must be boolean";
  if (typeof record.branchId !== "string" || record.branchId.length === 0)
    return "branch observation.branchId must be non-empty text";
  if (record.branchId.length > MAX_RECALL_TEXT_LENGTH)
    return `branch observation.branchId must be at most ${MAX_RECALL_TEXT_LENGTH} characters`;
  for (const [key, label] of [
    ["query", "branch observation.query"],
    ["answer", "branch observation.answer"],
  ] as const) {
    const textError = boundedTextError(record[key], label);
    if (textError) return textError;
  }
  for (const [key, label] of [
    ["unresolved", "branch observation.unresolved"],
    ["followUpQueries", "branch observation.followUpQueries"],
  ] as const) {
    const vectorError = boundedStringVectorError(record[key], label);
    if (vectorError) return vectorError;
  }
  for (const [key, kind] of [
    ["evidence", "evidence"],
    ["insights", "insight"],
    ["procedures", "procedure"],
    ["contradictions", "contradiction"],
    ["confidence", "confidence"],
  ] as const) {
    const vectorError = boundedItemVectorError(record[key], `branch observation.${key}`, kind);
    if (vectorError) return vectorError;
  }
  const usageError = recallUsageError(record.usage, "branch observation.usage");
  if (usageError) return usageError;
  for (const [key, label] of [
    ["tokens", "branch observation.tokens"],
    ["costUsd", "branch observation.costUsd"],
    ["finishedAt", "branch observation.finishedAt"],
  ] as const) {
    if (
      record[key] !== undefined &&
      (typeof record[key] !== "number" || !Number.isFinite(record[key]))
    )
      return `${label} must be finite`;
  }
  if (record.ok === false) {
    const failureError = boundedRecordError(record.failure, "branch observation.failure");
    if (failureError) return failureError;
    const failure = record.failure as Record<string, unknown>;
    for (const [key, label] of [
      ["code", "branch observation.failure.code"],
      ["branchId", "branch observation.failure.branchId"],
      ["query", "branch observation.failure.query"],
      ["message", "branch observation.failure.message"],
    ] as const) {
      const textError = boundedTextError(failure[key], label);
      if (textError) return textError;
    }
    if (
      failure.observedAt !== undefined &&
      (typeof failure.observedAt !== "number" || !Number.isFinite(failure.observedAt))
    )
      return "branch observation.failure.observedAt must be finite";
  }
  return undefined;
}

function scopeClosed(value: RecallScope, explicit: boolean | (() => boolean) | undefined): boolean {
  if (explicit !== undefined) return typeof explicit === "function" ? explicit() : explicit;
  return value.closed === true;
}

function emptyBudget(): RecallBudget {
  return {
    maxDepth: 0,
    maxBranches: 0,
    maxQueries: 0,
    maxResults: 0,
    maxTokens: 0,
    maxLatencyMs: 0,
    maxCostUsd: 0,
  };
}

function emptyUsage(): RecallBudget {
  return emptyBudget();
}

function failure(
  branchId: string,
  query: string,
  code: RecallBranchFailureCode,
  message: string,
  now: number,
  cause?: unknown,
): RecallBranchFailureObservation {
  return {
    ok: false,
    branchId,
    query,
    failure: {
      code,
      branchId,
      query,
      message,
      observedAt: now,
      ...(cause === undefined ? {} : { cause }),
    },
  };
}

function isObservation(value: unknown): value is RecallBranchObservation {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  if (!("ok" in value) || !("branchId" in value)) return false;
  if (value.ok === true) return typeof value.branchId === "string";
  if (value.ok === false) return typeof value.branchId === "string" && "failure" in value;
  return false;
}

const ITEM_SCOPE_KEYS = [
  "domain",
  "project",
  "repository",
  "provider",
  "path",
  "harness",
  "model",
  "user",
  "organization",
  "tool",
  "itemPermissions",
] as const;

function itemScopeWithin(parent: RecallScope, item: unknown): boolean {
  if (item === null || typeof item !== "object" || Array.isArray(item)) return false;
  const record = item as Record<string, unknown>;
  if (!("scope" in record) || record.scope === undefined) return true;
  if (record.scope === null || typeof record.scope !== "object" || Array.isArray(record.scope))
    return false;
  const rawScope = record.scope as Record<string, unknown>;
  const unknownKeys = Object.keys(rawScope).filter(
    (key) => key !== "harnesses" && !(ITEM_SCOPE_KEYS as readonly string[]).includes(key),
  );
  if (unknownKeys.length > 0) return false;
  const harnesses = rawScope.harnesses;
  if (harnesses !== undefined) {
    if (
      !Array.isArray(harnesses) ||
      harnesses.length === 0 ||
      harnesses.some((harness) => typeof harness !== "string" || harness.length === 0)
    )
      return false;
    if (parent.harness !== undefined && harnesses.some((harness) => harness !== parent.harness))
      return false;
  }
  const childScope: Record<string, unknown> = {};
  for (const key of ITEM_SCOPE_KEYS)
    if (Object.prototype.hasOwnProperty.call(rawScope, key)) childScope[key] = rawScope[key];
  return inheritRecallScope(parent, childScope).ok;
}

function scopedItems<T>(
  items: readonly T[] | undefined,
  parent: RecallScope,
): readonly T[] | undefined {
  if (items === undefined) return undefined;
  if (!Array.isArray(items)) return [];
  return items.filter((item) => itemScopeWithin(parent, item));
}

function normalizeObservation(
  value: unknown,
  branchId: string,
  query: string,
  now: number,
  scope: RecallScope,
): RecallBranchObservation {
  try {
    const validationError = observationError(value);
    if (validationError)
      return failure(branchId, query, "invalid-observation", validationError, now);
    if (!isObservation(value))
      return failure(
        branchId,
        query,
        "invalid-observation",
        "branch returned an invalid observation",
        now,
      );
    if (value.ok === false) {
      const branchFailure = value.failure;
      return {
        ...value,
        query,
        failure: {
          ...branchFailure,
          branchId,
          query,
          observedAt: branchFailure.observedAt ?? now,
        },
      };
    }
    return {
      ...value,
      branchId,
      query,
      evidence: scopedItems(value.evidence, scope),
      insights: scopedItems(value.insights, scope),
      procedures: scopedItems(value.procedures, scope),
      contradictions: scopedItems(value.contradictions, scope),
      confidence: scopedItems(value.confidence, scope),
    };
  } catch (error) {
    return failure(
      branchId,
      query,
      "invalid-observation",
      `branch returned an invalid observation: ${
        error instanceof Error ? error.message : String(error)
      }`,
      now,
    );
  }
}

function effectFromAdapter(
  adapter: RecallBranchAdapter,
  context: RecallBranchContext,
  now: number,
): Effect.Effect<RecallBranchObservation> {
  const invoked = Effect.try({
    try: () => adapter(context),
    catch: (error) => error,
  });
  return Effect.exit(invoked).pipe(
    Effect.flatMap((invocation) => {
      if (invocation._tag === "Failure")
        return Effect.succeed(
          failure(
            context.branchId,
            context.query,
            "provider-error",
            "branch invocation failed",
            now,
            invocation.cause,
          ),
        );
      const value = invocation.value;
      if (Effect.isEffect(value))
        return Effect.exit(value as Effect.Effect<unknown, unknown, never>).pipe(
          Effect.map((exit) =>
            exit._tag === "Success"
              ? normalizeObservation(
                  exit.value,
                  context.branchId,
                  context.query,
                  now,
                  context.scope,
                )
              : failure(
                  context.branchId,
                  context.query,
                  "provider-error",
                  "branch effect failed",
                  now,
                  exit.cause,
                ),
          ),
        );
      if (value !== null && typeof value === "object" && "then" in value) {
        const promised = Effect.tryPromise({
          try: () => Promise.resolve(value as PromiseLike<RecallBranchObservation>),
          catch: (error) => error,
        });
        return Effect.exit(promised).pipe(
          Effect.map((exit) =>
            exit._tag === "Success"
              ? normalizeObservation(
                  exit.value,
                  context.branchId,
                  context.query,
                  now,
                  context.scope,
                )
              : failure(
                  context.branchId,
                  context.query,
                  "provider-error",
                  "branch promise failed",
                  now,
                  exit.cause,
                ),
          ),
        );
      }
      return Effect.succeed(
        normalizeObservation(value, context.branchId, context.query, now, context.scope),
      );
    }),
  );
}

function timedBranch(
  adapter: RecallBranchDefinition,
  context: RecallBranchContext,
  clock: RecallClock,
): Effect.Effect<RecallBranchObservation | { readonly timedOut: true }> {
  const controller = new AbortController();
  const branchContext: RecallBranchContext = { ...context, signal: controller.signal };
  const run = effectFromAdapter(adapter.run, branchContext, clock.now()).pipe(
    Effect.onInterrupt(() => Effect.sync(() => controller.abort())),
    Effect.tap(() => Effect.sync(() => controller.abort())),
  );
  const timeout = clock.waitUntil(context.deadline.at).pipe(
    Effect.as({ timedOut: true } as const),
    Effect.tap(() => Effect.sync(() => controller.abort())),
  );
  return Effect.raceFirst(run, timeout);
}

function branchStatus(observation: RecallBranchObservation, timedOut: boolean): RecallBranchStatus {
  if (timedOut) return "timed-out";
  if (!observation.ok && observation.failure.code === "cancelled") return "cancelled";
  return observation.ok ? "succeeded" : "failed";
}

function observationUsage(observation: RecallBranchObservation, elapsedMs: number): RecallBudget {
  if (!observation.ok)
    return {
      ...emptyUsage(),
      maxLatencyMs: Math.max(0, elapsedMs),
    };
  const usage = observation.usage ?? {};
  const count =
    (observation.evidence?.length ?? 0) +
    (observation.insights?.length ?? 0) +
    (observation.procedures?.length ?? 0);
  return {
    maxDepth: 0,
    maxBranches: 0,
    maxQueries: 0,
    maxResults: Math.max(0, usage.maxResults ?? count),
    maxTokens: Math.max(0, observation.tokens ?? usage.maxTokens ?? 0),
    maxLatencyMs: Math.max(0, observation.usage?.maxLatencyMs ?? elapsedMs),
    maxCostUsd: Math.max(0, observation.costUsd ?? usage.maxCostUsd ?? 0),
  };
}

function updateBranchTrace(
  state: RuntimeState,
  branchId: string,
  query: string,
  update: Partial<RecallBranchTrace>,
): void {
  const index = state.branchTraces.findIndex(
    (trace) => trace.branchId === branchId && trace.query === query && trace.status === "cancelled",
  );
  if (index < 0) return;
  state.branchTraces[index] = { ...state.branchTraces[index], ...update };
}

function roundBudgetFrom(ledger: RecallBudgetLedger, depth: number): RecallBudget | undefined {
  const remaining = ledger.remaining();
  if (depth <= 0 || remaining.maxDepth < 1) return undefined;
  return { ...remaining, maxDepth: depth };
}

function runRound(
  adapters: readonly RecallBranchDefinition[],
  query: string,
  depth: number,
  request: RecallRequest,
  state: RuntimeState,
  ledger: RecallBudgetLedger,
  clock: RecallClock,
): Effect.Effect<RoundOutcome> {
  const normalized = normalizeQuery(query);
  if (state.queryLineage.has(normalized)) {
    state.cycleDetected = true;
    state.queryTraces.push({ query, normalized, depth, cycle: true, branchIds: [] });
    return Effect.succeed({ nextQueries: [], timedOut: false, scopeClosed: false, launched: 0 });
  }
  const roundBudget = roundBudgetFrom(ledger, depth);
  if (roundBudget === undefined)
    return Effect.succeed({ nextQueries: [], timedOut: false, scopeClosed: false, launched: 0 });
  state.queryLineage.add(normalized);
  state.maxDepthReached = Math.max(state.maxDepthReached, depth);
  const depthReservation = ledger.consume({ ...emptyUsage(), maxDepth: 1 });
  if (!depthReservation.ok)
    return Effect.succeed({ nextQueries: [], timedOut: false, scopeClosed: false, launched: 0 });
  const maxLaunches = Math.min(
    adapters.length,
    ledger.remaining().maxBranches,
    ledger.remaining().maxQueries,
  );
  const selected = adapters.slice(0, Math.max(0, Math.floor(maxLaunches)));
  const branchIds = selected.map((adapter) => adapter.id);
  state.queryTraces.push({ query, normalized, depth, cycle: false, branchIds });
  if (selected.length === 0)
    return Effect.succeed({ nextQueries: [], timedOut: false, scopeClosed: false, launched: 0 });

  const branchEffects = selected.map((adapter) => {
    const branchReservation = ledger.consume({ ...emptyUsage(), maxBranches: 1, maxQueries: 1 });
    if (!branchReservation.ok) {
      const now = clock.now();
      const observed = failure(
        adapter.id,
        query,
        "budget-exhausted",
        branchReservation.error.message,
        now,
      );
      return Effect.succeed({
        adapter,
        result: observed,
        startedAt: now,
        finishedAt: now,
        budget: undefined,
      } satisfies BranchCompletion);
    }
    const childBudgetResult = defaultChildBudget(roundBudget);
    if (!childBudgetResult.ok) {
      const now = clock.now();
      const observed = failure(
        adapter.id,
        query,
        "budget-exhausted",
        childBudgetResult.error.message,
        now,
      );
      return Effect.succeed({
        adapter,
        result: observed,
        startedAt: now,
        finishedAt: now,
        budget: undefined,
      } satisfies BranchCompletion);
    }
    const inherited = inheritRecallScope(request.scope, request.scope);
    if (!inherited.ok) {
      const now = clock.now();
      const observed = failure(adapter.id, query, "scope-closed", inherited.error.message, now);
      return Effect.succeed({
        adapter,
        result: observed,
        startedAt: now,
        finishedAt: now,
        budget: childBudgetResult.value,
      } satisfies BranchCompletion);
    }
    const startedAt = clock.now();
    const deadline = recallDeadline(clock, childBudgetResult.value.maxLatencyMs);
    state.branchTraces.push({
      branchId: adapter.id,
      query,
      status: "cancelled",
      depth,
      budget: childBudgetResult.value,
      deadlineAt: deadline.at,
      startedAt,
    });
    const context: RecallBranchContext = {
      contextSessionId: request.contextSessionId,
      branchId: adapter.id,
      query,
      normalizedQuery: normalized,
      depth: depth - 1,
      budget: childBudgetResult.value,
      scope: inherited.value,
      queryAncestry: [...state.queryLineage],
      visitedEvidenceIds: new Set(state.visitedEvidenceIds),
      visitedInsightRevisions: new Set(state.visitedInsightRevisions),
      clock,
      deadline,
      signal: new AbortController().signal,
      deriveChildBudget: (child) => deriveChildBudget(childBudgetResult.value, child),
      inheritScope: (child = {}) => inheritRecallScope(inherited.value, child),
    };
    return timedBranch(adapter, context, clock).pipe(
      Effect.map(
        (result): BranchCompletion => ({
          adapter,
          result,
          startedAt,
          finishedAt: clock.now(),
          budget: childBudgetResult.value,
        }),
      ),
    );
  });

  return Effect.all(branchEffects, { concurrency: "unbounded" }).pipe(
    Effect.map((completions) => {
      const results: RecallBranchObservation[] = [];
      for (const completion of completions) {
        const { adapter, result, startedAt, finishedAt, budget } = completion;
        if ("timedOut" in result) {
          state.timedOut = true;
          const elapsed = Math.max(0, finishedAt - startedAt);
          if (budget !== undefined)
            ledger.consume({
              ...emptyUsage(),
              maxLatencyMs: Math.min(elapsed, budget.maxLatencyMs),
            });
          const observed = failure(
            adapter.id,
            query,
            "timeout",
            "branch deadline elapsed",
            finishedAt,
          );
          state.observations.push(observed);
          results.push(observed);
          updateBranchTrace(state, adapter.id, query, {
            status: "timed-out",
            finishedAt,
            failure: observed.failure,
          });
          continue;
        }
        const elapsed = Math.max(0, finishedAt - startedAt);
        const usage = observationUsage(result, elapsed);
        const consumed = ledger.consume(usage);
        if (!consumed.ok) {
          const observed = failure(
            adapter.id,
            query,
            "budget-exhausted",
            consumed.error.message,
            finishedAt,
          );
          state.observations.push(observed);
          results.push(observed);
          updateBranchTrace(state, adapter.id, query, {
            status: "failed",
            finishedAt,
            failure: observed.failure,
          });
          continue;
        }
        state.observations.push(result);
        results.push(result);
        const branchFailure = result.ok ? undefined : result.failure;
        updateBranchTrace(state, adapter.id, query, {
          status: branchStatus(result, false),
          finishedAt,
          ...(branchFailure === undefined ? {} : { failure: branchFailure }),
        });
      }
      const followUps = results
        .flatMap((result) =>
          result.ok && Array.isArray(result.followUpQueries) ? result.followUpQueries : [],
        )
        .filter(
          (candidate): candidate is string =>
            typeof candidate === "string" && candidate.trim().length > 0,
        )
        .toSorted((left, right) => normalizeQuery(left).localeCompare(normalizeQuery(right)));
      const scopeFailure = results.some(
        (result) => !result.ok && result.failure.code === "scope-closed",
      );
      return {
        nextQueries: [...new Set(followUps)],
        timedOut: state.timedOut,
        scopeClosed: scopeFailure,
        launched: selected.length,
      };
    }),
  );
}

function parentCancellation(signal: AbortSignal | undefined): Effect.Effect<"cancelled"> {
  if (signal === undefined) return Effect.never;
  if (signal.aborted) return Effect.succeed("cancelled");
  return Effect.callback((resume, activeSignal) => {
    const onAbort = (): void => resume(Effect.succeed("cancelled"));
    signal.addEventListener("abort", onAbort, { once: true });
    const cleanup = (): void => signal.removeEventListener("abort", onAbort);
    activeSignal.addEventListener("abort", cleanup, { once: true });
    return Effect.sync(cleanup);
  });
}

function resultOptions(
  state: RuntimeState,
  request: RecallRequest,
  ledger: RecallBudgetLedger,
  reason: RecallTerminationReason,
): RecallConsolidationOptions {
  const snapshot = ledger.snapshot();
  return {
    terminationReason: reason,
    totalBudget: snapshot.total,
    consumedBudget: snapshot.consumed,
    remainingBudget: snapshot.remaining,
    scope: request.scope,
    depth: state.maxDepthReached,
    branchTraces: state.branchTraces,
    queryTraces: state.queryTraces,
    parentRequestedCancellation: state.parentRequestedCancellation,
    cancelledBranches: [...state.cancelledBranches],
    queryLineage: [...state.queryLineage],
    visitedEvidenceIds: [...state.visitedEvidenceIds],
    visitedInsightRevisions: [...state.visitedInsightRevisions],
    noveltyVisitedEvidenceIds: [...state.baselineEvidenceIds],
    noveltyVisitedInsightRevisions: [...state.baselineInsightRevisions],
    priorConsolidationHashes: [...state.priorHashes],
    previousUnresolved: request.previousUnresolved,
    omissions: [...state.omissions],
  };
}

function currentResult(
  state: RuntimeState,
  request: RecallRequest,
  ledger: RecallBudgetLedger,
  reason: RecallTerminationReason,
): RecallResult {
  return consolidateRecall(state.observations, resultOptions(state, request, ledger, reason));
}

function shouldSatisfy(result: RecallResult, request: RecallRequest): boolean {
  const minimum = request.minimumEvidence ?? 1;
  return Number.isFinite(minimum) && minimum >= 0 && result.evidence.length >= minimum;
}

function unresolvedContradiction(result: RecallResult): boolean {
  return result.contradictions.some((contradiction) => contradiction.resolved !== true);
}

function commitVisited(state: RuntimeState): void {
  for (const observation of state.observations) {
    if (!observation.ok) continue;
    for (const item of observation.evidence ?? []) state.visitedEvidenceIds.add(item.id);
    for (const item of observation.insights ?? [])
      state.visitedInsightRevisions.add(item.revisionId ?? item.id);
    for (const item of observation.unresolved ?? []) state.unresolved.add(item);
  }
}

function buildRecallEffect(
  request: RecallRequest,
  adapters: readonly RecallBranchDefinition[],
  clock: RecallClock,
  state: RuntimeState,
  ledger: RecallBudgetLedger,
): Effect.Effect<RecallResult> {
  return Effect.gen(function* () {
    if (scopeClosed(request.scope, request.scopeClosed)) {
      state.scopeClosed = true;
      return currentResult(state, request, ledger, "scope-closed");
    }
    if (request.parentSignal?.aborted || request.signal?.aborted) {
      state.parentRequestedCancellation = true;
      return currentResult(state, request, ledger, "cancelled-parent");
    }
    const maxRounds = request.maxRounds ?? Math.max(1, request.budget.maxDepth + 1);
    let query = request.query;
    let depth = request.budget.maxDepth;
    let rounds = 0;
    while (rounds < maxRounds) {
      if (scopeClosed(request.scope, request.scopeClosed)) {
        state.scopeClosed = true;
        break;
      }
      if (depth <= 0 || ledger.remaining().maxDepth <= 0) break;
      state.baselineEvidenceIds.clear();
      for (const id of state.visitedEvidenceIds) state.baselineEvidenceIds.add(id);
      state.baselineInsightRevisions.clear();
      for (const id of state.visitedInsightRevisions) state.baselineInsightRevisions.add(id);
      const round = yield* runRound(adapters, query, depth, request, state, ledger, clock);
      rounds += 1;
      const provisional = consolidateRecall(
        state.observations,
        resultOptions(state, request, ledger, "no-novelty"),
      );
      commitVisited(state);
      if (round.scopeClosed) {
        state.scopeClosed = true;
        break;
      }
      if (round.timedOut) {
        state.timedOut = true;
        break;
      }
      if (
        provisional.trace.stability.stable ||
        request.previousResultHash === provisional.contentHash
      )
        break;
      if (unresolvedContradiction(provisional)) break;
      if (shouldSatisfy(provisional, request) && provisional.trace.novelty.isNovel) break;
      const nextCandidate = round.nextQueries[0];
      if (nextCandidate !== undefined && queryCycle([...state.queryLineage], nextCandidate))
        state.queryTraces.push({
          query: nextCandidate,
          normalized: normalizeQuery(nextCandidate),
          depth: depth - 1,
          cycle: true,
          branchIds: [],
        });
      const next = round.nextQueries.find(
        (candidate) => !state.queryLineage.has(normalizeQuery(candidate)),
      );
      if (next === undefined) break;
      query = next;
      depth -= 1;
    }
    let reason: RecallTerminationReason;
    const provisional = consolidateRecall(
      state.observations,
      resultOptions(state, request, ledger, "no-novelty"),
    );
    if (state.scopeClosed) reason = "scope-closed";
    else if (state.timedOut) reason = "timeout";
    else if (unresolvedContradiction(provisional)) reason = "unresolved-contradiction";
    else if (
      request.previousResultHash === provisional.contentHash ||
      provisional.trace.stability.stable
    )
      reason = "stable-result";
    else if (shouldSatisfy(provisional, request) && provisional.trace.novelty.isNovel)
      reason = "sufficient-evidence";
    else if (
      state.observations.length > 0 &&
      state.observations.every((observation) => !observation.ok) &&
      !provisional.trace.branchFailures.some(
        (branchFailure) => branchFailure.code === "budget-exhausted",
      )
    )
      reason = "no-novelty";
    else if (
      state.cycleDetected ||
      (!provisional.trace.novelty.isNovel && state.observations.length > 0)
    )
      reason = "no-novelty";
    else if (
      ledger.remaining().maxDepth <= 0 ||
      ledger.remaining().maxBranches <= 0 ||
      ledger.remaining().maxQueries <= 0
    )
      reason = "budget-exhausted";
    else reason = "no-novelty";
    return currentResult(state, request, ledger, reason);
  });
}

function adapterVectorError(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return `${label} must be an array`;
  if (value.length > MAX_RECALL_ADAPTERS)
    return `${label} must contain at most ${MAX_RECALL_ADAPTERS} adapters`;
  for (const [index, adapter] of value.entries()) {
    try {
      if (typeof adapter === "function") {
        if (adapter.name.length > MAX_RECALL_TEXT_LENGTH)
          return `${label}[${index}] name is too long`;
        continue;
      }
      if (
        adapter === null ||
        typeof adapter !== "object" ||
        Array.isArray(adapter) ||
        typeof adapter.id !== "string" ||
        adapter.id.trim().length === 0 ||
        adapter.id.length > MAX_RECALL_TEXT_LENGTH ||
        typeof adapter.run !== "function"
      )
        return `${label}[${index}] must provide a bounded id and callable run`;
    } catch (error) {
      return `${label}[${index}] could not be inspected safely: ${
        error instanceof Error ? error.message : String(error)
      }`;
    }
  }
  return undefined;
}

function validatedRequest(request: RecallRequest): RecallError | undefined {
  if (request === null || typeof request !== "object" || Array.isArray(request))
    return new RecallError("invalid-request", "recall request must be an object");
  const invocationIdError = boundedTextError(request.invocationId, "invocationId");
  if (
    request.invocationId !== undefined &&
    (invocationIdError !== undefined ||
      request.invocationId.trim().length === 0 ||
      request.invocationId.length > 256)
  )
    return new RecallError(
      "invalid-request",
      "invocationId must be non-empty text of at most 256 characters",
    );
  if (
    typeof request.contextSessionId !== "string" ||
    !CONTEXT_SESSION_ID.test(request.contextSessionId)
  )
    return new RecallError(
      "invalid-request",
      "contextSessionId must identify one parent context session",
    );
  if (
    typeof request.query !== "string" ||
    request.query.trim().length === 0 ||
    request.query.length > MAX_RECALL_TEXT_LENGTH
  )
    return new RecallError(
      "invalid-request",
      `recall query must be non-empty text of at most ${MAX_RECALL_TEXT_LENGTH} characters`,
    );
  const scopeRecordError = boundedRecordError(request.scope, "recall scope");
  if (scopeRecordError) return new RecallError("invalid-request", scopeRecordError);
  const budget = validateRecallBudget(request.budget);
  if (!budget.ok) return new RecallError("invalid-budget", budget.error.message);
  const scope = validateRecallScope(request.scope);
  if (!scope.ok) return new RecallError("scope-denied", scope.error.message);
  for (const [value, label] of [
    [request.visitedEvidenceIds, "visitedEvidenceIds"],
    [request.visitedInsightRevisions, "visitedInsightRevisions"],
    [request.queryAncestry, "queryAncestry"],
    [request.priorConsolidationHashes, "priorConsolidationHashes"],
    [request.previousUnresolved, "previousUnresolved"],
  ] as const) {
    const vectorError = boundedStringVectorError(value, label);
    if (vectorError) return new RecallError("invalid-request", vectorError);
  }
  const previousResultHashError = boundedTextError(
    request.previousResultHash,
    "previousResultHash",
  );
  if (previousResultHashError) return new RecallError("invalid-request", previousResultHashError);
  const adapterError = adapterVectorError(request.adapters, "adapters");
  if (adapterError) return new RecallError("invalid-request", adapterError);
  if (
    request.minimumEvidence !== undefined &&
    (!Number.isFinite(request.minimumEvidence) || request.minimumEvidence < 0)
  )
    return new RecallError("invalid-request", "minimumEvidence must be finite and non-negative");
  if (
    request.maxRounds !== undefined &&
    (!Number.isInteger(request.maxRounds) ||
      request.maxRounds < 1 ||
      request.maxRounds > MAX_RECALL_ROUNDS)
  )
    return new RecallError(
      "invalid-request",
      `maxRounds must be a positive integer no greater than ${MAX_RECALL_ROUNDS}`,
    );
  return undefined;
}

export function validateRecallRequest(request: RecallRequest): RecallError | undefined {
  try {
    return validatedRequest(request);
  } catch (error) {
    return new RecallError(
      "invalid-request",
      `recall request could not be inspected safely: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

type AdapterNormalization =
  | {
      readonly ok: true;
      readonly value: RecallBranchDefinition;
    }
  | {
      readonly ok: false;
      readonly error: RecallError;
    };

type AdapterConfiguration =
  | {
      readonly ok: true;
      readonly adapters: readonly RecallBranchDefinition[];
    }
  | {
      readonly ok: false;
      readonly adapters: readonly [];
      readonly error: RecallError;
    };

function normalizeAdapter(
  adapter: RecallBranchAdapter | RecallBranchDefinition,
  index: number,
): AdapterNormalization {
  if (typeof adapter === "function")
    return {
      ok: true,
      value: {
        id: adapter.name.trim() || `branch-${index + 1}`,
        run: adapter,
      },
    };
  if (
    adapter !== null &&
    typeof adapter === "object" &&
    typeof adapter.id === "string" &&
    adapter.id.trim().length > 0 &&
    typeof adapter.run === "function"
  )
    return { ok: true, value: { id: adapter.id.trim(), run: adapter.run } };
  return {
    ok: false,
    error: new RecallError("invalid-request", `recall adapter ${index + 1} is invalid`),
  };
}

function configuredAdapters(options: RecallRuntimeOptions): AdapterConfiguration {
  let configured: readonly (RecallBranchAdapter | RecallBranchDefinition)[];
  try {
    configured = options.adapters ?? options.branches ?? [];
  } catch (error) {
    return {
      ok: false,
      adapters: [],
      error: new RecallError(
        "invalid-request",
        `recall runtime adapters could not be inspected safely: ${
          error instanceof Error ? error.message : String(error)
        }`,
      ),
    };
  }
  const adapterError = adapterVectorError(configured, "recall runtime adapters");
  if (adapterError)
    return { ok: false, adapters: [], error: new RecallError("invalid-request", adapterError) };
  const adapters: RecallBranchDefinition[] = [];
  const adapterIds = new Set<string>();
  for (const [index, adapter] of configured.entries()) {
    const normalized = normalizeAdapter(adapter, index);
    if (!normalized.ok) return { ok: false, adapters: [], error: normalized.error };
    if (adapterIds.has(normalized.value.id))
      return {
        ok: false,
        adapters: [],
        error: new RecallError("invalid-request", "recall adapter IDs must be unique"),
      };
    adapterIds.add(normalized.value.id);
    adapters.push(normalized.value);
  }
  return { ok: true, adapters };
}

export function createRecallRuntime(options: RecallRuntimeOptions = {}): RecallRuntime {
  const configured = configuredAdapters(options);
  const clock = options?.clock ?? systemRecallClock;
  return {
    recall(request) {
      const requestError = validateRecallRequest(request);
      if (requestError !== undefined) return Effect.fail(requestError);
      if (!configured.ok) return Effect.fail(configured.error);
      const scopeResult = validateRecallScope(request.scope);
      if (!scopeResult.ok)
        return Effect.fail(new RecallError("scope-denied", scopeResult.error.message));
      const normalizedRequest = {
        ...request,
        scope: scopeResult.value,
        invocationId: request.invocationId ?? randomUUID(),
      };
      let requestAdapters: readonly RecallBranchDefinition[];
      if (normalizedRequest.adapters === undefined) {
        requestAdapters = configured.adapters;
      } else {
        const normalizedAdapters: RecallBranchDefinition[] = [];
        const adapterIds = new Set<string>();
        for (const [index, adapter] of normalizedRequest.adapters.entries()) {
          const normalized = normalizeAdapter(adapter, index);
          if (!normalized.ok) return Effect.fail(normalized.error);
          if (adapterIds.has(normalized.value.id))
            return Effect.fail(
              new RecallError("invalid-request", "recall adapter IDs must be unique"),
            );
          adapterIds.add(normalized.value.id);
          normalizedAdapters.push(normalized.value);
        }
        requestAdapters = normalizedAdapters;
      }
      const ledger = new RecallBudgetLedger(normalizedRequest.budget);
      const state: RuntimeState = {
        observations: [],
        branchTraces: [],
        queryTraces: [],
        queryLineage: new Set((normalizedRequest.queryAncestry ?? []).map(normalizeQuery)),
        visitedEvidenceIds: new Set(normalizedRequest.visitedEvidenceIds ?? []),
        visitedInsightRevisions: new Set(normalizedRequest.visitedInsightRevisions ?? []),
        baselineEvidenceIds: new Set(normalizedRequest.visitedEvidenceIds ?? []),
        baselineInsightRevisions: new Set(normalizedRequest.visitedInsightRevisions ?? []),
        priorHashes: new Set(normalizedRequest.priorConsolidationHashes ?? []),
        unresolved: new Set(normalizedRequest.previousUnresolved ?? []),
        cancelledBranches: new Set(),
        omissions: new Set(),
        parentRequestedCancellation: false,
        timedOut: false,
        scopeClosed: false,
        cycleDetected: false,
        maxDepthReached: 0,
      };
      const program = buildRecallEffect(normalizedRequest, requestAdapters, clock, state, ledger);
      const cancellation = parentCancellation(
        normalizedRequest.parentSignal ?? normalizedRequest.signal,
      ).pipe(Effect.map(() => "cancelled" as const));
      return Effect.raceFirst(program, cancellation).pipe(
        Effect.map((value) => {
          if (value === "cancelled") {
            state.parentRequestedCancellation = true;
            for (const trace of state.branchTraces) {
              if (trace.status === "cancelled") state.cancelledBranches.add(trace.branchId);
            }
            return currentResult(state, normalizedRequest, ledger, "cancelled-parent");
          }
          return value;
        }),
      );
    },
  };
}

export const makeRecallRuntime = createRecallRuntime;

export function recall(
  request: RecallRequest,
  options: RecallRuntimeOptions = {},
): Effect.Effect<RecallResult, RecallError> {
  return createRecallRuntime(options).recall(request);
}

/** Promise adapter preserving the typed RecallError rejection channel. */
export function recallPromise(
  request: RecallRequest,
  options: RecallRuntimeOptions = {},
): Promise<RecallResult> {
  return Effect.runPromise(recall(request, options));
}
