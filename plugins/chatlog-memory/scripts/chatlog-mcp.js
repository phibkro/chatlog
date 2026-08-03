#!/usr/bin/env bun
// @bun

// src/experience-memory-mcp.ts
import { resolve as resolve3 } from "path";

// src/mcp/data.ts
import { Database } from "bun:sqlite";
import { existsSync } from "fs";
import { readFile as readFile3 } from "fs/promises";
import { join as join3, resolve as resolve2 } from "path";

// src/derive.ts
import { chmod, mkdir, readFile, rename, stat, writeFile } from "fs/promises";
import { basename, dirname, join } from "path";

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

// src/derive.ts
var STOP_WORDS = new Set(`about after again agent also another assistant because before being between both broken bug build call called calling can cannot change chat claude code codex color command content context continued conversation could current data does done each error fail failed failing failure file files first fix from function get have idlereason idle_notification intent into issue just last like local make message more most need only operator other output over path previous primary problem project read real regression request result same sent session should some source stuck summary system task team-lead teammate-message teammate_id than that their them then there these they this through timeout timestamp tool tools turn turns type unknown update user using want were what when where which while will with would wrong your`.split(" "));
async function loadDerived(root, conversationHash) {
  const path = join(root, "derived", "objects", conversationHash.slice(0, 2), `${conversationHash}.json`);
  return JSON.parse(await readFile(path, "utf8"));
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
var EVIDENCE_URI_PATTERN = "^chatlog://conversation/([a-fA-F0-9]{64})/turn/([0-9]+)$";
var evidenceUriRegex = new RegExp(EVIDENCE_URI_PATTERN);
function parseEvidenceUri(value) {
  if (typeof value !== "string")
    throw new Error("uri must be a chatlog evidence URI");
  const match = evidenceUriRegex.exec(value);
  if (!match)
    throw new Error("invalid chatlog evidence URI");
  const contentHash = match[1].toLowerCase();
  const turnIndex = Number(match[2]);
  return {
    uri: `chatlog://conversation/${contentHash}/turn/${turnIndex}`,
    contentHash,
    turnIndex
  };
}

// src/experience-memory-store.ts
import { chmod as chmod2, mkdir as mkdir2, readFile as readFile2, rename as rename2, writeFile as writeFile2 } from "fs/promises";
import { dirname as dirname2, join as join2, resolve } from "path";

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

// src/experience-memory-store.ts
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
async function recallPublishedMemory(root, snapshotHash, memoryId) {
  const published = await readPublishedMemory(root, snapshotHash);
  if (!published.ok)
    return published;
  return recallMemoryCard(published.value.published.ledger, memoryId);
}

// src/mcp/data.ts
var EVIDENCE_CHARACTER_LIMIT = 12000;
var EVIDENCE_UNAVAILABLE = "evidence not found or not permitted";
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
  const text = typeof value === "string" ? value : "";
  return text.length <= maximum ? text : `${text.slice(0, maximum)}\u2026`;
}

class McpData {
  root;
  configuredDomains;
  db;
  currentColumns;
  constructor(root, configuredDomains = parseDomainPolicy()) {
    this.root = resolve2(root);
    this.configuredDomains = normalizeConversationDomains(configuredDomains);
    const databasePath = join3(this.root, "analysis", "chatlog.sqlite");
    if (!existsSync(databasePath))
      throw new Error(`No Chatlog analysis database at ${databasePath}`);
    this.db = new Database(databasePath, { readonly: true, create: false });
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
  search(args) {
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
    return {
      query,
      policy,
      hits: hits.map((hit) => ({
        ...hit,
        evidenceUri: `chatlog://conversation/${hit.contentHash}/turn/${hit.turnIndex}`
      }))
    };
  }
  async evidence(args) {
    const pointer = parseEvidenceUri(args.uri);
    const policy = this.policy(args.domains);
    const indexed = this.db.query(`SELECT ${this.domainSql()} domain
      FROM current_conversations c WHERE c.content_hash = ?`).get(pointer.contentHash);
    if (!indexed)
      throw new Error(EVIDENCE_UNAVAILABLE);
    let conversation;
    try {
      conversation = JSON.parse(await readFile3(join3(this.root, "corpus", "objects", pointer.contentHash.slice(0, 2), `${pointer.contentHash}.json`), "utf8"));
    } catch {
      throw new Error(EVIDENCE_UNAVAILABLE);
    }
    let objectDomain;
    try {
      objectDomain = normalizeConversationDomain(conversation.domain || DEFAULT_CONVERSATION_DOMAIN);
    } catch {
      throw new Error(EVIDENCE_UNAVAILABLE);
    }
    if (typeof conversation.contentHash !== "string" || conversation.contentHash.toLowerCase() !== pointer.contentHash || indexed.domain !== objectDomain || !policy.effectiveDomains.includes(objectDomain))
      throw new Error(EVIDENCE_UNAVAILABLE);
    const turn = conversation.turns[pointer.turnIndex];
    if (!turn || !["user", "assistant"].includes(turn.role))
      throw new Error(EVIDENCE_UNAVAILABLE);
    const fullLength = turn.content.length;
    const content = turn.content.slice(0, EVIDENCE_CHARACTER_LIMIT);
    return {
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
  }
  recentWork(args) {
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
    return { project, policy, sessions };
  }
  async projectBrief(args) {
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
    return {
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
function response(id, result) {
  return { jsonrpc: "2.0", id, ...{ result } };
}
function errorResponse(id, code, message) {
  return { jsonrpc: "2.0", id, ...{ error: { code, message: redact(message) } } };
}
function toolResult(value, isError = false) {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return {
    content: [{ type: "text", text }],
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
  const id = hasId ? message.id ?? null : null;
  if (message.jsonrpc !== "2.0" || typeof message.method !== "string")
    return hasId ? errorResponse(id, -32600, "invalid JSON-RPC request") : null;
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
    return response(id, {
      protocolVersion: state.protocolVersion,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      instructions: "Search first, then resolve only the evidence turns needed. Results are local, bounded, redacted, and domain-filtered."
    });
  }
  if (message.method === "ping")
    return response(id, {});
  if (!state.initialized)
    return errorResponse(id, -32002, "server not initialized");
  if (message.method === "tools/list")
    return response(id, { tools: MCP_TOOLS });
  if (message.method === "tools/call") {
    const name = message.params?.name;
    if (typeof name !== "string" || !MCP_TOOLS.some((tool) => tool.name === name))
      return errorResponse(id, -32602, "unknown or missing tool name");
    try {
      const value = await callTool(data, name, argumentsRecord(message.params?.arguments));
      return response(id, toolResult(value));
    } catch (error) {
      return response(id, toolResult(redact(String(error?.message ?? error)), true));
    }
  }
  return errorResponse(id, -32601, `method not found: ${message.method}`);
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
var root = resolve3(process.env.CHATLOG_DATA_ROOT ?? process.cwd());
var data = new McpData(root);
try {
  await runMcpStdio(data);
} finally {
  data.close();
}
