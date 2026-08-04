import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { collectContextCandidates } from "./context-candidates";
import type { ContextCandidateCollectionResult } from "./context-candidates";
import { readAuthorizedContextRelease } from "./context-release";
import type { AuthorizedContextRelease } from "./context-release";
import { publishContextEventBatches } from "./context-event-outbox";
import {
  readContextEvents,
  recordContextEvent,
  recordContextFeedback,
  recordContextOutcome,
  stageContextEvent,
} from "./context-events";
import type {
  ContextEventProjectionRow,
  ContextEventRecord,
  ContextEventResult,
  ContextFeedbackInput,
  ContextOutcomeInput,
} from "./context-events";
import { planContext, validateContextBundleHash } from "./context-planner";
import { CONTEXT_POLICY_VERSION } from "./context-policy";
import {
  clearContextEventOutbox,
  commitContextBundleBudget,
  listContextSessions,
  MAX_STAGED_RECALL_EVENT_BATCHES,
  openContextSession,
  readContextSession,
  reserveContextBundleAttempt,
} from "./context-session";
import type { ContextSessionStoreResult } from "./context-session";
import type {
  ContextBudget,
  ContextBundle,
  ContextDeliveryMode,
  ContextExposure,
  ContextItemKind,
  ContextReceiptEvidence,
  ContextRequest,
  ContextRiskClass,
  ContextSession,
  ContextTarget,
} from "./context-types";
import { MAX_CONTEXT_BUDGET } from "./context-types";
import { selectDeliveryAdapter } from "./delivery-adapters";
import type { DeliveryAdapter, DeliveryError, EncodedContext } from "./delivery-adapters";
import { sha256, stableStringify } from "./events";
import { readPublishedInsightMemory } from "./experience-memory-store";
import type { InsightScope } from "./insights";
import { ActiveProjectionGuard } from "./source-authority";
import { withContextFinalizationLock } from "./lock";

export const CONTEXT_DELIVERY_POLICY_VERSION = "chatlog-context-delivery-v1";

export type ContextPlaneErrorCode =
  | "invalid-input"
  | "source-unavailable"
  | "projection-drift"
  | "session-error"
  | "planning-error"
  | "delivery-error"
  | "event-error"
  | "release-denied";

export type ContextPlaneResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: { code: ContextPlaneErrorCode; message: string } };

export interface StartContextPlaneSessionInput {
  nativeSessionId: string | null;
  target: ContextTarget;
  projectIdentity: string;
  cwd: string;
  domainPolicy: string[];
  path: string | null;
  totalBudget: ContextBudget;
  createdAt?: string;
}

export interface PrepareContextInput {
  contextSessionId: string;
  task: string;
  query: string;
  scope: InsightScope;
  allowedItemKinds: ContextItemKind[];
  riskCeiling: ContextRiskClass;
  freshAfter: string | null;
  budget: ContextBudget;
  fixedInstructionTokens: number;
  deliveryMode: ContextDeliveryMode;
  exposure: ContextExposure;
  now?: string;
  candidateIds?: string[];
}

export interface DeliverContextInput {
  nativeSessionId: string | null;
  target: ContextTarget;
  projectIdentity: string;
  cwd: string;
  domain: string;
  path?: string | null;
  task: string;
  query: string;
  budget: ContextBudget;
  deliveryMode: ContextDeliveryMode;
  receiptEvidence: ContextReceiptEvidence;
  receipt: Record<string, unknown>;
  now?: string;
}

export interface DeliverSessionContextInput {
  contextSessionId: string;
  task: string;
  query: string;
  deliveryMode: ContextDeliveryMode;
  receiptEvidence: ContextReceiptEvidence;
  receipt: Record<string, unknown>;
  now?: string;
}

export interface DeliveredContext {
  content: string;
  contextSessionId: string;
  bundleHash: string;
  gateHash: string;
  itemId: string;
  event: ContextEventProjectionRow;
}

export interface PreparedContext {
  session: ContextSession;
  request: ContextRequest;
  /** Candidate filter is part of the signed planning input and survives serialization. */
  candidateIds?: readonly string[];
  bundle: ContextBundle;
  encoded: EncodedContext;
  proposed: ContextEventProjectionRow;
  rendered: ContextEventProjectionRow;
}

export interface ConfirmContextEmissionInput {
  prepared: PreparedContext;
  releaseGateHash: string;
  receiptEvidence: ContextReceiptEvidence;
  receipt: Record<string, unknown>;
  occurredAt?: string;
}

export interface ConfirmedContextEmission {
  session: ContextSession;
  event: ContextEventProjectionRow;
}

function failure<T>(code: ContextPlaneErrorCode, message: string): ContextPlaneResult<T> {
  return { ok: false, error: { code, message } };
}

function databaseProjection(root: string): ContextPlaneResult<string> {
  const databasePath = join(resolve(root), "analysis", "chatlog.sqlite");
  if (!existsSync(databasePath))
    return failure("source-unavailable", "Chatlog analysis database is unavailable");
  let db: Database | undefined;
  try {
    db = new Database(databasePath, { readonly: true, create: false });
    return {
      ok: true,
      value: new ActiveProjectionGuard(resolve(root)).assert(db).manifestSourcesHash,
    };
  } catch (error) {
    return failure("projection-drift", error instanceof Error ? error.message : String(error));
  } finally {
    db?.close();
  }
}

const START_BUDGET_KEYS = ["tokens", "results", "latencyMs", "costUsd"] as const;

function startRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function startNonEmptyText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function startNullableText(value: unknown): value is string | null {
  return value === null || startNonEmptyText(value);
}

function startBudget(value: unknown): value is ContextBudget {
  if (!startRecord(value) || Object.keys(value).length !== START_BUDGET_KEYS.length) return false;
  for (const key of START_BUDGET_KEYS) {
    const amount = value[key];
    if (typeof amount !== "number" || !Number.isFinite(amount) || amount < 0) return false;
    if (key !== "costUsd" && !Number.isSafeInteger(amount)) return false;
    if (amount > MAX_CONTEXT_BUDGET[key]) return false;
  }
  return true;
}

function validStart(input: unknown): string | null {
  if (!startRecord(input)) return "context session input must be an object";
  if (!startRecord(input.target)) return "target must be an object";
  if (
    !startNonEmptyText(input.target.provider) ||
    !startNonEmptyText(input.target.harness) ||
    !startNullableText(input.target.model) ||
    !startNonEmptyText(input.target.role)
  )
    return "target provider, harness, model, and role must be non-empty text";
  if (!startNullableText(input.nativeSessionId))
    return "nativeSessionId must be non-empty text or null";
  if (!startNonEmptyText(input.projectIdentity) || !startNonEmptyText(input.cwd))
    return "project and cwd must be non-empty text";
  if (
    !Array.isArray(input.domainPolicy) ||
    input.domainPolicy.length === 0 ||
    input.domainPolicy.some((domain) => !startNonEmptyText(domain))
  )
    return "domainPolicy must be a non-empty array of strings";
  if (!startNullableText(input.path)) return "path must be non-empty text or null";
  if (!startBudget(input.totalBudget)) return "totalBudget has an invalid shape";
  if (input.createdAt !== undefined && !startNonEmptyText(input.createdAt))
    return "createdAt must be non-empty text";
  return null;
}

export async function startContextPlaneSession(
  root: string,
  input: StartContextPlaneSessionInput,
): Promise<ContextPlaneResult<ContextSession>> {
  const issue = validStart(input);
  if (issue) return failure("invalid-input", issue);
  const published = await readPublishedInsightMemory(root);
  if (!published.ok) return failure("source-unavailable", published.error.message);
  if (published.value.pointer.projectIdentity !== input.projectIdentity)
    return failure(
      "projection-drift",
      "published insight project does not match the session project",
    );
  const evidenceProjection = databaseProjection(root);
  if (!evidenceProjection.ok) return evidenceProjection;
  const created = await openContextSession(root, {
    nativeSessionId: input.nativeSessionId,
    provider: input.target.provider,
    harness: input.target.harness,
    model: input.target.model,
    role: input.target.role,
    projectIdentity: input.projectIdentity,
    cwd: input.cwd,
    domainPolicy: [...input.domainPolicy],
    path: input.path,
    pinnedInsightProjectionHash: published.value.pointer.outputHash,
    pinnedEvidenceProjectionHash: evidenceProjection.value,
    selectionPolicyVersion: CONTEXT_POLICY_VERSION,
    deliveryPolicyVersion: CONTEXT_DELIVERY_POLICY_VERSION,
    totalBudget: { ...input.totalBudget },
    createdAt: input.createdAt ?? new Date().toISOString(),
  });
  return created.ok
    ? { ok: true, value: created.value }
    : failure("session-error", created.error.message);
}

function collectionError<T>(
  result: Extract<ContextCandidateCollectionResult, { ok: false }>,
): ContextPlaneResult<T> {
  return failure(result.error.code, result.error.message);
}

function eventRow(
  result: ContextEventResult<{ event: { eventId: string }; batchHash: string }>,
  rows: readonly ContextEventProjectionRow[],
): ContextPlaneResult<ContextEventProjectionRow> {
  if (!result.ok) return failure("event-error", result.error.message);
  const row = rows.find((candidate) => candidate.eventId === result.value.event.eventId);
  return row
    ? { ok: true, value: row }
    : failure("event-error", "recorded context event is missing from its projection");
}

async function recordPreparedEvent(
  root: string,
  kind: "context.bundle.proposed" | "context.bundle.rendered",
  bundle: ContextBundle,
  encoded?: EncodedContext,
): Promise<ContextPlaneResult<ContextEventProjectionRow>> {
  const result = await recordContextEvent(root, {
    kind,
    contextSessionId: bundle.contextSessionId,
    idempotencyKey: `${bundle.bundleHash}:${kind}`,
    actor: { kind: "system", id: "chatlog-context-plane" },
    bundleHash: bundle.bundleHash,
    inputHash: bundle.inputHash,
    policyHash: bundle.policyHash,
    inputHashes: [bundle.pinnedInsightProjectionHash, bundle.pinnedEvidenceProjectionHash],
    ...(encoded ? { contentHash: encoded.contentHash } : {}),
    bounds: { ...bundle.budget },
    provenance: {
      target: bundle.target,
      deliveryMode: bundle.deliveryMode,
      exposure: bundle.exposure,
    },
    payload: {
      itemIds: bundle.items.map((item) => item.id),
      omissionCount: bundle.omissions.length,
      ...(encoded
        ? {
            adapterId: encoded.adapterId,
            adapterVersion: encoded.adapterVersion,
            estimatedTokens: encoded.estimatedTokens,
            supportedReceiptEvidence: encoded.supportedReceiptEvidence,
          }
        : {}),
    },
    occurredAt: bundle.plannedAt,
  });
  const rows = await readContextEvents(root, {
    contextSessionId: bundle.contextSessionId,
    kinds: [kind],
  });
  if (!rows.ok) return failure("event-error", rows.error.message);
  return eventRow(result, rows.value);
}

async function recordDeliveryFailure(
  root: string,
  bundle: ContextBundle,
  adapter: DeliveryAdapter,
  error: DeliveryError,
  phase: string,
): Promise<ContextPlaneResult<true>> {
  const idempotencyKey = `${bundle.bundleHash}:delivery.failed:${phase}:${error.code}`;
  const recorded = await recordContextEvent(root, {
    kind: "context.delivery.failed",
    contextSessionId: bundle.contextSessionId,
    idempotencyKey,
    actor: { kind: "provider", id: adapter.id },
    actorAuthority: "provider",
    bundleHash: bundle.bundleHash,
    inputHash: bundle.inputHash,
    policyHash: bundle.policyHash,
    inputHashes: [bundle.pinnedInsightProjectionHash, bundle.pinnedEvidenceProjectionHash],
    bounds: { ...bundle.budget },
    provenance: {
      phase,
      code: error.code,
      adapterId: adapter.id,
      adapterVersion: adapter.version,
      target: bundle.target,
      deliveryMode: bundle.deliveryMode,
    },
    payload: {
      phase,
      code: error.code,
      message: error.message.slice(0, 512),
      adapterId: adapter.id,
      adapterVersion: adapter.version,
      target: bundle.target,
      deliveryMode: bundle.deliveryMode,
    },
    occurredAt: bundle.plannedAt,
  });
  return recorded.ok
    ? { ok: true, value: true }
    : failure("event-error", `Could not record delivery failure: ${recorded.error.message}`);
}

function requestTokenBudgetIssue(request: ContextRequest, encoded: EncodedContext): string | null {
  return encoded.estimatedTokens <= request.budget.tokens
    ? null
    : `encoded context needs ${encoded.estimatedTokens} tokens but the request allows only ${request.budget.tokens}`;
}

function canonicalEqual(left: unknown, right: unknown): boolean {
  return stableStringify(left) === stableStringify(right);
}

export async function prepareContext(
  root: string,
  input: PrepareContextInput,
): Promise<ContextPlaneResult<PreparedContext>> {
  const opened = await readContextSession(root, input.contextSessionId);
  if (!opened.ok) return failure("session-error", opened.error.message);
  const selected = selectDeliveryAdapter(opened.value.target, input.deliveryMode);
  if (!selected.ok) return failure("delivery-error", selected.error.message);
  const candidateIds = input.candidateIds;
  if (
    candidateIds !== undefined &&
    (!Array.isArray(candidateIds) ||
      candidateIds.some((candidateId) => typeof candidateId !== "string"))
  )
    return failure("invalid-input", "candidateIds must be an array of strings");
  const request: ContextRequest = {
    task: input.task,
    query: input.query,
    contextSessionId: opened.value.contextSessionId,
    target: { ...opened.value.target },
    capabilities: {
      ...selected.value.capabilities,
      receiptEvidence: [...selected.value.capabilities.receiptEvidence],
    },
    scope: { ...input.scope },
    allowedItemKinds: [...input.allowedItemKinds],
    riskCeiling: input.riskCeiling,
    freshAfter: input.freshAfter,
    budget: { ...input.budget },
    fixedInstructionTokens: input.fixedInstructionTokens,
    deliveryMode: input.deliveryMode,
    exposure: input.exposure,
    now: input.now ?? new Date().toISOString(),
  };
  const collected = await collectContextCandidates(root, request);
  if (!collected.ok) return collectionError(collected);
  const candidates =
    candidateIds === undefined
      ? collected.value.candidates
      : collected.value.candidates.filter((candidate) => candidateIds.includes(candidate.id));
  if (
    collected.value.insightProjectionHash !== opened.value.pinnedInsightProjectionHash ||
    collected.value.evidenceProjectionHash !== opened.value.pinnedEvidenceProjectionHash
  )
    return failure(
      "projection-drift",
      "current sources do not match the session-pinned projections",
    );
  const planned = planContext(request, opened.value, candidates);
  if (!planned.ok) return failure("planning-error", planned.error.message);
  const attempted = await reserveContextBundleAttempt(
    root,
    opened.value.contextSessionId,
    planned.value.bundleHash,
  );
  if (!attempted.ok)
    return failure(
      "session-error",
      `bundle attempt reservation failed: ${attempted.error.message}`,
    );
  const rendered = selected.value.render(planned.value);
  if (!rendered.ok) {
    const failureEvent = await recordDeliveryFailure(
      root,
      planned.value,
      selected.value,
      rendered.error,
      "render",
    );
    return failureEvent.ok ? failure("delivery-error", rendered.error.message) : failureEvent;
  }
  const budgetIssue = requestTokenBudgetIssue(request, rendered.value);
  if (budgetIssue) {
    const failureEvent = await recordDeliveryFailure(
      root,
      planned.value,
      selected.value,
      {
        code: "budget-overflow",
        message: budgetIssue,
        adapterId: selected.value.id,
        mode: planned.value.deliveryMode,
        target: planned.value.target,
      },
      "admission",
    );
    return failureEvent.ok ? failure("delivery-error", budgetIssue) : failureEvent;
  }
  const proposed = await recordPreparedEvent(root, "context.bundle.proposed", planned.value);
  if (!proposed.ok) return proposed;
  const renderedEvent = await recordPreparedEvent(
    root,
    "context.bundle.rendered",
    planned.value,
    rendered.value,
  );
  if (!renderedEvent.ok) return renderedEvent;
  return {
    ok: true,
    value: {
      session: attempted.value.session,
      request,
      ...(candidateIds === undefined ? {} : { candidateIds: [...candidateIds] }),
      bundle: planned.value,
      encoded: rendered.value,
      proposed: proposed.value,
      rendered: renderedEvent.value,
    },
  };
}

async function verifyReleaseGate(
  root: string,
  prepared: PreparedContext,
  expectedGateHash: string,
): Promise<ContextPlaneResult<AuthorizedContextRelease>> {
  if (prepared.bundle.exposure === "shadow")
    return failure("release-denied", "shadow context cannot be emitted to a live agent");
  const authorized = await readAuthorizedContextRelease(root);
  if (!authorized.ok) return failure("release-denied", authorized.error.message);
  if (authorized.value.pointer.gateHash !== expectedGateHash)
    return failure("release-denied", "authorized release gate changed; prepare a new confirmation");
  const gate = authorized.value.gate;
  if (gate.stage !== prepared.bundle.exposure)
    return failure("release-denied", "release gate stage does not match bundle exposure");
  if (prepared.bundle.items.length !== 1)
    return failure(
      "release-denied",
      "an authorized release may contain exactly one evaluated candidate",
    );
  const item = prepared.bundle.items[0];
  if (!item || item.id !== gate.candidate.id || sha256(item.content) !== gate.candidate.contentHash)
    return failure(
      "release-denied",
      "release gate does not authorize the selected candidate content",
    );
  return { ok: true, value: authorized.value };
}

function recordValue(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function preparedStructureIssue(prepared: unknown): string | null {
  if (!recordValue(prepared)) return "prepared context must be an object";
  const session = prepared.session;
  if (
    !recordValue(session) ||
    typeof session.contextSessionId !== "string" ||
    !recordValue(session.target) ||
    !recordValue(session.budget) ||
    !recordValue(session.budget.total)
  )
    return "prepared session is malformed";
  const request = prepared.request;
  if (
    !recordValue(request) ||
    typeof request.contextSessionId !== "string" ||
    typeof request.task !== "string" ||
    typeof request.query !== "string" ||
    !recordValue(request.target) ||
    !recordValue(request.scope) ||
    !recordValue(request.budget) ||
    !recordValue(request.capabilities) ||
    !Array.isArray(request.allowedItemKinds) ||
    !Array.isArray(request.capabilities.receiptEvidence)
  )
    return "prepared request is malformed";
  if (
    !Number.isSafeInteger(request.fixedInstructionTokens) ||
    (request.fixedInstructionTokens as number) < 0 ||
    (request.fixedInstructionTokens as number) > MAX_CONTEXT_BUDGET.tokens
  )
    return "prepared request contains invalid token or item bounds";
  if (prepared.candidateIds !== undefined) {
    if (
      !Array.isArray(prepared.candidateIds) ||
      !prepared.candidateIds.every((candidateId) => typeof candidateId === "string")
    )
      return "prepared candidate filter is malformed";
  }
  const bundle = prepared.bundle;
  if (
    !recordValue(bundle) ||
    typeof bundle.contextSessionId !== "string" ||
    !recordValue(bundle.target) ||
    !recordValue(bundle.budget) ||
    !Array.isArray(bundle.items) ||
    !Array.isArray(bundle.omissions)
  )
    return "prepared bundle is malformed";
  const encoded = prepared.encoded;
  if (
    !recordValue(encoded) ||
    typeof encoded.contextSessionId !== "string" ||
    typeof encoded.bundleHash !== "string" ||
    typeof encoded.adapterId !== "string" ||
    typeof encoded.adapterVersion !== "string" ||
    typeof encoded.content !== "string" ||
    typeof encoded.contentHash !== "string" ||
    !Array.isArray(encoded.receiptEvidence) ||
    !Array.isArray(encoded.supportedReceiptEvidence)
  )
    return "prepared encoding is malformed";
  for (const name of ["proposed", "rendered"] as const) {
    const event = prepared[name];
    if (
      !recordValue(event) ||
      typeof event.eventId !== "string" ||
      typeof event.contextSessionId !== "string" ||
      !recordValue(event.payload)
    )
      return `prepared ${name} event is malformed`;
  }
  return null;
}

function sessionPinsMatch(left: ContextSession, right: ContextSession): boolean {
  return canonicalEqual(
    {
      schemaVersion: left.schemaVersion,
      contextSessionId: left.contextSessionId,
      nativeSessionId: left.nativeSessionId,
      sessionNonce: left.sessionNonce,
      target: left.target,
      projectIdentity: left.projectIdentity,
      cwd: left.cwd,
      domainPolicy: left.domainPolicy,
      path: left.path,
      pinnedInsightProjectionHash: left.pinnedInsightProjectionHash,
      pinnedEvidenceProjectionHash: left.pinnedEvidenceProjectionHash,
      selectionPolicyVersion: left.selectionPolicyVersion,
      deliveryPolicyVersion: left.deliveryPolicyVersion,
      totalBudget: left.budget.total,
      createdAt: left.createdAt,
    },
    {
      schemaVersion: right.schemaVersion,
      contextSessionId: right.contextSessionId,
      nativeSessionId: right.nativeSessionId,
      sessionNonce: right.sessionNonce,
      target: right.target,
      projectIdentity: right.projectIdentity,
      cwd: right.cwd,
      domainPolicy: right.domainPolicy,
      path: right.path,
      pinnedInsightProjectionHash: right.pinnedInsightProjectionHash,
      pinnedEvidenceProjectionHash: right.pinnedEvidenceProjectionHash,
      selectionPolicyVersion: right.selectionPolicyVersion,
      deliveryPolicyVersion: right.deliveryPolicyVersion,
      totalBudget: right.budget.total,
      createdAt: right.createdAt,
    },
  );
}

function bundleRequestPinsIssue(
  bundle: ContextBundle,
  request: ContextRequest,
  session: ContextSession,
): string | null {
  if (request.contextSessionId !== session.contextSessionId)
    return "request context session does not match the pinned session";
  if (bundle.contextSessionId !== session.contextSessionId)
    return "bundle context session does not match the pinned session";
  if (!canonicalEqual(request.target, session.target))
    return "request target does not match the pinned session target";
  if (!canonicalEqual(bundle.target, session.target))
    return "bundle target does not match the pinned session target";
  if (bundle.deliveryMode !== request.deliveryMode || bundle.exposure !== request.exposure)
    return "bundle delivery pins do not match the request";
  if (bundle.shadow !== (bundle.exposure === "shadow"))
    return "bundle shadow flag does not match its exposure";
  if (
    bundle.pinnedInsightProjectionHash !== session.pinnedInsightProjectionHash ||
    bundle.pinnedEvidenceProjectionHash !== session.pinnedEvidenceProjectionHash
  )
    return "bundle projection pins do not match the session";
  return null;
}

function preparedEventIssue(
  prepared: ContextEventProjectionRow,
  stored: ContextEventProjectionRow | undefined,
  kind: "context.bundle.proposed" | "context.bundle.rendered",
  bundle: ContextBundle,
  encoded: EncodedContext | undefined,
): string | null {
  if (!stored) return `${kind} event is missing from the canonical projection`;
  if (!canonicalEqual(prepared, stored)) return `${kind} event was mutated`;
  if (
    stored.kind !== kind ||
    stored.contextSessionId !== bundle.contextSessionId ||
    stored.bundleHash !== bundle.bundleHash ||
    stored.idempotencyKey !== `${bundle.bundleHash}:${kind}` ||
    stored.actorKind !== "system" ||
    stored.inputEventIds.length !== 0 ||
    !canonicalEqual(stored.inputHashes, [
      bundle.pinnedInsightProjectionHash,
      bundle.pinnedEvidenceProjectionHash,
    ])
  )
    return `${kind} event lineage does not match the prepared bundle`;
  const payload = stored.payload;
  if (
    payload.inputHash !== bundle.inputHash ||
    payload.policyHash !== bundle.policyHash ||
    !canonicalEqual(payload.bounds, bundle.budget) ||
    !canonicalEqual(payload.provenance, {
      target: bundle.target,
      deliveryMode: bundle.deliveryMode,
      exposure: bundle.exposure,
    }) ||
    !canonicalEqual(
      payload.itemIds,
      bundle.items.map((item) => item.id),
    ) ||
    payload.omissionCount !== bundle.omissions.length
  )
    return `${kind} event payload does not match the prepared bundle`;
  if (encoded) {
    if (
      payload.contentHash !== encoded.contentHash ||
      payload.adapterId !== encoded.adapterId ||
      payload.adapterVersion !== encoded.adapterVersion ||
      payload.estimatedTokens !== encoded.estimatedTokens ||
      !canonicalEqual(payload.supportedReceiptEvidence, encoded.supportedReceiptEvidence)
    )
      return "rendered event payload does not match the selected adapter";
  }
  return null;
}

interface PreparedConfirmation {
  session: ContextSession;
  request: ContextRequest;
  bundle: ContextBundle;
  encoded: EncodedContext;
  proposed: ContextEventProjectionRow;
  rendered: ContextEventProjectionRow;
  adapter: DeliveryAdapter;
}

async function validatePreparedConfirmation(
  root: string,
  input: ConfirmContextEmissionInput,
): Promise<ContextPlaneResult<PreparedConfirmation>> {
  const shapeIssue = preparedStructureIssue(input.prepared);
  if (shapeIssue) return failure("invalid-input", shapeIssue);
  const prepared = input.prepared;
  const current = await readContextSession(root, prepared.session.contextSessionId);
  if (!current.ok) return failure("session-error", current.error.message);
  if (!sessionPinsMatch(prepared.session, current.value))
    return failure("invalid-input", "prepared session pins do not match the canonical session");
  const pinsIssue = bundleRequestPinsIssue(prepared.bundle, prepared.request, current.value);
  if (pinsIssue) return failure("invalid-input", pinsIssue);
  const selected = selectDeliveryAdapter(current.value.target, prepared.request.deliveryMode);
  if (!selected.ok) return failure("delivery-error", selected.error.message);
  if (!canonicalEqual(prepared.request.capabilities, selected.value.capabilities))
    return failure("invalid-input", "prepared receipt capabilities do not match the adapter");
  if (!selected.value.capabilities.receiptEvidence.includes(input.receiptEvidence))
    return failure("release-denied", "receipt evidence is not supported by the selected adapter");

  const collected = await collectContextCandidates(root, prepared.request);
  if (!collected.ok) return collectionError(collected);
  if (
    collected.value.insightProjectionHash !== current.value.pinnedInsightProjectionHash ||
    collected.value.evidenceProjectionHash !== current.value.pinnedEvidenceProjectionHash
  )
    return failure(
      "projection-drift",
      "current sources do not match the session-pinned projections",
    );
  const candidates =
    prepared.candidateIds === undefined
      ? collected.value.candidates
      : collected.value.candidates.filter((candidate) =>
          prepared.candidateIds?.includes(candidate.id),
        );
  const planned = planContext(prepared.request, prepared.session, candidates);
  if (!planned.ok) return failure("planning-error", planned.error.message);
  if (!validateContextBundleHash(prepared.bundle))
    return failure("invalid-input", "prepared bundle hash is invalid");
  if (!canonicalEqual(planned.value, prepared.bundle))
    return failure("invalid-input", "prepared bundle does not match the canonical plan");
  const rerendered = selected.value.render(planned.value);
  if (!rerendered.ok) return failure("delivery-error", rerendered.error.message);
  const budgetIssue = requestTokenBudgetIssue(prepared.request, rerendered.value);
  if (budgetIssue) return failure("delivery-error", budgetIssue);
  if (!canonicalEqual(rerendered.value, prepared.encoded))
    return failure("invalid-input", "prepared encoding does not match the selected adapter");
  if (
    rerendered.value.adapterId !== selected.value.id ||
    rerendered.value.adapterVersion !== selected.value.version ||
    !canonicalEqual(
      rerendered.value.supportedReceiptEvidence,
      selected.value.capabilities.receiptEvidence,
    )
  )
    return failure("invalid-input", "prepared adapter identity or capabilities are invalid");
  if (
    !current.value.consumedBundleHashes.includes(prepared.bundle.bundleHash) &&
    rerendered.value.estimatedTokens > current.value.budget.remaining.tokens
  )
    return failure("session-error", "rendered context exceeds the remaining session token budget");

  const events = await readContextEvents(root, {
    contextSessionId: prepared.bundle.contextSessionId,
    kinds: ["context.bundle.proposed", "context.bundle.rendered"],
  });
  if (!events.ok) return failure("event-error", events.error.message);
  const proposedIssue = preparedEventIssue(
    prepared.proposed,
    events.value.find((event) => event.eventId === prepared.proposed.eventId),
    "context.bundle.proposed",
    prepared.bundle,
    undefined,
  );
  if (proposedIssue) return failure("invalid-input", proposedIssue);
  const renderedIssue = preparedEventIssue(
    prepared.rendered,
    events.value.find((event) => event.eventId === prepared.rendered.eventId),
    "context.bundle.rendered",
    prepared.bundle,
    rerendered.value,
  );
  if (renderedIssue) return failure("invalid-input", renderedIssue);
  return {
    ok: true,
    value: {
      session: current.value,
      request: prepared.request,
      bundle: prepared.bundle,
      encoded: rerendered.value,
      proposed: prepared.proposed,
      rendered: prepared.rendered,
      adapter: selected.value,
    },
  };
}

export async function confirmContextEmission(
  root: string,
  input: ConfirmContextEmissionInput,
): Promise<ContextPlaneResult<ConfirmedContextEmission>> {
  const validation = await validatePreparedConfirmation(root, input);
  if (!validation.ok) return validation;
  const { session: validatedSession, bundle, encoded, rendered } = validation.value;
  const prepared = input.prepared;
  const occurredAt = input.occurredAt ?? new Date().toISOString();
  const eventKind =
    bundle.deliveryMode === "tool-recall" ? "context.recall.returned" : "context.bundle.emitted";
  const idempotencyKey = `${bundle.bundleHash}:${eventKind}`;

  try {
    return await withContextFinalizationLock(root, async () => {
      const authorization = await verifyReleaseGate(root, prepared, input.releaseGateHash);
      if (!authorization.ok) return authorization;
      const gate = authorization.value.gate;
      if (validatedSession.consumedBundleHashes.includes(bundle.bundleHash)) {
        const rows = await readContextEvents(root, {
          contextSessionId: bundle.contextSessionId,
          kinds: [eventKind],
        });
        if (!rows.ok) return failure("event-error", rows.error.message);
        const existing = rows.value.find(
          (candidate) =>
            candidate.idempotencyKey === idempotencyKey &&
            candidate.bundleHash === bundle.bundleHash,
        );
        if (!existing)
          return failure("event-error", "delivered context event is missing from its projection");
        if (
          existing.actorKind !== "system" ||
          existing.itemId !== gate.candidate.id ||
          existing.payload.contentHash !== encoded.contentHash ||
          existing.payload.candidateContentHash !== gate.candidate.contentHash ||
          existing.payload.receiptEvidence !== input.receiptEvidence ||
          !canonicalEqual(existing.payload.receipt, input.receipt) ||
          existing.payload.adapterId !== encoded.adapterId ||
          existing.payload.chargedTokens !== encoded.estimatedTokens
        )
          return failure("invalid-input", "delivery retry does not match the committed receipt");
        return { ok: true, value: { session: validatedSession, event: existing } };
      }
      if (validatedSession.pendingEventBatchHashes.length >= MAX_STAGED_RECALL_EVENT_BATCHES)
        return failure(
          "session-error",
          `pending context event batches are limited to ${MAX_STAGED_RECALL_EVENT_BATCHES}`,
        );
      const staged = await stageContextEvent(root, {
        kind: eventKind,
        contextSessionId: bundle.contextSessionId,
        idempotencyKey,
        actor: { kind: "system", id: "chatlog-context-plane" },
        bundleHash: bundle.bundleHash,
        itemId: gate.candidate.id,
        inputHash: bundle.inputHash,
        contentHash: encoded.contentHash,
        candidateContentHash: gate.candidate.contentHash,
        policyHash: bundle.policyHash,
        inputEventIds: [rendered.eventId],
        inputHashes: [rendered.batchHash],
        bounds: { ...bundle.budget },
        provenance: {
          receiptEvidence: input.receiptEvidence,
          receipt: input.receipt,
          gateEvaluationId: gate.evaluationId,
          releaseGateHash: authorization.value.pointer.gateHash,
        },
        payload: {
          receiptEvidence: input.receiptEvidence,
          receipt: input.receipt,
          adapterId: encoded.adapterId,
          chargedTokens: encoded.estimatedTokens,
        },
        occurredAt,
      });
      if (!staged.ok) return failure("event-error", staged.error.message);

      const committed = await commitContextBundleBudget(
        root,
        bundle,
        occurredAt,
        encoded.estimatedTokens,
        [staged.value.batchHash],
      );
      if (!committed.ok) return failure("session-error", committed.error.message);
      let session = committed.value.session;
      if (committed.value.committed) {
        try {
          await publishContextEventBatches(root, [staged.value.batchHash]);
        } catch (error) {
          return failure(
            "event-error",
            `Could not publish delivered context event: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
        const cleared = await clearContextEventOutbox(root, bundle.contextSessionId, [
          staged.value.batchHash,
        ]);
        if (!cleared.ok) return failure("session-error", cleared.error.message);
        session = cleared.value;
      }
      const rows = await readContextEvents(root, {
        contextSessionId: bundle.contextSessionId,
        kinds: [eventKind],
      });
      if (!rows.ok) return failure("event-error", rows.error.message);
      const row: ContextPlaneResult<ContextEventProjectionRow> = committed.value.committed
        ? eventRow(staged, rows.value)
        : (() => {
            const existing = rows.value.find(
              (candidate) =>
                candidate.idempotencyKey === idempotencyKey &&
                candidate.bundleHash === bundle.bundleHash,
            );
            return existing
              ? { ok: true, value: existing }
              : failure("event-error", "delivered context event is missing from its projection");
          })();
      return row.ok ? { ok: true, value: { session, event: row.value } } : row;
    });
  } catch (error) {
    return failure(
      "session-error",
      `Could not finalize context delivery: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

async function deliverBoundContext(
  root: string,
  session: ContextSession,
  input: Omit<DeliverSessionContextInput, "contextSessionId">,
  authorization: AuthorizedContextRelease,
): Promise<ContextPlaneResult<DeliveredContext>> {
  if (session.domainPolicy.length !== 1)
    return failure("session-error", "context delivery requires one pinned session domain");
  const domain = session.domainPolicy[0]!;
  const prepared = await prepareContext(root, {
    contextSessionId: session.contextSessionId,
    task: input.task,
    query: input.query,
    scope: {
      user: null,
      organization: null,
      project: session.projectIdentity,
      repository: session.projectIdentity,
      path: session.path,
      harness: session.target.harness,
      model: session.target.model,
      tool: null,
      domain,
    },
    allowedItemKinds: ["evidence", "insight", "procedure", "current-state"],
    riskCeiling: "high",
    freshAfter: null,
    budget: { ...session.budget.remaining },
    fixedInstructionTokens: 0,
    deliveryMode: input.deliveryMode,
    exposure: authorization.gate.stage,
    candidateIds: [authorization.gate.candidate.id],
    ...(input.now === undefined ? {} : { now: input.now }),
  });
  if (!prepared.ok) return prepared;
  if (prepared.value.bundle.items.length !== 1)
    return failure("release-denied", "the authorized candidate is not relevant to this task");
  const confirmed = await confirmContextEmission(root, {
    prepared: prepared.value,
    releaseGateHash: authorization.pointer.gateHash,
    receiptEvidence: input.receiptEvidence,
    receipt: input.receipt,
    ...(input.now === undefined ? {} : { occurredAt: input.now }),
  });
  if (!confirmed.ok) return confirmed;
  return {
    ok: true,
    value: {
      content: prepared.value.encoded.content,
      contextSessionId: session.contextSessionId,
      bundleHash: prepared.value.bundle.bundleHash,
      gateHash: authorization.pointer.gateHash,
      itemId: prepared.value.bundle.items[0]!.id,
      event: confirmed.value.event,
    },
  };
}

export async function deliverSessionContext(
  root: string,
  input: DeliverSessionContextInput,
): Promise<ContextPlaneResult<DeliveredContext>> {
  const authorization = await readAuthorizedContextRelease(root);
  if (!authorization.ok) return failure("release-denied", authorization.error.message);
  const session = await readContextSession(root, input.contextSessionId);
  if (!session.ok) return failure("session-error", session.error.message);
  return deliverBoundContext(root, session.value, input, authorization.value);
}

export async function deliverContext(
  root: string,
  input: DeliverContextInput,
): Promise<ContextPlaneResult<DeliveredContext>> {
  const path = input.path ?? null;
  const authorization = await readAuthorizedContextRelease(root);
  if (!authorization.ok) return failure("release-denied", authorization.error.message);
  const started = await startContextPlaneSession(root, {
    nativeSessionId: input.nativeSessionId,
    target: input.target,
    projectIdentity: input.projectIdentity,
    cwd: input.cwd,
    domainPolicy: [input.domain],
    path,
    totalBudget: { ...input.budget },
    ...(input.now === undefined ? {} : { createdAt: input.now }),
  });
  if (!started.ok) return started;
  return deliverBoundContext(root, started.value, input, authorization.value);
}

export class ContextPlane {
  constructor(readonly root: string) {}

  startSession(input: StartContextPlaneSessionInput): Promise<ContextPlaneResult<ContextSession>> {
    return startContextPlaneSession(this.root, input);
  }

  listSessions(): Promise<ContextSessionStoreResult<ContextSession[]>> {
    return listContextSessions(this.root);
  }

  prepare(input: PrepareContextInput): Promise<ContextPlaneResult<PreparedContext>> {
    return prepareContext(this.root, input);
  }

  confirmEmission(
    input: ConfirmContextEmissionInput,
  ): Promise<ContextPlaneResult<ConfirmedContextEmission>> {
    return confirmContextEmission(this.root, input);
  }

  deliver(input: DeliverContextInput): Promise<ContextPlaneResult<DeliveredContext>> {
    return deliverContext(this.root, input);
  }

  deliverSession(input: DeliverSessionContextInput): Promise<ContextPlaneResult<DeliveredContext>> {
    return deliverSessionContext(this.root, input);
  }

  feedback(input: ContextFeedbackInput): Promise<ContextEventResult<ContextEventRecord>> {
    return recordContextFeedback(this.root, input);
  }

  outcome(input: ContextOutcomeInput): Promise<ContextEventResult<ContextEventRecord>> {
    return recordContextOutcome(this.root, input);
  }
}

export function deliveryAdapterFor(
  target: ContextTarget,
  mode: ContextDeliveryMode,
): ContextPlaneResult<DeliveryAdapter> {
  const selected = selectDeliveryAdapter(target, mode);
  return selected.ok
    ? { ok: true, value: selected.value }
    : failure("delivery-error", selected.error.message);
}
