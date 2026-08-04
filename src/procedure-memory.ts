import {
  recordContextEvent,
  type ContextEventError,
  type ContextEventRecord,
} from "./context-events";
import { sha256, stableStringify } from "./events";

const HASH = /^[0-9a-f]{64}$/;
const SOURCE_URI = /^[a-z][a-z0-9+.-]*:\/\/\S+$/iu;
const MAX_PROCEDURES = 1_000;
const MAX_RESULTS = 20;
const MAX_ACTIONS = 20;
const MAX_TEXT = 1_000;
export type ProcedureAuthority = "agent" | "provider" | "system" | "operator" | "user";
export type ProcedureOutcome = "success" | "failure" | "unknown";

export interface ProcedureEntry {
  schemaVersion: 1;
  procedureId: string;
  version: string;
  sourceUri: string;
  contentHash: string;
  authoredBy: { provider: string; harness: string };
  trigger: string;
  preconditions: readonly string[];
  scope: { repository: string | null; domain: string | null; harnesses: readonly string[] };
  environment: Readonly<Record<string, string>>;
  actions: readonly string[];
  successObservations: readonly string[];
  failureObservations: readonly string[];
  requiredAuthority: readonly ProcedureAuthority[];
  evidenceHashes: readonly string[];
  evaluationHashes: readonly string[];
  evaluation?: Readonly<Record<string, unknown>>;
  validTime: { start: string; end: string | null };
  status: "active" | "retired";
}

export type ProcedureSourceResolver = (sourceUri: string, contentHash: string) => boolean;

export interface ProcedureReference {
  id: string;
  procedureId: string;
  version: string;
  sourceUri: string;
  contentHash: string;
  authoredBy: { provider: string; harness: string };
  trigger: string;
  preconditions: readonly string[];
  scope: { repository: string | null; domain: string | null; harnesses: readonly string[] };
  environment: Readonly<Record<string, string>>;
  validTime: { start: string; end: string | null };
  actions: readonly string[];
  successObservations: readonly string[];
  failureObservations: readonly string[];
  requiredAuthority: readonly ProcedureAuthority[];
  evidenceHashes: readonly string[];
  evaluationHashes: readonly string[];
  evaluation?: Readonly<Record<string, unknown>>;
  status: "active" | "retired";
}

export interface ProcedureRecallRequest {
  task: string;
  repository: string | null;
  domain: string | null;
  harness: string;
  environment: Readonly<Record<string, string>>;
  authorities: readonly ProcedureAuthority[];
  currentVersions: Readonly<Record<string, string>>;
  priorOutcomes: Readonly<Record<string, ProcedureOutcome>>;
  now: string;
  maxResults: number;
  readonly sourceResolver?: ProcedureSourceResolver;
}

export type ProcedureRejectionReason =
  | "retired"
  | "outside-valid-time"
  | "task-mismatch"
  | "repository-mismatch"
  | "domain-mismatch"
  | "harness-mismatch"
  | "environment-mismatch"
  | "stale-version"
  | "missing-authority"
  | "failed-prior-outcome";

export interface ProcedureRejection {
  procedureId: string;
  version: string;
  reason: ProcedureRejectionReason;
}

export type ProcedureSelectionResult =
  | {
      ok: true;
      value: {
        references: readonly ProcedureReference[];
        rejections: readonly ProcedureRejection[];
        omitted: number;
      };
    }
  | { ok: false; error: { code: "invalid-request" | "invalid-procedure"; message: string } };

function textError(value: unknown, label: string): string | undefined {
  return typeof value !== "string" || value.trim().length === 0 || value.length > MAX_TEXT
    ? `${label} must be a non-empty bounded string`
    : undefined;
}

function instantError(value: unknown, label: string): string | undefined {
  const invalidText = textError(value, label);
  if (invalidText) return invalidText;
  return Number.isFinite(Date.parse(value as string))
    ? undefined
    : `${label} must be an ISO timestamp`;
}

function stringListError(value: unknown, label: string, maximum = MAX_ACTIONS): string | undefined {
  if (!Array.isArray(value) || value.length > maximum)
    return `${label} must be a bounded string array`;
  for (const [index, item] of value.entries()) {
    const error = textError(item, `${label}[${index}]`);
    if (error) return error;
  }
  return undefined;
}

function entryError(entry: ProcedureEntry, index: number): string | undefined {
  const label = `procedures[${index}]`;
  if (entry === null || typeof entry !== "object") return `${label} must be an object`;
  if (entry.schemaVersion !== 1) return `${label}.schemaVersion must be 1`;
  for (const [value, field] of [
    [entry.procedureId, "procedureId"],
    [entry.version, "version"],
    [entry.sourceUri, "sourceUri"],
    [entry.trigger, "trigger"],
  ] as const) {
    const error = textError(value, `${label}.${field}`);
    if (error) return error;
  }
  if (!SOURCE_URI.test(entry.sourceUri))
    return `${label}.sourceUri must be an absolute source pointer URI`;
  if (typeof entry.authoredBy !== "object" || entry.authoredBy === null)
    return `${label}.authoredBy must identify a provider and harness`;
  const providerError = textError(entry.authoredBy.provider, `${label}.authoredBy.provider`);
  if (providerError) return providerError;
  const harnessError = textError(entry.authoredBy.harness, `${label}.authoredBy.harness`);
  if (harnessError) return harnessError;
  for (const [value, field] of [
    [entry.preconditions, "preconditions"],
    [entry.actions, "actions"],
    [entry.successObservations, "successObservations"],
    [entry.failureObservations, "failureObservations"],
  ] as const) {
    const error = stringListError(value, `${label}.${field}`);
    if (error) return error;
  }
  if (entry.actions.length === 0) return `${label}.actions must not be empty`;
  if (typeof entry.scope !== "object" || entry.scope === null)
    return `${label}.scope must be an object`;
  const harnessesError = stringListError(entry.scope.harnesses, `${label}.scope.harnesses`);
  if (harnessesError) return harnessesError;
  if (entry.scope.repository !== null) {
    const error = textError(entry.scope.repository, `${label}.scope.repository`);
    if (error) return error;
  }
  if (entry.scope.domain !== null) {
    const error = textError(entry.scope.domain, `${label}.scope.domain`);
    if (error) return error;
  }
  if (
    typeof entry.environment !== "object" ||
    entry.environment === null ||
    Array.isArray(entry.environment)
  )
    return `${label}.environment must be an object`;
  for (const [key, value] of Object.entries(entry.environment)) {
    const keyError = textError(key, `${label}.environment key`);
    if (keyError) return keyError;
    const valueError = textError(value, `${label}.environment.${key}`);
    if (valueError) return valueError;
  }
  if (!Array.isArray(entry.requiredAuthority) || entry.requiredAuthority.length === 0)
    return `${label}.requiredAuthority must not be empty`;
  if (!Array.isArray(entry.evidenceHashes) || !Array.isArray(entry.evaluationHashes))
    return `${label} provenance must contain lowercase SHA-256 hashes`;
  if (![...entry.evidenceHashes, ...entry.evaluationHashes].every((hash) => HASH.test(hash)))
    return `${label} provenance must contain lowercase SHA-256 hashes`;
  if (
    entry.evaluation !== undefined &&
    (typeof entry.evaluation !== "object" ||
      entry.evaluation === null ||
      Array.isArray(entry.evaluation))
  )
    return `${label}.evaluation must be an object`;
  if (
    entry.evaluation !== undefined &&
    "artifactHash" in entry.evaluation &&
    !HASH.test(String(entry.evaluation.artifactHash))
  )
    return `${label}.evaluation.artifactHash must be a lowercase SHA-256 hash`;
  const startError = instantError(entry.validTime.start, `${label}.validTime.start`);
  if (startError) return startError;
  if (entry.validTime.end !== null) {
    const endError = instantError(entry.validTime.end, `${label}.validTime.end`);
    if (endError) return endError;
    if (Date.parse(entry.validTime.end) <= Date.parse(entry.validTime.start))
      return `${label}.validTime.end must follow start`;
  }
  if (entry.status !== "active" && entry.status !== "retired") return `${label}.status is invalid`;
  return undefined;
}

function words(value: string): Set<string> {
  return new Set(value.toLowerCase().match(/[a-z0-9][a-z0-9_-]*/g) ?? []);
}

function taskMatches(trigger: string, task: string): boolean {
  const wanted = words(trigger);
  const available = words(task);
  if (wanted.size === 0) return false;
  let common = 0;
  for (const word of wanted) if (available.has(word)) common += 1;
  return common / wanted.size >= 0.5;
}

function rejection(
  entry: ProcedureEntry,
  request: ProcedureRecallRequest,
  now: number,
): ProcedureRejectionReason | null {
  if (entry.status !== "active") return "retired";
  const start = Date.parse(entry.validTime.start);
  const end = entry.validTime.end === null ? null : Date.parse(entry.validTime.end);
  if (now < start || (end !== null && now >= end)) return "outside-valid-time";
  if (!taskMatches(entry.trigger, request.task)) return "task-mismatch";
  if (entry.scope.repository !== null && entry.scope.repository !== request.repository)
    return "repository-mismatch";
  if (entry.scope.domain !== null && entry.scope.domain !== request.domain)
    return "domain-mismatch";
  if (entry.scope.harnesses.length > 0 && !entry.scope.harnesses.includes(request.harness))
    return "harness-mismatch";
  for (const [key, value] of Object.entries(entry.environment)) {
    if (request.environment[key] !== value) return "environment-mismatch";
  }
  const currentVersion = request.currentVersions[entry.procedureId];
  if (currentVersion !== undefined && currentVersion !== entry.version) return "stale-version";
  if (entry.requiredAuthority.some((authority) => !request.authorities.includes(authority)))
    return "missing-authority";
  if (request.priorOutcomes[`${entry.procedureId}@${entry.version}`] === "failure")
    return "failed-prior-outcome";
  return null;
}
function pointerVerificationError(
  entry: ProcedureEntry,
  request: ProcedureRecallRequest,
): string | undefined {
  if (request.sourceResolver === undefined) return undefined;
  try {
    return request.sourceResolver(entry.sourceUri, entry.contentHash)
      ? undefined
      : "authoritative procedure source pointer could not be verified";
  } catch (error) {
    return `authoritative procedure source pointer verification failed: ${
      error instanceof Error ? error.message : String(error)
    }`;
  }
}

function reference(entry: ProcedureEntry): ProcedureReference {
  return {
    id: entry.procedureId,
    procedureId: entry.procedureId,
    version: entry.version,
    sourceUri: entry.sourceUri,
    contentHash: entry.contentHash,
    authoredBy: entry.authoredBy,
    trigger: entry.trigger,
    preconditions: entry.preconditions,
    scope: entry.scope,
    environment: entry.environment,
    validTime: entry.validTime,
    actions: entry.actions,
    successObservations: entry.successObservations,
    failureObservations: entry.failureObservations,
    requiredAuthority: entry.requiredAuthority,
    evidenceHashes: entry.evidenceHashes,
    evaluationHashes: entry.evaluationHashes,
    ...(entry.evaluation === undefined ? {} : { evaluation: entry.evaluation }),
    status: entry.status,
  };
}

export function selectProcedureReferences(
  procedures: readonly ProcedureEntry[],
  request: ProcedureRecallRequest,
): ProcedureSelectionResult {
  if (!Array.isArray(procedures) || procedures.length > MAX_PROCEDURES)
    return {
      ok: false,
      error: { code: "invalid-request", message: "procedures exceeds the bounded input limit" },
    };
  const taskError = textError(request?.task, "task");
  if (taskError) return { ok: false, error: { code: "invalid-request", message: taskError } };
  const harnessError = textError(request?.harness, "harness");
  if (harnessError) return { ok: false, error: { code: "invalid-request", message: harnessError } };
  const nowError = instantError(request?.now, "now");
  if (nowError) return { ok: false, error: { code: "invalid-request", message: nowError } };
  if (
    !Number.isInteger(request.maxResults) ||
    request.maxResults < 0 ||
    request.maxResults > MAX_RESULTS
  )
    return {
      ok: false,
      error: {
        code: "invalid-request",
        message: `maxResults must be an integer from 0 through ${MAX_RESULTS}`,
      },
    };
  for (const [index, entry] of procedures.entries()) {
    const error = entryError(entry, index);
    if (error) return { ok: false, error: { code: "invalid-procedure", message: error } };
  }

  const references: ProcedureReference[] = [];
  const rejections: ProcedureRejection[] = [];
  let eligible = 0;
  const now = Date.parse(request.now);
  for (const entry of procedures.toSorted((left, right) =>
    `${left.procedureId}\0${left.version}`.localeCompare(`${right.procedureId}\0${right.version}`),
  )) {
    const reason = rejection(entry, request, now);
    if (reason !== null)
      rejections.push({ procedureId: entry.procedureId, version: entry.version, reason });
    else {
      eligible += 1;
      if (references.length < request.maxResults) {
        const pointerError = pointerVerificationError(entry, request);
        if (pointerError)
          return { ok: false, error: { code: "invalid-procedure", message: pointerError } };
        references.push(reference(entry));
      }
    }
  }
  return { ok: true, value: { references, rejections, omitted: eligible - references.length } };
}

export interface RecordProcedureRecallInput {
  contextSessionId: string;
  idempotencyKey: string;
  procedures: readonly ProcedureEntry[];
  request: ProcedureRecallRequest;
  actorId?: string;
  occurredAt?: string;
}
export interface ProcedurePersistenceError {
  code: "persistence-error";
  retryable: true;
  phase: "storage";
  message: string;
}

export type RecordProcedureRecallResult =
  | {
      ok: true;
      value: {
        selection: Extract<ProcedureSelectionResult, { ok: true }>["value"];
        event: ContextEventRecord;
      };
    }
  | {
      ok: false;
      error:
        | ContextEventError
        | ProcedurePersistenceError
        | Extract<ProcedureSelectionResult, { ok: false }>["error"];
    };

export async function recordProcedureRecall(
  root: string,
  input: RecordProcedureRecallInput,
): Promise<RecordProcedureRecallResult> {
  if (!HASH.test(input.contextSessionId)) {
    return {
      ok: false,
      error: {
        code: "invalid-request",
        message: "contextSessionId must be a lowercase SHA-256 hash",
      },
    };
  }
  const selected = selectProcedureReferences(input.procedures, input.request);
  if (!selected.ok) return selected;
  const contentHash = sha256(stableStringify(selected.value.references));
  const recorded = await recordContextEvent(root, {
    kind: "context.procedure.returned",
    contextSessionId: input.contextSessionId,
    idempotencyKey: input.idempotencyKey,
    actor: { kind: "system", id: input.actorId ?? "chatlog-procedure-memory" },
    actorAuthority: "system",
    contentHash,
    bounds: {
      maxResults: input.request.maxResults,
      returned: selected.value.references.length,
      omitted: selected.value.omitted,
    },
    provenance: {
      procedures: selected.value.references.map((item) => ({
        id: item.id,
        procedureId: item.procedureId,
        version: item.version,
        sourceUri: item.sourceUri,
        contentHash: item.contentHash,
        authoredBy: item.authoredBy,
        trigger: item.trigger,
        preconditions: item.preconditions,
        scope: item.scope,
        environment: item.environment,
        validTime: item.validTime,
        actions: item.actions,
        successObservations: item.successObservations,
        failureObservations: item.failureObservations,
        requiredAuthority: item.requiredAuthority,
        evidenceHashes: item.evidenceHashes,
        evaluationHashes: item.evaluationHashes,
        ...(item.evaluation === undefined ? {} : { evaluation: item.evaluation }),
      })),
    },
    payload: {
      procedureIds: selected.value.references.map((item) => item.procedureId),
      versions: selected.value.references.map((item) => item.version),
      rejections: selected.value.rejections,
    },
    occurredAt: input.occurredAt ?? input.request.now,
  });
  if (recorded.ok) return { ok: true, value: { selection: selected.value, event: recorded.value } };
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
