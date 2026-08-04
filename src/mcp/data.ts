import { randomUUID } from "node:crypto";
import { Effect } from "effect";
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { ContextPlane } from "../context-plane";
import { validateCanonicalConversation } from "../conversation-projection";
import { readContextSession } from "../context-session";
import { readEventBatch } from "../event-store";
import { loadDerived, type DerivedConversation } from "../derive";
import { readPublishedInsightMemory } from "../experience-memory-store";
import {
  DEFAULT_CONVERSATION_DOMAIN,
  normalizeConversationDomain,
  normalizeConversationDomains,
} from "../domain";
import { parseEvidenceUri } from "../evidence-uri";
import {
  canonicalRecallPath,
  matchingRecallPath,
  type RecallBudget,
  validateRecallBudget,
} from "../recall-budget";
import { createRecordedRecallRuntime } from "../recall-events";
import { RecallError } from "../recall-runtime";
import { ActiveProjectionGuard, type ProjectionReceipt } from "../source-authority";

const EVIDENCE_CHARACTER_LIMIT = 12_000;
const EVIDENCE_UNAVAILABLE = "evidence not found or not permitted";

export const MCP_TEXT_MAXIMUMS = {
  domainCount: 32,
  domain: 128,
  evidenceUri: 512,
  identity: 256,
  path: 4_096,
  query: 1_000,
  task: 4_000,
} as const;

export class McpDataError extends Error {
  override readonly name = "McpDataError";
}

export interface McpDataFailure {
  readonly _tag: "McpDataFailure";
  readonly error: McpDataError;
}

export type McpDataResult<T> = T | McpDataFailure;

function failure(message: unknown): McpDataFailure {
  return {
    _tag: "McpDataFailure",
    error: new McpDataError(message instanceof Error ? message.message : String(message)),
  };
}

function evidenceUnavailable(): McpDataFailure {
  return failure(EVIDENCE_UNAVAILABLE);
}

export function isMcpDataFailure(value: unknown): value is McpDataFailure {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const candidate = value as { _tag?: unknown; error?: unknown };
  return (
    candidate._tag === "McpDataFailure" &&
    candidate.error instanceof McpDataError &&
    typeof candidate.error.message === "string"
  );
}
export interface DomainPolicyView {
  configuredDomains: string[];
  effectiveDomains: string[];
}

export function parseDomainPolicy(
  value: unknown = process.env.CHATLOG_MCP_DOMAINS ?? "",
): McpDataResult<string[]> {
  if (typeof value !== "string") return failure("domains must be a string");
  if (value.length > MCP_TEXT_MAXIMUMS.domain * MCP_TEXT_MAXIMUMS.domainCount)
    return failure("domains configuration is too large");
  if (value.split(",").some((domain) => domain.trim() === "*"))
    return failure("wildcard domain access is not allowed");
  try {
    return normalizeConversationDomains(value.split(","));
  } catch (error) {
    return failure(error);
  }
}

function boundedLimit(value: unknown, fallback: number, maximum: number): McpDataResult<number> {
  if (value == null) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value))
    return failure("limit must be a finite number");
  return Math.max(1, Math.min(maximum, Math.trunc(value)));
}

function searchExpression(query: unknown): McpDataResult<{ query: string; expression: string }> {
  const bounded = requiredText(query, "query", MCP_TEXT_MAXIMUMS.query);
  if (isMcpDataFailure(bounded)) return bounded;
  const trimmed = bounded.trim();
  const terms = trimmed.toLowerCase().match(/[\p{L}\p{N}_-]{2,}/gu) ?? [];
  if (!terms.length) return failure("search needs at least one concrete word");
  const expression = [...new Set(terms)]
    .slice(0, 10)
    .map((term) => `"${term.replaceAll('"', '""')}"`)
    .join(" AND ");
  return { query: trimmed, expression };
}

function exactProject(value: unknown): McpDataResult<string> {
  return requiredText(value, "project", MCP_TEXT_MAXIMUMS.path);
}

function clampSnippet(value: unknown, maximum = 600): string {
  const text = typeof value === "string" ? value : "";
  return text.length <= maximum ? text : `${text.slice(0, maximum)}…`;
}

type SearchHitRow = {
  contentHash: string;
  turnIndex: number;
  [key: string]: unknown;
};
type BoundedRecallHit = {
  contentHash: string;
  domain: string;
  project: string;
  provider: string;
  harness: string;
  model: string | null;
  cwd: string;
  sourcePath: string;
  endedAt: string | null;
  turnIndex: number;
};

type BoundedRecallSearchResult = {
  query: string;
  hits: Array<BoundedRecallHit & { evidenceUri: string; scopePath: string | null }>;
};

function requiredText(value: unknown, label: string, maximum: number): McpDataResult<string> {
  if (typeof value !== "string") return failure(`${label} must be a string`);
  if (value.length > maximum) return failure(`${label} must be at most ${maximum} characters`);
  if (!value.trim()) return failure(`${label} must be non-empty`);
  return value;
}

export const MCP_RECALL_MAXIMUMS = {
  maxDepth: 4,
  maxBranches: 5,
  maxQueries: 10,
  maxResults: 20,
  maxTokens: 12_000,
  maxLatencyMs: 5_000,
  maxCostUsd: 0,
} as const;

function boundedRecallBudget(value: unknown): McpDataResult<RecallBudget> {
  const validated = validateRecallBudget(value);
  if (!validated.ok) return failure(validated.error.message);
  for (const [key, maximum] of Object.entries(MCP_RECALL_MAXIMUMS)) {
    if (validated.value[key as keyof typeof MCP_RECALL_MAXIMUMS] > maximum)
      return failure(`budget.${key} exceeds the MCP recall maximum of ${maximum}`);
  }
  return validated.value;
}

export class McpData {
  readonly root: string;
  readonly configuredDomains: string[];
  private readonly db: Database | null;
  private readonly currentColumns: Set<string>;
  private readonly projectionGuard: ActiveProjectionGuard;
  private readonly contextPlane: ContextPlane;
  private readonly initializationFailure: McpDataFailure | null;

  constructor(root: string, configuredDomains: McpDataResult<string[]> = parseDomainPolicy()) {
    this.root = resolve(root);
    this.projectionGuard = new ActiveProjectionGuard(this.root);
    this.contextPlane = new ContextPlane(this.root);

    let domains: string[] = [];
    let database: Database | null = null;
    let initializationFailure: McpDataFailure | null = null;
    const columns = new Set<string>();

    if (isMcpDataFailure(configuredDomains)) {
      initializationFailure = configuredDomains;
    } else {
      try {
        domains = normalizeConversationDomains(configuredDomains);
      } catch (error) {
        initializationFailure = failure(error);
      }
    }

    if (!initializationFailure) {
      const databasePath = join(this.root, "analysis", "chatlog.sqlite");
      if (!existsSync(databasePath)) {
        initializationFailure = failure(`No Chatlog analysis database at ${databasePath}`);
      } else {
        try {
          database = new Database(databasePath, { readonly: true, create: false });
          for (const row of database
            .query("PRAGMA table_info(current_conversations)")
            .all() as Array<{
            name: string;
          }>)
            columns.add(row.name);
        } catch (error) {
          database?.close();
          database = null;
          initializationFailure = failure(error);
        }
      }
    }

    this.configuredDomains = domains;
    this.db = database;
    this.currentColumns = columns;
    this.initializationFailure = initializationFailure;
  }

  close(): void {
    this.db?.close();
  }

  private database(): Database | McpDataFailure {
    return this.db ?? this.initializationFailure ?? failure("MCP data is not initialized");
  }

  private effectiveDomains(requested: unknown): McpDataResult<string[]> {
    if (requested == null) return [...this.configuredDomains];
    if (!Array.isArray(requested) || requested.some((item) => typeof item !== "string"))
      return failure("domains must be an array of strings");
    if (requested.length > MCP_TEXT_MAXIMUMS.domainCount)
      return failure(`domains must contain at most ${MCP_TEXT_MAXIMUMS.domainCount} items`);
    if ((requested as string[]).some((domain) => domain.length > MCP_TEXT_MAXIMUMS.domain))
      return failure(`domain must be at most ${MCP_TEXT_MAXIMUMS.domain} characters`);
    if ((requested as string[]).some((domain) => domain.trim() === "*"))
      return failure("wildcard domain access is not allowed");
    let domains: string[];
    try {
      domains = normalizeConversationDomains(requested as string[]);
    } catch (error) {
      return failure(error);
    }
    const denied = domains.filter((domain) => !this.configuredDomains.includes(domain));
    if (denied.length) return failure(`domain access denied: ${denied.join(", ")}`);
    return domains;
  }

  private policy(requested: unknown): McpDataResult<DomainPolicyView> {
    const effectiveDomains = this.effectiveDomains(requested);
    if (isMcpDataFailure(effectiveDomains)) return effectiveDomains;
    return {
      configuredDomains: [...this.configuredDomains],
      effectiveDomains,
    };
  }

  private domainSql(alias = "c"): string {
    return this.currentColumns.has("domain")
      ? `LOWER(COALESCE(NULLIF(TRIM(${alias}.domain), ''), '${DEFAULT_CONVERSATION_DOMAIN}'))`
      : `'${DEFAULT_CONVERSATION_DOMAIN}'`;
  }

  private titleSql(alias = "c"): string {
    return this.currentColumns.has("title") ? `${alias}.title` : "''";
  }

  private assertProjection(expected?: ProjectionReceipt): McpDataResult<ProjectionReceipt> {
    const database = this.database();
    if (isMcpDataFailure(database)) return database;
    try {
      const current = this.projectionGuard.assert(database);
      if (
        expected &&
        (current.manifestSourcesHash !== expected.manifestSourcesHash ||
          current.reconciledAt !== expected.reconciledAt ||
          current.activeSources !== expected.activeSources)
      )
        return failure("active source projection changed while serving the request; retry");
      return current;
    } catch (error) {
      return failure(error);
    }
  }
  private async assertRecallProjectionPins(session: {
    pinnedEvidenceProjectionHash: string;
    pinnedInsightProjectionHash: string;
  }): Promise<McpDataFailure | undefined> {
    const evidence = this.assertProjection();
    if (isMcpDataFailure(evidence)) return evidence;
    const published = await readPublishedInsightMemory(this.root);
    if (!published.ok)
      return failure(
        "published insight projection is unavailable or stale; retry after rebuilding the insight projection",
      );
    if (
      evidence.manifestSourcesHash !== session.pinnedEvidenceProjectionHash ||
      published.value.pointer.outputHash !== session.pinnedInsightProjectionHash
    )
      return failure(
        "context session projection pins no longer match the active evidence or insight projection; reopen the session",
      );
    return undefined;
  }

  search(args: Record<string, unknown>): McpDataResult<unknown> {
    const projection = this.assertProjection();
    if (isMcpDataFailure(projection)) return projection;
    const parsed = searchExpression(args.query);
    if (isMcpDataFailure(parsed)) return parsed;
    const limit = boundedLimit(args.limit, 8, 20);
    if (isMcpDataFailure(limit)) return limit;
    const policy = this.policy(args.domains);
    if (isMcpDataFailure(policy)) return policy;
    const database = this.database();
    if (isMcpDataFailure(database)) return database;
    const placeholders = policy.effectiveDomains.map(() => "?").join(",");
    const domain = this.domainSql();
    const title = this.titleSql();
    let hits: SearchHitRow[];
    try {
      hits = database
        .query(`SELECT c.content_hash contentHash, c.id sessionId, ${title} title,
        ${domain} domain, c.project, c.harness, c.model, c.ended_at endedAt,
        f.turn_index turnIndex, snippet(turns_fts, 0, '[', ']', ' … ', 28) snippet,
        -bm25(turns_fts) score
        FROM turns_fts f JOIN current_conversations c ON c.content_hash=f.content_hash
        JOIN turns t ON t.content_hash=f.content_hash AND t.turn_index=f.turn_index
        WHERE turns_fts MATCH ? AND t.role IN ('user', 'assistant')
        AND ${domain} IN (${placeholders})
        ORDER BY bm25(turns_fts) LIMIT ?`)
        .all(parsed.expression, ...policy.effectiveDomains, limit) as SearchHitRow[];
    } catch (error) {
      return failure(error);
    }
    const reread = this.assertProjection(projection);
    if (isMcpDataFailure(reread)) return reread;
    return {
      query: parsed.query,
      policy,
      hits: hits.map((hit) => ({
        ...hit,
        evidenceUri: `chatlog://conversation/${hit.contentHash}/turn/${hit.turnIndex}`,
      })),
    };
  }

  async evidence(args: Record<string, unknown>): Promise<McpDataResult<unknown>> {
    const projection = this.assertProjection();
    if (isMcpDataFailure(projection)) return projection;
    const policy = this.policy(args.domains);
    if (isMcpDataFailure(policy)) return policy;
    const database = this.database();
    if (isMcpDataFailure(database)) return database;
    const uri = requiredText(args.uri, "uri", MCP_TEXT_MAXIMUMS.evidenceUri);
    if (isMcpDataFailure(uri)) return uri;
    try {
      const pointer = parseEvidenceUri(uri);
      if ("eventId" in pointer) {
        const indexed = database
          .query(`SELECT c.content_hash contentHash, c.id sessionId, c.title,
          ${this.domainSql()} domain, c.project, c.harness, c.model
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
          model: string;
        } | null;
        if (!indexed) return evidenceUnavailable();
        let batch;
        try {
          batch = await readEventBatch(this.root, pointer.batchHash);
        } catch {
          return evidenceUnavailable();
        }
        const event = batch.events.find((candidate) => candidate.eventId === pointer.eventId);
        let indexedDomain: string;
        try {
          indexedDomain = normalizeConversationDomain(indexed.domain);
        } catch {
          return evidenceUnavailable();
        }
        if (!event || !policy.effectiveDomains.includes(indexedDomain))
          return evidenceUnavailable();
        if (event.kind === "model.reasoning.observed" || event.capture.disposition === "opaque")
          return evidenceUnavailable();
        const content = JSON.stringify(event.payload);
        const reread = this.assertProjection(projection);
        if (isMcpDataFailure(reread)) return reread;
        return {
          policy,
          evidenceUri: pointer.uri,
          conversationHash: indexed.contentHash,
          sessionId: indexed.sessionId,
          title: indexed.title,
          domain: indexed.domain,
          project: indexed.project,
          harness: indexed.harness,
          eventId: event.eventId,
          eventKind: event.kind,
          event: {
            sequence: event.sequence,
            occurredAt: event.occurredAt,
            payload: content.slice(0, EVIDENCE_CHARACTER_LIMIT),
            fullLength: content.length,
          },
        };
      }
      const indexed = database
        .query(`SELECT c.content_hash contentHash, a.source_path sourcePath, ${this.domainSql()} domain
        FROM current_conversations c JOIN active_sources a
        ON a.source_path = c.source_path AND a.content_hash = c.content_hash
        WHERE a.content_hash = ?`)
        .get(pointer.contentHash) as {
        contentHash: string;
        sourcePath: string;
        domain: string;
      } | null;
      if (!indexed) return evidenceUnavailable();

      let parsed: unknown;
      try {
        parsed = JSON.parse(
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
        );
      } catch {
        return evidenceUnavailable();
      }

      const conversation = validateCanonicalConversation(parsed, {
        contentHash: pointer.contentHash,
        sourcePath: indexed.sourcePath,
      });
      if (indexed.contentHash !== pointer.contentHash || !conversation)
        return evidenceUnavailable();

      let objectDomain: string;
      try {
        objectDomain = normalizeConversationDomain(
          conversation.domain || DEFAULT_CONVERSATION_DOMAIN,
        );
      } catch {
        return evidenceUnavailable();
      }
      if (
        typeof conversation.contentHash !== "string" ||
        conversation.contentHash.toLowerCase() !== pointer.contentHash ||
        indexed.domain !== objectDomain ||
        !policy.effectiveDomains.includes(objectDomain)
      )
        return evidenceUnavailable();

      const turn = conversation.turns[pointer.turnIndex];
      if (!turn || !["user", "assistant"].includes(turn.role)) return evidenceUnavailable();
      const fullLength = turn.content.length;
      const content = turn.content.slice(0, EVIDENCE_CHARACTER_LIMIT);
      const reread = this.assertProjection(projection);
      if (isMcpDataFailure(reread)) return reread;
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
          ...(turn.at ? { at: turn.at } : {}),
        },
        truncated: fullLength > content.length,
        fullLength,
      };
    } catch (error) {
      return failure(error);
    }
  }

  recentWork(args: Record<string, unknown>): McpDataResult<unknown> {
    const projection = this.assertProjection();
    if (isMcpDataFailure(projection)) return projection;
    const project = exactProject(args.project);
    if (isMcpDataFailure(project)) return project;
    const limit = boundedLimit(args.limit, 8, 20);
    if (isMcpDataFailure(limit)) return limit;
    const policy = this.policy(args.domains);
    if (isMcpDataFailure(policy)) return policy;
    const database = this.database();
    if (isMcpDataFailure(database)) return database;
    const placeholders = policy.effectiveDomains.map(() => "?").join(",");
    const domain = this.domainSql();
    const title = this.titleSql();
    let sessions: unknown[];
    try {
      sessions = database
        .query(`SELECT c.content_hash contentHash, c.id sessionId,
        ${title} title, ${domain} domain, c.project, c.harness, c.model,
        c.started_at startedAt, c.ended_at endedAt, c.turn_count turns
        FROM current_conversations c
        WHERE c.project = ? AND ${domain} IN (${placeholders})
        ORDER BY c.ended_at DESC LIMIT ?`)
        .all(project, ...policy.effectiveDomains, limit);
    } catch (error) {
      return failure(error);
    }
    const reread = this.assertProjection(projection);
    if (isMcpDataFailure(reread)) return reread;
    return { project, policy, sessions };
  }

  async projectBrief(args: Record<string, unknown>): Promise<McpDataResult<unknown>> {
    const projection = this.assertProjection();
    if (isMcpDataFailure(projection)) return projection;
    const project = exactProject(args.project);
    if (isMcpDataFailure(project)) return project;
    const policy = this.policy(args.domains);
    if (isMcpDataFailure(policy)) return policy;
    const database = this.database();
    if (isMcpDataFailure(database)) return database;
    const placeholders = policy.effectiveDomains.map(() => "?").join(",");
    const domain = this.domainSql();
    const params = [project, ...policy.effectiveDomains];
    let overview: {
      sessions?: number | string;
      turns?: number | string;
      firstSeen?: string | null;
      lastSeen?: string | null;
    } | null;
    let harnesses: unknown[];
    let models: unknown[];
    let hashes: Array<{ contentHash: string }>;
    try {
      overview = database
        .query(`SELECT count(*) sessions, sum(c.turn_count) turns,
        min(c.started_at) firstSeen, max(c.ended_at) lastSeen
        FROM current_conversations c
        WHERE c.project = ? AND ${domain} IN (${placeholders})`)
        .get(...params) as typeof overview;
      harnesses = database
        .query(`SELECT c.harness, count(*) sessions, sum(c.turn_count) turns
        FROM current_conversations c
        WHERE c.project = ? AND ${domain} IN (${placeholders})
        GROUP BY c.harness ORDER BY sessions DESC LIMIT 8`)
        .all(...params);
      models = database
        .query(`SELECT c.model, c.harness, count(*) sessions
        FROM current_conversations c
        WHERE c.project = ? AND ${domain} IN (${placeholders})
        GROUP BY c.model, c.harness ORDER BY sessions DESC LIMIT 8`)
        .all(...params);
      hashes = database
        .query(`SELECT c.content_hash contentHash
        FROM current_conversations c
        WHERE c.project = ? AND ${domain} IN (${placeholders})
        ORDER BY c.ended_at DESC LIMIT 8`)
        .all(...params) as Array<{ contentHash: string }>;
    } catch (error) {
      return failure(error);
    }

    const outcomes: Record<string, number> = { success: 0, failure: 0, mixed: 0, unknown: 0 };
    const problems: unknown[] = [];
    const decisions: unknown[] = [];
    let derivedMissing = 0;
    for (const { contentHash } of hashes) {
      let artifact: DerivedConversation;
      try {
        artifact = await loadDerived(this.root, contentHash);
      } catch {
        derivedMissing++;
        continue;
      }
      outcomes[artifact.outcome.status] = (outcomes[artifact.outcome.status] ?? 0) + 1;
      for (const item of artifact.problems.slice(-2)) {
        if (problems.length >= 8) break;
        problems.push({ snippet: clampSnippet(item.snippet), pointer: item.pointer });
      }
      for (const item of artifact.decisions.slice(-2)) {
        if (decisions.length >= 8) break;
        decisions.push({ snippet: clampSnippet(item.snippet), pointer: item.pointer });
      }
    }
    const reread = this.assertProjection(projection);
    if (isMcpDataFailure(reread)) return reread;
    return {
      project,
      policy,
      overview: {
        sessions: Number(overview?.sessions ?? 0),
        turns: Number(overview?.turns ?? 0),
        firstSeen: overview?.firstSeen ?? null,
        lastSeen: overview?.lastSeen ?? null,
      },
      harnesses,
      models,
      recentOutcomes: outcomes,
      derivedMissing,
      recurringProblemEvidence: problems,
      recentDecisionEvidence: decisions,
    };
  }
  async deliverContext(args: Record<string, unknown>): Promise<McpDataResult<unknown>> {
    const contextSessionId = requiredText(
      args.contextSessionId,
      "contextSessionId",
      MCP_TEXT_MAXIMUMS.identity,
    );
    if (isMcpDataFailure(contextSessionId)) return contextSessionId;
    const session = await readContextSession(this.root, contextSessionId);
    if (!session.ok) return failure(session.error.message);
    const domainPolicy = this.policy(session.value.domainPolicy);
    if (isMcpDataFailure(domainPolicy)) return domainPolicy;
    if (
      domainPolicy.effectiveDomains.length !== 1 ||
      domainPolicy.effectiveDomains[0] !== session.value.domainPolicy[0]
    )
      return failure("context delivery requires one policy-visible pinned session domain");
    const task = requiredText(args.task, "task", MCP_TEXT_MAXIMUMS.task);
    if (isMcpDataFailure(task)) return task;
    const query = requiredText(args.query, "query", MCP_TEXT_MAXIMUMS.query);
    if (isMcpDataFailure(query)) return query;
    try {
      const delivered = await this.contextPlane.deliverSession({
        contextSessionId,
        task,
        query,
        deliveryMode: "tool-recall",
        receiptEvidence: "tool-result",
        receipt: { transport: "mcp-tool-result" },
      });
      return delivered.ok ? delivered.value : failure(delivered.error.message);
    } catch (error) {
      return failure(error);
    }
  }

  private boundedRecallSearch(
    session: {
      projectIdentity: string;
      target: { provider: string; harness: string; model: string | null };
      path: string | null;
    },
    queryValue: unknown,
    domain: string,
    limit: number,
  ): McpDataResult<BoundedRecallSearchResult> {
    const projection = this.assertProjection();
    if (isMcpDataFailure(projection)) return projection;
    const parsed = searchExpression(queryValue);
    if (isMcpDataFailure(parsed)) return parsed;
    const canonicalSessionPath = session.path === null ? null : canonicalRecallPath(session.path);
    const canonicalColumn = (column: string): string =>
      `(${column} GLOB '/*' AND ${column} NOT LIKE '%/./%' AND ${column} NOT LIKE '%/../%' AND ${column} NOT LIKE '%/.' AND ${column} NOT LIKE '%/..')`;
    const pathClause =
      canonicalSessionPath === null
        ? "(NULLIF(c.cwd, '') IS NULL AND NULLIF(c.source_path, '') IS NULL)"
        : canonicalSessionPath === undefined
          ? "1 = 0"
          : `(
              (${canonicalColumn("c.cwd")} AND (c.cwd = ? OR c.cwd LIKE ? ESCAPE '\\'))
              OR
              (${canonicalColumn("c.source_path")} AND
                (c.source_path = ? OR c.source_path LIKE ? ESCAPE '\\'))
            )`;
    const pathParameters =
      canonicalSessionPath === null || canonicalSessionPath === undefined
        ? []
        : (() => {
            const escaped = canonicalSessionPath
              .replaceAll("\\", "\\\\")
              .replaceAll("%", "\\%")
              .replaceAll("_", "\\_");
            const descendantPattern = canonicalSessionPath === "/" ? "/%" : `${escaped}/%`;
            return [
              canonicalSessionPath,
              descendantPattern,
              canonicalSessionPath,
              descendantPattern,
            ];
          })();
    const database = this.database();
    if (isMcpDataFailure(database)) return database;
    let hits: BoundedRecallHit[];
    try {
      hits = database
        .query(
          `SELECT c.content_hash contentHash, c.project project, c.provider provider,
          c.harness harness, c.model model, c.cwd cwd, c.source_path sourcePath,
          ${this.domainSql()} domain, c.ended_at endedAt,
          f.turn_index turnIndex, snippet(turns_fts, 0, '[', ']', ' … ', 28) snippet,
          -bm25(turns_fts) score
          FROM turns_fts f JOIN current_conversations c ON c.content_hash = f.content_hash
          JOIN turns t ON t.content_hash = f.content_hash AND t.turn_index = f.turn_index
          WHERE turns_fts MATCH ? AND t.role IN ('user', 'assistant')
          AND ${this.domainSql()} = ?
          AND c.project = ?
          AND LOWER(c.provider) = LOWER(?)
          AND LOWER(c.harness) = LOWER(?)
          AND (? IS NULL OR c.model = ?)
          AND ${pathClause}
          ORDER BY bm25(turns_fts) LIMIT ?`,
        )
        .all(
          parsed.expression,
          domain,
          session.projectIdentity,
          session.target.provider,
          session.target.harness,
          session.target.model,
          session.target.model,
          ...pathParameters,
          limit,
        ) as BoundedRecallHit[];
    } catch (error) {
      return failure(error);
    }
    const reread = this.assertProjection(projection);
    if (isMcpDataFailure(reread)) return reread;
    const scopedHits = hits.flatMap((hit) => {
      const scopePath = matchingRecallPath(canonicalSessionPath, hit.cwd, hit.sourcePath);
      return scopePath === undefined
        ? []
        : [
            {
              ...hit,
              scopePath,
              evidenceUri: `chatlog://conversation/${hit.contentHash}/turn/${hit.turnIndex}`,
            },
          ];
    });
    return {
      query: parsed.query,
      hits: scopedHits,
    };
  }

  async boundedRecall(args: Record<string, unknown>): Promise<McpDataResult<unknown>> {
    const contextSessionId = requiredText(
      args.contextSessionId,
      "contextSessionId",
      MCP_TEXT_MAXIMUMS.identity,
    );
    if (isMcpDataFailure(contextSessionId)) return contextSessionId;
    const query = requiredText(args.query, "query", MCP_TEXT_MAXIMUMS.query);
    if (isMcpDataFailure(query)) return query;
    const loaded = await readContextSession(this.root, contextSessionId);
    if (!loaded.ok) return failure(loaded.error.message);
    const session = loaded.value;
    const pins = await this.assertRecallProjectionPins(session);
    if (pins) return pins;
    const invocationId =
      args.invocationId === undefined
        ? randomUUID()
        : requiredText(args.invocationId, "invocationId", MCP_TEXT_MAXIMUMS.identity);
    if (isMcpDataFailure(invocationId)) return invocationId;
    const policy = this.policy(session.domainPolicy);
    if (isMcpDataFailure(policy)) return policy;
    if (policy.effectiveDomains.length !== 1)
      return failure("bounded recall requires one policy-visible domain");
    const effectiveDomain = policy.effectiveDomains[0];
    if (!effectiveDomain) return failure("bounded recall requires one policy-visible domain");
    const budget = boundedRecallBudget(args.budget);
    if (isMcpDataFailure(budget)) return budget;

    let callbackFailure: McpDataFailure | undefined;
    const runtime = createRecordedRecallRuntime(this.root, {
      beforeFinalize: async ({ session: currentSession }) => {
        if (callbackFailure !== undefined)
          return new RecallError("finalization-error", callbackFailure.error.message, {
            phase: "debit",
          });
        const rechecked = await this.assertRecallProjectionPins(currentSession);
        return rechecked === undefined
          ? undefined
          : new RecallError("finalization-error", rechecked.error.message, { phase: "debit" });
      },
      adapters: [
        {
          id: "chatlog-lexical",
          run: async (context) => {
            const rechecked = await this.assertRecallProjectionPins(session);
            if (rechecked) {
              callbackFailure = rechecked;
              return {
                ok: false as const,
                branchId: context.branchId,
                query: context.query,
                failure: {
                  code: "provider-error" as const,
                  branchId: context.branchId,
                  query: context.query,
                  message: rechecked.error.message,
                  observedAt: Date.now(),
                },
              };
            }
            const searched = this.boundedRecallSearch(
              session,
              context.query,
              effectiveDomain,
              context.budget.maxResults,
            );
            if (isMcpDataFailure(searched)) {
              callbackFailure = searched;
              return {
                ok: false as const,
                branchId: context.branchId,
                query: context.query,
                failure: {
                  code: "provider-error" as const,
                  branchId: context.branchId,
                  query: context.query,
                  message: searched.error.message,
                  observedAt: Date.now(),
                },
              };
            }
            return {
              ok: true as const,
              branchId: context.branchId,
              query: searched.query,
              evidence: searched.hits.map((hit) => ({
                id: hit.evidenceUri,
                reference: hit.evidenceUri,
                support: [hit.contentHash],
                counterevidence: [],
                scope: {
                  user: null,
                  organization: null,
                  domain: hit.domain,
                  project: hit.project,
                  repository: hit.project,
                  provider: hit.provider,
                  harness: hit.harness,
                  model: hit.model,
                  path: hit.scopePath,
                  tool: null,
                  itemPermissions: [],
                },
                authority: {
                  kind: "observed" as const,
                  actor: "provider" as const,
                  reference: hit.evidenceUri,
                },
                observedAt: hit.endedAt ?? undefined,
              })),
              usage: { maxResults: searched.hits.length },
            };
          },
        },
      ],
    });
    try {
      const result = await Effect.runPromise(
        runtime.recall({
          invocationId,
          contextSessionId,
          query,
          scope: {
            domain: effectiveDomain,
            project: session.projectIdentity,
            provider: session.target.provider,
            harness: session.target.harness,
            model: session.target.model,
            path: session.path,
          },
          budget,
          minimumEvidence: 1,
        }),
      );
      return callbackFailure ?? result;
    } catch (error) {
      return failure(error);
    }
  }
}
