import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Conversation } from "./types";

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
    reasoning_tokens INTEGER NOT NULL, total_tokens INTEGER NOT NULL
  )`);
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
  db.run(`CREATE VIEW IF NOT EXISTS current_conversations AS
    SELECT content_hash, id, provider, harness, project, cwd, model, started_at, ended_at,
      resume_id, source_path, source_mtime, source_size, ingested_at, turn_count,
      input_tokens, output_tokens, cached_input_tokens, reasoning_tokens, total_tokens FROM (
      SELECT *, row_number() OVER (PARTITION BY source_path ORDER BY source_mtime DESC, source_size DESC, ingested_at DESC) rn
    FROM conversations
    ) WHERE rn = 1`);
  db.run(`CREATE VIEW IF NOT EXISTS current_turns AS
    SELECT t.* FROM turns t JOIN current_conversations c USING(content_hash)`);
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
  const insertConversation = db.prepare("INSERT INTO conversations VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
  const insertTurn = db.prepare("INSERT INTO turns VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
  const insertFts = db.prepare("INSERT INTO turns_fts(content, content_hash, turn_index, harness, project) VALUES (?, ?, ?, ?, ?)");
  const insertTool = db.prepare("INSERT INTO tool_calls VALUES (?, ?, ?, ?, ?, ?, ?)");
  db.transaction(() => {
    insertConversation.run(c.contentHash, c.id, c.provider, c.harness, c.project, c.cwd, c.model, c.startedAt, c.endedAt, c.resumeId ?? null, c.sourcePath, sourceMtime, sourceSize, new Date().toISOString(), c.turns.length, totals.input, totals.output, totals.cached, totals.reasoning, totals.total);
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
      sum(input_tokens) input_tokens, sum(output_tokens) output_tokens,
      sum(cached_input_tokens) cached_input_tokens, sum(total_tokens) total_tokens
      FROM current_conversations GROUP BY provider, harness ORDER BY sessions DESC`).all(),
    projects: db.query(`SELECT project, provider, harness, count(*) sessions, sum(turn_count) turns,
      sum(total_tokens) total_tokens FROM current_conversations GROUP BY project, provider, harness
      ORDER BY sessions DESC, total_tokens DESC LIMIT 30`).all(),
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
