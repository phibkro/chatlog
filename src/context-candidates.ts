import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { matchingRecallPath, canonicalRecallPath } from "./recall-budget";
import { readPublishedInsightMemory } from "./experience-memory-store";
import { ActiveProjectionGuard } from "./source-authority";
import type {
  ContextCandidate,
  ContextItemKind,
  ContextRequest,
  ContextScoreComponents,
} from "./context-types";
import type { InsightRevision } from "./insights";

export interface ContextEvidenceRow {
  eventId: string;
  batchHash: string;
  kind: string;
  payload: string;
  occurredAt: string | null;
  project: string;
  cwd: string;
  sourcePath?: string | null;
  harness: string;
  model: string | null;
  domain: string;
}

export type ContextCandidateCollectionResult =
  | {
      ok: true;
      value: {
        candidates: ContextCandidate[];
        insightProjectionHash: string;
        evidenceProjectionHash: string;
      };
    }
  | {
      ok: false;
      error: {
        code: "source-unavailable" | "projection-drift";
        message: string;
      };
    };

function terms(value: string): Set<string> {
  return new Set(value.toLowerCase().match(/[\p{L}\p{N}_-]{2,}/gu) ?? []);
}

function score(
  content: string,
  request: ContextRequest,
  kind: ContextItemKind,
): ContextScoreComponents {
  const wanted = terms(`${request.task} ${request.query}`);
  const available = terms(content);
  const matches = [...wanted].filter((term) => available.has(term)).length;
  const lexical = wanted.size === 0 ? 0 : matches / wanted.size;
  const procedure = kind === "procedure" ? 1 : 0;
  const total = lexical * 4 + procedure;
  return { lexical, semantic: 0, temporal: 0, procedure, total };
}

function withTemporalScore(
  components: ContextScoreComponents,
  observedAt: string,
  now: string,
): ContextScoreComponents {
  const elapsedDays = Math.max(0, Date.parse(now) - Date.parse(observedAt)) / 86_400_000;
  const temporal = Number.isFinite(elapsedDays) ? 1 / (1 + elapsedDays / 30) : 0;
  return { ...components, temporal, total: components.total + temporal };
}

function estimates(
  content: string,
): Pick<
  ContextCandidate,
  "estimatedTokens" | "estimatedCharacters" | "estimatedLatencyMs" | "estimatedCostUsd"
> {
  return {
    estimatedTokens: Math.ceil(new TextEncoder().encode(content).byteLength / 4),
    estimatedCharacters: content.length,
    estimatedLatencyMs: 0,
    estimatedCostUsd: 0,
  };
}

function insightKind(revision: InsightRevision): ContextItemKind {
  if (revision.kind === "procedure") return "procedure";
  if (revision.kind === "current-state") return "current-state";
  return "insight";
}

function insightAuthority(revision: InsightRevision): string {
  const ranking = [
    "authoritative-document",
    "measured-evaluation",
    "human-review",
    "human-assertion",
    "deterministic-derivation",
    "source-observation",
    "model-proposal",
    "assumption",
  ];
  const available = new Set([revision.origin.kind, ...revision.authority.map((item) => item.kind)]);
  return (
    ranking.find((kind) => available.has(kind as InsightRevision["origin"]["kind"])) ??
    revision.origin.kind
  );
}

export function candidatesFromInsightRevisions(
  revisions: readonly InsightRevision[],
  request: ContextRequest,
): ContextCandidate[] {
  return revisions
    .filter((revision) => revision.status === "active")
    .map((revision) => {
      const kind = insightKind(revision);
      const content = revision.procedure
        ? `${revision.proposition}\nProcedure: ${revision.procedure}`
        : revision.proposition;
      return {
        id: revision.revisionId,
        kind,
        content,
        evidenceReferences: [...revision.supportEvidence],
        selectionReason: "governed active insight matched the requested task and scope",
        scores: withTemporalScore(score(content, request, kind), revision.observedAt, request.now),
        scope: { ...revision.scope },
        validTime: { ...revision.validTime },
        authority: insightAuthority(revision),
        advisory: true,
        riskClass: revision.riskClass,
        ...estimates(content),
      };
    });
}

export function candidatesFromEvidenceRows(
  rows: readonly ContextEvidenceRow[],
  request: ContextRequest,
): ContextCandidate[] {
  return rows.flatMap((row) => {
    const observedAt = row.occurredAt ?? request.now;
    const matchedPath = matchingRecallPath(request.scope.path, row.cwd, row.sourcePath);
    if (matchedPath === undefined) return [];
    return [
      {
        id: row.eventId,
        kind: "evidence",
        content: row.payload,
        evidenceReferences: [`chatlog://event/${row.batchHash}/${row.eventId}`],
        selectionReason: `canonical ${row.kind} event matched the requested task`,
        scores: withTemporalScore(score(row.payload, request, "evidence"), observedAt, request.now),
        scope: {
          user: null,
          organization: null,
          project: row.project || null,
          repository: row.project || null,
          path: matchedPath,
          harness: row.harness || null,
          model: row.model,
          tool: null,
          domain: row.domain,
        },
        validTime: { start: observedAt, end: null },
        authority: "source-observation",
        advisory: false,
        riskClass: "low",
        ...estimates(row.payload),
      },
    ];
  });
}

function canonicalPathSql(column: string): string {
  return `(${column} GLOB '/*' AND ${column} NOT LIKE '%/./%' AND ${column} NOT LIKE '%/../%' AND ${column} NOT LIKE '%/.' AND ${column} NOT LIKE '%/..')`;
}

function evidencePathFilter(scopePath: string | null | undefined): {
  clause: string;
  parameters: string[];
} {
  if (scopePath === null || scopePath === undefined)
    return {
      clause: "(NULLIF(c.cwd, '') IS NULL AND NULLIF(c.source_path, '') IS NULL)",
      parameters: [],
    };
  const canonical = canonicalRecallPath(scopePath);
  if (canonical === undefined) return { clause: "1 = 0", parameters: [] };
  const escaped = canonical.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
  const descendantPattern = canonical === "/" ? "/%" : `${escaped}/%`;
  return {
    clause: `(
      (${canonicalPathSql("c.cwd")} AND (c.cwd = ? OR c.cwd LIKE ? ESCAPE '\\'))
      OR
      (${canonicalPathSql("c.source_path")} AND
        (c.source_path = ? OR c.source_path LIKE ? ESCAPE '\\'))
    )`,
    parameters: [canonical, descendantPattern, canonical, descendantPattern],
  };
}

function sqlTerms(request: ContextRequest): string[] {
  return [...terms(`${request.task} ${request.query}`)].slice(0, 8);
}

export async function collectContextCandidates(
  root: string,
  request: ContextRequest,
): Promise<ContextCandidateCollectionResult> {
  const published = await readPublishedInsightMemory(root);
  if (!published.ok)
    return {
      ok: false,
      error: { code: "source-unavailable", message: published.error.message },
    };
  const databasePath = join(resolve(root), "analysis", "chatlog.sqlite");
  if (!existsSync(databasePath))
    return {
      ok: false,
      error: { code: "source-unavailable", message: "Chatlog analysis database is unavailable" },
    };
  const db = new Database(databasePath, { readonly: true, create: false });
  try {
    const guard = new ActiveProjectionGuard(resolve(root));
    const before = guard.assert(db);
    const queryTerms = sqlTerms(request);
    const pathFilter = evidencePathFilter(request.scope.path);
    const project = request.scope.project ?? request.scope.repository;
    const evidenceRows =
      !project || queryTerms.length === 0
        ? []
        : (db
            .query(
              `SELECT e.event_id eventId,e.batch_hash batchHash,e.kind,e.payload_json payload,
                 COALESCE(e.occurred_at,e.observed_at) occurredAt,c.project,c.cwd,c.source_path sourcePath,
                 c.harness,c.model,
                 LOWER(COALESCE(NULLIF(TRIM(c.domain), ''), 'general')) domain
               FROM event_metadata e
               JOIN active_sources a ON a.event_batch_hash=e.batch_hash
               JOIN current_conversations c ON c.source_path=a.source_path AND c.content_hash=a.content_hash
               WHERE c.project=? AND LOWER(COALESCE(NULLIF(TRIM(c.domain), ''), 'general'))=?
                 AND ${pathFilter.clause}
                 AND e.capture_disposition IN ('normalized','redacted')
                 AND e.kind IN ('message.created','human.correction','tool.result.observed','evaluation.recorded','artifact.created','artifact.modified')
                 AND (${queryTerms.map(() => "LOWER(e.payload_json) LIKE ? ESCAPE '\\'").join(" OR ")})
               ORDER BY COALESCE(e.occurred_at,e.observed_at,'') DESC,e.sequence DESC,e.event_id ASC
               LIMIT 40`,
            )
            .all(
              project,
              request.scope.domain.toLowerCase(),
              ...pathFilter.parameters,
              ...queryTerms.map(
                (term) => `%${term.replaceAll("%", "\\%").replaceAll("_", "\\_")}%`,
              ),
            ) as ContextEvidenceRow[]);
    const after = guard.assert(db);
    if (
      before.manifestSourcesHash !== after.manifestSourcesHash ||
      before.reconciledAt !== after.reconciledAt ||
      before.activeSources !== after.activeSources
    )
      return {
        ok: false,
        error: {
          code: "projection-drift",
          message: "active evidence projection changed during recall",
        },
      };
    const insights = Object.values(published.value.projection.current);
    return {
      ok: true,
      value: {
        candidates: [
          ...candidatesFromInsightRevisions(insights, request),
          ...candidatesFromEvidenceRows(evidenceRows, request),
        ],
        insightProjectionHash: published.value.pointer.outputHash,
        evidenceProjectionHash: before.manifestSourcesHash,
      },
    };
  } catch (error) {
    return {
      ok: false,
      error: {
        code: "projection-drift",
        message: error instanceof Error ? error.message : String(error),
      },
    };
  } finally {
    db.close();
  }
}
