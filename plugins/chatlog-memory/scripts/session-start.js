#!/usr/bin/env bun
// @bun

// src/experience-memory-hook.ts
import { join as join5, resolve as resolve4 } from "path";

// src/experience-memory.ts
import { createHash } from "crypto";
import { mkdir, readFile, writeFile } from "fs/promises";
import { join } from "path";
var EXPERIENCE_MEMORY_SCHEMA_VERSION = 1;
var TIER_ONE_TARGET_TOKENS = 1500;
var TIER_ONE_MAX_TOKENS = 2000;
var MAX_LEDGER_ID = 160;
var MAX_PROJECT_IDENTITY = 500;
var MAX_MEMORY_ID = 120;
var MAX_TRIGGER = 500;
var MAX_ACTION = 500;
var MAX_CARD_TEXT = 4000;
var MAX_POINTER = 2000;
var MAX_ENTRIES = 500;
function ok(value) {
  return { ok: true, value };
}
function fail(code, message, issues) {
  return { ok: false, error: { code, message, ...issues === undefined ? {} : { issues } } };
}
function objectRow(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function exactKeys(value, keys) {
  const actual = Object.keys(value).toSorted();
  const expected = keys.toSorted();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}
function boundedText(value, maximum) {
  return typeof value === "string" && value.trim().length > 0 && value.length <= maximum;
}
function singleLineText(value, maximum) {
  return boundedText(value, maximum) && !value.includes(`
`) && !value.includes("\r");
}
function validMemoryId(value) {
  return singleLineText(value, MAX_MEMORY_ID) && /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/u.test(value);
}
function validateScope(value, path, issues) {
  if (!objectRow(value) || !exactKeys(value, ["kind", "value"])) {
    issues.push(`${path} must contain exactly kind and value`);
    return false;
  }
  if (value.kind !== "global" && value.kind !== "repository" && value.kind !== "path" && value.kind !== "tool" && value.kind !== "model" && value.kind !== "harness") {
    issues.push(`${path}.kind is not a supported scope`);
    return false;
  }
  if (value.kind === "global") {
    if (value.value !== null) {
      issues.push(`${path}.value must be null for global scope`);
      return false;
    }
    return true;
  }
  if (!singleLineText(value.value, MAX_PROJECT_IDENTITY)) {
    issues.push(`${path}.value must be a bounded single-line string`);
    return false;
  }
  return true;
}
function validatePointers(value, path, kind, issues) {
  if (!Array.isArray(value) || value.length === 0) {
    issues.push(`${path} must be a non-empty array`);
    return false;
  }
  let valid = true;
  const unique = new Set;
  for (const [index, pointer] of value.entries()) {
    if (!singleLineText(pointer, MAX_POINTER)) {
      issues.push(`${path}[${index}] must be a bounded single-line string`);
      valid = false;
      continue;
    }
    if (kind === "evidence" && !pointer.startsWith("chatlog://")) {
      issues.push(`${path}[${index}] must use chatlog://`);
      valid = false;
    }
    if (kind === "documentation" && pointer.startsWith("chatlog://")) {
      issues.push(`${path}[${index}] must point to authoritative documentation`);
      valid = false;
    }
    if (unique.has(pointer)) {
      issues.push(`${path}[${index}] duplicates an earlier pointer`);
      valid = false;
    }
    unique.add(pointer);
  }
  return valid;
}
function validateEntry(value, index, issues) {
  const path = `entries[${index}]`;
  const keys = [
    "id",
    "status",
    "judgment",
    "valence",
    "provenance",
    "trigger",
    "scope",
    "polarity",
    "action",
    "situation",
    "outcome",
    "lesson",
    "confidence",
    "freshness",
    "canonicalDocs",
    "evidencePointers"
  ];
  if (!objectRow(value) || !exactKeys(value, keys)) {
    issues.push(`${path} has missing or unknown fields`);
    return false;
  }
  let valid = true;
  if (!validMemoryId(value.id)) {
    issues.push(`${path}.id must be a stable lowercase memory ID`);
    valid = false;
  }
  if (value.status !== "accepted") {
    issues.push(`${path}.status must be accepted`);
    valid = false;
  }
  if (value.judgment !== "correct") {
    issues.push(`${path}.judgment must be correct`);
    valid = false;
  }
  if (value.valence !== "positive" && value.valence !== "negative" && value.valence !== "neutral") {
    issues.push(`${path}.valence must be positive, negative, or neutral`);
    valid = false;
  }
  if (!objectRow(value.provenance) || !exactKeys(value.provenance, [
    "packetHash",
    "proposalSetHash",
    "operatorReviewHash",
    "candidateAlias",
    "candidateId"
  ])) {
    issues.push(`${path}.provenance has missing or unknown fields`);
    valid = false;
  } else {
    for (const field of ["packetHash", "proposalSetHash", "operatorReviewHash"]) {
      if (typeof value.provenance[field] !== "string" || !/^[a-f0-9]{64}$/u.test(value.provenance[field])) {
        issues.push(`${path}.provenance.${field} must be a lowercase SHA-256`);
        valid = false;
      }
    }
    if (!/^C[0-9]{3}$/u.test(String(value.provenance.candidateAlias))) {
      issues.push(`${path}.provenance.candidateAlias must be a blinded candidate alias`);
      valid = false;
    }
    if (typeof value.provenance.candidateId !== "string" || !/^[a-f0-9]{20}$/u.test(value.provenance.candidateId)) {
      issues.push(`${path}.provenance.candidateId must be a refinery candidate ID`);
      valid = false;
    }
  }
  if (!singleLineText(value.trigger, MAX_TRIGGER)) {
    issues.push(`${path}.trigger must be a bounded single-line string`);
    valid = false;
  }
  if (!validateScope(value.scope, `${path}.scope`, issues))
    valid = false;
  if (value.polarity !== "prefer" && value.polarity !== "avoid" && value.polarity !== "check") {
    issues.push(`${path}.polarity must be prefer, avoid, or check`);
    valid = false;
  }
  if (!singleLineText(value.action, MAX_ACTION)) {
    issues.push(`${path}.action must be a bounded single-line string`);
    valid = false;
  }
  for (const field of ["situation", "outcome", "lesson"]) {
    if (!boundedText(value[field], MAX_CARD_TEXT)) {
      issues.push(`${path}.${field} must be bounded non-empty text`);
      valid = false;
    }
  }
  if (typeof value.confidence !== "number" || !Number.isFinite(value.confidence) || value.confidence < 0 || value.confidence > 1) {
    issues.push(`${path}.confidence must be a finite number from 0 to 1`);
    valid = false;
  }
  if (value.freshness !== "current") {
    issues.push(`${path}.freshness must be current`);
    valid = false;
  }
  if (!validatePointers(value.canonicalDocs, `${path}.canonicalDocs`, "documentation", issues)) {
    valid = false;
  }
  if (!validatePointers(value.evidencePointers, `${path}.evidencePointers`, "evidence", issues)) {
    valid = false;
  }
  return valid;
}
function validateAcceptedMemoryLedger(input) {
  const issues = [];
  if (!objectRow(input) || !exactKeys(input, ["schemaVersion", "ledgerId", "projectIdentity", "entries"])) {
    return fail("invalid-ledger", "Accepted memory ledger has missing or unknown fields");
  }
  if (input.schemaVersion !== EXPERIENCE_MEMORY_SCHEMA_VERSION) {
    issues.push("schemaVersion must be 1");
  }
  if (!singleLineText(input.ledgerId, MAX_LEDGER_ID)) {
    issues.push("ledgerId must be a bounded single-line string");
  }
  if (!singleLineText(input.projectIdentity, MAX_PROJECT_IDENTITY)) {
    issues.push("projectIdentity must be a bounded single-line string");
  }
  if (!Array.isArray(input.entries) || input.entries.length === 0) {
    issues.push("entries must be a non-empty array");
  } else if (input.entries.length > MAX_ENTRIES) {
    issues.push(`entries exceeds the ${MAX_ENTRIES}-entry bound`);
  } else {
    const identifiers = new Set;
    for (const [index, entry] of input.entries.entries()) {
      const valid = validateEntry(entry, index, issues);
      if (valid) {
        if (identifiers.has(entry.id))
          issues.push(`entries[${index}].id is duplicated`);
        identifiers.add(entry.id);
      }
    }
  }
  if (issues.length > 0) {
    return fail("invalid-ledger", "Accepted memory ledger failed strict validation", issues);
  }
  return ok(input);
}
function renderScope(scope) {
  return scope.kind === "global" ? "global" : `${scope.kind}:${scope.value}`;
}
function renderTierOne(entries) {
  const sections = entries.map((entry) => [
    `## ${entry.id}`,
    `- USE WHEN: ${entry.trigger}`,
    `- Scope: ${renderScope(entry.scope)}`,
    `- Polarity: ${entry.polarity}`,
    `- Action: ${entry.action}`
  ].join(`
`));
  return `${sections.join(`

`)}
`;
}
function estimateMemoryTokens(content) {
  return Math.ceil(new TextEncoder().encode(content).byteLength / 3);
}
function compileMemorySnapshot(input) {
  const validated = validateAcceptedMemoryLedger(input);
  if (!validated.ok)
    return validated;
  const entries = validated.value.entries.toSorted((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
  const content = renderTierOne(entries);
  const bytes = new TextEncoder().encode(content).byteLength;
  const estimatedTokens = estimateMemoryTokens(content);
  if (estimatedTokens > TIER_ONE_MAX_TOKENS) {
    return fail("snapshot-too-large", `Tier 1 snapshot is ${estimatedTokens} estimated tokens; maximum is ${TIER_ONE_MAX_TOKENS}`);
  }
  return ok({
    schemaVersion: EXPERIENCE_MEMORY_SCHEMA_VERSION,
    sha256: createHash("sha256").update(content).digest("hex"),
    content,
    bytes,
    estimatedTokens,
    withinTarget: estimatedTokens <= TIER_ONE_TARGET_TOKENS,
    entryIds: entries.map((entry) => entry.id)
  });
}
function validSessionPin(input, sessionId) {
  if (!objectRow(input) || !exactKeys(input, ["schemaVersion", "sessionId", "snapshotHash", "content"]) || input.schemaVersion !== EXPERIENCE_MEMORY_SCHEMA_VERSION || input.sessionId !== sessionId || typeof input.snapshotHash !== "string" || !/^[a-f0-9]{64}$/u.test(input.snapshotHash) || typeof input.content !== "string") {
    return false;
  }
  return estimateMemoryTokens(input.content) <= TIER_ONE_MAX_TOKENS && createHash("sha256").update(input.content).digest("hex") === input.snapshotHash;
}
function validCompiledSnapshot(value) {
  return objectRow(value) && exactKeys(value, [
    "schemaVersion",
    "sha256",
    "content",
    "bytes",
    "estimatedTokens",
    "withinTarget",
    "entryIds"
  ]) && value.schemaVersion === EXPERIENCE_MEMORY_SCHEMA_VERSION && typeof value.content === "string" && new TextEncoder().encode(value.content).byteLength === value.bytes && estimateMemoryTokens(value.content) === value.estimatedTokens && value.estimatedTokens <= TIER_ONE_MAX_TOKENS && value.withinTarget === value.estimatedTokens <= TIER_ONE_TARGET_TOKENS && /^[a-f0-9]{64}$/u.test(value.sha256) && createHash("sha256").update(value.content).digest("hex") === value.sha256 && Array.isArray(value.entryIds) && value.entryIds.every(validMemoryId) && new Set(value.entryIds).size === value.entryIds.length && value.entryIds.every((id, index) => index === 0 || value.entryIds[index - 1] < id);
}
function storageError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return fail("storage-error", `Could not access the session memory pin: ${message}`);
}
async function readPin(path, sessionId) {
  try {
    const input = JSON.parse(await readFile(path, "utf8"));
    return validSessionPin(input, sessionId) ? ok(input) : fail("invalid-session-pin", "Existing session memory pin is invalid");
  } catch (error) {
    return storageError(error);
  }
}
async function prepareStartupMemory(input) {
  if (input.source !== "startup")
    return ok({ emitted: false, reason: "not-startup" });
  if (!singleLineText(input.sessionId, 500) || !boundedText(input.pinDirectory, 4000) || !validCompiledSnapshot(input.snapshot)) {
    return fail("invalid-startup-request", "Startup source, session ID, directory, or snapshot is invalid");
  }
  const pinName = `${createHash("sha256").update(input.sessionId).digest("hex")}.json`;
  const pinPath = join(input.pinDirectory, pinName);
  const pin = {
    schemaVersion: EXPERIENCE_MEMORY_SCHEMA_VERSION,
    sessionId: input.sessionId,
    snapshotHash: input.snapshot.sha256,
    content: input.snapshot.content
  };
  try {
    await mkdir(input.pinDirectory, { recursive: true, mode: 448 });
    await writeFile(pinPath, `${JSON.stringify(pin)}
`, {
      encoding: "utf8",
      flag: "wx",
      mode: 384
    });
    return ok({
      emitted: true,
      snapshotHash: pin.snapshotHash,
      content: pin.content,
      pinned: false
    });
  } catch (error) {
    if (objectRow(error) && error.code === "EEXIST") {
      const existing = await readPin(pinPath, input.sessionId);
      if (!existing.ok)
        return existing;
      return ok({
        emitted: true,
        snapshotHash: existing.value.snapshotHash,
        content: existing.value.content,
        pinned: true
      });
    }
    return storageError(error);
  }
}

// src/experience-memory-store.ts
import { createHash as createHash4, randomUUID as randomUUID2 } from "crypto";
import { chmod as chmod2, mkdir as mkdir3, readFile as readFile3, rename as rename2, writeFile as writeFile3 } from "fs/promises";
import { dirname as dirname2, join as join3, resolve as resolve2 } from "path";

// src/insight-compiler.ts
import { createHash as createHash2 } from "crypto";

// src/events.ts
var SEMANTIC_LOSS_CODES = [
  "capture-policy-omission",
  "provider-field-unsupported",
  "encrypted-content-unavailable",
  "attachment-body-excluded",
  "reasoning-excluded-from-projection",
  "unknown-well-formed-item",
  "partial-live-tail",
  "relation-target-missing"
];
var SEMANTIC_LOSS_CODE_SET = new Set(SEMANTIC_LOSS_CODES);
var AGENT_EVENT_KINDS = [
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
  "provider.opaque"
];
var EVENT_KINDS = new Set(AGENT_EVENT_KINDS);
var canonicalEventBatches = new WeakSet;
function canonicalValue(value) {
  if (Array.isArray(value))
    return value.map(canonicalValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, child]) => [key, canonicalValue(child)]));
  }
  return value;
}
function stableStringify(value) {
  return JSON.stringify(canonicalValue(value));
}

// src/evidence-uri.ts
var EVIDENCE_URI_PATTERN = "^(?:chatlog://conversation/([a-fA-F0-9]{64})/turn/([0-9]+)|chatlog://event/([a-fA-F0-9]{64})/([a-fA-F0-9]{64}))$";
var evidenceUriRegex = new RegExp(EVIDENCE_URI_PATTERN);

class EvidenceUriError extends Error {
  name = "EvidenceUriError";
}
function invalidEvidenceUri(message) {
  throw new EvidenceUriError(message);
}
function eventEvidenceUri(batchHash, eventId) {
  if (!/^[a-f0-9]{64}$/i.test(batchHash) || !/^[a-f0-9]{64}$/i.test(eventId))
    invalidEvidenceUri("event evidence pointers require SHA-256 hashes");
  return `chatlog://event/${batchHash.toLowerCase()}/${eventId.toLowerCase()}`;
}
function parseEvidenceUri(value) {
  if (typeof value !== "string")
    invalidEvidenceUri("uri must be a chatlog evidence URI");
  const match = evidenceUriRegex.exec(value);
  if (!match)
    invalidEvidenceUri("invalid chatlog evidence URI");
  if (match[1] && match[2]) {
    const contentHash = match[1].toLowerCase();
    const turnIndex = Number(match[2]);
    if (!Number.isSafeInteger(turnIndex))
      invalidEvidenceUri("invalid chatlog turn index");
    return {
      uri: `chatlog://conversation/${contentHash}/turn/${turnIndex}`,
      contentHash,
      turnIndex
    };
  }
  const batchHash = match[3].toLowerCase();
  const eventId = match[4].toLowerCase();
  return {
    uri: eventEvidenceUri(batchHash, eventId),
    contentHash: batchHash,
    batchHash,
    eventId
  };
}

// src/insights.ts
var INSIGHT_SCHEMA_VERSION = 2;
var INSIGHT_LEDGER_SCHEMA_VERSION = 2;
var INSIGHT_CURRENT_SCHEMA_VERSION = 2;
var HASH = /^[a-f0-9]{64}$/u;
var ID = /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/u;
var MAX_TEXT = 8000;
var MAX_URI = 2000;
var MAX_AXES = 500;
function insightScope(input) {
  return {
    user: input.user ?? null,
    organization: input.organization ?? null,
    project: input.project ?? null,
    repository: input.repository ?? null,
    path: input.path ?? null,
    harness: input.harness ?? null,
    model: input.model ?? null,
    tool: input.tool ?? null,
    domain: input.domain
  };
}
function objectRow2(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function exactKeys2(value, expected) {
  const actual = Object.keys(value).toSorted();
  const keys = expected.toSorted();
  return actual.length === keys.length && actual.every((key, index) => key === keys[index]);
}
function text(value, maximum = MAX_TEXT) {
  return typeof value === "string" && value.trim().length > 0 && value.length <= maximum;
}
function bounded(value, maximum = MAX_TEXT) {
  return typeof value === "string" && value.length <= maximum;
}
function hash(value) {
  return typeof value === "string" && HASH.test(value);
}
function timestamp(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) && value.length <= 80;
}
function id(value) {
  return typeof value === "string" && value.length <= 160 && ID.test(value);
}
function validateHashArray(value, path, errors) {
  if (!Array.isArray(value) || value.some((item) => !hash(item))) {
    errors.push({ path, message: "must be an array of lowercase SHA-256 hashes" });
    return false;
  }
  if (new Set(value).size !== value.length)
    errors.push({ path, message: "must not contain duplicates" });
  return true;
}
function validateUris(value, path, errors) {
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
        message: "must be a canonical chatlog evidence URI"
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
function validateScope2(value, path, errors) {
  if (!objectRow2(value)) {
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
    "domain"
  ];
  if (Object.keys(value).some((key) => !allowed.includes(key))) {
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
  if (errors.some((error) => error.path === `${path}.domain`))
    valid = false;
  return valid;
}
function validateAuthority(value, path, errors) {
  if (!objectRow2(value) || !exactKeys2(value, ["kind", "actor", "authority", "assertedAt", "sourceHashes"])) {
    errors.push({ path, message: "must use the exact authority record" });
    return false;
  }
  let valid = true;
  if (!Object.values([
    "source-observation",
    "deterministic-derivation",
    "model-proposal",
    "human-assertion",
    "human-review",
    "measured-evaluation",
    "authoritative-document",
    "assumption"
  ]).includes(value.kind)) {
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
  if (!validateHashArray(value.sourceHashes, `${path}.sourceHashes`, errors))
    valid = false;
  return valid;
}
function validateRevision(input) {
  const errors = [];
  if (!objectRow2(input))
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
    "authoritativeDocs"
  ];
  if (!exactKeys2(input, keys))
    errors.push({ path: "$", message: "revision has missing or unknown fields" });
  if (input.schemaVersion !== INSIGHT_SCHEMA_VERSION)
    errors.push({ path: "schemaVersion", message: "must be 2" });
  if (!id(input.insightId))
    errors.push({ path: "insightId", message: "must be a stable lowercase ID" });
  if (!id(input.revisionId))
    errors.push({ path: "revisionId", message: "must be a stable lowercase ID" });
  const kinds = [
    "fact",
    "preference",
    "decision",
    "episode",
    "procedure",
    "hypothesis",
    "relationship",
    "current-state"
  ];
  if (!kinds.includes(input.kind))
    errors.push({ path: "kind", message: "unsupported semantic kind" });
  if (!text(input.proposition))
    errors.push({ path: "proposition", message: "must be non-empty bounded text" });
  if (input.procedure !== null && !bounded(input.procedure, MAX_TEXT))
    errors.push({ path: "procedure", message: "must be null or bounded text" });
  const scopeValid = validateScope2(input.scope, "scope", errors);
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
  if (!objectRow2(input.validTime) || !exactKeys2(input.validTime, ["start", "end"])) {
    errors.push({ path: "validTime", message: "must contain exactly start and end" });
  } else {
    if (!timestamp(input.validTime.start))
      errors.push({ path: "validTime.start", message: "must be an ISO timestamp" });
    if (input.validTime.end !== null && !timestamp(input.validTime.end))
      errors.push({ path: "validTime.end", message: "must be null or an ISO timestamp" });
    if (timestamp(input.validTime.start) && timestamp(input.validTime.end) && Date.parse(input.validTime.end) < Date.parse(input.validTime.start))
      errors.push({ path: "validTime", message: "end cannot precede start" });
  }
  const statuses = [
    "candidate",
    "active",
    "rejected",
    "disputed",
    "superseded",
    "expired",
    "retired"
  ];
  if (!statuses.includes(input.status))
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
  if (!objectRow2(input.origin) || !exactKeys2(input.origin, ["kind", "actor", "sourceHashes", "proposalId"])) {
    errors.push({ path: "origin", message: "must use the exact origin record" });
    originValid = false;
  } else {
    if (!Object.values([
      "source-observation",
      "deterministic-derivation",
      "model-proposal",
      "human-assertion",
      "human-review",
      "measured-evaluation",
      "authoritative-document",
      "assumption"
    ]).includes(input.origin.kind)) {
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
      if (!validateAuthority(record, `authority[${index}]`, errors))
        authorityValid = false;
  let derivationValid = true;
  if (input.derivation !== null) {
    if (!objectRow2(input.derivation) || !exactKeys2(input.derivation, ["activity", "recipe", "model", "inputHashes"])) {
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
      if (!objectRow2(assessment) || !exactKeys2(assessment, ["assessor", "role", "value", "evidence", "assessedAt"])) {
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
      if (typeof assessment.value !== "number" || !Number.isFinite(assessment.value) || assessment.value < 0 || assessment.value > 1) {
        errors.push({ path: `${path}.value`, message: "must be finite and between 0 and 1" });
        confidenceValid = false;
      }
      if (!Array.isArray(assessment.evidence) || assessment.evidence.some((item) => typeof item !== "string" || item.length > MAX_URI)) {
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
      if (!objectRow2(doc) || !exactKeys2(doc, ["uri", "observedHash"]) || !text(doc.uri, MAX_URI) || doc.uri.startsWith("chatlog://") || doc.observedHash !== null && !hash(doc.observedHash)) {
        errors.push({ path, message: "must contain an authoritative URI and observed hash" });
        docsValid = false;
      }
    }
  if (!scopeValid || !originValid || !authorityValid || !derivationValid || !confidenceValid || !docsValid || errors.length > 0)
    return { ok: false, errors };
  const normalizedScope = insightScope(input.scope);
  const typed = input;
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
      authoritativeDocs: [...typed.authoritativeDocs]
    }
  };
}
function validateInsightTransition(input) {
  const errors = [];
  if (!objectRow2(input) || !exactKeys2(input, [
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
    "commandHash"
  ]))
    return {
      ok: false,
      errors: [{ path: "$", message: "transition has missing or unknown fields" }]
    };
  if (input.schemaVersion !== INSIGHT_SCHEMA_VERSION)
    errors.push({ path: "schemaVersion", message: "must be 2" });
  if (!id(input.transitionId))
    errors.push({ path: "transitionId", message: "must be a stable ID" });
  const commands = [
    "accept",
    "accept-with-correction",
    "reject",
    "dispute",
    "resolve-dispute",
    "supersede",
    "expire",
    "retire"
  ];
  if (!commands.includes(input.command))
    errors.push({ path: "command", message: "unsupported transition command" });
  if (!id(input.insightId))
    errors.push({ path: "insightId", message: "must be a stable ID" });
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
  if (!objectRow2(input.actor) || !exactKeys2(input.actor, ["id", "kind"]) || !text(input.actor.id, 160) || !["human", "operator", "system"].includes(String(input.actor.kind)))
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
  if (!hash(input.commandHash))
    errors.push({ path: "commandHash", message: "must be a SHA-256" });
  if (errors.length > 0 || !revision.ok)
    return { ok: false, errors };
  return { ok: true, value: input };
}
function validateTransitionChain(transitions, errors) {
  const current = {};
  for (const [index, transition] of transitions.entries()) {
    const priorId = transition.command === "supersede" ? transition.relatedInsightId : transition.insightId;
    const prior = priorId === null ? undefined : current[priorId];
    if ((prior?.revisionId ?? null) !== transition.priorRevisionId)
      errors.push({
        path: `transitions[${index}].priorRevisionId`,
        message: "does not match the projected prior revision"
      });
    if (transition.command === "supersede" && transition.relatedInsightId) {
      const old = current[transition.relatedInsightId];
      if (old)
        current[transition.relatedInsightId] = { ...old, status: "superseded" };
    }
    current[transition.insightId] = transition.revision;
  }
}
function validateInsightLedger(input) {
  const errors = [];
  if (!objectRow2(input) || !exactKeys2(input, [
    "schemaVersion",
    "ledgerId",
    "projectIdentity",
    "previousLedgerHash",
    "transitions",
    "ledgerHash"
  ]))
    return { ok: false, errors: [{ path: "$", message: "ledger has missing or unknown fields" }] };
  if (input.schemaVersion !== INSIGHT_LEDGER_SCHEMA_VERSION)
    errors.push({ path: "schemaVersion", message: "must be 2" });
  if (!id(input.ledgerId))
    errors.push({ path: "ledgerId", message: "must be a stable ID" });
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
        errors.push(...result.errors.map((error) => ({
          ...error,
          path: `transitions[${index}].${error.path}`
        })));
    }
    if (input.transitions.every((transition) => validateInsightTransition(transition).ok))
      validateTransitionChain(input.transitions, errors);
  }
  if (!hash(input.ledgerHash))
    errors.push({ path: "ledgerHash", message: "must be a SHA-256" });
  if (errors.length > 0)
    return { ok: false, errors };
  return { ok: true, value: input };
}
function projectInsightState(ledger, ledgerHash = ledger.ledgerHash) {
  const current = {};
  const history = [];
  for (const transition of ledger.transitions) {
    history.push(transition.revision);
    const priorKey = transition.command === "supersede" ? transition.relatedInsightId : transition.insightId;
    const prior = priorKey === null ? undefined : current[priorKey];
    if (prior && prior.revisionId !== transition.priorRevisionId)
      throw new Error(`insight transition chain mismatch for ${transition.insightId}`);
    if (transition.command === "supersede" && transition.relatedInsightId) {
      const old = current[transition.relatedInsightId];
      if (old)
        current[transition.relatedInsightId] = { ...old, status: "superseded" };
    }
    current[transition.insightId] = transition.revision;
  }
  return {
    schemaVersion: INSIGHT_SCHEMA_VERSION,
    ledgerHash,
    projectIdentity: ledger.projectIdentity,
    current,
    history
  };
}
function activeInsightRevisions(projection, now = new Date) {
  return Object.values(projection.current).filter((revision) => {
    if (revision.status !== "active")
      return false;
    const start = Date.parse(revision.validTime.start);
    const end = revision.validTime.end === null ? Number.POSITIVE_INFINITY : Date.parse(revision.validTime.end);
    return start <= now.getTime() && now.getTime() < end;
  });
}
function validateInsightCurrentPointer(input) {
  const errors = [];
  if (!objectRow2(input) || !exactKeys2(input, [
    "schemaVersion",
    "projectIdentity",
    "inputProjectionHash",
    "sourceAuthorityHash",
    "recipeHashes",
    "ledgerHash",
    "compiledAt",
    "compiledStateHash",
    "outputHash"
  ]))
    return {
      ok: false,
      errors: [{ path: "$", message: "current pointer has missing or unknown fields" }]
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
    "outputHash"
  ])
    if (!hash(input[key]))
      errors.push({ path: key, message: "must be a SHA-256" });
  if (!timestamp(input.compiledAt))
    errors.push({ path: "compiledAt", message: "must be an ISO timestamp" });
  if (!objectRow2(input.recipeHashes))
    errors.push({ path: "recipeHashes", message: "must be a map" });
  else
    for (const [key, value] of Object.entries(input.recipeHashes))
      if (!/^[a-z][a-z0-9._-]{0,80}$/u.test(key) || !hash(value))
        errors.push({ path: `recipeHashes.${key}`, message: "must map to a SHA-256" });
  if (errors.length > 0)
    return { ok: false, errors };
  return { ok: true, value: input };
}

// src/insight-compiler.ts
var INSIGHT_COMPILED_SCHEMA_VERSION = 2;
var SUPPORTED_INSIGHT_RISK_CLASSES = new Set([
  "low",
  "medium",
  "high"
]);
var TARGET_TOKENS = 1500;
var MAX_TOKENS = 2000;
function hash2(value) {
  return createHash2("sha256").update(value).digest("hex");
}
function estimate(content) {
  return Math.ceil(new TextEncoder().encode(content).byteLength / 3);
}
function scopeMatches(scope, requested) {
  return Object.entries(requested).every(([axis, value]) => {
    if (value === undefined || value === null)
      return true;
    return scope[axis] === value;
  });
}
function evidenceAvailable(revision, activeEvidence) {
  return activeEvidence === undefined || [...revision.supportEvidence, ...revision.counterEvidence].every((uri) => activeEvidence.has(uri));
}
function noUnresolvedConflict(revision, current) {
  return revision.conflictsWith.every((id2) => {
    const other = current[id2];
    return !other || other.status !== "active";
  });
}
function riskSupported(revision, supported) {
  const risk = revision.riskClass ?? "low";
  return supported.has(risk);
}
function renderScope2(scope) {
  const parts = Object.entries(scope).filter(([, value]) => value !== null && value !== undefined).map(([key, value]) => `${key}:${value}`);
  return parts.join(",") || "global";
}
function renderTierOne2(entries) {
  return `${entries.map((entry) => {
    const trigger = entry.proposition.replace(/\s+/gu, " ").trim().slice(0, 240);
    const action = entry.procedure?.replace(/\s+/gu, " ").trim().slice(0, 240) ?? "recall the current insight card";
    return [
      `## ${entry.id}`,
      `- USE WHEN: ${trigger}`,
      `- Scope: ${renderScope2(entry.scope)}`,
      `- Kind: ${entry.kind}`,
      `- Action: ${action}`
    ].join(`
`);
  }).join(`

`)}
`;
}
function eligible(revision, projection, options) {
  if (revision.status !== "active")
    return false;
  if (options.staleRevisionIds?.has(revision.revisionId))
    return false;
  if (!scopeMatches(revision.scope, options.scope ?? {}))
    return false;
  const now = options.now.getTime();
  const start = Date.parse(revision.validTime.start);
  const end = revision.validTime.end === null ? Number.POSITIVE_INFINITY : Date.parse(revision.validTime.end);
  if (!(start <= now && now < end))
    return false;
  if (!evidenceAvailable(revision, options.activeEvidence))
    return false;
  if (!revision.authority.some((record) => record.kind === "human-review" || record.kind === "human-assertion"))
    return false;
  if (!noUnresolvedConflict(revision, projection.current))
    return false;
  if (revision.duplicateOf !== null)
    return false;
  return riskSupported(revision, options.supportedRiskClasses);
}
function compileInsightProjection(projection, options = {}) {
  const now = options.now ?? new Date;
  const compiledAt = now.toISOString();
  const supportedRiskClasses = options.supportedRiskClasses ?? new Set(["low", "medium"]);
  const revisions = activeInsightRevisions(projection, now).filter((revision) => eligible(revision, projection, { ...options, now, supportedRiskClasses })).toSorted((left, right) => left.insightId.localeCompare(right.insightId) || left.revisionId.localeCompare(right.revisionId));
  const entries = revisions.map((revision) => ({
    id: revision.insightId,
    kind: revision.kind,
    proposition: revision.proposition,
    procedure: revision.procedure,
    scope: { ...revision.scope },
    validTime: { ...revision.validTime },
    supportEvidence: [...revision.supportEvidence],
    counterEvidence: [...revision.counterEvidence]
  }));
  const stateBytes = stableStringify({
    compiledAt,
    ledgerHash: projection.ledgerHash,
    projectIdentity: projection.projectIdentity,
    revisions
  });
  const content = renderTierOne2(entries);
  const estimatedTokens = estimate(content);
  if (estimatedTokens > MAX_TOKENS)
    return { ok: false, error: `compiled Tier 1 snapshot exceeds ${MAX_TOKENS} tokens` };
  const outputHash = hash2(content);
  return {
    ok: true,
    value: {
      schemaVersion: INSIGHT_COMPILED_SCHEMA_VERSION,
      ledgerHash: projection.ledgerHash,
      projectIdentity: options.projectIdentity ?? projection.projectIdentity,
      compiledAt,
      compiledStateHash: hash2(stateBytes),
      outputHash,
      content,
      bytes: new TextEncoder().encode(content).byteLength,
      estimatedTokens,
      withinTarget: estimatedTokens <= TARGET_TOKENS,
      entryIds: entries.map((entry) => entry.id),
      entries
    }
  };
}

// src/insight-ledger.ts
import { createHash as createHash3, randomUUID } from "crypto";
import { Database } from "bun:sqlite";
import { chmod, mkdir as mkdir2, open, readFile as readFile2, rename, stat, unlink, writeFile as writeFile2 } from "fs/promises";
import { dirname, join as join2, resolve } from "path";
var HASH2 = /^[a-f0-9]{64}$/u;
function hashBytes(bytes) {
  return createHash3("sha256").update(bytes).digest("hex");
}
function insightLedgerHash(ledger) {
  const { ledgerHash: _ledgerHash, ...payload } = ledger;
  return hashBytes(stableStringify(payload));
}
function storageFailure(error) {
  return {
    ok: false,
    error: {
      code: "storage-error",
      message: error instanceof Error ? error.message : String(error)
    }
  };
}
function invalid(code, message, issues) {
  return { ok: false, error: { code, message, ...issues ? { issues } : {} } };
}
function hashRows(value) {
  return hashBytes(stableStringify(value));
}
async function readInsightPublicationContext(root) {
  const path = join2(resolve(root), "analysis", "chatlog.sqlite");
  try {
    await stat(path);
    const db = new Database(path, { readonly: true, create: false });
    try {
      const sources = db.query(`SELECT source_path sourcePath, content_hash contentHash, event_batch_hash eventBatchHash,
        projection_hash projectionHash, receipt_hash receiptHash FROM active_sources ORDER BY source_path`).all();
      const turns = db.query(`SELECT content_hash contentHash, turn_index turnIndex FROM current_turns ORDER BY content_hash, turn_index`).all();
      const events = db.query(`SELECT e.batch_hash batchHash, e.event_id eventId FROM event_metadata e
        JOIN active_sources a ON a.event_batch_hash = e.batch_hash ORDER BY e.batch_hash, e.event_id`).all();
      const meta = db.query("SELECT manifest_sources_hash manifestSourcesHash FROM active_projection_meta WHERE singleton = 1").get();
      const activeEvidence = new Set;
      for (const row of turns)
        activeEvidence.add(`chatlog://conversation/${row.contentHash}/turn/${row.turnIndex}`);
      for (const row of events)
        activeEvidence.add(eventEvidenceUri(row.batchHash, row.eventId));
      return {
        ok: true,
        value: {
          inputProjectionHash: hashRows({ sources, turns, events }),
          sourceAuthorityHash: meta?.manifestSourcesHash && HASH2.test(meta.manifestSourcesHash) ? meta.manifestSourcesHash : hashRows(sources),
          activeEvidence
        }
      };
    } finally {
      db.close();
    }
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
    if (code === "ENOENT")
      return null;
    return storageFailure(error);
  }
}
function insightLedgerPath(root, ledgerHash) {
  if (!HASH2.test(ledgerHash))
    throw new Error("ledger hash must be a SHA-256");
  return join2(resolve(root), "memory", "insight-ledgers", `${ledgerHash}.json`);
}
async function loadInsightLedger(root, ledgerHash) {
  try {
    const value = JSON.parse(await readFile2(insightLedgerPath(root, ledgerHash), "utf8"));
    const validated = validateInsightLedger(value);
    if (!validated.ok)
      return invalid("invalid-ledger", "insight ledger failed validation", validated.errors.map((error) => `${error.path}: ${error.message}`));
    if (validated.value.ledgerHash !== ledgerHash || insightLedgerHash(validated.value) !== ledgerHash)
      return invalid("invalid-ledger", "insight ledger content hash does not match its path");
    return { ok: true, value: validated.value };
  } catch (error) {
    return storageFailure(error);
  }
}
async function readInsightCurrentPointer(root) {
  try {
    const input = JSON.parse(await readFile2(join2(resolve(root), "memory", "insight-current.json"), "utf8"));
    const validated = validateInsightCurrentPointer(input);
    if (!validated.ok)
      return invalid("invalid-ledger", "current insight pointer failed validation", validated.errors.map((error) => `${error.path}: ${error.message}`));
    return { ok: true, value: validated.value };
  } catch (error) {
    return storageFailure(error);
  }
}

// src/experience-memory-store.ts
var HASH_PATTERN = /^[a-f0-9]{64}$/u;
function jsonBytes(value) {
  return `${JSON.stringify(value, null, 2)}
`;
}
function sha256(content) {
  return createHash4("sha256").update(content).digest("hex");
}
function storageFailure2(error) {
  const message = error instanceof Error ? error.message : String(error);
  return {
    ok: false,
    error: { code: "storage-error", message: `Could not access published memory: ${message}` }
  };
}
function validPointer(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return false;
  const pointer = value;
  return Object.keys(pointer).toSorted().join(",") === ["schemaVersion", "projectIdentity", "snapshotHash", "ledgerHash"].toSorted().join(",") && pointer.schemaVersion === 1 && typeof pointer.projectIdentity === "string" && pointer.projectIdentity.length > 0 && typeof pointer.snapshotHash === "string" && HASH_PATTERN.test(pointer.snapshotHash) && typeof pointer.ledgerHash === "string" && HASH_PATTERN.test(pointer.ledgerHash);
}
async function readPublishedMemory(root, requestedSnapshotHash) {
  try {
    try {
      await readFile3(join3(resolve2(root), "memory", "insight-current.json"), "utf8");
      const insight = await readPublishedInsightMemory(root);
      if (!insight.ok)
        return { ok: false, error: insight.error };
      if (requestedSnapshotHash !== undefined && requestedSnapshotHash !== insight.value.pointer.outputHash)
        return {
          ok: false,
          error: {
            code: "invalid-memory-id",
            message: "requested snapshot is not the current insight publication"
          }
        };
      return { ok: true, value: legacyPublishedFromInsight(insight.value) };
    } catch (error) {
      const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
      if (code !== "ENOENT")
        throw error;
    }
    const directory = join3(resolve2(root), "memory");
    const pointerInput = JSON.parse(await readFile3(join3(directory, "current.json"), "utf8"));
    if (!validPointer(pointerInput)) {
      return {
        ok: false,
        error: { code: "invalid-ledger", message: "Current memory pointer is invalid" }
      };
    }
    const snapshotHash = requestedSnapshotHash ?? pointerInput.snapshotHash;
    if (!HASH_PATTERN.test(snapshotHash)) {
      return {
        ok: false,
        error: { code: "invalid-memory-id", message: "Snapshot hash must be exact SHA-256" }
      };
    }
    const snapshotInput = JSON.parse(await readFile3(join3(directory, "snapshots", `${snapshotHash}.json`), "utf8"));
    if (typeof snapshotInput !== "object" || snapshotInput === null || Array.isArray(snapshotInput)) {
      return {
        ok: false,
        error: { code: "invalid-ledger", message: "Published memory snapshot is invalid" }
      };
    }
    const row = snapshotInput;
    if (row.schemaVersion !== 1 || !("snapshot" in row) || !("ledger" in row) || Object.keys(row).toSorted().join(",") !== ["schemaVersion", "snapshot", "ledger"].toSorted().join(",")) {
      return {
        ok: false,
        error: { code: "invalid-ledger", message: "Published memory snapshot is invalid" }
      };
    }
    const ledger = validateAcceptedMemoryLedger(row.ledger);
    if (!ledger.ok)
      return ledger;
    const compiled = compileMemorySnapshot(ledger.value);
    if (!compiled.ok || compiled.value.sha256 !== snapshotHash || JSON.stringify(compiled.value) !== JSON.stringify(row.snapshot)) {
      return {
        ok: false,
        error: {
          code: "invalid-ledger",
          message: "Published memory snapshot does not match its accepted ledger"
        }
      };
    }
    const published = {
      schemaVersion: 1,
      snapshot: compiled.value,
      ledger: ledger.value
    };
    if (pointerInput.ledgerHash !== sha256(jsonBytes(ledger.value))) {
      return {
        ok: false,
        error: { code: "invalid-ledger", message: "Current memory pointer ledger hash is stale" }
      };
    }
    return { ok: true, value: { pointer: pointerInput, published } };
  } catch (error) {
    return storageFailure2(error);
  }
}
function insightToLegacyEntry(revision) {
  const sourceHashes = revision.origin.sourceHashes.filter((value) => HASH_PATTERN.test(value));
  const migratedV1 = revision.derivation?.activity === "v1-accepted-memory-migration";
  const hashOffset = migratedV1 ? 1 : 0;
  const hashes = [
    sourceHashes[hashOffset] ?? sha256(revision.revisionId),
    sourceHashes[hashOffset + 1] ?? sha256(`${revision.revisionId}:proposal`),
    sourceHashes[hashOffset + 2] ?? sha256(`${revision.revisionId}:review`)
  ];
  const scopeAxis = revision.scope.repository !== null ? { kind: "repository", value: revision.scope.repository } : revision.scope.path !== null ? { kind: "path", value: revision.scope.path } : revision.scope.tool !== null ? { kind: "tool", value: revision.scope.tool } : revision.scope.model !== null ? { kind: "model", value: revision.scope.model } : revision.scope.harness !== null ? { kind: "harness", value: revision.scope.harness } : { kind: "global", value: null };
  return {
    id: revision.insightId,
    status: "accepted",
    judgment: "correct",
    valence: revision.valence,
    provenance: {
      packetHash: hashes[0],
      proposalSetHash: hashes[1],
      operatorReviewHash: hashes[2],
      candidateAlias: "C000",
      candidateId: sha256(revision.insightId).slice(0, 20)
    },
    trigger: revision.proposition.slice(0, 500),
    scope: scopeAxis,
    polarity: revision.kind === "preference" ? "prefer" : "check",
    action: revision.procedure ?? revision.proposition.slice(0, 500),
    situation: revision.proposition,
    outcome: revision.proposition,
    lesson: revision.proposition,
    confidence: revision.confidence.find((assessment) => assessment.role === "human")?.value ?? 0.5,
    freshness: "current",
    canonicalDocs: revision.authoritativeDocs.map((document) => document.uri).filter((uri) => !uri.startsWith("chatlog://")).concat(revision.authoritativeDocs.length === 0 ? [`insight://${revision.revisionId}`] : []),
    evidencePointers: [...revision.supportEvidence]
  };
}
function legacyPublishedFromInsight(published) {
  const entries = Object.values(published.projection.current).filter((revision) => revision.status === "active").toSorted((left, right) => left.insightId.localeCompare(right.insightId)).map(insightToLegacyEntry);
  const ledger = {
    schemaVersion: 1,
    ledgerId: published.ledger.ledgerId,
    projectIdentity: published.pointer.projectIdentity,
    entries
  };
  const snapshot = {
    schemaVersion: 1,
    sha256: published.compiled.outputHash,
    content: published.compiled.content,
    bytes: published.compiled.bytes,
    estimatedTokens: published.compiled.estimatedTokens,
    withinTarget: published.compiled.withinTarget,
    entryIds: published.compiled.entryIds
  };
  return {
    pointer: {
      schemaVersion: 1,
      projectIdentity: published.pointer.projectIdentity,
      snapshotHash: published.pointer.outputHash,
      ledgerHash: published.pointer.ledgerHash
    },
    published: { schemaVersion: 1, snapshot, ledger }
  };
}
async function readPublishedInsightMemory(root) {
  try {
    const pointer = await readInsightCurrentPointer(root);
    if (!pointer.ok)
      return { ok: false, error: { code: "invalid-ledger", message: pointer.error.message } };
    const ledger = await loadInsightLedger(root, pointer.value.ledgerHash);
    if (!ledger.ok)
      return {
        ok: false,
        error: {
          code: "invalid-ledger",
          message: ledger.error.message,
          issues: ledger.error.issues
        }
      };
    if (ledger.value.projectIdentity !== pointer.value.projectIdentity)
      return {
        ok: false,
        error: {
          code: "invalid-ledger",
          message: "insight ledger project identity does not match current pointer"
        }
      };
    const projection = projectInsightState(ledger.value);
    const contextResult = await readInsightPublicationContext(root);
    if (contextResult && !contextResult.ok)
      return { ok: false, error: { code: "invalid-ledger", message: contextResult.error.message } };
    const context = contextResult?.value;
    if (context && (pointer.value.inputProjectionHash !== context.inputProjectionHash || pointer.value.sourceAuthorityHash !== context.sourceAuthorityHash))
      return {
        ok: false,
        error: {
          code: "invalid-ledger",
          message: "insight current pointer is stale for the active source projection"
        }
      };
    const compiledResult = compileInsightProjection(projection, {
      projectIdentity: pointer.value.projectIdentity,
      now: new Date(pointer.value.compiledAt),
      supportedRiskClasses: new Set(["low", "medium", "high"]),
      ...context ? { activeEvidence: context.activeEvidence } : {}
    });
    if (!compiledResult.ok)
      return { ok: false, error: { code: "invalid-ledger", message: compiledResult.error } };
    const compiled = compiledResult.value;
    if (compiled.ledgerHash !== pointer.value.ledgerHash || compiled.compiledStateHash !== pointer.value.compiledStateHash || compiled.outputHash !== pointer.value.outputHash)
      return {
        ok: false,
        error: {
          code: "invalid-ledger",
          message: "insight current pointer is stale for its ledger or compiled state"
        }
      };
    const stored = JSON.parse(await readFile3(join3(resolve2(root), "memory", "insight-compiled", `${pointer.value.outputHash}.json`), "utf8"));
    if (JSON.stringify(stored) !== JSON.stringify(compiled))
      return {
        ok: false,
        error: {
          code: "invalid-ledger",
          message: "compiled insight artifact bytes do not match current pointer"
        }
      };
    return {
      ok: true,
      value: { pointer: pointer.value, ledger: ledger.value, projection, compiled }
    };
  } catch (error) {
    return storageFailure2(error);
  }
}

// src/project-identity.ts
import { readFileSync, realpathSync, statSync } from "fs";
import { basename, dirname as dirname3, isAbsolute, join as join4, normalize, resolve as resolve3 } from "path";
var CACHE_LIMIT = 512;
var commonDirectoryCache = new Map;
var cwdResolutionCache = new Map;
function normalizedFallback(cwd) {
  return cwd ? normalize(cwd) : "(unknown)";
}
function existingDirectory(path) {
  try {
    const canonical = realpathSync(path);
    return statSync(canonical).isDirectory() ? canonical : undefined;
  } catch {
    return;
  }
}
function isMissing(error) {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
function cachedProject(cacheKey, cwd) {
  const cached = cwdResolutionCache.get(cacheKey);
  if (!cached)
    return;
  if (existingDirectory(cwd) !== cached.canonicalCwd) {
    cwdResolutionCache.delete(cacheKey);
    return;
  }
  cwdResolutionCache.delete(cacheKey);
  cwdResolutionCache.set(cacheKey, cached);
  return cached.project;
}
function cacheProject(cacheKey, canonicalCwd, project) {
  cwdResolutionCache.set(cacheKey, { canonicalCwd, project });
  if (cwdResolutionCache.size > CACHE_LIMIT) {
    const oldest = cwdResolutionCache.keys().next().value;
    if (oldest)
      cwdResolutionCache.delete(oldest);
  }
  return project;
}
function metadataLine(path) {
  try {
    if (statSync(path).size > 4096)
      return;
    const value = readFileSync(path, "utf8").trim();
    if (!value || value.includes(`
`) || value.includes("\x00"))
      return;
    return value;
  } catch {
    return;
  }
}
function gitDirectory(marker, checkoutRoot) {
  try {
    const markerStat = statSync(marker);
    if (markerStat.isDirectory()) {
      const gitDir2 = existingDirectory(marker);
      return gitDir2 ? { kind: "valid", gitDir: gitDir2 } : { kind: "invalid" };
    }
    if (!markerStat.isFile())
      return { kind: "invalid" };
  } catch (error) {
    return isMissing(error) ? { kind: "absent" } : { kind: "invalid" };
  }
  const line = metadataLine(marker);
  const match = line?.match(/^gitdir:\s*(.+)$/);
  if (!match)
    return { kind: "invalid" };
  const path = match[1];
  const gitDir = existingDirectory(isAbsolute(path) ? path : resolve3(checkoutRoot, path));
  return gitDir ? { kind: "valid", gitDir } : { kind: "invalid" };
}
function commonDirectory(gitDir) {
  const marker = join4(gitDir, "commondir");
  let markerStat;
  try {
    markerStat = statSync(marker);
  } catch (error) {
    return isMissing(error) ? gitDir : undefined;
  }
  if (!markerStat.isFile())
    return;
  const path = metadataLine(marker);
  if (!path)
    return;
  return existingDirectory(isAbsolute(path) ? path : resolve3(gitDir, path));
}
function cacheCommonDirectory(commonGitDir) {
  const cached = commonDirectoryCache.get(commonGitDir);
  if (cached) {
    commonDirectoryCache.delete(commonGitDir);
    commonDirectoryCache.set(commonGitDir, cached);
    return cached;
  }
  const mainRoot = basename(commonGitDir) === ".git" ? existingDirectory(dirname3(commonGitDir)) : existingDirectory(commonGitDir);
  if (!mainRoot)
    return;
  commonDirectoryCache.set(commonGitDir, mainRoot);
  if (commonDirectoryCache.size > CACHE_LIMIT) {
    const oldest = commonDirectoryCache.keys().next().value;
    if (oldest)
      commonDirectoryCache.delete(oldest);
  }
  return mainRoot;
}
function projectOf(cwd) {
  const fallback = normalizedFallback(cwd);
  if (!cwd)
    return fallback;
  const cached = cachedProject(fallback, cwd);
  if (cached)
    return cached;
  const start = existingDirectory(cwd);
  if (!start)
    return fallback;
  for (let directory = start;; directory = dirname3(directory)) {
    const marker = gitDirectory(join4(directory, ".git"), directory);
    if (marker.kind === "invalid")
      return cacheProject(fallback, start, fallback);
    if (marker.kind === "valid") {
      const commonGitDir = commonDirectory(marker.gitDir);
      if (!commonGitDir)
        return cacheProject(fallback, start, fallback);
      const project = cacheCommonDirectory(commonGitDir) ?? fallback;
      return cacheProject(fallback, start, project);
    }
    const parent = dirname3(directory);
    if (parent === directory)
      return cacheProject(fallback, start, fallback);
  }
}

// src/experience-memory-hook.ts
async function readInput() {
  try {
    const text2 = await Bun.stdin.text();
    const input = JSON.parse(text2);
    return typeof input === "object" && input !== null && !Array.isArray(input) ? input : undefined;
  } catch {
    return;
  }
}
async function main() {
  const input = await readInput();
  if (input?.hook_event_name !== "SessionStart" || input.source !== "startup" || typeof input.session_id !== "string" || typeof input.cwd !== "string") {
    return;
  }
  const projectIdentity = projectOf(input.cwd);
  const root = resolve4(process.env.CHATLOG_DATA_ROOT ?? projectIdentity);
  const published = await readPublishedMemory(root);
  if (!published.ok || published.value.pointer.projectIdentity !== projectIdentity) {
    return;
  }
  const pluginData = process.env.PLUGIN_DATA ?? process.env.CLAUDE_PLUGIN_DATA ?? join5(root, "memory");
  const startup = await prepareStartupMemory({
    source: input.source,
    sessionId: input.session_id,
    snapshot: published.value.published.snapshot,
    pinDirectory: join5(pluginData, "session-pins")
  });
  if (!startup.ok || !startup.value.emitted)
    return;
  const context = [
    "Chatlog experience-memory routing index.",
    `Snapshot: ${startup.value.snapshotHash}`,
    "When a USE WHEN trigger applies, call chatlog_recall_memory with this snapshotHash and the exact memoryId. Do not recall unrelated cards.",
    "",
    startup.value.content.trimEnd()
  ].join(`
`);
  process.stdout.write(`${JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: context
    }
  })}
`);
}
await main();
