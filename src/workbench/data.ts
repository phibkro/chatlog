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
  return [...new Set(terms)]
    .slice(0, 10)
    .map((term) => `"${term.replaceAll('"', '""')}"`)
    .join(" AND ");
}

const INSIGHT_EVIDENCE_LIMIT = 3;
const CANDIDATE_EVIDENCE_LIMIT = 2;

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

  async insights(): Promise<unknown> {
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
            candidates: (refinery.artifact.candidates ?? []).map((candidate: any) => ({
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
  }

  sources(): Promise<unknown[]> {
    return sourceCatalog(this.root);
  }
}
