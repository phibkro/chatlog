import { chmod, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { Conversation, TokenUsage } from "./types";
import { redact } from "./redact";

export interface Pointer { turnIndex: number; uri: string }
export interface Evidence { pointer: Pointer; snippet: string }
export interface ProblemEvidence extends Evidence { terms: string[]; categories: string[] }
export interface AttemptEvidence extends Evidence {
  tools: string[];
  outcome: "success" | "failure" | "unknown";
  resultPointer?: Pointer;
}
export interface DerivedConversation {
  schemaVersion: 1;
  conversationHash: string;
  sessionId: string;
  title?: string;
  provider: string;
  project: string;
  harness: string;
  domain?: string;
  sourceKind?: string;
  model: string;
  startedAt: string;
  endedAt: string;
  metrics: {
    turns: number;
    characters: number;
    roles: Record<string, number>;
    tokens: TokenUsage;
    toolCalls: Array<{ name: string; count: number }>;
  };
  topics: Array<{ term: string; turns: number; pointers: Pointer[] }>;
  problems: ProblemEvidence[];
  decisions: Evidence[];
  gates: Array<Evidence & { result: "success" | "failure" | "unknown" }>;
  attempts: AttemptEvidence[];
  outcome: { status: "success" | "failure" | "mixed" | "unknown"; evidence: Evidence[] };
}

interface DerivedManifestEntry {
  derivedArtifacts: { structure: { path: string; contentHash: string } };
  processedAt: string;
}
interface DerivedManifest {
  version: 1;
  recipeHash: string;
  conversations: Record<string, DerivedManifestEntry>;
  currentProjection?: { path: string; contentHash: string };
}
export interface DeriveSummary { discovered: number; processed: number; skipped: number; recipeChanged: boolean; manifestPath: string }

const STOP_WORDS = new Set(`about after again agent also another assistant because before being between both broken bug build call called calling can cannot change chat claude code codex color command content context continued conversation could current data does done each error fail failed failing failure file files first fix from function get have idlereason idle_notification intent into issue just last like local make message more most need only operator other output over path previous primary problem project read real regression request result same sent session should some source stuck summary system task team-lead teammate-message teammate_id than that their them then there these they this through timeout timestamp tool tools turn turns type unknown update user using want were what when where which while will with would wrong your`.split(" "));
const PROBLEM = /\b(bug|broken|cannot|can't|couldn't|error|fail(?:ed|ing|ure)?|fix|issue|problem|regression|stuck|timeout|wrong)\b/i;
const DECISION = /\b(decid(?:e|ed|ing)|decision|choose|chosen|instead|rather than|root cause|the fix|the solution|we(?:'ll| will)|use .{0,50} (?:because|so that)|approach)\b/i;
const SUCCESS = /\b(done|fixed|green|landed|merged|passes?|passed|resolved|shipped|succeeded|successful|verified|working|complete[d]?)\b/i;
const FAILURE = /\b(blocked|broken|cannot|can't|couldn't|error|fail(?:ed|ing|ure)?|timed? out|unable|unsuccessful)\b/i;
const GATE = /\b(exit(?:ed)?(?: code)?|tests?|checks?|build|verify|verification|pass(?:ed|ing)?|fail(?:ed|ing|ure)?|error|success)\b/i;
const PROBLEM_CATEGORIES: Array<[string, RegExp]> = [
  ["nix-dirty-or-untracked-input", /(?:nix|flake).{0,100}(?:dirty|untracked|invisible)|(?:dirty|untracked).{0,100}(?:nix|flake)/i],
  ["nix-daemon-or-sandbox-permission", /(?:nix.?daemon|nix_remote|unix (?:test )?socket|read-only store).{0,140}(?:denied|eperm|permission|socket|unavailable|write)|(?:denied|eperm|permission).{0,100}(?:nix|socket)/i],
  ["stale-or-drifted-state", /\b(?:stale|drift(?:ed|ing)?|outdated|superseded|timing artifact)\b/i],
  ["ci-test-or-build-failure", /(?:\bci\b|tests?|checks?|build|gate).{0,120}(?:fail(?:ed|ing|ure)?|red|error|broke|broken)|(?:fail(?:ed|ing|ure)?|red).{0,100}(?:\bci\b|tests?|checks?|build|gate)/i],
  ["merge-rebase-or-worktree-conflict", /\b(?:merge|rebase|worktree).{0,120}(?:conflict|collision|failed|dirty)|\bconflict.{0,100}(?:merge|rebase|branch)/i],
  ["missing-config-schema-or-file", /\b(?:missing|not found|absent|wasn't included|isn't included).{0,120}(?:config|schema|profile|file|field|input|hook)|(?:config|schema|profile|file|field).{0,100}\bmissing\b/i],
  ["proof-or-design-wall", /\b(?:proof|lemma|theorem|lean|design|approach).{0,140}(?:blocked|stuck|wall|counterexample|impossible|unsound)|\b(?:containment|structural|design) wall\b/i],
  ["timeout-memory-or-resource-limit", /\b(?:timeout|timed out|out of memory|oom|resource limit|killed by signal)\b/i],
];

function hash(text: string): string { return new Bun.CryptoHasher("sha256").update(text).digest("hex"); }
export function serializeDerived(value: DerivedConversation): string {
  return JSON.stringify(value, (_key, item) => typeof item === "string" ? item.toWellFormed() : item) + "\n";
}
function pointer(c: Conversation, turnIndex: number): Pointer { return { turnIndex, uri: `chatlog://conversation/${c.contentHash}/turn/${turnIndex}` }; }
function snippet(text: string, length = 220): string {
  const clean = redact(text).replace(/\s+/g, " ").trim();
  return clean.length > length ? clean.slice(0, length - 1) + "…" : clean;
}
function terms(text: string): string[] {
  return [...new Set((text.toLowerCase().match(/[a-z][a-z0-9_-]{3,}/g) ?? []).filter((term) => !STOP_WORDS.has(term) && !/^\d/.test(term)))].slice(0, 12);
}
function problemCategories(text: string): string[] { return PROBLEM_CATEGORIES.filter(([, pattern]) => pattern.test(text)).map(([name]) => name); }
function addTokens(total: TokenUsage, usage?: TokenUsage): void {
  if (!usage) return;
  for (const key of ["input", "output", "cachedInput", "cacheWrite", "reasoning", "total"] as const)
    if (usage[key] != null) total[key] = (total[key] ?? 0) + usage[key]!;
}
function signal(text: string): "success" | "failure" | "unknown" {
  if (/\b(?:gate.{0,30}green|merged (?:to|into) main|landed (?:to|on|in) main|exit(?:ed)?(?: code)?\s*[:=]?\s*0|all .{0,40}(?:pass|green))\b/i.test(text)) return "success";
  const success = SUCCESS.test(text); const failure = FAILURE.test(text);
  if (failure && !success) return "failure";
  if (success && !failure) return "success";
  return "unknown";
}
function boundedPush<T>(items: T[], value: T, max: number): void { items.push(value); if (items.length > max) items.shift(); }

export function deriveConversation(c: Conversation): DerivedConversation {
  const roles: Record<string, number> = {};
  const tokenTotals: TokenUsage = {};
  const tools = new Map<string, number>();
  const topicMap = new Map<string, { turns: Set<number>; pointers: Pointer[] }>();
  const problems: ProblemEvidence[] = [];
  const decisions: Evidence[] = [];
  const gates: Array<Evidence & { result: "success" | "failure" | "unknown" }> = [];
  const attempts: AttemptEvidence[] = [];
  const outcomeSignals: Array<Evidence & { result: "success" | "failure" }> = [];
  let characters = 0;

  c.turns.forEach((turn, index) => {
    roles[turn.role] = (roles[turn.role] ?? 0) + 1;
    characters += turn.content.length;
    addTokens(tokenTotals, turn.tokens);
    if (turn.role === "assistant") for (const call of turn.toolCalls ?? []) tools.set(call.name, (tools.get(call.name) ?? 0) + 1);

    const text = redact(turn.content);
    const controlMessage = turn.role === "user" && (/^#\s+(?:AGENTS|CLAUDE)\.md instructions/i.test(text) || text.includes("<INSTRUCTIONS>") || /^This session is being continued from a previous conversation/i.test(text) || /idle_notification/.test(text));
    if (text && !controlMessage) for (const term of terms(text)) {
      const item = topicMap.get(term) ?? { turns: new Set<number>(), pointers: [] };
      item.turns.add(index);
      if (item.pointers.length < 3) item.pointers.push(pointer(c, index));
      topicMap.set(term, item);
    }

    const previousHadTools = index > 0 && Boolean(c.turns[index - 1].toolCalls?.length);
    if (turn.role === "user" && !controlMessage && !previousHadTools && PROBLEM.test(text))
      boundedPush(problems, { pointer: pointer(c, index), snippet: snippet(text), terms: terms(text), categories: problemCategories(text) }, 40);
    if ((turn.role === "assistant" || turn.role === "system") && DECISION.test(text))
      boundedPush(decisions, { pointer: pointer(c, index), snippet: snippet(text) }, 50);
    if ((turn.role === "assistant" || turn.role === "tool" || previousHadTools) && GATE.test(text)) {
      const result = signal(text);
      if (result !== "unknown" || /exit(?:ed)?(?: code)?\s*[:=]?\s*0\b/i.test(text)) {
        const normalized = /exit(?:ed)?(?: code)?\s*[:=]?\s*0\b/i.test(text) && result !== "failure" ? "success" : result;
        boundedPush(gates, { pointer: pointer(c, index), snippet: snippet(text), result: normalized }, 40);
      }
    }
    if (turn.role === "assistant" && text) {
      const result = signal(text);
      if (result !== "unknown") boundedPush(outcomeSignals, { pointer: pointer(c, index), snippet: snippet(text), result }, 20);
    }
    if (turn.role === "assistant" && turn.toolCalls?.length) {
      const resultTurn = c.turns[index + 1];
      const result = resultTurn ? signal(resultTurn.content) : "unknown";
      let intent = text;
      if (!intent) for (let back = index - 1; back >= Math.max(0, index - 4); back--) {
        if (c.turns[back].role === "assistant" && c.turns[back].content) { intent = c.turns[back].content; break; }
      }
      boundedPush(attempts, {
        pointer: pointer(c, index), snippet: snippet(intent || `Called ${turn.toolCalls.map((x) => x.name).join(", ")}`),
        tools: turn.toolCalls.map((x) => x.name), outcome: result,
        ...(resultTurn ? { resultPointer: pointer(c, index + 1) } : {}),
      }, 80);
    }
  });

  const latestSuccess = [...outcomeSignals, ...gates].filter((x) => x.result === "success").sort((a, b) => a.pointer.turnIndex - b.pointer.turnIndex).at(-1);
  const latestFailure = [...outcomeSignals, ...gates].filter((x) => x.result === "failure").sort((a, b) => a.pointer.turnIndex - b.pointer.turnIndex).at(-1);
  let status: DerivedConversation["outcome"]["status"] = "unknown";
  if (latestSuccess && latestFailure) status = Math.abs(latestSuccess.pointer.turnIndex - latestFailure.pointer.turnIndex) <= 5 ? "mixed" : latestSuccess.pointer.turnIndex > latestFailure.pointer.turnIndex ? "success" : "failure";
  else if (latestSuccess) status = "success";
  else if (latestFailure) status = "failure";

  const topics = [...topicMap].map(([term, value]) => ({ term, turns: value.turns.size, pointers: value.pointers }))
    .sort((a, b) => b.turns - a.turns || a.term.localeCompare(b.term)).slice(0, 24);
  const outcomeEvidence: Evidence[] = [];
  const evidenceSeen = new Set<string>();
  for (const item of [...outcomeSignals, ...gates].sort((a, b) => b.pointer.turnIndex - a.pointer.turnIndex)) {
    const key = `${item.pointer.turnIndex}:${item.snippet}`;
    if (evidenceSeen.has(key)) continue;
    evidenceSeen.add(key); outcomeEvidence.push({ pointer: item.pointer, snippet: item.snippet });
    if (outcomeEvidence.length === 6) break;
  }
  return {
    schemaVersion: 1, conversationHash: c.contentHash, sessionId: c.id, ...(c.title ? { title: c.title } : {}),
    provider: c.provider, project: c.project, harness: c.harness, ...(c.domain ? { domain: c.domain } : {}),
    ...(c.sourceKind ? { sourceKind: c.sourceKind } : {}), model: c.model, startedAt: c.startedAt, endedAt: c.endedAt,
    metrics: { turns: c.turns.length, characters, roles, tokens: tokenTotals, toolCalls: [...tools].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count) },
    topics, problems, decisions, gates, attempts,
    outcome: { status, evidence: outcomeEvidence },
  };
}

async function atomicWrite(path: string, data: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, data, { mode: 0o600 });
  await rename(temp, path);
  await chmod(path, 0o600);
}
async function loadManifest(path: string, recipeHash: string): Promise<{ manifest: DerivedManifest; recipeChanged: boolean }> {
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as DerivedManifest;
    if (value.version !== 1 || !value.conversations) throw new Error("unsupported derived manifest shape");
    return { manifest: { ...value, recipeHash }, recipeChanged: value.recipeHash !== recipeHash };
  } catch (error: any) {
    if (error?.code !== "ENOENT") throw error;
    return { manifest: { version: 1, recipeHash, conversations: {} }, recipeChanged: false };
  }
}

export async function deriveCorpus(root: string): Promise<DeriveSummary> {
  const corpusDir = join(root, "corpus");
  const derivedDir = join(root, "derived");
  const manifestPath = join(derivedDir, "manifest.json");
  const recipeHash = hash(await Bun.file(import.meta.path).text());
  const loaded = await loadManifest(manifestPath, recipeHash);
  const hashes = [...new Bun.Glob("objects/*/*.json").scanSync({ cwd: corpusDir, onlyFiles: true })]
    .map((path) => basename(path, ".json")).sort();
  let processed = 0; let skipped = 0;
  for (const conversationHash of hashes) {
    const artifactRel = `objects/${conversationHash.slice(0, 2)}/${conversationHash}.json`;
    const artifactPath = join(derivedDir, artifactRel);
    const prior = loaded.manifest.conversations[conversationHash];
    let exists = false; try { await stat(artifactPath); exists = true; } catch {}
    if (!loaded.recipeChanged && prior?.derivedArtifacts.structure.path === artifactRel && exists) { skipped++; continue; }
    const canonicalPath = join(corpusDir, "objects", conversationHash.slice(0, 2), `${conversationHash}.json`);
    const conversation = JSON.parse(await readFile(canonicalPath, "utf8")) as Conversation;
    if (conversation.contentHash !== conversationHash) throw new Error(`${canonicalPath}: filename/content hash mismatch`);
    const artifactText = serializeDerived(deriveConversation(conversation));
    await atomicWrite(artifactPath, artifactText);
    loaded.manifest.conversations[conversationHash] = {
      derivedArtifacts: { structure: { path: artifactRel, contentHash: hash(artifactText) } },
      processedAt: new Date().toISOString(),
    };
    processed++;
  }
  const corpusManifest = JSON.parse(await readFile(join(corpusDir, "manifest.json"), "utf8")) as { sources: Record<string, { contentHash: string }> };
  const currentHashes = [...new Set(Object.values(corpusManifest.sources).map((entry) => entry.contentHash))].sort();
  const projectionText = currentHashes.map((conversationHash) => JSON.stringify({ conversationHash })).join("\n") + "\n";
  const projectionPath = "current-hashes.jsonl";
  await atomicWrite(join(derivedDir, projectionPath), projectionText);
  loaded.manifest.currentProjection = { path: projectionPath, contentHash: hash(projectionText) };
  await mkdir(derivedDir, { recursive: true, mode: 0o700 });
  await chmod(derivedDir, 0o700);
  await atomicWrite(manifestPath, JSON.stringify(loaded.manifest, null, 2) + "\n");
  return { discovered: hashes.length, processed, skipped, recipeChanged: loaded.recipeChanged, manifestPath };
}

export async function loadDerived(root: string, conversationHash: string): Promise<DerivedConversation> {
  const path = join(root, "derived", "objects", conversationHash.slice(0, 2), `${conversationHash}.json`);
  return JSON.parse(await readFile(path, "utf8")) as DerivedConversation;
}
