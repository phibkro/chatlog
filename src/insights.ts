import { createHash } from "node:crypto";
import { stableStringify } from "./events";
import { parseEvidenceUri } from "./evidence-uri";
import type { ConversationDomain } from "./types";

export const INSIGHT_SCHEMA_VERSION = 2 as const;
export const INSIGHT_LEDGER_SCHEMA_VERSION = 2 as const;
export const INSIGHT_CURRENT_SCHEMA_VERSION = 2 as const;

const HASH = /^[a-f0-9]{64}$/u;
const ID = /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/u;
const MAX_TEXT = 8_000;
const MAX_URI = 2_000;
const MAX_AXES = 500;

export type InsightKind =
  | "fact"
  | "preference"
  | "decision"
  | "episode"
  | "procedure"
  | "hypothesis"
  | "relationship"
  | "current-state";

export type InsightStatus =
  | "candidate"
  | "active"
  | "rejected"
  | "disputed"
  | "superseded"
  | "expired"
  | "retired";

export type InsightAuthorityKind =
  | "source-observation"
  | "deterministic-derivation"
  | "model-proposal"
  | "human-assertion"
  | "human-review"
  | "measured-evaluation"
  | "authoritative-document"
  | "assumption";

export type InsightAssessorRole = "human" | "model" | "system" | "evaluation";
export type InsightTransitionCommand =
  | "accept"
  | "accept-with-correction"
  | "reject"
  | "dispute"
  | "resolve-dispute"
  | "supersede"
  | "expire"
  | "retire";

export interface InsightScope {
  user: string | null;
  organization: string | null;
  project: string | null;
  repository: string | null;
  path: string | null;
  harness: string | null;
  model: string | null;
  tool: string | null;
  domain: string;
}

export type InsightScopeInput = Partial<InsightScope> & Pick<InsightScope, "domain">;

export interface InsightValidTime {
  start: string;
  end: string | null;
}

export interface InsightOrigin {
  kind: InsightAuthorityKind;
  actor: string;
  sourceHashes: string[];
  proposalId: string | null;
}

export interface InsightAuthorityRecord {
  kind: InsightAuthorityKind;
  actor: string;
  authority: string;
  assertedAt: string;
  sourceHashes: string[];
}

export interface InsightDerivation {
  activity: string;
  recipe: string;
  model: string | null;
  inputHashes: string[];
}

export interface InsightConfidenceAssessment {
  assessor: string;
  role: InsightAssessorRole;
  value: number;
  evidence: string[];
  assessedAt: string;
}

export interface InsightDocumentReference {
  uri: string;
  observedHash: string | null;
}

export interface InsightRevision {
  schemaVersion: typeof INSIGHT_SCHEMA_VERSION;
  insightId: string;
  revisionId: string;
  kind: InsightKind;
  proposition: string;
  procedure: string | null;
  scope: InsightScope;
  supportEvidence: string[];
  counterEvidence: string[];
  observedAt: string;
  validTime: InsightValidTime;
  recordedAt: string;
  status: InsightStatus;
  supersedes: string | null;
  conflictsWith: string[];
  duplicateOf: string | null;
  riskClass: "low" | "medium" | "high";
  valence: "positive" | "negative" | "neutral";
  origin: InsightOrigin;
  authority: InsightAuthorityRecord[];
  derivation: InsightDerivation | null;
  confidence: InsightConfidenceAssessment[];
  authoritativeDocs: InsightDocumentReference[];
}

export interface InsightTransition {
  schemaVersion: typeof INSIGHT_SCHEMA_VERSION;
  transitionId: string;
  command: InsightTransitionCommand;
  insightId: string;
  revision: InsightRevision;
  priorRevisionId: string | null;
  relatedInsightId: string | null;
  relatedRevisionId: string | null;
  actor: { id: string; kind: "human" | "operator" | "system" };
  authority: InsightAuthorityRecord;
  recordedAt: string;
  reason: string;
  sourceHashes: string[];
  priorLedgerHash: string | null;
  commandHash: string;
}

export interface InsightLedgerSnapshot {
  schemaVersion: typeof INSIGHT_LEDGER_SCHEMA_VERSION;
  ledgerId: string;
  projectIdentity: string;
  previousLedgerHash: string | null;
  transitions: InsightTransition[];
  ledgerHash: string;
}

export interface InsightProjection {
  schemaVersion: typeof INSIGHT_SCHEMA_VERSION;
  ledgerHash: string;
  projectIdentity: string;
  current: Record<string, InsightRevision>;
  history: InsightRevision[];
}
export interface InsightCurrentPointer {
  schemaVersion: typeof INSIGHT_CURRENT_SCHEMA_VERSION;
  projectIdentity: string;
  inputProjectionHash: string;
  sourceAuthorityHash: string;
  recipeHashes: Record<string, string>;
  ledgerHash: string;
  compiledAt: string;
  compiledStateHash: string;
  outputHash: string;
}

export interface InsightValidationError {
  path: string;
  message: string;
}

export type InsightValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; errors: InsightValidationError[] };

export function insightScope(input: InsightScopeInput): InsightScope {
  return {
    user: input.user ?? null,
    organization: input.organization ?? null,
    project: input.project ?? null,
    repository: input.repository ?? null,
    path: input.path ?? null,
    harness: input.harness ?? null,
    model: input.model ?? null,
    tool: input.tool ?? null,
    domain: input.domain,
  };
}

function objectRow(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).toSorted();
  const keys = expected.toSorted();
  return actual.length === keys.length && actual.every((key, index) => key === keys[index]);
}

function text(value: unknown, maximum = MAX_TEXT): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= maximum;
}

function bounded(value: unknown, maximum = MAX_TEXT): value is string {
  return typeof value === "string" && value.length <= maximum;
}

function hash(value: unknown): value is string {
  return typeof value === "string" && HASH.test(value);
}

function timestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) && value.length <= 80;
}

function id(value: unknown): value is string {
  return typeof value === "string" && value.length <= 160 && ID.test(value);
}

function validateHashArray(
  value: unknown,
  path: string,
  errors: InsightValidationError[],
): value is string[] {
  if (!Array.isArray(value) || value.some((item) => !hash(item))) {
    errors.push({ path, message: "must be an array of lowercase SHA-256 hashes" });
    return false;
  }
  if (new Set(value).size !== value.length)
    errors.push({ path, message: "must not contain duplicates" });
  return true;
}

function validateUris(
  value: unknown,
  path: string,
  errors: InsightValidationError[],
): value is string[] {
  if (!Array.isArray(value) || value.length === 0) {
    errors.push({ path, message: "must be a non-empty array of evidence URIs" });
    return false;
  }
  let valid = true;
  for (const [index, uri] of value.entries()) {
    if (typeof uri !== "string" || uri.length > MAX_URI) {
      errors.push({ path: `${path}[${index}]`, message: "must be a bounded URI" });
      valid = false;
      continue;
    }
    try {
      parseEvidenceUri(uri);
    } catch {
      errors.push({
        path: `${path}[${index}]`,
        message: "must be a canonical chatlog evidence URI",
      });
      valid = false;
    }
  }
  if (new Set(value).size !== value.length) {
    errors.push({ path, message: "must not contain duplicate evidence URIs" });
    valid = false;
  }
  return valid;
}

function validateScope(
  value: unknown,
  path: string,
  errors: InsightValidationError[],
): value is InsightScope {
  if (!objectRow(value)) {
    errors.push({ path, message: "must be an object" });
    return false;
  }
  const allowed = [
    "user",
    "organization",
    "project",
    "repository",
    "path",
    "harness",
    "model",
    "tool",
    "domain",
  ] as const;
  if (Object.keys(value).some((key) => !allowed.includes(key as (typeof allowed)[number]))) {
    errors.push({ path, message: "contains an unknown scope axis" });
    return false;
  }
  if (!text(value.domain, 64) || !/^[a-z0-9][a-z0-9_-]{0,63}$/u.test(value.domain)) {
    errors.push({ path: `${path}.domain`, message: "must be a normalized conversation domain" });
  }
  let valid = true;
  for (const axis of allowed.slice(0, -1)) {
    const axisValue = value[axis];
    if (axisValue !== undefined && axisValue !== null && !bounded(axisValue, MAX_AXES)) {
      errors.push({ path: `${path}.${axis}`, message: "must be null or a bounded string" });
      valid = false;
    }
  }
  if (errors.some((error) => error.path === `${path}.domain`)) valid = false;
  return valid;
}

function validateAuthority(
  value: unknown,
  path: string,
  errors: InsightValidationError[],
): value is InsightAuthorityRecord {
  if (
    !objectRow(value) ||
    !exactKeys(value, ["kind", "actor", "authority", "assertedAt", "sourceHashes"])
  ) {
    errors.push({ path, message: "must use the exact authority record" });
    return false;
  }
  let valid = true;
  if (
    !Object.values<InsightAuthorityKind>([
      "source-observation",
      "deterministic-derivation",
      "model-proposal",
      "human-assertion",
      "human-review",
      "measured-evaluation",
      "authoritative-document",
      "assumption",
    ]).includes(value.kind as InsightAuthorityKind)
  ) {
    errors.push({ path: `${path}.kind`, message: "unsupported authority kind" });
    valid = false;
  }
  if (!text(value.actor, 160)) {
    errors.push({ path: `${path}.actor`, message: "must be non-empty bounded text" });
    valid = false;
  }
  if (!text(value.authority, 500)) {
    errors.push({ path: `${path}.authority`, message: "must be non-empty bounded text" });
    valid = false;
  }
  if (!timestamp(value.assertedAt)) {
    errors.push({ path: `${path}.assertedAt`, message: "must be an ISO timestamp" });
    valid = false;
  }
  if (!validateHashArray(value.sourceHashes, `${path}.sourceHashes`, errors)) valid = false;
  return valid;
}

function validateRevision(input: unknown): InsightValidationResult<InsightRevision> {
  const errors: InsightValidationError[] = [];
  if (!objectRow(input))
    return { ok: false, errors: [{ path: "$", message: "revision must be an object" }] };
  const keys = [
    "schemaVersion",
    "insightId",
    "revisionId",
    "kind",
    "proposition",
    "procedure",
    "scope",
    "supportEvidence",
    "counterEvidence",
    "observedAt",
    "validTime",
    "recordedAt",
    "status",
    "supersedes",
    "conflictsWith",
    "duplicateOf",
    "riskClass",
    "valence",
    "origin",
    "authority",
    "derivation",
    "confidence",
    "authoritativeDocs",
  ];
  if (!exactKeys(input, keys))
    errors.push({ path: "$", message: "revision has missing or unknown fields" });
  if (input.schemaVersion !== INSIGHT_SCHEMA_VERSION)
    errors.push({ path: "schemaVersion", message: "must be 2" });
  if (!id(input.insightId))
    errors.push({ path: "insightId", message: "must be a stable lowercase ID" });
  if (!id(input.revisionId))
    errors.push({ path: "revisionId", message: "must be a stable lowercase ID" });
  const kinds: InsightKind[] = [
    "fact",
    "preference",
    "decision",
    "episode",
    "procedure",
    "hypothesis",
    "relationship",
    "current-state",
  ];
  if (!kinds.includes(input.kind as InsightKind))
    errors.push({ path: "kind", message: "unsupported semantic kind" });
  if (!text(input.proposition))
    errors.push({ path: "proposition", message: "must be non-empty bounded text" });
  if (input.procedure !== null && !bounded(input.procedure, MAX_TEXT))
    errors.push({ path: "procedure", message: "must be null or bounded text" });
  const scopeValid = validateScope(input.scope, "scope", errors);
  if (!Array.isArray(input.supportEvidence) || input.supportEvidence.length === 0) {
    errors.push({ path: "supportEvidence", message: "must contain at least one evidence URI" });
  } else if (!validateUris(input.supportEvidence, "supportEvidence", errors)) {
    errors.push({ path: "supportEvidence", message: "contains invalid evidence" });
  }
  if (!Array.isArray(input.counterEvidence))
    errors.push({ path: "counterEvidence", message: "must be an array" });
  else if (input.counterEvidence.length > 0)
    validateUris(input.counterEvidence, "counterEvidence", errors);
  if (!timestamp(input.observedAt))
    errors.push({ path: "observedAt", message: "must be an ISO timestamp" });
  if (!objectRow(input.validTime) || !exactKeys(input.validTime, ["start", "end"])) {
    errors.push({ path: "validTime", message: "must contain exactly start and end" });
  } else {
    if (!timestamp(input.validTime.start))
      errors.push({ path: "validTime.start", message: "must be an ISO timestamp" });
    if (input.validTime.end !== null && !timestamp(input.validTime.end))
      errors.push({ path: "validTime.end", message: "must be null or an ISO timestamp" });
    if (
      timestamp(input.validTime.start) &&
      timestamp(input.validTime.end) &&
      Date.parse(input.validTime.end) < Date.parse(input.validTime.start)
    )
      errors.push({ path: "validTime", message: "end cannot precede start" });
  }
  const statuses: InsightStatus[] = [
    "candidate",
    "active",
    "rejected",
    "disputed",
    "superseded",
    "expired",
    "retired",
  ];
  if (!statuses.includes(input.status as InsightStatus))
    errors.push({ path: "status", message: "unsupported status" });
  if (input.supersedes !== null && !id(input.supersedes))
    errors.push({ path: "supersedes", message: "must be null or an ID" });
  if (!Array.isArray(input.conflictsWith) || input.conflictsWith.some((item) => !id(item)))
    errors.push({ path: "conflictsWith", message: "must be an array of IDs" });
  if (input.duplicateOf !== null && !id(input.duplicateOf))
    errors.push({ path: "duplicateOf", message: "must be null or an ID" });
  if (input.riskClass !== "low" && input.riskClass !== "medium" && input.riskClass !== "high")
    errors.push({ path: "riskClass", message: "must be low, medium, or high" });
  if (input.valence !== "positive" && input.valence !== "negative" && input.valence !== "neutral")
    errors.push({ path: "valence", message: "must be positive, negative, or neutral" });
  let originValid = true;
  if (
    !objectRow(input.origin) ||
    !exactKeys(input.origin, ["kind", "actor", "sourceHashes", "proposalId"])
  ) {
    errors.push({ path: "origin", message: "must use the exact origin record" });
    originValid = false;
  } else {
    if (
      !Object.values<InsightAuthorityKind>([
        "source-observation",
        "deterministic-derivation",
        "model-proposal",
        "human-assertion",
        "human-review",
        "measured-evaluation",
        "authoritative-document",
        "assumption",
      ]).includes(input.origin.kind as InsightAuthorityKind)
    ) {
      errors.push({ path: "origin.kind", message: "unsupported origin kind" });
      originValid = false;
    }
    if (!text(input.origin.actor, 160)) {
      errors.push({ path: "origin.actor", message: "must be non-empty bounded text" });
      originValid = false;
    }
    if (!validateHashArray(input.origin.sourceHashes, "origin.sourceHashes", errors))
      originValid = false;
    if (input.origin.proposalId !== null && !id(input.origin.proposalId)) {
      errors.push({ path: "origin.proposalId", message: "must be null or an ID" });
      originValid = false;
    }
  }
  let authorityValid = true;
  if (!Array.isArray(input.authority) || input.authority.length === 0) {
    errors.push({ path: "authority", message: "must contain at least one record" });
    authorityValid = false;
  } else
    for (const [index, record] of input.authority.entries())
      if (!validateAuthority(record, `authority[${index}]`, errors)) authorityValid = false;
  let derivationValid = true;
  if (input.derivation !== null) {
    if (
      !objectRow(input.derivation) ||
      !exactKeys(input.derivation, ["activity", "recipe", "model", "inputHashes"])
    ) {
      errors.push({ path: "derivation", message: "must use the exact derivation record or null" });
      derivationValid = false;
    } else {
      if (!text(input.derivation.activity, 500)) {
        errors.push({ path: "derivation.activity", message: "must be non-empty bounded text" });
        derivationValid = false;
      }
      if (!text(input.derivation.recipe, 500)) {
        errors.push({ path: "derivation.recipe", message: "must be non-empty bounded text" });
        derivationValid = false;
      }
      if (input.derivation.model !== null && !bounded(input.derivation.model, 500)) {
        errors.push({ path: "derivation.model", message: "must be null or bounded text" });
        derivationValid = false;
      }
      if (!validateHashArray(input.derivation.inputHashes, "derivation.inputHashes", errors))
        derivationValid = false;
    }
  }
  let confidenceValid = true;
  if (!Array.isArray(input.confidence) || input.confidence.length === 0) {
    errors.push({ path: "confidence", message: "must contain assessor-specific records" });
    confidenceValid = false;
  } else
    for (const [index, assessment] of input.confidence.entries()) {
      const path = `confidence[${index}]`;
      if (
        !objectRow(assessment) ||
        !exactKeys(assessment, ["assessor", "role", "value", "evidence", "assessedAt"])
      ) {
        errors.push({ path, message: "must use the exact confidence record" });
        confidenceValid = false;
        continue;
      }
      if (!text(assessment.assessor, 160)) {
        errors.push({ path: `${path}.assessor`, message: "must be non-empty bounded text" });
        confidenceValid = false;
      }
      if (!["human", "model", "system", "evaluation"].includes(String(assessment.role))) {
        errors.push({ path: `${path}.role`, message: "unsupported assessor role" });
        confidenceValid = false;
      }
      if (
        typeof assessment.value !== "number" ||
        !Number.isFinite(assessment.value) ||
        assessment.value < 0 ||
        assessment.value > 1
      ) {
        errors.push({ path: `${path}.value`, message: "must be finite and between 0 and 1" });
        confidenceValid = false;
      }
      if (
        !Array.isArray(assessment.evidence) ||
        assessment.evidence.some((item) => typeof item !== "string" || item.length > MAX_URI)
      ) {
        errors.push({ path: `${path}.evidence`, message: "must be bounded evidence references" });
        confidenceValid = false;
      }
      if (!timestamp(assessment.assessedAt)) {
        errors.push({ path: `${path}.assessedAt`, message: "must be an ISO timestamp" });
        confidenceValid = false;
      }
    }
  let docsValid = true;
  if (!Array.isArray(input.authoritativeDocs)) {
    errors.push({ path: "authoritativeDocs", message: "must be an array" });
    docsValid = false;
  } else
    for (const [index, doc] of input.authoritativeDocs.entries()) {
      const path = `authoritativeDocs[${index}]`;
      if (
        !objectRow(doc) ||
        !exactKeys(doc, ["uri", "observedHash"]) ||
        !text(doc.uri, MAX_URI) ||
        doc.uri.startsWith("chatlog://") ||
        (doc.observedHash !== null && !hash(doc.observedHash))
      ) {
        errors.push({ path, message: "must contain an authoritative URI and observed hash" });
        docsValid = false;
      }
    }
  if (
    !scopeValid ||
    !originValid ||
    !authorityValid ||
    !derivationValid ||
    !confidenceValid ||
    !docsValid ||
    errors.length > 0
  )
    return { ok: false, errors };
  const normalizedScope = insightScope(input.scope as InsightScopeInput);
  const typed = input as unknown as InsightRevision;
  return {
    ok: true,
    value: {
      ...typed,
      scope: normalizedScope,
      supportEvidence: [...typed.supportEvidence],
      counterEvidence: [...typed.counterEvidence],
      conflictsWith: [...typed.conflictsWith],
      authority: [...typed.authority],
      confidence: [...typed.confidence],
      authoritativeDocs: [...typed.authoritativeDocs],
    },
  };
}

export function validateInsightRevision(input: unknown): InsightValidationResult<InsightRevision> {
  return validateRevision(input);
}

export function canonicalInsightRevision(input: InsightRevision): string {
  return stableStringify(input);
}

export function insightRevisionHash(input: Omit<InsightRevision, "revisionId">): string {
  return createHash("sha256").update(stableStringify(input)).digest("hex");
}

export function validateInsightTransition(
  input: unknown,
): InsightValidationResult<InsightTransition> {
  const errors: InsightValidationError[] = [];
  if (
    !objectRow(input) ||
    !exactKeys(input, [
      "schemaVersion",
      "transitionId",
      "command",
      "insightId",
      "revision",
      "priorRevisionId",
      "relatedInsightId",
      "relatedRevisionId",
      "actor",
      "authority",
      "recordedAt",
      "reason",
      "sourceHashes",
      "priorLedgerHash",
      "commandHash",
    ])
  )
    return {
      ok: false,
      errors: [{ path: "$", message: "transition has missing or unknown fields" }],
    };
  if (input.schemaVersion !== INSIGHT_SCHEMA_VERSION)
    errors.push({ path: "schemaVersion", message: "must be 2" });
  if (!id(input.transitionId))
    errors.push({ path: "transitionId", message: "must be a stable ID" });
  const commands: InsightTransitionCommand[] = [
    "accept",
    "accept-with-correction",
    "reject",
    "dispute",
    "resolve-dispute",
    "supersede",
    "expire",
    "retire",
  ];
  if (!commands.includes(input.command as InsightTransitionCommand))
    errors.push({ path: "command", message: "unsupported transition command" });
  if (!id(input.insightId)) errors.push({ path: "insightId", message: "must be a stable ID" });
  const revision = validateRevision(input.revision);
  if (!revision.ok)
    errors.push(...revision.errors.map((error) => ({ ...error, path: `revision.${error.path}` })));
  if (revision.ok && revision.value.insightId !== input.insightId)
    errors.push({ path: "revision.insightId", message: "must match transition insightId" });
  if (input.priorRevisionId !== null && !id(input.priorRevisionId))
    errors.push({ path: "priorRevisionId", message: "must be null or a stable ID" });
  if (input.relatedInsightId !== null && !id(input.relatedInsightId))
    errors.push({ path: "relatedInsightId", message: "must be null or a stable ID" });
  if (input.relatedRevisionId !== null && !id(input.relatedRevisionId))
    errors.push({ path: "relatedRevisionId", message: "must be null or a stable ID" });
  if (
    !objectRow(input.actor) ||
    !exactKeys(input.actor, ["id", "kind"]) ||
    !text(input.actor.id, 160) ||
    !["human", "operator", "system"].includes(String(input.actor.kind))
  )
    errors.push({ path: "actor", message: "must identify a human/operator/system actor" });
  if (!validateAuthority(input.authority, "authority", errors))
    errors.push({ path: "authority", message: "invalid transition authority" });
  if (!timestamp(input.recordedAt))
    errors.push({ path: "recordedAt", message: "must be an ISO timestamp" });
  if (!text(input.reason, MAX_TEXT))
    errors.push({ path: "reason", message: "must be non-empty bounded text" });
  validateHashArray(input.sourceHashes, "sourceHashes", errors);
  if (input.priorLedgerHash !== null && !hash(input.priorLedgerHash))
    errors.push({ path: "priorLedgerHash", message: "must be null or a SHA-256" });
  if (!hash(input.commandHash)) errors.push({ path: "commandHash", message: "must be a SHA-256" });
  if (errors.length > 0 || !revision.ok) return { ok: false, errors };
  return { ok: true, value: input as unknown as InsightTransition };
}

function validateTransitionChain(
  transitions: readonly InsightTransition[],
  errors: InsightValidationError[],
): void {
  const current: Record<string, InsightRevision> = {};
  for (const [index, transition] of transitions.entries()) {
    const priorId =
      transition.command === "supersede" ? transition.relatedInsightId : transition.insightId;
    const prior = priorId === null ? undefined : current[priorId];
    if ((prior?.revisionId ?? null) !== transition.priorRevisionId)
      errors.push({
        path: `transitions[${index}].priorRevisionId`,
        message: "does not match the projected prior revision",
      });
    if (transition.command === "supersede" && transition.relatedInsightId) {
      const old = current[transition.relatedInsightId];
      if (old) current[transition.relatedInsightId] = { ...old, status: "superseded" };
    }
    current[transition.insightId] = transition.revision;
  }
}

export function validateInsightLedger(
  input: unknown,
): InsightValidationResult<InsightLedgerSnapshot> {
  const errors: InsightValidationError[] = [];
  if (
    !objectRow(input) ||
    !exactKeys(input, [
      "schemaVersion",
      "ledgerId",
      "projectIdentity",
      "previousLedgerHash",
      "transitions",
      "ledgerHash",
    ])
  )
    return { ok: false, errors: [{ path: "$", message: "ledger has missing or unknown fields" }] };
  if (input.schemaVersion !== INSIGHT_LEDGER_SCHEMA_VERSION)
    errors.push({ path: "schemaVersion", message: "must be 2" });
  if (!id(input.ledgerId)) errors.push({ path: "ledgerId", message: "must be a stable ID" });
  if (!text(input.projectIdentity, 500))
    errors.push({ path: "projectIdentity", message: "must be non-empty bounded text" });
  if (input.previousLedgerHash !== null && !hash(input.previousLedgerHash))
    errors.push({ path: "previousLedgerHash", message: "must be null or a SHA-256" });
  if (!Array.isArray(input.transitions))
    errors.push({ path: "transitions", message: "must be an array" });
  else {
    for (const [index, transition] of input.transitions.entries()) {
      const result = validateInsightTransition(transition);
      if (!result.ok)
        errors.push(
          ...result.errors.map((error) => ({
            ...error,
            path: `transitions[${index}].${error.path}`,
          })),
        );
    }
    if (input.transitions.every((transition) => validateInsightTransition(transition).ok))
      validateTransitionChain(input.transitions as InsightTransition[], errors);
  }
  if (!hash(input.ledgerHash)) errors.push({ path: "ledgerHash", message: "must be a SHA-256" });
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: input as unknown as InsightLedgerSnapshot };
}

export function projectInsightState(
  ledger: InsightLedgerSnapshot,
  ledgerHash = ledger.ledgerHash,
): InsightProjection {
  const current: Record<string, InsightRevision> = {};
  const history: InsightRevision[] = [];
  for (const transition of ledger.transitions) {
    history.push(transition.revision);
    const priorKey =
      transition.command === "supersede" ? transition.relatedInsightId : transition.insightId;
    const prior = priorKey === null ? undefined : current[priorKey];
    if (prior && prior.revisionId !== transition.priorRevisionId)
      throw new Error(`insight transition chain mismatch for ${transition.insightId}`);
    if (transition.command === "supersede" && transition.relatedInsightId) {
      const old = current[transition.relatedInsightId];
      if (old) current[transition.relatedInsightId] = { ...old, status: "superseded" };
    }
    current[transition.insightId] = transition.revision;
  }
  return {
    schemaVersion: INSIGHT_SCHEMA_VERSION,
    ledgerHash,
    projectIdentity: ledger.projectIdentity,
    current,
    history,
  };
}

export function activeInsightRevisions(
  projection: InsightProjection,
  now = new Date(),
): InsightRevision[] {
  return Object.values(projection.current).filter((revision) => {
    if (revision.status !== "active") return false;
    const start = Date.parse(revision.validTime.start);
    const end =
      revision.validTime.end === null
        ? Number.POSITIVE_INFINITY
        : Date.parse(revision.validTime.end);
    return start <= now.getTime() && now.getTime() < end;
  });
}

export function insightCurrentPointerHash(
  pointer: Omit<InsightCurrentPointer, "outputHash">,
): string {
  return createHash("sha256").update(stableStringify(pointer)).digest("hex");
}

export function validateInsightCurrentPointer(
  input: unknown,
): InsightValidationResult<InsightCurrentPointer> {
  const errors: InsightValidationError[] = [];
  if (
    !objectRow(input) ||
    !exactKeys(input, [
      "schemaVersion",
      "projectIdentity",
      "inputProjectionHash",
      "sourceAuthorityHash",
      "recipeHashes",
      "ledgerHash",
      "compiledAt",
      "compiledStateHash",
      "outputHash",
    ])
  )
    return {
      ok: false,
      errors: [{ path: "$", message: "current pointer has missing or unknown fields" }],
    };
  if (input.schemaVersion !== INSIGHT_CURRENT_SCHEMA_VERSION)
    errors.push({ path: "schemaVersion", message: "must be 2" });
  if (!text(input.projectIdentity, 500))
    errors.push({ path: "projectIdentity", message: "must be non-empty bounded text" });
  for (const key of [
    "inputProjectionHash",
    "sourceAuthorityHash",
    "ledgerHash",
    "compiledStateHash",
    "outputHash",
  ] as const)
    if (!hash(input[key])) errors.push({ path: key, message: "must be a SHA-256" });
  if (!timestamp(input.compiledAt))
    errors.push({ path: "compiledAt", message: "must be an ISO timestamp" });
  if (!objectRow(input.recipeHashes))
    errors.push({ path: "recipeHashes", message: "must be a map" });
  else
    for (const [key, value] of Object.entries(input.recipeHashes))
      if (!/^[a-z][a-z0-9._-]{0,80}$/u.test(key) || !hash(value))
        errors.push({ path: `recipeHashes.${key}`, message: "must map to a SHA-256" });
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: input as unknown as InsightCurrentPointer };
}

export type { ConversationDomain };
