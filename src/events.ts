import { redact } from "./redact";

export const EVENT_SCHEMA_VERSION = 1 as const;
export const EVENT_ADAPTER_RECIPE = "chatlog-agent-events-v2";
export const EVENT_CAPTURE_POLICY_VERSION = "chatlog-redacted-capture-v1";

export const SEMANTIC_LOSS_CODES = [
  "capture-policy-omission",
  "provider-field-unsupported",
  "encrypted-content-unavailable",
  "attachment-body-excluded",
  "reasoning-excluded-from-projection",
  "unknown-well-formed-item",
  "partial-live-tail",
  "relation-target-missing",
] as const;

export type SemanticLossCode = (typeof SEMANTIC_LOSS_CODES)[number];
export const SEMANTIC_LOSS_CODE_SET: ReadonlySet<string> = new Set(SEMANTIC_LOSS_CODES);

export const ACTIVE_SOURCE_AUTHORITY_VERSION = "chatlog-active-sources-v1";

export const CONTEXT_EVENT_KINDS = [
  "context.bundle.proposed",
  "context.bundle.rendered",
  "context.bundle.emitted",
  "context.bundle.acknowledged",
  "context.recall.returned",
  "context.recall.branch.started",
  "context.recall.branch.completed",
  "context.recall.branch.failed",
  "context.recall.branch.cancelled",
  "context.recall.terminated",
  "context.procedure.returned",
  "context.advisor.advice",
  "context.delivery.failed",
  "context.feedback.asserted",
  "context.outcome.observed",
] as const;
export const AGENT_EVENT_KINDS = [
  "session.started",
  "session.ended",
  "message.created",
  "model.reasoning.observed",
  "tool.call.proposed",
  "tool.call.approved",
  "tool.call.denied",
  "tool.execution.observed",
  "tool.result.observed",
  "artifact.created",
  "artifact.modified",
  "branch.created",
  "branch.selected",
  "context.compacted",
  "human.correction",
  "evaluation.recorded",
  "provider.opaque",
  ...CONTEXT_EVENT_KINDS,
] as const;

export type AgentEventKind = (typeof AGENT_EVENT_KINDS)[number];

export const CONTEXT_EVENT_PROCESSOR = "chatlog-context-events";
export const CONTEXT_EVENT_RECIPE = "chatlog-context-intervention-v1";
export type ContextEventKind = (typeof CONTEXT_EVENT_KINDS)[number];
export type CaptureDispositionName = "normalized" | "opaque" | "redacted" | "omitted";

export interface CaptureDisposition {
  disposition: CaptureDispositionName;
  reason?: string;
}

export type EventActorKind =
  | "provider"
  | "assistant"
  | "human"
  | "tool"
  | "system"
  | "unknown"
  | string;
export interface EventActor {
  kind: EventActorKind;
  id?: string;
  name?: string;
}

export interface EventScope {
  sessionId?: string;
  conversationId?: string;
  branchId?: string;
  project?: string;
  cwd?: string;
}

export interface SourceRecordPosition {
  line?: number;
  record?: number;
}

export interface SourceEventReference {
  provider: string;
  harness: string;
  sourceKind: string;
  nativeSessionId?: string;
  nativeItemId?: string;
  sourcePath: string;
  recordPosition: SourceRecordPosition;
  adapterRecipe: string;
  capturePolicyVersion: string;
  redactedNativeRecordHash: string;
}

export interface SourceBatchReference {
  provider: string;
  harness: string;
  sourceKind: string;
  nativeSessionId?: string;
  sourcePath: string;
  adapterRecipe: string;
  capturePolicyVersion: string;
  redactedSourceHash: string;
}

export interface ObservedOrigin {
  kind: "observed";
  source: SourceEventReference;
}

export interface ChatlogOrigin {
  kind: "chatlog";
  processor: string;
  recipe: string;
  inputEventIds: readonly string[];
  inputHashes: readonly string[];
}

export interface ObservedBatchOrigin {
  kind: "observed";
  source: SourceBatchReference;
}

export interface ChatlogBatchOrigin {
  kind: "chatlog";
  processor: string;
  recipe: string;
  inputHashes: readonly string[];
}

export type EventOrigin = ObservedOrigin | ChatlogOrigin;
export type EventBatchOrigin = ObservedBatchOrigin | ChatlogBatchOrigin;

export interface EventRelations {
  parent?: string;
  branch?: string;
  causedBy?: readonly string[];
  correlatesWith?: readonly string[];
  derivedFrom?: readonly string[];
}

export type AgentEventPayload = Readonly<Record<string, unknown>>;

export interface AgentEventEnvelope {
  schemaVersion: typeof EVENT_SCHEMA_VERSION;
  eventId: string;
  kind: AgentEventKind;
  sequence: number;
  occurredAt?: string;
  observedAt?: string;
  actor: EventActor;
  scope: EventScope;
  origin: EventOrigin;
  relations: EventRelations;
  payload: AgentEventPayload;
  capture: CaptureDisposition;
}

export interface SemanticLossEntry {
  code: SemanticLossCode;
  reason: string;
  provider: string;
  harness: string;
  sourceItemKind: string;
  sourceLocator: string;
  count: number;
  firstObservedAt?: string;
  lastObservedAt?: string;
  affectedEventIds?: readonly string[];
  adapterRecipe: string;
  capturePolicyVersion: string;
  recoverable: boolean;
  sourcePath?: string;
  recordPosition?: SourceRecordPosition;
  nativeItemId?: string;
  details?: Readonly<Record<string, unknown>>;
}

export interface EventBatch {
  schemaVersion: typeof EVENT_SCHEMA_VERSION;
  origin: EventBatchOrigin;
  events: readonly AgentEventEnvelope[];
  semanticLoss: readonly SemanticLossEntry[];
  partialTail: boolean;
  /** Number of source items observed by the reader, including an incomplete tail. */
  sourceItemCount: number;
}

export interface EventBuildInput extends Omit<AgentEventEnvelope, "eventId" | "schemaVersion"> {
  eventId?: string;
}

export interface ObservedEventInput extends Omit<EventBuildInput, "origin"> {
  source: SourceEventReference;
}

export const EVENT_KINDS: ReadonlySet<string> = new Set(AGENT_EVENT_KINDS);
const canonicalEventBatches = new WeakSet<EventBatch>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export class EventValidationError extends Error {
  override readonly name = "EventValidationError";
}

export function invalidEvent(message: string): never {
  throw new EventValidationError(message);
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, child]) => [key, canonicalValue(child)]),
    );
  }
  return value;
}

export function stableStringify(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

export function sha256(value: string): string {
  return new Bun.CryptoHasher("sha256").update(value).digest("hex");
}

export function redactedHash(value: unknown): string {
  return sha256(stableStringify(redactValue(value)));
}

export function redactValue(value: unknown): unknown {
  if (typeof value === "string") return redact(value);
  if (Array.isArray(value)) return value.map(redactValue);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, child]) => [
        key,
        redactValue(child),
      ]),
    );
  return value;
}

export function capture(disposition: CaptureDispositionName, reason?: string): CaptureDisposition {
  if (disposition === "omitted" && !reason) invalidEvent("omitted capture requires a reason");
  return reason ? { disposition, reason } : { disposition };
}

export function makeObservedSource(
  source: Omit<SourceEventReference, "redactedNativeRecordHash">,
  nativeRecord: unknown,
): SourceEventReference {
  return {
    ...source,
    redactedNativeRecordHash: redactedHash(nativeRecord),
  };
}

export function makeObservedBatchOrigin(
  source: Omit<SourceBatchReference, "redactedSourceHash">,
  recordsOrHash: unknown,
): ObservedBatchOrigin {
  return {
    kind: "observed",
    source: {
      ...source,
      redactedSourceHash:
        typeof recordsOrHash === "string" && /^[a-f0-9]{64}$/.test(recordsOrHash)
          ? recordsOrHash
          : redactedHash(recordsOrHash),
    },
  };
}

export function eventIdentity(input: Omit<AgentEventEnvelope, "eventId">): string {
  return sha256(stableStringify(input));
}

export function makeEvent(input: EventBuildInput): AgentEventEnvelope {
  const candidate: Omit<AgentEventEnvelope, "eventId"> = {
    schemaVersion: EVENT_SCHEMA_VERSION,
    kind: input.kind,
    sequence: input.sequence,
    ...(input.occurredAt ? { occurredAt: input.occurredAt } : {}),
    ...(input.observedAt ? { observedAt: input.observedAt } : {}),
    actor: input.actor,
    scope: input.scope,
    origin: input.origin,
    relations: input.relations,
    payload: redactValue(input.payload) as AgentEventPayload,
    capture: input.capture,
  };
  return {
    ...candidate,
    eventId: input.eventId ?? eventIdentity(candidate),
  };
}

export function makeObservedEvent(input: ObservedEventInput): AgentEventEnvelope {
  return makeEvent({ ...input, origin: { kind: "observed", source: input.source } });
}

function assertString(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !value) invalidEvent(`${label} must be a non-empty string`);
}

function assertHash(value: unknown, label: string): asserts value is string {
  assertString(value, label);
  if (!/^[a-f0-9]{64}$/i.test(value)) invalidEvent(`${label} must be a SHA-256 hash`);
}

function assertTimestamp(value: unknown, label: string): void {
  if (value === undefined) return;
  assertString(value, label);
  if (!Number.isFinite(Date.parse(value))) invalidEvent(`${label} must be an ISO timestamp`);
}

function validatePosition(value: unknown, label: string): void {
  if (!isRecord(value)) invalidEvent(`${label} must be an object`);
  for (const key of ["line", "record"] as const) {
    if (value[key] !== undefined && (!Number.isSafeInteger(value[key]) || Number(value[key]) < 0))
      invalidEvent(`${label}.${key} must be a non-negative integer`);
  }
  if (value.line === undefined && value.record === undefined)
    invalidEvent(`${label} must include line or record`);
}

function validateCapture(value: unknown, label: string): CaptureDisposition {
  const captureValue = typeof value === "string" ? { disposition: value } : value;
  if (
    !isRecord(captureValue) ||
    !["normalized", "opaque", "redacted", "omitted"].includes(String(captureValue.disposition))
  )
    invalidEvent(`${label} has an unknown disposition`);
  const disposition = String(captureValue.disposition) as CaptureDispositionName;
  if (disposition === "omitted" && typeof captureValue.reason !== "string")
    invalidEvent(`${label} omitted disposition requires a reason`);
  if (captureValue.reason !== undefined) assertString(captureValue.reason, `${label}.reason`);
  return { disposition, ...(captureValue.reason ? { reason: captureValue.reason } : {}) };
}

function validateSourceEvent(value: unknown, label: string): SourceEventReference {
  if (!isRecord(value)) invalidEvent(`${label} must be an object`);
  for (const key of [
    "provider",
    "harness",
    "sourceKind",
    "sourcePath",
    "adapterRecipe",
    "capturePolicyVersion",
  ])
    assertString(value[key], `${label}.${key}`);
  validatePosition(value.recordPosition, `${label}.recordPosition`);
  assertHash(value.redactedNativeRecordHash, `${label}.redactedNativeRecordHash`);
  for (const key of ["nativeSessionId", "nativeItemId"])
    if (value[key] !== undefined) assertString(value[key], `${label}.${key}`);
  return value as unknown as SourceEventReference;
}

function validateSourceBatch(value: unknown, label: string): SourceBatchReference {
  if (!isRecord(value)) invalidEvent(`${label} must be an object`);
  for (const key of [
    "provider",
    "harness",
    "sourceKind",
    "sourcePath",
    "adapterRecipe",
    "capturePolicyVersion",
  ])
    assertString(value[key], `${label}.${key}`);
  assertHash(value.redactedSourceHash, `${label}.redactedSourceHash`);
  if (value.nativeSessionId !== undefined)
    assertString(value.nativeSessionId, `${label}.nativeSessionId`);
  return value as unknown as SourceBatchReference;
}

function validateOrigin(value: unknown, label: string): EventOrigin {
  if (!isRecord(value)) invalidEvent(`${label} must be an object`);
  if (value.kind === "observed")
    return { kind: "observed", source: validateSourceEvent(value.source, `${label}.source`) };
  if (value.kind === "chatlog") {
    assertString(value.processor, `${label}.processor`);
    assertString(value.recipe, `${label}.recipe`);
    if (
      !Array.isArray(value.inputEventIds) ||
      !value.inputEventIds.every((item) => typeof item === "string" && item)
    )
      invalidEvent(`${label}.inputEventIds must be non-empty strings`);
    if (
      !Array.isArray(value.inputHashes) ||
      !value.inputHashes.every((item) => /^[a-f0-9]{64}$/i.test(String(item)))
    )
      invalidEvent(`${label}.inputHashes must be SHA-256 hashes`);
    return value as unknown as ChatlogOrigin;
  }
  invalidEvent(`${label}.kind must be observed or chatlog`);
}
function validateContextEventOrigin(origin: EventOrigin, kind: string, label: string): void {
  if (!CONTEXT_EVENT_KINDS.includes(kind as ContextEventKind)) return;
  if (origin.kind !== "chatlog")
    invalidEvent(`${label}.kind must be chatlog for reserved context event kinds`);
  if (origin.processor !== CONTEXT_EVENT_PROCESSOR)
    invalidEvent(`${label}.processor must be ${CONTEXT_EVENT_PROCESSOR}`);
  if (origin.recipe !== CONTEXT_EVENT_RECIPE)
    invalidEvent(`${label}.recipe must be ${CONTEXT_EVENT_RECIPE}`);
}

function validateBatchOrigin(value: unknown, label: string): EventBatchOrigin {
  if (!isRecord(value)) invalidEvent(`${label} must be an object`);
  if (value.kind === "observed")
    return { kind: "observed", source: validateSourceBatch(value.source, `${label}.source`) };
  if (value.kind === "chatlog") {
    assertString(value.processor, `${label}.processor`);
    assertString(value.recipe, `${label}.recipe`);
    if (
      !Array.isArray(value.inputHashes) ||
      !value.inputHashes.every((item) => /^[a-f0-9]{64}$/i.test(String(item)))
    )
      invalidEvent(`${label}.inputHashes must be SHA-256 hashes`);
    return value as unknown as ChatlogBatchOrigin;
  }
  invalidEvent(`${label}.kind must be observed or chatlog`);
}

function validateRelations(value: unknown, label: string): EventRelations {
  if (!isRecord(value)) invalidEvent(`${label} must be an object`);
  for (const key of ["parent", "branch"] as const)
    if (value[key] !== undefined) assertString(value[key], `${label}.${key}`);
  for (const key of ["causedBy", "correlatesWith", "derivedFrom"] as const) {
    if (
      value[key] !== undefined &&
      (!Array.isArray(value[key]) || !value[key].every((item) => typeof item === "string" && item))
    )
      invalidEvent(`${label}.${key} must be string arrays`);
  }
  return value as unknown as EventRelations;
}

function validateLoss(value: unknown, label: string): SemanticLossEntry {
  if (!isRecord(value)) invalidEvent(`${label} must be an object`);
  if (typeof value.code !== "string" || !SEMANTIC_LOSS_CODE_SET.has(value.code))
    invalidEvent(`${label}.code is unknown`);
  assertString(value.reason, `${label}.reason`);
  for (const key of [
    "provider",
    "harness",
    "sourceItemKind",
    "sourceLocator",
    "adapterRecipe",
    "capturePolicyVersion",
  ])
    assertString(value[key], `${label}.${key}`);
  if (!Number.isSafeInteger(value.count) || Number(value.count) < 1)
    invalidEvent(`${label}.count must be a positive integer`);
  if (value.firstObservedAt !== undefined)
    assertTimestamp(value.firstObservedAt, `${label}.firstObservedAt`);
  if (value.lastObservedAt !== undefined)
    assertTimestamp(value.lastObservedAt, `${label}.lastObservedAt`);
  if (
    typeof value.firstObservedAt === "string" &&
    typeof value.lastObservedAt === "string" &&
    Date.parse(value.lastObservedAt) < Date.parse(value.firstObservedAt)
  )
    invalidEvent(`${label}.lastObservedAt must not precede firstObservedAt`);
  if (value.affectedEventIds !== undefined) {
    if (
      !Array.isArray(value.affectedEventIds) ||
      !value.affectedEventIds.every((item) => /^[a-f0-9]{64}$/i.test(String(item)))
    )
      invalidEvent(`${label}.affectedEventIds must be SHA-256 hashes`);
  }
  if (typeof value.recoverable !== "boolean") invalidEvent(`${label}.recoverable must be boolean`);
  if (value.sourcePath !== undefined) assertString(value.sourcePath, `${label}.sourcePath`);
  if (value.recordPosition !== undefined)
    validatePosition(value.recordPosition, `${label}.recordPosition`);
  if (value.nativeItemId !== undefined) assertString(value.nativeItemId, `${label}.nativeItemId`);
  if (value.details !== undefined && !isRecord(value.details))
    invalidEvent(`${label}.details must be an object`);
  return value as unknown as SemanticLossEntry;
}

export function validateSemanticLoss(value: unknown, label = "semantic loss"): SemanticLossEntry {
  return validateLoss(value, label);
}

export function makeSemanticLoss(input: SemanticLossEntry): SemanticLossEntry {
  return validateLoss(redactValue(input), "semantic loss");
}

export function validateAgentEvent(value: unknown, label = "event"): AgentEventEnvelope {
  if (!isRecord(value)) invalidEvent(`${label} must be an object`);
  if (value.schemaVersion !== EVENT_SCHEMA_VERSION)
    invalidEvent(`${label}.schemaVersion must be 1`);
  assertHash(value.eventId, `${label}.eventId`);
  if (typeof value.kind !== "string" || !EVENT_KINDS.has(value.kind))
    invalidEvent(`${label}.kind is unknown`);
  if (!Number.isSafeInteger(value.sequence) || Number(value.sequence) < 0)
    invalidEvent(`${label}.sequence must be a non-negative integer`);
  assertTimestamp(value.occurredAt, `${label}.occurredAt`);
  assertTimestamp(value.observedAt, `${label}.observedAt`);
  if (!isRecord(value.actor)) invalidEvent(`${label}.actor must be an object`);
  assertString(value.actor.kind, `${label}.actor.kind`);
  if (value.actor.id !== undefined) assertString(value.actor.id, `${label}.actor.id`);
  if (value.actor.name !== undefined) assertString(value.actor.name, `${label}.actor.name`);
  if (!isRecord(value.scope)) invalidEvent(`${label}.scope must be an object`);
  for (const key of ["sessionId", "conversationId", "branchId", "project", "cwd"])
    if (value.scope[key] !== undefined) assertString(value.scope[key], `${label}.scope.${key}`);
  const origin = validateOrigin(value.origin, `${label}.origin`);
  validateContextEventOrigin(origin, value.kind, `${label}.origin`);
  validateRelations(value.relations, `${label}.relations`);
  if (!isRecord(value.payload)) invalidEvent(`${label}.payload must be an object`);
  const normalizedCapture = validateCapture(value.capture, `${label}.capture`);
  const normalized = { ...value, capture: normalizedCapture } as unknown as AgentEventEnvelope;
  const { eventId: _eventId, ...identity } = normalized;
  if (eventIdentity(identity) !== normalized.eventId)
    invalidEvent(`${label}.eventId does not match canonical event identity`);
  return normalized;
}

export function validateEventBatch(value: unknown): EventBatch {
  if (!isRecord(value)) invalidEvent("event batch must be an object");
  if (value.schemaVersion !== EVENT_SCHEMA_VERSION)
    invalidEvent("event batch schemaVersion must be 1");
  const origin = validateBatchOrigin(value.origin, "batch.origin");
  if (!Array.isArray(value.events)) invalidEvent("batch.events must be an array");
  const events = value.events.map((event, index) =>
    validateAgentEvent(event, `batch.events[${index}]`),
  );
  const ids = new Set<string>();
  const nativeIds = new Set<string>();
  let priorSequence = -1;
  for (const [index, event] of events.entries()) {
    if (ids.has(event.eventId)) invalidEvent(`duplicate event id ${event.eventId}`);
    ids.add(event.eventId);
    if (event.sequence <= priorSequence)
      invalidEvent("events must be ordered by increasing sequence");
    priorSequence = event.sequence;
    if (event.sequence !== index) invalidEvent("event sequences must be contiguous from zero");
    if (event.origin.kind === "observed") {
      const nativeId = event.origin.source.nativeItemId;
      if (nativeId) {
        const key = `${event.origin.source.sourcePath}\u0000${nativeId}`;
        if (nativeIds.has(key)) invalidEvent(`duplicate native item id ${nativeId}`);
        nativeIds.add(key);
      }
    }
    const references: string[] = [];
    if (event.relations.parent) references.push(event.relations.parent);
    if (event.relations.branch) references.push(event.relations.branch);
    for (const key of ["causedBy", "correlatesWith", "derivedFrom"] as const)
      references.push(...(event.relations[key] ?? []));
    for (const reference of references)
      if (!ids.has(reference)) invalidEvent(`dangling relation ${reference} in ${event.eventId}`);
  }
  if (!Array.isArray(value.semanticLoss)) invalidEvent("batch.semanticLoss must be an array");
  const semanticLoss = value.semanticLoss.map((item, index) =>
    validateLoss(item, `batch.semanticLoss[${index}]`),
  );
  if (typeof value.partialTail !== "boolean") invalidEvent("batch.partialTail must be boolean");
  if (!Number.isSafeInteger(value.sourceItemCount) || Number(value.sourceItemCount) < 0)
    invalidEvent("batch.sourceItemCount must be a non-negative integer");
  return {
    schemaVersion: EVENT_SCHEMA_VERSION,
    origin,
    events,
    semanticLoss,
    partialTail: value.partialTail,
    sourceItemCount: Number(value.sourceItemCount),
  };
}

export function assertEventBatch(value: unknown): asserts value is EventBatch {
  validateEventBatch(value);
}

export function freezeEventBatch(batch: EventBatch): EventBatch {
  const freeze = <T>(value: T): T => {
    if (value && typeof value === "object") {
      for (const child of Object.values(value as Record<string, unknown>)) freeze(child);
      Object.freeze(value);
    }
    return value;
  };
  return freeze(batch);
}

export function canonicalEventBatch(value: EventBatch): EventBatch {
  if (canonicalEventBatches.has(value)) return value;
  const canonical = freezeEventBatch(validateEventBatch(redactValue(value)));
  canonicalEventBatches.add(canonical);
  return canonical;
}
