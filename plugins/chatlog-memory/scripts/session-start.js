#!/usr/bin/env bun
// @bun

// src/experience-memory-hook.ts
import { join as join4, resolve as resolve3 } from "path";

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
import { chmod, mkdir as mkdir2, readFile as readFile2, rename, writeFile as writeFile2 } from "fs/promises";
import { dirname, join as join2, resolve } from "path";
var HASH_PATTERN = /^[a-f0-9]{64}$/u;
function storageFailure(error) {
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
    const directory = join2(resolve(root), "memory");
    const pointerInput = JSON.parse(await readFile2(join2(directory, "current.json"), "utf8"));
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
    const snapshotInput = JSON.parse(await readFile2(join2(directory, "snapshots", `${snapshotHash}.json`), "utf8"));
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
    return { ok: true, value: { pointer: pointerInput, published } };
  } catch (error) {
    return storageFailure(error);
  }
}

// src/project-identity.ts
import { readFileSync, realpathSync, statSync } from "fs";
import { basename, dirname as dirname2, isAbsolute, join as join3, normalize, resolve as resolve2 } from "path";
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
  const gitDir = existingDirectory(isAbsolute(path) ? path : resolve2(checkoutRoot, path));
  return gitDir ? { kind: "valid", gitDir } : { kind: "invalid" };
}
function commonDirectory(gitDir) {
  const marker = join3(gitDir, "commondir");
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
  return existingDirectory(isAbsolute(path) ? path : resolve2(gitDir, path));
}
function cacheCommonDirectory(commonGitDir) {
  const cached = commonDirectoryCache.get(commonGitDir);
  if (cached) {
    commonDirectoryCache.delete(commonGitDir);
    commonDirectoryCache.set(commonGitDir, cached);
    return cached;
  }
  const mainRoot = basename(commonGitDir) === ".git" ? existingDirectory(dirname2(commonGitDir)) : existingDirectory(commonGitDir);
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
  for (let directory = start;; directory = dirname2(directory)) {
    const marker = gitDirectory(join3(directory, ".git"), directory);
    if (marker.kind === "invalid")
      return cacheProject(fallback, start, fallback);
    if (marker.kind === "valid") {
      const commonGitDir = commonDirectory(marker.gitDir);
      if (!commonGitDir)
        return cacheProject(fallback, start, fallback);
      const project = cacheCommonDirectory(commonGitDir) ?? fallback;
      return cacheProject(fallback, start, project);
    }
    const parent = dirname2(directory);
    if (parent === directory)
      return cacheProject(fallback, start, fallback);
  }
}

// src/experience-memory-hook.ts
async function readInput() {
  try {
    const text = await Bun.stdin.text();
    const input = JSON.parse(text);
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
  const root = resolve3(process.env.CHATLOG_DATA_ROOT ?? projectIdentity);
  const published = await readPublishedMemory(root);
  if (!published.ok || published.value.pointer.projectIdentity !== projectIdentity) {
    return;
  }
  const pluginData = process.env.PLUGIN_DATA ?? process.env.CLAUDE_PLUGIN_DATA ?? join4(root, "memory");
  const startup = await prepareStartupMemory({
    source: input.source,
    sessionId: input.session_id,
    snapshot: published.value.published.snapshot,
    pinDirectory: join4(pluginData, "session-pins")
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
