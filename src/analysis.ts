import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Conversation } from "./types";

function hasColumn(db: Database, table: string, column: string): boolean {
  return (db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).some((row) => row.name === column);
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
  db.run("CREATE VIRTUAL TABLE IF NOT EXISTS turns_fts USING fts5(content, content_hash UNINDEXED, turn_index UNINDEXED, harness UNINDEXED, project UNINDEXED, tokenize='unicode61')");
  db.run("DROP VIEW IF EXISTS current_token_usage");
  db.run("DROP VIEW IF EXISTS current_turns");
  db.run("DROP VIEW IF EXISTS current_conversations");
  db.run(`CREATE VIEW current_conversations AS
    SELECT content_hash, id, provider, harness, title, domain, source_kind, project, cwd, model, started_at, ended_at,
      resume_id, source_path, source_mtime, source_size, ingested_at, turn_count,
      input_tokens, output_tokens, cached_input_tokens, reasoning_tokens, total_tokens, cache_write_tokens FROM (
      SELECT *, row_number() OVER (PARTITION BY source_path ORDER BY source_mtime DESC, source_size DESC, ingested_at DESC) rn
    FROM conversations
    ) WHERE rn = 1`);
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
  chmodSync(path, 0o600);
  return db;
}

export function indexConversation(db: Database, c: Conversation, sourceMtime: number, sourceSize: number): boolean {
  if (db.query("SELECT 1 FROM conversations WHERE content_hash = ?").get(c.contentHash)) return false;
  const totals = c.turns.reduce((a, t) => ({
    input: a.input + (t.tokens?.input ?? 0), output: a.output + (t.tokens?.output ?? 0),
    cached: a.cached + (t.tokens?.cachedInput ?? 0), reasoning: a.reasoning + (t.tokens?.reasoning ?? 0),
    total: a.total + (t.tokens?.total ?? 0),
  }), { input: 0, output: 0, cached: 0, reasoning: 0, total: 0 });
  const insertConversation = db.prepare(`INSERT INTO conversations
    (content_hash,id,provider,harness,project,cwd,model,started_at,ended_at,resume_id,source_path,
     source_mtime,source_size,ingested_at,turn_count,input_tokens,output_tokens,cached_input_tokens,
     reasoning_tokens,total_tokens,cache_write_tokens,title,domain,source_kind)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const insertTurn = db.prepare("INSERT INTO turns VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
  const insertFts = db.prepare("INSERT INTO turns_fts(content, content_hash, turn_index, harness, project) VALUES (?, ?, ?, ?, ?)");
  const insertTool = db.prepare("INSERT INTO tool_calls VALUES (?, ?, ?, ?, ?, ?, ?)");
  db.transaction(() => {
    const cacheWrite = c.turns.reduce((sum, turn) => sum + (turn.tokens?.cacheWrite ?? 0), 0);
    insertConversation.run(c.contentHash, c.id, c.provider, c.harness, c.project, c.cwd, c.model, c.startedAt, c.endedAt, c.resumeId ?? null, c.sourcePath, sourceMtime, sourceSize, new Date().toISOString(), c.turns.length, totals.input, totals.output, totals.cached, totals.reasoning, totals.total, cacheWrite, c.title ?? "", c.domain ?? "coding", c.sourceKind ?? "session-log");
    c.turns.forEach((t, i) => {
      insertTurn.run(c.contentHash, i, t.role, t.content, t.at ?? null, t.tokens?.input ?? 0, t.tokens?.output ?? 0, t.tokens?.cachedInput ?? 0, t.tokens?.reasoning ?? 0, t.tokens?.total ?? 0);
      if (t.content) insertFts.run(t.content, c.contentHash, i, c.harness, c.project);
      t.toolCalls?.forEach((call, j) => insertTool.run(c.contentHash, i, j, call.id ?? null, call.name, call.arguments ?? null, call.output ?? null));
    });
  })();
  return true;
}

export function queryStats(db: Database): { providers: unknown[]; projects: unknown[] } {
  return {
    providers: db.query(`SELECT provider, harness, count(*) sessions, sum(turn_count) turns,
      sum(non_cached_tokens) non_cached_tokens, sum(cache_read_tokens) cache_read_tokens,
      sum(cache_write_tokens) cache_write_tokens, sum(reported_total_tokens) reported_total_tokens
      FROM current_token_usage GROUP BY provider, harness ORDER BY sessions DESC`).all(),
    projects: db.query(`SELECT project, provider, harness, count(*) sessions, sum(turn_count) turns,
      sum(non_cached_tokens) non_cached_tokens, sum(cached_tokens) cached_tokens,
      sum(reported_total_tokens) reported_total_tokens FROM current_token_usage GROUP BY project, provider, harness
      ORDER BY sessions DESC, reported_total_tokens DESC LIMIT 30`).all(),
  };
}

export function querySearch(db: Database, term: string, limit = 10): unknown[] {
  return db.query(`SELECT f.harness, f.project, c.started_at, substr(highlight(turns_fts, 0, '[', ']'), 1, 240) excerpt,
    f.content_hash, f.turn_index FROM turns_fts f JOIN current_conversations c ON c.content_hash=f.content_hash
    WHERE turns_fts MATCH ? ORDER BY rank LIMIT ?`).all(term, limit);
}

export function queryModels(db: Database): unknown[] {
  return db.query(`SELECT project, harness, model, count(*) sessions, sum(total_tokens) total_tokens
    FROM current_conversations GROUP BY project, harness, model
    ORDER BY sessions DESC, total_tokens DESC LIMIT 30`).all();
}

export function queryTokenUsage(db: Database): unknown[] {
  return db.query(`SELECT provider, harness, count(*) sessions,
    sum(non_cached_tokens) non_cached_tokens, sum(cache_read_tokens) cache_read_tokens,
    sum(cache_write_tokens) cache_write_tokens, sum(cached_tokens) cached_tokens,
    sum(reported_total_tokens) reported_total_tokens
    FROM current_token_usage GROUP BY provider, harness ORDER BY sessions DESC`).all();
}

export function queryUsageOverTime(db: Database, bucket: "day" | "month" = "month", limit = 60): unknown[] {
  const format = bucket === "day" ? "%Y-%m-%d" : "%Y-%m";
  return db.query(`SELECT strftime('${format}', started_at) period, harness, model, count(*) sessions,
    sum(non_cached_tokens) non_cached_tokens, sum(cached_tokens) cached_tokens,
    sum(reported_total_tokens) reported_total_tokens
    FROM current_token_usage GROUP BY period, harness, model
    ORDER BY period DESC, reported_total_tokens DESC LIMIT ?`).all(limit);
}

export function queryToolFrequency(db: Database, limit = 30): unknown[] {
  return db.query(`SELECT c.harness, tc.name tool, count(*) calls,
    count(DISTINCT tc.content_hash) sessions
    FROM tool_calls tc JOIN current_conversations c USING(content_hash)
    JOIN turns t ON t.content_hash=tc.content_hash AND t.turn_index=tc.turn_index
    WHERE t.role='assistant'
    GROUP BY c.harness, tc.name ORDER BY calls DESC LIMIT ?`).all(limit);
}

export function querySessionLengths(db: Database): unknown[] {
  return db.query(`SELECT
    CASE WHEN turn_count = 0 THEN '0'
      WHEN turn_count <= 10 THEN '1-10'
      WHEN turn_count <= 50 THEN '11-50'
      WHEN turn_count <= 200 THEN '51-200'
      WHEN turn_count <= 1000 THEN '201-1000'
      ELSE '1001+' END turn_bucket,
    count(*) sessions, round(avg(turn_count), 1) avg_turns,
    min(turn_count) min_turns, max(turn_count) max_turns
    FROM current_conversations GROUP BY turn_bucket
    ORDER BY min(turn_count)`).all();
}

export async function backfillCacheWrite(db: Database, corpusDir: string): Promise<number> {
  db.run("CREATE TABLE IF NOT EXISTS analysis_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  if (db.query("SELECT value FROM analysis_meta WHERE key='cache_write_backfill_v1'").get()) return 0;
  const update = db.prepare("UPDATE conversations SET cache_write_tokens=? WHERE content_hash=?");
  let count = 0;
  db.transaction(() => {
    for (const rel of new Bun.Glob("objects/**/*.json").scanSync({ cwd: corpusDir, onlyFiles: true })) {
      const conversation = JSON.parse(readFileSync(`${corpusDir}/${rel}`, "utf8")) as Conversation;
      const tokens = conversation.turns.reduce((sum, turn) => sum + (turn.tokens?.cacheWrite ?? 0), 0);
      update.run(tokens, conversation.contentHash);
      count++;
    }
    db.query("INSERT OR REPLACE INTO analysis_meta(key,value) VALUES ('cache_write_backfill_v1',?)").run(new Date().toISOString());
  })();
  return count;
}
