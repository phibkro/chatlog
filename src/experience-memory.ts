import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const EXPERIENCE_MEMORY_SCHEMA_VERSION = 1 as const;
export const TIER_ONE_TARGET_TOKENS = 1_500;
export const TIER_ONE_MAX_TOKENS = 2_000;

const MAX_LEDGER_ID = 160;
const MAX_PROJECT_IDENTITY = 500;
const MAX_MEMORY_ID = 120;
const MAX_TRIGGER = 500;
const MAX_ACTION = 500;
const MAX_CARD_TEXT = 4_000;
const MAX_POINTER = 2_000;
const MAX_ENTRIES = 500;

export type MemoryScopeKind = "global" | "repository" | "path" | "tool" | "model" | "harness";
export type MemoryPolarity = "prefer" | "avoid" | "check";
export type MemoryValence = "positive" | "negative" | "neutral";
export type MemoryFeedbackSignal = "helpful" | "harmful" | "stale" | "mis-scoped";

export interface MemoryScope {
  kind: MemoryScopeKind;
  value: string | null;
}

export interface MemoryProvenance {
  packetHash: string;
  proposalSetHash: string;
  operatorReviewHash: string;
  candidateAlias: string;
  candidateId: string;
}

export interface AcceptedMemoryEntry {
  id: string;
  status: "accepted";
  judgment: "correct";
  valence: MemoryValence;
  provenance: MemoryProvenance;
  trigger: string;
  scope: MemoryScope;
  polarity: MemoryPolarity;
  action: string;
  situation: string;
  outcome: string;
  lesson: string;
  confidence: number;
  freshness: "current";
  canonicalDocs: Array<string>;
  evidencePointers: Array<`chatlog://${string}`>;
}

export interface AcceptedMemoryLedger {
  schemaVersion: 1;
  ledgerId: string;
  projectIdentity: string;
  entries: Array<AcceptedMemoryEntry>;
}

export interface TierTwoMemoryCard {
  id: string;
  situation: string;
  outcome: string;
  lesson: string;
  action: string;
  scope: MemoryScope;
  confidence: number;
  freshness: "current";
  status: "accepted";
  canonicalDocs: Array<string>;
  evidencePointers: Array<`chatlog://${string}`>;
}

export interface CompiledMemorySnapshot {
  schemaVersion: 1;
  sha256: string;
  content: string;
  bytes: number;
  estimatedTokens: number;
  withinTarget: boolean;
  entryIds: Array<string>;
}

export interface MemoryFeedbackRecord {
  schemaVersion: 1;
  memoryId: string;
  sessionId: string;
  signal: MemoryFeedbackSignal;
  note: string;
}

export type ExperienceMemoryErrorCode =
  | "invalid-ledger"
  | "snapshot-too-large"
  | "invalid-memory-id"
  | "memory-not-found"
  | "invalid-startup-request"
  | "invalid-session-pin"
  | "storage-error";

export interface ExperienceMemoryError {
  code: ExperienceMemoryErrorCode;
  message: string;
  issues?: Array<string>;
}

export type ExperienceMemoryResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: ExperienceMemoryError };

export type StartupMemoryOutput =
  | { emitted: false; reason: "not-startup" }
  | {
      emitted: true;
      snapshotHash: string;
      content: string;
      pinned: boolean;
    };

interface SessionPin {
  schemaVersion: 1;
  sessionId: string;
  snapshotHash: string;
  content: string;
}

function ok<T>(value: T): ExperienceMemoryResult<T> {
  return { ok: true, value };
}

function fail<T>(
  code: ExperienceMemoryErrorCode,
  message: string,
  issues?: Array<string>,
): ExperienceMemoryResult<T> {
  return { ok: false, error: { code, message, ...(issues === undefined ? {} : { issues }) } };
}

function objectRow(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: ReadonlyArray<string>): boolean {
  const actual = Object.keys(value).toSorted();
  const expected = keys.toSorted();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function boundedText(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= maximum;
}

function singleLineText(value: unknown, maximum: number): value is string {
  return boundedText(value, maximum) && !value.includes("\n") && !value.includes("\r");
}

function validMemoryId(value: unknown): value is string {
  return singleLineText(value, MAX_MEMORY_ID) && /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/u.test(value);
}

function validateScope(value: unknown, path: string, issues: Array<string>): value is MemoryScope {
  if (!objectRow(value) || !exactKeys(value, ["kind", "value"])) {
    issues.push(`${path} must contain exactly kind and value`);
    return false;
  }
  if (
    value.kind !== "global" &&
    value.kind !== "repository" &&
    value.kind !== "path" &&
    value.kind !== "tool" &&
    value.kind !== "model" &&
    value.kind !== "harness"
  ) {
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

function validatePointers(
  value: unknown,
  path: string,
  kind: "documentation" | "evidence",
  issues: Array<string>,
): boolean {
  if (!Array.isArray(value) || value.length === 0) {
    issues.push(`${path} must be a non-empty array`);
    return false;
  }
  let valid = true;
  const unique = new Set<string>();
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

function validateEntry(
  value: unknown,
  index: number,
  issues: Array<string>,
): value is AcceptedMemoryEntry {
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
    "evidencePointers",
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
  if (
    !objectRow(value.provenance) ||
    !exactKeys(value.provenance, [
      "packetHash",
      "proposalSetHash",
      "operatorReviewHash",
      "candidateAlias",
      "candidateId",
    ])
  ) {
    issues.push(`${path}.provenance has missing or unknown fields`);
    valid = false;
  } else {
    for (const field of ["packetHash", "proposalSetHash", "operatorReviewHash"] as const) {
      if (
        typeof value.provenance[field] !== "string" ||
        !/^[a-f0-9]{64}$/u.test(value.provenance[field])
      ) {
        issues.push(`${path}.provenance.${field} must be a lowercase SHA-256`);
        valid = false;
      }
    }
    if (!/^C[0-9]{3}$/u.test(String(value.provenance.candidateAlias))) {
      issues.push(`${path}.provenance.candidateAlias must be a blinded candidate alias`);
      valid = false;
    }
    if (
      typeof value.provenance.candidateId !== "string" ||
      !/^[a-f0-9]{20}$/u.test(value.provenance.candidateId)
    ) {
      issues.push(`${path}.provenance.candidateId must be a refinery candidate ID`);
      valid = false;
    }
  }
  if (!singleLineText(value.trigger, MAX_TRIGGER)) {
    issues.push(`${path}.trigger must be a bounded single-line string`);
    valid = false;
  }
  if (!validateScope(value.scope, `${path}.scope`, issues)) valid = false;
  if (value.polarity !== "prefer" && value.polarity !== "avoid" && value.polarity !== "check") {
    issues.push(`${path}.polarity must be prefer, avoid, or check`);
    valid = false;
  }
  if (!singleLineText(value.action, MAX_ACTION)) {
    issues.push(`${path}.action must be a bounded single-line string`);
    valid = false;
  }
  for (const field of ["situation", "outcome", "lesson"] as const) {
    if (!boundedText(value[field], MAX_CARD_TEXT)) {
      issues.push(`${path}.${field} must be bounded non-empty text`);
      valid = false;
    }
  }
  if (
    typeof value.confidence !== "number" ||
    !Number.isFinite(value.confidence) ||
    value.confidence < 0 ||
    value.confidence > 1
  ) {
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

export function validateAcceptedMemoryLedger(
  input: unknown,
): ExperienceMemoryResult<AcceptedMemoryLedger> {
  const issues: Array<string> = [];
  if (
    !objectRow(input) ||
    !exactKeys(input, ["schemaVersion", "ledgerId", "projectIdentity", "entries"])
  ) {
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
    const identifiers = new Set<string>();
    for (const [index, entry] of input.entries.entries()) {
      const valid = validateEntry(entry, index, issues);
      if (valid) {
        if (identifiers.has(entry.id)) issues.push(`entries[${index}].id is duplicated`);
        identifiers.add(entry.id);
      }
    }
  }
  if (issues.length > 0) {
    return fail("invalid-ledger", "Accepted memory ledger failed strict validation", issues);
  }
  return ok(input as unknown as AcceptedMemoryLedger);
}

function renderScope(scope: MemoryScope): string {
  return scope.kind === "global" ? "global" : `${scope.kind}:${scope.value}`;
}

function renderTierOne(entries: ReadonlyArray<AcceptedMemoryEntry>): string {
  const sections = entries.map((entry) =>
    [
      `## ${entry.id}`,
      `- USE WHEN: ${entry.trigger}`,
      `- Scope: ${renderScope(entry.scope)}`,
      `- Polarity: ${entry.polarity}`,
      `- Action: ${entry.action}`,
    ].join("\n"),
  );
  return `${sections.join("\n\n")}\n`;
}

export function estimateMemoryTokens(content: string): number {
  // Three UTF-8 bytes per token deliberately overestimates ordinary English and
  // remains deterministic without coupling the compiler to a model tokenizer.
  return Math.ceil(new TextEncoder().encode(content).byteLength / 3);
}

export function compileMemorySnapshot(
  input: unknown,
): ExperienceMemoryResult<CompiledMemorySnapshot> {
  const validated = validateAcceptedMemoryLedger(input);
  if (!validated.ok) return validated;
  const entries = validated.value.entries.toSorted((left, right) =>
    left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
  );
  const content = renderTierOne(entries);
  const bytes = new TextEncoder().encode(content).byteLength;
  const estimatedTokens = estimateMemoryTokens(content);
  if (estimatedTokens > TIER_ONE_MAX_TOKENS) {
    return fail(
      "snapshot-too-large",
      `Tier 1 snapshot is ${estimatedTokens} estimated tokens; maximum is ${TIER_ONE_MAX_TOKENS}`,
    );
  }
  return ok({
    schemaVersion: EXPERIENCE_MEMORY_SCHEMA_VERSION,
    sha256: createHash("sha256").update(content).digest("hex"),
    content,
    bytes,
    estimatedTokens,
    withinTarget: estimatedTokens <= TIER_ONE_TARGET_TOKENS,
    entryIds: entries.map((entry) => entry.id),
  });
}

export function recallMemoryCard(
  input: unknown,
  memoryId: string,
): ExperienceMemoryResult<TierTwoMemoryCard> {
  if (!validMemoryId(memoryId)) {
    return fail("invalid-memory-id", "Memory recall requires one exact bounded memory ID");
  }
  const validated = validateAcceptedMemoryLedger(input);
  if (!validated.ok) return validated;
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
    evidencePointers: [...entry.evidencePointers],
  });
}

function validSessionPin(input: unknown, sessionId: string): input is SessionPin {
  if (
    !objectRow(input) ||
    !exactKeys(input, ["schemaVersion", "sessionId", "snapshotHash", "content"]) ||
    input.schemaVersion !== EXPERIENCE_MEMORY_SCHEMA_VERSION ||
    input.sessionId !== sessionId ||
    typeof input.snapshotHash !== "string" ||
    !/^[a-f0-9]{64}$/u.test(input.snapshotHash) ||
    typeof input.content !== "string"
  ) {
    return false;
  }
  return (
    estimateMemoryTokens(input.content) <= TIER_ONE_MAX_TOKENS &&
    createHash("sha256").update(input.content).digest("hex") === input.snapshotHash
  );
}

function validCompiledSnapshot(value: CompiledMemorySnapshot): boolean {
  return (
    objectRow(value) &&
    exactKeys(value, [
      "schemaVersion",
      "sha256",
      "content",
      "bytes",
      "estimatedTokens",
      "withinTarget",
      "entryIds",
    ]) &&
    value.schemaVersion === EXPERIENCE_MEMORY_SCHEMA_VERSION &&
    typeof value.content === "string" &&
    new TextEncoder().encode(value.content).byteLength === value.bytes &&
    estimateMemoryTokens(value.content) === value.estimatedTokens &&
    value.estimatedTokens <= TIER_ONE_MAX_TOKENS &&
    value.withinTarget === value.estimatedTokens <= TIER_ONE_TARGET_TOKENS &&
    /^[a-f0-9]{64}$/u.test(value.sha256) &&
    createHash("sha256").update(value.content).digest("hex") === value.sha256 &&
    Array.isArray(value.entryIds) &&
    value.entryIds.every(validMemoryId) &&
    new Set(value.entryIds).size === value.entryIds.length &&
    value.entryIds.every((id, index) => index === 0 || value.entryIds[index - 1]! < id)
  );
}

function storageError(error: unknown): ExperienceMemoryResult<never> {
  const message = error instanceof Error ? error.message : String(error);
  return fail("storage-error", `Could not access the session memory pin: ${message}`);
}

async function readPin(
  path: string,
  sessionId: string,
): Promise<ExperienceMemoryResult<SessionPin>> {
  try {
    const input: unknown = JSON.parse(await readFile(path, "utf8"));
    return validSessionPin(input, sessionId)
      ? ok(input)
      : fail("invalid-session-pin", "Existing session memory pin is invalid");
  } catch (error) {
    return storageError(error);
  }
}

export async function prepareStartupMemory(input: {
  source: string;
  sessionId: string;
  snapshot: CompiledMemorySnapshot;
  pinDirectory: string;
}): Promise<ExperienceMemoryResult<StartupMemoryOutput>> {
  if (input.source !== "startup") return ok({ emitted: false, reason: "not-startup" });
  if (
    !singleLineText(input.sessionId, 500) ||
    !boundedText(input.pinDirectory, 4_000) ||
    !validCompiledSnapshot(input.snapshot)
  ) {
    return fail(
      "invalid-startup-request",
      "Startup source, session ID, directory, or snapshot is invalid",
    );
  }

  const pinName = `${createHash("sha256").update(input.sessionId).digest("hex")}.json`;
  const pinPath = join(input.pinDirectory, pinName);
  const pin: SessionPin = {
    schemaVersion: EXPERIENCE_MEMORY_SCHEMA_VERSION,
    sessionId: input.sessionId,
    snapshotHash: input.snapshot.sha256,
    content: input.snapshot.content,
  };

  try {
    await mkdir(input.pinDirectory, { recursive: true, mode: 0o700 });
    await writeFile(pinPath, `${JSON.stringify(pin)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    return ok({
      emitted: true,
      snapshotHash: pin.snapshotHash,
      content: pin.content,
      pinned: false,
    });
  } catch (error) {
    if (objectRow(error) && error.code === "EEXIST") {
      const existing = await readPin(pinPath, input.sessionId);
      if (!existing.ok) return existing;
      return ok({
        emitted: true,
        snapshotHash: existing.value.snapshotHash,
        content: existing.value.content,
        pinned: true,
      });
    }
    return storageError(error);
  }
}
