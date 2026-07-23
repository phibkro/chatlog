import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { loadDerived, type DerivedConversation } from "../derive";
import {
  DEFAULT_CONVERSATION_DOMAIN,
  normalizeConversationDomain,
  normalizeConversationDomains,
} from "../domain";
import { parseEvidenceUri } from "../evidence-uri";
import type { Conversation } from "../types";

const EVIDENCE_CHARACTER_LIMIT = 12_000;
const EVIDENCE_UNAVAILABLE = "evidence not found or not permitted";

export interface DomainPolicyView {
  configuredDomains: string[];
  effectiveDomains: string[];
}

export function parseDomainPolicy(value = process.env.CHATLOG_MCP_DOMAINS ?? ""): string[] {
  if (value.split(",").some((domain) => domain.trim() === "*"))
    throw new Error("wildcard domain access is not allowed");
  return normalizeConversationDomains(value.split(","));
}

function boundedLimit(value: unknown, fallback: number, maximum: number): number {
  if (value == null) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error("limit must be a finite number");
  return Math.max(1, Math.min(maximum, Math.trunc(value)));
}

function searchExpression(query: unknown): { query: string; expression: string } {
  if (typeof query !== "string") throw new Error("query must be a string");
  const trimmed = query.trim();
  const terms = trimmed.toLowerCase().match(/[\p{L}\p{N}_-]{2,}/gu) ?? [];
  if (!terms.length) throw new Error("search needs at least one concrete word");
  const expression = [...new Set(terms)]
    .slice(0, 10)
    .map((term) => `"${term.replaceAll('"', '""')}"`)
    .join(" AND ");
  return { query: trimmed, expression };
}

function exactProject(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new Error("project must be an exact non-empty path");
  return value;
}

function clampSnippet(value: unknown, maximum = 600): string {
  const text = typeof value === "string" ? value : "";
  return text.length <= maximum ? text : `${text.slice(0, maximum)}…`;
}

export class McpData {
  readonly root: string;
  readonly configuredDomains: string[];
  private readonly db: Database;
  private readonly currentColumns: Set<string>;

  constructor(root: string, configuredDomains = parseDomainPolicy()) {
    this.root = resolve(root);
    this.configuredDomains = normalizeConversationDomains(configuredDomains);
    const databasePath = join(this.root, "analysis", "chatlog.sqlite");
    if (!existsSync(databasePath)) throw new Error(`No Chatlog analysis database at ${databasePath}`);
    this.db = new Database(databasePath, { readonly: true, create: false });
    this.currentColumns = new Set(
      (this.db.query("PRAGMA table_info(current_conversations)").all() as Array<{ name: string }>).map((row) => row.name),
    );
  }

  close(): void {
    this.db.close();
  }

  private effectiveDomains(requested: unknown): string[] {
    if (requested == null) return [...this.configuredDomains];
    if (!Array.isArray(requested) || requested.some((item) => typeof item !== "string"))
      throw new Error("domains must be an array of strings");
    if ((requested as string[]).some((domain) => domain.trim() === "*"))
      throw new Error("wildcard domain access is not allowed");
    const domains = normalizeConversationDomains(requested as string[]);
    const denied = domains.filter((domain) => !this.configuredDomains.includes(domain));
    if (denied.length) throw new Error(`domain access denied: ${denied.join(", ")}`);
    return domains;
  }

  private policy(requested: unknown): DomainPolicyView {
    return {
      configuredDomains: [...this.configuredDomains],
      effectiveDomains: this.effectiveDomains(requested),
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

  search(args: Record<string, unknown>): unknown {
    const { query, expression } = searchExpression(args.query);
    const limit = boundedLimit(args.limit, 8, 20);
    const policy = this.policy(args.domains);
    const placeholders = policy.effectiveDomains.map(() => "?").join(",");
    const domain = this.domainSql();
    const title = this.titleSql();
    const hits = this.db.query(`SELECT c.content_hash contentHash, c.id sessionId, ${title} title,
      ${domain} domain, c.project, c.harness, c.model, c.ended_at endedAt,
      f.turn_index turnIndex, snippet(turns_fts, 0, '[', ']', ' … ', 28) snippet,
      -bm25(turns_fts) score
      FROM turns_fts f JOIN current_conversations c ON c.content_hash=f.content_hash
      JOIN turns t ON t.content_hash=f.content_hash AND t.turn_index=f.turn_index
      WHERE turns_fts MATCH ? AND t.role IN ('user', 'assistant')
      AND ${domain} IN (${placeholders})
      ORDER BY bm25(turns_fts) LIMIT ?`).all(expression, ...policy.effectiveDomains, limit) as any[];
    return {
      query,
      policy,
      hits: hits.map((hit) => ({
        ...hit,
        evidenceUri: `chatlog://conversation/${hit.contentHash}/turn/${hit.turnIndex}`,
      })),
    };
  }

  async evidence(args: Record<string, unknown>): Promise<unknown> {
    const pointer = parseEvidenceUri(args.uri);
    const policy = this.policy(args.domains);
    const indexed = this.db.query(`SELECT ${this.domainSql()} domain
      FROM current_conversations c WHERE c.content_hash = ?`).get(pointer.contentHash) as
      { domain: string } | null;
    if (!indexed) throw new Error(EVIDENCE_UNAVAILABLE);

    let conversation: Conversation;
    try {
      conversation = JSON.parse(await readFile(
        join(this.root, "corpus", "objects", pointer.contentHash.slice(0, 2), `${pointer.contentHash}.json`),
        "utf8",
      )) as Conversation;
    } catch {
      throw new Error(EVIDENCE_UNAVAILABLE);
    }

    let objectDomain: string;
    try {
      objectDomain = normalizeConversationDomain(
        conversation.domain || DEFAULT_CONVERSATION_DOMAIN,
      );
    } catch {
      throw new Error(EVIDENCE_UNAVAILABLE);
    }
    if (
      typeof conversation.contentHash !== "string"
      || conversation.contentHash.toLowerCase() !== pointer.contentHash
      || indexed.domain !== objectDomain
      || !policy.effectiveDomains.includes(objectDomain)
    ) throw new Error(EVIDENCE_UNAVAILABLE);

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
        ...(turn.at ? { at: turn.at } : {}),
      },
      truncated: fullLength > content.length,
      fullLength,
    };
  }

  recentWork(args: Record<string, unknown>): unknown {
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

  async projectBrief(args: Record<string, unknown>): Promise<unknown> {
    const project = exactProject(args.project);
    const policy = this.policy(args.domains);
    const placeholders = policy.effectiveDomains.map(() => "?").join(",");
    const domain = this.domainSql();
    const params = [project, ...policy.effectiveDomains];
    const overview = this.db.query(`SELECT count(*) sessions, sum(c.turn_count) turns,
      min(c.started_at) firstSeen, max(c.ended_at) lastSeen
      FROM current_conversations c
      WHERE c.project = ? AND ${domain} IN (${placeholders})`).get(...params) as any;
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
      ORDER BY c.ended_at DESC LIMIT 8`).all(...params) as Array<{ contentHash: string }>;

    const outcomes: Record<string, number> = { success: 0, failure: 0, mixed: 0, unknown: 0 };
    const problems: unknown[] = [];
    const decisions: unknown[] = [];
    let derivedMissing = 0;
    for (const { contentHash } of hashes) {
      let artifact: DerivedConversation;
      try { artifact = await loadDerived(this.root, contentHash); }
      catch {
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
}
