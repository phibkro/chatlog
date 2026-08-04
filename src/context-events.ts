import { Effect } from "effect";
import type { Database } from "bun:sqlite";
import { join } from "node:path";
import {
  CONTEXT_EVENT_KINDS,
  CONTEXT_EVENT_PROCESSOR,
  EVENT_SCHEMA_VERSION,
  CONTEXT_EVENT_RECIPE,
  capture,
  invalidEvent,
  makeEvent,
  sha256,
  stableStringify,
  type AgentEventEnvelope,
  type ContextEventKind,
  type EventActor,
  type EventScope,
  type EventBatch,
} from "./events";
import {
  canonicalMetricsEqual,
  isTrustedClosedLoopEvaluatorSource,
  isUntrustedEvaluatorActor,
  parseClosedLoopEvaluatorMetrics,
  type ClosedLoopCanonicalMetrics,
} from "./closed-loop-evaluation";
import {
  indexEventBatch,
  openAnalysis,
  queryContextEvent,
  queryContextEvents,
  queryContextEventKindCounts,
  type IndexedContextEventRow,
} from "./analysis";
import { persistEventBatch } from "./event-store";
import { listContextSessions, readContextSession } from "./context-session";
import type { ContextSession } from "./context-types";
import { withIngestLock } from "./lock";

import { validateBoundedRecord, type BoundedRecordLimits } from "./bounded-input";
export { CONTEXT_EVENT_KINDS, CONTEXT_EVENT_PROCESSOR, CONTEXT_EVENT_RECIPE };

export const CONTEXT_FEEDBACK_SIGNALS = [
  "helpful",
  "harmful",
  "stale",
  "mis-scoped",
  "irrelevant",
  "incorrect",
] as const;
export type ContextFeedbackSignal = (typeof CONTEXT_FEEDBACK_SIGNALS)[number];

export const CONTEXT_OUTCOME_EVIDENCE_GRADES = [
  "gate-observed",
  "provider-observed",
  "human-asserted",
  "heuristic",
  "agent-self-report",
] as const;
export type ContextOutcomeEvidenceGrade = (typeof CONTEXT_OUTCOME_EVIDENCE_GRADES)[number];
export const CONTEXT_TREATMENT_ARMS = [
  "no-memory",
  "raw-evidence",
  "active-insight",
  "insight-plus-procedure",
  "reflective-model",
] as const;
export type ContextTreatmentArm = (typeof CONTEXT_TREATMENT_ARMS)[number];

export type ContextActorAuthority = "human" | "agent" | "provider" | "tool" | "system" | "unknown";
export type ContextOutcomeStatus = "success" | "failure" | "mixed" | "unknown";
export type ContextOutcomeEvidenceClassification =
  | "independent"
  | "non-independent-repetition"
  | "agent-self-report"
  | "human-asserted"
  | "pre-intervention"
  | "unknown";

export type ContextInterventionEventKind = Exclude<
  ContextEventKind,
  "context.feedback.asserted" | "context.outcome.observed"
>;

export interface ContextEventInput {
  kind: ContextInterventionEventKind;
  contextSessionId: string;
  idempotencyKey: string;
  actor: EventActor;
  actorAuthority?: ContextActorAuthority;
  scope?: EventScope;
  bundleHash?: string;
  itemId?: string;
  interventionEventId?: string;
  interventionEventIds?: readonly string[];
  knownInterventionLineage?: readonly string[];
  inputEventIds?: readonly string[];
  inputHashes?: readonly string[];
  inputHash?: string;
  contentHash?: string;
  candidateContentHash?: string;
  policyHash?: string;
  bounds?: Readonly<Record<string, unknown>>;
  provenance?: Readonly<Record<string, unknown>>;
  payload?: Readonly<Record<string, unknown>>;
  occurredAt?: string;
  observedAt?: string;
  providerReported?: boolean;
}

export interface ContextFeedbackInput {
  contextSessionId: string;
  idempotencyKey: string;
  actor: EventActor;
  actorAuthority?: ContextActorAuthority;
  interventionEventId?: string;
  interventionEventIds?: readonly string[];
  itemId?: string;
  signal: ContextFeedbackSignal;
  note?: string;
  inputEventIds?: readonly string[];
  inputHashes?: readonly string[];
  occurredAt?: string;
  observedAt?: string;
}

export interface ContextOutcomeInput {
  contextSessionId: string;
  idempotencyKey: string;
  actor: EventActor;
  actorAuthority?: ContextActorAuthority;
  interventionEventIds?: readonly string[];
  knownInterventionLineage?: readonly string[];
  inputEventIds?: readonly string[];
  inputHashes?: readonly string[];
  evidenceGrade: ContextOutcomeEvidenceGrade;
  treatmentArm: ContextTreatmentArm;
  metrics: Readonly<Record<string, unknown>>;
  unresolved: boolean;
  status?: ContextOutcomeStatus;
  outcome?: ContextOutcomeStatus;
  evidenceSource?: string;
  evidenceSources?: readonly string[];
  source?: string;
  postInterventionRepetition?: boolean;
  repeatedInjectedProposition?: boolean;
  repetitionOfInjectedProposition?: boolean;
  occurredAt?: string;
  observedAt?: string;
}

export interface ContextEventRecord {
  event: AgentEventEnvelope;
  batchHash: string;
  idempotent: boolean;
}

export interface ContextEventError {
  code: "invalid-input" | "storage-error" | "idempotency-conflict";
  message: string;
  issues?: readonly string[];
}

export type ContextEventResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: ContextEventError };

export interface ContextEventReadOptions {
  contextSessionId: string;
  kinds?: readonly ContextEventKind[];
  limit?: number;
  /** Skip global outbox recovery only after the requested session was read and published. */
  recoverPending?: boolean;
}

export interface ContextEventLookupOptions {
  contextSessionId: string;
  eventId: string;
  /** Skip global outbox recovery only after the requested session was read and published. */
  recoverPending?: boolean;
}

export type ContextEventProjectionRow = IndexedContextEventRow;
export const MAX_CONTEXT_EVENT_HASHES = 256;
export const MAX_CONTEXT_EVENT_BATCH_INPUTS = 256;
export const MAX_CONTEXT_EVENT_RECORD_DEPTH = 8;
export const MAX_CONTEXT_EVENT_RECORD_KEYS = 512;
export const MAX_CONTEXT_EVENT_RECORD_ARRAY_ITEMS = 256;
export const MAX_CONTEXT_EVENT_RECORD_STRING = 4_096;
export const MAX_CONTEXT_EVENT_RECORD_BYTES = 64 * 1024;
const CONTEXT_EVENT_RECORD_LIMITS: BoundedRecordLimits = {
  maxDepth: MAX_CONTEXT_EVENT_RECORD_DEPTH,
  maxKeys: MAX_CONTEXT_EVENT_RECORD_KEYS,
  maxArrayItems: MAX_CONTEXT_EVENT_RECORD_ARRAY_ITEMS,
  maxStringLength: MAX_CONTEXT_EVENT_RECORD_STRING,
  maxBytes: MAX_CONTEXT_EVENT_RECORD_BYTES,
};

const HASH = /^[a-f0-9]{64}$/iu;
const MAX_TEXT = 512;
const MAX_NOTE = 1_500;
const CONTEXT_EVENT_SET: ReadonlySet<string> = new Set(CONTEXT_EVENT_KINDS);
const CONTEXT_INTERVENTION_EVENT_SET: ReadonlySet<string> = new Set(
  CONTEXT_EVENT_KINDS.filter(
    (kind) => kind !== "context.feedback.asserted" && kind !== "context.outcome.observed",
  ),
);
const CANONICAL_OUTCOME_EVENT_KINDS: Readonly<Record<string, true>> = {
  "evaluation.recorded": true,
  "message.created": true,
  "human.correction": true,
  "tool.result.observed": true,
  "artifact.created": true,
  "artifact.modified": true,
};
const OUTCOME_CONTENT_KEYS: Readonly<Record<string, true>> = {
  content: true,
  contentHash: true,
  encodedContent: true,
  inputHash: true,
  itemId: true,
  proposition: true,
  propositionHash: true,
  statement: true,
  text: true,
};
const STATE_BY_KIND: Readonly<Record<string, string>> = {
  "context.bundle.proposed": "proposed",
  "context.bundle.rendered": "rendered",
  "context.bundle.emitted": "emitted",
  "context.bundle.acknowledged": "acknowledged",
  "context.recall.returned": "recalled",
  "context.recall.branch.started": "recall-branch-started",
  "context.recall.branch.completed": "recall-branch-completed",
  "context.recall.branch.failed": "recall-branch-failed",
  "context.recall.branch.cancelled": "recall-branch-cancelled",
  "context.recall.terminated": "recall-terminated",
  "context.procedure.returned": "procedure-returned",
  "context.advisor.advice": "advisor-advice",
  "context.delivery.failed": "failed",
  "context.feedback.asserted": "feedback",
  "context.outcome.observed": "outcome",
};
function invalid(message: string, _issues?: readonly string[]): never {
  return invalidEvent(message);
}

function text(value: unknown, label: string, maximum = MAX_TEXT): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum)
    invalid(`${label} must be non-empty text of at most ${maximum} characters`);
  return value;
}

function hashes(value: readonly string[] | undefined, label: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value))
    invalid(`${label} must be an array of at most ${MAX_CONTEXT_EVENT_HASHES} SHA-256 hashes`);
  if (value.length > MAX_CONTEXT_EVENT_HASHES)
    invalid(`${label} must contain at most ${MAX_CONTEXT_EVENT_HASHES} hashes`);
  if (!value.every((item) => typeof item === "string" && item.length === 64 && HASH.test(item)))
    invalid(`${label} must contain SHA-256 hashes`);
  return value.map((item) => item.toLowerCase());
}

function checkedBoundedRecord(value: unknown, label: string): Record<string, unknown> {
  const validation = validateBoundedRecord(value, label, CONTEXT_EVENT_RECORD_LIMITS);
  if (!validation.ok) invalid(validation.error);
  return value as Record<string, unknown>;
}

function actorAuthority(actor: EventActor): ContextActorAuthority {
  const kind = actor.kind.toLowerCase();
  if (kind === "human") return "human";
  if (kind === "assistant" || kind === "agent") return "agent";
  if (kind === "provider") return "provider";
  if (kind === "tool") return "tool";
  if (kind === "system") return "system";
  return "unknown";
}

function checkedAuthority(
  actor: EventActor,
  supplied: ContextActorAuthority | undefined,
): ContextActorAuthority {
  const inferred = actorAuthority(actor);
  if (supplied !== undefined && supplied !== inferred)
    invalid(`actorAuthority ${supplied} does not match actor.kind ${actor.kind}`);
  return inferred;
}

function checkedActor(actor: EventActor): EventActor {
  if (!actor || typeof actor !== "object") invalid("actor must be an object");
  text(actor.kind, "actor.kind");
  if (actor.id !== undefined) text(actor.id, "actor.id");
  if (actor.name !== undefined) text(actor.name, "actor.name");
  return { ...actor };
}

function checkedTimestamp(value: string | undefined, label: string): string | undefined {
  if (value === undefined) return undefined;
  text(value, label);
  if (!Number.isFinite(Date.parse(value))) invalid(`${label} must be an ISO timestamp`);
  return value;
}

function checkedContextEventInput(
  input: ContextEventInput,
  allowDedicated = false,
): {
  input: ContextEventInput;
  actor: EventActor;
  authority: ContextActorAuthority;
  inputEventIds: string[];
  inputHashes: string[];
  interventionEventIds: string[];
  knownInterventionLineage: string[];
} {
  if (!input || typeof input !== "object" || Array.isArray(input))
    invalid("context event input must be an object");
  checkedBoundedRecord(input, "context event input");
  if (!CONTEXT_EVENT_SET.has(input.kind))
    invalid(`unsupported context event kind ${String(input.kind)}`);
  if (!allowDedicated && !CONTEXT_INTERVENTION_EVENT_SET.has(input.kind))
    invalid(`${input.kind} must be recorded by its dedicated API`);
  const contextSessionId = text(input.contextSessionId, "contextSessionId");
  const idempotencyKey = text(input.idempotencyKey, "idempotencyKey", 256);
  const actor = checkedActor(input.actor);
  const authority = checkedAuthority(actor, input.actorAuthority);
  if (input.kind === "context.bundle.acknowledged" && authority !== "provider")
    invalid("context.bundle.acknowledged requires provider authority");
  if (input.providerReported !== undefined && typeof input.providerReported !== "boolean")
    invalid("providerReported must be boolean");
  if (input.kind === "context.bundle.acknowledged" && input.providerReported !== true)
    invalid("context.bundle.acknowledged requires providerReported");
  if (input.kind !== "context.bundle.acknowledged" && input.providerReported === true)
    invalid("providerReported is only valid for context.bundle.acknowledged");
  const bundleHash =
    input.bundleHash === undefined ? undefined : text(input.bundleHash, "bundleHash");
  if (bundleHash !== undefined && !HASH.test(bundleHash))
    invalid("bundleHash must be a SHA-256 hash");
  const itemId = input.itemId === undefined ? undefined : text(input.itemId, "itemId");
  const inputEventIds = hashes(input.inputEventIds, "inputEventIds");
  const inputHashes = hashes(input.inputHashes, "inputHashes");
  const normalizedInputHashes = inputHashes.length > 0 ? inputHashes : [...inputEventIds];
  const interventionEventIds = hashes(input.interventionEventIds, "interventionEventIds");
  const singleIntervention =
    input.interventionEventId === undefined
      ? undefined
      : text(input.interventionEventId, "interventionEventId");
  if (singleIntervention !== undefined && !HASH.test(singleIntervention))
    invalid("interventionEventId must be a SHA-256 event ID");
  if (singleIntervention && !interventionEventIds.includes(singleIntervention)) {
    if (interventionEventIds.length >= MAX_CONTEXT_EVENT_HASHES)
      invalid(`interventionEventIds must contain at most ${MAX_CONTEXT_EVENT_HASHES} hashes`);
    interventionEventIds.push(singleIntervention);
  }
  const knownInterventionLineage = hashes(
    input.knownInterventionLineage,
    "knownInterventionLineage",
  );
  const payload = input.payload === undefined ? {} : input.payload;
  checkedBoundedRecord(payload, "payload");
  if (input.bounds !== undefined) checkedBoundedRecord(input.bounds, "bounds");
  if (input.provenance !== undefined) checkedBoundedRecord(input.provenance, "provenance");
  for (const [value, label] of [
    [input.inputHash, "inputHash"],
    [input.contentHash, "contentHash"],
    [input.candidateContentHash, "candidateContentHash"],
    [input.policyHash, "policyHash"],
  ] as const) {
    if (
      value !== undefined &&
      (typeof value !== "string" || value.length !== 64 || !HASH.test(value))
    )
      invalid(`${label} must be a SHA-256 hash`);
  }
  checkedTimestamp(input.occurredAt, "occurredAt");
  checkedTimestamp(input.observedAt, "observedAt");
  return {
    input: { ...input, contextSessionId, idempotencyKey, bundleHash, itemId },
    actor,
    authority,
    inputEventIds,
    inputHashes: normalizedInputHashes,
    interventionEventIds,
    knownInterventionLineage,
  };
}

function idempotencyIdentity(input: {
  contextSessionId: string;
  kind: ContextEventKind;
  idempotencyKey: string;
}): string {
  return sha256(stableStringify(input));
}
function makeContextBatch(
  input: ContextEventInput,
  allowDedicated = false,
): { event: AgentEventEnvelope; batch: EventBatch } {
  const checked = checkedContextEventInput(input, allowDedicated);
  const {
    input: normalized,
    actor,
    authority,
    inputEventIds,
    inputHashes,
    interventionEventIds,
    knownInterventionLineage,
  } = checked;
  const state = STATE_BY_KIND[normalized.kind];
  const payload: Record<string, unknown> = {
    ...normalized.payload,
    contextSessionId: normalized.contextSessionId,
    state,
    actorAuthority: authority,
    idempotencyKey: normalized.idempotencyKey,
    idempotencyIdentity: idempotencyIdentity({
      contextSessionId: normalized.contextSessionId,
      kind: normalized.kind,
      idempotencyKey: normalized.idempotencyKey,
    }),
    inputEventIds,
    inputHashes,
    ...(normalized.bundleHash ? { bundleHash: normalized.bundleHash } : {}),
    ...(normalized.itemId ? { itemId: normalized.itemId } : {}),
    ...(interventionEventIds.length > 0 ? { interventionEventIds } : {}),
    ...(knownInterventionLineage.length > 0 ? { knownInterventionLineage } : {}),
    ...(normalized.inputHash ? { inputHash: normalized.inputHash } : {}),
    ...(normalized.contentHash ? { contentHash: normalized.contentHash } : {}),
    ...(normalized.candidateContentHash
      ? { candidateContentHash: normalized.candidateContentHash }
      : {}),
    ...(normalized.policyHash ? { policyHash: normalized.policyHash } : {}),
    ...(normalized.bounds ? { bounds: normalized.bounds } : {}),
    ...(normalized.provenance ? { provenance: normalized.provenance } : {}),
    ...(normalized.providerReported === undefined
      ? {}
      : { providerReported: normalized.providerReported }),
  };
  const event = makeEvent({
    kind: normalized.kind,
    sequence: 0,
    ...(normalized.occurredAt ? { occurredAt: normalized.occurredAt } : {}),
    ...(normalized.observedAt ? { observedAt: normalized.observedAt } : {}),
    actor,
    scope: normalized.scope ?? { sessionId: normalized.contextSessionId },
    origin: {
      kind: "chatlog",
      processor: CONTEXT_EVENT_PROCESSOR,
      recipe: CONTEXT_EVENT_RECIPE,
      inputEventIds,
      inputHashes,
    },
    relations: {},
    payload,
    capture: capture("normalized"),
  });
  const batch: EventBatch = {
    schemaVersion: EVENT_SCHEMA_VERSION,
    origin: {
      kind: "chatlog",
      processor: CONTEXT_EVENT_PROCESSOR,
      recipe: CONTEXT_EVENT_RECIPE,
      inputHashes,
    },
    events: [event],
    semanticLoss: [],
    partialTail: false,
    sourceItemCount: 1,
  };
  return { event, batch };
}

function resultError<T>(code: ContextEventError["code"], message: string): ContextEventResult<T> {
  return { ok: false, error: { code, message } };
}

function storageMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function writeContextBatch(
  root: string,
  event: AgentEventEnvelope,
  batch: EventBatch,
  idempotencyKey: string,
  preflight?: (db: Database) => ContextEventError | undefined,
): Promise<ContextEventResult<ContextEventRecord>> {
  try {
    return await withIngestLock(root, async () => {
      const db = openAnalysis(join(root, "analysis", "chatlog.sqlite"));
      try {
        const existing = db
          .query(
            `SELECT event_id eventId,batch_hash batchHash FROM context_event_projection
             WHERE context_session_id = ? AND kind = ? AND idempotency_key = ?`,
          )
          .get(String(event.payload.contextSessionId), event.kind, idempotencyKey) as {
          eventId: string;
          batchHash: string;
        } | null;
        if (existing) {
          if (existing.eventId !== event.eventId)
            return resultError(
              "idempotency-conflict",
              `idempotency key ${idempotencyKey} already names a different context event`,
            );
          return {
            ok: true,
            value: { event, batchHash: existing.batchHash, idempotent: true },
          };
        }
        const validationError = preflight?.(db);
        if (validationError) return { ok: false, error: validationError };
        const batchHash = await persistEventBatch(root, batch);
        const inserted = indexEventBatch(db, batch, batchHash);
        return { ok: true, value: { event, batchHash, idempotent: !inserted } };
      } finally {
        db.close();
      }
    });
  } catch (error) {
    return resultError(
      "storage-error",
      `Could not persist context event: ${storageMessage(error)}`,
    );
  }
}

export async function recordContextEvent(
  root: string,
  input: ContextEventInput,
): Promise<ContextEventResult<ContextEventRecord>> {
  try {
    const { event, batch } = makeContextBatch(input);
    return await writeContextBatch(root, event, batch, input.idempotencyKey);
  } catch (error) {
    return resultError("invalid-input", storageMessage(error));
  }
}

export async function stageContextEvent(
  root: string,
  input: ContextEventInput,
): Promise<ContextEventResult<ContextEventRecord>> {
  let staged: ReturnType<typeof makeContextBatch>;
  try {
    staged = makeContextBatch(input);
  } catch (error) {
    return resultError("invalid-input", storageMessage(error));
  }
  try {
    const batchHash = await persistEventBatch(root, staged.batch);
    return { ok: true, value: { event: staged.event, batchHash, idempotent: false } };
  } catch (error) {
    return resultError("storage-error", `Could not stage context event: ${storageMessage(error)}`);
  }
}

export async function stageContextEvents(
  root: string,
  inputs: readonly ContextEventInput[],
): Promise<ContextEventResult<ContextEventRecord[]>> {
  if (!Array.isArray(inputs))
    return resultError("invalid-input", "context event inputs must be an array");
  if (inputs.length > MAX_CONTEXT_EVENT_BATCH_INPUTS)
    return resultError(
      "invalid-input",
      `context event inputs must contain at most ${MAX_CONTEXT_EVENT_BATCH_INPUTS} items`,
    );
  const staged = await Effect.runPromise(
    Effect.all(
      inputs.map((input) => Effect.promise(() => stageContextEvent(root, input))),
      { concurrency: 8 },
    ),
  );
  const failed = staged.find(
    (result): result is Extract<ContextEventResult<ContextEventRecord>, { ok: false }> =>
      !result.ok,
  );
  return (
    failed ?? {
      ok: true,
      value: staged.flatMap((result) => (result.ok ? [result.value] : [])),
    }
  );
}

function feedbackAuthority(
  _actor: EventActor,
  authority: ContextActorAuthority,
): "strong" | "weak" {
  return authority === "human" ? "strong" : "weak";
}
type ContextReferenceRow = {
  eventId: string;
  contextSessionId: string;
  kind: string;
  itemId: string | null;
  actorKind: string;
  payloadJson: string;
  occurredAt: string | null;
  observedAt: string | null;
};

type CanonicalEvidenceRow = {
  eventId: string;
  kind: string;
  actorKind: string;
  payloadJson: string;
  scopeJson: string;
  captureDisposition: string;
  originKind: string;
  originJson: string;
  occurredAt: string | null;
  observedAt: string | null;
};

interface ValidatedContextReferences {
  session: ContextSession;
  interventionRows: ContextReferenceRow[];
  evidenceRows: CanonicalEvidenceRow[];
  repetitionDetected: boolean;
  preIntervention: boolean;
}

type ContextReferenceResult =
  | { ok: true; value: ValidatedContextReferences }
  | { ok: false; error: ContextEventError };

function contextReferenceError(
  code: ContextEventError["code"],
  message: string,
): ContextEventError {
  return { code, message };
}

function jsonRecord(value: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function canonicalEvidenceMatchesSession(
  row: CanonicalEvidenceRow,
  session: ContextSession,
): boolean {
  if (
    !CANONICAL_OUTCOME_EVENT_KINDS[row.kind] ||
    row.originKind !== "observed" ||
    !["normalized", "redacted"].includes(row.captureDisposition)
  )
    return false;
  const scope = jsonRecord(row.scopeJson);
  const origin = jsonRecord(row.originJson);
  const source =
    origin.source && typeof origin.source === "object" && !Array.isArray(origin.source)
      ? (origin.source as Record<string, unknown>)
      : {};
  const provider = typeof source.provider === "string" ? source.provider : "";
  const harness = typeof source.harness === "string" ? source.harness : "";
  if (
    !provider ||
    !harness ||
    provider.toLowerCase() !== session.target.provider.toLowerCase() ||
    harness.toLowerCase() !== session.target.harness.toLowerCase()
  )
    return false;
  if (scope.project !== session.projectIdentity || scope.cwd !== session.cwd) return false;
  return scope.sessionId === session.contextSessionId;
}

function outcomeContentFingerprints(value: unknown, key?: string): Set<string> {
  const fingerprints = new Set<string>();
  if (typeof value === "string") {
    if (key === undefined || OUTCOME_CONTENT_KEYS[key]) {
      fingerprints.add(`text:${value}`);
      fingerprints.add(`hash:${sha256(value)}`);
      if (HASH.test(value)) fingerprints.add(`hash:${value.toLowerCase()}`);
    }
    return fingerprints;
  }
  if (Array.isArray(value)) {
    for (const item of value)
      for (const fingerprint of outcomeContentFingerprints(item, key))
        fingerprints.add(fingerprint);
    return fingerprints;
  }
  if (!value || typeof value !== "object") return fingerprints;
  for (const [childKey, child] of Object.entries(value))
    for (const fingerprint of outcomeContentFingerprints(child, childKey))
      fingerprints.add(fingerprint);
  return fingerprints;
}

function canonicalInputDescendsFromIntervention(
  db: Database,
  inputEventIds: readonly string[],
  interventionEventIds: readonly string[],
): boolean {
  if (!inputEventIds.length || !interventionEventIds.length) return false;
  const placeholders = interventionEventIds.map(() => "?").join(", ");
  const query = db.query(
    `WITH RECURSIVE ancestors(event_id) AS (
       SELECT ?
       UNION
       SELECT relation.target_event_id
       FROM event_relations relation
       JOIN ancestors ON relation.event_id = ancestors.event_id
     )
     SELECT 1 FROM ancestors
     WHERE event_id IN (${placeholders})
     LIMIT 1`,
  );
  return inputEventIds.some((eventId) => Boolean(query.get(eventId, ...interventionEventIds)));
}

function eventTime(row: { occurredAt: string | null; observedAt: string | null }): number | null {
  const value = row.occurredAt ?? row.observedAt;
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

async function validateContextReferences(
  root: string,
  input: {
    contextSessionId: string;
    interventionEventIds: readonly string[];
    knownInterventionLineage: readonly string[];
    inputEventIds: readonly string[];
    itemId?: string;
  },
): Promise<ContextReferenceResult> {
  const session = await readContextSession(root, input.contextSessionId);
  if (!session.ok) {
    if (session.error.code === "invalid-session" || session.error.code === "session-conflict")
      return {
        ok: false,
        error: contextReferenceError("invalid-input", session.error.message),
      };
    if (/\bENOENT\b/u.test(session.error.message))
      return {
        ok: false,
        error: contextReferenceError("invalid-input", "context session does not exist"),
      };
    return {
      ok: false,
      error: contextReferenceError("storage-error", session.error.message),
    };
  }

  const interventionEventIds = [...new Set(input.interventionEventIds)];
  const knownInterventionLineage = [...new Set(input.knownInterventionLineage)];
  const inputEventIds = [...new Set(input.inputEventIds)];
  let db: Database;
  try {
    db = openAnalysis(join(root, "analysis", "chatlog.sqlite"));
  } catch (error) {
    return {
      ok: false,
      error: contextReferenceError(
        "storage-error",
        `Could not inspect context references: ${storageMessage(error)}`,
      ),
    };
  }
  try {
    const interventionRows: ContextReferenceRow[] = [];
    for (const eventId of [...interventionEventIds, ...knownInterventionLineage]) {
      const row = db
        .query(
          `SELECT event_id eventId,context_session_id contextSessionId,kind,item_id itemId,
             actor_kind actorKind,payload_json payloadJson,occurred_at occurredAt,observed_at observedAt
           FROM context_event_projection WHERE event_id = ?`,
        )
        .get(eventId) as ContextReferenceRow | null;
      if (!row)
        return {
          ok: false,
          error: contextReferenceError(
            "invalid-input",
            `referenced context event ${eventId} does not exist`,
          ),
        };
      if (row.contextSessionId !== input.contextSessionId)
        return {
          ok: false,
          error: contextReferenceError(
            "invalid-input",
            `referenced context event ${eventId} belongs to a different context session`,
          ),
        };
      if (!CONTEXT_INTERVENTION_EVENT_SET.has(row.kind))
        return {
          ok: false,
          error: contextReferenceError(
            "invalid-input",
            `context event ${eventId} is not a valid intervention lineage event`,
          ),
        };
      interventionRows.push(row);
    }

    const evidenceRows: CanonicalEvidenceRow[] = [];
    for (const eventId of inputEventIds) {
      const row = db
        .query(
          `SELECT event_id eventId,kind,actor_kind actorKind,payload_json payloadJson,
             scope_json scopeJson,capture_disposition captureDisposition,
             origin_kind originKind,origin_json originJson,occurred_at occurredAt,observed_at observedAt
           FROM event_metadata WHERE event_id = ?`,
        )
        .get(eventId) as CanonicalEvidenceRow | null;
      if (!row)
        return {
          ok: false,
          error: contextReferenceError(
            "invalid-input",
            `canonical input evidence event ${eventId} does not exist`,
          ),
        };
      if (!canonicalEvidenceMatchesSession(row, session.value))
        return {
          ok: false,
          error: contextReferenceError(
            "invalid-input",
            `canonical input evidence event ${eventId} lacks allowed same-session observed provenance`,
          ),
        };
      evidenceRows.push(row);
    }

    if (input.itemId !== undefined) {
      const rowsForItem = db
        .query(
          `SELECT kind,item_id itemId,payload_json payloadJson
           FROM context_event_projection WHERE context_session_id = ?`,
        )
        .all(input.contextSessionId) as Array<{
        kind: string;
        itemId: string | null;
        payloadJson: string;
      }>;
      const itemFound = rowsForItem.some((row) => {
        if (!CONTEXT_INTERVENTION_EVENT_SET.has(row.kind)) return false;
        if (row.itemId === input.itemId) return true;
        const payload = jsonRecord(row.payloadJson);
        return (
          payload.itemId === input.itemId ||
          (Array.isArray(payload.itemIds) && payload.itemIds.includes(input.itemId))
        );
      });
      if (!itemFound)
        return {
          ok: false,
          error: contextReferenceError(
            "invalid-input",
            `context item ${input.itemId} does not exist in the context session`,
          ),
        };
    }

    const interventionFingerprints = new Set<string>();
    for (const row of interventionRows)
      for (const fingerprint of outcomeContentFingerprints(jsonRecord(row.payloadJson)))
        interventionFingerprints.add(fingerprint);
    const evidenceRepeats = evidenceRows.some((row) => {
      for (const fingerprint of outcomeContentFingerprints(jsonRecord(row.payloadJson)))
        if (interventionFingerprints.has(fingerprint)) return true;
      return false;
    });
    const lineageIds = [...new Set([...interventionEventIds, ...knownInterventionLineage])];
    const repetitionDetected =
      canonicalInputDescendsFromIntervention(db, inputEventIds, lineageIds) || evidenceRepeats;
    const interventionTimes = interventionRows
      .map(eventTime)
      .filter((value): value is number => value !== null);
    const evidenceTimes = evidenceRows
      .map(eventTime)
      .filter((value): value is number => value !== null);
    const preIntervention =
      interventionTimes.length > 0 &&
      evidenceTimes.length > 0 &&
      Math.max(...evidenceTimes) < Math.min(...interventionTimes);
    return {
      ok: true,
      value: {
        session: session.value,
        interventionRows,
        evidenceRows,
        repetitionDetected,
        preIntervention,
      },
    };
  } catch (error) {
    return {
      ok: false,
      error: contextReferenceError(
        "storage-error",
        `Could not inspect context references: ${storageMessage(error)}`,
      ),
    };
  } finally {
    db.close();
  }
}

export async function recordContextFeedback(
  root: string,
  input: ContextFeedbackInput,
): Promise<ContextEventResult<ContextEventRecord>> {
  try {
    checkedBoundedRecord(input, "feedback input");
    if (!CONTEXT_FEEDBACK_SIGNALS.includes(input.signal))
      invalid(`unsupported feedback signal ${String(input.signal)}`);
    const actor = checkedActor(input.actor);
    const authority = checkedAuthority(actor, input.actorAuthority);
    const note = input.note === undefined ? undefined : text(input.note, "note", MAX_NOTE);
    const interventionEventIds = hashes(input.interventionEventIds, "interventionEventIds");
    const inputEventIds = hashes(input.inputEventIds, "inputEventIds");
    const inputHashes = hashes(input.inputHashes, "inputHashes");
    const itemId = input.itemId === undefined ? undefined : text(input.itemId, "itemId");
    if (input.interventionEventId !== undefined) {
      text(input.interventionEventId, "interventionEventId");
      if (!HASH.test(input.interventionEventId))
        invalid("interventionEventId must be a SHA-256 event ID");
      if (!interventionEventIds.includes(input.interventionEventId)) {
        if (interventionEventIds.length >= MAX_CONTEXT_EVENT_HASHES)
          invalid(`interventionEventIds must contain at most ${MAX_CONTEXT_EVENT_HASHES} hashes`);
        interventionEventIds.push(input.interventionEventId);
      }
    }
    const references = await validateContextReferences(root, {
      contextSessionId: input.contextSessionId,
      interventionEventIds,
      knownInterventionLineage: [],
      inputEventIds,
      ...(itemId === undefined ? {} : { itemId }),
    });
    if (!references.ok) return references;
    const contextInput: ContextEventInput = {
      kind: "context.feedback.asserted" as ContextInterventionEventKind,
      contextSessionId: input.contextSessionId,
      idempotencyKey: input.idempotencyKey,
      actor,
      actorAuthority: authority,
      itemId,
      interventionEventIds,
      inputEventIds,
      inputHashes,
      occurredAt: input.occurredAt,
      observedAt: input.observedAt,
      payload: {
        signal: input.signal,
        feedbackSignal: input.signal,
        ...(note === undefined ? {} : { note }),
        feedbackAuthority: feedbackAuthority(actor, authority),
        weakAssertion: feedbackAuthority(actor, authority) === "weak",
      },
    };
    const { event, batch } = makeContextBatch(contextInput, true);
    return await writeContextBatch(root, event, batch, input.idempotencyKey);
  } catch (error) {
    return resultError("invalid-input", storageMessage(error));
  }
}

function outcomeStatus(input: ContextOutcomeInput): ContextOutcomeStatus {
  const status = input.status ?? input.outcome;
  if (!status || !["success", "failure", "mixed", "unknown"].includes(status))
    invalid("outcome status must be success, failure, mixed, or unknown");
  return status;
}

function outcomeSources(input: ContextOutcomeInput): string[] {
  if (input.evidenceSources !== undefined) {
    if (!Array.isArray(input.evidenceSources)) invalid("outcome evidenceSources must be an array");
    if (input.evidenceSources.length > MAX_CONTEXT_EVENT_HASHES)
      invalid(`outcome evidenceSources must contain at most ${MAX_CONTEXT_EVENT_HASHES} items`);
  }
  for (const [value, label] of [
    [input.evidenceSource, "evidenceSource"],
    [input.source, "source"],
  ] as const) {
    if (value !== undefined) text(value, label);
  }
  if (input.evidenceSources !== undefined)
    for (const [index, value] of input.evidenceSources.entries())
      text(value, `evidenceSources[${index}]`);
  const values = [
    ...(input.evidenceSources ?? []),
    ...(input.evidenceSource === undefined ? [] : [input.evidenceSource]),
    ...(input.source === undefined ? [] : [input.source]),
  ];
  return [...new Set(values.map((value) => value.toLowerCase()))];
}

function metricObject(metrics: Readonly<Record<string, unknown>>): Record<string, unknown> {
  checkedBoundedRecord(metrics, "metrics");
  const normalized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(metrics)) {
    text(key, "metric name", 128);
    if (
      value !== null &&
      typeof value !== "string" &&
      typeof value !== "boolean" &&
      typeof value !== "number"
    )
      invalid(`metric ${key} must be a scalar`);
    if (typeof value === "number" && !Number.isFinite(value))
      invalid(`metric ${key} must be finite`);
    normalized[key] = value;
  }
  return normalized;
}

function classifyOutcome(
  input: ContextOutcomeInput,
  authority: ContextActorAuthority,
  references: ValidatedContextReferences,
): ContextOutcomeEvidenceClassification {
  if (references.repetitionDetected) return "non-independent-repetition";
  if (authority === "human" && input.evidenceGrade === "human-asserted") return "human-asserted";
  if (
    references.evidenceRows.some((row) =>
      ["assistant", "agent"].includes(row.actorKind.toLowerCase()),
    ) ||
    (references.evidenceRows.length === 0 && authority === "agent")
  )
    return "agent-self-report";
  if (references.preIntervention) return "pre-intervention";
  if (references.evidenceRows.length === 0) return "unknown";
  return "independent";
}

function gateEvidenceIsAccepted(
  references: ValidatedContextReferences,
  requestedMetrics: ClosedLoopCanonicalMetrics | null,
  requestedUnresolved: boolean,
): boolean {
  if (
    requestedMetrics === null ||
    requestedMetrics.unresolved !== requestedUnresolved ||
    references.evidenceRows.length === 0 ||
    references.repetitionDetected
  )
    return false;
  const evidenceTimes = references.evidenceRows.map(eventTime);
  if (evidenceTimes.some((time) => time === null)) return false;
  const interventionTimes = references.interventionRows.map(eventTime);
  if (interventionTimes.some((time) => time === null)) return false;
  const knownInterventionTimes = interventionTimes as number[];
  const latestIntervention =
    knownInterventionTimes.length > 0 ? Math.max(...knownInterventionTimes) : null;
  return references.evidenceRows.every((row, index) => {
    const origin = jsonRecord(row.originJson);
    const source =
      origin.source && typeof origin.source === "object" && !Array.isArray(origin.source)
        ? (origin.source as Record<string, unknown>)
        : {};
    const sourceKind = typeof source.sourceKind === "string" ? source.sourceKind : "";
    const adapterRecipe = typeof source.adapterRecipe === "string" ? source.adapterRecipe : "";
    const metrics = parseClosedLoopEvaluatorMetrics(jsonRecord(row.payloadJson));
    return (
      isTrustedClosedLoopEvaluatorSource({
        kind: row.kind,
        sourceKind,
        adapterRecipe,
      }) &&
      !isUntrustedEvaluatorActor(row.actorKind) &&
      metrics !== null &&
      canonicalMetricsEqual(metrics, requestedMetrics) &&
      (latestIntervention === null || evidenceTimes[index]! > latestIntervention)
    );
  });
}

export async function recordContextOutcome(
  root: string,
  input: ContextOutcomeInput,
): Promise<ContextEventResult<ContextEventRecord>> {
  try {
    checkedBoundedRecord(input, "outcome input");
    const status = outcomeStatus(input);
    const evidenceSources = outcomeSources(input);
    const evidenceGrade = input.evidenceGrade;
    if (!CONTEXT_OUTCOME_EVIDENCE_GRADES.includes(evidenceGrade))
      invalid(`unsupported outcome evidence grade ${String(evidenceGrade)}`);
    if (!CONTEXT_TREATMENT_ARMS.includes(input.treatmentArm))
      invalid(`unsupported treatment arm ${String(input.treatmentArm)}`);
    if (typeof input.unresolved !== "boolean") invalid("outcome unresolved must be boolean");
    const actor = checkedActor(input.actor);
    const authority = checkedAuthority(actor, input.actorAuthority);
    const interventionEventIds = hashes(input.interventionEventIds, "interventionEventIds");
    const knownInterventionLineage = hashes(
      input.knownInterventionLineage,
      "knownInterventionLineage",
    );
    const inputEventIds = hashes(input.inputEventIds, "inputEventIds");
    const inputHashes = hashes(input.inputHashes, "inputHashes");
    const references = await validateContextReferences(root, {
      contextSessionId: input.contextSessionId,
      interventionEventIds,
      knownInterventionLineage,
      inputEventIds,
    });
    if (!references.ok) return references;
    const classification = classifyOutcome(input, authority, references.value);
    const gateInput = evidenceGrade === "gate-observed" && status === "success";
    const requestedMetrics = gateInput ? parseClosedLoopEvaluatorMetrics(input.metrics) : null;
    if (gateInput && !gateEvidenceIsAccepted(references.value, requestedMetrics, input.unresolved))
      return resultError(
        "invalid-input",
        "gate-observed success requires trusted post-intervention evaluator evidence with matching canonical metrics",
      );
    const contextInput: ContextEventInput = {
      kind: "context.outcome.observed" as ContextInterventionEventKind,
      contextSessionId: input.contextSessionId,
      idempotencyKey: input.idempotencyKey,
      actor,
      actorAuthority: authority,
      interventionEventIds,
      knownInterventionLineage,
      inputEventIds,
      inputHashes,
      occurredAt: input.occurredAt,
      observedAt: input.observedAt,
      payload: {
        status,
        outcome: status,
        outcomeStatus: status,
        evidenceGrade,
        evidenceSources,
        ...(evidenceSources[0] ? { evidenceSource: evidenceSources[0] } : {}),
        treatmentArm: input.treatmentArm,
        metrics: metricObject(input.metrics),
        evidenceClassification: classification,
        unresolved: input.unresolved,
        evidenceIndependence: classification === "independent" ? "independent" : "non-independent",
        association: "intervention-lineage",
        causalClaim: false,
        interventionEventIds,
        knownInterventionLineage,
        interventionLineage: {
          interventionEventIds,
          knownInterventionLineage,
          association: "observational",
        },
      },
    };
    const { event, batch } = makeContextBatch(contextInput, true);
    return await writeContextBatch(root, event, batch, input.idempotencyKey);
  } catch (error) {
    return resultError("invalid-input", storageMessage(error));
  }
}

async function publishPendingContextEventBatches(
  root: string,
): Promise<ContextEventResult<undefined>> {
  const listed = await listContextSessions(root);
  if (!listed.ok) return resultError("storage-error", listed.error.message);
  for (const session of listed.value) {
    if (session.pendingEventBatchHashes.length === 0) continue;
    const recovered = await readContextSession(root, session.contextSessionId);
    if (
      !recovered.ok &&
      !(
        recovered.error.code === "storage-error" &&
        /\bENOENT\b|no such file or directory/u.test(recovered.error.message)
      )
    )
      return resultError("storage-error", recovered.error.message);
  }
  return { ok: true, value: undefined };
}

export async function readContextEvent(
  root: string,
  options: ContextEventLookupOptions,
): Promise<ContextEventResult<ContextEventProjectionRow | null>> {
  try {
    const contextSessionId = text(options.contextSessionId, "contextSessionId");
    const eventId = text(options.eventId, "eventId");
    if (!HASH.test(eventId)) invalid("eventId must be a SHA-256 event ID");
    if (options.recoverPending !== false) {
      const published = await publishPendingContextEventBatches(root);
      if (!published.ok) return published;
    }
    const db = openAnalysis(join(root, "analysis", "chatlog.sqlite"));
    try {
      return { ok: true, value: queryContextEvent(db, contextSessionId, eventId) };
    } finally {
      db.close();
    }
  } catch (error) {
    return resultError("storage-error", `Could not read context event: ${storageMessage(error)}`);
  }
}

export async function readContextEvents(
  root: string,
  options: ContextEventReadOptions,
): Promise<ContextEventResult<ContextEventProjectionRow[]>> {
  try {
    const contextSessionId = text(options.contextSessionId, "contextSessionId");
    const kinds = options.kinds === undefined ? undefined : [...options.kinds];
    if (kinds && !kinds.every((kind) => CONTEXT_EVENT_SET.has(kind)))
      invalid("context event read kinds must be canonical context event kinds");
    if (
      options.limit !== undefined &&
      (!Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > 1_000)
    )
      invalid("context event read limit must be between 1 and 1000");
    if (options.recoverPending !== false) {
      const published = await publishPendingContextEventBatches(root);
      if (!published.ok) return published;
    }
    const db = openAnalysis(join(root, "analysis", "chatlog.sqlite"));
    try {
      return {
        ok: true,
        value: queryContextEvents(db, contextSessionId, kinds, options.limit),
      };
    } finally {
      db.close();
    }
  } catch (error) {
    return resultError("storage-error", `Could not read context events: ${storageMessage(error)}`);
  }
}

export async function readContextEventKindCounts(
  root: string,
): Promise<ContextEventResult<Record<string, number>>> {
  try {
    const published = await publishPendingContextEventBatches(root);
    if (!published.ok) return published;
    const db = openAnalysis(join(root, "analysis", "chatlog.sqlite"));
    try {
      return { ok: true, value: queryContextEventKindCounts(db) };
    } finally {
      db.close();
    }
  } catch (error) {
    return resultError("storage-error", `Could not count context events: ${storageMessage(error)}`);
  }
}

export function contextIdempotencyIdentity(input: {
  contextSessionId: string;
  kind: ContextEventKind;
  idempotencyKey: string;
}): string {
  return sha256(stableStringify(input));
}

export function outcomeEvidenceIsIndependent(
  row: Pick<ContextEventProjectionRow, "evidenceClassification">,
): boolean {
  return row.evidenceClassification === "independent";
}

export function contextEventKinds(): readonly ContextEventKind[] {
  return CONTEXT_EVENT_KINDS;
}
