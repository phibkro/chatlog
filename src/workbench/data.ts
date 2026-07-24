import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseEvidenceUri } from "../evidence-uri";
import { listImportReceipts } from "../import-receipts";
import { sourceCatalog } from "../source-catalog";
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
} from "../derived-authority";
import { loadWorkflowOutcomes } from "../workflow-outcomes";
import { loadWorkflowPatterns } from "../workflow-patterns";

function boundedInteger(value: string | null, fallback: number, maximum = 100): number {
  if (value == null || value.trim() === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(1, Math.min(maximum, Math.trunc(parsed))) : fallback;
}

function searchExpression(query: string): string {
  const terms = query.toLowerCase().match(/[\p{L}\p{N}_-]{2,}/gu) ?? [];
  if (!terms.length) throw new Error("Search needs at least one concrete word");
  return [...new Set(terms)].slice(0, 10).map((term) => `"${term.replaceAll('"', '""')}"`).join(" AND ");
}

export function boundedOutcomeComparison(comparison: any): unknown {
  if (!comparison) return null;
  const scope = comparison.scope ?? {};
  return {
    kind: comparison.kind,
    occurredAt: comparison.occurredAt,
    status: comparison.status,
    reasons: comparison.reasons,
    scope: {
      projectCount: Array.isArray(scope.projects)
        ? scope.projects.length
        : scope.projectCount,
      maximumWindowDays: scope.maximumWindowDays,
      observedWindowHours: scope.observedWindowHours,
      preStart: scope.preStart,
      postEnd: scope.postEnd,
    },
    coverage: comparison.coverage,
    pre: comparison.pre,
    post: comparison.post,
    deltas: comparison.deltas,
    interpretation: comparison.interpretation,
  };
}

export function boundedWorkflowPattern(pattern: any): unknown {
  if (!pattern) return null;
  const coverage = pattern.coverage ?? {};
  const metric = (value: any) => ({
    orientation: value?.orientation,
    samples: value?.samples,
    favorable: value?.favorable,
    unfavorable: value?.unfavorable,
    unchanged: value?.unchanged,
    medianDelta: value?.medianDelta,
  });
  return {
    kind: pattern.kind,
    signal: pattern.signal,
    role: pattern.role,
    title: pattern.title,
    claim: pattern.claim,
    boundaryEffect: pattern.boundaryEffect,
    coverage: {
      eventMemberships: coverage.eventMemberships,
      sharedEventMemberships: coverage.sharedEventMemberships,
      distinctEpisodes: coverage.distinctEpisodes,
      distinctDays: coverage.distinctDays,
      distinctFormulations: coverage.distinctFormulations,
      collapsedSameEpisodeMemberships:
        coverage.collapsedSameEpisodeMemberships,
      projectCount: Array.isArray(coverage.projects)
        ? coverage.projects.length
        : coverage.projectCount,
      harnesses: coverage.harnesses,
      firstSeenAt: coverage.firstSeenAt,
      lastSeenAt: coverage.lastSeenAt,
      minimumDistinctEpisodes: coverage.minimumDistinctEpisodes,
      minimumDistinctDays: coverage.minimumDistinctDays,
    },
    sequence: {
      relations: pattern.sequence?.relations,
      latestRelation: pattern.sequence?.latestRelation,
      timeline: (pattern.sequence?.timeline ?? []).slice(-12).map(
        (item: any) => ({
          occurredAt: item.occurredAt,
          relation: item.relation,
        }),
      ),
    },
    outcomes: {
      status: pattern.outcomes?.status,
      observedEpisodes: pattern.outcomes?.observedEpisodes,
      sparseEpisodes: pattern.outcomes?.sparseEpisodes,
      minimumObservedEpisodes: pattern.outcomes?.minimumObservedEpisodes,
      reasons: pattern.outcomes?.reasons,
      metrics: {
        completionRate: metric(pattern.outcomes?.metrics?.completionRate),
        frictionRate: metric(pattern.outcomes?.metrics?.frictionRate),
        reworkRate: metric(pattern.outcomes?.metrics?.reworkRate),
      },
      interpretation: {
        claim: pattern.outcomes?.interpretation?.claim,
        causal: false,
      },
    },
    examples: (pattern.examples ?? []).slice(0, 4).map((example: any) => ({
      occurredAt: example.occurredAt,
      relation: example.relation,
      evidence: (example.evidence ?? []).slice(0, 1).map(
        (item: any) => ({ pointer: item.pointer }),
      ),
    })),
  };
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

  private assertProjection(expected?: ProjectionReceipt): ProjectionReceipt {
    const current = this.projectionGuard.assert(this.requireDb());
    if (
      expected
      && (
        current.manifestSourcesHash !== expected.manifestSourcesHash
        || current.reconciledAt !== expected.reconciledAt
        || current.activeSources !== expected.activeSources
      )
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
    const projection = this.assertProjection();
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
    const result = { ready: true, root: this.root, corpus, harnesses, domains, projects, recent, tools };
    this.assertProjection(projection);
    return result;
  }

  projects(limitValue: string | null): unknown[] {
    const projection = this.assertProjection();
    const limit = boundedInteger(limitValue, 50, 200);
    const result = this.requireDb().query(`SELECT project, count(*) sessions, sum(turn_count) turns,
      min(started_at) firstSeen, max(ended_at) lastSeen
      FROM current_conversations GROUP BY project
      ORDER BY sessions DESC, turns DESC LIMIT ?`).all(limit) as unknown[];
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
    const result = db.query(`SELECT c.content_hash contentHash, c.id, ${title} title, ${domain} domain,
      ${sourceKind} sourceKind, c.project, c.harness, c.model, c.started_at startedAt,
      c.ended_at endedAt, c.turn_count turns
      FROM current_conversations c ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY c.ended_at DESC LIMIT ?`).all(...params) as unknown[];
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
    const hits = db.query(`SELECT c.content_hash contentHash, c.id, ${title} title, ${domain} domain,
      c.project, c.harness, c.model, c.ended_at endedAt, f.turn_index turnIndex,
      snippet(turns_fts, 0, '<mark>', '</mark>', ' … ', 32) snippet,
      -bm25(turns_fts) score
      FROM turns_fts f JOIN current_conversations c ON c.content_hash=f.content_hash
      WHERE turns_fts MATCH ? ORDER BY bm25(turns_fts) LIMIT ?`).all(expression, limit) as any[];
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

  async evidence(uri: string): Promise<unknown> {
    const projection = this.assertProjection();
    const pointer = parseEvidenceUri(uri);
    const current = this.requireDb().query(
      "SELECT 1 FROM current_conversations WHERE content_hash = ?",
    ).get(pointer.contentHash);
    if (!current) throw new Error("Evidence not found");
    const conversation = JSON.parse(await readFile(
      join(this.root, "corpus", "objects", pointer.contentHash.slice(0, 2), `${pointer.contentHash}.json`),
      "utf8",
    )) as Conversation;
    const turn = conversation.turns[pointer.turnIndex];
    if (!turn) throw new Error("Evidence turn not found");
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

  async insights(): Promise<unknown> {
    const projection = this.assertProjection();
    const derivedProjection = await assertDerivedProjection(this.root);
    const [leanCurrent, rolesCurrent, refineryCurrent, workflowCurrent] = await Promise.all([
      loadProjectionBoundArtifact(this.root, "orchestration-lean-manifest.json", { optional: true, projection: derivedProjection }),
      loadProjectionBoundArtifact(this.root, "orchestration-roles-manifest.json", { optional: true, projection: derivedProjection }),
      loadProjectionBoundArtifact(this.root, "refinery-manifest.json", {
        optional: true,
        projection: derivedProjection,
        inputProjectionHash: derivedProjection.structureProjectionHash,
      }),
      loadProjectionBoundArtifact(this.root, "workflow-evolution-manifest.json", {
        optional: true,
        projection: derivedProjection,
      }),
    ]);
    const effectivenessCurrent = rolesCurrent
      ? await loadCurrentDerivedArtifact(
        this.root,
        "orchestration-effectiveness-manifest.json",
        { optional: true },
      )
      : null;
    const workflowOutcomes = workflowCurrent
      ? await loadWorkflowOutcomes(this.root, {
        optional: true,
        projection: derivedProjection,
      })
      : null;
    const workflowPatterns = workflowOutcomes
      ? await loadWorkflowPatterns(this.root, {
        optional: true,
        projection: derivedProjection,
      })
      : null;
    if (
      effectivenessCurrent
      && effectivenessCurrent.artifact?.roleProfileContentHash !== rolesCurrent?.contentHash
    ) {
      throw new DerivedProjectionDriftError(
        "orchestration-effectiveness-manifest.json: current artifact does not match the active role projection",
      );
    }
    const lean = leanCurrent?.artifact;
    const roles = rolesCurrent?.artifact;
    const effectiveness = effectivenessCurrent?.artifact;
    const refinery = refineryCurrent?.artifact;
    const workflow = workflowCurrent?.artifact;
    const boundedWorkflowEvent = (event: any) => event ? ({
      id: event.id,
      kind: event.kind,
      occurredAt: event.occurredAt,
      statement: event.statement,
      confidence: event.confidence,
      lineage: event.lineage,
      signals: event.signals,
      policyDelta: event.policyDelta,
      evidence: (event.evidence ?? []).slice(0, 3),
    }) : null;
    const result = {
      workflowPatterns: workflowPatterns ? {
        summary: workflowPatterns.summary,
        methodology: {
          identity: workflowPatterns.methodology?.identity,
          repetition: workflowPatterns.methodology?.repetition,
          relations: workflowPatterns.methodology?.relations,
          boundaryEffect: workflowPatterns.methodology?.boundaryEffect,
          outcomes: workflowPatterns.methodology?.outcomes,
          causality: workflowPatterns.methodology?.causality,
        },
        patterns: (workflowPatterns.patterns ?? [])
          .slice(0, 30)
          .map(boundedWorkflowPattern),
      } : null,
      workflowOutcomes: workflowOutcomes ? {
        summary: workflowOutcomes.summary,
        methodology: {
          window: workflowOutcomes.methodology?.window,
          scope: workflowOutcomes.methodology?.scope,
          causality: workflowOutcomes.methodology?.causality,
        },
        approvalGateTracer: boundedOutcomeComparison(
          workflowOutcomes.approvalGateTracer,
        ),
        comparisons: (workflowOutcomes.comparisons ?? [])
          .slice(-30)
          .reverse()
          .map(boundedOutcomeComparison),
      } : null,
      workflowEvolution: workflow ? {
        summary: workflow.summary,
        methodology: {
          grouping: workflow.methodology?.grouping,
          crossSessionBoundary: workflow.methodology?.crossSessionBoundary,
          causalBoundary: workflow.methodology?.causalBoundary,
        },
        approvalGateTracer: boundedWorkflowEvent(workflow.tracers?.approvalGate),
        events: (workflow.events ?? []).slice(-40).reverse().map(boundedWorkflowEvent),
      } : null,
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
    this.assertProjection(projection);
    const finalDerivedProjection = await assertDerivedProjection(this.root);
    if (
      finalDerivedProjection.contentHash !== derivedProjection.contentHash
      || finalDerivedProjection.structureProjectionHash !== derivedProjection.structureProjectionHash
    )
      throw new DerivedProjectionDriftError("derived projection changed while serving the request; retry");
    return result;
  }

  sources(): Promise<unknown[]> {
    return sourceCatalog(this.root);
  }

  receipts(limitValue: string | null): Promise<unknown[]> {
    return listImportReceipts(this.root, boundedInteger(limitValue, 20, 100));
  }
}
