import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { canonicalEventBatch, type EventBatch } from "./events";
import { eventBatchHash } from "./event-store";
import type { Conversation } from "./types";
import { ensureInsightProjection } from "./insight-projection";

function hasColumn(db: Database, table: string, column: string): boolean {
  return (db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).some(
    (row) => row.name === column,
  );
}

export function openAnalysis(path: string): Database {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new Database(path, { create: true });
  db.run("PRAGMA journal_mode=WAL");
  db.run("PRAGMA synchronous=NORMAL");
  db.run(`CREATE TABLE IF NOT EXISTS conversations (
    content_hash TEXT PRIMARY KEY, id TEXT NOT NULL, provider TEXT NOT NULL, harness TEXT NOT NULL,
    project TEXT NOT NULL, cwd TEXT NOT NULL, model TEXT NOT NULL, started_at TEXT NOT NULL,
    ended_at TEXT NOT NULL, resume_id TEXT, source_path TEXT NOT NULL, source_mtime REAL NOT NULL,
    source_size INTEGER NOT NULL, ingested_at TEXT NOT NULL, turn_count INTEGER NOT NULL,
    input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL, cached_input_tokens INTEGER NOT NULL,
    reasoning_tokens INTEGER NOT NULL, total_tokens INTEGER NOT NULL,
    cache_write_tokens INTEGER NOT NULL DEFAULT 0,
    title TEXT NOT NULL DEFAULT '',
    domain TEXT NOT NULL DEFAULT 'coding',
    source_kind TEXT NOT NULL DEFAULT 'session-log'
  )`);
  if (!hasColumn(db, "conversations", "cache_write_tokens"))
    db.run("ALTER TABLE conversations ADD COLUMN cache_write_tokens INTEGER NOT NULL DEFAULT 0");
  if (!hasColumn(db, "conversations", "title"))
    db.run("ALTER TABLE conversations ADD COLUMN title TEXT NOT NULL DEFAULT ''");
  if (!hasColumn(db, "conversations", "domain"))
    db.run("ALTER TABLE conversations ADD COLUMN domain TEXT NOT NULL DEFAULT 'coding'");
  if (!hasColumn(db, "conversations", "source_kind"))
    db.run("ALTER TABLE conversations ADD COLUMN source_kind TEXT NOT NULL DEFAULT 'session-log'");
  db.run(`CREATE TABLE IF NOT EXISTS turns (
    content_hash TEXT NOT NULL, turn_index INTEGER NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL,
    at TEXT, input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL, cached_input_tokens INTEGER NOT NULL,
    reasoning_tokens INTEGER NOT NULL, total_tokens INTEGER NOT NULL,
    PRIMARY KEY(content_hash, turn_index)
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS tool_calls (
    content_hash TEXT NOT NULL, turn_index INTEGER NOT NULL, call_index INTEGER NOT NULL,
    call_id TEXT, name TEXT NOT NULL, arguments TEXT, output TEXT,
    PRIMARY KEY(content_hash, turn_index, call_index)
  )`);
  db.run(
    "CREATE VIRTUAL TABLE IF NOT EXISTS turns_fts USING fts5(content, content_hash UNINDEXED, turn_index UNINDEXED, harness UNINDEXED, project UNINDEXED, tokenize='unicode61')",
  );
  db.run(`CREATE TABLE IF NOT EXISTS active_sources (
    source_path TEXT PRIMARY KEY,
    content_hash TEXT NOT NULL,
    event_batch_hash TEXT,
    projection_hash TEXT,
    receipt_hash TEXT,
    updated_at TEXT NOT NULL
  )`);
  if (!hasColumn(db, "active_sources", "event_batch_hash"))
    db.run("ALTER TABLE active_sources ADD COLUMN event_batch_hash TEXT");
  if (!hasColumn(db, "active_sources", "projection_hash"))
    db.run("ALTER TABLE active_sources ADD COLUMN projection_hash TEXT");
  if (!hasColumn(db, "active_sources", "receipt_hash"))
    db.run("ALTER TABLE active_sources ADD COLUMN receipt_hash TEXT");
  db.run("CREATE INDEX IF NOT EXISTS active_sources_content_hash ON active_sources(content_hash)");
  db.run(`CREATE TABLE IF NOT EXISTS active_projection_meta (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    manifest_sources_hash TEXT NOT NULL,
    reconciled_at TEXT NOT NULL
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS event_batches (
    batch_hash TEXT PRIMARY KEY,
    schema_version INTEGER NOT NULL,
    origin_kind TEXT NOT NULL,
    origin_json TEXT NOT NULL,
    partial_tail INTEGER NOT NULL,
    event_count INTEGER NOT NULL,
    semantic_loss_count INTEGER NOT NULL,
    projection_hash TEXT
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS event_metadata (
    event_id TEXT PRIMARY KEY,
    batch_hash TEXT NOT NULL,
    sequence INTEGER NOT NULL,
    kind TEXT NOT NULL,
    occurred_at TEXT,
    observed_at TEXT,
    actor_kind TEXT NOT NULL,
    actor_json TEXT NOT NULL,
    scope_json TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    capture_disposition TEXT NOT NULL,
    capture_reason TEXT,
    origin_kind TEXT NOT NULL,
    origin_json TEXT NOT NULL
  )`);
  db.run("CREATE INDEX IF NOT EXISTS event_metadata_batch ON event_metadata(batch_hash, sequence)");
  db.run("CREATE INDEX IF NOT EXISTS event_metadata_kind ON event_metadata(kind)");
  db.run(`CREATE TABLE IF NOT EXISTS event_relations (
    event_id TEXT NOT NULL,
    relation_name TEXT NOT NULL,
    target_event_id TEXT NOT NULL,
    PRIMARY KEY(event_id, relation_name, target_event_id)
  )`);
  db.run("CREATE INDEX IF NOT EXISTS event_relations_target ON event_relations(target_event_id)");
  db.run(`CREATE TABLE IF NOT EXISTS event_sources (
    event_id TEXT PRIMARY KEY,
    batch_hash TEXT NOT NULL,
    provider TEXT NOT NULL,
    harness TEXT NOT NULL,
    source_kind TEXT NOT NULL,
    source_path TEXT NOT NULL,
    native_session_id TEXT,
    native_item_id TEXT,
    record_position_json TEXT NOT NULL,
    adapter_recipe TEXT NOT NULL,
    capture_policy_version TEXT NOT NULL,
    redacted_native_record_hash TEXT NOT NULL
  )`);
  db.run(
    "CREATE INDEX IF NOT EXISTS event_sources_path ON event_sources(source_path, native_item_id)",
  );
  db.run(
    "CREATE VIEW IF NOT EXISTS source_to_events AS SELECT source_path, event_id, batch_hash, native_item_id, record_position_json FROM event_sources",
  );
  db.run("DROP VIEW IF EXISTS current_token_usage");
  db.run("DROP VIEW IF EXISTS current_turns");
  db.run("DROP VIEW IF EXISTS current_conversations");
  db.run(`CREATE VIEW current_conversations AS
    SELECT c.content_hash, c.id, c.provider, c.harness, c.title, c.domain,
      c.source_kind, c.project, c.cwd, c.model, c.started_at, c.ended_at,
      c.resume_id, c.source_path, c.source_mtime, c.source_size, c.ingested_at,
      c.turn_count, c.input_tokens, c.output_tokens, c.cached_input_tokens,
      c.reasoning_tokens, c.total_tokens, c.cache_write_tokens
    FROM conversations c
    JOIN active_sources a
      ON a.source_path = c.source_path AND a.content_hash = c.content_hash`);
  db.run(`CREATE VIEW current_turns AS
    SELECT t.* FROM turns t JOIN current_conversations c USING(content_hash)`);
  db.run(`CREATE VIEW current_token_usage AS
    SELECT content_hash, id, provider, harness, project, model, started_at, turn_count,
      input_tokens, output_tokens,
      CASE WHEN harness = 'codex'
        THEN max(input_tokens - cached_input_tokens, 0) + output_tokens
        ELSE input_tokens + output_tokens END AS non_cached_tokens,
      cached_input_tokens AS cache_read_tokens,
      cache_write_tokens,
      cached_input_tokens + cache_write_tokens AS cached_tokens,
      total_tokens AS reported_total_tokens
    FROM current_conversations`);
  ensureInsightProjection(db);
  chmodSync(path, 0o600);
  return db;
}

export function indexEventBatch(
  db: Database,
  input: EventBatch,
  batchHash = eventBatchHash(input),
  projectionHash?: string,
): boolean {
  const batch = canonicalEventBatch(input);
  if (db.query("SELECT 1 FROM event_batches WHERE batch_hash = ?").get(batchHash)) return false;
  const insertBatch = db.prepare(`INSERT INTO event_batches
    (batch_hash,schema_version,origin_kind,origin_json,partial_tail,event_count,semantic_loss_count,projection_hash)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  const insertEvent = db.prepare(`INSERT OR REPLACE INTO event_metadata
    (event_id,batch_hash,sequence,kind,occurred_at,observed_at,actor_kind,actor_json,scope_json,payload_json,capture_disposition,capture_reason,origin_kind,origin_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const insertRelation = db.prepare(
    "INSERT OR IGNORE INTO event_relations(event_id,relation_name,target_event_id) VALUES (?, ?, ?)",
  );
  const insertSource = db.prepare(`INSERT OR REPLACE INTO event_sources
    (event_id,batch_hash,provider,harness,source_kind,source_path,native_session_id,native_item_id,record_position_json,adapter_recipe,capture_policy_version,redacted_native_record_hash)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  db.transaction(() => {
    insertBatch.run(
      batchHash,
      batch.schemaVersion,
      batch.origin.kind,
      JSON.stringify(batch.origin),
      batch.partialTail ? 1 : 0,
      batch.events.length,
      batch.semanticLoss.length,
      projectionHash ?? null,
    );
    for (const event of batch.events) {
      insertEvent.run(
        event.eventId,
        batchHash,
        event.sequence,
        event.kind,
        event.occurredAt ?? null,
        event.observedAt ?? null,
        event.actor.kind,
        JSON.stringify(event.actor),
        JSON.stringify(event.scope),
        JSON.stringify(event.payload),
        event.capture.disposition,
        event.capture.reason ?? null,
        event.origin.kind,
        JSON.stringify(event.origin),
      );
      if (event.relations.parent)
        insertRelation.run(event.eventId, "parent", event.relations.parent);
      if (event.relations.branch)
        insertRelation.run(event.eventId, "branch", event.relations.branch);
      for (const relation of ["causedBy", "correlatesWith", "derivedFrom"] as const)
        for (const target of event.relations[relation] ?? [])
          insertRelation.run(event.eventId, relation, target);
      if (event.origin.kind === "observed") {
        const source = event.origin.source;
        insertSource.run(
          event.eventId,
          batchHash,
          source.provider,
          source.harness,
          source.sourceKind,
          source.sourcePath,
          source.nativeSessionId ?? null,
          source.nativeItemId ?? null,
          JSON.stringify(source.recordPosition),
          source.adapterRecipe,
          source.capturePolicyVersion,
          source.redactedNativeRecordHash,
        );
      }
    }
  })();
  return true;
}

export function indexConversation(
  db: Database,
  c: Conversation,
  sourceMtime: number,
  sourceSize: number,
): boolean {
  if (db.query("SELECT 1 FROM conversations WHERE content_hash = ?").get(c.contentHash))
    return false;
  const totals = c.turns.reduce(
    (a, t) => ({
      input: a.input + (t.tokens?.input ?? 0),
      output: a.output + (t.tokens?.output ?? 0),
      cached: a.cached + (t.tokens?.cachedInput ?? 0),
      reasoning: a.reasoning + (t.tokens?.reasoning ?? 0),
      total: a.total + (t.tokens?.total ?? 0),
    }),
    { input: 0, output: 0, cached: 0, reasoning: 0, total: 0 },
  );
  const insertConversation = db.prepare(`INSERT INTO conversations
    (content_hash,id,provider,harness,project,cwd,model,started_at,ended_at,resume_id,source_path,
     source_mtime,source_size,ingested_at,turn_count,input_tokens,output_tokens,cached_input_tokens,
     reasoning_tokens,total_tokens,cache_write_tokens,title,domain,source_kind)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const insertTurn = db.prepare("INSERT INTO turns VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
  const insertFts = db.prepare(
    "INSERT INTO turns_fts(content, content_hash, turn_index, harness, project) VALUES (?, ?, ?, ?, ?)",
  );
  const insertTool = db.prepare("INSERT INTO tool_calls VALUES (?, ?, ?, ?, ?, ?, ?)");
  db.transaction(() => {
    const cacheWrite = c.turns.reduce((sum, turn) => sum + (turn.tokens?.cacheWrite ?? 0), 0);
    insertConversation.run(
      c.contentHash,
      c.id,
      c.provider,
      c.harness,
      c.project,
      c.cwd,
      c.model,
      c.startedAt,
      c.endedAt,
      c.resumeId ?? null,
      c.sourcePath,
      sourceMtime,
      sourceSize,
      new Date().toISOString(),
      c.turns.length,
      totals.input,
      totals.output,
      totals.cached,
      totals.reasoning,
      totals.total,
      cacheWrite,
      c.title ?? "",
      c.domain ?? "coding",
      c.sourceKind ?? "session-log",
    );
    c.turns.forEach((t, i) => {
      insertTurn.run(
        c.contentHash,
        i,
        t.role,
        t.content,
        t.at ?? null,
        t.tokens?.input ?? 0,
        t.tokens?.output ?? 0,
        t.tokens?.cachedInput ?? 0,
        t.tokens?.reasoning ?? 0,
        t.tokens?.total ?? 0,
      );
      if (t.content) insertFts.run(t.content, c.contentHash, i, c.harness, c.project);
      t.toolCalls?.forEach((call, j) =>
        insertTool.run(
          c.contentHash,
          i,
          j,
          call.id ?? null,
          call.name,
          call.arguments ?? null,
          call.output ?? null,
        ),
      );
    });
  })();
  return true;
}

export function queryStats(db: Database): { providers: unknown[]; projects: unknown[] } {
  return {
    providers: db
      .query(`SELECT provider, harness, count(*) sessions, sum(turn_count) turns,
      sum(non_cached_tokens) non_cached_tokens, sum(cache_read_tokens) cache_read_tokens,
      sum(cache_write_tokens) cache_write_tokens, sum(reported_total_tokens) reported_total_tokens
      FROM current_token_usage GROUP BY provider, harness ORDER BY sessions DESC`)
      .all(),
    projects: db
      .query(`SELECT project, provider, harness, count(*) sessions, sum(turn_count) turns,
      sum(non_cached_tokens) non_cached_tokens, sum(cached_tokens) cached_tokens,
      sum(reported_total_tokens) reported_total_tokens FROM current_token_usage GROUP BY project, provider, harness
      ORDER BY sessions DESC, reported_total_tokens DESC LIMIT 30`)
      .all(),
  };
}

export function querySearch(db: Database, term: string, limit = 10): unknown[] {
  return db
    .query(`SELECT f.harness, f.project, c.started_at, substr(highlight(turns_fts, 0, '[', ']'), 1, 240) excerpt,
    f.content_hash, f.turn_index FROM turns_fts f JOIN current_conversations c ON c.content_hash=f.content_hash
    WHERE turns_fts MATCH ? ORDER BY rank LIMIT ?`)
    .all(term, limit);
}

export function queryModels(db: Database): unknown[] {
  return db
    .query(`SELECT project, harness, model, count(*) sessions, sum(total_tokens) total_tokens
    FROM current_conversations GROUP BY project, harness, model ORDER BY sessions DESC, total_tokens DESC LIMIT 30`)
    .all();
}

export function queryTokenUsage(db: Database): unknown[] {
  return db
    .query(`SELECT provider, harness, count(*) sessions,
    sum(non_cached_tokens) non_cached_tokens, sum(cache_read_tokens) cache_read_tokens,
    sum(cache_write_tokens) cache_write_tokens, sum(cached_tokens) cached_tokens,
    sum(reported_total_tokens) reported_total_tokens FROM current_token_usage
    GROUP BY provider, harness ORDER BY sessions DESC`)
    .all();
}

export function queryUsageOverTime(
  db: Database,
  bucket: "day" | "month" = "month",
  limit = 60,
): unknown[] {
  const format = bucket === "day" ? "%Y-%m-%d" : "%Y-%m";
  return db
    .query(`SELECT strftime('${format}', started_at) period, harness, model, count(*) sessions,
    sum(non_cached_tokens) non_cached_tokens, sum(cached_tokens) cached_tokens,
    sum(reported_total_tokens) reported_total_tokens FROM current_token_usage
    GROUP BY period, harness, model ORDER BY period DESC, reported_total_tokens DESC LIMIT ?`)
    .all(limit);
}

export function queryToolFrequency(db: Database, limit = 30): unknown[] {
  return db
    .query(`SELECT c.harness, tc.name tool, count(*) calls,
    count(DISTINCT tc.content_hash) sessions FROM tool_calls tc JOIN current_conversations c USING(content_hash)
    JOIN turns t ON t.content_hash=tc.content_hash AND t.turn_index=tc.turn_index WHERE t.role='assistant'
    GROUP BY c.harness, tc.name ORDER BY calls DESC LIMIT ?`)
    .all(limit);
}

export function querySessionLengths(db: Database): unknown[] {
  return db
    .query(`SELECT CASE WHEN turn_count = 0 THEN '0'
      WHEN turn_count <= 10 THEN '1-10' WHEN turn_count <= 50 THEN '11-50'
      WHEN turn_count <= 200 THEN '51-200' WHEN turn_count <= 1000 THEN '201-1000' ELSE '1001+' END turn_bucket,
    count(*) sessions, round(avg(turn_count), 1) avg_turns, min(turn_count) min_turns, max(turn_count) max_turns
    FROM current_conversations GROUP BY turn_bucket ORDER BY min(turn_count)`)
    .all();
}

export async function backfillCacheWrite(db: Database, corpusDir: string): Promise<number> {
  db.run("CREATE TABLE IF NOT EXISTS analysis_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  if (db.query("SELECT value FROM analysis_meta WHERE key='cache_write_backfill_v1'").get())
    return 0;
  const update = db.prepare("UPDATE conversations SET cache_write_tokens=? WHERE content_hash=?");
  let count = 0;
  db.transaction(() => {
    for (const rel of new Bun.Glob("objects/**/*.json").scanSync({
      cwd: corpusDir,
      onlyFiles: true,
    })) {
      const conversation = JSON.parse(readFileSync(`${corpusDir}/${rel}`, "utf8")) as Conversation;
      const tokens = conversation.turns.reduce(
        (sum, turn) => sum + (turn.tokens?.cacheWrite ?? 0),
        0,
      );
      update.run(tokens, conversation.contentHash);
      count++;
    }
    db.query(
      "INSERT OR REPLACE INTO analysis_meta(key,value) VALUES ('cache_write_backfill_v1',?)",
    ).run(new Date().toISOString());
  })();
  return count;
}
