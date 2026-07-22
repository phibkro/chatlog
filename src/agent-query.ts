import type { Database } from "bun:sqlite";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Conversation } from "./types";
import type { DerivedConversation, Evidence, Pointer } from "./derive";
import { loadDerived } from "./derive";
import { duckProjectAnalytics } from "./duckdb";

export interface SearchHit {
  sessionId: string; conversationHash: string; project: string; harness: string; model: string;
  score: number; snippet: string; pointer: Pointer;
}

export function agentSearch(db: Database, query: string, limit = 20): { query: string; hits: SearchHit[] } {
  const rows = db.query(`SELECT c.id sessionId, c.content_hash conversationHash, c.project, c.harness, c.model,
    -bm25(turns_fts) score, snippet(turns_fts, 0, '[', ']', ' … ', 28) snippet, f.turn_index turnIndex
    FROM turns_fts f JOIN current_conversations c ON c.content_hash=f.content_hash
    WHERE turns_fts MATCH ? ORDER BY bm25(turns_fts) LIMIT ?`).all(query, limit) as any[];
  return { query, hits: rows.map((row) => ({ ...row, pointer: { turnIndex: row.turnIndex, uri: `chatlog://conversation/${row.conversationHash}/turn/${row.turnIndex}` }, turnIndex: undefined }))
    .map(({ turnIndex: _, ...row }) => row) as SearchHit[] };
}

async function canonical(root: string, hash: string): Promise<Conversation> {
  return JSON.parse(await readFile(join(root, "corpus", "objects", hash.slice(0, 2), `${hash}.json`), "utf8")) as Conversation;
}

function resolveHash(db: Database, identifier: string): string {
  const isHash = /^[a-f0-9]{8,64}$/i.test(identifier);
  const rows = (isHash
    ? db.query("SELECT content_hash FROM conversations WHERE content_hash LIKE ? ORDER BY ingested_at DESC LIMIT 2").all(`${identifier}%`)
    : db.query("SELECT content_hash FROM current_conversations WHERE id=? OR resume_id=? ORDER BY ended_at DESC LIMIT 2").all(identifier, identifier)) as Array<{ content_hash: string }>;
  if (!rows.length) throw new Error(`conversation not found: ${identifier}`);
  if (isHash && rows.length > 1) throw new Error(`ambiguous conversation hash prefix: ${identifier}`);
  return rows[0].content_hash;
}

export async function agentGet(db: Database, root: string, identifier: string, turnIndex?: number): Promise<unknown> {
  const hash = resolveHash(db, identifier);
  const conversation = await canonical(root, hash);
  if (turnIndex == null) return { pointer: `chatlog://conversation/${hash}`, conversation };
  const turn = conversation.turns[turnIndex];
  if (!turn) throw new Error(`turn not found: ${turnIndex}`);
  return { sessionId: conversation.id, conversationHash: hash, project: conversation.project, pointer: `chatlog://conversation/${hash}/turn/${turnIndex}`, turnIndex, turn };
}

function relevant<T extends Evidence>(items: T[], words: string[], limit: number): T[] {
  const filtered = items.filter((item) => words.some((word) => item.snippet.toLowerCase().includes(word)));
  return (filtered.length ? filtered : items).slice(-limit);
}

function structuralView(artifact: DerivedConversation, matches: SearchHit[] = [], words: string[] = []): unknown {
  const problems = relevant(artifact.problems, words, 3).map(({ pointer, snippet }) => ({ pointer, snippet }));
  return {
    sessionId: artifact.sessionId, conversationHash: artifact.conversationHash, project: artifact.project,
    harness: artifact.harness, model: artifact.model, startedAt: artifact.startedAt, endedAt: artifact.endedAt,
    matches: matches.map(({ score, snippet, pointer }) => ({ score, snippet, pointer })),
    shape: { turns: artifact.metrics.turns, characters: artifact.metrics.characters, roles: artifact.metrics.roles, tokens: artifact.metrics.tokens },
    problems, decisions: relevant(artifact.decisions, words, 3),
    toolCallProfile: artifact.metrics.toolCalls.slice(0, 8), gates: relevant(artifact.gates, words, 3),
    attempts: relevant(artifact.attempts, words, 5), outcome: { status: artifact.outcome.status, evidence: artifact.outcome.evidence.slice(0, 2) },
  };
}

export async function agentGrok(db: Database, root: string, topic: string, limit = 10): Promise<unknown> {
  const searched = agentSearch(db, topic, Math.max(limit * 5, 30));
  const grouped = new Map<string, SearchHit[]>();
  for (const hit of searched.hits) {
    const hits = grouped.get(hit.conversationHash) ?? [];
    if (hits.length < 3) hits.push(hit);
    grouped.set(hit.conversationHash, hits);
  }
  const words = askTerms(topic);
  const sessions = [];
  for (const [hash, matches] of [...grouped].slice(0, limit)) sessions.push(structuralView(await loadDerived(root, hash), matches, words));
  return { topic, matchedSessions: grouped.size, sessions };
}

const ASK_STOP = new Set("what did i me we you they try tried last time for the a an to of on in with how do does was were is are my our and or".split(" "));
function askTerms(question: string): string[] {
  const stripped = question.replace(/what did (?:i|we) try last time for/i, "");
  return [...new Set((stripped.toLowerCase().match(/[a-z][a-z0-9_-]{2,}/g) ?? []).filter((x) => !ASK_STOP.has(x)))].slice(0, 8);
}
export async function agentAsk(db: Database, root: string, question: string, limit = 10): Promise<unknown> {
  const words = askTerms(question);
  if (!words.length) throw new Error("ask needs a concrete task/topic");
  const quoted = words.map((word) => `"${word.replaceAll('"', '""')}"`);
  const primaryExpression = quoted.join(" AND ");
  let searched = agentSearch(db, primaryExpression, Math.max(limit * 8, 50));
  let expression = primaryExpression;
  if (searched.hits.length < limit) {
    expression = quoted.join(" OR ");
    searched = agentSearch(db, expression, Math.max(limit * 8, 50));
  }
  const grouped = new Map<string, SearchHit[]>();
  for (const hit of searched.hits) {
    const hits = grouped.get(hit.conversationHash) ?? [];
    if (hits.length < 3) hits.push(hit);
    grouped.set(hit.conversationHash, hits);
  }
  const candidates: any[] = [];
  for (const [hash, matches] of grouped) {
    const artifact = await loadDerived(root, hash);
    candidates.push({
      sessionId: artifact.sessionId, conversationHash: hash, project: artifact.project, harness: artifact.harness,
      model: artifact.model, endedAt: artifact.endedAt, matchedPointers: matches.map((x) => x.pointer),
      priorProblems: artifact.problems.filter((item) => words.some((word) => item.snippet.toLowerCase().includes(word))).slice(-2).map(({ pointer, snippet }) => ({ pointer, snippet })),
      attempts: artifact.attempts.filter((attempt) => words.some((word) => attempt.snippet.toLowerCase().includes(word))).slice(-5),
      decisions: artifact.decisions.filter((item) => words.some((word) => item.snippet.toLowerCase().includes(word))).slice(-3),
      outcome: { status: artifact.outcome.status }, resolutionPointers: artifact.outcome.evidence.slice(0, 2),
    });
  }
  candidates.sort((a, b) => b.endedAt.localeCompare(a.endedAt));
  const sessions = candidates.slice(0, limit);
  const outcomes = Object.fromEntries(["success", "failure", "mixed", "unknown"].map((status) => [status, sessions.filter((x) => x.outcome.status === status).length]));
  return { question, interpretedTopic: words, searchExpression: expression, matchedSessions: grouped.size, outcomes, sessions };
}

function addExample(target: any, artifact: DerivedConversation, evidence: Evidence): void {
  if (target.examples.length >= 2) return;
  target.examples.push({ sessionId: artifact.sessionId, conversationHash: artifact.conversationHash, harness: artifact.harness, model: artifact.model, problem: { pointer: evidence.pointer, snippet: evidence.snippet }, outcome: artifact.outcome.status, resolution: artifact.outcome.evidence[0] ?? null });
}

export async function agentProject(db: Database, root: string, project: string): Promise<unknown> {
  const analytics = await duckProjectAnalytics(root, project);
  const overview = analytics.overview; const models = analytics.models.slice(0, 20); const tools = analytics.tools.slice(0, 15);
  const hashes = db.query("SELECT content_hash FROM current_conversations WHERE project=?").all(project) as Array<{ content_hash: string }>;
  const outcomes: Record<string, number> = { success: 0, failure: 0, mixed: 0, unknown: 0 };
  const recurring = new Map<string, { occurrences: number; sessions: Set<string>; examples: any[] }>();
  const decisions: Array<Evidence & { sessionId: string; model: string; endedAt: string }> = [];
  for (const { content_hash } of hashes) {
    const artifact = await loadDerived(root, content_hash);
    outcomes[artifact.outcome.status]++;
    const seen = new Set<string>();
    for (const problem of artifact.problems) for (const term of problem.categories) {
      const item = recurring.get(term) ?? { occurrences: 0, sessions: new Set<string>(), examples: [] };
      item.occurrences++;
      item.sessions.add(artifact.conversationHash);
      if (!seen.has(term)) addExample(item, artifact, problem);
      seen.add(term); recurring.set(term, item);
    }
    for (const decision of artifact.decisions.slice(-2)) decisions.push({ ...decision, sessionId: artifact.sessionId, model: artifact.model, endedAt: artifact.endedAt });
  }
  const recurringProblems = [...recurring].map(([category, item]) => ({ category, occurrences: item.occurrences, sessions: item.sessions.size, examples: item.examples }))
    .sort((a, b) => b.sessions - a.sessions || b.occurrences - a.occurrences).slice(0, 12);
  decisions.sort((a, b) => b.endedAt.localeCompare(a.endedAt));
  return { project, overview, models, tools, outcomes, recurringProblems, recentDecisionPoints: decisions.slice(0, 10) };
}
