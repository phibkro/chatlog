import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { isClosedLoopSourceEventKind, verifyClosedLoopGate } from "./closed-loop-gate";
import { parseClosedLoopEvaluatorMetrics } from "./closed-loop-evaluation";
import type {
  ClosedLoopEvidenceObservation,
  ClosedLoopEvidencePointer,
  ClosedLoopEvidenceResolution,
  ClosedLoopGateArtifact,
  ClosedLoopSourceObservation,
} from "./closed-loop-gate";
import { openAnalysis } from "./analysis";
import { readEventBatch } from "./event-store";
import { sha256, stableStringify, type AgentEventEnvelope, type EventBatch } from "./events";
import { readContextSession } from "./context-session";
import { withContextFinalizationLock, withIngestLock } from "./lock";

export interface ContextReleasePointer {
  schema: "chatlog/context-release-pointer-v1";
  gateHash: string;
  evaluationId: string;
  stage: ClosedLoopGateArtifact["stage"];
  candidateId: string;
  authorizedAt: string;
}

export interface AuthorizedContextRelease {
  pointer: ContextReleasePointer;
  gate: ClosedLoopGateArtifact;
}

export type ContextReleaseResult<T> =
  | { ok: true; value: T }
  | {
      ok: false;
      error: {
        code: "invalid-gate" | "missing-evidence" | "storage-error" | "not-authorized";
        message: string;
      };
    };

const HASH = /^[a-f0-9]{64}$/u;

function fail<T>(
  code: "invalid-gate" | "missing-evidence" | "storage-error" | "not-authorized",
  message: string,
): ContextReleaseResult<T> {
  return { ok: false, error: { code, message } };
}
type EventMetadataRow = {
  eventId: string;
  batchHash: string;
  kind: string;
};

function hashList(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  if (!value.every((item) => typeof item === "string" && HASH.test(item))) return null;
  return [...value];
}

function interventionId(payload: Readonly<Record<string, unknown>>): string | null | undefined {
  if ("interventionId" in payload) {
    if (payload.interventionId === null) return null;
    return typeof payload.interventionId === "string" && HASH.test(payload.interventionId)
      ? payload.interventionId
      : undefined;
  }
  const ids = hashList(payload.interventionEventIds);
  if (ids === null) return undefined;
  if (ids.length > 1) return undefined;
  return ids[0] ?? null;
}

function inputEventIds(event: AgentEventEnvelope): string[] | null {
  const payloadIds = hashList(event.payload.inputEventIds);
  const originIds = event.origin.kind === "chatlog" ? hashList(event.origin.inputEventIds) : null;
  if (payloadIds === null && originIds === null) return null;
  if (
    payloadIds !== null &&
    originIds !== null &&
    (payloadIds.length !== originIds.length ||
      payloadIds.some((eventId, index) => eventId !== originIds[index]))
  )
    return null;
  return payloadIds ?? originIds ?? [];
}

async function sourceObservations(
  root: string,
  contextSessionId: string,
  eventIds: readonly string[],
): Promise<ClosedLoopSourceObservation[] | null> {
  if (!eventIds.length) return [];
  const session = await readContextSession(root, contextSessionId);
  if (!session.ok) return null;
  const sourceSessionId = session.value.nativeSessionId ?? contextSessionId;
  const db = openAnalysis(join(root, "analysis", "chatlog.sqlite"));
  let rows: EventMetadataRow[];
  try {
    const placeholders = eventIds.map(() => "?").join(",");
    rows = db
      .query(
        `SELECT event_id eventId,batch_hash batchHash,kind
         FROM event_metadata WHERE event_id IN (${placeholders})`,
      )
      .all(...eventIds) as EventMetadataRow[];
  } finally {
    db.close();
  }
  if (rows.length !== eventIds.length) return null;
  const rowsById = new Map<string, EventMetadataRow>(
    rows.map((row) => [row.eventId, row] as const),
  );
  const batches = new Map<string, EventBatch>();
  const sources: ClosedLoopSourceObservation[] = [];
  for (const eventId of eventIds) {
    const row = rowsById.get(eventId);
    if (!row) return null;
    let batch = batches.get(row.batchHash);
    if (!batch) {
      batch = await readEventBatch(root, row.batchHash);
      batches.set(row.batchHash, batch);
    }
    const event = batch.events.find((candidate) => candidate.eventId === eventId);
    if (
      !event ||
      event.kind !== row.kind ||
      event.origin.kind !== "observed" ||
      (event.capture.disposition !== "normalized" && event.capture.disposition !== "redacted") ||
      event.origin.source.provider !== session.value.target.provider ||
      event.origin.source.harness !== session.value.target.harness ||
      event.scope.project !== session.value.projectIdentity ||
      event.scope.cwd !== session.value.cwd
    )
      return null;
    if (
      event.scope.sessionId !== contextSessionId ||
      event.origin.source.nativeSessionId !== sourceSessionId
    )
      return null;
    if (!isClosedLoopSourceEventKind(event.kind)) return null;
    sources.push({
      pointer: { batchHash: row.batchHash, eventId },
      kind: event.kind,
      contextSessionId,
      originKind: event.origin.kind,
      captureDisposition: event.capture.disposition,
      actorKind: event.actor.kind,
      sourceKind: event.origin.source.sourceKind,
      adapterRecipe: event.origin.source.adapterRecipe,
      recordedAt: event.occurredAt ?? event.observedAt ?? null,
      metrics:
        event.kind === "evaluation.recorded"
          ? parseClosedLoopEvaluatorMetrics(event.payload)
          : null,
    });
  }
  return sources;
}

async function observation(
  root: string,
  pointer: ClosedLoopEvidencePointer,
  event: AgentEventEnvelope,
): Promise<ClosedLoopEvidenceObservation | null> {
  if (
    event.kind !== "context.bundle.emitted" &&
    event.kind !== "context.bundle.acknowledged" &&
    event.kind !== "context.outcome.observed"
  )
    return null;
  const payloadContextSessionId =
    typeof event.payload.contextSessionId === "string" ? event.payload.contextSessionId : null;
  const contextSessionId = payloadContextSessionId ?? event.scope.sessionId;
  if (
    typeof contextSessionId !== "string" ||
    !HASH.test(contextSessionId) ||
    event.scope.sessionId !== contextSessionId
  )
    return null;
  const allowedGrades = [
    "gate-observed",
    "provider-observed",
    "human-asserted",
    "heuristic",
    "agent-self-report",
  ] as const;
  const evidenceGrade =
    typeof event.payload.evidenceGrade === "string" &&
    allowedGrades.includes(event.payload.evidenceGrade as (typeof allowedGrades)[number])
      ? (event.payload.evidenceGrade as ClosedLoopEvidenceObservation["evidenceGrade"])
      : null;
  const ids = event.kind === "context.outcome.observed" ? inputEventIds(event) : [];
  if (ids === null) return null;
  const sources = await sourceObservations(root, contextSessionId, ids);
  if (sources === null) return null;
  const metrics =
    event.kind === "context.outcome.observed"
      ? parseClosedLoopEvaluatorMetrics(event.payload)
      : null;
  if (event.kind === "context.outcome.observed" && !metrics) return null;
  const namedIntervention =
    event.kind === "context.outcome.observed" ? interventionId(event.payload) : null;
  if (namedIntervention === undefined) return null;
  const candidateId =
    typeof event.payload.candidateId === "string"
      ? event.payload.candidateId
      : typeof event.payload.itemId === "string"
        ? event.payload.itemId
        : null;
  const candidateContentHash =
    typeof event.payload.candidateContentHash === "string" &&
    HASH.test(event.payload.candidateContentHash)
      ? event.payload.candidateContentHash
      : null;
  return {
    pointer,
    kind: event.kind,
    contextSessionId,
    evidenceGrade,
    originKind: event.origin.kind,
    captureDisposition: event.capture.disposition,
    actorKind: event.actor.kind,
    recordedAt: event.occurredAt ?? event.observedAt ?? null,
    metrics,
    interventionId: namedIntervention,
    inputEventIds: ids,
    sources,
    candidateId,
    candidateContentHash,
  };
}

function eventIsCanonicallyPublished(
  root: string,
  pointer: ClosedLoopEvidencePointer,
  event: AgentEventEnvelope,
): boolean {
  const db = openAnalysis(join(root, "analysis", "chatlog.sqlite"));
  try {
    const row = db
      .query(
        `SELECT 1 present
         FROM event_metadata metadata
         JOIN context_event_projection context
           ON context.event_id = metadata.event_id
          AND context.batch_hash = metadata.batch_hash
         WHERE metadata.event_id = ?
           AND metadata.batch_hash = ?
           AND metadata.kind = ?
           AND context.kind = ?
         LIMIT 1`,
      )
      .get(pointer.eventId, pointer.batchHash, event.kind, event.kind);
    return row !== null;
  } finally {
    db.close();
  }
}

export async function resolveContextReleaseEvidence(
  root: string,
  pointer: ClosedLoopEvidencePointer,
): Promise<ClosedLoopEvidenceResolution> {
  try {
    const batch = await readEventBatch(root, pointer.batchHash);
    const event = batch.events.find((candidate) => candidate.eventId === pointer.eventId);
    const value =
      event && eventIsCanonicallyPublished(root, pointer, event)
        ? await observation(root, pointer, event)
        : null;
    return value
      ? { ok: true, value }
      : { ok: false, error: "event is missing or is not release evidence" };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function verifyContextReleaseArtifact(
  root: string,
  input: unknown,
): Promise<ContextReleaseResult<ClosedLoopGateArtifact>> {
  const verified = await verifyClosedLoopGate(input, (pointer) =>
    resolveContextReleaseEvidence(root, pointer),
  );
  if (!verified.ok) return fail(verified.error.code, verified.error.message);
  if (verified.value.verdict !== "keep")
    return fail("invalid-gate", `release gate verdict is ${verified.value.verdict}`);
  return { ok: true, value: verified.value.artifact };
}

function releaseDirectory(root: string): string {
  return join(resolve(root), "memory", "context-release");
}

function releasePath(root: string, hash: string): string {
  return join(releaseDirectory(root), `${hash}.json`);
}

function pointerPath(root: string): string {
  return join(releaseDirectory(root), "current.json");
}

async function atomicPrivateWrite(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
  await chmod(temporary, 0o600);
  await rename(temporary, path);
  await chmod(path, 0o600);
}

function errorCode(error: unknown): string {
  if (typeof error !== "object" || error === null || !("code" in error)) return "";
  return typeof error.code === "string" ? error.code : "";
}

export async function authorizeContextRelease(
  root: string,
  input: unknown,
  authorizedAt = new Date().toISOString(),
): Promise<ContextReleaseResult<AuthorizedContextRelease>> {
  if (!Number.isFinite(Date.parse(authorizedAt)))
    return fail("invalid-gate", "authorizedAt must be an ISO timestamp");
  const verified = await verifyContextReleaseArtifact(root, input);
  if (!verified.ok) return verified;
  const gate = verified.value;
  const gateBytes = `${stableStringify(gate)}\n`;
  const gateHash = sha256(gateBytes);
  const pointer: ContextReleasePointer = {
    schema: "chatlog/context-release-pointer-v1",
    gateHash,
    evaluationId: gate.evaluationId,
    stage: gate.stage,
    candidateId: gate.candidate.id,
    authorizedAt,
  };
  try {
    return await withContextFinalizationLock(root, () =>
      withIngestLock(root, async () => {
        await mkdir(releaseDirectory(root), { recursive: true, mode: 0o700 });
        const immutablePath = releasePath(root, gateHash);
        try {
          const existing = await readFile(immutablePath, "utf8");
          if (existing !== gateBytes)
            return fail("storage-error", "authorized gate hash collides with different bytes");
        } catch (error) {
          const code = errorCode(error);
          if (code !== "ENOENT")
            return fail("storage-error", error instanceof Error ? error.message : String(error));
          await atomicPrivateWrite(immutablePath, gateBytes);
        }
        await atomicPrivateWrite(pointerPath(root), `${stableStringify(pointer)}\n`);
        return { ok: true, value: { pointer, gate } };
      }),
    );
  } catch (error) {
    return fail("storage-error", error instanceof Error ? error.message : String(error));
  }
}

function validPointer(input: unknown): input is ContextReleasePointer {
  return (
    typeof input === "object" &&
    input !== null &&
    !Array.isArray(input) &&
    "schema" in input &&
    input.schema === "chatlog/context-release-pointer-v1" &&
    "gateHash" in input &&
    typeof input.gateHash === "string" &&
    HASH.test(input.gateHash) &&
    "evaluationId" in input &&
    typeof input.evaluationId === "string" &&
    "stage" in input &&
    typeof input.stage === "string" &&
    (input.stage === "shadow" ||
      input.stage === "evidence-only" ||
      input.stage === "limited-insight") &&
    "candidateId" in input &&
    typeof input.candidateId === "string" &&
    "authorizedAt" in input &&
    typeof input.authorizedAt === "string" &&
    Number.isFinite(Date.parse(input.authorizedAt))
  );
}

export async function readAuthorizedContextRelease(
  root: string,
): Promise<ContextReleaseResult<AuthorizedContextRelease>> {
  try {
    const pointerInput: unknown = JSON.parse(await readFile(pointerPath(root), "utf8"));
    if (!validPointer(pointerInput))
      return fail("storage-error", "context release pointer is malformed");
    const gateBytes = await readFile(releasePath(root, pointerInput.gateHash), "utf8");
    if (sha256(gateBytes) !== pointerInput.gateHash)
      return fail("storage-error", "authorized context gate bytes do not match the pointer hash");
    const verified = await verifyContextReleaseArtifact(root, JSON.parse(gateBytes));
    if (!verified.ok) return verified;
    const gate = verified.value;
    if (
      gate.evaluationId !== pointerInput.evaluationId ||
      gate.stage !== pointerInput.stage ||
      gate.candidate.id !== pointerInput.candidateId
    )
      return fail("storage-error", "authorized context gate does not match its pointer");
    return { ok: true, value: { pointer: pointerInput, gate } };
  } catch (error) {
    const code = errorCode(error);
    return fail(
      code === "ENOENT" ? "not-authorized" : "storage-error",
      code === "ENOENT"
        ? "no operator-authorized context release gate is installed"
        : error instanceof Error
          ? error.message
          : String(error),
    );
  }
}
