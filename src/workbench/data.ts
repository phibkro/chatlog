import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseEvidenceUri } from "../evidence-uri";
import { sourceCatalog } from "../source-catalog";
import type { Conversation } from "../types";

function boundedInteger(value: string | null, fallback: number, maximum = 100): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(1, Math.min(maximum, Math.trunc(parsed))) : fallback;
}

function searchExpression(query: string): string {
  const terms = query.toLowerCase().match(/[\p{L}\p{N}_-]{2,}/gu) ?? [];
  if (!terms.length) throw new Error("Search needs at least one concrete word");
  return [...new Set(terms)].slice(0, 10).map((term) => `"${term.replaceAll('"', '""')}"`).join(" AND ");
}

async function currentArtifact(root: string, manifestName: string): Promise<any | null> {
  try {
    const manifest = JSON.parse(await readFile(join(root, "derived", manifestName), "utf8"));
    const path = manifest.current?.artifactPath;
    return path ? JSON.parse(await readFile(join(root, "derived", path), "utf8")) : null;
  } catch (error: any) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
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
      (this.db.query("PRAGMA table_info(current_conversations)").all() as Array<{ name: string }>).map((row) => row.name),
    );
  }

  close(): void {
    this.db?.close();
  }

  private requireDb(): Database {
    if (!this.db) throw new Error(`No Chatlog analysis database at ${join(this.root, "analysis", "chatlog.sqlite")}`);
    return this.db;
  }

  private optionalColumn(name: string, fallback: string): string {
    return this.currentColumns.has(name) ? `c.${name}` : fallback;
  }

  async overview(): Promise<unknown> {
    if (!this.db) return {
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
    const corpus = db.query(`SELECT count(*) sessions, count(DISTINCT project) projects,
      sum(turn_count) turns, min(started_at) firstSession, max(ended_at) lastSession
      FROM current_conversations`).get();
    const harnesses = db.query(`SELECT harness, count(*) sessions, sum(turn_count) turns
      FROM current_conversations GROUP BY harness ORDER BY sessions DESC`).all();
    const domains = this.currentColumns.has("domain")
      ? db.query(`SELECT domain, count(*) sessions FROM current_conversations GROUP BY domain ORDER BY sessions DESC`).all()
      : [{ domain: "coding", sessions: (corpus as any).sessions }];
    const projects = db.query(`SELECT project, count(*) sessions, sum(turn_count) turns,
      max(ended_at) lastSeen FROM current_conversations GROUP BY project
      ORDER BY sessions DESC, turns DESC LIMIT 12`).all();
    const title = this.optionalColumn("title", "''");
    const domain = this.optionalColumn("domain", "'coding'");
    const recent = db.query(`SELECT c.content_hash contentHash, c.id, ${title} title, ${domain} domain,
      c.project, c.harness, c.model, c.started_at startedAt, c.ended_at endedAt, c.turn_count turns
      FROM current_conversations c ORDER BY c.ended_at DESC LIMIT 12`).all();
    const tools = db.query(`SELECT tc.name, count(*) calls, count(DISTINCT tc.content_hash) sessions
      FROM tool_calls tc JOIN current_conversations c USING(content_hash)
      GROUP BY tc.name ORDER BY calls DESC LIMIT 10`).all();
    return { ready: true, root: this.root, corpus, harnesses, domains, projects, recent, tools };
  }

  projects(limitValue: string | null): unknown[] {
    const limit = boundedInteger(limitValue, 50, 200);
    return this.requireDb().query(`SELECT project, count(*) sessions, sum(turn_count) turns,
      min(started_at) firstSeen, max(ended_at) lastSeen
      FROM current_conversations GROUP BY project
      ORDER BY sessions DESC, turns DESC LIMIT ?`).all(limit) as unknown[];
  }

  sessions(url: URL): unknown[] {
    const db = this.requireDb();
    const limit = boundedInteger(url.searchParams.get("limit"), 40, 100);
    const project = url.searchParams.get("project");
    const query = url.searchParams.get("q")?.trim();
    const where: string[] = [];
    const params: Array<string | number> = [];
    if (project) { where.push("c.project = ?"); params.push(project); }
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
    return db.query(`SELECT c.content_hash contentHash, c.id, ${title} title, ${domain} domain,
      ${sourceKind} sourceKind, c.project, c.harness, c.model, c.started_at startedAt,
      c.ended_at endedAt, c.turn_count turns
      FROM current_conversations c ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY c.ended_at DESC LIMIT ?`).all(...params) as unknown[];
  }

  search(url: URL): unknown {
    const db = this.requireDb();
    const query = url.searchParams.get("q")?.trim() ?? "";
    const limit = boundedInteger(url.searchParams.get("limit"), 24, 100);
    const expression = searchExpression(query);
    const title = this.optionalColumn("title", "''");
    const domain = this.optionalColumn("domain", "'coding'");
    const hits = db.query(`SELECT c.content_hash contentHash, c.id, ${title} title, ${domain} domain,
      c.project, c.harness, c.model, c.ended_at endedAt, f.turn_index turnIndex,
      snippet(turns_fts, 0, '<mark>', '</mark>', ' … ', 32) snippet,
      -bm25(turns_fts) score
      FROM turns_fts f JOIN current_conversations c ON c.content_hash=f.content_hash
      WHERE turns_fts MATCH ? ORDER BY bm25(turns_fts) LIMIT ?`).all(expression, limit) as any[];
    return {
      query,
      expression,
      hits: hits.map((hit) => ({
        ...hit,
        evidenceUri: `chatlog://conversation/${hit.contentHash}/turn/${hit.turnIndex}`,
      })),
    };
  }

  async evidence(uri: string): Promise<unknown> {
    const pointer = parseEvidenceUri(uri);
    const conversation = JSON.parse(await readFile(
      join(this.root, "corpus", "objects", pointer.contentHash.slice(0, 2), `${pointer.contentHash}.json`),
      "utf8",
    )) as Conversation;
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

  async insights(): Promise<unknown> {
    const [lean, roles, effectiveness, refinery] = await Promise.all([
      currentArtifact(this.root, "orchestration-lean-manifest.json"),
      currentArtifact(this.root, "orchestration-roles-manifest.json"),
      currentArtifact(this.root, "orchestration-effectiveness-manifest.json"),
      currentArtifact(this.root, "refinery-manifest.json"),
    ]);
    return {
      orchestration: lean?.finding ? {
        claim: lean.finding.claim,
        decisionBoundary: lean.finding.decisionBoundary,
        inventories: (lean.inventories ?? []).map((item: any) => ({
          pole: item.pole,
          signal: item.signal,
          claim: item.claim,
          matchingTurns: item.matchingTurns,
          conversations: item.conversations,
        })),
      } : null,
      roles: roles ? {
        inferredCounts: roles.inferredCounts,
        profiles: (roles.profiles ?? []).map((profile: any) => ({
          role: profile.role,
          highConfidenceSessions: profile.highConfidenceSessions,
          classifiedChoices: profile.classifiedChoices,
          autonomyChoiceRate: profile.autonomyChoiceRate,
          claim: profile.claim,
          signalCounts: profile.signalCounts,
        })),
      } : null,
      effectiveness: effectiveness?.ranking ? {
        claim: effectiveness.ranking.claim,
        winner: effectiveness.ranking.winner,
        loser: effectiveness.ranking.loser,
        role: effectiveness.ranking.role,
        metrics: effectiveness.ranking.metrics,
      } : null,
      refinery: refinery ? {
        threshold: refinery.threshold,
        policy: refinery.policy,
        candidates: (refinery.candidates ?? []).map((candidate: any) => ({
          id: candidate.id,
          type: candidate.type,
          signature: candidate.signature,
          title: candidate.title,
          status: candidate.status,
          frequency: candidate.frequency,
        })),
      } : null,
    };
  }

  sources(): Promise<unknown[]> {
    return sourceCatalog(this.root);
  }
}
