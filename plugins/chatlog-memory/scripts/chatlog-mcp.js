#!/usr/bin/env bun
// @bun

// src/experience-memory-mcp.ts
import { resolve as resolve4 } from "path";

// src/mcp/data.ts
import { Database as Database2 } from "bun:sqlite";
import { existsSync } from "fs";
import { readFile as readFile5 } from "fs/promises";
import { join as join6, resolve as resolve3 } from "path";

// src/event-store.ts
import { chmod, mkdir, readFile, rename, stat, writeFile } from "fs/promises";
import { dirname, join } from "path";

// src/redact.ts
var RULES = [
  [
    /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/gi,
    "[REDACTED_PRIVATE_KEY]"
  ],
  [/\bsk-(?:ant-)?[A-Za-z0-9_-]{16,}\b/g, "[REDACTED_API_KEY]"],
  [/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g, "[REDACTED_GITHUB_TOKEN]"],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, "[REDACTED_GITHUB_TOKEN]"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "[REDACTED_AWS_ACCESS_KEY]"],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, "[REDACTED_SLACK_TOKEN]"],
  [/(\b(?:authorization)\s*[:=]\s*bearer\s+)[A-Za-z0-9._~+/-]{12,}/gi, "$1[REDACTED_TOKEN]"],
  [
    /(\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|secret[_-]?key|password)\b\s*["']?\s*[:=]\s*["']?)[^\s,"'}]{8,}/gi,
    "$1[REDACTED_SECRET]"
  ]
];
function redact(text) {
  return RULES.reduce((value, [pattern, replacement]) => value.replace(pattern, replacement), text);
}

// src/events.ts
var EVENT_SCHEMA_VERSION = 1;
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
function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

class EventValidationError extends Error {
  name = "EventValidationError";
}
function invalidEvent(message) {
  throw new EventValidationError(message);
}
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
function sha256(value) {
  return new Bun.CryptoHasher("sha256").update(value).digest("hex");
}
function redactValue(value) {
  if (typeof value === "string")
    return redact(value);
  if (Array.isArray(value))
    return value.map(redactValue);
  if (value && typeof value === "object")
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [
      key,
      redactValue(child)
    ]));
  return value;
}
function eventIdentity(input) {
  return sha256(stableStringify(input));
}
function assertString(value, label) {
  if (typeof value !== "string" || !value)
    invalidEvent(`${label} must be a non-empty string`);
}
function assertHash(value, label) {
  assertString(value, label);
  if (!/^[a-f0-9]{64}$/i.test(value))
    invalidEvent(`${label} must be a SHA-256 hash`);
}
function assertTimestamp(value, label) {
  if (value === undefined)
    return;
  assertString(value, label);
  if (!Number.isFinite(Date.parse(value)))
    invalidEvent(`${label} must be an ISO timestamp`);
}
function validatePosition(value, label) {
  if (!isRecord(value))
    invalidEvent(`${label} must be an object`);
  for (const key of ["line", "record"]) {
    if (value[key] !== undefined && (!Number.isSafeInteger(value[key]) || Number(value[key]) < 0))
      invalidEvent(`${label}.${key} must be a non-negative integer`);
  }
  if (value.line === undefined && value.record === undefined)
    invalidEvent(`${label} must include line or record`);
}
function validateCapture(value, label) {
  const captureValue = typeof value === "string" ? { disposition: value } : value;
  if (!isRecord(captureValue) || !["normalized", "opaque", "redacted", "omitted"].includes(String(captureValue.disposition)))
    invalidEvent(`${label} has an unknown disposition`);
  const disposition = String(captureValue.disposition);
  if (disposition === "omitted" && typeof captureValue.reason !== "string")
    invalidEvent(`${label} omitted disposition requires a reason`);
  if (captureValue.reason !== undefined)
    assertString(captureValue.reason, `${label}.reason`);
  return { disposition, ...captureValue.reason ? { reason: captureValue.reason } : {} };
}
function validateSourceEvent(value, label) {
  if (!isRecord(value))
    invalidEvent(`${label} must be an object`);
  for (const key of [
    "provider",
    "harness",
    "sourceKind",
    "sourcePath",
    "adapterRecipe",
    "capturePolicyVersion"
  ])
    assertString(value[key], `${label}.${key}`);
  validatePosition(value.recordPosition, `${label}.recordPosition`);
  assertHash(value.redactedNativeRecordHash, `${label}.redactedNativeRecordHash`);
  for (const key of ["nativeSessionId", "nativeItemId"])
    if (value[key] !== undefined)
      assertString(value[key], `${label}.${key}`);
  return value;
}
function validateSourceBatch(value, label) {
  if (!isRecord(value))
    invalidEvent(`${label} must be an object`);
  for (const key of [
    "provider",
    "harness",
    "sourceKind",
    "sourcePath",
    "adapterRecipe",
    "capturePolicyVersion"
  ])
    assertString(value[key], `${label}.${key}`);
  assertHash(value.redactedSourceHash, `${label}.redactedSourceHash`);
  if (value.nativeSessionId !== undefined)
    assertString(value.nativeSessionId, `${label}.nativeSessionId`);
  return value;
}
function validateOrigin(value, label) {
  if (!isRecord(value))
    invalidEvent(`${label} must be an object`);
  if (value.kind === "observed")
    return { kind: "observed", source: validateSourceEvent(value.source, `${label}.source`) };
  if (value.kind === "chatlog") {
    assertString(value.processor, `${label}.processor`);
    assertString(value.recipe, `${label}.recipe`);
    if (!Array.isArray(value.inputEventIds) || !value.inputEventIds.every((item) => typeof item === "string" && item))
      invalidEvent(`${label}.inputEventIds must be non-empty strings`);
    if (!Array.isArray(value.inputHashes) || !value.inputHashes.every((item) => /^[a-f0-9]{64}$/i.test(String(item))))
      invalidEvent(`${label}.inputHashes must be SHA-256 hashes`);
    return value;
  }
  invalidEvent(`${label}.kind must be observed or chatlog`);
}
function validateBatchOrigin(value, label) {
  if (!isRecord(value))
    invalidEvent(`${label} must be an object`);
  if (value.kind === "observed")
    return { kind: "observed", source: validateSourceBatch(value.source, `${label}.source`) };
  if (value.kind === "chatlog") {
    assertString(value.processor, `${label}.processor`);
    assertString(value.recipe, `${label}.recipe`);
    if (!Array.isArray(value.inputHashes) || !value.inputHashes.every((item) => /^[a-f0-9]{64}$/i.test(String(item))))
      invalidEvent(`${label}.inputHashes must be SHA-256 hashes`);
    return value;
  }
  invalidEvent(`${label}.kind must be observed or chatlog`);
}
function validateRelations(value, label) {
  if (!isRecord(value))
    invalidEvent(`${label} must be an object`);
  for (const key of ["parent", "branch"])
    if (value[key] !== undefined)
      assertString(value[key], `${label}.${key}`);
  for (const key of ["causedBy", "correlatesWith", "derivedFrom"]) {
    if (value[key] !== undefined && (!Array.isArray(value[key]) || !value[key].every((item) => typeof item === "string" && item)))
      invalidEvent(`${label}.${key} must be string arrays`);
  }
  return value;
}
function validateLoss(value, label) {
  if (!isRecord(value))
    invalidEvent(`${label} must be an object`);
  if (typeof value.code !== "string" || !SEMANTIC_LOSS_CODE_SET.has(value.code))
    invalidEvent(`${label}.code is unknown`);
  assertString(value.reason, `${label}.reason`);
  for (const key of [
    "provider",
    "harness",
    "sourceItemKind",
    "sourceLocator",
    "adapterRecipe",
    "capturePolicyVersion"
  ])
    assertString(value[key], `${label}.${key}`);
  if (!Number.isSafeInteger(value.count) || Number(value.count) < 1)
    invalidEvent(`${label}.count must be a positive integer`);
  if (value.firstObservedAt !== undefined)
    assertTimestamp(value.firstObservedAt, `${label}.firstObservedAt`);
  if (value.lastObservedAt !== undefined)
    assertTimestamp(value.lastObservedAt, `${label}.lastObservedAt`);
  if (typeof value.firstObservedAt === "string" && typeof value.lastObservedAt === "string" && Date.parse(value.lastObservedAt) < Date.parse(value.firstObservedAt))
    invalidEvent(`${label}.lastObservedAt must not precede firstObservedAt`);
  if (value.affectedEventIds !== undefined) {
    if (!Array.isArray(value.affectedEventIds) || !value.affectedEventIds.every((item) => /^[a-f0-9]{64}$/i.test(String(item))))
      invalidEvent(`${label}.affectedEventIds must be SHA-256 hashes`);
  }
  if (typeof value.recoverable !== "boolean")
    invalidEvent(`${label}.recoverable must be boolean`);
  if (value.sourcePath !== undefined)
    assertString(value.sourcePath, `${label}.sourcePath`);
  if (value.recordPosition !== undefined)
    validatePosition(value.recordPosition, `${label}.recordPosition`);
  if (value.nativeItemId !== undefined)
    assertString(value.nativeItemId, `${label}.nativeItemId`);
  if (value.details !== undefined && !isRecord(value.details))
    invalidEvent(`${label}.details must be an object`);
  return value;
}
function validateAgentEvent(value, label = "event") {
  if (!isRecord(value))
    invalidEvent(`${label} must be an object`);
  if (value.schemaVersion !== EVENT_SCHEMA_VERSION)
    invalidEvent(`${label}.schemaVersion must be 1`);
  assertHash(value.eventId, `${label}.eventId`);
  if (typeof value.kind !== "string" || !EVENT_KINDS.has(value.kind))
    invalidEvent(`${label}.kind is unknown`);
  if (!Number.isSafeInteger(value.sequence) || Number(value.sequence) < 0)
    invalidEvent(`${label}.sequence must be a non-negative integer`);
  assertTimestamp(value.occurredAt, `${label}.occurredAt`);
  assertTimestamp(value.observedAt, `${label}.observedAt`);
  if (!isRecord(value.actor))
    invalidEvent(`${label}.actor must be an object`);
  assertString(value.actor.kind, `${label}.actor.kind`);
  if (value.actor.id !== undefined)
    assertString(value.actor.id, `${label}.actor.id`);
  if (value.actor.name !== undefined)
    assertString(value.actor.name, `${label}.actor.name`);
  if (!isRecord(value.scope))
    invalidEvent(`${label}.scope must be an object`);
  for (const key of ["sessionId", "conversationId", "branchId", "project", "cwd"])
    if (value.scope[key] !== undefined)
      assertString(value.scope[key], `${label}.scope.${key}`);
  validateOrigin(value.origin, `${label}.origin`);
  validateRelations(value.relations, `${label}.relations`);
  if (!isRecord(value.payload))
    invalidEvent(`${label}.payload must be an object`);
  const normalizedCapture = validateCapture(value.capture, `${label}.capture`);
  const normalized = { ...value, capture: normalizedCapture };
  const { eventId: _eventId, ...identity } = normalized;
  if (eventIdentity(identity) !== normalized.eventId)
    invalidEvent(`${label}.eventId does not match canonical event identity`);
  return normalized;
}
function validateEventBatch(value) {
  if (!isRecord(value))
    invalidEvent("event batch must be an object");
  if (value.schemaVersion !== EVENT_SCHEMA_VERSION)
    invalidEvent("event batch schemaVersion must be 1");
  const origin = validateBatchOrigin(value.origin, "batch.origin");
  if (!Array.isArray(value.events))
    invalidEvent("batch.events must be an array");
  const events = value.events.map((event, index) => validateAgentEvent(event, `batch.events[${index}]`));
  const ids = new Set;
  const nativeIds = new Set;
  let priorSequence = -1;
  for (const [index, event] of events.entries()) {
    if (ids.has(event.eventId))
      invalidEvent(`duplicate event id ${event.eventId}`);
    ids.add(event.eventId);
    if (event.sequence <= priorSequence)
      invalidEvent("events must be ordered by increasing sequence");
    priorSequence = event.sequence;
    if (event.sequence !== index)
      invalidEvent("event sequences must be contiguous from zero");
    if (event.origin.kind === "observed") {
      const nativeId = event.origin.source.nativeItemId;
      if (nativeId) {
        const key = `${event.origin.source.sourcePath}\x00${nativeId}`;
        if (nativeIds.has(key))
          invalidEvent(`duplicate native item id ${nativeId}`);
        nativeIds.add(key);
      }
    }
    const references = [];
    if (event.relations.parent)
      references.push(event.relations.parent);
    if (event.relations.branch)
      references.push(event.relations.branch);
    for (const key of ["causedBy", "correlatesWith", "derivedFrom"])
      references.push(...event.relations[key] ?? []);
    for (const reference of references)
      if (!ids.has(reference))
        invalidEvent(`dangling relation ${reference} in ${event.eventId}`);
  }
  if (!Array.isArray(value.semanticLoss))
    invalidEvent("batch.semanticLoss must be an array");
  const semanticLoss = value.semanticLoss.map((item, index) => validateLoss(item, `batch.semanticLoss[${index}]`));
  if (typeof value.partialTail !== "boolean")
    invalidEvent("batch.partialTail must be boolean");
  if (!Number.isSafeInteger(value.sourceItemCount) || Number(value.sourceItemCount) < 0)
    invalidEvent("batch.sourceItemCount must be a non-negative integer");
  return {
    schemaVersion: EVENT_SCHEMA_VERSION,
    origin,
    events,
    semanticLoss,
    partialTail: value.partialTail,
    sourceItemCount: Number(value.sourceItemCount)
  };
}
function freezeEventBatch(batch) {
  const freeze = (value) => {
    if (value && typeof value === "object") {
      for (const child of Object.values(value))
        freeze(child);
      Object.freeze(value);
    }
    return value;
  };
  return freeze(batch);
}
function canonicalEventBatch(value) {
  if (canonicalEventBatches.has(value))
    return value;
  const canonical = freezeEventBatch(validateEventBatch(redactValue(value)));
  canonicalEventBatches.add(canonical);
  return canonical;
}

// src/event-store.ts
var EVENT_OBJECT_DIRECTORY = "events";

class EventStoreError extends Error {
  name = "EventStoreError";
}
function invalidEventStore(message, cause) {
  throw new EventStoreError(message, cause === undefined ? undefined : { cause });
}
function serializeEventBatch(batch) {
  const canonical = canonicalEventBatch(batch);
  return `${stableStringify(canonical)}
`;
}
function eventBatchHash(batch) {
  return sha256(serializeEventBatch(batch));
}
function eventBatchRelativePath(hash) {
  if (!/^[a-f0-9]{64}$/i.test(hash))
    invalidEventStore("event batch hash must be SHA-256");
  const normalized = hash.toLowerCase();
  return `${EVENT_OBJECT_DIRECTORY}/${normalized.slice(0, 2)}/${normalized}.json`;
}
function eventBatchPath(root, hash) {
  return join(root, "corpus", eventBatchRelativePath(hash));
}
async function readEventBatch(root, hash) {
  const path = eventBatchPath(root, hash);
  const batch = canonicalEventBatch(JSON.parse(await readFile(path, "utf8")));
  if (eventBatchHash(batch) !== hash.toLowerCase())
    invalidEventStore(`${path}: event batch hash mismatch`);
  return batch;
}

// src/derive.ts
import { chmod as chmod2, mkdir as mkdir2, readFile as readFile2, rename as rename2, stat as stat2, writeFile as writeFile2 } from "fs/promises";
import { basename, dirname as dirname2, join as join3 } from "path";

// src/source-authority.ts
import { readFileSync, statSync } from "fs";
import { join as join2 } from "path";

// src/adapter-conformance.ts
class AdapterConformanceError extends Error {
  code = "adapter-conformance-invalid";
}
function failClosed(message, cause) {
  throw new AdapterConformanceError(message, cause === undefined ? undefined : { cause });
}
function validateSourceItemAccounting(accounting) {
  if (accounting.unaccountedItems !== 0)
    failClosed("source item accounting contains unaccounted items");
  const eventBackedPartition = accounting.dispositions.normalized + accounting.dispositions.opaque + accounting.dispositions.redacted + accounting.dispositions.omitted;
  if (accounting.eventBackedItems !== eventBackedPartition)
    failClosed("event-backed disposition accounting is false");
  const partition = eventBackedPartition + accounting.lossOnlyItems;
  if (accounting.sourceItems !== partition)
    failClosed("source item accounting partition is false");
  if (accounting.opaqueItems > accounting.eventBackedItems)
    failClosed("opaque items cannot exceed event-backed items");
}

// src/source-receipts.ts
var SOURCE_RECEIPT_SCHEMA = "chatlog/source-receipt-v1";
function invalidReceipt(message) {
  throw new Error(message);
}
function boundedText(value, label, maximum) {
  if (typeof value !== "string" || !value || value.length > maximum)
    invalidReceipt(`${label} is not bounded text`);
  return value;
}
function boundedHash(value, label) {
  const text = boundedText(value, label, 128);
  if (!/^[a-f0-9]{64}$/.test(text))
    invalidReceipt(`${label} must be a SHA-256 hash`);
  return text;
}
function boundedCount(value, label) {
  if (!Number.isSafeInteger(value) || Number(value) < 0)
    invalidReceipt(`${label} must be a non-negative integer`);
  return Number(value);
}
function validateItemCounts(value) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    invalidReceipt("source receipt itemCounts must be an object");
  const record = value;
  for (const key of [
    "sourceItems",
    "eventBackedItems",
    "lossOnlyItems",
    "unaccountedItems",
    "opaqueItems",
    "redactedItems",
    "policyOmissions"
  ])
    boundedCount(record[key], `itemCounts.${key}`);
  const dispositions = record.dispositions;
  if (!dispositions || typeof dispositions !== "object" || Array.isArray(dispositions))
    invalidReceipt("source receipt dispositions must be an object");
  const dispositionRecord = dispositions;
  for (const key of ["normalized", "opaque", "redacted", "omitted"])
    boundedCount(dispositionRecord[key], `itemCounts.dispositions.${key}`);
  const accounting = {
    sourceItems: Number(record.sourceItems),
    eventBackedItems: Number(record.eventBackedItems),
    lossOnlyItems: Number(record.lossOnlyItems),
    unaccountedItems: Number(record.unaccountedItems),
    opaqueItems: Number(record.opaqueItems),
    redactedItems: Number(record.redactedItems),
    policyOmissions: Number(record.policyOmissions),
    dispositions: {
      normalized: Number(dispositionRecord.normalized),
      opaque: Number(dispositionRecord.opaque),
      redacted: Number(dispositionRecord.redacted),
      omitted: Number(dispositionRecord.omitted)
    }
  };
  validateSourceItemAccounting(accounting);
  return accounting;
}
function validateLossCounts(value) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    invalidReceipt("source receipt lossCounts must be an object");
  const result = {};
  for (const [code, count] of Object.entries(value)) {
    if (!SEMANTIC_LOSS_CODES.includes(code))
      invalidReceipt(`source receipt lossCounts has unknown code ${code}`);
    result[code] = boundedCount(count, `lossCounts.${code}`);
  }
  return Object.fromEntries(Object.entries(result).sort(([a], [b]) => a.localeCompare(b)));
}
function validateSourceReceipt(value) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    invalidReceipt("source receipt must be an object");
  const receipt = value;
  if (receipt.schema !== SOURCE_RECEIPT_SCHEMA)
    invalidReceipt("unsupported source receipt schema");
  const receiptHash = boundedHash(receipt.receiptHash, "receiptHash");
  if (!receipt.source || typeof receipt.source !== "object" || Array.isArray(receipt.source))
    invalidReceipt("source receipt source must be an object");
  const source = receipt.source;
  boundedText(source.path, "source.path", 4096);
  boundedHash(source.hash, "source.hash");
  boundedText(source.provider, "source.provider", 128);
  boundedText(source.harness, "source.harness", 128);
  boundedText(source.sourceKind, "source.sourceKind", 128);
  if (source.nativeSessionId !== undefined)
    boundedText(source.nativeSessionId, "source.nativeSessionId", 256);
  const eventBatchHashValue = boundedHash(receipt.eventBatchHash, "eventBatchHash");
  const adapterRecipe = boundedText(receipt.adapterRecipe, "adapterRecipe", 256);
  const capturePolicyVersion = boundedText(receipt.capturePolicyVersion, "capturePolicyVersion", 256);
  const itemCounts = validateItemCounts(receipt.itemCounts);
  const lossCounts = validateLossCounts(receipt.lossCounts);
  if (typeof receipt.partialTail !== "boolean")
    invalidReceipt("source receipt partialTail must be boolean");
  const activeSourceAuthorityVersion = boundedText(receipt.activeSourceAuthorityVersion, "activeSourceAuthorityVersion", 256);
  const eventProjectionHash = boundedHash(receipt.eventProjectionHash, "eventProjectionHash");
  const conversationProjectionHash = boundedHash(receipt.conversationProjectionHash, "conversationProjectionHash");
  const body = {
    schema: SOURCE_RECEIPT_SCHEMA,
    source: {
      path: String(source.path),
      hash: String(source.hash),
      provider: String(source.provider),
      harness: String(source.harness),
      sourceKind: String(source.sourceKind),
      ...source.nativeSessionId !== undefined ? { nativeSessionId: String(source.nativeSessionId) } : {}
    },
    eventBatchHash: eventBatchHashValue,
    adapterRecipe,
    capturePolicyVersion,
    itemCounts,
    lossCounts,
    partialTail: receipt.partialTail,
    activeSourceAuthorityVersion,
    eventProjectionHash,
    conversationProjectionHash
  };
  if (sha256(stableStringify(body)) !== receiptHash)
    invalidReceipt("source receipt integrity check failed");
  return { ...body, receiptHash };
}

// src/source-authority.ts
class ActiveProjectionDriftError extends Error {
  constructor(message = "active source projection is unavailable or stale; run `chatlog source reconcile`", options) {
    super(message, options);
    this.name = "ActiveProjectionDriftError";
  }
}
class SourceAuthorityError extends Error {
  name = "SourceAuthorityError";
}
function invalidSourceAuthority(message) {
  throw new SourceAuthorityError(message);
}
function sha2562(value) {
  return new Bun.CryptoHasher("sha256").update(value).digest("hex");
}
function validateManifest(value, path) {
  const manifest = value;
  if (manifest?.version !== 1 || !manifest.sources || typeof manifest.sources !== "object")
    invalidSourceAuthority(`${path}: unsupported corpus manifest`);
  for (const [sourcePath, entry] of Object.entries(manifest.sources)) {
    if (!sourcePath || !entry || !/^[a-f0-9]{64}$/.test(entry.contentHash))
      invalidSourceAuthority(`${path}: invalid source mapping`);
    for (const key of ["eventBatchHash", "conversationProjectionHash", "receiptHash"])
      if (entry[key] !== undefined && !/^[a-f0-9]{64}$/.test(entry[key]))
        invalidSourceAuthority(`${path}: invalid source mapping`);
  }
  return manifest;
}
function validateReceiptMappings(root, sources) {
  for (const [sourcePath, entry] of Object.entries(sources)) {
    if (!entry.receiptHash)
      continue;
    const receiptPath = join2(root, "receipts", "sources", entry.receiptHash.slice(0, 2), `${entry.receiptHash}.json`);
    let receipt;
    try {
      receipt = validateSourceReceipt(JSON.parse(readFileSync(receiptPath, "utf8")));
    } catch {
      invalidSourceAuthority(`${sourcePath}: source receipt is missing or invalid`);
    }
    if (receipt.receiptHash !== entry.receiptHash || receipt.source.path !== sourcePath || receipt.eventBatchHash !== entry.eventBatchHash || receipt.conversationProjectionHash !== (entry.conversationProjectionHash ?? entry.contentHash))
      invalidSourceAuthority(`${sourcePath}: source receipt does not match manifest mapping`);
  }
}
function manifestSourcesHash(sources) {
  const canonical = Object.entries(sources).sort(([left], [right]) => left.localeCompare(right)).map(([sourcePath, entry]) => [
    sourcePath,
    entry.contentHash,
    entry.eventBatchHash ?? null,
    entry.conversationProjectionHash ?? entry.contentHash,
    entry.receiptHash ?? null
  ]);
  return sha2562(stableStringify(canonical));
}
function loadCorpusManifestSync(root) {
  const path = join2(root, "corpus", "manifest.json");
  return validateManifest(JSON.parse(readFileSync(path, "utf8")), path);
}
class ActiveProjectionGuard {
  root;
  manifestCache;
  verifiedCache;
  constructor(root) {
    this.root = root;
  }
  expectedManifestHash() {
    const path = join2(this.root, "corpus", "manifest.json");
    const info = statSync(path, { bigint: true });
    const signature = `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}`;
    if (this.manifestCache?.signature === signature)
      return this.manifestCache.hash;
    const manifest = loadCorpusManifestSync(this.root);
    validateReceiptMappings(this.root, manifest.sources);
    const hash = manifestSourcesHash(manifest.sources);
    this.manifestCache = { signature, hash };
    return hash;
  }
  assert(db) {
    try {
      const expectedHash = this.expectedManifestHash();
      const meta = db.query(`SELECT manifest_sources_hash manifestSourcesHash, reconciled_at reconciledAt
        FROM active_projection_meta WHERE singleton = 1`).get();
      if (!meta || meta.manifestSourcesHash !== expectedHash)
        throw new ActiveProjectionDriftError;
      const dataVersion = Number(db.query("PRAGMA data_version").get().data_version);
      if (this.verifiedCache?.manifestHash === expectedHash && this.verifiedCache.reconciledAt === meta.reconciledAt && this.verifiedCache.dataVersion === dataVersion)
        return {
          manifestSourcesHash: expectedHash,
          activeSources: this.verifiedCache.activeSources,
          reconciledAt: meta.reconciledAt
        };
      const rows = db.query("SELECT source_path sourcePath, content_hash contentHash, event_batch_hash eventBatchHash, projection_hash projectionHash, receipt_hash receiptHash FROM active_sources ORDER BY source_path").all();
      const actualHash = manifestSourcesHash(Object.fromEntries(rows.map((row) => [
        row.sourcePath,
        {
          contentHash: row.contentHash,
          ...row.eventBatchHash ? { eventBatchHash: row.eventBatchHash } : {},
          ...row.projectionHash ? { conversationProjectionHash: row.projectionHash } : {},
          ...row.receiptHash ? { receiptHash: row.receiptHash } : {}
        }
      ])));
      if (actualHash !== expectedHash)
        throw new ActiveProjectionDriftError;
      const missingIndexedSource = db.query(`SELECT 1 FROM active_sources a
        LEFT JOIN conversations c ON c.source_path = a.source_path AND c.content_hash = a.content_hash
        WHERE c.content_hash IS NULL LIMIT 1`).get();
      if (missingIndexedSource)
        throw new ActiveProjectionDriftError("active source projection references missing analysis rows; run `chatlog source reconcile`");
      const missingEventBatch = db.query(`SELECT 1 FROM active_sources a
        LEFT JOIN event_batches e ON e.batch_hash = a.event_batch_hash
        WHERE a.event_batch_hash IS NOT NULL AND e.batch_hash IS NULL LIMIT 1`).get();
      if (missingEventBatch)
        throw new ActiveProjectionDriftError("active source projection references missing event batches; run `chatlog source reconcile`");
      this.verifiedCache = {
        manifestHash: expectedHash,
        reconciledAt: meta.reconciledAt,
        dataVersion,
        activeSources: rows.length
      };
      return {
        manifestSourcesHash: expectedHash,
        activeSources: rows.length,
        reconciledAt: meta.reconciledAt
      };
    } catch (error) {
      if (error instanceof ActiveProjectionDriftError)
        throw error;
      const code = typeof error === "object" && error && "code" in error ? String(error.code) : "";
      const message = error instanceof Error ? error.message : "";
      if (code === "ENOENT" || message.includes("unsupported corpus manifest") || message.includes("invalid source mapping"))
        throw new ActiveProjectionDriftError("active source projection cannot be verified because the corpus manifest is unavailable", { cause: error });
      if (message.includes("source receipt"))
        throw new ActiveProjectionDriftError("active source projection cannot be verified because a source receipt is unavailable or stale", { cause: error });
      if (message.includes("no such table: active_projection_meta"))
        throw new ActiveProjectionDriftError("active source projection is not initialized; run `chatlog source reconcile`", { cause: error });
      if (code === "SQLITE_BUSY" || message.includes("database is locked"))
        throw new ActiveProjectionDriftError("active source projection verification is temporarily unavailable", { cause: error });
      throw new ActiveProjectionDriftError("active source projection verification failed", {
        cause: error
      });
    }
  }
}

// src/derive.ts
var STOP_WORDS = new Set(`about after again agent also another assistant because before being between both broken bug build call called calling can cannot change chat claude code codex color command content context continued conversation could current data does done each error fail failed failing failure file files first fix from function get have idlereason idle_notification intent into issue just last like local make message more most need only operator other output over path previous primary problem project read real regression request result same sent session should some source stuck summary system task team-lead teammate-message teammate_id than that their them then there these they this through timeout timestamp tool tools turn turns type unknown update user using want were what when where which while will with would wrong your`.split(" "));
async function loadDerived(root, conversationHash) {
  const path = join3(root, "derived", "objects", conversationHash.slice(0, 2), `${conversationHash}.json`);
  return JSON.parse(await readFile2(path, "utf8"));
}

// src/domain.ts
var DEFAULT_CONVERSATION_DOMAIN = "coding";
var DOMAIN_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
function normalizeConversationDomain(value) {
  if (typeof value !== "string")
    throw new Error("conversation domain must be a string");
  const domain = value.trim().toLowerCase();
  if (!DOMAIN_PATTERN.test(domain))
    throw new Error(`invalid conversation domain: ${value}`);
  return domain;
}
function normalizeConversationDomains(values, fallback = DEFAULT_CONVERSATION_DOMAIN) {
  const domains = [
    ...new Set(values.map((value) => value.trim()).filter(Boolean).map(normalizeConversationDomain))
  ].toSorted();
  if (!domains.length)
    return [normalizeConversationDomain(fallback)];
  return domains;
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

// src/experience-memory-store.ts
import { createHash as createHash4, randomUUID as randomUUID2 } from "crypto";
import { chmod as chmod4, mkdir as mkdir4, readFile as readFile4, rename as rename4, writeFile as writeFile4 } from "fs/promises";
import { dirname as dirname4, join as join5, resolve as resolve2 } from "path";

// src/experience-memory.ts
import { createHash } from "crypto";
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
function boundedText2(value, maximum) {
  return typeof value === "string" && value.trim().length > 0 && value.length <= maximum;
}
function singleLineText(value, maximum) {
  return boundedText2(value, maximum) && !value.includes(`
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
    if (!boundedText2(value[field], MAX_CARD_TEXT)) {
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
function recallMemoryCard(input, memoryId) {
  if (!validMemoryId(memoryId)) {
    return fail("invalid-memory-id", "Memory recall requires one exact bounded memory ID");
  }
  const validated = validateAcceptedMemoryLedger(input);
  if (!validated.ok)
    return validated;
  const entry = validated.value.entries.find((candidate) => candidate.id === memoryId);
  if (entry === undefined) {
    return fail("memory-not-found", `No current accepted memory has ID ${memoryId}`);
  }
  return ok({
    id: entry.id,
    situation: entry.situation,
    outcome: entry.outcome,
    lesson: entry.lesson,
    action: entry.action,
    scope: { ...entry.scope },
    confidence: entry.confidence,
    freshness: entry.freshness,
    status: entry.status,
    canonicalDocs: [...entry.canonicalDocs],
    evidencePointers: [...entry.evidencePointers]
  });
}

// src/insight-compiler.ts
import { createHash as createHash2 } from "crypto";

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
import { chmod as chmod3, mkdir as mkdir3, open, readFile as readFile3, rename as rename3, stat as stat3, unlink, writeFile as writeFile3 } from "fs/promises";
import { dirname as dirname3, join as join4, resolve } from "path";
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
  const path = join4(resolve(root), "analysis", "chatlog.sqlite");
  try {
    await stat3(path);
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
  return join4(resolve(root), "memory", "insight-ledgers", `${ledgerHash}.json`);
}
async function loadInsightLedger(root, ledgerHash) {
  try {
    const value = JSON.parse(await readFile3(insightLedgerPath(root, ledgerHash), "utf8"));
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
    const input = JSON.parse(await readFile3(join4(resolve(root), "memory", "insight-current.json"), "utf8"));
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
function sha2563(content) {
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
      await readFile4(join5(resolve2(root), "memory", "insight-current.json"), "utf8");
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
    const directory = join5(resolve2(root), "memory");
    const pointerInput = JSON.parse(await readFile4(join5(directory, "current.json"), "utf8"));
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
    const snapshotInput = JSON.parse(await readFile4(join5(directory, "snapshots", `${snapshotHash}.json`), "utf8"));
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
    if (pointerInput.ledgerHash !== sha2563(jsonBytes(ledger.value))) {
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
    sourceHashes[hashOffset] ?? sha2563(revision.revisionId),
    sourceHashes[hashOffset + 1] ?? sha2563(`${revision.revisionId}:proposal`),
    sourceHashes[hashOffset + 2] ?? sha2563(`${revision.revisionId}:review`)
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
      candidateId: sha2563(revision.insightId).slice(0, 20)
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
    const stored = JSON.parse(await readFile4(join5(resolve2(root), "memory", "insight-compiled", `${pointer.value.outputHash}.json`), "utf8"));
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
async function recallPublishedMemory(root, snapshotHash, memoryId) {
  const published = await readPublishedMemory(root, snapshotHash);
  if (!published.ok)
    return published;
  return recallMemoryCard(published.value.published.ledger, memoryId);
}

// src/mcp/data.ts
var EVIDENCE_CHARACTER_LIMIT = 12000;
var EVIDENCE_UNAVAILABLE = "evidence not found or not permitted";

class McpDataError extends Error {
  name = "McpDataError";
}
function evidenceUnavailable() {
  throw new McpDataError(EVIDENCE_UNAVAILABLE);
}
function parseDomainPolicy(value = process.env.CHATLOG_MCP_DOMAINS ?? "") {
  if (value.split(",").some((domain) => domain.trim() === "*"))
    throw new Error("wildcard domain access is not allowed");
  return normalizeConversationDomains(value.split(","));
}
function boundedLimit(value, fallback, maximum) {
  if (value == null)
    return fallback;
  if (typeof value !== "number" || !Number.isFinite(value))
    throw new Error("limit must be a finite number");
  return Math.max(1, Math.min(maximum, Math.trunc(value)));
}
function searchExpression(query) {
  if (typeof query !== "string")
    throw new Error("query must be a string");
  const trimmed = query.trim();
  const terms = trimmed.toLowerCase().match(/[\p{L}\p{N}_-]{2,}/gu) ?? [];
  if (!terms.length)
    throw new Error("search needs at least one concrete word");
  const expression = [...new Set(terms)].slice(0, 10).map((term) => `"${term.replaceAll('"', '""')}"`).join(" AND ");
  return { query: trimmed, expression };
}
function exactProject(value) {
  if (typeof value !== "string" || !value.trim())
    throw new Error("project must be an exact non-empty path");
  return value;
}
function clampSnippet(value, maximum = 600) {
  const text2 = typeof value === "string" ? value : "";
  return text2.length <= maximum ? text2 : `${text2.slice(0, maximum)}\u2026`;
}

class McpData {
  root;
  configuredDomains;
  db;
  currentColumns;
  projectionGuard;
  constructor(root, configuredDomains = parseDomainPolicy()) {
    this.root = resolve3(root);
    this.projectionGuard = new ActiveProjectionGuard(this.root);
    this.configuredDomains = normalizeConversationDomains(configuredDomains);
    const databasePath = join6(this.root, "analysis", "chatlog.sqlite");
    if (!existsSync(databasePath))
      throw new Error(`No Chatlog analysis database at ${databasePath}`);
    this.db = new Database2(databasePath, { readonly: true, create: false });
    this.currentColumns = new Set(this.db.query("PRAGMA table_info(current_conversations)").all().map((row) => row.name));
  }
  close() {
    this.db.close();
  }
  effectiveDomains(requested) {
    if (requested == null)
      return [...this.configuredDomains];
    if (!Array.isArray(requested) || requested.some((item) => typeof item !== "string"))
      throw new Error("domains must be an array of strings");
    if (requested.some((domain) => domain.trim() === "*"))
      throw new Error("wildcard domain access is not allowed");
    const domains = normalizeConversationDomains(requested);
    const denied = domains.filter((domain) => !this.configuredDomains.includes(domain));
    if (denied.length)
      throw new Error(`domain access denied: ${denied.join(", ")}`);
    return domains;
  }
  policy(requested) {
    return {
      configuredDomains: [...this.configuredDomains],
      effectiveDomains: this.effectiveDomains(requested)
    };
  }
  domainSql(alias = "c") {
    return this.currentColumns.has("domain") ? `LOWER(COALESCE(NULLIF(TRIM(${alias}.domain), ''), '${DEFAULT_CONVERSATION_DOMAIN}'))` : `'${DEFAULT_CONVERSATION_DOMAIN}'`;
  }
  titleSql(alias = "c") {
    return this.currentColumns.has("title") ? `${alias}.title` : "''";
  }
  assertProjection(expected) {
    const current = this.projectionGuard.assert(this.db);
    if (expected && (current.manifestSourcesHash !== expected.manifestSourcesHash || current.reconciledAt !== expected.reconciledAt || current.activeSources !== expected.activeSources)) {
      throw new ActiveProjectionDriftError("active source projection changed while serving the request; retry");
    }
    return current;
  }
  search(args) {
    const projection = this.assertProjection();
    const { query, expression } = searchExpression(args.query);
    const limit = boundedLimit(args.limit, 8, 20);
    const policy = this.policy(args.domains);
    const placeholders = policy.effectiveDomains.map(() => "?").join(",");
    const domain = this.domainSql();
    const title = this.titleSql();
    const hits = this.db.query(`SELECT c.content_hash contentHash, c.id sessionId, ${title} title,
      ${domain} domain, c.project, c.harness, c.model, c.ended_at endedAt,
      f.turn_index turnIndex, snippet(turns_fts, 0, '[', ']', ' \u2026 ', 28) snippet,
      -bm25(turns_fts) score
      FROM turns_fts f JOIN current_conversations c ON c.content_hash=f.content_hash
      JOIN turns t ON t.content_hash=f.content_hash AND t.turn_index=f.turn_index
      WHERE turns_fts MATCH ? AND t.role IN ('user', 'assistant')
      AND ${domain} IN (${placeholders})
      ORDER BY bm25(turns_fts) LIMIT ?`).all(expression, ...policy.effectiveDomains, limit);
    const result = {
      query,
      policy,
      hits: hits.map((hit) => ({
        ...hit,
        evidenceUri: `chatlog://conversation/${hit.contentHash}/turn/${hit.turnIndex}`
      }))
    };
    this.assertProjection(projection);
    return result;
  }
  async evidence(args) {
    const projection = this.assertProjection();
    const pointer = parseEvidenceUri(args.uri);
    const policy = this.policy(args.domains);
    if ("eventId" in pointer) {
      const indexed2 = this.db.query(`SELECT c.content_hash contentHash, c.id sessionId, c.title,
        ${this.domainSql()} domain, c.project, c.harness, c.model
        FROM current_conversations c JOIN active_sources a
        ON a.source_path = c.source_path AND a.content_hash = c.content_hash
        WHERE a.event_batch_hash = ?`).get(pointer.batchHash);
      if (!indexed2)
        evidenceUnavailable();
      let batch;
      try {
        batch = await readEventBatch(this.root, pointer.batchHash);
      } catch {
        evidenceUnavailable();
      }
      const event = batch.events.find((candidate) => candidate.eventId === pointer.eventId);
      if (!event || !policy.effectiveDomains.includes(normalizeConversationDomain(indexed2.domain)))
        evidenceUnavailable();
      if (event.kind === "model.reasoning.observed" || event.capture.disposition === "opaque")
        evidenceUnavailable();
      const content2 = JSON.stringify(event.payload);
      this.assertProjection(projection);
      return {
        policy,
        evidenceUri: pointer.uri,
        conversationHash: indexed2.contentHash,
        sessionId: indexed2.sessionId,
        title: indexed2.title,
        domain: indexed2.domain,
        project: indexed2.project,
        harness: indexed2.harness,
        eventId: event.eventId,
        eventKind: event.kind,
        event: {
          sequence: event.sequence,
          occurredAt: event.occurredAt,
          payload: content2.slice(0, EVIDENCE_CHARACTER_LIMIT),
          fullLength: content2.length
        }
      };
    }
    const indexed = this.db.query(`SELECT ${this.domainSql()} domain
      FROM current_conversations c WHERE c.content_hash = ?`).get(pointer.contentHash);
    if (!indexed)
      evidenceUnavailable();
    let conversation;
    try {
      conversation = JSON.parse(await readFile5(join6(this.root, "corpus", "objects", pointer.contentHash.slice(0, 2), `${pointer.contentHash}.json`), "utf8"));
    } catch {
      evidenceUnavailable();
    }
    let objectDomain;
    try {
      objectDomain = normalizeConversationDomain(conversation.domain || DEFAULT_CONVERSATION_DOMAIN);
    } catch {
      evidenceUnavailable();
    }
    if (typeof conversation.contentHash !== "string" || conversation.contentHash.toLowerCase() !== pointer.contentHash || indexed.domain !== objectDomain || !policy.effectiveDomains.includes(objectDomain))
      evidenceUnavailable();
    const turn = conversation.turns[pointer.turnIndex];
    if (!turn || !["user", "assistant"].includes(turn.role))
      evidenceUnavailable();
    const fullLength = turn.content.length;
    const content = turn.content.slice(0, EVIDENCE_CHARACTER_LIMIT);
    const result = {
      policy,
      evidenceUri: pointer.uri,
      conversationHash: pointer.contentHash,
      sessionId: conversation.id,
      title: conversation.title ?? "",
      domain: objectDomain,
      project: conversation.project,
      harness: conversation.harness,
      turnIndex: pointer.turnIndex,
      turn: {
        role: turn.role,
        content,
        ...turn.at ? { at: turn.at } : {}
      },
      truncated: fullLength > content.length,
      fullLength
    };
    this.assertProjection(projection);
    return result;
  }
  recentWork(args) {
    const projection = this.assertProjection();
    const project = exactProject(args.project);
    const limit = boundedLimit(args.limit, 8, 20);
    const policy = this.policy(args.domains);
    const placeholders = policy.effectiveDomains.map(() => "?").join(",");
    const domain = this.domainSql();
    const title = this.titleSql();
    const sessions = this.db.query(`SELECT c.content_hash contentHash, c.id sessionId,
      ${title} title, ${domain} domain, c.project, c.harness, c.model,
      c.started_at startedAt, c.ended_at endedAt, c.turn_count turns
      FROM current_conversations c
      WHERE c.project = ? AND ${domain} IN (${placeholders})
      ORDER BY c.ended_at DESC LIMIT ?`).all(project, ...policy.effectiveDomains, limit);
    const result = { project, policy, sessions };
    this.assertProjection(projection);
    return result;
  }
  async projectBrief(args) {
    const projection = this.assertProjection();
    const project = exactProject(args.project);
    const policy = this.policy(args.domains);
    const placeholders = policy.effectiveDomains.map(() => "?").join(",");
    const domain = this.domainSql();
    const params = [project, ...policy.effectiveDomains];
    const overview = this.db.query(`SELECT count(*) sessions, sum(c.turn_count) turns,
      min(c.started_at) firstSeen, max(c.ended_at) lastSeen
      FROM current_conversations c
      WHERE c.project = ? AND ${domain} IN (${placeholders})`).get(...params);
    const harnesses = this.db.query(`SELECT c.harness, count(*) sessions, sum(c.turn_count) turns
      FROM current_conversations c
      WHERE c.project = ? AND ${domain} IN (${placeholders})
      GROUP BY c.harness ORDER BY sessions DESC LIMIT 8`).all(...params);
    const models = this.db.query(`SELECT c.model, c.harness, count(*) sessions
      FROM current_conversations c
      WHERE c.project = ? AND ${domain} IN (${placeholders})
      GROUP BY c.model, c.harness ORDER BY sessions DESC LIMIT 8`).all(...params);
    const hashes = this.db.query(`SELECT c.content_hash contentHash
      FROM current_conversations c
      WHERE c.project = ? AND ${domain} IN (${placeholders})
      ORDER BY c.ended_at DESC LIMIT 8`).all(...params);
    const outcomes = { success: 0, failure: 0, mixed: 0, unknown: 0 };
    const problems = [];
    const decisions = [];
    let derivedMissing = 0;
    for (const { contentHash } of hashes) {
      let artifact;
      try {
        artifact = await loadDerived(this.root, contentHash);
      } catch {
        derivedMissing++;
        continue;
      }
      outcomes[artifact.outcome.status] = (outcomes[artifact.outcome.status] ?? 0) + 1;
      for (const item of artifact.problems.slice(-2)) {
        if (problems.length >= 8)
          break;
        problems.push({ snippet: clampSnippet(item.snippet), pointer: item.pointer });
      }
      for (const item of artifact.decisions.slice(-2)) {
        if (decisions.length >= 8)
          break;
        decisions.push({ snippet: clampSnippet(item.snippet), pointer: item.pointer });
      }
    }
    const result = {
      project,
      policy,
      overview: {
        sessions: Number(overview?.sessions ?? 0),
        turns: Number(overview?.turns ?? 0),
        firstSeen: overview?.firstSeen ?? null,
        lastSeen: overview?.lastSeen ?? null
      },
      harnesses,
      models,
      recentOutcomes: outcomes,
      derivedMissing,
      recurringProblemEvidence: problems,
      recentDecisionEvidence: decisions
    };
    this.assertProjection(projection);
    return result;
  }
  async recallMemory(args) {
    if (typeof args.snapshotHash !== "string" || typeof args.memoryId !== "string") {
      return {
        ok: false,
        error: {
          code: "invalid-memory-id",
          message: "memory recall requires snapshotHash and memoryId"
        }
      };
    }
    return recallPublishedMemory(this.root, args.snapshotHash, args.memoryId);
  }
}

// src/mcp/server.ts
import { createInterface } from "readline";
var SERVER_NAME = "chatlog";
var SERVER_VERSION = "0.1.0";
var LATEST_STABLE_PROTOCOL = "2025-11-25";
var SUPPORTED_PROTOCOLS = new Set([
  LATEST_STABLE_PROTOCOL,
  "2025-06-18",
  "2025-03-26",
  "2024-11-05"
]);
function createMcpState() {
  return {
    initializeReceived: false,
    initialized: false,
    protocolVersion: LATEST_STABLE_PROTOCOL
  };
}
var DOMAIN_PROPERTY = {
  type: "array",
  items: { type: "string" },
  description: "Optional subset of the server's configured conversation domains."
};
var MCP_TOOLS = [
  {
    name: "chatlog_search",
    description: "Search policy-visible Chatlog turns locally and return bounded snippets with stable evidence URIs.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Concrete lexical search terms." },
        limit: { type: "number", minimum: 1, maximum: 20, default: 8 },
        domains: DOMAIN_PROPERTY
      },
      required: ["query"],
      additionalProperties: false
    }
  },
  {
    name: "chatlog_get_evidence",
    description: "Resolve one policy-visible chatlog:// turn pointer, bounded to 12,000 text characters.",
    inputSchema: {
      type: "object",
      properties: {
        uri: { type: "string", pattern: EVIDENCE_URI_PATTERN },
        domains: DOMAIN_PROPERTY
      },
      required: ["uri"],
      additionalProperties: false
    }
  },
  {
    name: "chatlog_recent_work",
    description: "Return recent policy-visible session metadata for one exact project path.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string", description: "Exact canonical project path." },
        limit: { type: "number", minimum: 1, maximum: 20, default: 8 },
        domains: DOMAIN_PROPERTY
      },
      required: ["project"],
      additionalProperties: false
    }
  },
  {
    name: "chatlog_project_brief",
    description: "Return a bounded local activity and derived-evidence brief for one exact project path.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string", description: "Exact canonical project path." },
        domains: DOMAIN_PROPERTY
      },
      required: ["project"],
      additionalProperties: false
    }
  },
  {
    name: "chatlog_recall_memory",
    description: "Recall one accepted Tier 2 memory card by exact content-addressed snapshot hash and memory ID. Use the hash emitted at session startup.",
    inputSchema: {
      type: "object",
      properties: {
        snapshotHash: {
          type: "string",
          pattern: "^[a-f0-9]{64}$",
          description: "Exact snapshot hash emitted by the SessionStart routing index."
        },
        memoryId: {
          type: "string",
          pattern: "^[a-z0-9][a-z0-9._-]*[a-z0-9]$",
          description: "Exact memory ID from the startup routing index."
        }
      },
      required: ["snapshotHash", "memoryId"],
      additionalProperties: false
    }
  }
];
function response(id2, result) {
  return { jsonrpc: "2.0", id: id2, ...{ result } };
}
function errorResponse(id2, code, message) {
  return { jsonrpc: "2.0", id: id2, ...{ error: { code, message: redact(message) } } };
}
function toolResult(value, isError = false) {
  const text2 = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return {
    content: [{ type: "text", text: text2 }],
    ...typeof value === "object" && value !== null ? { structuredContent: value } : {},
    ...isError ? { isError: true } : {}
  };
}
function argumentsRecord(value) {
  if (value == null)
    return {};
  if (typeof value !== "object" || Array.isArray(value))
    throw new Error("tool arguments must be an object");
  return value;
}
async function callTool(data, name, args) {
  if (name === "chatlog_search")
    return data.search(args);
  if (name === "chatlog_get_evidence")
    return data.evidence(args);
  if (name === "chatlog_recent_work")
    return data.recentWork(args);
  if (name === "chatlog_project_brief")
    return data.projectBrief(args);
  if (name === "chatlog_recall_memory") {
    const recalled = await data.recallMemory(args);
    if (!recalled?.ok)
      throw new Error(recalled?.error?.message ?? "memory recall failed");
    return recalled.value;
  }
  throw new Error(`unknown tool: ${name}`);
}
async function handleMcpMessage(data, message, state = createMcpState()) {
  const hasId = Object.prototype.hasOwnProperty.call(message, "id");
  const id2 = hasId ? message.id ?? null : null;
  if (message.jsonrpc !== "2.0" || typeof message.method !== "string")
    return hasId ? errorResponse(id2, -32600, "invalid JSON-RPC request") : null;
  if (message.method === "notifications/initialized") {
    if (state.initializeReceived)
      state.initialized = true;
    return null;
  }
  if (!hasId)
    return null;
  if (message.method === "initialize") {
    state.initializeReceived = true;
    const requested = message.params?.protocolVersion;
    state.protocolVersion = typeof requested === "string" && SUPPORTED_PROTOCOLS.has(requested) ? requested : LATEST_STABLE_PROTOCOL;
    return response(id2, {
      protocolVersion: state.protocolVersion,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      instructions: "Search first, then resolve only the evidence turns needed. Results are local, bounded, redacted, and domain-filtered."
    });
  }
  if (message.method === "ping")
    return response(id2, {});
  if (!state.initialized)
    return errorResponse(id2, -32002, "server not initialized");
  if (message.method === "tools/list")
    return response(id2, { tools: MCP_TOOLS });
  if (message.method === "tools/call") {
    const name = message.params?.name;
    if (typeof name !== "string" || !MCP_TOOLS.some((tool) => tool.name === name))
      return errorResponse(id2, -32602, "unknown or missing tool name");
    try {
      const value = await callTool(data, name, argumentsRecord(message.params?.arguments));
      return response(id2, toolResult(value));
    } catch (error) {
      return response(id2, toolResult(redact(String(error?.message ?? error)), true));
    }
  }
  return errorResponse(id2, -32601, `method not found: ${message.method}`);
}
async function processMcpLine(data, line, state) {
  let parsed;
  try {
    parsed = JSON.parse(line);
  } catch {
    return errorResponse(null, -32700, "parse error");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    return errorResponse(null, -32600, "invalid JSON-RPC request");
  return handleMcpMessage(data, parsed, state);
}
async function runMcpStdio(data) {
  const state = createMcpState();
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim())
      continue;
    const reply = await processMcpLine(data, line, state);
    if (reply)
      process.stdout.write(`${JSON.stringify(reply)}
`);
  }
}
if (false) {}

// src/experience-memory-mcp.ts
var root = resolve4(process.env.CHATLOG_DATA_ROOT ?? process.cwd());
var data = new McpData(root);
try {
  await runMcpStdio(data);
} finally {
  data.close();
}
