import type { Database } from "bun:sqlite";
import type {
  InsightCurrentPointer,
  InsightProjection,
  InsightRevision,
  InsightTransition,
} from "./insights";

export function ensureInsightProjection(db: Database): void {
  db.run(`CREATE TABLE IF NOT EXISTS insight_transitions (
    transition_id TEXT PRIMARY KEY,
    command TEXT NOT NULL,
    insight_id TEXT NOT NULL,
    revision_id TEXT NOT NULL,
    prior_revision_id TEXT,
    related_insight_id TEXT,
    related_revision_id TEXT,
    recorded_at TEXT NOT NULL,
    actor_json TEXT NOT NULL,
    authority_json TEXT NOT NULL,
    source_hashes_json TEXT NOT NULL,
    transition_json TEXT NOT NULL
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS insight_revisions (
    revision_id TEXT PRIMARY KEY,
    insight_id TEXT NOT NULL,
    status TEXT NOT NULL,
    kind TEXT NOT NULL,
    scope_json TEXT NOT NULL,
    observed_at TEXT NOT NULL,
    valid_start TEXT NOT NULL,
    valid_end TEXT,
    revision_json TEXT NOT NULL
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS insight_current (
    insight_id TEXT PRIMARY KEY,
    revision_id TEXT NOT NULL,
    status TEXT NOT NULL,
    revision_json TEXT NOT NULL
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS insight_projection_meta (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    project_identity TEXT NOT NULL,
    ledger_hash TEXT NOT NULL,
    compiled_state_hash TEXT NOT NULL,
    output_hash TEXT NOT NULL,
    input_projection_hash TEXT NOT NULL,
    source_authority_hash TEXT NOT NULL,
    recipe_hashes_json TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`);
  db.run(
    "CREATE INDEX IF NOT EXISTS insight_revisions_insight ON insight_revisions(insight_id, observed_at)",
  );
  db.run("CREATE INDEX IF NOT EXISTS insight_revisions_status ON insight_revisions(status)");
}

export function rebuildInsightProjection(
  db: Database,
  projection: InsightProjection,
  pointer: InsightCurrentPointer,
  transitions: readonly InsightTransition[] = [],
  updatedAt = new Date().toISOString(),
): void {
  ensureInsightProjection(db);
  const insertTransition = db.prepare(`INSERT INTO insight_transitions
    (transition_id,command,insight_id,revision_id,prior_revision_id,related_insight_id,related_revision_id,recorded_at,actor_json,authority_json,source_hashes_json,transition_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const insertRevision = db.prepare(`INSERT INTO insight_revisions
    (revision_id,insight_id,status,kind,scope_json,observed_at,valid_start,valid_end,revision_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const insertCurrent = db.prepare(
    "INSERT INTO insight_current(insight_id,revision_id,status,revision_json) VALUES (?, ?, ?, ?)",
  );
  db.transaction(() => {
    db.run("DELETE FROM insight_transitions");
    db.run("DELETE FROM insight_revisions");
    db.run("DELETE FROM insight_current");
    for (const revision of projection.history) {
      insertRevision.run(
        revision.revisionId,
        revision.insightId,
        revision.status,
        revision.kind,
        JSON.stringify(revision.scope),
        revision.observedAt,
        revision.validTime.start,
        revision.validTime.end,
        JSON.stringify(revision),
      );
    }
    for (const [insightId, revision] of Object.entries(projection.current))
      insertCurrent.run(insightId, revision.revisionId, revision.status, JSON.stringify(revision));
    for (const transition of transitions)
      insertTransition.run(
        transition.transitionId,
        transition.command,
        transition.insightId,
        transition.revision.revisionId,
        transition.priorRevisionId,
        transition.relatedInsightId,
        transition.relatedRevisionId,
        transition.recordedAt,
        JSON.stringify(transition.actor),
        JSON.stringify(transition.authority),
        JSON.stringify(transition.sourceHashes),
        JSON.stringify(transition),
      );
    db.query(`INSERT INTO insight_projection_meta
      (singleton,project_identity,ledger_hash,compiled_state_hash,output_hash,input_projection_hash,source_authority_hash,recipe_hashes_json,updated_at)
      VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(singleton) DO UPDATE SET project_identity=excluded.project_identity, ledger_hash=excluded.ledger_hash,
      compiled_state_hash=excluded.compiled_state_hash, output_hash=excluded.output_hash,
      input_projection_hash=excluded.input_projection_hash, source_authority_hash=excluded.source_authority_hash,
      recipe_hashes_json=excluded.recipe_hashes_json, updated_at=excluded.updated_at`).run(
      pointer.projectIdentity,
      pointer.ledgerHash,
      pointer.compiledStateHash,
      pointer.outputHash,
      pointer.inputProjectionHash,
      pointer.sourceAuthorityHash,
      JSON.stringify(pointer.recipeHashes),
      updatedAt,
    );
  })();
}

export function readInsightCurrentProjection(db: Database): InsightRevision[] {
  ensureInsightProjection(db);
  return (
    db
      .query("SELECT revision_json revisionJson FROM insight_current ORDER BY insight_id")
      .all() as Array<{ revisionJson: string }>
  ).map((row) => JSON.parse(row.revisionJson) as InsightRevision);
}

export function readInsightHistoryProjection(db: Database): InsightRevision[] {
  ensureInsightProjection(db);
  return (
    db
      .query(
        "SELECT revision_json revisionJson FROM insight_revisions ORDER BY insight_id, revision_id",
      )
      .all() as Array<{ revisionJson: string }>
  ).map((row) => JSON.parse(row.revisionJson) as InsightRevision);
}
