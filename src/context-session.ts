import { Database } from "bun:sqlite";
import { Effect } from "effect";
import { randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  opendir,
  readFile,
  readdir,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  CONTEXT_SCHEMA_VERSION,
  MAX_CONTEXT_BUDGET,
  MAX_CONTEXT_RECALL_INVOCATIONS,
  MAX_CONTEXT_SESSIONS,
  MAX_STAGED_RECALL_EVENT_BATCHES,
  type ContextBudget,
  type ContextBundle,
  type ContextSession,
  type ContextSessionInput,
  type RecallInvocationRecord,
} from "./context-types";
export {
  MAX_CONTEXT_BUDGET,
  MAX_CONTEXT_RECALL_INVOCATIONS,
  MAX_CONTEXT_SESSIONS,
  MAX_STAGED_RECALL_EVENT_BATCHES,
} from "./context-types";
import { publishContextEventBatches } from "./context-event-outbox";
import { readEventBatch } from "./event-store";
import { sha256, stableStringify, type EventBatch } from "./events";
import { recallStabilityHash, type RecallResult } from "./recall-consolidation";
import { recallPathWithin, type RecallScope } from "./recall-budget";
import { validateBoundedRecord } from "./recall-runtime";
import { withIngestLock } from "./lock";

const HASH = /^[a-f0-9]{64}$/u;
export const MAX_CONTEXT_BUNDLE_HASHES = 256;
const CONTEXT_SESSION_KEYS = [
  "schemaVersion",
  "contextSessionId",
  "nativeSessionId",
  "sessionNonce",
  "target",
  "projectIdentity",
  "cwd",
  "domainPolicy",
  "path",
  "pinnedInsightProjectionHash",
  "pinnedEvidenceProjectionHash",
  "selectionPolicyVersion",
  "deliveryPolicyVersion",
  "budget",
  "consumedBundleHashes",
  "committedDeliveryBatchHashes",
  "attemptedBundleHashes",
  "consumedRecallHashes",
  "consumedRecallInvocations",
  "pendingEventBatchHashes",
  "createdAt",
  "updatedAt",
] as const;
const LEGACY_REQUIRED_CONTEXT_SESSION_KEYS = CONTEXT_SESSION_KEYS.filter(
  (key) =>
    key !== "sessionNonce" &&
    key !== "committedDeliveryBatchHashes" &&
    key !== "attemptedBundleHashes" &&
    key !== "consumedRecallHashes" &&
    key !== "consumedRecallInvocations" &&
    key !== "pendingEventBatchHashes",
);
const CONTEXT_TARGET_KEYS = ["provider", "harness", "model", "role"] as const;
const CONTEXT_BUDGET_KEYS = ["tokens", "results", "latencyMs", "costUsd"] as const;
const RECALL_BUDGET_KEYS = [
  "maxDepth",
  "maxBranches",
  "maxQueries",
  "maxResults",
  "maxTokens",
  "maxLatencyMs",
  "maxCostUsd",
] as const;
const RECALL_BUDGET_INTEGER_KEYS: Record<string, true> = {
  maxDepth: true,
  maxBranches: true,
  maxQueries: true,
  maxResults: true,
  maxTokens: true,
};
const RECALL_EVENT_KINDS: Record<string, true> = {
  "context.recall.branch.started": true,
  "context.recall.branch.completed": true,
  "context.recall.branch.failed": true,
  "context.recall.branch.cancelled": true,
  "context.recall.terminated": true,
  "context.recall.returned": true,
};
const RECALL_BRANCH_STATUSES: Record<string, true> = {
  succeeded: true,
  failed: true,
  "timed-out": true,
  cancelled: true,
};
const RECALL_TERMINATION_REASONS: Record<string, true> = {
  "sufficient-evidence": true,
  "stable-result": true,
  "no-novelty": true,
  "budget-exhausted": true,
  timeout: true,
  "unresolved-contradiction": true,
  "cancelled-parent": true,
  "scope-closed": true,
};

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return (
    actual.length === keys.length &&
    keys.every((key) => Object.prototype.hasOwnProperty.call(value, key))
  );
}

function hasMigratableSessionKeys(value: Record<string, unknown>): boolean {
  const known = new Set<string>(CONTEXT_SESSION_KEYS);
  return (
    Object.keys(value).every((key) => known.has(key)) &&
    LEGACY_REQUIRED_CONTEXT_SESSION_KEYS.every((key) =>
      Object.prototype.hasOwnProperty.call(value, key),
    )
  );
}
function isLegacyAnonymousSession(value: Record<string, unknown>): boolean {
  return (
    value.nativeSessionId === null &&
    !Object.prototype.hasOwnProperty.call(value, "sessionNonce") &&
    !hasExactKeys(value, CONTEXT_SESSION_KEYS) &&
    hasMigratableSessionKeys(value)
  );
}

function legacyAnonymousSessionNonce(contextSessionId: string): string {
  return sha256(
    stableStringify({
      recipe: "chatlog-context-session-legacy-anonymous-migration-v1",
      contextSessionId,
    }),
  );
}

export type ContextSessionStoreResult<T> =
  | { ok: true; value: T }
  | {
      ok: false;
      error: {
        code: "invalid-session" | "session-conflict" | "storage-error";
        message: string;
      };
    };

function invalid(message: string): ContextSessionStoreResult<never> {
  return { ok: false, error: { code: "invalid-session", message } };
}

function storageError(error: unknown): ContextSessionStoreResult<never> {
  return {
    ok: false,
    error: {
      code: "storage-error",
      message: error instanceof Error ? error.message : String(error),
    },
  };
}

function validTimestamp(value: string): boolean {
  return Number.isFinite(Date.parse(value));
}

function normalizeBudget(value: unknown, label: string): ContextSessionStoreResult<ContextBudget> {
  if (!record(value) || !hasExactKeys(value, CONTEXT_BUDGET_KEYS))
    return invalid(`${label} must contain exactly tokens, results, latencyMs, and costUsd`);
  for (const key of CONTEXT_BUDGET_KEYS) {
    const amount = value[key];
    if (typeof amount !== "number" || !Number.isFinite(amount) || amount < 0)
      return invalid(`${label}.${key} must be a non-negative finite number`);
    if (key !== "costUsd" && !Number.isSafeInteger(amount))
      return invalid(`${label}.${key} must be a non-negative integer`);
    if (amount > MAX_CONTEXT_BUDGET[key])
      return invalid(`${label}.${key} exceeds the maximum of ${MAX_CONTEXT_BUDGET[key]}`);
  }
  return {
    ok: true,
    value: {
      tokens: value.tokens as number,
      results: value.results as number,
      latencyMs: value.latencyMs as number,
      costUsd: value.costUsd as number,
    },
  };
}

export function contextSessionIdentity(
  input: Omit<ContextSessionInput, "totalBudget" | "createdAt">,
): string {
  return sha256(
    stableStringify({
      recipe: "chatlog-context-session-v1",
      nativeSessionId: input.nativeSessionId,
      ...(input.nativeSessionId === null ? { sessionNonce: input.sessionNonce } : {}),
      provider: input.provider,
      harness: input.harness,
      model: input.model,
      role: input.role,
      projectIdentity: input.projectIdentity,
      cwd: input.cwd,
      domainPolicy: [
        ...new Set(input.domainPolicy.map((domain) => domain.trim().toLowerCase())),
      ].toSorted(),
      path: input.path,
      binding: "pins-and-budgets-are-session-state",
    }),
  );
}

export function createContextSession(
  input: ContextSessionInput,
): ContextSessionStoreResult<ContextSession> {
  for (const [label, value] of [
    ["provider", input.provider],
    ["harness", input.harness],
    ["role", input.role],
    ["projectIdentity", input.projectIdentity],
    ["cwd", input.cwd],
    ["selectionPolicyVersion", input.selectionPolicyVersion],
    ["deliveryPolicyVersion", input.deliveryPolicyVersion],
  ] as const)
    if (!value.trim()) return invalid(`${label} must be non-empty`);
  if (input.model !== null && !input.model.trim()) return invalid("model must be non-empty");
  if (input.nativeSessionId !== null && !input.nativeSessionId.trim())
    return invalid("nativeSessionId must be non-empty");
  if (input.sessionNonce !== undefined && input.sessionNonce !== null && !input.sessionNonce.trim())
    return invalid("sessionNonce must be non-empty");
  if (input.nativeSessionId !== null && input.sessionNonce != null)
    return invalid("sessionNonce is only valid without a nativeSessionId");
  if (input.path !== null && !input.path.trim()) return invalid("path must be non-empty");
  if (!input.domainPolicy.length || input.domainPolicy.some((domain) => !domain.trim()))
    return invalid("domainPolicy must contain at least one explicit domain");
  if (!HASH.test(input.pinnedInsightProjectionHash))
    return invalid("pinnedInsightProjectionHash must be a lowercase SHA-256 hash");
  if (!HASH.test(input.pinnedEvidenceProjectionHash))
    return invalid("pinnedEvidenceProjectionHash must be a lowercase SHA-256 hash");
  if (!validTimestamp(input.createdAt)) return invalid("createdAt must be an ISO timestamp");
  const total = normalizeBudget(input.totalBudget, "totalBudget");
  if (!total.ok) return total;
  const domains = [
    ...new Set(input.domainPolicy.map((domain) => domain.trim().toLowerCase())),
  ].toSorted();
  const sessionNonce = input.nativeSessionId === null ? (input.sessionNonce ?? randomUUID()) : null;
  const contextSessionId = contextSessionIdentity({
    ...input,
    domainPolicy: domains,
    sessionNonce,
  });
  return {
    ok: true,
    value: {
      schemaVersion: CONTEXT_SCHEMA_VERSION,
      contextSessionId,
      nativeSessionId: input.nativeSessionId,
      sessionNonce,
      target: {
        provider: input.provider,
        harness: input.harness,
        model: input.model,
        role: input.role,
      },
      projectIdentity: input.projectIdentity,
      cwd: input.cwd,
      domainPolicy: domains,
      path: input.path,
      pinnedInsightProjectionHash: input.pinnedInsightProjectionHash,
      pinnedEvidenceProjectionHash: input.pinnedEvidenceProjectionHash,
      selectionPolicyVersion: input.selectionPolicyVersion,
      deliveryPolicyVersion: input.deliveryPolicyVersion,
      budget: { total: { ...total.value }, remaining: { ...total.value } },
      consumedBundleHashes: [],
      committedDeliveryBatchHashes: [],
      attemptedBundleHashes: [],
      consumedRecallHashes: [],
      consumedRecallInvocations: [],
      pendingEventBatchHashes: [],
      createdAt: input.createdAt,
      updatedAt: input.createdAt,
    },
  };
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function strictHashArray(value: unknown, label: string): ContextSessionStoreResult<string[]> {
  if (!Array.isArray(value)) return invalid(`${label} must be an array`);
  const hashes: string[] = [];
  for (const [index, item] of value.entries()) {
    if (typeof item !== "string" || !HASH.test(item))
      return invalid(`${label}[${index}] must be a lowercase SHA-256`);
    hashes.push(item);
  }
  if (new Set(hashes).size !== hashes.length)
    return invalid(`${label} must not contain duplicates`);
  return { ok: true, value: hashes };
}
function strictRecallInvocationArray(
  value: unknown,
  label: string,
): ContextSessionStoreResult<RecallInvocationRecord[]> {
  if (!Array.isArray(value)) return invalid(`${label} must be an array`);
  const records: RecallInvocationRecord[] = [];
  const ids = new Set<string>();
  const hashes = new Set<string>();
  for (const [index, item] of value.entries()) {
    if (
      !record(item) ||
      (!hasExactKeys(item, ["invocationId", "invocationHash", "contentHash", "traceHash"]) &&
        !hasExactKeys(item, [
          "invocationId",
          "invocationHash",
          "contentHash",
          "traceHash",
          "lifecycleTimestampFloor",
        ]))
    )
      return invalid(`${label}[${index}] has an invalid recall invocation record shape`);
    if (
      typeof item.invocationId !== "string" ||
      item.invocationId.trim().length === 0 ||
      item.invocationId.length > 256
    )
      return invalid(
        `${label}[${index}].invocationId must be non-empty text of at most 256 characters`,
      );
    if (typeof item.invocationHash !== "string" || !HASH.test(item.invocationHash))
      return invalid(`${label}[${index}].invocationHash must be a lowercase SHA-256`);
    if (typeof item.contentHash !== "string" || !HASH.test(item.contentHash))
      return invalid(`${label}[${index}].contentHash must be a lowercase SHA-256`);
    if (typeof item.traceHash !== "string" || !HASH.test(item.traceHash))
      return invalid(`${label}[${index}].traceHash must be a lowercase SHA-256`);
    if (
      item.lifecycleTimestampFloor !== undefined &&
      (typeof item.lifecycleTimestampFloor !== "string" ||
        !validTimestamp(item.lifecycleTimestampFloor))
    )
      return invalid(`${label}[${index}].lifecycleTimestampFloor must be an ISO timestamp`);
    if (ids.has(item.invocationId) || hashes.has(item.invocationHash))
      return invalid(`${label} must not contain duplicate invocation identities`);
    ids.add(item.invocationId);
    hashes.add(item.invocationHash);
    records.push({
      invocationId: item.invocationId,
      invocationHash: item.invocationHash,
      contentHash: item.contentHash,
      traceHash: item.traceHash,
      ...(item.lifecycleTimestampFloor === undefined
        ? {}
        : { lifecycleTimestampFloor: item.lifecycleTimestampFloor }),
    });
  }
  return { ok: true, value: records };
}

function requiredHashArray(value: unknown, label: string): ContextSessionStoreResult<string[]> {
  const hashes = strictHashArray(value, label);
  if (!hashes.ok) return hashes;
  return hashes.value.length === 0
    ? invalid(`${label} must contain at least one staged event batch`)
    : hashes;
}

async function stagedEventBatches(
  root: string,
  hashes: readonly string[],
): Promise<ContextSessionStoreResult<Array<{ hash: string; events: EventBatch["events"] }>>> {
  try {
    const batches = await Effect.runPromise(
      Effect.all(
        hashes.map((hash) =>
          Effect.promise(async () => ({ hash, events: (await readEventBatch(root, hash)).events })),
        ),
        { concurrency: 8 },
      ),
    );
    return { ok: true, value: batches };
  } catch (error) {
    return storageError(error);
  }
}

function eventPayload(event: EventBatch["events"][number]): Record<string, unknown> {
  return event.payload;
}
function recallBudgetRecord(
  value: unknown,
  label: string,
): ContextSessionStoreResult<Record<string, number>> {
  if (!record(value) || !hasExactKeys(value, RECALL_BUDGET_KEYS))
    return invalid(
      `${label} must contain exactly maxDepth, maxBranches, maxQueries, maxResults, maxTokens, maxLatencyMs, and maxCostUsd`,
    );
  const budget: Record<string, number> = {};
  for (const key of RECALL_BUDGET_KEYS) {
    const amount = value[key];
    if (typeof amount !== "number" || !Number.isFinite(amount) || amount < 0)
      return invalid(`${label}.${key} must be a non-negative finite number`);
    if (RECALL_BUDGET_INTEGER_KEYS[key] && !Number.isSafeInteger(amount))
      return invalid(`${label}.${key} must be a non-negative integer`);
    budget[key] = amount;
  }
  return { ok: true, value: budget };
}

function recallBudgetsEqual(left: Record<string, number>, right: Record<string, number>): boolean {
  return RECALL_BUDGET_KEYS.every((key) => left[key] === right[key]);
}

function recallBudgetArithmeticIsConsistent(budget: {
  total: Record<string, number>;
  consumed: Record<string, number>;
  remaining: Record<string, number>;
}): boolean {
  return RECALL_BUDGET_KEYS.every((key) => {
    const sum = budget.consumed[key]! + budget.remaining[key]!;
    const difference = Math.abs(sum - budget.total[key]!);
    const tolerance = Number.EPSILON * Math.max(1, Math.abs(sum), Math.abs(budget.total[key]!)) * 4;
    return (
      Number.isFinite(sum) &&
      Number.isFinite(difference) &&
      Number.isFinite(tolerance) &&
      difference <= tolerance
    );
  });
}

function branchEndKind(status: string): string | undefined {
  if (status === "succeeded") return "context.recall.branch.completed";
  if (status === "failed") return "context.recall.branch.failed";
  if (status === "timed-out") return "context.recall.branch.failed";
  if (status === "cancelled") return "context.recall.branch.cancelled";
  return undefined;
}

function recallHashList(value: unknown, label: string): ContextSessionStoreResult<string[]> {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !HASH.test(item)))
    return invalid(`${label} must contain lowercase SHA-256 hashes`);
  const hashes = value as string[];
  return new Set(hashes).size === hashes.length
    ? { ok: true, value: hashes }
    : invalid(`${label} must not contain duplicates`);
}

async function validateStagedBundleEvent(
  root: string,
  hashes: readonly string[],
  bundle: ContextBundle,
): Promise<ContextSessionStoreResult<true>> {
  if (hashes.length !== 1)
    return invalid("bundle budget commit requires exactly one staged delivery success event");
  const loaded = await stagedEventBatches(root, hashes);
  if (!loaded.ok) return loaded;
  const staged = loaded.value[0];
  if (!staged || staged.events.length !== 1)
    return invalid("bundle budget commit requires one event in the staged batch");
  const event = staged.events[0]!;
  const payload = eventPayload(event);
  const providerAcknowledged = payload.receiptEvidence === "provider-acknowledgment";
  const expectedKind = providerAcknowledged
    ? "context.bundle.acknowledged"
    : bundle.deliveryMode === "tool-recall"
      ? "context.recall.returned"
      : "context.bundle.emitted";
  if (
    event.kind !== expectedKind ||
    payload.contextSessionId !== bundle.contextSessionId ||
    payload.bundleHash !== bundle.bundleHash ||
    payload.idempotencyKey !== `${bundle.bundleHash}:${expectedKind}` ||
    payload.inputHash !== bundle.inputHash ||
    payload.policyHash !== bundle.policyHash ||
    stableStringify(payload.bounds) !== stableStringify(bundle.budget)
  )
    return invalid("staged delivery success does not match the exact context bundle");
  if (
    providerAcknowledged
      ? event.actor.kind.toLowerCase() !== "provider" ||
        payload.actorAuthority !== "provider" ||
        payload.providerReported !== true
      : event.actor.kind.toLowerCase() !== "system" ||
        payload.actorAuthority !== "system" ||
        payload.providerReported === true
  )
    return invalid("staged delivery success has invalid receipt authority");
  if (
    typeof payload.itemId !== "string" ||
    !bundle.items.some((item) => item.id === payload.itemId)
  )
    return invalid("staged delivery success does not identify an item from the exact bundle");
  if (!Array.isArray(payload.inputEventIds) || payload.inputEventIds.length !== 1)
    return invalid("staged delivery success is missing its rendered-event lineage");
  if (!Array.isArray(payload.inputHashes) || payload.inputHashes.length !== 1)
    return invalid("staged delivery success is missing its rendered-batch lineage");
  const renderedBatchHash = payload.inputHashes[0];
  const renderedEventId = payload.inputEventIds[0];
  if (typeof renderedBatchHash !== "string" || typeof renderedEventId !== "string")
    return invalid("staged delivery success lineage is malformed");
  let renderedBatch: EventBatch;
  try {
    renderedBatch = await readEventBatch(root, renderedBatchHash);
  } catch (error) {
    return storageError(error);
  }
  const rendered = renderedBatch.events.find((candidate) => candidate.eventId === renderedEventId);
  if (!rendered || rendered.kind !== "context.bundle.rendered")
    return invalid("staged delivery success references a missing rendered context event");
  const renderedPayload = eventPayload(rendered);
  if (
    renderedPayload.contextSessionId !== bundle.contextSessionId ||
    renderedPayload.bundleHash !== bundle.bundleHash ||
    renderedPayload.idempotencyKey !== `${bundle.bundleHash}:context.bundle.rendered` ||
    renderedPayload.inputHash !== bundle.inputHash ||
    renderedPayload.policyHash !== bundle.policyHash ||
    stableStringify(renderedPayload.bounds) !== stableStringify(bundle.budget)
  )
    return invalid("staged delivery success rendered-event lineage does not match the bundle");
  return { ok: true, value: true };
}
interface StagedRecallBranch {
  readonly branchId: string;
  readonly query: string;
  readonly depth: number;
  readonly status: string;
  readonly budget: Record<string, number>;
  readonly deadlineAt: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly startedPayload: Readonly<Record<string, unknown>>;
  readonly finishedPayload: Readonly<Record<string, unknown>>;
  readonly failure?: { readonly code: string; readonly message: string };
}

interface ValidatedStagedRecallEvents {
  readonly contentHash: string;
  readonly traceHash: string;
  readonly scope: RecallScope;
  readonly scopeHash: string;
  readonly branches: readonly StagedRecallBranch[];
  readonly terminalBounds: {
    readonly total: Record<string, number>;
    readonly consumed: Record<string, number>;
    readonly remaining: Record<string, number>;
  };
  readonly terminationReason: string;
  readonly cancellation: Record<string, unknown>;
  readonly novelty: Record<string, unknown>;
  readonly terminalInputHashes: readonly string[];
  readonly terminalOccurredAt: string;
  readonly terminatedPayload: Readonly<Record<string, unknown>>;
  readonly returnedPayload: Readonly<Record<string, unknown>>;
}

async function validateStagedRecallEvents(
  root: string,
  hashes: readonly string[],
  session: Pick<
    ContextSession,
    "contextSessionId" | "projectIdentity" | "cwd" | "target" | "domainPolicy" | "path"
  >,
  invocationId: string,
  invocationHash: string,
  consumed: ContextBudget,
): Promise<ContextSessionStoreResult<ValidatedStagedRecallEvents>> {
  if (hashes.length > MAX_STAGED_RECALL_EVENT_BATCHES)
    return invalid(
      `recall budget commit accepts at most ${MAX_STAGED_RECALL_EVENT_BATCHES} staged event batches`,
    );
  const loaded = await stagedEventBatches(root, hashes);
  if (!loaded.ok) return loaded;
  const idempotencyKeys = new Set<string>();
  const branchStarts = new Set<string>();
  const branchEnds = new Set<string>();
  const branchBounds = new Map<string, string>();
  const branchStartRecords = new Map<
    string,
    Omit<StagedRecallBranch, "status" | "failure" | "finishedAt" | "finishedPayload">
  >();
  const branchEndRecords = new Map<
    string,
    Pick<StagedRecallBranch, "status" | "failure" | "finishedAt" | "finishedPayload">
  >();
  let returnedCount = 0;
  let terminatedCount = 0;
  let contentHash: string | undefined;
  let traceHash: string | undefined;
  let scope: RecallScope | undefined;
  let scopeHash: string | undefined;
  let terminationReason: string | undefined;
  let terminalBounds:
    | {
        total: Record<string, number>;
        consumed: Record<string, number>;
        remaining: Record<string, number>;
      }
    | undefined;
  let terminalInputHashes: string[] | undefined;
  let cancellation: Record<string, unknown> | undefined;
  let novelty: Record<string, unknown> | undefined;
  let terminalOccurredAt: string | undefined;
  let terminatedPayload: Readonly<Record<string, unknown>> | undefined;
  let returnedPayload: Readonly<Record<string, unknown>> | undefined;

  for (const staged of loaded.value) {
    if (staged.events.length !== 1)
      return invalid("recall budget commit requires one event in each staged batch");
    const event = staged.events[0]!;
    const payload = eventPayload(event);
    const occurredAt = event.occurredAt;
    if (typeof occurredAt !== "string" || !Number.isFinite(Date.parse(occurredAt)))
      return invalid("staged recall lifecycle event has an invalid timestamp");
    if (!RECALL_EVENT_KINDS[event.kind])
      return invalid("recall budget commit accepts only staged recall lifecycle events");
    if (
      payload.contextSessionId !== session.contextSessionId ||
      payload.invocationId !== invocationId ||
      payload.invocationHash !== invocationHash
    )
      return invalid("staged recall lifecycle event does not match the exact recall invocation");
    if (
      !record(payload.scope) ||
      typeof payload.scopeHash !== "string" ||
      !HASH.test(payload.scopeHash) ||
      sha256(stableStringify(payload.scope)) !== payload.scopeHash ||
      !recallScopeMatchesSession(payload.scope as RecallScope, session)
    )
      return invalid("staged recall lifecycle event has an invalid request scope binding");
    if (scopeHash !== undefined && scopeHash !== payload.scopeHash)
      return invalid("staged recall lifecycle events disagree on scopeHash");
    if (scope !== undefined && stableStringify(scope) !== stableStringify(payload.scope))
      return invalid("staged recall lifecycle events disagree on request scope");
    scope = payload.scope as RecallScope;
    scopeHash = payload.scopeHash;
    const branchScoped = event.kind.startsWith("context.recall.branch.");
    if (
      event.scope.sessionId !== session.contextSessionId ||
      event.scope.project !== session.projectIdentity ||
      event.scope.cwd !== session.cwd ||
      Object.keys(event.scope).some(
        (key) =>
          key !== "sessionId" &&
          key !== "project" &&
          key !== "cwd" &&
          (!branchScoped || key !== "branchId"),
      ) ||
      (branchScoped
        ? event.scope.branchId !== payload.branchId
        : Object.prototype.hasOwnProperty.call(event.scope, "branchId"))
    )
      return invalid("staged recall lifecycle event is outside the exact context session scope");
    if (event.actor.kind.toLowerCase() !== "system" || payload.actorAuthority !== "system")
      return invalid("staged recall lifecycle event must have system authority");

    const eventContentHash = payload.contentHash;
    const eventTraceHash = payload.traceHash;
    if (
      typeof eventContentHash !== "string" ||
      !HASH.test(eventContentHash) ||
      typeof eventTraceHash !== "string" ||
      !HASH.test(eventTraceHash)
    )
      return invalid(
        "staged recall lifecycle event is missing consistent content and trace hashes",
      );
    if (contentHash !== undefined && contentHash !== eventContentHash)
      return invalid("staged recall lifecycle events disagree on contentHash");
    if (traceHash !== undefined && traceHash !== eventTraceHash)
      return invalid("staged recall lifecycle events disagree on traceHash");
    contentHash = eventContentHash;
    traceHash = eventTraceHash;

    const idempotencyKey = payload.idempotencyKey;
    if (typeof idempotencyKey !== "string" || idempotencyKeys.has(idempotencyKey))
      return invalid("staged recall lifecycle event idempotency keys must be unique");
    idempotencyKeys.add(idempotencyKey);

    if (event.kind === "context.recall.branch.started") {
      if (typeof event.scope.branchId !== "string" || event.scope.branchId.length === 0)
        return invalid("staged recall branch start is missing its branch scope");
      const branchId = payload.branchId;
      const query = payload.query;
      const depth = payload.depth;
      if (
        typeof branchId !== "string" ||
        branchId.length === 0 ||
        event.scope.branchId !== branchId ||
        typeof query !== "string" ||
        typeof depth !== "number" ||
        !Number.isSafeInteger(depth) ||
        depth < 0 ||
        typeof payload.deadlineAt !== "string" ||
        !Number.isFinite(Date.parse(payload.deadlineAt))
      )
        return invalid("staged recall branch start lineage is malformed");
      const identity = sha256(stableStringify({ branchId, query, depth }));
      if (branchStarts.has(identity))
        return invalid("staged recall branch start records must be unique");
      const bounds = recallBudgetRecord(payload.bounds, "staged recall branch bounds");
      if (!bounds.ok) return bounds;
      const boundsHash = stableStringify(bounds.value);
      const priorBounds = branchBounds.get(identity);
      if (priorBounds !== undefined && priorBounds !== boundsHash)
        return invalid("staged recall branch start/end budgets disagree");
      branchBounds.set(identity, boundsHash);
      branchStarts.add(identity);
      branchStartRecords.set(identity, {
        branchId,
        query,
        depth,
        budget: bounds.value,
        deadlineAt: payload.deadlineAt,
        startedAt: occurredAt,
        startedPayload: payload,
      });
      const expectedKey = `recall:${invocationHash}:started:${identity}`;
      if (idempotencyKey !== expectedKey)
        return invalid("staged recall branch start has an invalid lifecycle idempotency key");
      continue;
    }

    if (
      event.kind === "context.recall.branch.completed" ||
      event.kind === "context.recall.branch.failed" ||
      event.kind === "context.recall.branch.cancelled"
    ) {
      if (typeof event.scope.branchId !== "string" || event.scope.branchId.length === 0)
        return invalid("staged recall branch end is missing its branch scope");
      const branchId = payload.branchId;
      const query = payload.query;
      const depth = payload.depth;
      const status = payload.status;
      if (
        typeof branchId !== "string" ||
        branchId.length === 0 ||
        event.scope.branchId !== branchId ||
        typeof query !== "string" ||
        typeof depth !== "number" ||
        !Number.isSafeInteger(depth) ||
        depth < 0 ||
        typeof status !== "string" ||
        !RECALL_BRANCH_STATUSES[status] ||
        branchEndKind(status) !== event.kind
      )
        return invalid("staged recall branch end lineage is malformed");
      if (
        payload.failure !== undefined &&
        (!record(payload.failure) ||
          typeof payload.failure.code !== "string" ||
          typeof payload.failure.message !== "string")
      )
        return invalid("staged recall branch failure lineage is malformed");
      const identity = sha256(stableStringify({ branchId, query, depth }));
      if (branchEnds.has(identity))
        return invalid("staged recall branch end records must be unique");
      const bounds = recallBudgetRecord(payload.bounds, "staged recall branch bounds");
      if (!bounds.ok) return bounds;
      const boundsHash = stableStringify(bounds.value);
      const priorBounds = branchBounds.get(identity);
      if (priorBounds !== undefined && priorBounds !== boundsHash)
        return invalid("staged recall branch start/end budgets disagree");
      branchBounds.set(identity, boundsHash);
      branchEnds.add(identity);
      branchEndRecords.set(identity, {
        status,
        ...(payload.failure === undefined
          ? {}
          : {
              failure: {
                code: payload.failure.code as string,
                message: payload.failure.message as string,
              },
            }),
        finishedAt: occurredAt,
        finishedPayload: payload,
      });
      const expectedKey = `recall:${invocationHash}:${status}:${identity}`;
      if (idempotencyKey !== expectedKey)
        return invalid("staged recall branch end has an invalid lifecycle idempotency key");
      continue;
    }

    if (event.scope.branchId !== undefined)
      return invalid("staged recall terminal events must not carry a branch scope");
    if (event.kind !== "context.recall.terminated" && event.kind !== "context.recall.returned")
      return invalid("staged recall lifecycle event kind is unsupported");
    const expectedKey = `recall:${invocationHash}:${event.kind.endsWith("terminated") ? "terminated" : "returned"}`;
    if (idempotencyKey !== expectedKey)
      return invalid("staged recall terminal event has an invalid lifecycle idempotency key");
    const terminalBudget = payload.bounds;
    if (
      !record(terminalBudget) ||
      !hasExactKeys(terminalBudget, ["total", "consumed", "remaining"])
    )
      return invalid("staged recall terminal event is missing its exact budget bounds");
    const total = recallBudgetRecord(terminalBudget.total, "staged recall terminal total");
    const consumedBudget = recallBudgetRecord(
      terminalBudget.consumed,
      "staged recall terminal consumed",
    );
    const remaining = recallBudgetRecord(
      terminalBudget.remaining,
      "staged recall terminal remaining",
    );
    if (!total.ok) return total;
    if (!consumedBudget.ok) return consumedBudget;
    if (!remaining.ok) return remaining;
    const candidateBounds = {
      total: total.value,
      consumed: consumedBudget.value,
      remaining: remaining.value,
    };
    if (!recallBudgetArithmeticIsConsistent(candidateBounds))
      return invalid("staged recall terminal budget bounds are arithmetically inconsistent");
    if (terminalBounds !== undefined && !recallBudgetsEqual(terminalBounds.total, total.value))
      return invalid("staged recall terminal total budget bounds disagree");
    if (
      terminalBounds !== undefined &&
      !recallBudgetsEqual(terminalBounds.consumed, consumedBudget.value)
    )
      return invalid("staged recall terminal consumed budget bounds disagree");
    if (
      terminalBounds !== undefined &&
      !recallBudgetsEqual(terminalBounds.remaining, remaining.value)
    )
      return invalid("staged recall terminal remaining budget bounds disagree");
    terminalBounds = candidateBounds;
    const expectedConsumed: Record<string, number> = {
      maxDepth: consumedBudget.value.maxDepth!,
      maxBranches: consumedBudget.value.maxBranches!,
      maxQueries: consumedBudget.value.maxQueries!,
      maxResults: consumed.results,
      maxTokens: consumed.tokens,
      maxLatencyMs: consumed.latencyMs,
      maxCostUsd: consumed.costUsd,
    };
    if (RECALL_BUDGET_KEYS.some((key) => consumedBudget.value[key] !== expectedConsumed[key]))
      return invalid("staged recall terminal bounds do not match the consumed context budget");
    const inputHashes = recallHashList(payload.inputHashes, "staged recall terminal inputHashes");
    if (!inputHashes.ok) return inputHashes;
    if (
      terminalInputHashes !== undefined &&
      stableStringify(terminalInputHashes) !== stableStringify(inputHashes.value)
    )
      return invalid("staged recall terminal input lineage disagrees");
    terminalInputHashes = inputHashes.value;
    if (terminalOccurredAt !== undefined && terminalOccurredAt !== occurredAt)
      return invalid("staged recall terminal timestamps disagree");
    terminalOccurredAt = occurredAt;
    const reason = payload.terminationReason;
    if (typeof reason !== "string" || !RECALL_TERMINATION_REASONS[reason])
      return invalid("staged recall terminal terminationReason is invalid");
    if (terminationReason !== undefined && terminationReason !== reason)
      return invalid("staged recall terminal termination data disagrees");
    terminationReason = reason;
    if (event.kind === "context.recall.terminated") {
      if (!record(payload.cancellation) || !record(payload.novelty) || !record(payload.stability))
        return invalid(
          "staged recall termination is missing cancellation, novelty, or stability data",
        );
      if (typeof payload.cancellation.parentRequested !== "boolean")
        return invalid("staged recall termination cancellation data is malformed");
      if (!Array.isArray(payload.cancellation.cancelledBranches))
        return invalid("staged recall termination cancellation lineage is malformed");
      if (typeof payload.novelty.hash !== "string" || !HASH.test(payload.novelty.hash))
        return invalid("staged recall termination novelty data is malformed");
      if (typeof payload.novelty.isNovel !== "boolean")
        return invalid("staged recall termination novelty status is malformed");
      cancellation = payload.cancellation;
      novelty = payload.novelty;
      terminatedPayload = payload;
      terminatedCount++;
    } else {
      returnedPayload = payload;
      returnedCount++;
    }
  }
  if (returnedCount !== 1 || terminatedCount !== 1)
    return invalid(
      "recall budget commit requires exactly one terminated and returned success event",
    );
  if (
    branchStarts.size !== branchEnds.size ||
    [...branchStarts].some((identity) => !branchEnds.has(identity))
  )
    return invalid("recall budget commit requires unique paired branch start/end records");
  const branches: StagedRecallBranch[] = [];
  for (const [identity, start] of branchStartRecords) {
    const end = branchEndRecords.get(identity);
    if (!end) return invalid("staged recall lifecycle branch lineage is incomplete");
    branches.push({ ...start, ...end });
  }
  if (
    contentHash === undefined ||
    traceHash === undefined ||
    scope === undefined ||
    scopeHash === undefined ||
    terminalBounds === undefined ||
    terminationReason === undefined ||
    cancellation === undefined ||
    novelty === undefined ||
    terminalOccurredAt === undefined ||
    terminatedPayload === undefined ||
    returnedPayload === undefined
  )
    return invalid("staged recall lifecycle events are missing result, scope, or terminal data");
  return {
    ok: true,
    value: {
      contentHash,
      traceHash,
      scope,
      scopeHash,
      branches,
      terminalBounds,
      terminationReason,
      cancellation,
      novelty,
      terminalInputHashes: terminalInputHashes ?? [],
      terminalOccurredAt,
      terminatedPayload,
      returnedPayload,
    },
  };
}
const MAX_RECALL_LIFECYCLE_LINEAGE = 256;

function recallLifecycleInputHashes(result: RecallResult): string[] {
  const values: string[] = [];
  const seen = new Set<string>();
  const add = (value: unknown): void => {
    if (
      values.length >= MAX_RECALL_LIFECYCLE_LINEAGE ||
      typeof value !== "string" ||
      !HASH.test(value) ||
      seen.has(value)
    )
      return;
    seen.add(value);
    values.push(value);
  };
  for (const item of result.evidence) {
    for (const value of item.support ?? []) add(value);
    for (const value of item.counterevidence ?? []) add(value);
  }
  for (const item of result.insights) {
    for (const value of item.supportEvidence ?? []) add(value);
    for (const value of item.counterEvidence ?? []) add(value);
  }
  for (const item of result.procedures) {
    for (const value of item.evidenceHashes ?? []) add(value);
    for (const value of item.evaluationHashes ?? []) add(value);
    if (item.evaluationHash !== undefined) add(item.evaluationHash);
  }
  return values.toSorted();
}

function recallLifecycleProcedureIdentity(item: RecallResult["procedures"][number]): string {
  return item.procedureId ?? item.id;
}

function recallLifecycleItemIds(result: RecallResult): string[] {
  const values: string[] = [];
  for (const item of result.evidence) {
    if (values.length >= MAX_RECALL_LIFECYCLE_LINEAGE) break;
    values.push(item.id);
  }
  for (const item of result.insights) {
    if (values.length >= MAX_RECALL_LIFECYCLE_LINEAGE) break;
    values.push(item.revisionId ?? item.id);
  }
  for (const item of result.procedures) {
    if (values.length >= MAX_RECALL_LIFECYCLE_LINEAGE) break;
    values.push(recallLifecycleProcedureIdentity(item));
  }
  return values;
}

function recallLifecycleProcedureProvenance(
  item: RecallResult["procedures"][number],
): Record<string, unknown> {
  return {
    id: item.id,
    procedureId: item.procedureId ?? item.id,
    version: item.version ?? null,
    sourceUri: item.sourceUri ?? null,
    contentHash: item.contentHash ?? null,
    authoredBy: item.authoredBy ?? null,
    trigger: item.trigger ?? null,
    preconditions: item.preconditions ?? [],
    scope: item.scope ?? null,
    environment: item.environment ?? null,
    validTime: item.validTime ?? null,
    actions: item.actions ?? [],
    successObservations: item.successObservations ?? [],
    failureObservations: item.failureObservations ?? [],
    requiredAuthority: item.requiredAuthority ?? [],
    evidenceHashes: item.evidenceHashes ?? [],
    evaluationHashes:
      item.evaluationHashes ?? (item.evaluationHash === undefined ? [] : [item.evaluationHash]),
    ...(item.evaluationHash === undefined ? {} : { evaluationHash: item.evaluationHash }),
    ...(item.evaluation === undefined ? {} : { evaluation: item.evaluation }),
  };
}

function recallLifecycleInstant(value: number | undefined, fallback: string): string {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  const candidate = new Date(value).toISOString();
  return Date.parse(candidate) < Date.parse(fallback) ? fallback : candidate;
}

function recallLifecycleState(kind: string): string {
  if (kind === "context.recall.branch.started") return "recall-branch-started";
  if (kind === "context.recall.branch.completed") return "recall-branch-completed";
  if (kind === "context.recall.branch.failed") return "recall-branch-failed";
  if (kind === "context.recall.branch.cancelled") return "recall-branch-cancelled";
  if (kind === "context.recall.terminated") return "recall-terminated";
  return "recalled";
}

function recallLifecycleBasePayload(
  session: ContextSession,
  result: RecallResult,
  kind: string,
  idempotencyKey: string,
  inputHashes: readonly string[],
  bounds: unknown,
): Record<string, unknown> {
  return {
    contextSessionId: session.contextSessionId,
    state: recallLifecycleState(kind),
    actorAuthority: "system",
    idempotencyKey,
    idempotencyIdentity: sha256(
      stableStringify({ contextSessionId: session.contextSessionId, kind, idempotencyKey }),
    ),
    inputEventIds: [],
    inputHashes,
    contentHash: result.contentHash,
    bounds,
  };
}

function validateRecallLifecycleResult(
  events: ValidatedStagedRecallEvents,
  result: RecallResult,
  session: ContextSession,
  invocationId: string,
  invocationHash: string,
  timestampFloor: string,
): ContextSessionStoreResult<true> {
  if (result.contentHash !== events.contentHash || result.trace.contentHash !== events.traceHash)
    return invalid("recall result hashes do not match staged lifecycle events");
  const trace = result.trace;
  if (
    stableStringify(events.scope) !== stableStringify(trace.scope) ||
    events.scopeHash !== trace.scopeHash
  )
    return invalid("recall result scope does not match staged lifecycle events");
  if (
    events.terminationReason !== trace.terminationReason ||
    stableStringify(events.terminalBounds) !== stableStringify(trace.budget) ||
    stableStringify(events.cancellation) !== stableStringify(trace.cancellation) ||
    stableStringify(events.novelty) !== stableStringify(trace.novelty)
  )
    return invalid("recall result terminal data does not match staged lifecycle events");

  const inputHashes = recallLifecycleInputHashes(result);
  if (stableStringify(events.terminalInputHashes) !== stableStringify(inputHashes))
    return invalid("recall result input lineage does not match staged lifecycle events");
  const branchTimes = trace.branches.flatMap((branch) =>
    branch.finishedAt === undefined ? [] : [branch.finishedAt],
  );
  const completedAt = recallLifecycleInstant(
    branchTimes.length === 0 ? undefined : Math.max(...branchTimes),
    timestampFloor,
  );
  if (events.terminalOccurredAt !== completedAt)
    return invalid("recall result terminal timestamp does not match staged lifecycle events");

  const invocation = {
    invocationId,
    invocationHash,
    scope: trace.scope,
    scopeHash: trace.scopeHash,
  };
  const terminatedKind = "context.recall.terminated";
  const terminatedKey = `recall:${invocationHash}:terminated`;
  const expectedTerminatedPayload = {
    ...invocation,
    contentHash: result.contentHash,
    traceHash: trace.contentHash,
    terminationReason: trace.terminationReason,
    cancellation: trace.cancellation,
    novelty: trace.novelty,
    stability: trace.stability,
    ...recallLifecycleBasePayload(
      session,
      result,
      terminatedKind,
      terminatedKey,
      inputHashes,
      trace.budget,
    ),
  };
  const itemIds = recallLifecycleItemIds(result);
  const returnedKind = "context.recall.returned";
  const returnedKey = `recall:${invocationHash}:returned`;
  const expectedReturnedPayload = {
    ...invocation,
    contentHash: result.contentHash,
    traceHash: trace.contentHash,
    terminationReason: trace.terminationReason,
    evidenceIds: result.evidence.map((item) => item.id),
    insightRevisions: result.insights.map((item) => item.revisionId ?? item.id),
    procedureIds: result.procedures.map(recallLifecycleProcedureIdentity),
    contradictionIds: result.contradictions.map((item) => item.id),
    unresolved: result.unresolved,
    disagreements: trace.disagreements,
    omissions: trace.omissions,
    ...recallLifecycleBasePayload(
      session,
      result,
      returnedKind,
      returnedKey,
      inputHashes,
      trace.budget,
    ),
    ...(itemIds.length === 1 ? { itemId: itemIds[0] } : {}),
    provenance: {
      evidenceReferences: result.evidence.flatMap((item) => [
        ...(item.reference === undefined ? [] : [item.reference]),
        ...(item.references ?? []),
      ]),
      insightRevisions: result.insights.map((item) => item.revisionId ?? item.id),
      procedures: result.procedures.map(recallLifecycleProcedureProvenance),
    },
  };
  if (
    stableStringify(events.terminatedPayload) !== stableStringify(expectedTerminatedPayload) ||
    stableStringify(events.returnedPayload) !== stableStringify(expectedReturnedPayload)
  )
    return invalid("recall result summaries do not match staged lifecycle events");

  const stagedBranches = new Map(
    events.branches.map((branch) => [
      sha256(
        stableStringify({
          branchId: branch.branchId,
          query: branch.query,
          depth: branch.depth,
        }),
      ),
      branch,
    ]),
  );
  if (
    stagedBranches.size !== events.branches.length ||
    stagedBranches.size !== trace.branches.length
  )
    return invalid("recall result branches do not match staged lifecycle events");
  for (const branch of trace.branches) {
    const identity = sha256(
      stableStringify({
        branchId: branch.branchId,
        query: branch.query,
        depth: branch.depth,
      }),
    );
    const staged = stagedBranches.get(identity);
    const expectedFailure =
      branch.failure === undefined
        ? undefined
        : { code: branch.failure.code, message: branch.failure.message.slice(0, 500) };
    const startedAt = recallLifecycleInstant(branch.startedAt, timestampFloor);
    const finishedAt = recallLifecycleInstant(branch.finishedAt, startedAt);
    const startedKind = "context.recall.branch.started";
    const startedKey = `recall:${invocationHash}:started:${identity}`;
    const expectedStartedPayload = {
      ...invocation,
      branchId: branch.branchId,
      query: branch.query,
      depth: branch.depth,
      deadlineAt: recallLifecycleInstant(branch.deadlineAt, startedAt),
      traceHash: trace.contentHash,
      ...recallLifecycleBasePayload(session, result, startedKind, startedKey, [], branch.budget),
    };
    const finishedKind = branchEndKind(branch.status);
    if (finishedKind === undefined)
      return invalid("recall result branch status has no lifecycle event kind");
    const finishedKey = `recall:${invocationHash}:${branch.status}:${identity}`;
    const expectedFinishedPayload = {
      ...invocation,
      branchId: branch.branchId,
      query: branch.query,
      depth: branch.depth,
      status: branch.status,
      traceHash: trace.contentHash,
      ...(expectedFailure === undefined ? {} : { failure: expectedFailure }),
      ...recallLifecycleBasePayload(session, result, finishedKind, finishedKey, [], branch.budget),
    };
    if (
      staged === undefined ||
      staged.status !== branch.status ||
      stableStringify(staged.budget) !== stableStringify(branch.budget) ||
      stableStringify(staged.failure) !== stableStringify(expectedFailure) ||
      staged.startedAt !== startedAt ||
      staged.finishedAt !== finishedAt ||
      stableStringify(staged.startedPayload) !== stableStringify(expectedStartedPayload) ||
      stableStringify(staged.finishedPayload) !== stableStringify(expectedFinishedPayload)
    )
      return invalid("recall result branches do not match staged lifecycle events");
  }
  return { ok: true, value: true };
}

function parseStoredSession(value: unknown): ContextSessionStoreResult<ContextSession> {
  if (!record(value)) return invalid("context session must be an object");
  const legacyMissingFields =
    !hasExactKeys(value, CONTEXT_SESSION_KEYS) && hasMigratableSessionKeys(value);
  if (!legacyMissingFields && !hasExactKeys(value, CONTEXT_SESSION_KEYS))
    return invalid("context session has missing or unknown fields");
  if (value.schemaVersion !== CONTEXT_SCHEMA_VERSION)
    return invalid("context session schema version is unsupported");
  if (!record(value.target) || !hasExactKeys(value.target, CONTEXT_TARGET_KEYS))
    return invalid("context session target has missing or unknown fields");
  if (!record(value.budget) || !hasExactKeys(value.budget, ["total", "remaining"]))
    return invalid("context session budget must contain exactly total and remaining");
  if (!record(value.budget.total) || !record(value.budget.remaining))
    return invalid("context session budget must contain total and remaining objects");

  const nativeSessionId = value.nativeSessionId;
  if (nativeSessionId !== null && typeof nativeSessionId !== "string")
    return invalid("nativeSessionId must be a string or null");
  if (typeof nativeSessionId === "string" && !nativeSessionId.trim())
    return invalid("nativeSessionId must be non-empty");
  const legacyAnonymous = isLegacyAnonymousSession(value);
  if (typeof value.contextSessionId !== "string" || !HASH.test(value.contextSessionId))
    return invalid("contextSessionId must be a lowercase SHA-256");
  const contextSessionId = value.contextSessionId;
  const sessionNonce = Object.prototype.hasOwnProperty.call(value, "sessionNonce")
    ? value.sessionNonce
    : legacyAnonymous
      ? legacyAnonymousSessionNonce(contextSessionId)
      : null;
  if (nativeSessionId === null) {
    if (typeof sessionNonce !== "string" || !sessionNonce.trim())
      return invalid("anonymous context sessions require a non-empty sessionNonce");
  } else if (sessionNonce !== null) {
    return invalid("native context sessions must not contain a sessionNonce");
  }

  const target = value.target;
  for (const [label, raw] of [
    ["provider", target.provider],
    ["harness", target.harness],
    ["role", target.role],
  ] as const)
    if (typeof raw !== "string" || !raw.trim())
      return invalid(`target.${label} must be non-empty text`);
  if (target.model !== null && (typeof target.model !== "string" || !target.model.trim()))
    return invalid("target.model must be non-empty text or null");
  const provider = target.provider as string;
  const harness = target.harness as string;
  const model = target.model as string | null;
  const role = target.role as string;

  for (const [label, raw] of [
    ["projectIdentity", value.projectIdentity],
    ["cwd", value.cwd],
    ["selectionPolicyVersion", value.selectionPolicyVersion],
    ["deliveryPolicyVersion", value.deliveryPolicyVersion],
  ] as const)
    if (typeof raw !== "string" || !raw.trim()) return invalid(`${label} must be non-empty text`);
  const projectIdentity = value.projectIdentity as string;
  const cwd = value.cwd as string;
  const selectionPolicyVersion = value.selectionPolicyVersion as string;
  const deliveryPolicyVersion = value.deliveryPolicyVersion as string;
  if (value.path !== null && (typeof value.path !== "string" || !value.path.trim()))
    return invalid("path must be non-empty text or null");
  const path = value.path as string | null;
  if (
    typeof value.pinnedInsightProjectionHash !== "string" ||
    !HASH.test(value.pinnedInsightProjectionHash)
  )
    return invalid("pinnedInsightProjectionHash must be a lowercase SHA-256 hash");
  if (
    typeof value.pinnedEvidenceProjectionHash !== "string" ||
    !HASH.test(value.pinnedEvidenceProjectionHash)
  )
    return invalid("pinnedEvidenceProjectionHash must be a lowercase SHA-256 hash");
  if (typeof value.createdAt !== "string" || !validTimestamp(value.createdAt))
    return invalid("createdAt must be an ISO timestamp");
  if (typeof value.updatedAt !== "string" || !validTimestamp(value.updatedAt))
    return invalid("updatedAt must be an ISO timestamp");

  if (!Array.isArray(value.domainPolicy) || value.domainPolicy.length === 0)
    return invalid("domainPolicy must be a non-empty array");
  const domains = value.domainPolicy as unknown[];
  if (
    !domains.every((domain): domain is string => typeof domain === "string" && domain.trim() !== "")
  )
    return invalid("domainPolicy must contain only non-empty strings");
  const domainValues = domains as string[];
  const canonicalDomains = [
    ...new Set(domainValues.map((domain) => domain.trim().toLowerCase())),
  ].toSorted();
  if (
    canonicalDomains.length !== domainValues.length ||
    canonicalDomains.some((domain, index) => domain !== domainValues[index])
  )
    return invalid("domainPolicy must be sorted, unique, lowercase, and trimmed");

  const total = normalizeBudget(value.budget.total, "totalBudget");
  if (!total.ok) return total;
  const remaining = normalizeBudget(value.budget.remaining, "remainingBudget");
  if (!remaining.ok) return remaining;
  for (const key of CONTEXT_BUDGET_KEYS)
    if (remaining.value[key] > total.value[key])
      return invalid(`remainingBudget.${key} exceeds the total budget`);
  const consumedBundleHashes = strictHashArray(value.consumedBundleHashes, "consumedBundleHashes");
  if (!consumedBundleHashes.ok) return consumedBundleHashes;
  if (consumedBundleHashes.value.length > MAX_CONTEXT_BUNDLE_HASHES)
    return invalid(`consumedBundleHashes must contain at most ${MAX_CONTEXT_BUNDLE_HASHES} hashes`);
  const committedDeliveryBatchHashes: ContextSessionStoreResult<string[]> =
    Object.prototype.hasOwnProperty.call(value, "committedDeliveryBatchHashes")
      ? strictHashArray(value.committedDeliveryBatchHashes, "committedDeliveryBatchHashes")
      : { ok: true, value: [] };
  if (!committedDeliveryBatchHashes.ok) return committedDeliveryBatchHashes;
  if (committedDeliveryBatchHashes.value.length > MAX_CONTEXT_BUNDLE_HASHES)
    return invalid(
      `committedDeliveryBatchHashes must contain at most ${MAX_CONTEXT_BUNDLE_HASHES} hashes`,
    );
  const attemptedBundleHashes: ContextSessionStoreResult<string[]> =
    Object.prototype.hasOwnProperty.call(value, "attemptedBundleHashes")
      ? strictHashArray(value.attemptedBundleHashes, "attemptedBundleHashes")
      : { ok: true, value: [] };
  if (!attemptedBundleHashes.ok) return attemptedBundleHashes;
  if (attemptedBundleHashes.value.length > MAX_CONTEXT_BUNDLE_HASHES)
    return invalid(
      `attemptedBundleHashes must contain at most ${MAX_CONTEXT_BUNDLE_HASHES} hashes`,
    );
  if (
    (Array.isArray(value.consumedRecallHashes) &&
      value.consumedRecallHashes.length > MAX_CONTEXT_RECALL_INVOCATIONS) ||
    (Array.isArray(value.consumedRecallInvocations) &&
      value.consumedRecallInvocations.length > MAX_CONTEXT_RECALL_INVOCATIONS)
  )
    return invalid(
      `context sessions accept at most ${MAX_CONTEXT_RECALL_INVOCATIONS} recall invocations`,
    );
  const consumedRecallHashes: ContextSessionStoreResult<string[]> =
    Object.prototype.hasOwnProperty.call(value, "consumedRecallHashes")
      ? strictHashArray(value.consumedRecallHashes, "consumedRecallHashes")
      : { ok: true, value: [] };
  if (!consumedRecallHashes.ok) return consumedRecallHashes;
  const consumedRecallInvocations: ContextSessionStoreResult<RecallInvocationRecord[]> =
    Object.prototype.hasOwnProperty.call(value, "consumedRecallInvocations")
      ? strictRecallInvocationArray(value.consumedRecallInvocations, "consumedRecallInvocations")
      : { ok: true, value: [] };
  if (!consumedRecallInvocations.ok) return consumedRecallInvocations;
  if (
    consumedRecallHashes.value.length !== consumedRecallInvocations.value.length ||
    consumedRecallInvocations.value.some(
      (invocation, index) => invocation.invocationHash !== consumedRecallHashes.value[index],
    )
  )
    return invalid("consumed recall hashes must match the recorded invocation order");
  if (
    Array.isArray(value.pendingEventBatchHashes) &&
    value.pendingEventBatchHashes.length > MAX_STAGED_RECALL_EVENT_BATCHES
  )
    return invalid(
      `pendingEventBatchHashes must contain at most ${MAX_STAGED_RECALL_EVENT_BATCHES} hashes`,
    );
  const pendingEventBatchHashes: ContextSessionStoreResult<string[]> =
    Object.prototype.hasOwnProperty.call(value, "pendingEventBatchHashes")
      ? strictHashArray(value.pendingEventBatchHashes, "pendingEventBatchHashes")
      : { ok: true, value: [] };
  if (!pendingEventBatchHashes.ok) return pendingEventBatchHashes;
  const createdAt = value.createdAt as string;
  const updatedAt = value.updatedAt as string;
  const pinnedInsightProjectionHash = value.pinnedInsightProjectionHash as string;
  const pinnedEvidenceProjectionHash = value.pinnedEvidenceProjectionHash as string;

  const legacyIdentityInput = {
    nativeSessionId,
    sessionNonce: undefined,
    provider,
    harness,
    model,
    role,
    projectIdentity,
    cwd,
    domainPolicy: canonicalDomains,
    path,
    pinnedInsightProjectionHash,
    pinnedEvidenceProjectionHash,
    selectionPolicyVersion,
    deliveryPolicyVersion,
  };
  const legacyIdentityMatches =
    nativeSessionId === null && contextSessionId === contextSessionIdentity(legacyIdentityInput);
  const migratedLegacyAnonymous =
    legacyIdentityMatches && sessionNonce === legacyAnonymousSessionNonce(contextSessionId);
  const preservesLegacyIdentity = legacyAnonymous || migratedLegacyAnonymous;
  const identityInput = {
    ...legacyIdentityInput,
    sessionNonce: preservesLegacyIdentity ? undefined : (sessionNonce as string | null),
  };
  if (contextSessionId !== contextSessionIdentity(identityInput))
    return invalid(
      preservesLegacyIdentity
        ? "legacy context session identity does not match its binding"
        : "context session identity does not match its binding",
    );
  const created = createContextSession({
    nativeSessionId,
    sessionNonce: sessionNonce as string | null,
    provider,
    harness,
    model,
    role,
    projectIdentity,
    cwd,
    domainPolicy: canonicalDomains,
    path,
    pinnedInsightProjectionHash,
    pinnedEvidenceProjectionHash,
    selectionPolicyVersion,
    deliveryPolicyVersion,
    totalBudget: total.value,
    createdAt,
  });
  if (!created.ok) return created;
  return {
    ok: true,
    value: {
      ...created.value,
      contextSessionId: preservesLegacyIdentity ? contextSessionId : created.value.contextSessionId,
      budget: { total: created.value.budget.total, remaining: remaining.value },
      consumedBundleHashes: consumedBundleHashes.value,
      committedDeliveryBatchHashes: committedDeliveryBatchHashes.value,
      attemptedBundleHashes: attemptedBundleHashes.value,
      consumedRecallHashes: consumedRecallHashes.value,
      consumedRecallInvocations: consumedRecallInvocations.value,
      pendingEventBatchHashes: pendingEventBatchHashes.value,
      updatedAt,
    },
  };
}

function sessionPath(root: string, contextSessionId: string): string {
  return join(resolve(root), "memory", "context-sessions", `${contextSessionId}.json`);
}

async function atomicPrivateJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await chmod(dirname(path), 0o700);
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
  await rename(temporary, path);
  await chmod(path, 0o600);
}

function validPendingDeliveryEvent(
  hash: string,
  event: EventBatch["events"][number],
  session: ContextSession,
): boolean {
  const payload = event.payload;
  if (
    typeof payload.bundleHash !== "string" ||
    !HASH.test(payload.bundleHash) ||
    !session.consumedBundleHashes.includes(payload.bundleHash) ||
    !session.committedDeliveryBatchHashes.includes(hash) ||
    Object.prototype.hasOwnProperty.call(payload, "invocationId") ||
    Object.prototype.hasOwnProperty.call(payload, "invocationHash") ||
    payload.contextSessionId !== session.contextSessionId ||
    event.scope.sessionId !== session.contextSessionId ||
    payload.idempotencyKey !== `${payload.bundleHash}:${event.kind}` ||
    typeof payload.itemId !== "string" ||
    payload.itemId.length === 0 ||
    typeof payload.inputHash !== "string" ||
    !HASH.test(payload.inputHash) ||
    typeof payload.contentHash !== "string" ||
    !HASH.test(payload.contentHash) ||
    typeof payload.candidateContentHash !== "string" ||
    !HASH.test(payload.candidateContentHash) ||
    typeof payload.policyHash !== "string" ||
    !HASH.test(payload.policyHash) ||
    !Array.isArray(payload.inputEventIds) ||
    payload.inputEventIds.length !== 1 ||
    payload.inputEventIds.some((value) => typeof value !== "string" || !HASH.test(value)) ||
    !Array.isArray(payload.inputHashes) ||
    payload.inputHashes.length !== 1 ||
    payload.inputHashes.some((value) => typeof value !== "string" || !HASH.test(value)) ||
    !record(payload.bounds) ||
    !hasExactKeys(payload.bounds, [
      "beforeTokens",
      "afterTokens",
      "beforeResults",
      "afterResults",
      "beforeLatencyMs",
      "afterLatencyMs",
      "beforeCostUsd",
      "afterCostUsd",
      "fixedInstructionTokens",
      "encodingOverheadTokens",
    ]) ||
    Object.values(payload.bounds).some(
      (value) => typeof value !== "number" || !Number.isFinite(value) || value < 0,
    )
  )
    return false;
  const providerAcknowledged = payload.receiptEvidence === "provider-acknowledgment";
  if (providerAcknowledged)
    return (
      event.kind === "context.bundle.acknowledged" &&
      event.actor.kind.toLowerCase() === "provider" &&
      payload.actorAuthority === "provider" &&
      payload.providerReported === true
    );
  return (
    (event.kind === "context.bundle.emitted" || event.kind === "context.recall.returned") &&
    event.actor.kind.toLowerCase() === "system" &&
    payload.actorAuthority === "system" &&
    payload.providerReported !== true
  );
}

async function publishSessionOutbox(
  root: string,
  session: ContextSession,
): Promise<ContextSessionStoreResult<Set<string>>> {
  try {
    const pending = await Promise.all(
      session.pendingEventBatchHashes.map(async (hash) => ({
        hash,
        batch: await readEventBatch(root, hash),
      })),
    );
    const publishable = new Set<string>();
    const attemptedRecallInvocations = new Set<string>();
    for (const candidate of pending) {
      if (candidate.batch.events.length !== 1) continue;
      const event = candidate.batch.events[0]!;
      const payload = event.payload;
      if (
        payload.contextSessionId !== session.contextSessionId ||
        event.scope.sessionId !== session.contextSessionId
      )
        continue;
      if (Object.prototype.hasOwnProperty.call(payload, "bundleHash")) {
        if (validPendingDeliveryEvent(candidate.hash, event, session))
          publishable.add(candidate.hash);
        continue;
      }
      if (!RECALL_EVENT_KINDS[event.kind]) continue;
      if (
        typeof payload.invocationId !== "string" ||
        payload.invocationId.trim().length === 0 ||
        typeof payload.invocationHash !== "string" ||
        !HASH.test(payload.invocationHash)
      )
        continue;
      const invocation = session.consumedRecallInvocations.find(
        (item) =>
          item.invocationId === payload.invocationId &&
          item.invocationHash === payload.invocationHash,
      );
      if (!invocation || attemptedRecallInvocations.has(invocation.invocationHash)) continue;
      if (invocation.lifecycleTimestampFloor === undefined) continue;
      attemptedRecallInvocations.add(invocation.invocationHash);
      const durable = await readContextRecallResult(root, session.contextSessionId, invocation, {
        session,
      });
      if (!durable.ok) continue;
      const invocationBatchHashes = pending.flatMap(({ hash, batch }) => {
        if (batch.events.length !== 1) return [];
        const pendingEvent = batch.events[0]!;
        return RECALL_EVENT_KINDS[pendingEvent.kind] &&
          !Object.prototype.hasOwnProperty.call(pendingEvent.payload, "bundleHash") &&
          pendingEvent.payload.invocationId === invocation.invocationId &&
          pendingEvent.payload.invocationHash === invocation.invocationHash
          ? [hash]
          : [];
      });
      const consumed: ContextBudget = {
        tokens: durable.value.trace.consumedBudget.maxTokens,
        results: durable.value.trace.consumedBudget.maxResults,
        latencyMs: durable.value.trace.consumedBudget.maxLatencyMs,
        costUsd: durable.value.trace.consumedBudget.maxCostUsd,
      };
      const lifecycle = await validateStagedRecallEvents(
        root,
        invocationBatchHashes,
        session,
        invocation.invocationId,
        invocation.invocationHash,
        consumed,
      );
      if (!lifecycle.ok) continue;
      const result = validateRecallLifecycleResult(
        lifecycle.value,
        durable.value,
        session,
        invocation.invocationId,
        invocation.invocationHash,
        invocation.lifecycleTimestampFloor,
      );
      if (!result.ok) continue;
      for (const hash of invocationBatchHashes) publishable.add(hash);
    }
    await publishContextEventBatches(root, [...publishable]);
    return { ok: true, value: publishable };
  } catch (error) {
    return storageError(error);
  }
}

function withoutPublishedOutbox(
  session: ContextSession,
  published: ReadonlySet<string>,
): ContextSession {
  if (published.size === 0) return session;
  return {
    ...session,
    pendingEventBatchHashes: session.pendingEventBatchHashes.filter((hash) => !published.has(hash)),
  };
}

function sameNativeBinding(left: ContextSession, right: ContextSession): boolean {
  return (
    left.nativeSessionId === right.nativeSessionId &&
    left.target.provider === right.target.provider &&
    left.target.harness === right.target.harness &&
    left.target.model === right.target.model &&
    left.target.role === right.target.role &&
    left.projectIdentity === right.projectIdentity &&
    left.cwd === right.cwd &&
    left.path === right.path &&
    left.domainPolicy.length === right.domainPolicy.length &&
    left.domainPolicy.every((domain, index) => domain === right.domainPolicy[index])
  );
}

interface NativeSessionLookup {
  readonly session: ContextSession | undefined;
  readonly total: number;
}

async function findNativeSession(
  root: string,
  nativeSessionId: string,
): Promise<ContextSessionStoreResult<NativeSessionLookup>> {
  const directoryPath = join(resolve(root), "memory", "context-sessions");
  let directory;
  try {
    directory = await opendir(directoryPath);
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")
      return { ok: true, value: { session: undefined, total: 0 } };
    return storageError(error);
  }
  let match: ContextSession | undefined;
  let total = 0;
  let enumerated = false;
  try {
    for await (const entry of directory) {
      enumerated = true;
      if (!entry.name.endsWith(".json")) continue;
      total += 1;
      if (total > MAX_CONTEXT_SESSIONS)
        return invalid(`context session storage exceeds the ${MAX_CONTEXT_SESSIONS}-session limit`);
      let parsed: ContextSessionStoreResult<ContextSession>;
      try {
        parsed = parseStoredSession(
          JSON.parse(await readFile(join(directoryPath, entry.name), "utf8")),
        );
      } catch (error) {
        return storageError(error);
      }
      if (!parsed.ok) return parsed;
      if (parsed.value.nativeSessionId !== nativeSessionId) continue;
      if (match !== undefined)
        return invalid("nativeSessionId is bound by multiple stored context sessions");
      match = parsed.value;
    }
  } catch (error) {
    if (
      !enumerated &&
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    )
      return { ok: true, value: { session: undefined, total: 0 } };
    return storageError(error);
  }
  return { ok: true, value: { session: match, total } };
}
function contextSessionIsUnused(session: ContextSession): boolean {
  return (
    session.pendingEventBatchHashes.length === 0 &&
    session.consumedBundleHashes.length === 0 &&
    session.attemptedBundleHashes.length === 0 &&
    session.consumedRecallHashes.length === 0 &&
    session.consumedRecallInvocations.length === 0 &&
    session.budget.total.tokens === session.budget.remaining.tokens &&
    session.budget.total.results === session.budget.remaining.results &&
    session.budget.total.latencyMs === session.budget.remaining.latencyMs &&
    session.budget.total.costUsd === session.budget.remaining.costUsd
  );
}
async function contextSessionHasRecallArtifacts(
  root: string,
  contextSessionId: string,
): Promise<ContextSessionStoreResult<boolean>> {
  let directory;
  try {
    directory = await opendir(
      join(resolve(root), "memory", "context-recall-results", contextSessionId),
    );
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")
      return { ok: true, value: false };
    return storageError(error);
  }
  try {
    for await (const _entry of directory) return { ok: true, value: true };
    return { ok: true, value: false };
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")
      return { ok: true, value: false };
    return storageError(error);
  }
}

async function requireContextSessionCapacity(
  root: string,
  excludedNativeSessionId?: string | null,
): Promise<ContextSessionStoreResult<true>> {
  const directoryPath = join(resolve(root), "memory", "context-sessions");
  let directory;
  try {
    directory = await opendir(directoryPath);
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")
      return { ok: true, value: true };
    return storageError(error);
  }
  const reclaimable: ContextSession[] = [];
  let total = 0;
  let enumerated = false;
  try {
    for await (const entry of directory) {
      enumerated = true;
      if (!entry.name.endsWith(".json")) continue;
      total += 1;
      if (total > MAX_CONTEXT_SESSIONS)
        return invalid(`context session storage exceeds the ${MAX_CONTEXT_SESSIONS}-session limit`);
      let parsed: ContextSessionStoreResult<ContextSession>;
      try {
        parsed = parseStoredSession(
          JSON.parse(await readFile(join(directoryPath, entry.name), "utf8")),
        );
      } catch (error) {
        return storageError(error);
      }
      if (!parsed.ok) return parsed;
      if (
        contextSessionIsUnused(parsed.value) &&
        (excludedNativeSessionId == null ||
          parsed.value.nativeSessionId !== excludedNativeSessionId)
      )
        reclaimable.push(parsed.value);
    }
  } catch (error) {
    if (
      !enumerated &&
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    )
      return { ok: true, value: true };
    return storageError(error);
  }
  if (total < MAX_CONTEXT_SESSIONS) return { ok: true, value: true };
  const candidates = reclaimable.toSorted((left, right) => {
    const updated = Date.parse(left.updatedAt) - Date.parse(right.updatedAt);
    return updated !== 0 ? updated : left.contextSessionId.localeCompare(right.contextSessionId);
  });
  let database: Database;
  try {
    database = new Database(join(resolve(root), "analysis", "chatlog.sqlite"), {
      readonly: true,
      create: false,
    });
  } catch (error) {
    return storageError(error);
  }
  try {
    const hasEvents = database.query(
      "SELECT 1 FROM context_event_projection WHERE context_session_id = ? LIMIT 1",
    );
    for (const candidate of candidates) {
      if (hasEvents.get(candidate.contextSessionId) !== null) continue;
      const hasRecallArtifacts = await contextSessionHasRecallArtifacts(
        root,
        candidate.contextSessionId,
      );
      if (!hasRecallArtifacts.ok) return hasRecallArtifacts;
      if (hasRecallArtifacts.value) continue;
      try {
        await unlink(sessionPath(root, candidate.contextSessionId));
        return { ok: true, value: true };
      } catch (error) {
        return storageError(error);
      }
    }
    return invalid("context session storage is full and no unused session is reclaimable");
  } catch (error) {
    return storageError(error);
  } finally {
    database.close();
  }
}

export async function readContextSession(
  root: string,
  contextSessionId: string,
): Promise<ContextSessionStoreResult<ContextSession>> {
  if (!HASH.test(contextSessionId)) return invalid("contextSessionId must be a lowercase SHA-256");
  const location = sessionPath(root, contextSessionId);
  let parsed: ContextSessionStoreResult<ContextSession>;
  let migrate = false;
  try {
    const raw = JSON.parse(await readFile(location, "utf8")) as unknown;
    migrate = record(raw) && isLegacyAnonymousSession(raw);
    parsed = parseStoredSession(raw);
  } catch (error) {
    return storageError(error);
  }
  if (!parsed.ok) return parsed;
  if (migrate) {
    const migrated = await withIngestLock(root, async () => {
      try {
        const currentRaw = JSON.parse(await readFile(location, "utf8")) as unknown;
        const current = parseStoredSession(currentRaw);
        if (!current.ok) return current;
        if (record(currentRaw) && isLegacyAnonymousSession(currentRaw))
          await atomicPrivateJson(location, current.value);
        return current;
      } catch (error) {
        return storageError(error);
      }
    });
    if (!migrated.ok) return migrated;
    parsed = migrated;
  }
  const published = await publishSessionOutbox(root, parsed.value);
  if (!published.ok) return published;
  if (published.value.size === 0) return parsed;
  return withIngestLock(root, async () => {
    let current: ContextSessionStoreResult<ContextSession>;
    try {
      current = parseStoredSession(JSON.parse(await readFile(location, "utf8")) as unknown);
    } catch (error) {
      return storageError(error);
    }
    if (!current.ok) return current;
    const updated = withoutPublishedOutbox(current.value, published.value);
    if (updated === current.value) return current;
    try {
      await atomicPrivateJson(location, updated);
      return { ok: true, value: updated };
    } catch (error) {
      return storageError(error);
    }
  });
}

export async function openContextSession(
  root: string,
  input: ContextSessionInput,
): Promise<ContextSessionStoreResult<ContextSession>> {
  const candidate = createContextSession(input);
  if (!candidate.ok) return candidate;
  return withIngestLock(root, async () => {
    if (candidate.value.nativeSessionId !== null) {
      const existing = await findNativeSession(root, candidate.value.nativeSessionId);
      if (!existing.ok) return existing;
      if (existing.value.session !== undefined) {
        if (!sameNativeBinding(existing.value.session, candidate.value))
          return {
            ok: false,
            error: {
              code: "session-conflict",
              message: "nativeSessionId is already bound to a different session identity",
            },
          };
        return { ok: true, value: existing.value.session };
      }
    } else {
      try {
        const current = parseStoredSession(
          JSON.parse(await readFile(sessionPath(root, candidate.value.contextSessionId), "utf8")),
        );
        if (!current.ok) return current;
        return { ok: true, value: current.value };
      } catch (error) {
        if (
          typeof error !== "object" ||
          error === null ||
          !("code" in error) ||
          error.code !== "ENOENT"
        )
          return storageError(error);
      }
    }
    const capacity = await requireContextSessionCapacity(root, candidate.value.nativeSessionId);
    if (!capacity.ok) return capacity;
    try {
      await atomicPrivateJson(sessionPath(root, candidate.value.contextSessionId), candidate.value);
      return candidate;
    } catch (error) {
      return storageError(error);
    }
  });
}

export interface ReserveContextBundleAttemptResult {
  readonly session: ContextSession;
  readonly reserved: boolean;
}

export async function reserveContextBundleAttempt(
  root: string,
  contextSessionId: string,
  bundleHash: string,
): Promise<ContextSessionStoreResult<ReserveContextBundleAttemptResult>> {
  if (!HASH.test(contextSessionId)) return invalid("contextSessionId must be a lowercase SHA-256");
  if (!HASH.test(bundleHash)) return invalid("bundleHash must be a lowercase SHA-256");
  return withIngestLock(root, async () => {
    let current: ContextSessionStoreResult<ContextSession>;
    try {
      current = parseStoredSession(
        JSON.parse(await readFile(sessionPath(root, contextSessionId), "utf8")),
      );
    } catch (error) {
      return storageError(error);
    }
    if (!current.ok) return current;
    if (current.value.attemptedBundleHashes.includes(bundleHash))
      return { ok: true, value: { session: current.value, reserved: false } };
    if (current.value.attemptedBundleHashes.length >= MAX_CONTEXT_BUNDLE_HASHES)
      return invalid(
        `attemptedBundleHashes must contain at most ${MAX_CONTEXT_BUNDLE_HASHES} hashes`,
      );
    const updated: ContextSession = {
      ...current.value,
      attemptedBundleHashes: [...current.value.attemptedBundleHashes, bundleHash],
      updatedAt: new Date().toISOString(),
    };
    try {
      await atomicPrivateJson(sessionPath(root, contextSessionId), updated);
      return { ok: true, value: { session: updated, reserved: true } };
    } catch (error) {
      return storageError(error);
    }
  });
}

export interface CommitContextBundleBudgetResult {
  readonly session: ContextSession;
  readonly committed: boolean;
}

export async function commitContextBundleBudget(
  root: string,
  bundle: ContextBundle,
  committedAt: string,
  renderedTokens: number,
  eventBatchHashes: readonly string[],
): Promise<ContextSessionStoreResult<CommitContextBundleBudgetResult>> {
  if (!HASH.test(bundle.bundleHash)) return invalid("bundleHash must be a lowercase SHA-256");
  if (!validTimestamp(committedAt)) return invalid("committedAt must be an ISO timestamp");
  if (!Number.isSafeInteger(renderedTokens) || renderedTokens < 0)
    return invalid("renderedTokens must be a non-negative integer");
  const staged = requiredHashArray(eventBatchHashes, "eventBatchHashes");
  if (!staged.ok) return staged;
  const validEvents = await validateStagedBundleEvent(root, staged.value, bundle);
  if (!validEvents.ok) return validEvents;
  const recovered = await readContextSession(root, bundle.contextSessionId);
  if (!recovered.ok) return recovered;

  return withIngestLock(root, async () => {
    let current: ContextSessionStoreResult<ContextSession>;
    try {
      current = parseStoredSession(
        JSON.parse(await readFile(sessionPath(root, bundle.contextSessionId), "utf8")),
      );
    } catch (error) {
      return storageError(error);
    }
    if (!current.ok) return current;
    const session = current.value;
    if (session.consumedBundleHashes.includes(bundle.bundleHash))
      return { ok: true, value: { session, committed: false } };
    if (
      bundle.pinnedInsightProjectionHash !== session.pinnedInsightProjectionHash ||
      bundle.pinnedEvidenceProjectionHash !== session.pinnedEvidenceProjectionHash
    )
      return {
        ok: false,
        error: { code: "session-conflict", message: "bundle projection pins do not match session" },
      };
    const before = bundle.budget;
    if (
      before.beforeTokens !== session.budget.remaining.tokens ||
      before.beforeResults !== session.budget.remaining.results ||
      before.beforeLatencyMs !== session.budget.remaining.latencyMs ||
      before.beforeCostUsd !== session.budget.remaining.costUsd
    )
      return {
        ok: false,
        error: { code: "session-conflict", message: "bundle was planned against stale budget" },
      };
    if (renderedTokens > session.budget.remaining.tokens)
      return {
        ok: false,
        error: {
          code: "session-conflict",
          message: "rendered context exceeds the remaining session token budget",
        },
      };
    const remaining = normalizeBudget(
      {
        tokens: session.budget.remaining.tokens - renderedTokens,
        results: before.afterResults,
        latencyMs: before.afterLatencyMs,
        costUsd: before.afterCostUsd,
      },
      "remainingBudget",
    );
    if (!remaining.ok) return remaining;
    const pendingEventBatchHashes = [
      ...new Set([...session.pendingEventBatchHashes, ...staged.value]),
    ];
    if (pendingEventBatchHashes.length > MAX_STAGED_RECALL_EVENT_BATCHES)
      return invalid(
        `pendingEventBatchHashes must contain at most ${MAX_STAGED_RECALL_EVENT_BATCHES} hashes`,
      );
    const updated: ContextSession = {
      ...session,
      budget: { total: { ...session.budget.total }, remaining: remaining.value },
      consumedBundleHashes: [...session.consumedBundleHashes, bundle.bundleHash],
      committedDeliveryBatchHashes: [...session.committedDeliveryBatchHashes, staged.value[0]!],
      pendingEventBatchHashes,
      updatedAt: committedAt,
    };
    try {
      await atomicPrivateJson(sessionPath(root, session.contextSessionId), updated);
      return { ok: true, value: { session: updated, committed: true } };
    } catch (error) {
      return storageError(error);
    }
  });
}
const RECALL_RESULT_KEYS = [
  "evidence",
  "insights",
  "procedures",
  "contradictions",
  "unresolved",
  "confidence",
  "contentHash",
  "trace",
] as const;
const RECALL_RESULT_KEYS_WITH_ANSWER = ["answer", ...RECALL_RESULT_KEYS] as const;
const RECALL_TRACE_KEYS = [
  "branches",
  "queries",
  "depth",
  "budget",
  "consumedBudget",
  "remainingBudget",
  "cancellation",
  "novelty",
  "stability",
  "terminationReason",
  "scope",
  "scopeHash",
  "queryLineage",
  "visitedEvidenceIds",
  "visitedInsightRevisions",
  "branchFailures",
  "disagreements",
  "omissions",
  "contentHash",
] as const;

function recallResultPath(root: string, contextSessionId: string, invocationHash: string): string {
  return join(
    resolve(root),
    "memory",
    "context-recall-results",
    contextSessionId,
    `${invocationHash}.json`,
  );
}

export interface RecallResultValidationContext {
  readonly scope?: RecallScope;
  readonly session?: Pick<ContextSession, "projectIdentity" | "target" | "domainPolicy" | "path">;
}

function recallScopeMatchesSession(
  scope: RecallScope,
  session: RecallResultValidationContext["session"],
): boolean {
  if (session === undefined) return true;
  if (
    scope.project !== session.projectIdentity ||
    scope.repository !== session.projectIdentity ||
    scope.provider !== session.target.provider ||
    scope.harness !== session.target.harness ||
    scope.model !== session.target.model ||
    typeof scope.domain !== "string" ||
    !session.domainPolicy.includes(scope.domain)
  )
    return false;
  if (scope.user !== null || scope.organization !== null || scope.tool !== null) return false;
  if (
    !Array.isArray(scope.itemPermissions) ||
    scope.itemPermissions.length !== 0 ||
    scope.itemPermissions.some((permission) => typeof permission !== "string")
  )
    return false;
  return session.path === null
    ? scope.path === null || scope.path === undefined
    : typeof scope.path === "string" && recallPathWithin(session.path, scope.path);
}

function validateStoredRecallResult(
  value: unknown,
  label: string,
  context: RecallResultValidationContext = {},
): ContextSessionStoreResult<RecallResult> {
  const bounded = validateBoundedRecord(value, label);
  if (!bounded.ok) return invalid(bounded.error);
  if (!record(value)) return invalid(`${label} must be an object`);
  if (
    !hasExactKeys(
      value,
      Object.prototype.hasOwnProperty.call(value, "answer")
        ? RECALL_RESULT_KEYS_WITH_ANSWER
        : RECALL_RESULT_KEYS,
    )
  )
    return invalid(`${label} has missing or unknown fields`);
  if (
    !Array.isArray(value.evidence) ||
    !Array.isArray(value.insights) ||
    !Array.isArray(value.procedures) ||
    !Array.isArray(value.contradictions) ||
    !Array.isArray(value.unresolved) ||
    !Array.isArray(value.confidence) ||
    (value.answer !== undefined && typeof value.answer !== "string") ||
    typeof value.contentHash !== "string" ||
    !HASH.test(value.contentHash) ||
    !record(value.trace) ||
    !hasExactKeys(value.trace, RECALL_TRACE_KEYS)
  )
    return invalid(`${label} has malformed result fields`);
  const trace = value.trace;
  if (
    !Array.isArray(trace.branches) ||
    !Array.isArray(trace.queries) ||
    !Number.isSafeInteger(trace.depth) ||
    (trace.depth as number) < 0 ||
    typeof trace.terminationReason !== "string" ||
    !RECALL_TERMINATION_REASONS[trace.terminationReason] ||
    !record(trace.cancellation) ||
    !hasExactKeys(trace.cancellation, ["parentRequested", "cancelledBranches"]) ||
    typeof trace.cancellation.parentRequested !== "boolean" ||
    !Array.isArray(trace.cancellation.cancelledBranches) ||
    trace.cancellation.cancelledBranches.some((item) => typeof item !== "string") ||
    !record(trace.novelty) ||
    !hasExactKeys(trace.novelty, [
      "hash",
      "isNovel",
      "addedEvidenceIds",
      "addedInsightRevisions",
      "addedContradictionIds",
      "reducedUnresolved",
    ]) ||
    typeof trace.novelty.hash !== "string" ||
    !HASH.test(trace.novelty.hash) ||
    typeof trace.novelty.isNovel !== "boolean" ||
    !Array.isArray(trace.novelty.addedEvidenceIds) ||
    trace.novelty.addedEvidenceIds.some((item) => typeof item !== "string") ||
    !Array.isArray(trace.novelty.addedInsightRevisions) ||
    trace.novelty.addedInsightRevisions.some((item) => typeof item !== "string") ||
    !Array.isArray(trace.novelty.addedContradictionIds) ||
    trace.novelty.addedContradictionIds.some((item) => typeof item !== "string") ||
    typeof trace.novelty.reducedUnresolved !== "boolean" ||
    !record(trace.stability) ||
    !hasExactKeys(trace.stability, ["hash", "priorHashes", "stable"]) ||
    typeof trace.stability.hash !== "string" ||
    !HASH.test(trace.stability.hash) ||
    !Array.isArray(trace.stability.priorHashes) ||
    trace.stability.priorHashes.some((item) => typeof item !== "string") ||
    typeof trace.stability.stable !== "boolean"
  )
    return invalid(`${label}.trace lifecycle fields are malformed`);
  if (typeof trace.contentHash !== "string" || !HASH.test(trace.contentHash))
    return invalid(`${label}.trace.contentHash must be a lowercase SHA-256`);
  if (!record(trace.scope) || typeof trace.scopeHash !== "string" || !HASH.test(trace.scopeHash))
    return invalid(`${label}.trace scope binding is malformed`);
  if (sha256(stableStringify(trace.scope)) !== trace.scopeHash)
    return invalid(`${label}.trace.scopeHash does not match the durable scope`);
  if (!recallScopeMatchesSession(trace.scope as RecallScope, context.session))
    return invalid(`${label}.trace.scope is outside the parent context session`);
  if (
    context.scope !== undefined &&
    stableStringify(trace.scope) !== stableStringify(context.scope)
  )
    return invalid(`${label}.trace.scope does not match the exact recall request scope`);
  const traceBudgets =
    record(trace.budget) && hasExactKeys(trace.budget, ["total", "consumed", "remaining"])
      ? {
          total: recallBudgetRecord(trace.budget.total, `${label}.trace.budget.total`),
          consumed: recallBudgetRecord(trace.budget.consumed, `${label}.trace.budget.consumed`),
          remaining: recallBudgetRecord(trace.budget.remaining, `${label}.trace.budget.remaining`),
        }
      : undefined;
  if (traceBudgets === undefined) return invalid(`${label}.trace.budget is malformed`);
  if (!traceBudgets.total.ok) return traceBudgets.total;
  if (!traceBudgets.consumed.ok) return traceBudgets.consumed;
  if (!traceBudgets.remaining.ok) return traceBudgets.remaining;
  const consumedBudget = recallBudgetRecord(trace.consumedBudget, `${label}.trace.consumedBudget`);
  if (!consumedBudget.ok) return consumedBudget;
  const remainingBudget = recallBudgetRecord(
    trace.remainingBudget,
    `${label}.trace.remainingBudget`,
  );
  if (!remainingBudget.ok) return remainingBudget;
  if (
    !recallBudgetsEqual(traceBudgets.consumed.value, consumedBudget.value) ||
    !recallBudgetsEqual(traceBudgets.remaining.value, remainingBudget.value) ||
    !recallBudgetArithmeticIsConsistent({
      total: traceBudgets.total.value,
      consumed: traceBudgets.consumed.value,
      remaining: traceBudgets.remaining.value,
    })
  )
    return invalid(`${label}.trace budget fields are inconsistent`);
  const { contentHash: traceHash, ...traceWithoutHash } = trace;
  if (sha256(stableStringify(traceWithoutHash)) !== traceHash)
    return invalid(`${label}.trace.contentHash does not match the durable trace`);
  const expectedContentHash = recallStabilityHash({
    answer: value.answer as string | undefined,
    evidence: value.evidence,
    insights: value.insights,
    procedures: value.procedures,
    contradictions: value.contradictions,
    unresolved: value.unresolved,
    confidence: value.confidence,
  });
  if (expectedContentHash !== value.contentHash)
    return invalid(`${label}.contentHash does not match the durable result`);
  return { ok: true, value: value as unknown as RecallResult };
}

type StoredRecallResult = {
  invocationId: string;
  invocationHash: string;
  result: RecallResult;
};

function validateStoredRecallEnvelopeIdentity(
  value: unknown,
  expected: Pick<RecallInvocationRecord, "invocationId" | "invocationHash">,
  context: RecallResultValidationContext = {},
): ContextSessionStoreResult<RecallResult> {
  if (
    !record(value) ||
    !hasExactKeys(value, ["invocationId", "invocationHash", "result"]) ||
    value.invocationId !== expected.invocationId ||
    value.invocationHash !== expected.invocationHash
  )
    return invalid("durable recall result invocation binding is invalid");
  return validateStoredRecallResult(value.result, "durable recall result", context);
}

function validateStoredRecallEnvelope(
  value: unknown,
  expected: RecallInvocationRecord,
  context: RecallResultValidationContext = {},
): ContextSessionStoreResult<RecallResult> {
  const result = validateStoredRecallEnvelopeIdentity(value, expected, context);
  if (!result.ok) return result;
  if (
    result.value.contentHash !== expected.contentHash ||
    result.value.trace.contentHash !== expected.traceHash
  )
    return invalid("durable recall result hashes do not match the committed invocation");
  return result;
}

export async function readUncommittedContextRecallResult(
  root: string,
  contextSessionId: string,
  invocationId: string,
  invocationHash: string,
  context: RecallResultValidationContext = {},
): Promise<ContextSessionStoreResult<RecallResult | null>> {
  if (typeof contextSessionId !== "string" || !HASH.test(contextSessionId))
    return invalid("contextSessionId must be a lowercase SHA-256");
  if (
    typeof invocationId !== "string" ||
    invocationId.trim().length === 0 ||
    invocationId.length > 256 ||
    typeof invocationHash !== "string" ||
    !HASH.test(invocationHash)
  )
    return invalid("recall invocation identity is malformed");
  try {
    const stored = JSON.parse(
      await readFile(recallResultPath(root, contextSessionId, invocationHash), "utf8"),
    ) as unknown;
    return validateStoredRecallEnvelopeIdentity(stored, { invocationId, invocationHash }, context);
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")
      return { ok: true, value: null };
    return storageError(
      error instanceof Error ? `durable recall result is unavailable: ${error.message}` : error,
    );
  }
}

export async function readContextRecallResult(
  root: string,
  contextSessionId: string,
  invocation: RecallInvocationRecord,
  context: RecallResultValidationContext = {},
): Promise<ContextSessionStoreResult<RecallResult>> {
  if (typeof contextSessionId !== "string" || !HASH.test(contextSessionId))
    return invalid("contextSessionId must be a lowercase SHA-256");
  if (
    !record(invocation) ||
    typeof invocation.invocationId !== "string" ||
    invocation.invocationId.trim().length === 0 ||
    invocation.invocationId.length > 256 ||
    typeof invocation.invocationHash !== "string" ||
    !HASH.test(invocation.invocationHash)
  )
    return invalid("recall invocation identity is malformed");
  try {
    const stored = JSON.parse(
      await readFile(recallResultPath(root, contextSessionId, invocation.invocationHash), "utf8"),
    ) as unknown;
    return validateStoredRecallEnvelope(stored, invocation, context);
  } catch (error) {
    return storageError(
      error instanceof Error ? `durable recall result is unavailable: ${error.message}` : error,
    );
  }
}

async function persistContextRecallResult(
  root: string,
  contextSessionId: string,
  invocationId: string,
  invocationHash: string,
  result: RecallResult,
): Promise<ContextSessionStoreResult<true>> {
  const validated = validateStoredRecallResult(result, "recall result");
  if (!validated.ok) return validated;
  const envelope: StoredRecallResult = { invocationId, invocationHash, result: validated.value };
  const path = recallResultPath(root, contextSessionId, invocationHash);
  try {
    const existing = JSON.parse(await readFile(path, "utf8")) as unknown;
    const checked = validateStoredRecallEnvelope(existing, {
      invocationId,
      invocationHash,
      contentHash: result.contentHash,
      traceHash: result.trace.contentHash,
    });
    if (!checked.ok) return checked;
    return stableStringify(existing) === stableStringify(envelope)
      ? { ok: true, value: true }
      : invalid("durable recall result already exists with different content");
  } catch (error) {
    if (
      typeof error !== "object" ||
      error === null ||
      !("code" in error) ||
      error.code !== "ENOENT"
    )
      return storageError(error);
  }
  try {
    await atomicPrivateJson(path, envelope);
    return { ok: true, value: true };
  } catch (error) {
    return storageError(error);
  }
}

export interface CommitContextRecallBudgetInput {
  readonly contextSessionId: string;
  readonly invocationId: string;
  readonly invocationHash: string;
  readonly expectedRemaining: ContextBudget;
  readonly consumed: ContextBudget;
  readonly committedAt: string;
  readonly eventBatchHashes: readonly string[];
  readonly result: RecallResult;
  readonly lifecycleTimestampFloor: string;
}

export interface CommitContextRecallBudgetResult {
  readonly session: ContextSession;
  readonly committed: boolean;
}

interface ValidatedRecallBudgetMutation {
  readonly invocationId: string;
  readonly invocationHash: string;
  readonly expected: ContextBudget;
  readonly consumed: ContextBudget;
  readonly eventBatchHashes: string[];
  readonly result: RecallResult;
  readonly lifecycleTimestampFloor: string;
}

function validateRecallBudgetMutation(
  input: CommitContextRecallBudgetInput,
): ContextSessionStoreResult<ValidatedRecallBudgetMutation> {
  if (!HASH.test(input.contextSessionId))
    return invalid("contextSessionId must be a lowercase SHA-256");
  if (
    typeof input.invocationId !== "string" ||
    input.invocationId.trim().length === 0 ||
    input.invocationId.length > 256
  )
    return invalid("invocationId must be non-empty text of at most 256 characters");
  if (!HASH.test(input.invocationHash))
    return invalid("invocationHash must be a lowercase SHA-256");
  if (!validTimestamp(input.committedAt)) return invalid("committedAt must be an ISO timestamp");
  const expected = normalizeBudget(input.expectedRemaining, "expectedRemaining");
  if (!expected.ok) return expected;
  const consumed = normalizeBudget(input.consumed, "consumed");
  if (
    !validTimestamp(input.lifecycleTimestampFloor) ||
    Date.parse(input.lifecycleTimestampFloor) > Date.parse(input.committedAt)
  )
    return invalid("lifecycleTimestampFloor must be an ISO timestamp at or before committedAt");
  if (!consumed.ok) return consumed;
  const result = validateStoredRecallResult(input.result, "recall result");
  if (!result.ok) return result;
  if (
    Array.isArray(input.eventBatchHashes) &&
    input.eventBatchHashes.length > MAX_STAGED_RECALL_EVENT_BATCHES
  )
    return invalid(
      `eventBatchHashes must contain at most ${MAX_STAGED_RECALL_EVENT_BATCHES} staged recall event batches`,
    );
  const eventBatchHashes = requiredHashArray(input.eventBatchHashes, "eventBatchHashes");
  if (!eventBatchHashes.ok) return eventBatchHashes;
  if (eventBatchHashes.value.length > MAX_STAGED_RECALL_EVENT_BATCHES)
    return invalid(
      `eventBatchHashes must contain at most ${MAX_STAGED_RECALL_EVENT_BATCHES} staged recall event batches`,
    );
  return {
    ok: true,
    value: {
      invocationId: input.invocationId,
      invocationHash: input.invocationHash,
      expected: expected.value,
      consumed: consumed.value,
      eventBatchHashes: eventBatchHashes.value,
      result: result.value,
      lifecycleTimestampFloor: input.lifecycleTimestampFloor,
    },
  };
}

export async function commitContextRecallBudget(
  root: string,
  input: CommitContextRecallBudgetInput,
): Promise<ContextSessionStoreResult<CommitContextRecallBudgetResult>> {
  const validated = validateRecallBudgetMutation(input);
  if (!validated.ok) return validated;
  const {
    invocationId,
    invocationHash,
    expected,
    consumed,
    eventBatchHashes,
    result,
    lifecycleTimestampFloor,
  } = validated.value;
  const recovered = await readContextSession(root, input.contextSessionId);
  if (!recovered.ok) return recovered;
  const validEvents = await validateStagedRecallEvents(
    root,
    eventBatchHashes,
    recovered.value,
    invocationId,
    invocationHash,
    consumed,
  );
  if (!validEvents.ok) return validEvents;
  const checkedResult = validateStoredRecallResult(result, "recall result", {
    scope: validEvents.value.scope,
    session: recovered.value,
  });
  if (!checkedResult.ok) return checkedResult;
  const lifecycle = validateRecallLifecycleResult(
    validEvents.value,
    checkedResult.value,
    recovered.value,
    invocationId,
    invocationHash,
    lifecycleTimestampFloor,
  );
  if (!lifecycle.ok) return lifecycle;

  return withIngestLock(root, async () => {
    let current: ContextSessionStoreResult<ContextSession>;
    try {
      current = parseStoredSession(
        JSON.parse(await readFile(sessionPath(root, input.contextSessionId), "utf8")),
      );
    } catch (error) {
      return storageError(error);
    }
    if (!current.ok) return current;
    const session = current.value;
    const priorInvocation = session.consumedRecallInvocations.find(
      (item) => item.invocationId === invocationId,
    );
    if (priorInvocation && priorInvocation.invocationHash !== invocationHash)
      return {
        ok: false,
        error: {
          code: "session-conflict",
          message: "recall invocationId was already used with a different request",
        },
      };
    if (priorInvocation !== undefined) {
      const durable = await readContextRecallResult(
        root,
        session.contextSessionId,
        priorInvocation,
        { scope: validEvents.value.scope, session },
      );
      if (!durable.ok) return durable;
      return { ok: true, value: { session, committed: false } };
    }
    if (session.consumedRecallInvocations.length >= MAX_CONTEXT_RECALL_INVOCATIONS)
      return invalid(
        `context session recall invocations are limited to ${MAX_CONTEXT_RECALL_INVOCATIONS}`,
      );
    for (const key of Object.keys(expected) as Array<keyof ContextBudget>) {
      if (session.budget.remaining[key] !== expected[key])
        return {
          ok: false,
          error: {
            code: "session-conflict",
            message: "recall was evaluated against a stale context session budget",
          },
        };
      if (consumed[key] > session.budget.remaining[key])
        return {
          ok: false,
          error: {
            code: "session-conflict",
            message: `recall consumed more ${key} than the context session had remaining`,
          },
        };
    }
    const pendingEventBatchHashes = [
      ...new Set([...session.pendingEventBatchHashes, ...eventBatchHashes]),
    ];
    if (pendingEventBatchHashes.length > MAX_STAGED_RECALL_EVENT_BATCHES)
      return invalid(
        `pendingEventBatchHashes must contain at most ${MAX_STAGED_RECALL_EVENT_BATCHES} hashes`,
      );
    const persisted = await persistContextRecallResult(
      root,
      session.contextSessionId,
      invocationId,
      invocationHash,
      result,
    );
    if (!persisted.ok) return persisted;
    const remaining: ContextBudget = {
      tokens: session.budget.remaining.tokens - consumed.tokens,
      results: session.budget.remaining.results - consumed.results,
      latencyMs: session.budget.remaining.latencyMs - consumed.latencyMs,
      costUsd: session.budget.remaining.costUsd - consumed.costUsd,
    };
    const updated: ContextSession = {
      ...session,
      budget: { total: { ...session.budget.total }, remaining },
      consumedRecallHashes: [...session.consumedRecallHashes, invocationHash],
      consumedRecallInvocations: [
        ...session.consumedRecallInvocations,
        {
          invocationId,
          invocationHash,
          contentHash: validEvents.value.contentHash,
          traceHash: validEvents.value.traceHash,
          lifecycleTimestampFloor,
        },
      ],
      pendingEventBatchHashes,
      updatedAt: input.committedAt,
    };
    try {
      await atomicPrivateJson(sessionPath(root, session.contextSessionId), updated);
      return { ok: true, value: { session: updated, committed: true } };
    } catch (error) {
      return storageError(error);
    }
  });
}

export async function clearContextEventOutbox(
  root: string,
  contextSessionId: string,
  eventBatchHashes: readonly string[],
): Promise<ContextSessionStoreResult<ContextSession>> {
  if (!HASH.test(contextSessionId)) return invalid("contextSessionId must be a lowercase SHA-256");
  const clearedHashes = requiredHashArray(eventBatchHashes, "eventBatchHashes");
  if (!clearedHashes.ok) return clearedHashes;
  const cleared = new Set(clearedHashes.value);
  return withIngestLock(root, async () => {
    let current: ContextSessionStoreResult<ContextSession>;
    try {
      current = parseStoredSession(
        JSON.parse(await readFile(sessionPath(root, contextSessionId), "utf8")),
      );
    } catch (error) {
      return storageError(error);
    }
    if (!current.ok) return current;
    const session = current.value;
    const pendingEventBatchHashes = session.pendingEventBatchHashes.filter(
      (hash) => !cleared.has(hash),
    );
    if (pendingEventBatchHashes.length === session.pendingEventBatchHashes.length) return current;
    const updated: ContextSession = { ...session, pendingEventBatchHashes };
    try {
      await atomicPrivateJson(sessionPath(root, contextSessionId), updated);
      return { ok: true, value: updated };
    } catch (error) {
      return storageError(error);
    }
  });
}

export interface BoundedContextSessionList {
  readonly sessions: ContextSession[];
  readonly total: number;
}

function compareContextSessions(left: ContextSession, right: ContextSession): number {
  return (
    Date.parse(right.createdAt) - Date.parse(left.createdAt) ||
    left.contextSessionId.localeCompare(right.contextSessionId)
  );
}

export async function listContextSessionsBounded(
  root: string,
  limit: number,
): Promise<ContextSessionStoreResult<BoundedContextSessionList>> {
  if (!Number.isSafeInteger(limit) || limit < 1)
    return invalid("context session list limit must be a positive finite integer");
  const directoryPath = join(resolve(root), "memory", "context-sessions");
  let directory;
  try {
    directory = await opendir(directoryPath);
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")
      return { ok: true, value: { sessions: [], total: 0 } };
    return storageError(error);
  }
  const sessions: ContextSession[] = [];
  let total = 0;
  for await (const entry of directory) {
    const name = entry.name;
    if (!name.endsWith(".json")) continue;
    let parsed: ContextSessionStoreResult<ContextSession>;
    try {
      parsed = parseStoredSession(JSON.parse(await readFile(join(directoryPath, name), "utf8")));
    } catch (error) {
      return storageError(error);
    }
    if (!parsed.ok) return parsed;
    total += 1;
    const insertAt = sessions.findIndex(
      (session) => compareContextSessions(parsed.value, session) < 0,
    );
    if (insertAt === -1) {
      if (sessions.length < limit) sessions.push(parsed.value);
      continue;
    }
    sessions.splice(insertAt, 0, parsed.value);
    if (sessions.length > limit) sessions.pop();
  }
  return { ok: true, value: { sessions, total } };
}

export async function listContextSessions(
  root: string,
): Promise<ContextSessionStoreResult<ContextSession[]>> {
  const directory = join(resolve(root), "memory", "context-sessions");
  let names: string[];
  try {
    names = await readdir(directory);
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")
      return { ok: true, value: [] };
    return storageError(error);
  }
  const sessions: ContextSession[] = [];
  for (const name of names.toSorted()) {
    if (!name.endsWith(".json")) continue;
    try {
      const parsed = parseStoredSession(JSON.parse(await readFile(join(directory, name), "utf8")));
      if (!parsed.ok) return parsed;
      sessions.push(parsed.value);
    } catch (error) {
      return storageError(error);
    }
  }
  return {
    ok: true,
    value: sessions.toSorted(
      (left, right) =>
        Date.parse(right.createdAt) - Date.parse(left.createdAt) ||
        left.contextSessionId.localeCompare(right.contextSessionId),
    ),
  };
}
