import { randomUUID } from "node:crypto";
import { Effect } from "effect";
import type { ContextSession } from "./context-types";
import { publishContextEventBatches } from "./context-event-outbox";
import {
  MAX_CONTEXT_EVENT_HASHES,
  stageContextEvents,
  type ContextEventInput,
} from "./context-events";
import {
  clearContextEventOutbox,
  commitContextRecallBudget,
  MAX_CONTEXT_RECALL_INVOCATIONS,
  MAX_STAGED_RECALL_EVENT_BATCHES,
  readContextRecallResult,
  readUncommittedContextRecallResult,
  readContextSession,
} from "./context-session";
import { sha256, stableStringify, type EventActor, type EventScope } from "./events";
import { withContextFinalizationLock } from "./lock";
import {
  createRecallRuntime,
  normalizeRecallQuery,
  RecallError,
  validateBoundedRecord,
  validateRecallRequest,
  MAX_RECALL_ADAPTERS,
  MAX_RECALL_TEXT_LENGTH,
  type RecallBranchStatus,
  type RecallRequest,
  type RecallResult,
  type RecallRuntime,
  type RecallRuntimeOptions,
} from "./recall-runtime";
import { recallPathWithin, type RecallScope } from "./recall-budget";

const HASH = /^[a-f0-9]{64}$/u;
type RecallEventResult<T> = { readonly ok: true; readonly value: T } | RecallEventFailure;
type RecallEventFailure = { readonly ok: false; readonly error: RecallError };

function recallSuccess<T>(value: T): RecallEventResult<T> {
  return { ok: true, value };
}

function recallFailure(error: RecallError): RecallEventFailure {
  return { ok: false, error };
}

function assertSessionBinding(
  session: ContextSession,
  request: RecallRequest,
  enforceBudget = true,
): RecallEventResult<void> {
  const scope = request.scope;
  if (scope.project !== session.projectIdentity)
    return recallFailure(
      new RecallError("scope-denied", "recall project does not match the parent context session"),
    );
  // Context sessions pin the project/repository identity together. A null or
  // alternate repository would allow a caller to cross the evidence boundary.
  if (scope.repository !== session.projectIdentity)
    return recallFailure(
      new RecallError(
        "scope-denied",
        "recall repository does not match the parent context session",
      ),
    );
  if (scope.user !== null)
    return recallFailure(
      new RecallError("scope-denied", "recall user must use the neutral null scope"),
    );
  if (scope.organization !== null)
    return recallFailure(
      new RecallError("scope-denied", "recall organization must use the neutral null scope"),
    );
  if (scope.tool !== null)
    return recallFailure(
      new RecallError("scope-denied", "recall tool must use the neutral null scope"),
    );
  if (
    !Array.isArray(scope.itemPermissions) ||
    scope.itemPermissions.some((permission) => typeof permission !== "string") ||
    scope.itemPermissions.length > 0
  )
    return recallFailure(
      new RecallError("scope-denied", "recall itemPermissions must use the neutral empty scope"),
    );
  if (scope.provider !== session.target.provider)
    return recallFailure(
      new RecallError("scope-denied", "recall provider does not match the parent context session"),
    );
  if (scope.harness !== session.target.harness)
    return recallFailure(
      new RecallError("scope-denied", "recall harness does not match the parent context session"),
    );
  if (scope.model !== session.target.model)
    return recallFailure(
      new RecallError("scope-denied", "recall model does not match the parent context session"),
    );
  if (typeof scope.domain !== "string" || !session.domainPolicy.includes(scope.domain))
    return recallFailure(
      new RecallError("scope-denied", "recall domain is outside the parent context session policy"),
    );
  if (
    session.path === null
      ? scope.path !== null && scope.path !== undefined
      : typeof scope.path !== "string" || !recallPathWithin(session.path, scope.path)
  )
    return recallFailure(
      new RecallError("scope-denied", "recall path is outside the parent context session scope"),
    );

  if (!enforceBudget) return recallSuccess(undefined);
  const remaining = session.budget.remaining;
  if (request.budget.maxResults > remaining.results)
    return recallFailure(
      new RecallError("scope-denied", "recall results exceed the parent context session budget"),
    );
  if (request.budget.maxTokens > remaining.tokens)
    return recallFailure(
      new RecallError("scope-denied", "recall tokens exceed the parent context session budget"),
    );
  if (request.budget.maxLatencyMs > remaining.latencyMs)
    return recallFailure(
      new RecallError("scope-denied", "recall latency exceeds the parent context session budget"),
    );
  if (request.budget.maxCostUsd > remaining.costUsd)
    return recallFailure(
      new RecallError("scope-denied", "recall cost exceeds the parent context session budget"),
    );
  return recallSuccess(undefined);
}

function effectiveRecallScope(
  session: ContextSession,
  request: RecallRequest,
  enforceBudget = true,
): RecallEventResult<RecallRequest["scope"]> {
  if (request === null || typeof request !== "object")
    return recallFailure(new RecallError("invalid-request", "recall request must be an object"));
  if (typeof request.contextSessionId !== "string" || !HASH.test(request.contextSessionId))
    return recallFailure(
      new RecallError(
        "invalid-request",
        "contextSessionId must identify one parent context session",
      ),
    );
  if (request.scope === null || typeof request.scope !== "object")
    return recallFailure(new RecallError("invalid-request", "recall scope must be an object"));
  const scope = request.scope;
  const domain =
    scope.domain === undefined
      ? session.domainPolicy.length === 1
        ? session.domainPolicy[0]
        : undefined
      : scope.domain;
  const effective = {
    ...scope,
    user: scope.user === undefined ? null : scope.user,
    organization: scope.organization === undefined ? null : scope.organization,
    tool: scope.tool === undefined ? null : scope.tool,
    itemPermissions: scope.itemPermissions === undefined ? [] : scope.itemPermissions,
    project: scope.project === undefined ? session.projectIdentity : scope.project,
    repository: scope.repository === undefined ? session.projectIdentity : scope.repository,
    provider: scope.provider === undefined ? session.target.provider : scope.provider,
    harness: scope.harness === undefined ? session.target.harness : scope.harness,
    model: scope.model === undefined ? session.target.model : scope.model,
    domain,
    path: scope.path === undefined ? session.path : scope.path,
  };
  const binding = assertSessionBinding(session, { ...request, scope: effective }, enforceBudget);
  if (!binding.ok) return binding;
  return recallSuccess(effective);
}

interface PreparedRecall {
  readonly session: ContextSession;
  readonly request: RecallRequest;
}

async function parentSession(
  root: string,
  request: RecallRequest,
  enforceBudget = true,
): Promise<RecallEventResult<PreparedRecall>> {
  if (request === null || typeof request !== "object")
    return recallFailure(new RecallError("invalid-request", "recall request must be an object"));
  if (typeof request.contextSessionId !== "string" || !HASH.test(request.contextSessionId))
    return recallFailure(
      new RecallError(
        "invalid-request",
        "contextSessionId must identify one parent context session",
      ),
    );
  const loaded = await readContextSession(root, request.contextSessionId);
  if (!loaded.ok)
    return recallFailure(
      new RecallError(
        "persistence-error",
        `parent context session is unavailable: ${loaded.error.message}`,
        { phase: "parent-read" },
      ),
    );
  const scope = effectiveRecallScope(loaded.value, request, enforceBudget);
  if (!scope.ok) return scope;
  return recallSuccess({
    session: loaded.value,
    request: { ...request, scope: scope.value },
  });
}

export interface RecordedRecallFinalizeContext {
  readonly session: ContextSession;
  readonly request: RecallRequest;
  readonly result: RecallResult;
}

export interface RecordedRecallRuntimeOptions extends RecallRuntimeOptions {
  readonly actor?: EventActor;
  readonly beforeFinalize?: (
    context: RecordedRecallFinalizeContext,
  ) => void | RecallError | Promise<void | RecallError>;
}

function invocationAdapters(
  request: RecallRequest,
  options: RecallRuntimeOptions,
): RecallEventResult<readonly Record<string, string | number>[]> {
  const configured = request.adapters ?? options.adapters ?? options.branches ?? [];
  if (!Array.isArray(configured) || configured.length > MAX_RECALL_ADAPTERS)
    return recallFailure(
      new RecallError(
        "invalid-request",
        `recall adapters must contain at most ${MAX_RECALL_ADAPTERS} entries`,
      ),
    );
  const adapters: Record<string, string | number>[] = [];
  for (const [index, adapter] of configured.entries()) {
    if (typeof adapter === "function") {
      const implementation = String(adapter);
      if (implementation.length > MAX_RECALL_TEXT_LENGTH)
        return recallFailure(
          new RecallError(
            "invalid-request",
            `recall adapter ${index + 1} implementation exceeds ${MAX_RECALL_TEXT_LENGTH} characters`,
          ),
        );
      adapters.push({
        index,
        id: adapter.name.trim() || `branch-${index + 1}`,
        implementationHash: sha256(implementation),
      });
      continue;
    }
    const implementation = String(adapter.run);
    if (implementation.length > MAX_RECALL_TEXT_LENGTH)
      return recallFailure(
        new RecallError(
          "invalid-request",
          `recall adapter ${index + 1} implementation exceeds ${MAX_RECALL_TEXT_LENGTH} characters`,
        ),
      );
    adapters.push({
      index,
      id: adapter.id,
      implementationHash: sha256(implementation),
    });
  }
  return recallSuccess(adapters);
}

function recallInvocationHash(
  session: ContextSession,
  request: RecallRequest,
  options: RecallRuntimeOptions,
): RecallEventResult<string> {
  const requestForValidation =
    request.adapters === undefined
      ? { ...request, adapters: options.adapters ?? options.branches }
      : request;
  const requestError = validateRecallRequest(requestForValidation as RecallRequest);
  if (requestError !== undefined) return recallFailure(requestError);
  if (typeof request.invocationId !== "string" || request.invocationId.trim().length === 0)
    return recallFailure(new RecallError("invalid-request", "recall invocationId is missing"));
  const adapters = invocationAdapters(request, options);
  if (!adapters.ok) return adapters;
  return recallSuccess(
    sha256(
      stableStringify({
        schemaVersion: "chatlog-recall-invocation-v1",
        contextSessionId: session.contextSessionId,
        invocationId: request.invocationId,
        query: normalizeRecallQuery(request.query),
        scope: request.scope,
        budget: request.budget,
        visitedEvidenceIds: [...(request.visitedEvidenceIds ?? [])].toSorted(),
        visitedInsightRevisions: [...(request.visitedInsightRevisions ?? [])].toSorted(),
        queryAncestry: [...(request.queryAncestry ?? [])].map(normalizeRecallQuery).toSorted(),
        priorConsolidationHashes: [...(request.priorConsolidationHashes ?? [])].toSorted(),
        previousResultHash: request.previousResultHash ?? null,
        previousUnresolved: [...(request.previousUnresolved ?? [])].toSorted(),
        minimumEvidence: request.minimumEvidence ?? null,
        maxRounds: request.maxRounds ?? null,
        adapters: adapters.value,
      }),
    ),
  );
}

function eventScope(session: ContextSession, branchId?: string): EventScope {
  return {
    sessionId: session.contextSessionId,
    project: session.projectIdentity,
    cwd: session.cwd,
    ...(branchId === undefined ? {} : { branchId }),
  };
}

function instant(value: number | undefined, fallback: string): string {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  const candidate = new Date(value).toISOString();
  return Date.parse(candidate) < Date.parse(fallback) ? fallback : candidate;
}

function recallCompletedAt(result: RecallResult, fallback: string): string {
  const branchTimes = result.trace.branches.flatMap((branch) =>
    branch.finishedAt === undefined ? [] : [branch.finishedAt],
  );
  return instant(branchTimes.length === 0 ? undefined : Math.max(...branchTimes), fallback);
}

function sessionTimestamp(session: ContextSession): string {
  return Date.parse(session.createdAt) > Date.parse(session.updatedAt)
    ? session.createdAt
    : session.updatedAt;
}

function resultInputHashes(result: RecallResult): string[] {
  const values: string[] = [];
  const seen = new Set<string>();
  const add = (value: unknown): void => {
    if (
      values.length >= MAX_CONTEXT_EVENT_HASHES ||
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

function procedureIdentity(item: RecallResult["procedures"][number]): string {
  return item.procedureId ?? item.id;
}

function resultItemIds(result: RecallResult): string[] {
  const values: string[] = [];
  for (const item of result.evidence) {
    if (values.length >= MAX_CONTEXT_EVENT_HASHES) break;
    values.push(item.id);
  }
  for (const item of result.insights) {
    if (values.length >= MAX_CONTEXT_EVENT_HASHES) break;
    values.push(item.revisionId ?? item.id);
  }
  for (const item of result.procedures) {
    if (values.length >= MAX_CONTEXT_EVENT_HASHES) break;
    values.push(procedureIdentity(item));
  }
  return values;
}

function recallResultEventError(result: RecallResult): string | undefined {
  const bounded = validateBoundedRecord(result, "recall result");
  if (!bounded.ok) return bounded.error;
  let references = 0;
  for (const item of result.evidence) {
    if (item.reference !== undefined) references += 1;
    if (item.references !== undefined) references += item.references.length;
  }
  if (references > MAX_CONTEXT_EVENT_HASHES)
    return `recall result references exceed ${MAX_CONTEXT_EVENT_HASHES} items`;
  return undefined;
}
function procedureProvenance(item: RecallResult["procedures"][number]): Record<string, unknown> {
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

function branchEndKind(status: RecallBranchStatus): ContextEventInput["kind"] {
  if (status === "succeeded") return "context.recall.branch.completed";
  if (status === "cancelled") return "context.recall.branch.cancelled";
  return "context.recall.branch.failed";
}

function recallEventInputs(
  session: ContextSession,
  result: RecallResult,
  actor: EventActor,
  invocationId: string,
  invocationHash: string,
): ContextEventInput[] {
  const executionId = invocationHash;
  const timestampFloor = sessionTimestamp(session);
  const base = {
    contextSessionId: session.contextSessionId,
    actor,
    actorAuthority: "system" as const,
    contentHash: result.contentHash,
  };
  const invocation = {
    invocationId,
    invocationHash,
    scope: result.trace.scope,
    scopeHash: result.trace.scopeHash,
  };
  const inputs: ContextEventInput[] = [];

  for (const branch of result.trace.branches) {
    const branchIdentity = sha256(
      stableStringify({ branchId: branch.branchId, query: branch.query, depth: branch.depth }),
    );
    const startedAt = instant(branch.startedAt, timestampFloor);
    inputs.push(
      {
        ...base,
        kind: "context.recall.branch.started",
        idempotencyKey: `recall:${executionId}:started:${branchIdentity}`,
        scope: eventScope(session, branch.branchId),
        occurredAt: startedAt,
        bounds: { ...branch.budget },
        payload: {
          ...invocation,
          branchId: branch.branchId,
          query: branch.query,
          depth: branch.depth,
          deadlineAt: instant(branch.deadlineAt, startedAt),
          traceHash: result.trace.contentHash,
        },
      },
      {
        ...base,
        kind: branchEndKind(branch.status),
        idempotencyKey: `recall:${executionId}:${branch.status}:${branchIdentity}`,
        scope: eventScope(session, branch.branchId),
        occurredAt: instant(branch.finishedAt, startedAt),
        bounds: { ...branch.budget },
        payload: {
          ...invocation,
          branchId: branch.branchId,
          query: branch.query,
          depth: branch.depth,
          status: branch.status,
          traceHash: result.trace.contentHash,
          ...(branch.failure === undefined
            ? {}
            : {
                failure: {
                  code: branch.failure.code,
                  message: branch.failure.message.slice(0, 500),
                },
              }),
        },
      },
    );
  }

  const completedAt = recallCompletedAt(result, timestampFloor);
  const itemIds = resultItemIds(result);
  const inputHashes = resultInputHashes(result);
  inputs.push(
    {
      ...base,
      kind: "context.recall.terminated",
      idempotencyKey: `recall:${executionId}:terminated`,
      scope: eventScope(session),
      occurredAt: completedAt,
      inputHashes,
      bounds: result.trace.budget,
      payload: {
        ...invocation,
        contentHash: result.contentHash,
        traceHash: result.trace.contentHash,
        terminationReason: result.trace.terminationReason,
        cancellation: result.trace.cancellation,
        novelty: result.trace.novelty,
        stability: result.trace.stability,
      },
    },
    {
      ...base,
      kind: "context.recall.returned",
      idempotencyKey: `recall:${executionId}:returned`,
      scope: eventScope(session),
      occurredAt: completedAt,
      ...(itemIds.length === 1 ? { itemId: itemIds[0] } : {}),
      inputHashes,
      bounds: result.trace.budget,
      provenance: {
        evidenceReferences: result.evidence.flatMap((item) => [
          ...(item.reference === undefined ? [] : [item.reference]),
          ...(item.references ?? []),
        ]),
        insightRevisions: result.insights.map((item) => item.revisionId ?? item.id),
        procedures: result.procedures.map(procedureProvenance),
      },
      payload: {
        ...invocation,
        contentHash: result.contentHash,
        traceHash: result.trace.contentHash,
        terminationReason: result.trace.terminationReason,
        evidenceIds: result.evidence.map((item) => item.id),
        insightRevisions: result.insights.map((item) => item.revisionId ?? item.id),
        procedureIds: result.procedures.map((item) => procedureIdentity(item)),
        contradictionIds: result.contradictions.map((item) => item.id),
        unresolved: result.unresolved,
        disagreements: result.trace.disagreements,
        omissions: result.trace.omissions,
      },
    },
  );
  return inputs;
}

function retryableRecallError(
  code: "persistence-error" | "finalization-error",
  phase: "stage" | "lock" | "debit" | "publish" | "outbox-clear" | "storage",
  message: string,
  cause?: unknown,
): RecallError {
  if (cause instanceof RecallError) return cause;
  return new RecallError(code, message, { phase, cause });
}

async function finalizeRecall(
  root: string,
  session: ContextSession,
  result: RecallResult,
  actor: EventActor,
  invocationId: string,
  invocationHash: string,
  requestScope: RecallScope,
): Promise<RecallEventResult<RecallResult>> {
  const resultValidationError = recallResultEventError(result);
  if (resultValidationError !== undefined)
    return recallFailure(
      retryableRecallError(
        "persistence-error",
        "stage",
        `recall result is not safely bounded: ${resultValidationError}`,
      ),
    );
  if (result.trace.branches.length > Math.floor((MAX_STAGED_RECALL_EVENT_BATCHES - 2) / 2))
    return recallFailure(
      retryableRecallError(
        "persistence-error",
        "stage",
        `recall persistence failed: at most ${MAX_STAGED_RECALL_EVENT_BATCHES} lifecycle batches may be staged`,
      ),
    );
  let inputs: ContextEventInput[];
  try {
    inputs = recallEventInputs(session, result, actor, invocationId, invocationHash);
  } catch (error) {
    return recallFailure(
      retryableRecallError(
        "persistence-error",
        "stage",
        `recall persistence failed: ${error instanceof Error ? error.message : String(error)}`,
        error,
      ),
    );
  }
  if (inputs.length > MAX_STAGED_RECALL_EVENT_BATCHES)
    return recallFailure(
      retryableRecallError(
        "persistence-error",
        "stage",
        `recall persistence failed: at most ${MAX_STAGED_RECALL_EVENT_BATCHES} lifecycle batches may be staged`,
      ),
    );
  const consumed = {
    tokens: result.trace.budget.consumed.maxTokens,
    results: result.trace.budget.consumed.maxResults,
    latencyMs: result.trace.budget.consumed.maxLatencyMs,
    costUsd: result.trace.budget.consumed.maxCostUsd,
  };
  try {
    return await withContextFinalizationLock(
      root,
      async (): Promise<RecallEventResult<RecallResult>> => {
        let recovered;
        try {
          recovered = await readContextSession(root, session.contextSessionId);
        } catch (error) {
          return recallFailure(
            retryableRecallError(
              "finalization-error",
              "debit",
              `recall budget debit failed: ${error instanceof Error ? error.message : String(error)}`,
              error,
            ),
          );
        }
        if (!recovered.ok)
          return recallFailure(
            retryableRecallError(
              "finalization-error",
              "debit",
              `recall budget debit failed: ${recovered.error.message}`,
            ),
          );
        const current = recovered.value;
        const priorInvocation = current.consumedRecallInvocations.find(
          (item) => item.invocationId === invocationId,
        );
        if (priorInvocation && priorInvocation.invocationHash !== invocationHash)
          return recallFailure(
            retryableRecallError(
              "finalization-error",
              "debit",
              "recall budget debit failed: recall invocationId was already used with a different request",
            ),
          );
        const alreadyConsumed = priorInvocation !== undefined;
        const clearPublishedPending = async (
          hashes: readonly string[],
        ): Promise<RecallEventResult<void>> => {
          if (hashes.length === 0) return recallSuccess(undefined);
          let cleared;
          try {
            cleared = await clearContextEventOutbox(root, session.contextSessionId, hashes);
          } catch (error) {
            return recallFailure(
              retryableRecallError(
                "finalization-error",
                "outbox-clear",
                `recall event outbox clear failed: ${
                  error instanceof Error ? error.message : String(error)
                }`,
                error,
              ),
            );
          }
          if (!cleared.ok)
            return recallFailure(
              retryableRecallError(
                "finalization-error",
                "outbox-clear",
                `recall event outbox clear failed: ${cleared.error.message}`,
              ),
            );
          return recallSuccess(undefined);
        };
        if (alreadyConsumed) {
          const replay = await readContextRecallResult(
            root,
            current.contextSessionId,
            priorInvocation,
            { scope: requestScope, session },
          );
          if (!replay.ok)
            return recallFailure(
              retryableRecallError(
                "finalization-error",
                "storage",
                `durable recall result is unavailable: ${replay.error.message}`,
              ),
            );
          return recallSuccess(replay.value);
        }
        if (current.consumedRecallInvocations.length >= MAX_CONTEXT_RECALL_INVOCATIONS)
          return recallFailure(
            retryableRecallError(
              "finalization-error",
              "debit",
              `recall budget debit failed: context session recall invocations are limited to ${MAX_CONTEXT_RECALL_INVOCATIONS}`,
            ),
          );
        for (const key of ["tokens", "results", "latencyMs", "costUsd"] as const) {
          if (current.budget.remaining[key] !== session.budget.remaining[key])
            return recallFailure(
              retryableRecallError(
                "finalization-error",
                "debit",
                "recall budget debit failed: recall was evaluated against a stale context session budget",
              ),
            );
          if (consumed[key] > current.budget.remaining[key])
            return recallFailure(
              retryableRecallError(
                "finalization-error",
                "debit",
                `recall budget debit failed: recall consumed more ${key} than the context session had remaining`,
              ),
            );
        }
        if (
          current.pendingEventBatchHashes.length + inputs.length >
          MAX_STAGED_RECALL_EVENT_BATCHES
        )
          return recallFailure(
            retryableRecallError(
              "persistence-error",
              "stage",
              `recall persistence failed: pending and staged lifecycle batches may total at most ${MAX_STAGED_RECALL_EVENT_BATCHES}`,
            ),
          );

        let staged;
        try {
          staged = await stageContextEvents(root, inputs);
        } catch (error) {
          return recallFailure(
            retryableRecallError(
              "persistence-error",
              "stage",
              `recall persistence failed: ${error instanceof Error ? error.message : String(error)}`,
              error,
            ),
          );
        }
        if (!staged.ok)
          return recallFailure(
            retryableRecallError(
              "persistence-error",
              "stage",
              `recall persistence failed: ${staged.error.message}`,
            ),
          );
        const batchHashes = staged.value.map((record) => record.batchHash);
        const committedAt = recallCompletedAt(result, sessionTimestamp(session));
        let committed;
        try {
          committed = await commitContextRecallBudget(root, {
            contextSessionId: session.contextSessionId,
            invocationId,
            invocationHash,
            expectedRemaining: session.budget.remaining,
            consumed,
            committedAt,
            lifecycleTimestampFloor: sessionTimestamp(session),
            eventBatchHashes: batchHashes,
            result,
          });
        } catch (error) {
          return recallFailure(
            retryableRecallError(
              "finalization-error",
              "debit",
              `recall budget debit failed: ${error instanceof Error ? error.message : String(error)}`,
              error,
            ),
          );
        }
        if (!committed.ok)
          return recallFailure(
            retryableRecallError(
              "finalization-error",
              "debit",
              `recall budget debit failed: ${committed.error.message}`,
            ),
          );
        if (!committed.value.committed) return recallSuccess(result);

        try {
          await publishContextEventBatches(root, batchHashes);
        } catch (error) {
          return recallFailure(
            retryableRecallError(
              "finalization-error",
              "publish",
              `recall event publication failed: ${
                error instanceof Error ? error.message : String(error)
              }`,
              error,
            ),
          );
        }
        const cleared = await clearPublishedPending(batchHashes);
        if (!cleared.ok) return recallFailure(cleared.error);
        return recallSuccess(result);
      },
    );
  } catch (error) {
    if (error instanceof RecallError) return recallFailure(error);
    return recallFailure(
      retryableRecallError(
        "finalization-error",
        "lock",
        `recall finalization failed: ${error instanceof Error ? error.message : String(error)}`,
        error,
      ),
    );
  }
}
export function createRecordedRecallRuntime(
  root: string,
  options: RecordedRecallRuntimeOptions = {},
): RecallRuntime {
  const {
    actor = { kind: "system", id: "chatlog-recall-runtime" },
    beforeFinalize,
    ...runtimeOptions
  } = options;
  const runtime = createRecallRuntime(runtimeOptions);
  return {
    recall(request) {
      const requestError = validateRecallRequest(request);
      if (requestError !== undefined) return Effect.fail(requestError);
      const requestWithInvocation =
        request.invocationId === undefined ? { ...request, invocationId: randomUUID() } : request;
      const prepared = Effect.tryPromise({
        try: () => parentSession(root, requestWithInvocation, false),
        catch: (error) =>
          error instanceof RecallError
            ? error
            : new RecallError(
                "persistence-error",
                `parent context session read failed: ${
                  error instanceof Error ? error.message : String(error)
                }`,
                { phase: "parent-read", cause: error },
              ),
      });
      return prepared.pipe(
        Effect.flatMap((preparedResult) => {
          if (!preparedResult.ok) return Effect.fail(preparedResult.error);
          const { session, request: preparedRequest } = preparedResult.value;
          if (typeof preparedRequest.invocationId !== "string")
            return Effect.fail(
              new RecallError("invalid-request", "recall invocationId is missing"),
            );
          const invocationId = preparedRequest.invocationId;
          const invocationHashResult = recallInvocationHash(
            session,
            preparedRequest,
            runtimeOptions,
          );
          if (!invocationHashResult.ok) return Effect.fail(invocationHashResult.error);
          const invocationHash = invocationHashResult.value;
          const priorInvocation = session.consumedRecallInvocations.find(
            (item) => item.invocationId === invocationId,
          );
          if (priorInvocation !== undefined) {
            if (priorInvocation.invocationHash !== invocationHash)
              return Effect.fail(
                new RecallError(
                  "finalization-error",
                  "recall invocationId was already used with a different request",
                  { phase: "debit" },
                ),
              );
            return Effect.tryPromise({
              try: () =>
                readContextRecallResult(root, session.contextSessionId, priorInvocation, {
                  scope: preparedRequest.scope,
                  session,
                }),
              catch: (error) =>
                new RecallError(
                  "finalization-error",
                  `durable recall result is unavailable: ${
                    error instanceof Error ? error.message : String(error)
                  }`,
                  { phase: "storage", cause: error },
                ),
            }).pipe(
              Effect.flatMap((replay) =>
                replay.ok
                  ? Effect.succeed(replay.value)
                  : Effect.fail(
                      new RecallError(
                        "finalization-error",
                        `durable recall result is unavailable: ${replay.error.message}`,
                        { phase: "storage" },
                      ),
                    ),
              ),
            );
          }
          const admission = assertSessionBinding(session, preparedRequest);
          if (!admission.ok) return Effect.fail(admission.error);
          if (session.consumedRecallInvocations.length >= MAX_CONTEXT_RECALL_INVOCATIONS)
            return Effect.fail(
              new RecallError(
                "invalid-request",
                `context session recall invocations are limited to ${MAX_CONTEXT_RECALL_INVOCATIONS}`,
              ),
            );
          const finalizeRecorded = (recallResult: RecallResult) => {
            const guarded =
              beforeFinalize === undefined
                ? Effect.succeed(recallResult)
                : Effect.tryPromise({
                    try: async () => {
                      const guard = await beforeFinalize({
                        session,
                        request: preparedRequest,
                        result: recallResult,
                      });
                      if (guard instanceof RecallError) throw guard;
                      return recallResult;
                    },
                    catch: (error) =>
                      error instanceof RecallError
                        ? error
                        : new RecallError(
                            "finalization-error",
                            `recall pre-finalization guard failed: ${
                              error instanceof Error ? error.message : String(error)
                            }`,
                            { phase: "debit", cause: error },
                          ),
                  });
            return guarded.pipe(
              Effect.flatMap((guardedResult) =>
                Effect.tryPromise({
                  try: () =>
                    finalizeRecall(
                      root,
                      session,
                      guardedResult,
                      actor,
                      invocationId,
                      invocationHash,
                      preparedRequest.scope,
                    ),
                  catch: (error) =>
                    error instanceof RecallError
                      ? error
                      : new RecallError(
                          "finalization-error",
                          `recall finalization failed: ${
                            error instanceof Error ? error.message : String(error)
                          }`,
                          { phase: "storage", cause: error },
                        ),
                }).pipe(
                  Effect.flatMap((finalized) =>
                    finalized.ok ? Effect.succeed(finalized.value) : Effect.fail(finalized.error),
                  ),
                ),
              ),
            );
          };
          return Effect.tryPromise({
            try: () =>
              readUncommittedContextRecallResult(
                root,
                session.contextSessionId,
                invocationId,
                invocationHash,
                { scope: preparedRequest.scope, session },
              ),
            catch: (error) =>
              new RecallError(
                "finalization-error",
                `durable uncommitted recall result read failed: ${
                  error instanceof Error ? error.message : String(error)
                }`,
                { phase: "storage", cause: error },
              ),
          }).pipe(
            Effect.flatMap((recovered) => {
              if (!recovered.ok)
                return Effect.fail(
                  new RecallError(
                    "finalization-error",
                    `durable uncommitted recall result is invalid: ${recovered.error.message}`,
                    { phase: "storage" },
                  ),
                );
              if (recovered.value !== null) return finalizeRecorded(recovered.value);
              return runtime.recall(preparedRequest).pipe(Effect.flatMap(finalizeRecorded));
            }),
          );
        }),
      );
    },
  };
}

/** Promise adapter for callers that do not compose the Effect directly. */
export function recordedRecallPromise(
  root: string,
  request: RecallRequest,
  options: RecordedRecallRuntimeOptions = {},
): Promise<RecallResult> {
  return Effect.runPromise(createRecordedRecallRuntime(root, options).recall(request));
}
