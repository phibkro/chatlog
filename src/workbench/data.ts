import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { opendir, readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { agentAskLexical } from "../agent-query";
import { loadDerived } from "../derive";
import { readEventBatch } from "../event-store";
import { parseEvidenceUri } from "../evidence-uri";
import { listImportReceipts } from "../import-receipts";
import { sourceCatalog } from "../source-catalog";
import { listSourceReceipts, readUnknownShapeNominations } from "../source-receipts";
import {
  ActiveProjectionDriftError,
  ActiveProjectionGuard,
  type ProjectionReceipt,
} from "../source-authority";
import type { Conversation } from "../types";
import {
  DerivedProjectionDriftError,
  assertDerivedProjection,
  loadCurrentDerivedArtifact,
  loadProjectionBoundArtifact,
  type CurrentDerivedArtifact,
  type DerivedProjectionReceipt,
} from "../derived-authority";
import { clusterTopics, normalizeTopic, topicCacheKey } from "../vault";

function boundedInteger(value: string | null, fallback: number, maximum = 100): number {
  if (value == null || value.trim() === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(1, Math.min(maximum, Math.trunc(parsed))) : fallback;
}

function nodeErrorCode(error: unknown): string | null {
  if (!error || typeof error !== "object" || !("code" in error)) return null;
  return typeof error.code === "string" ? error.code : null;
}

function searchExpression(query: string): string {
  const terms = query.toLowerCase().match(/[\p{L}\p{N}_-]{2,}/gu) ?? [];
  if (!terms.length) throw new Error("Search needs at least one concrete word");
  return [...new Set(terms)]
    .slice(0, 10)
    .map((term) => `"${term.replaceAll('"', '""')}"`)
    .join(" AND ");
}

const INSIGHT_EVIDENCE_LIMIT = 3;
const EVIDENCE_EVENT_CHARACTER_LIMIT = 12_000;

export class WorkbenchDataError extends Error {
  override readonly name = "WorkbenchDataError";
}

function evidenceNotFound(message = "Evidence not found"): never {
  throw new WorkbenchDataError(message);
}
const CANDIDATE_EVIDENCE_LIMIT = 2;
const KNOWLEDGE_CANDIDATE_PAGE_SIZE = 20;
const KNOWLEDGE_CANDIDATE_PAGE_SIZE_MAX = 50;
const KNOWLEDGE_CANDIDATE_PAGE_MAX = 10_000;
const KNOWLEDGE_CANDIDATE_QUERY_MAX = 160;
const KNOWLEDGE_CANDIDATE_DETAIL_EVIDENCE_MAX = 6;
const KNOWLEDGE_CANDIDATE_CHECKS_MAX = 12;
const THEMES_CACHE_SCAN_MAX = 10_000;
const THEMES_KEY_COMPUTATION_MAX = 1_000_000;
const THEMES_PROJECTION_BYTES_MAX = 16 * 1024 * 1024;
const THEMES_CACHE_ENTRY_BYTES_MAX = 64 * 1024;
const THEMES_CLUSTER_LIMIT = 20;
const THEMES_CLUSTER_LIMIT_MAX = 50;
const THEMES_CLUSTER_MEMBERS_MAX = 10;
const THEMES_UNIQUE_TOPICS_MAX = 1_000;
const THEMES_PAIRWISE_COMPARISONS_MAX = 500_000;
const THEMES_CLUSTER_RECIPE = "vault-topic-token-set-jaccard-current-conversation-v1";
const PRIOR_ATTEMPT_LIMIT = 10;
const PROJECT_DERIVED_SAMPLE_LIMIT = 40;
const PROJECT_SESSION_LIMIT = 100;
const SUMMARY_SNIPPET_LIMIT = 360;

interface InsightFreshness {
  fresh: true;
  status: "fresh";
  reason: "projection-match";
  currentProjectionHash: string;
  artifactProjectionHash: string;
  manifestProjectionHash: string;
}

const KNOWLEDGE_CANDIDATE_TYPES = [
  "skill",
  "gotcha-skill",
  "memory-or-adr",
  "claude-md",
  "wiki-page-later",
] as const;

const KNOWLEDGE_PRECISION_GATE = {
  status: "unavailable",
  classification: "possible-only",
  minimumOperatorJudgedPrecisionPercent: 70,
  recordedOperatorJudgedPrecisionPercent: null,
  message:
    "Project documentation gap classification is unavailable. Candidates are possible review leads only until a recorded operator-judged precision result of at least 70% exists.",
} as const;

const KNOWLEDGE_REVIEW_NOTICE =
  "Review candidate only — not accepted, not promoted, and not classified as a project documentation gap.";

function artifactFreshness(currentHash: string, current: CurrentDerivedArtifact): InsightFreshness {
  const artifactProjectionHash =
    typeof current.artifact?.inputProjectionHash === "string"
      ? current.artifact.inputProjectionHash
      : current.inputProjectionHash;
  return {
    fresh: true,
    status: "fresh",
    reason: "projection-match",
    currentProjectionHash: currentHash,
    artifactProjectionHash,
    manifestProjectionHash: current.inputProjectionHash,
  };
}

function assertStableDerivedProjection(
  expected: DerivedProjectionReceipt,
  current: DerivedProjectionReceipt,
): void {
  if (
    current.contentHash !== expected.contentHash ||
    current.structureProjectionHash !== expected.structureProjectionHash
  ) {
    throw new DerivedProjectionDriftError(
      "derived projection changed while serving the request; retry",
    );
  }
}

async function artifactMetadata(
  root: string,
  manifestName: string,
  current: CurrentDerivedArtifact,
): Promise<{ processedAt: string | null }> {
  try {
    const manifest = JSON.parse(await readFile(join(root, "derived", manifestName), "utf8"));
    if (
      manifest?.version !== 1 ||
      manifest.current?.contentHash !== current.contentHash ||
      String(manifest.current?.inputProjectionHash ?? "") !== current.inputProjectionHash
    ) {
      throw new DerivedProjectionDriftError(
        `${manifestName}: current artifact metadata changed while serving the request`,
      );
    }
    return {
      processedAt:
        typeof manifest.current.processedAt === "string" ? manifest.current.processedAt : null,
    };
  } catch (error) {
    if (error instanceof DerivedProjectionDriftError) throw error;
    throw new DerivedProjectionDriftError(
      `${manifestName}: current artifact metadata is unavailable`,
      { cause: error },
    );
  }
}

function boundedEvidence(
  evidence: unknown,
  limit = INSIGHT_EVIDENCE_LIMIT,
): Array<{ uri: string }> {
  if (!Array.isArray(evidence)) return [];
  const pointers = new Set<string>();
  for (const item of evidence) {
    const pointer =
      typeof item === "string"
        ? item
        : item && typeof item === "object"
          ? typeof (item as any).pointer === "string"
            ? (item as any).pointer
            : typeof (item as any).pointer?.uri === "string"
              ? (item as any).pointer.uri
              : null
          : null;
    if (!pointer) continue;
    try {
      parseEvidenceUri(pointer);
      pointers.add(pointer);
    } catch {
      continue;
    }
    if (pointers.size >= limit) break;
  }
  return [...pointers].map((uri) => ({ uri }));
}

function boundedDecisionBoundary(value: unknown): unknown {
  if (!value || typeof value !== "object") return null;
  const boundary = value as any;
  const shape = (item: any) =>
    item
      ? {
          claim: item.claim,
          evidence: boundedEvidence(item.evidence),
        }
      : null;
  return {
    grantsAutonomy: shape(boundary.grantsAutonomy),
    imposesGuardrail: shape(boundary.imposesGuardrail),
  };
}

function evidenceUri(value: unknown): string | null {
  const uri =
    typeof value === "string"
      ? value
      : value && typeof value === "object" && typeof (value as any).uri === "string"
        ? (value as any).uri
        : null;
  if (!uri) return null;
  try {
    return parseEvidenceUri(uri).uri;
  } catch {
    return null;
  }
}

function boundedSnippet(value: unknown): string {
  const text = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  return text.length <= SUMMARY_SNIPPET_LIMIT
    ? text
    : `${text.slice(0, SUMMARY_SNIPPET_LIMIT - 1)}…`;
}

function boundedEvidenceDetails(
  evidence: unknown,
  limit: number,
): Array<{ uri: string; snippet: string }> {
  if (!Array.isArray(evidence)) return [];
  const found: Array<{ uri: string; snippet: string }> = [];
  const seen = new Set<string>();
  for (const item of evidence) {
    const pointer =
      item && typeof item === "object" && "pointer" in item ? (item as any).pointer : item;
    const uri = evidenceUri(pointer);
    if (!uri || seen.has(uri)) continue;
    seen.add(uri);
    found.push({
      uri,
      snippet: boundedSnippet(item && typeof item === "object" ? (item as any).snippet : ""),
    });
    if (found.length >= limit) break;
  }
  return found;
}

function boundedText(value: unknown, limit: number): string {
  const text = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  return text.length <= limit ? text : `${text.slice(0, Math.max(0, limit - 1))}…`;
}

function candidateFrequency(value: any): Record<string, number> {
  return Object.fromEntries(
    [
      "occurrences",
      "distinctSnippets",
      "conversations",
      "sessions",
      "projects",
      "harnesses",
      "threshold",
    ].map((key) => [key, Number(value?.[key] ?? 0)]),
  );
}

function candidateSummary(candidate: any): Record<string, unknown> {
  return {
    id: boundedText(candidate.id, 200),
    type: candidate.type,
    signature: boundedText(candidate.signature, 320),
    title: boundedText(candidate.title, 320),
    status: candidate.status,
    frequency: candidateFrequency(candidate.frequency),
    reviewNotice: KNOWLEDGE_REVIEW_NOTICE,
  };
}

function candidateDetail(candidate: any): Record<string, unknown> {
  const curation = candidate.curation ?? {};
  const evaluation = candidate.evaluation ?? {};
  return {
    ...candidateSummary(candidate),
    curation: {
      principle: boundedText(curation.principle, 1_200),
      route: boundedText(curation.route, 1_200),
      checks: (Array.isArray(curation.checks) ? curation.checks : [])
        .slice(0, KNOWLEDGE_CANDIDATE_CHECKS_MAX)
        .map((check: unknown) => boundedText(check, 500)),
    },
    evaluation: {
      contract: boundedText(evaluation.contract, 160),
      status: boundedText(evaluation.status, 80),
      minimumRunsPerArm: Number(evaluation.minimumRunsPerArm ?? 0),
      control: boundedText(evaluation.control, 1_200),
      treatment: boundedText(evaluation.treatment, 1_200),
      metrics: (Array.isArray(evaluation.metrics) ? evaluation.metrics : [])
        .slice(0, KNOWLEDGE_CANDIDATE_CHECKS_MAX)
        .map((metric: unknown) => boundedText(metric, 160)),
      keepRule: boundedText(evaluation.keepRule, 1_200),
      cutRule: boundedText(evaluation.cutRule, 1_200),
    },
    evidence: boundedEvidence(candidate.evidence, KNOWLEDGE_CANDIDATE_DETAIL_EVIDENCE_MAX),
  };
}

interface ThemeProjection {
  exact: boolean;
  reason: "current-projection" | "projection-missing" | "projection-invalid" | "projection-bound";
  hashes: string[];
}

interface ThemeCachePath {
  directory: string;
  filename: string;
  path: string;
}

interface ThemeCacheEntry {
  key: string;
  model: string;
  recipe: string;
  topics: string[];
}

async function readThemeProjection(root: string): Promise<ThemeProjection> {
  const path = join(root, "derived", "current-hashes.jsonl");
  let size: number;
  try {
    size = (await stat(path)).size;
  } catch (error: unknown) {
    return {
      exact: false,
      reason: nodeErrorCode(error) === "ENOENT" ? "projection-missing" : "projection-invalid",
      hashes: [],
    };
  }
  if (size > THEMES_PROJECTION_BYTES_MAX)
    return { exact: false, reason: "projection-bound", hashes: [] };
  try {
    const projection = await assertDerivedProjection(root);
    return {
      exact: true,
      reason: "current-projection",
      hashes: projection.conversationHashes,
    };
  } catch {
    return { exact: false, reason: "projection-invalid", hashes: [] };
  }
}

async function scanThemeCachePaths(
  root: string,
  limit: number,
): Promise<{ exact: boolean; paths: ThemeCachePath[]; observedFiles: number }> {
  const cacheRoot = join(root, "analysis", "vault-topic-cache");
  const paths: ThemeCachePath[] = [];
  if (!existsSync(cacheRoot)) return { exact: true, paths, observedFiles: 0 };
  let rootDirectory;
  try {
    rootDirectory = await opendir(cacheRoot);
  } catch (error: unknown) {
    if (nodeErrorCode(error) === "ENOENT") return { exact: true, paths, observedFiles: 0 };
    return { exact: false, paths, observedFiles: 0 };
  }
  let observedFiles = 0;
  for await (const prefix of rootDirectory) {
    if (!prefix.isDirectory() || !/^[a-f0-9]{2}$/.test(prefix.name)) continue;
    let directory;
    try {
      directory = await opendir(join(cacheRoot, prefix.name));
    } catch {
      return { exact: false, paths, observedFiles };
    }
    for await (const entry of directory) {
      if (!entry.isFile()) continue;
      observedFiles++;
      if (observedFiles > limit) return { exact: false, paths, observedFiles };
      paths.push({
        directory: prefix.name,
        filename: entry.name,
        path: join(cacheRoot, prefix.name, entry.name),
      });
    }
  }
  return { exact: true, paths, observedFiles };
}

async function readThemeCacheEntry(
  item: ThemeCachePath,
): Promise<{ entry: ThemeCacheEntry | null; invalid: boolean }> {
  const match = /^([a-f0-9]{64})\.json$/.exec(item.filename);
  if (!match || item.directory !== match[1]!.slice(0, 2)) return { entry: null, invalid: true };
  try {
    if ((await stat(item.path)).size > THEMES_CACHE_ENTRY_BYTES_MAX)
      return { entry: null, invalid: true };
    const parsed = JSON.parse(await readFile(item.path, "utf8")) as any;
    if (
      !Array.isArray(parsed.topics) ||
      parsed.topics.length < 1 ||
      parsed.topics.length > 5 ||
      typeof parsed.model !== "string" ||
      !parsed.model.trim() ||
      parsed.model.length > 200 ||
      typeof parsed.recipe !== "string" ||
      !parsed.recipe.trim() ||
      parsed.recipe.length > 200 ||
      typeof parsed.extractedAt !== "string" ||
      Number.isNaN(new Date(parsed.extractedAt).getTime())
    )
      return { entry: null, invalid: true };
    const topics = parsed.topics.map((topic: unknown) =>
      typeof topic === "string" ? normalizeTopic(topic) : "",
    );
    if (
      topics.some((topic: string) => topic.length < 2 || topic.length > 60) ||
      new Set(topics).size !== topics.length
    )
      return { entry: null, invalid: true };
    return {
      entry: {
        key: match[1]!,
        model: parsed.model.trim(),
        recipe: parsed.recipe.trim(),
        topics,
      },
      invalid: false,
    };
  } catch {
    return { entry: null, invalid: true };
  }
}

function themeVariantId(model: string, recipe: string): string {
  return JSON.stringify([model, recipe]);
}
export class WorkbenchData {
  readonly root: string;
  private readonly db: Database | null;
  private readonly currentColumns: Set<string>;
  private readonly projectionGuard: ActiveProjectionGuard;

  constructor(root: string) {
    this.root = resolve(root);
    this.projectionGuard = new ActiveProjectionGuard(this.root);
    const databasePath = join(this.root, "analysis", "chatlog.sqlite");
    if (!existsSync(databasePath)) {
      this.db = null;
      this.currentColumns = new Set();
      return;
    }
    this.db = new Database(databasePath, { readonly: true, create: false });
    this.currentColumns = new Set(
      (
        this.db.query("PRAGMA table_info(current_conversations)").all() as Array<{ name: string }>
      ).map((row) => row.name),
    );
  }

  close(): void {
    this.db?.close();
  }

  private requireDb(): Database {
    if (!this.db)
      throw new Error(
        `No Chatlog analysis database at ${join(this.root, "analysis", "chatlog.sqlite")}`,
      );
    return this.db;
  }

  private optionalColumn(name: string, fallback: string): string {
    return this.currentColumns.has(name) ? `c.${name}` : fallback;
  }

  private assertProjection(expected?: ProjectionReceipt): ProjectionReceipt {
    const current = this.projectionGuard.assert(this.requireDb());
    if (
      expected &&
      (current.manifestSourcesHash !== expected.manifestSourcesHash ||
        current.reconciledAt !== expected.reconciledAt ||
        current.activeSources !== expected.activeSources)
    ) {
      throw new ActiveProjectionDriftError(
        "active source projection changed while serving the request; retry",
      );
    }
    return current;
  }

  health(): { ready: boolean; activeSources: number } {
    if (!this.db) return { ready: false, activeSources: 0 };
    const projection = this.assertProjection();
    return { ready: true, activeSources: projection.activeSources };
  }

  async overview(): Promise<unknown> {
    if (!this.db)
      return {
        ready: false,
        root: this.root,
        corpus: { sessions: 0, projects: 0, turns: 0, firstSession: null, lastSession: null },
        harnesses: [],
        domains: [],
        projects: [],
        recent: [],
        tools: [],
      };
    const projection = this.assertProjection();
    const db = this.db;
    const corpus = db
      .query(`SELECT count(*) sessions, count(DISTINCT project) projects,
      sum(turn_count) turns, min(started_at) firstSession, max(ended_at) lastSession
      FROM current_conversations`)
      .get();
    const harnesses = db
      .query(`SELECT harness, count(*) sessions, sum(turn_count) turns
      FROM current_conversations GROUP BY harness ORDER BY sessions DESC`)
      .all();
    const domains = this.currentColumns.has("domain")
      ? db
          .query(
            `SELECT domain, count(*) sessions FROM current_conversations GROUP BY domain ORDER BY sessions DESC`,
          )
          .all()
      : [{ domain: "coding", sessions: (corpus as any).sessions }];
    const projects = db
      .query(`SELECT project, count(*) sessions, sum(turn_count) turns,
      max(ended_at) lastSeen FROM current_conversations GROUP BY project
      ORDER BY sessions DESC, turns DESC LIMIT 12`)
      .all();
    const title = this.optionalColumn("title", "''");
    const domain = this.optionalColumn("domain", "'coding'");
    const recent = db
      .query(`SELECT c.content_hash contentHash, c.id, ${title} title, ${domain} domain,
      c.project, c.harness, c.model, c.started_at startedAt, c.ended_at endedAt, c.turn_count turns
      FROM current_conversations c ORDER BY c.ended_at DESC LIMIT 12`)
      .all();
    const tools = db
      .query(`SELECT tc.name, count(*) calls, count(DISTINCT tc.content_hash) sessions
      FROM tool_calls tc JOIN current_conversations c USING(content_hash)
      GROUP BY tc.name ORDER BY calls DESC LIMIT 10`)
      .all();
    const result = {
      ready: true,
      root: this.root,
      corpus,
      harnesses,
      domains,
      projects,
      recent,
      tools,
    };
    this.assertProjection(projection);
    return result;
  }

  projects(limitValue: string | null): unknown[] {
    const projection = this.assertProjection();
    const limit = boundedInteger(limitValue, 50, 200);
    const result = this.requireDb()
      .query(`SELECT project, count(*) sessions, sum(turn_count) turns,
      min(started_at) firstSeen, max(ended_at) lastSeen
      FROM current_conversations GROUP BY project
      ORDER BY sessions DESC, turns DESC LIMIT ?`)
      .all(limit) as unknown[];
    this.assertProjection(projection);
    return result;
  }

  sessions(url: URL): unknown[] {
    const projection = this.assertProjection();
    const db = this.requireDb();
    const limit = boundedInteger(url.searchParams.get("limit"), 40, 100);
    const project = url.searchParams.get("project");
    const query = url.searchParams.get("q")?.trim();
    const where: string[] = [];
    const params: Array<string | number> = [];
    if (project) {
      where.push("c.project = ?");
      params.push(project);
    }
    if (query) {
      const title = this.optionalColumn("title", "''");
      where.push(`(c.project LIKE ? OR c.model LIKE ? OR c.id LIKE ? OR ${title} LIKE ?)`);
      const like = `%${query}%`;
      params.push(like, like, like, like);
    }
    params.push(limit);
    const title = this.optionalColumn("title", "''");
    const domain = this.optionalColumn("domain", "'coding'");
    const sourceKind = this.optionalColumn("source_kind", "'session-log'");
    const result = db
      .query(`SELECT c.content_hash contentHash, c.id, ${title} title, ${domain} domain,
      ${sourceKind} sourceKind, c.project, c.harness, c.model, c.started_at startedAt,
      c.ended_at endedAt, c.turn_count turns
      FROM current_conversations c ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY c.ended_at DESC LIMIT ?`)
      .all(...params) as unknown[];
    this.assertProjection(projection);
    return result;
  }

  search(url: URL): unknown {
    const projection = this.assertProjection();
    const db = this.requireDb();
    const query = url.searchParams.get("q")?.trim() ?? "";
    const limit = boundedInteger(url.searchParams.get("limit"), 24, 100);
    const expression = searchExpression(query);
    const title = this.optionalColumn("title", "''");
    const domain = this.optionalColumn("domain", "'coding'");
    const hits = db
      .query(`SELECT c.content_hash contentHash, c.id, ${title} title, ${domain} domain,
      c.project, c.harness, c.model, c.ended_at endedAt, f.turn_index turnIndex,
      snippet(turns_fts, 0, '<mark>', '</mark>', ' … ', 32) snippet,
      -bm25(turns_fts) score
      FROM turns_fts f JOIN current_conversations c ON c.content_hash=f.content_hash
      WHERE turns_fts MATCH ? ORDER BY bm25(turns_fts) LIMIT ?`)
      .all(expression, limit) as any[];
    const result = {
      query,
      expression,
      hits: hits.map((hit) => ({
        ...hit,
        evidenceUri: `chatlog://conversation/${hit.contentHash}/turn/${hit.turnIndex}`,
      })),
    };
    this.assertProjection(projection);
    return result;
  }

  async priorAttempts(url: URL): Promise<unknown> {
    const projection = this.assertProjection();
    const derivedProjection = await assertDerivedProjection(this.root);
    const db = this.requireDb();
    const question = url.searchParams.get("q")?.trim() ?? "";
    const limit = boundedInteger(url.searchParams.get("limit"), 6, PRIOR_ATTEMPT_LIMIT);
    const candidateLimit = Math.min(PRIOR_ATTEMPT_LIMIT * 4, Math.max(limit * 4, 20));
    const lexical = (await agentAskLexical(db, this.root, question, candidateLimit, {
      contentRolesOnly: true,
      groupedSessionLoadLimit: candidateLimit,
    })) as any;
    const candidates = [];
    for (const session of lexical.sessions ?? []) {
      candidates.push({
        sessionId: session.sessionId,
        conversationHash: session.conversationHash,
        project: session.project,
        harness: session.harness,
        model: session.model,
        endedAt: session.endedAt,
        matchedEvidence: boundedEvidenceDetails(session.matchedEvidence, 2),
        problems: boundedEvidenceDetails(session.priorProblems, 2),
        attempts: (Array.isArray(session.attempts) ? session.attempts : [])
          .slice(-4)
          .flatMap((attempt: any) => {
            const uri = evidenceUri(attempt.pointer);
            if (!uri) return [];
            return [
              {
                uri,
                snippet: boundedSnippet(attempt.snippet),
                tools: Array.isArray(attempt.tools)
                  ? attempt.tools.filter((tool: unknown) => typeof tool === "string").slice(0, 6)
                  : [],
                outcome: attempt.outcome,
                resultUri: evidenceUri(attempt.resultPointer),
              },
            ];
          }),
        decisions: boundedEvidenceDetails(session.decisions, 3),
        outcome: session.outcome?.status ?? "unknown",
        resolutions: boundedEvidenceDetails(session.resolutionPointers, 2),
      });
    }
    const sessions = candidates
      .toSorted((a, b) => b.endedAt.localeCompare(a.endedAt))
      .slice(0, limit)
      .toSorted((a, b) => a.endedAt.localeCompare(b.endedAt));
    const outcomes = Object.fromEntries(
      ["success", "failure", "mixed", "unknown"].map((status) => [
        status,
        sessions.filter((session) => session.outcome === status).length,
      ]),
    );
    const result = {
      mode: "lexical",
      question: lexical.question,
      interpretedTopic: lexical.interpretedTopic,
      searchExpression: lexical.searchExpression,
      candidateSessions: lexical.matchedSessions,
      matchedSessions: sessions.length,
      outcomes,
      sessions,
      bounds: {
        requestedSessionLimit: limit,
        candidateSessionLimit: candidateLimit,
        derivedArtifactReadLimit: candidateLimit,
        derivedArtifactsRead: lexical.bounds.loadedSessions,
        sessionLimit: PRIOR_ATTEMPT_LIMIT,
        returnedSessions: sessions.length,
        matchedEvidencePerSession: 2,
        problemsPerSession: 2,
        attemptsPerSession: 4,
        decisionsPerSession: 3,
        resolutionsPerSession: 2,
        snippetCharacters: SUMMARY_SNIPPET_LIMIT,
      },
      egress: { performed: false, surface: "none" },
    };
    this.assertProjection(projection);
    assertStableDerivedProjection(derivedProjection, await assertDerivedProjection(this.root));
    return result;
  }

  async projectIntelligence(url: URL): Promise<unknown> {
    const projection = this.assertProjection();
    const derivedProjection = await assertDerivedProjection(this.root);
    const db = this.requireDb();
    const project = url.searchParams.get("project")?.trim();
    if (!project) return Promise.reject(new Error("project must be an exact non-empty path"));
    const sampleLimit = boundedInteger(
      url.searchParams.get("sampleLimit"),
      24,
      PROJECT_DERIVED_SAMPLE_LIMIT,
    );
    const sessionLimit = boundedInteger(
      url.searchParams.get("sessionLimit"),
      40,
      PROJECT_SESSION_LIMIT,
    );
    const overview = db
      .query(`SELECT count(*) sessions, sum(c.turn_count) turns,
      min(c.started_at) firstSeen, max(c.ended_at) lastSeen
      FROM current_conversations c WHERE c.project = ?`)
      .get(project) as any;
    if (!Number(overview?.sessions))
      return Promise.reject(new Error(`project not found: ${project}`));
    const harnesses = db
      .query(`SELECT c.harness, count(*) sessions, sum(c.turn_count) turns
      FROM current_conversations c WHERE c.project = ?
      GROUP BY c.harness ORDER BY sessions DESC LIMIT 8`)
      .all(project);
    const models = db
      .query(`SELECT c.model, c.harness, count(*) sessions, sum(c.turn_count) turns
      FROM current_conversations c WHERE c.project = ?
      GROUP BY c.model, c.harness ORDER BY sessions DESC, turns DESC LIMIT 8`)
      .all(project);
    const tools = db
      .query(`SELECT tc.name tool, count(*) calls, count(DISTINCT tc.content_hash) sessions
      FROM tool_calls tc JOIN current_conversations c USING(content_hash)
      JOIN turns t ON t.content_hash=tc.content_hash AND t.turn_index=tc.turn_index
      WHERE c.project = ? AND t.role='assistant'
      GROUP BY tc.name ORDER BY calls DESC, sessions DESC LIMIT 10`)
      .all(project);
    const hashes = db
      .query(`SELECT c.content_hash contentHash, c.ended_at endedAt
      FROM current_conversations c WHERE c.project = ?
      ORDER BY c.ended_at DESC LIMIT ?`)
      .all(project, sampleLimit) as Array<{ contentHash: string; endedAt: string }>;
    const outcomes: Record<string, number> = {
      success: 0,
      failure: 0,
      mixed: 0,
      unknown: 0,
    };
    const recurring = new Map<
      string,
      {
        occurrences: number;
        sessions: Set<string>;
        examples: Array<{
          sessionId: string;
          harness: string;
          model: string;
          outcome: string;
          evidence: { uri: string; snippet: string };
          resolution: { uri: string; snippet: string } | null;
        }>;
      }
    >();
    const decisions: Array<{
      sessionId: string;
      model: string;
      harness: string;
      endedAt: string;
      evidence: { uri: string; snippet: string };
    }> = [];
    const sampledArtifacts = await Promise.all(
      hashes.map(async ({ contentHash }) => {
        try {
          return { contentHash, artifact: await loadDerived(this.root, contentHash) };
        } catch {
          return { contentHash, artifact: null };
        }
      }),
    );
    let derivedMissing = 0;
    let derivedSessions = 0;
    for (const { contentHash, artifact } of sampledArtifacts) {
      if (!artifact) {
        derivedMissing++;
        continue;
      }
      if (artifact.conversationHash !== contentHash || artifact.project !== project) {
        derivedMissing++;
        continue;
      }
      derivedSessions++;
      outcomes[artifact.outcome.status] = (outcomes[artifact.outcome.status] ?? 0) + 1;
      const categoriesSeen = new Set<string>();
      for (const problem of artifact.problems)
        for (const category of problem.categories) {
          const item = recurring.get(category) ?? {
            occurrences: 0,
            sessions: new Set<string>(),
            examples: [],
          };
          item.occurrences++;
          item.sessions.add(contentHash);
          if (!categoriesSeen.has(category) && item.examples.length < 2) {
            const [evidence] = boundedEvidenceDetails([problem], 1);
            const [resolution] = boundedEvidenceDetails(artifact.outcome.evidence, 1);
            if (evidence)
              item.examples.push({
                sessionId: artifact.sessionId,
                harness: artifact.harness,
                model: artifact.model,
                outcome: artifact.outcome.status,
                evidence,
                resolution: resolution ?? null,
              });
          }
          categoriesSeen.add(category);
          recurring.set(category, item);
        }
      for (const decision of artifact.decisions.slice(-2)) {
        const [evidence] = boundedEvidenceDetails([decision], 1);
        if (evidence)
          decisions.push({
            sessionId: artifact.sessionId,
            model: artifact.model,
            harness: artifact.harness,
            endedAt: artifact.endedAt,
            evidence,
          });
      }
    }
    const recurringProblems = [...recurring]
      .map(([category, item]) => ({
        category,
        occurrences: item.occurrences,
        sessions: item.sessions.size,
        examples: item.examples,
      }))
      .toSorted((a, b) => b.sessions - a.sessions || b.occurrences - a.occurrences)
      .slice(0, 10);
    const recentDecisions = decisions
      .toSorted((a, b) => b.endedAt.localeCompare(a.endedAt))
      .slice(0, 10);
    const sessionUrl = new URL("http://localhost/api/sessions");
    sessionUrl.searchParams.set("project", project);
    sessionUrl.searchParams.set("limit", String(sessionLimit));
    const sessions = this.sessions(sessionUrl);
    const result = {
      project,
      scope: {
        source: "current_conversations",
        totalCurrentSessions: Number(overview?.sessions ?? 0),
        derivedSampleLimit: sampleLimit,
        sampledCurrentSessions: hashes.length,
        derivedSessions,
        derivedMissing,
      },
      overview: {
        sessions: Number(overview?.sessions ?? 0),
        turns: Number(overview?.turns ?? 0),
        firstSeen: overview?.firstSeen ?? null,
        lastSeen: overview?.lastSeen ?? null,
      },
      harnesses,
      outcomes,
      recurringProblems,
      recentDecisions,
      models,
      tools,
      sessions,
      bounds: {
        requestedDerivedSampleLimit: sampleLimit,
        requestedSessionLimit: sessionLimit,
        maximumDerivedSample: PROJECT_DERIVED_SAMPLE_LIMIT,
        maximumSessions: PROJECT_SESSION_LIMIT,
        maximumProblemCategories: 10,
        examplesPerProblemCategory: 2,
        maximumDecisions: 10,
        snippetCharacters: SUMMARY_SNIPPET_LIMIT,
      },
      egress: { performed: false, surface: "none" },
    };
    this.assertProjection(projection);
    assertStableDerivedProjection(derivedProjection, await assertDerivedProjection(this.root));
    return result;
  }

  async knowledgeCandidates(url: URL): Promise<unknown> {
    const query = boundedText(url.searchParams.get("q"), KNOWLEDGE_CANDIDATE_QUERY_MAX);
    const requestedType = url.searchParams.get("type")?.trim() ?? "";
    if (
      requestedType &&
      requestedType !== "all" &&
      !KNOWLEDGE_CANDIDATE_TYPES.some((candidateType) => candidateType === requestedType)
    )
      return Promise.reject(new Error(`unsupported knowledge candidate type: ${requestedType}`));
    const type = requestedType && requestedType !== "all" ? requestedType : null;
    const page = boundedInteger(url.searchParams.get("page"), 1, KNOWLEDGE_CANDIDATE_PAGE_MAX);
    const pageSize = boundedInteger(
      url.searchParams.get("pageSize"),
      KNOWLEDGE_CANDIDATE_PAGE_SIZE,
      KNOWLEDGE_CANDIDATE_PAGE_SIZE_MAX,
    );
    const projection = this.assertProjection();
    const derivedProjection = await assertDerivedProjection(this.root);
    const refinery = await loadProjectionBoundArtifact(this.root, "refinery-manifest.json", {
      optional: true,
      projection: derivedProjection,
      inputProjectionHash: derivedProjection.structureProjectionHash,
    });
    const provenance = refinery
      ? artifactFreshness(derivedProjection.structureProjectionHash, refinery)
      : null;
    const normalizedQuery = query.toLowerCase();
    const candidates = (
      Array.isArray(refinery?.artifact.candidates) ? refinery.artifact.candidates : []
    ).filter((candidate: any) => {
      if (type && candidate.type !== type) return false;
      if (!normalizedQuery) return true;
      return [
        candidate.id,
        candidate.title,
        candidate.signature,
        candidate.type,
        candidate.status,
      ].some((value) =>
        String(value ?? "")
          .toLowerCase()
          .includes(normalizedQuery),
      );
    });
    const total = candidates.length;
    const offset = (page - 1) * pageSize;
    const result = {
      available: Boolean(refinery),
      provenance,
      threshold: Number(refinery?.artifact.threshold ?? 0),
      policy: {
        autoPromotion: false,
        frequencyIsSignalNotDecision:
          refinery?.artifact.policy?.frequencyIsSignalNotDecision === true,
      },
      precisionGate: KNOWLEDGE_PRECISION_GATE,
      reviewNotice: KNOWLEDGE_REVIEW_NOTICE,
      filters: {
        q: query,
        type,
        supportedTypes: KNOWLEDGE_CANDIDATE_TYPES,
      },
      pagination: {
        page,
        pageSize,
        total,
        totalPages: total ? Math.ceil(total / pageSize) : 0,
      },
      items: candidates.slice(offset, offset + pageSize).map(candidateSummary),
      bounds: {
        queryCharacters: KNOWLEDGE_CANDIDATE_QUERY_MAX,
        maximumPage: KNOWLEDGE_CANDIDATE_PAGE_MAX,
        maximumPageSize: KNOWLEDGE_CANDIDATE_PAGE_SIZE_MAX,
        detailEvidencePointers: KNOWLEDGE_CANDIDATE_DETAIL_EVIDENCE_MAX,
        curationChecks: KNOWLEDGE_CANDIDATE_CHECKS_MAX,
      },
      egress: { performed: false, surface: "none" },
    };
    this.assertProjection(projection);
    assertStableDerivedProjection(derivedProjection, await assertDerivedProjection(this.root));
    return result;
  }

  async knowledgeCandidate(url: URL): Promise<unknown> {
    const id = url.searchParams.get("id")?.trim() ?? "";
    if (!id) return Promise.reject(new Error("knowledge candidate id is required"));
    if (id.length > 200)
      return Promise.reject(new Error("knowledge candidate id exceeds 200 characters"));
    const projection = this.assertProjection();
    const derivedProjection = await assertDerivedProjection(this.root);
    const refinery = await loadProjectionBoundArtifact(this.root, "refinery-manifest.json", {
      optional: true,
      projection: derivedProjection,
      inputProjectionHash: derivedProjection.structureProjectionHash,
    });
    if (!refinery) return Promise.reject(new Error("knowledge candidate artifact not found"));
    const metadata = await artifactMetadata(this.root, "refinery-manifest.json", refinery);
    const candidate = (refinery.artifact.candidates ?? []).find((item: any) => item.id === id);
    if (!candidate) return Promise.reject(new Error(`knowledge candidate not found: ${id}`));
    const result = {
      candidate: candidateDetail(candidate),
      provenance: artifactFreshness(derivedProjection.structureProjectionHash, refinery),
      artifact: {
        contentHash: refinery.contentHash,
        inputProjectionHash: refinery.inputProjectionHash,
        recipeHash:
          typeof refinery.artifact.recipeHash === "string" ? refinery.artifact.recipeHash : null,
        processedAt: metadata.processedAt,
      },
      policy: {
        autoPromotion: false,
        mutationAvailable: false,
      },
      precisionGate: KNOWLEDGE_PRECISION_GATE,
      reviewNotice: KNOWLEDGE_REVIEW_NOTICE,
      bounds: {
        evidencePointers: KNOWLEDGE_CANDIDATE_DETAIL_EVIDENCE_MAX,
        curationChecks: KNOWLEDGE_CANDIDATE_CHECKS_MAX,
      },
      egress: { performed: false, surface: "none" },
    };
    this.assertProjection(projection);
    assertStableDerivedProjection(derivedProjection, await assertDerivedProjection(this.root));
    return result;
  }

  async themes(url: URL): Promise<unknown> {
    const requestedScanLimit = url.searchParams.get("scanLimit");
    const scanLimit = boundedInteger(
      requestedScanLimit,
      THEMES_CACHE_SCAN_MAX,
      THEMES_CACHE_SCAN_MAX,
    );
    const clusterLimit = boundedInteger(
      url.searchParams.get("limit"),
      THEMES_CLUSTER_LIMIT,
      THEMES_CLUSTER_LIMIT_MAX,
    );
    const requestedTopicLimit = url.searchParams.get("topicLimit");
    const topicLimit = boundedInteger(
      requestedTopicLimit,
      THEMES_UNIQUE_TOPICS_MAX,
      THEMES_UNIQUE_TOPICS_MAX,
    );
    const [projection, scan] = await Promise.all([
      readThemeProjection(this.root),
      scanThemeCachePaths(this.root, scanLimit),
    ]);
    const base = {
      label: "Experimental · partial cached sample",
      scope: "current-projection cached sample only",
      clusterRecipe: THEMES_CLUSTER_RECIPE,
      bounds: {
        requestedScanLimit: requestedScanLimit == null ? null : boundedText(requestedScanLimit, 32),
        appliedScanLimit: scanLimit,
        maximumScanLimit: THEMES_CACHE_SCAN_MAX,
        maximumKeyComputations: THEMES_KEY_COMPUTATION_MAX,
        maximumProjectionBytes: THEMES_PROJECTION_BYTES_MAX,
        maximumCacheEntryBytes: THEMES_CACHE_ENTRY_BYTES_MAX,
        requestedClusterLimit: clusterLimit,
        maximumClusterLimit: THEMES_CLUSTER_LIMIT_MAX,
        maximumClusterMembers: THEMES_CLUSTER_MEMBERS_MAX,
        requestedTopicLimit:
          requestedTopicLimit == null ? null : boundedText(requestedTopicLimit, 32),
        appliedTopicLimit: topicLimit,
        maximumUniqueTopics: THEMES_UNIQUE_TOPICS_MAX,
        maximumPairwiseComparisons: THEMES_PAIRWISE_COMPARISONS_MAX,
      },
      attestations: {
        egressPerformed: false,
        extractionPerformed: false,
        cacheWritesPerformed: false,
        source: "completed vault topic cache files plus current hash projection",
      },
    };
    if (!scan.exact)
      return {
        ...base,
        coverage: {
          exact: false,
          reason: scan.observedFiles > scanLimit ? "cache-scan-bound-exceeded" : "cache-scan-error",
          currentDenominator: projection.exact ? projection.hashes.length : null,
          currentCovered: null,
          percent: null,
          wholeCorpusClaimed: false,
        },
        cache: {
          scannedFiles: Math.min(scan.paths.length, scanLimit),
          observedFilesBeforeStop: scan.observedFiles,
          totalCompletedEntries: null,
          staleOtherEntries: null,
          invalidEntries: null,
        },
        variants: [],
        clusters: [],
        distribution: null,
      };
    const parsed = await Promise.all(scan.paths.map(readThemeCacheEntry));
    const entries = parsed.flatMap((item) => (item.entry ? [item.entry] : []));
    const invalidEntries = parsed.filter((item) => item.invalid).length;
    const variantsById = new Map<
      string,
      {
        model: string;
        recipe: string;
        completedCacheEntries: number;
        currentCacheEntries: number;
        currentHashes: Set<string>;
      }
    >();
    for (const entry of entries) {
      const id = themeVariantId(entry.model, entry.recipe);
      const variant = variantsById.get(id) ?? {
        model: entry.model,
        recipe: entry.recipe,
        completedCacheEntries: 0,
        currentCacheEntries: 0,
        currentHashes: new Set<string>(),
      };
      variant.completedCacheEntries++;
      variantsById.set(id, variant);
    }
    const incompleteCoverage = (reason: string, currentDenominator: number | null): unknown => ({
      ...base,
      coverage: {
        exact: false,
        reason,
        currentDenominator,
        currentCovered: null,
        percent: null,
        wholeCorpusClaimed: false,
      },
      cache: {
        scannedFiles: scan.paths.length,
        observedFilesBeforeStop: scan.observedFiles,
        totalCompletedEntries: entries.length,
        staleOtherEntries: null,
        invalidEntries,
      },
      variants: [...variantsById.values()]
        .map((variant) => ({
          model: variant.model,
          recipe: variant.recipe,
          completedCacheEntries: variant.completedCacheEntries,
          currentCacheEntries: null,
          currentCovered: null,
          coveragePercent: null,
        }))
        .toSorted((a, b) => a.model.localeCompare(b.model) || a.recipe.localeCompare(b.recipe)),
      clusters: [],
      distribution: null,
    });
    if (!projection.exact) return incompleteCoverage(projection.reason, null);
    const keyComputations = projection.hashes.length * variantsById.size;
    if (keyComputations > THEMES_KEY_COMPUTATION_MAX)
      return incompleteCoverage("key-computation-bound-exceeded", projection.hashes.length);
    const expected = new Map<string, { conversationHash: string; variantId: string }>();
    for (const [variantId, variant] of variantsById)
      for (const conversationHash of projection.hashes)
        expected.set(topicCacheKey(conversationHash, variant.model, variant.recipe), {
          conversationHash,
          variantId,
        });
    const topicsByConversation = new Map<string, Set<string>>();
    let currentCacheEntries = 0;
    for (const entry of entries) {
      const variantId = themeVariantId(entry.model, entry.recipe);
      const match = expected.get(entry.key);
      if (!match || match.variantId !== variantId) continue;
      currentCacheEntries++;
      const topics = topicsByConversation.get(match.conversationHash) ?? new Set<string>();
      for (const topic of entry.topics) topics.add(topic);
      topicsByConversation.set(match.conversationHash, topics);
      const variant = variantsById.get(variantId)!;
      variant.currentCacheEntries++;
      variant.currentHashes.add(match.conversationHash);
    }
    const rawCounts = new Map<string, number>();
    for (const topics of topicsByConversation.values())
      for (const topic of topics) rawCounts.set(topic, (rawCounts.get(topic) ?? 0) + 1);
    const denominator = projection.hashes.length;
    const covered = topicsByConversation.size;
    const percent = denominator ? Number(((covered / denominator) * 100).toFixed(1)) : 0;
    const pairwiseComparisons = (rawCounts.size * (rawCounts.size - 1)) / 2;
    const cacheResult = {
      scannedFiles: scan.paths.length,
      observedFilesBeforeStop: scan.observedFiles,
      totalCompletedEntries: entries.length,
      staleOtherEntries: entries.length - currentCacheEntries,
      invalidEntries,
    };
    const variantResults = [...variantsById.values()]
      .map((variant) => ({
        model: variant.model,
        recipe: variant.recipe,
        completedCacheEntries: variant.completedCacheEntries,
        currentCacheEntries: variant.currentCacheEntries,
        currentCovered: variant.currentHashes.size,
        coveragePercent: denominator
          ? Number(((variant.currentHashes.size / denominator) * 100).toFixed(1))
          : 0,
      }))
      .toSorted((a, b) => a.model.localeCompare(b.model) || a.recipe.localeCompare(b.recipe));
    if (rawCounts.size > topicLimit || pairwiseComparisons > THEMES_PAIRWISE_COMPARISONS_MAX)
      return {
        ...base,
        coverage: {
          exact: false,
          reason: "topic-clustering-bound-exceeded",
          currentKeyCoverageExact: true,
          currentDenominator: denominator,
          currentCovered: covered,
          percent,
          currentCompletedCacheEntries: currentCacheEntries,
          keyComputations,
          wholeCorpusClaimed: false,
        },
        cache: cacheResult,
        variants: variantResults,
        clustering: {
          exact: false,
          reason: "topic-clustering-bound-exceeded",
          uniqueNormalizedTopics: rawCounts.size,
          appliedUniqueTopicLimit: topicLimit,
          pairwiseComparisons,
          maximumPairwiseComparisons: THEMES_PAIRWISE_COMPARISONS_MAX,
        },
        clusters: [],
        distribution: null,
      };
    const clustered = clusterTopics(rawCounts);
    const canonicalCounts = new Map<string, number>();
    for (const topics of topicsByConversation.values()) {
      const canonical = new Set(
        [...topics].map((topic) => clustered.canonicalOf.get(topic) ?? topic),
      );
      for (const topic of canonical)
        canonicalCounts.set(topic, (canonicalCounts.get(topic) ?? 0) + 1);
    }
    const allClusters = clustered.clusters
      .map((cluster) => ({
        topic: cluster.canonical,
        conversations: canonicalCounts.get(cluster.canonical) ?? 0,
        members: cluster.members.slice(0, THEMES_CLUSTER_MEMBERS_MAX),
        totalMembers: cluster.members.length,
      }))
      .toSorted((a, b) => b.conversations - a.conversations || a.topic.localeCompare(b.topic));
    const shared = allClusters.filter((cluster) => cluster.conversations >= 2);
    const singleton = allClusters.filter((cluster) => cluster.conversations === 1);
    return {
      ...base,
      coverage: {
        exact: true,
        reason: projection.reason,
        currentKeyCoverageExact: true,
        currentDenominator: denominator,
        currentCovered: covered,
        percent,
        currentCompletedCacheEntries: currentCacheEntries,
        keyComputations,
        wholeCorpusClaimed: false,
      },
      cache: cacheResult,
      variants: variantResults,
      clustering: {
        exact: true,
        reason: "within-topic-clustering-bounds",
        uniqueNormalizedTopics: rawCounts.size,
        appliedUniqueTopicLimit: topicLimit,
        pairwiseComparisons,
        maximumPairwiseComparisons: THEMES_PAIRWISE_COMPARISONS_MAX,
      },
      clusters: allClusters.slice(0, clusterLimit),
      distribution: {
        totalClusters: allClusters.length,
        sharedClusters: shared.length,
        sharedConversationAssignments: shared.reduce(
          (sum, cluster) => sum + cluster.conversations,
          0,
        ),
        singletonLongTailClusters: singleton.length,
        singletonConversationAssignments: singleton.reduce(
          (sum, cluster) => sum + cluster.conversations,
          0,
        ),
        singletonLongTailDefinition: "cluster observed in exactly one covered conversation",
      },
    };
  }

  async evidence(uri: string): Promise<unknown> {
    const projection = this.assertProjection();
    const pointer = parseEvidenceUri(uri);
    if ("eventId" in pointer) {
      const indexed = this.requireDb()
        .query(`SELECT c.content_hash contentHash, c.id sessionId, c.title,
          COALESCE(c.domain, 'coding') domain, c.project, c.harness
          FROM current_conversations c JOIN active_sources a
          ON a.source_path = c.source_path AND a.content_hash = c.content_hash
          WHERE a.event_batch_hash = ?`)
        .get(pointer.batchHash) as {
        contentHash: string;
        sessionId: string;
        title: string;
        domain: string;
        project: string;
        harness: string;
      } | null;
      if (!indexed) evidenceNotFound();
      let batch;
      try {
        batch = await readEventBatch(this.root, pointer.batchHash);
      } catch {
        evidenceNotFound();
      }
      const event = batch.events.find((candidate) => candidate.eventId === pointer.eventId);
      if (!event) evidenceNotFound();
      if (event.kind === "model.reasoning.observed" || event.capture.disposition === "opaque")
        evidenceNotFound();
      const content = JSON.stringify(event.payload);
      const result = {
        conversationHash: indexed.contentHash,
        sessionId: indexed.sessionId,
        title: indexed.title ?? "",
        domain: indexed.domain,
        project: indexed.project,
        harness: indexed.harness,
        eventId: event.eventId,
        eventKind: event.kind,
        event: {
          sequence: event.sequence,
          occurredAt: event.occurredAt,
          payload: content.slice(0, EVIDENCE_EVENT_CHARACTER_LIMIT),
          fullLength: content.length,
        },
      };
      this.assertProjection(projection);
      return result;
    }
    const current = this.requireDb()
      .query("SELECT 1 FROM current_conversations WHERE content_hash = ?")
      .get(pointer.contentHash);
    if (!current) evidenceNotFound();
    const conversation = JSON.parse(
      await readFile(
        join(
          this.root,
          "corpus",
          "objects",
          pointer.contentHash.slice(0, 2),
          `${pointer.contentHash}.json`,
        ),
        "utf8",
      ),
    ) as Conversation;
    const turn = conversation.turns[pointer.turnIndex];
    if (!turn) evidenceNotFound("Evidence turn not found");
    const result = {
      conversationHash: pointer.contentHash,
      sessionId: conversation.id,
      title: conversation.title ?? "",
      domain: conversation.domain ?? "coding",
      project: conversation.project,
      harness: conversation.harness,
      turnIndex: pointer.turnIndex,
      turn,
    };
    this.assertProjection(projection);
    return result;
  }

  async insights(url?: URL): Promise<unknown> {
    const projection = this.assertProjection();
    const derivedProjection = await assertDerivedProjection(this.root);
    const [leanCurrent, rolesCurrent, refineryCurrent] = await Promise.all([
      loadProjectionBoundArtifact(this.root, "orchestration-lean-manifest.json", {
        optional: true,
        projection: derivedProjection,
      }),
      loadProjectionBoundArtifact(this.root, "orchestration-roles-manifest.json", {
        optional: true,
        projection: derivedProjection,
      }),
      loadProjectionBoundArtifact(this.root, "refinery-manifest.json", {
        optional: true,
        projection: derivedProjection,
        inputProjectionHash: derivedProjection.structureProjectionHash,
      }),
    ]);
    const effectivenessCurrent = rolesCurrent
      ? await loadCurrentDerivedArtifact(this.root, "orchestration-effectiveness-manifest.json", {
          optional: true,
        })
      : null;
    if (
      effectivenessCurrent &&
      effectivenessCurrent.artifact?.roleProfileContentHash !== rolesCurrent?.contentHash
    ) {
      throw new DerivedProjectionDriftError(
        "orchestration-effectiveness-manifest.json: current artifact does not match the active role projection",
      );
    }
    const lean = leanCurrent?.artifact;
    const roles = rolesCurrent?.artifact;
    const effectiveness = effectivenessCurrent?.artifact;
    const refinery = refineryCurrent?.artifact;
    const leanFreshness = leanCurrent
      ? artifactFreshness(derivedProjection.contentHash, leanCurrent)
      : null;
    const rolesFreshness = rolesCurrent
      ? artifactFreshness(derivedProjection.contentHash, rolesCurrent)
      : null;
    const refineryFreshness = refineryCurrent
      ? artifactFreshness(derivedProjection.structureProjectionHash, refineryCurrent)
      : null;
    const effectivenessFreshness = effectivenessCurrent
      ? {
          fresh: true,
          status: "fresh" as const,
          reason: "role-profile-match",
          currentProjectionHash: derivedProjection.contentHash,
          roleProfileContentHash: effectiveness.roleProfileContentHash,
          currentRoleProfileContentHash: rolesCurrent?.contentHash ?? null,
          artifactInputProjectionHash: effectivenessCurrent.inputProjectionHash,
        }
      : null;
    const result = {
      projection: {
        path: "derived/current-hashes.jsonl",
        contentHash: derivedProjection.contentHash,
      },
      orchestration: lean?.finding
        ? {
            provenance: leanFreshness,
            claim: lean.finding.claim,
            evidence: boundedEvidence(lean.finding.evidence),
            decisionBoundary: boundedDecisionBoundary(lean.finding.decisionBoundary),
            inventories: (lean.inventories ?? []).map((item: any) => ({
              pole: item.pole,
              signal: item.signal,
              claim: item.claim,
              matchingTurns: item.matchingTurns,
              conversations: item.conversations,
            })),
          }
        : null,
      roles: roles
        ? {
            provenance: rolesFreshness,
            inferredCounts: roles.inferredCounts,
            profiles: (roles.profiles ?? []).map((profile: any) => ({
              role: profile.role,
              highConfidenceSessions: profile.highConfidenceSessions,
              classifiedChoices: profile.classifiedChoices,
              autonomyChoiceRate: profile.autonomyChoiceRate,
              claim: profile.claim,
              signalCounts: profile.signalCounts,
              evidence: boundedEvidence(profile.evidence),
            })),
          }
        : null,
      effectiveness: effectiveness?.ranking
        ? {
            provenance: effectivenessFreshness,
            claim: effectiveness.ranking.claim,
            winner: effectiveness.ranking.winner,
            loser: effectiveness.ranking.loser,
            role: effectiveness.ranking.role,
            metrics: effectiveness.ranking.metrics,
            evidence: boundedEvidence(effectiveness.ranking.evidence),
          }
        : null,
      refinery: refinery
        ? {
            provenance: refineryFreshness,
            threshold: refinery.threshold,
            policy: refinery.policy,
            candidateCount: Array.isArray(refinery.candidates) ? refinery.candidates.length : 0,
            candidates:
              url?.searchParams.get("candidateLimit") === "0"
                ? []
                : (refinery.candidates ?? []).map((candidate: any) => ({
                    id: candidate.id,
                    type: candidate.type,
                    signature: candidate.signature,
                    title: candidate.title,
                    status: candidate.status,
                    frequency: candidate.frequency,
                    evidence: boundedEvidence(candidate.evidence, CANDIDATE_EVIDENCE_LIMIT),
                  })),
          }
        : null,
    };
    this.assertProjection(projection);
    const finalDerivedProjection = await assertDerivedProjection(this.root);
    if (
      finalDerivedProjection.contentHash !== derivedProjection.contentHash ||
      finalDerivedProjection.structureProjectionHash !== derivedProjection.structureProjectionHash
    )
      throw new DerivedProjectionDriftError(
        "derived projection changed while serving the request; retry",
      );
    return result;
  }

  sources(): Promise<unknown[]> {
    return sourceCatalog(this.root);
  }

  receipts(limitValue: string | null): Promise<unknown[]> {
    return listImportReceipts(this.root, boundedInteger(limitValue, 20, 100));
  }

  sourceReceipts(limitValue: string | null): Promise<unknown[]> {
    return listSourceReceipts(this.root, boundedInteger(limitValue, 20, 100));
  }

  nominations(): Promise<unknown[]> {
    return readUnknownShapeNominations(this.root);
  }
}
