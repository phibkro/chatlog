import {
  readContextEventKindCounts,
  readContextEvents,
  recordContextFeedback,
  recordContextOutcome,
  CONTEXT_FEEDBACK_SIGNALS,
  CONTEXT_TREATMENT_ARMS,
  type ContextFeedbackSignal,
  type ContextEventProjectionRow,
  type ContextOutcomeStatus,
  type ContextTreatmentArm,
} from "../context-events";
import { readAuthorizedContextRelease } from "../context-release";
import { listContextSessionsBounded, readContextSession } from "../context-session";
import { sha256, stableStringify } from "../events";
import type { ContextSession } from "../context-types";
import { readPublishedInsightMemory } from "../experience-memory-store";
import type { InsightAuthorityKind, InsightRevision, InsightScope } from "../insights";

const HASH = /^[a-f0-9]{64}$/u;

export const CONTEXT_MANAGEMENT_LIMITS = {
  insights: 100,
  sessions: 100,
  eventsPerSession: 100,
  eventReferences: 32,
  sessionReferences: 32,
  payloadKeys: 32,
  payloadArrayItems: 32,
  payloadDepth: 3,
  text: 1_500,
  operatorId: 80,
  evidence: 8,
  authority: 8,
} as const;

export interface ContextManagementRelease {
  gateHash: string;
  evaluationId: string;
  stage: "shadow" | "evidence-only" | "limited-insight";
  candidateId: string;
  authorizedAt: string;
}

export interface ContextManagementAuthority {
  kind: InsightAuthorityKind;
  actor: string;
  authority: string;
  assertedAt: string;
  sourceHashes: string[];
}

export interface ContextManagementInsight {
  insightId: string;
  revisionId: string;
  kind: InsightRevision["kind"];
  proposition: string;
  procedure: string | null;
  status: "active";
  scope: InsightScope;
  validTime: { start: string; end: string | null };
  riskClass: InsightRevision["riskClass"];
  authority: ContextManagementAuthority[];
  supportEvidence: string[];
  counterEvidence: string[];
}

export type ContextManagementEvent = ContextEventProjectionRow;

export interface ContextManagementSessionProjection {
  schemaVersion: ContextSession["schemaVersion"];
  contextSessionId: string;
  nativeSessionId: string | null;
  sessionNonce: string | null;
  target: {
    provider: string;
    harness: string;
    model: string | null;
    role: string;
  };
  projectIdentity: string;
  cwd: string;
  domainPolicy: string[];
  domainPolicyTotal: number;
  domainPolicyTruncated: boolean;
  path: string | null;
  pinnedInsightProjectionHash: string;
  pinnedEvidenceProjectionHash: string;
  selectionPolicyVersion: string;
  deliveryPolicyVersion: string;
  budget: ContextSession["budget"];
  consumedBundleHashes: string[];
  consumedBundleHashesTotal: number;
  consumedBundleHashesTruncated: boolean;
  consumedRecallHashes: string[];
  consumedRecallHashesTotal: number;
  consumedRecallHashesTruncated: boolean;
  consumedRecallInvocations: ContextSession["consumedRecallInvocations"];
  consumedRecallInvocationsTotal: number;
  consumedRecallInvocationsTruncated: boolean;
  pendingEventBatchHashes: string[];
  pendingEventBatchHashesTotal: number;
  pendingEventBatchHashesTruncated: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ContextManagementSession {
  session: ContextManagementSessionProjection;
  events: ContextManagementEvent[];
}

export interface ContextManagementTotals {
  sessions: number;
  delivered: number;
  feedback: number;
  outcomes: number;
}

export interface ContextManagementView {
  release: ContextManagementRelease | null;
  insights: ContextManagementInsight[];
  sessions: ContextManagementSession[];
  totals: ContextManagementTotals;
}

export interface ContextManagementFeedbackInput {
  contextSessionId: string;
  interventionEventId: string;
  itemId?: string;
  signal: ContextFeedbackSignal;
  note?: string;
  operatorId: string;
}

export interface ContextManagementOutcomeInput {
  contextSessionId: string;
  interventionEventId: string;
  status: ContextOutcomeStatus;
  treatmentArm: ContextTreatmentArm;
  unresolved: boolean;
  note?: string;
  operatorId: string;
}

export type ContextManagementResult<T> =
  | { ok: true; value: T }
  | { ok: false; status: number; error: string };

function failure<T>(status: number, error: string): ContextManagementResult<T> {
  return { ok: false, status, error };
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function text(value: unknown, maximum: number): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum) return undefined;
  return value;
}

function parseFeedbackInput(
  value: unknown,
): { ok: true; value: ContextManagementFeedbackInput } | { ok: false; error: string } {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return { ok: false, error: "context feedback must be an object" };
  const input = value as Record<string, unknown>;
  if (
    !hasOnlyKeys(input, [
      "contextSessionId",
      "interventionEventId",
      "itemId",
      "signal",
      "note",
      "operatorId",
    ])
  )
    return { ok: false, error: "context feedback contains unsupported fields" };
  const contextSessionId = text(input.contextSessionId, 200);
  if (!contextSessionId || !HASH.test(contextSessionId))
    return { ok: false, error: "contextSessionId must be a lowercase SHA-256" };
  const interventionEventId = text(input.interventionEventId, 64);
  if (!interventionEventId || !HASH.test(interventionEventId))
    return { ok: false, error: "interventionEventId must be a lowercase SHA-256 event ID" };
  const operatorId = text(input.operatorId, CONTEXT_MANAGEMENT_LIMITS.operatorId);
  if (!operatorId) return { ok: false, error: "operatorId must be non-empty bounded text" };
  if (
    typeof input.signal !== "string" ||
    !CONTEXT_FEEDBACK_SIGNALS.includes(input.signal as ContextFeedbackSignal)
  )
    return { ok: false, error: "signal is not a supported context feedback signal" };
  const itemId =
    input.itemId === undefined ? undefined : text(input.itemId, CONTEXT_MANAGEMENT_LIMITS.text);
  if (input.itemId !== undefined && !itemId)
    return { ok: false, error: "itemId must be non-empty bounded text" };
  const note =
    input.note === undefined ? undefined : text(input.note, CONTEXT_MANAGEMENT_LIMITS.text);
  if (input.note !== undefined && note === undefined)
    return { ok: false, error: "note must be bounded non-empty text" };
  return {
    ok: true,
    value: {
      contextSessionId,
      interventionEventId,
      ...(itemId === undefined ? {} : { itemId }),
      signal: input.signal as ContextFeedbackSignal,
      ...(note === undefined ? {} : { note }),
      operatorId,
    },
  };
}

function parseOutcomeInput(
  value: unknown,
): { ok: true; value: ContextManagementOutcomeInput } | { ok: false; error: string } {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return { ok: false, error: "context outcome must be an object" };
  const input = value as Record<string, unknown>;
  if (
    !hasOnlyKeys(input, [
      "contextSessionId",
      "interventionEventId",
      "status",
      "treatmentArm",
      "unresolved",
      "note",
      "operatorId",
    ])
  )
    return { ok: false, error: "context outcome contains unsupported fields" };
  const contextSessionId = text(input.contextSessionId, 200);
  if (!contextSessionId || !HASH.test(contextSessionId))
    return { ok: false, error: "contextSessionId must be a lowercase SHA-256" };
  const interventionEventId = text(input.interventionEventId, 64);
  if (!interventionEventId || !HASH.test(interventionEventId))
    return { ok: false, error: "interventionEventId must be a lowercase SHA-256 event ID" };
  const operatorId = text(input.operatorId, CONTEXT_MANAGEMENT_LIMITS.operatorId);
  if (!operatorId) return { ok: false, error: "operatorId must be non-empty bounded text" };
  if (
    typeof input.status !== "string" ||
    !["success", "failure", "mixed", "unknown"].includes(input.status)
  )
    return { ok: false, error: "status must be success, failure, mixed, or unknown" };
  if (
    typeof input.treatmentArm !== "string" ||
    !CONTEXT_TREATMENT_ARMS.includes(input.treatmentArm as ContextTreatmentArm)
  )
    return { ok: false, error: "treatmentArm is not supported" };
  if (typeof input.unresolved !== "boolean")
    return { ok: false, error: "unresolved must be boolean" };
  const note =
    input.note === undefined ? undefined : text(input.note, CONTEXT_MANAGEMENT_LIMITS.text);
  if (input.note !== undefined && note === undefined)
    return { ok: false, error: "note must be bounded non-empty text" };
  return {
    ok: true,
    value: {
      contextSessionId,
      interventionEventId,
      status: input.status as ContextOutcomeStatus,
      treatmentArm: input.treatmentArm as ContextTreatmentArm,
      unresolved: input.unresolved,
      ...(note === undefined ? {} : { note }),
      operatorId,
    },
  };
}

function boundedText(value: unknown, maximum: number = CONTEXT_MANAGEMENT_LIMITS.text): string {
  if (typeof value !== "string") return "";
  if (value.length <= maximum) return value;
  return `${value.slice(0, Math.max(0, maximum - 1))}…`;
}

function boundedNullableText(value: unknown): string | null {
  return value === null ? null : boundedText(value);
}

function boundedScope(scope: InsightScope): InsightScope {
  return {
    user: boundedNullableText(scope.user),
    organization: boundedNullableText(scope.organization),
    project: boundedNullableText(scope.project),
    repository: boundedNullableText(scope.repository),
    path: boundedNullableText(scope.path),
    harness: boundedNullableText(scope.harness),
    model: boundedNullableText(scope.model),
    tool: boundedNullableText(scope.tool),
    domain: boundedText(scope.domain),
  };
}

function boundedAuthority(revision: InsightRevision): ContextManagementAuthority[] {
  return revision.authority.slice(0, CONTEXT_MANAGEMENT_LIMITS.authority).map((record) => ({
    kind: record.kind,
    actor: boundedText(record.actor),
    authority: boundedText(record.authority),
    assertedAt: boundedText(record.assertedAt),
    sourceHashes: record.sourceHashes
      .slice(0, CONTEXT_MANAGEMENT_LIMITS.evidence)
      .map((hash) => boundedText(hash, 128)),
  }));
}

function boundedInsight(revision: InsightRevision): ContextManagementInsight {
  return {
    insightId: boundedText(revision.insightId, 200),
    revisionId: boundedText(revision.revisionId, 200),
    kind: revision.kind,
    proposition: boundedText(revision.proposition),
    procedure: revision.procedure === null ? null : boundedText(revision.procedure),
    status: "active",
    scope: boundedScope(revision.scope),
    validTime: {
      start: boundedText(revision.validTime.start, 128),
      end: revision.validTime.end === null ? null : boundedText(revision.validTime.end, 128),
    },
    riskClass: revision.riskClass,
    authority: boundedAuthority(revision),
    supportEvidence: revision.supportEvidence
      .slice(0, CONTEXT_MANAGEMENT_LIMITS.evidence)
      .map((value) => boundedText(value, 2_000)),
    counterEvidence: revision.counterEvidence
      .slice(0, CONTEXT_MANAGEMENT_LIMITS.evidence)
      .map((value) => boundedText(value, 2_000)),
  };
}

function boundedValue(value: unknown, depth: number): unknown {
  if (depth >= CONTEXT_MANAGEMENT_LIMITS.payloadDepth) {
    if (typeof value === "string") return boundedText(value);
    if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
    return "[bounded]";
  }
  if (typeof value === "string") return boundedText(value);
  if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
  if (Array.isArray(value))
    return value
      .slice(0, CONTEXT_MANAGEMENT_LIMITS.payloadArrayItems)
      .map((item) => boundedValue(item, depth + 1));
  if (typeof value !== "object") return "[bounded]";
  const bounded: Record<string, unknown> = {};
  let count = 0;
  for (const key in value) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
    if (count >= CONTEXT_MANAGEMENT_LIMITS.payloadKeys) break;
    bounded[boundedText(key, 160)] = boundedValue(
      (value as Record<string, unknown>)[key],
      depth + 1,
    );
    count += 1;
  }
  return bounded;
}

function boundedEvent(event: ContextEventProjectionRow): ContextManagementEvent {
  return {
    ...event,
    interventionEventIds: event.interventionEventIds.slice(
      0,
      CONTEXT_MANAGEMENT_LIMITS.eventReferences,
    ),
    knownInterventionLineage: event.knownInterventionLineage.slice(
      0,
      CONTEXT_MANAGEMENT_LIMITS.eventReferences,
    ),
    inputEventIds: event.inputEventIds.slice(0, CONTEXT_MANAGEMENT_LIMITS.eventReferences),
    inputHashes: event.inputHashes.slice(0, CONTEXT_MANAGEMENT_LIMITS.eventReferences),
    actor: boundedValue(event.actor, 0) as Record<string, unknown>,
    payload: boundedValue(event.payload, 0) as Record<string, unknown>,
  };
}

function boundedSessionArray<T>(
  values: readonly T[],
  fromEnd = false,
): { values: T[]; total: number; truncated: boolean } {
  const total = values.length;
  const limit = CONTEXT_MANAGEMENT_LIMITS.sessionReferences;
  return {
    values: fromEnd ? values.slice(Math.max(0, total - limit)) : values.slice(0, limit),
    total,
    truncated: total > limit,
  };
}

function boundedSession(session: ContextSession): ContextManagementSessionProjection {
  const domainPolicy = boundedSessionArray(session.domainPolicy);
  const consumedBundleHashes = boundedSessionArray(session.consumedBundleHashes, true);
  const consumedRecallHashes = boundedSessionArray(session.consumedRecallHashes, true);
  const consumedRecallInvocations = boundedSessionArray(session.consumedRecallInvocations, true);
  const pendingEventBatchHashes = boundedSessionArray(session.pendingEventBatchHashes, true);
  return {
    schemaVersion: session.schemaVersion,
    contextSessionId: session.contextSessionId,
    nativeSessionId:
      session.nativeSessionId === null ? null : boundedText(session.nativeSessionId, 256),
    sessionNonce: session.sessionNonce === null ? null : boundedText(session.sessionNonce, 256),
    target: {
      provider: boundedText(session.target.provider, 128),
      harness: boundedText(session.target.harness, 128),
      model: session.target.model === null ? null : boundedText(session.target.model, 256),
      role: boundedText(session.target.role, 128),
    },
    projectIdentity: boundedText(session.projectIdentity),
    cwd: boundedText(session.cwd),
    domainPolicy: domainPolicy.values.map((value) => boundedText(value, 128)),
    domainPolicyTotal: domainPolicy.total,
    domainPolicyTruncated: domainPolicy.truncated,
    path: session.path === null ? null : boundedText(session.path),
    pinnedInsightProjectionHash: session.pinnedInsightProjectionHash,
    pinnedEvidenceProjectionHash: session.pinnedEvidenceProjectionHash,
    selectionPolicyVersion: boundedText(session.selectionPolicyVersion, 256),
    deliveryPolicyVersion: boundedText(session.deliveryPolicyVersion, 256),
    budget: {
      total: { ...session.budget.total },
      remaining: { ...session.budget.remaining },
    },
    consumedBundleHashes: consumedBundleHashes.values,
    consumedBundleHashesTotal: consumedBundleHashes.total,
    consumedBundleHashesTruncated: consumedBundleHashes.truncated,
    consumedRecallHashes: consumedRecallHashes.values,
    consumedRecallHashesTotal: consumedRecallHashes.total,
    consumedRecallHashesTruncated: consumedRecallHashes.truncated,
    consumedRecallInvocations: consumedRecallInvocations.values,
    consumedRecallInvocationsTotal: consumedRecallInvocations.total,
    consumedRecallInvocationsTruncated: consumedRecallInvocations.truncated,
    pendingEventBatchHashes: pendingEventBatchHashes.values,
    pendingEventBatchHashesTotal: pendingEventBatchHashes.total,
    pendingEventBatchHashesTruncated: pendingEventBatchHashes.truncated,
    createdAt: boundedText(session.createdAt, 128),
    updatedAt: boundedText(session.updatedAt, 128),
  };
}

function eventFailure<T>(message: string): ContextManagementResult<T> {
  return failure(503, message);
}

function feedbackFailure<T>(error: { code: string; message: string }): ContextManagementResult<T> {
  if (error.code === "storage-error") return failure(503, error.message);
  if (error.code === "idempotency-conflict") return failure(409, error.message);
  return failure(400, error.message);
}

const DELIVERED_EVENT_KINDS = new Set([
  "context.bundle.emitted",
  "context.recall.returned",
  "context.procedure.returned",
]);

async function deliveredIntervention(
  root: string,
  contextSessionId: string,
  interventionEventId: string,
): Promise<ContextManagementResult<ContextEventProjectionRow>> {
  const loaded = await readContextSession(root, contextSessionId);
  if (!loaded.ok) {
    if (/\bENOENT\b/u.test(loaded.error.message))
      return failure(400, "context session does not exist");
    return eventFailure(loaded.error.message);
  }
  const events = await readContextEvents(root, {
    contextSessionId,
    recoverPending: false,
  });
  if (!events.ok) return eventFailure(events.error.message);
  const intervention = events.value.find((event) => event.eventId === interventionEventId);
  return intervention && DELIVERED_EVENT_KINDS.has(intervention.kind)
    ? { ok: true, value: intervention }
    : failure(400, "intervention event does not belong to the context session");
}

export class ContextManagement {
  constructor(readonly root: string) {}

  async get(): Promise<ContextManagementResult<ContextManagementView>> {
    const published = await readPublishedInsightMemory(this.root);
    if (!published.ok) return eventFailure(published.error.message);

    const releaseResult = await readAuthorizedContextRelease(this.root);
    if (!releaseResult.ok && releaseResult.error.code !== "not-authorized")
      return eventFailure(releaseResult.error.message);

    const listed = await listContextSessionsBounded(this.root, CONTEXT_MANAGEMENT_LIMITS.sessions);
    if (!listed.ok) return eventFailure(listed.error.message);

    const visibleSessions = listed.value.sessions;
    const eventCounts = await readContextEventKindCounts(this.root);
    if (!eventCounts.ok) return eventFailure(eventCounts.error.message);
    const totals: ContextManagementTotals = {
      sessions: listed.value.total,
      delivered: [...DELIVERED_EVENT_KINDS].reduce(
        (count, kind) => count + (eventCounts.value[kind] ?? 0),
        0,
      ),
      feedback: eventCounts.value["context.feedback.asserted"] ?? 0,
      outcomes: eventCounts.value["context.outcome.observed"] ?? 0,
    };
    const sessionResults = await Promise.all(
      visibleSessions.map(async (session) => {
        const events = await readContextEvents(this.root, {
          contextSessionId: session.contextSessionId,
          limit: CONTEXT_MANAGEMENT_LIMITS.eventsPerSession,
        });
        return events.ok
          ? {
              ok: true as const,
              value: { session: boundedSession(session), events: events.value.map(boundedEvent) },
            }
          : events;
      }),
    );
    const sessionFailure = sessionResults.find((result) => !result.ok);
    if (sessionFailure && !sessionFailure.ok) return eventFailure(sessionFailure.error.message);
    const sessions: ContextManagementSession[] = sessionResults.flatMap((result) =>
      result.ok ? [result.value] : [],
    );

    const insights = Object.values(published.value.projection.current)
      .filter((revision) => revision.status === "active")
      .toSorted(
        (left, right) =>
          left.insightId.localeCompare(right.insightId) ||
          left.revisionId.localeCompare(right.revisionId),
      )
      .slice(0, CONTEXT_MANAGEMENT_LIMITS.insights)
      .map(boundedInsight);

    return {
      ok: true,
      value: {
        release: releaseResult.ok
          ? {
              gateHash: releaseResult.value.pointer.gateHash,
              evaluationId: releaseResult.value.pointer.evaluationId,
              stage: releaseResult.value.pointer.stage,
              candidateId: releaseResult.value.pointer.candidateId,
              authorizedAt: releaseResult.value.pointer.authorizedAt,
            }
          : null,
        insights,
        sessions,
        totals,
      },
    };
  }

  async feedback(input: unknown): Promise<ContextManagementResult<ContextManagementView>> {
    const parsed = parseFeedbackInput(input);
    if (!parsed.ok) return failure(400, parsed.error);
    const value = parsed.value;

    const intervention = await deliveredIntervention(
      this.root,
      value.contextSessionId,
      value.interventionEventId,
    );
    if (!intervention.ok) return intervention;
    if (value.itemId !== undefined && intervention.value.itemId !== value.itemId)
      return failure(400, "feedback item does not belong to the intervention");

    const idempotencyKey = sha256(
      stableStringify({
        recipe: "chatlog-workbench-context-feedback-v1",
        contextSessionId: value.contextSessionId,
        interventionEventId: value.interventionEventId,
        itemId: value.itemId ?? null,
        signal: value.signal,
        note: value.note ?? null,
        operatorId: value.operatorId,
      }),
    );
    const recorded = await recordContextFeedback(this.root, {
      contextSessionId: value.contextSessionId,
      idempotencyKey,
      actor: { kind: "human", id: value.operatorId },
      actorAuthority: "human",
      interventionEventId: value.interventionEventId,
      ...(value.itemId === undefined ? {} : { itemId: value.itemId }),
      signal: value.signal,
      ...(value.note === undefined ? {} : { note: value.note }),
    });
    if (!recorded.ok) return feedbackFailure(recorded.error);
    return this.get();
  }

  async outcome(input: unknown): Promise<ContextManagementResult<ContextManagementView>> {
    const parsed = parseOutcomeInput(input);
    if (!parsed.ok) return failure(400, parsed.error);
    const value = parsed.value;
    const intervention = await deliveredIntervention(
      this.root,
      value.contextSessionId,
      value.interventionEventId,
    );
    if (!intervention.ok) return intervention;

    const idempotencyKey = sha256(
      stableStringify({
        recipe: "chatlog-workbench-context-outcome-v1",
        contextSessionId: value.contextSessionId,
        interventionEventId: value.interventionEventId,
        status: value.status,
        treatmentArm: value.treatmentArm,
        unresolved: value.unresolved,
        note: value.note ?? null,
        operatorId: value.operatorId,
      }),
    );
    const recorded = await recordContextOutcome(this.root, {
      contextSessionId: value.contextSessionId,
      idempotencyKey,
      actor: { kind: "human", id: value.operatorId },
      actorAuthority: "human",
      interventionEventIds: [value.interventionEventId],
      evidenceGrade: "human-asserted",
      treatmentArm: value.treatmentArm,
      metrics: value.note === undefined ? {} : { note: value.note },
      unresolved: value.unresolved,
      status: value.status,
      evidenceSource: "workbench-operator",
    });
    if (!recorded.ok) return feedbackFailure(recorded.error);
    return this.get();
  }
}

export async function readContextManagement(
  root: string,
): Promise<ContextManagementResult<ContextManagementView>> {
  return new ContextManagement(root).get();
}

export async function recordContextManagementFeedback(
  root: string,
  input: unknown,
): Promise<ContextManagementResult<ContextManagementView>> {
  return new ContextManagement(root).feedback(input);
}
