import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { agentAskLexical } from "../agent-query";
import { loadDerived } from "../derive";
import { parseEvidenceUri } from "../evidence-uri";
import { sourceCatalog } from "../source-catalog";
import type { Conversation } from "../types";

function boundedInteger(value: string | null, fallback: number, maximum = 100): number {
  if (value == null || !value.trim()) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(1, Math.min(maximum, Math.trunc(parsed))) : fallback;
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
const CANDIDATE_EVIDENCE_LIMIT = 2;
const KNOWLEDGE_CANDIDATE_PAGE_SIZE = 20;
const KNOWLEDGE_CANDIDATE_PAGE_SIZE_MAX = 50;
const KNOWLEDGE_CANDIDATE_PAGE_MAX = 10_000;
const KNOWLEDGE_CANDIDATE_QUERY_MAX = 160;
const KNOWLEDGE_CANDIDATE_DETAIL_EVIDENCE_MAX = 6;
const KNOWLEDGE_CANDIDATE_CHECKS_MAX = 12;
const PRIOR_ATTEMPT_LIMIT = 10;
const PROJECT_DERIVED_SAMPLE_LIMIT = 40;
const PROJECT_SESSION_LIMIT = 100;
const SUMMARY_SNIPPET_LIMIT = 360;

interface CurrentArtifact {
  artifact: any;
  manifest: any;
}

interface InsightFreshness {
  fresh: boolean;
  status: "fresh" | "stale";
  reason:
    | "projection-match"
    | "current-projection-missing"
    | "artifact-projection-missing"
    | "artifact-manifest-mismatch"
    | "projection-mismatch";
  currentProjectionHash: string | null;
  artifactProjectionHash: string | null;
  manifestProjectionHash: string | null;
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

function sha256(text: string): string {
  return new Bun.CryptoHasher("sha256").update(text).digest("hex");
}

async function currentProjectionHash(root: string): Promise<string | null> {
  try {
    return sha256(await readFile(join(root, "derived", "current-hashes.jsonl"), "utf8"));
  } catch {
    return null;
  }
}

async function currentArtifact(
  root: string,
  manifestName: string,
): Promise<CurrentArtifact | null> {
  try {
    const manifest = JSON.parse(await readFile(join(root, "derived", manifestName), "utf8"));
    const path = manifest.current?.artifactPath;
    return path
      ? {
          artifact: JSON.parse(await readFile(join(root, "derived", path), "utf8")),
          manifest,
        }
      : null;
  } catch (error: any) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function artifactFreshness(currentHash: string | null, current: CurrentArtifact): InsightFreshness {
  const artifactProjectionHash =
    typeof current.artifact.inputProjectionHash === "string"
      ? current.artifact.inputProjectionHash
      : null;
  const manifestProjectionHash =
    typeof current.manifest.current?.inputProjectionHash === "string"
      ? current.manifest.current.inputProjectionHash
      : null;
  const base = {
    currentProjectionHash: currentHash,
    artifactProjectionHash,
    manifestProjectionHash,
  };
  if (!currentHash)
    return {
      ...base,
      fresh: false,
      status: "stale",
      reason: "current-projection-missing",
    };
  if (!artifactProjectionHash || !manifestProjectionHash)
    return {
      ...base,
      fresh: false,
      status: "stale",
      reason: "artifact-projection-missing",
    };
  if (artifactProjectionHash !== manifestProjectionHash)
    return {
      ...base,
      fresh: false,
      status: "stale",
      reason: "artifact-manifest-mismatch",
    };
  if (artifactProjectionHash !== currentHash)
    return { ...base, fresh: false, status: "stale", reason: "projection-mismatch" };
  return { ...base, fresh: true, status: "fresh", reason: "projection-match" };
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
    evidence: boundedEvidence(
      candidate.evidence,
      KNOWLEDGE_CANDIDATE_DETAIL_EVIDENCE_MAX,
    ),
  };
}

export class WorkbenchData {
  readonly root: string;
  private readonly db: Database | null;
  private readonly currentColumns: Set<string>;

  constructor(root: string) {
    this.root = resolve(root);
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
    return { ready: true, root: this.root, corpus, harnesses, domains, projects, recent, tools };
  }

  projects(limitValue: string | null): unknown[] {
    const limit = boundedInteger(limitValue, 50, 200);
    return this.requireDb()
      .query(`SELECT project, count(*) sessions, sum(turn_count) turns,
      min(started_at) firstSeen, max(ended_at) lastSeen
      FROM current_conversations GROUP BY project
      ORDER BY sessions DESC, turns DESC LIMIT ?`)
      .all(limit) as unknown[];
  }

  sessions(url: URL): unknown[] {
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
    return db
      .query(`SELECT c.content_hash contentHash, c.id, ${title} title, ${domain} domain,
      ${sourceKind} sourceKind, c.project, c.harness, c.model, c.started_at startedAt,
      c.ended_at endedAt, c.turn_count turns
      FROM current_conversations c ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY c.ended_at DESC LIMIT ?`)
      .all(...params) as unknown[];
  }

  search(url: URL): unknown {
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
    return {
      query,
      expression,
      hits: hits.map((hit) => ({
        ...hit,
        evidenceUri: `chatlog://conversation/${hit.contentHash}/turn/${hit.turnIndex}`,
      })),
    };
  }

  async priorAttempts(url: URL): Promise<unknown> {
    const db = this.requireDb();
    const question = url.searchParams.get("q")?.trim() ?? "";
    const limit = boundedInteger(url.searchParams.get("limit"), 6, PRIOR_ATTEMPT_LIMIT);
    const candidateLimit = Math.min(PRIOR_ATTEMPT_LIMIT * 4, Math.max(limit * 4, 20));
    const lexical = (await agentAskLexical(
      db,
      this.root,
      question,
      candidateLimit,
      {
        contentRolesOnly: true,
        groupedSessionLoadLimit: candidateLimit,
      },
    )) as any;
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
    return {
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
  }

  async projectIntelligence(url: URL): Promise<unknown> {
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
    return {
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
  }

  async knowledgeCandidates(url: URL): Promise<unknown> {
    const query = boundedText(url.searchParams.get("q"), KNOWLEDGE_CANDIDATE_QUERY_MAX);
    const requestedType = url.searchParams.get("type")?.trim() ?? "";
    if (
      requestedType &&
      requestedType !== "all" &&
      !KNOWLEDGE_CANDIDATE_TYPES.includes(requestedType as any)
    )
      return Promise.reject(new Error(`unsupported knowledge candidate type: ${requestedType}`));
    const type = requestedType && requestedType !== "all" ? requestedType : null;
    const page = boundedInteger(
      url.searchParams.get("page"),
      1,
      KNOWLEDGE_CANDIDATE_PAGE_MAX,
    );
    const pageSize = boundedInteger(
      url.searchParams.get("pageSize"),
      KNOWLEDGE_CANDIDATE_PAGE_SIZE,
      KNOWLEDGE_CANDIDATE_PAGE_SIZE_MAX,
    );
    const [projectionHash, refinery] = await Promise.all([
      currentProjectionHash(this.root),
      currentArtifact(this.root, "refinery-manifest.json"),
    ]);
    const provenance = refinery ? artifactFreshness(projectionHash, refinery) : null;
    const normalizedQuery = query.toLowerCase();
    const candidates = (Array.isArray(refinery?.artifact.candidates)
      ? refinery.artifact.candidates
      : []
    ).filter((candidate: any) => {
      if (type && candidate.type !== type) return false;
      if (!normalizedQuery) return true;
      return [candidate.id, candidate.title, candidate.signature, candidate.type, candidate.status]
        .some((value) => String(value ?? "").toLowerCase().includes(normalizedQuery));
    });
    const total = candidates.length;
    const offset = (page - 1) * pageSize;
    return {
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
  }

  async knowledgeCandidate(url: URL): Promise<unknown> {
    const id = url.searchParams.get("id")?.trim() ?? "";
    if (!id) return Promise.reject(new Error("knowledge candidate id is required"));
    if (id.length > 200)
      return Promise.reject(new Error("knowledge candidate id exceeds 200 characters"));
    const [projectionHash, refinery] = await Promise.all([
      currentProjectionHash(this.root),
      currentArtifact(this.root, "refinery-manifest.json"),
    ]);
    if (!refinery) return Promise.reject(new Error("knowledge candidate artifact not found"));
    const candidate = (refinery.artifact.candidates ?? []).find(
      (item: any) => item.id === id,
    );
    if (!candidate) return Promise.reject(new Error(`knowledge candidate not found: ${id}`));
    return {
      candidate: candidateDetail(candidate),
      provenance: artifactFreshness(projectionHash, refinery),
      artifact: {
        contentHash:
          typeof refinery.manifest.current?.contentHash === "string"
            ? refinery.manifest.current.contentHash
            : null,
        inputProjectionHash:
          typeof refinery.artifact.inputProjectionHash === "string"
            ? refinery.artifact.inputProjectionHash
            : null,
        recipeHash:
          typeof refinery.artifact.recipeHash === "string"
            ? refinery.artifact.recipeHash
            : null,
        processedAt:
          typeof refinery.manifest.current?.processedAt === "string"
            ? refinery.manifest.current.processedAt
            : null,
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
  }

  async evidence(uri: string): Promise<unknown> {
    const pointer = parseEvidenceUri(uri);
    const current = this.requireDb()
      .query("SELECT 1 FROM current_conversations WHERE content_hash = ?")
      .get(pointer.contentHash);
    if (!current) throw new Error("Evidence not found");
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
    if (!turn) throw new Error("Evidence turn not found");
    return {
      conversationHash: pointer.contentHash,
      sessionId: conversation.id,
      title: conversation.title ?? "",
      domain: conversation.domain ?? "coding",
      project: conversation.project,
      harness: conversation.harness,
      turnIndex: pointer.turnIndex,
      turn,
    };
  }

  async insights(url?: URL): Promise<unknown> {
    const [projectionHash, lean, roles, effectiveness, refinery] = await Promise.all([
      currentProjectionHash(this.root),
      currentArtifact(this.root, "orchestration-lean-manifest.json"),
      currentArtifact(this.root, "orchestration-roles-manifest.json"),
      currentArtifact(this.root, "orchestration-effectiveness-manifest.json"),
      currentArtifact(this.root, "refinery-manifest.json"),
    ]);
    const leanFreshness = lean ? artifactFreshness(projectionHash, lean) : null;
    const rolesFreshness = roles ? artifactFreshness(projectionHash, roles) : null;
    const refineryFreshness = refinery ? artifactFreshness(projectionHash, refinery) : null;
    const currentRoleProfileContentHash =
      typeof roles?.manifest.current?.contentHash === "string"
        ? roles.manifest.current.contentHash
        : null;
    const referencedRoleProfileContentHash =
      typeof effectiveness?.artifact.roleProfileContentHash === "string"
        ? effectiveness.artifact.roleProfileContentHash
        : null;
    const effectivenessFresh =
      Boolean(rolesFreshness?.fresh) &&
      Boolean(currentRoleProfileContentHash) &&
      referencedRoleProfileContentHash === currentRoleProfileContentHash;
    const effectivenessFreshness = effectiveness
      ? {
          fresh: effectivenessFresh,
          status: effectivenessFresh ? ("fresh" as const) : ("stale" as const),
          reason: !rolesFreshness?.fresh
            ? "role-profile-stale"
            : referencedRoleProfileContentHash !== currentRoleProfileContentHash
              ? "role-profile-mismatch"
              : "role-profile-match",
          currentProjectionHash: projectionHash,
          roleProfileContentHash: referencedRoleProfileContentHash,
          currentRoleProfileContentHash,
          artifactInputProjectionHash:
            typeof effectiveness.manifest.current?.inputProjectionHash === "string"
              ? effectiveness.manifest.current.inputProjectionHash
              : null,
        }
      : null;
    return {
      projection: {
        path: "derived/current-hashes.jsonl",
        contentHash: projectionHash,
      },
      orchestration: lean?.artifact.finding
        ? {
            provenance: leanFreshness,
            claim: lean.artifact.finding.claim,
            evidence: boundedEvidence(lean.artifact.finding.evidence),
            decisionBoundary: boundedDecisionBoundary(lean.artifact.finding.decisionBoundary),
            inventories: (lean.artifact.inventories ?? []).map((item: any) => ({
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
            inferredCounts: roles.artifact.inferredCounts,
            profiles: (roles.artifact.profiles ?? []).map((profile: any) => ({
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
      effectiveness: effectiveness?.artifact.ranking
        ? {
            provenance: effectivenessFreshness,
            claim: effectiveness.artifact.ranking.claim,
            winner: effectiveness.artifact.ranking.winner,
            loser: effectiveness.artifact.ranking.loser,
            role: effectiveness.artifact.ranking.role,
            metrics: effectiveness.artifact.ranking.metrics,
            evidence: boundedEvidence(effectiveness.artifact.ranking.evidence),
          }
        : null,
      refinery: refinery
        ? {
            provenance: refineryFreshness,
            threshold: refinery.artifact.threshold,
            policy: refinery.artifact.policy,
            candidateCount: Array.isArray(refinery.artifact.candidates)
              ? refinery.artifact.candidates.length
              : 0,
            candidates:
              url?.searchParams.get("candidateLimit") === "0"
                ? []
                : (refinery.artifact.candidates ?? []).map((candidate: any) => ({
                    id: candidate.id,
                    type: candidate.type,
                    signature: candidate.signature,
                    title: candidate.title,
                    status: candidate.status,
                    frequency: candidate.frequency,
                    evidence: boundedEvidence(
                      candidate.evidence,
                      CANDIDATE_EVIDENCE_LIMIT,
                    ),
                  })),
          }
        : null,
    };
  }

  sources(): Promise<unknown[]> {
    return sourceCatalog(this.root);
  }
}
