import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Conversation } from "./types";
import { redact } from "./redact";

// Bump when the extraction prompt or expected output shape changes so stale
// cache entries are re-inferred instead of silently reused.
const TOPIC_RECIPE = "vault-topic-extraction-v2";
const DEFAULT_MODEL = process.env.CHATLOG_VAULT_TOPIC_MODEL ?? "gemma3:12b";
const DEFAULT_ENDPOINT =
  process.env.CHATLOG_VAULT_OLLAMA_ENDPOINT ?? "http://127.0.0.1:11434/api/generate";
const DEFAULT_CONCURRENCY = Number(process.env.CHATLOG_VAULT_CONCURRENCY ?? 4);

export interface TopicExtractionResult {
  ok: boolean;
  topics: string[];
  model: string;
  cached: boolean;
  latencyMs: number;
  reason?: string;
}

// ---------------------------------------------------------------------------
// Pure vocabulary normalization — collapses near-duplicate emergent topics
// ("nix flakes" / "Nix flake" / "flakes") without a fixed bucket list. Merge
// is token-set based (not raw edit distance) so short unrelated words like
// "health" and "wealth" never collide; only shares of whole hyphen-tokens do.
// ---------------------------------------------------------------------------

export function normalizeTopic(raw: string): string {
  return raw
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function singularize(word: string): string {
  if (word.length > 5 && word.endsWith("ies")) return `${word.slice(0, -3)}y`;
  if (word.length > 5 && /(ches|shes|xes|zes|sses)$/.test(word)) return word.slice(0, -2);
  if (word.length > 4 && word.endsWith("s") && !word.endsWith("ss") && !word.endsWith("us"))
    return word.slice(0, -1);
  return word;
}

function tokenize(topic: string): Set<string> {
  return new Set(topic.split("-").filter(Boolean).map(singularize));
}

function jaccard(a: Set<string>, b: Set<string>): number {
  let intersection = 0;
  for (const item of a) if (b.has(item)) intersection++;
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

export interface TopicCluster {
  canonical: string;
  members: string[];
  count: number;
}

export interface TopicClustering {
  canonicalOf: Map<string, string>;
  clusters: TopicCluster[];
}

export function clusterTopics(counts: Map<string, number>): TopicClustering {
  const topics = [...counts.keys()];
  const tokenSets = new Map(topics.map((topic) => [topic, tokenize(topic)]));
  const parent = new Map(topics.map((topic) => [topic, topic]));
  function find(topic: string): string {
    let root = topic;
    while (parent.get(root) !== root) root = parent.get(root)!;
    let cursor = topic;
    while (parent.get(cursor) !== root) {
      const next = parent.get(cursor)!;
      parent.set(cursor, root);
      cursor = next;
    }
    return root;
  }
  function union(a: string, b: string): void {
    const rootA = find(a);
    const rootB = find(b);
    if (rootA !== rootB) parent.set(rootA, rootB);
  }
  for (let i = 0; i < topics.length; i++) {
    for (let j = i + 1; j < topics.length; j++) {
      const a = topics[i]!;
      const b = topics[j]!;
      const tokensA = tokenSets.get(a)!;
      const tokensB = tokenSets.get(b)!;
      const similarity = jaccard(tokensA, tokensB);
      if (similarity >= 1) {
        union(a, b);
        continue;
      }
      // Guard against absorbing a strictly broader/narrower topic: only merge
      // near-equal-length variants (typo/plural/hyphenation drift), never a
      // topic that is merely a superset of another's tokens.
      if (Math.abs(tokensA.size - tokensB.size) <= 1 && similarity >= 0.66) union(a, b);
    }
  }
  const groups = new Map<string, string[]>();
  for (const topic of topics) {
    const root = find(topic);
    const list = groups.get(root) ?? [];
    list.push(topic);
    groups.set(root, list);
  }
  const canonicalOf = new Map<string, string>();
  const clusters: TopicCluster[] = [];
  for (const members of groups.values()) {
    const sorted = members.toSorted(
      (a, b) => counts.get(b)! - counts.get(a)! || a.length - b.length || a.localeCompare(b),
    );
    const canonical = sorted[0]!;
    let count = 0;
    for (const member of members) {
      canonicalOf.set(member, canonical);
      count += counts.get(member) ?? 0;
    }
    clusters.push({ canonical, members: sorted, count });
  }
  return {
    canonicalOf,
    clusters: clusters.toSorted((a, b) => b.count - a.count || a.canonical.localeCompare(b.canonical)),
  };
}

// ---------------------------------------------------------------------------
// Local ollama extraction — one small conversation excerpt in, a bounded
// JSON topic array out. Cached on disk keyed by conversation content hash +
// recipe + model, so a re-run only pays for conversations it hasn't seen.
// ---------------------------------------------------------------------------

export function parseTopicResponse(text: string): string[] {
  const stripped = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/i, "");
  const start = stripped.indexOf("[");
  const end = stripped.lastIndexOf("]");
  if (start < 0 || end < start) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const seen = new Set<string>();
  const topics: string[] = [];
  for (const item of parsed) {
    if (typeof item !== "string") continue;
    const topic = normalizeTopic(item);
    if (topic.length < 2 || topic.length > 60 || seen.has(topic)) continue;
    seen.add(topic);
    topics.push(topic);
    if (topics.length === 5) break;
  }
  return topics;
}

// Long sessions (some run 300+ turns) would otherwise starve the excerpt on
// the opening turns and never reach later, often more specific, content —
// verified against a real conversation where the load-bearing detail (an
// Aker Solutions sensor-dashboard bachelor's project) only appeared past
// turn 100. Split the budget between the earliest turns (states the
// objective) and the most recent turns (states where it landed).
function relevantLines(conversation: Conversation): string[] {
  return conversation.turns
    .filter((turn) => turn.role === "user" || turn.role === "assistant")
    .map((turn) => ({ role: turn.role, text: redact(turn.content).trim() }))
    .filter((turn) => turn.text)
    .map((turn) => `[${turn.role}] ${turn.text.slice(0, 900)}`);
}

export function buildExtractionPrompt(conversation: Conversation): string {
  const parts: string[] = [];
  if (conversation.title) parts.push(`Title: ${redact(conversation.title)}`);
  const lines = relevantLines(conversation);
  const totalBudget = 3200;
  const headBudget = Math.ceil(totalBudget * 0.4);
  const tailBudget = totalBudget - headBudget;

  const head: string[] = [];
  let headUsed = 0;
  let headEnd = 0;
  for (const line of lines) {
    if (headUsed + line.length > headBudget) break;
    head.push(line);
    headUsed += line.length;
    headEnd++;
  }
  const tail: string[] = [];
  let tailUsed = 0;
  let tailStart = lines.length;
  for (let index = lines.length - 1; index >= headEnd; index--) {
    const line = lines[index]!;
    if (tailUsed + line.length > tailBudget) break;
    tail.unshift(line);
    tailUsed += line.length;
    tailStart = index;
  }
  parts.push(...head);
  if (tailStart > headEnd) parts.push("...[earlier turns omitted]...");
  parts.push(...tail);
  return [
    "Extract 2-5 SPECIFIC topics discussed in this conversation excerpt.",
    'Prefer concrete named technical or personal subjects over generic categories. Good: "btrfs-snapshot-retention", "restic-sftp-permission-denied", "hms-sensor-platform-direction". Bad: "infrastructure", "backup", "career".',
    "Output ONLY a JSON array of 2 to 5 lowercase kebab-case strings, nothing else.",
    "",
    "Conversation:",
    parts.join("\n\n"),
    "",
    "JSON array:",
  ].join("\n");
}

function cacheKey(conversationHash: string, model: string): string {
  return new Bun.CryptoHasher("sha256")
    .update(`${TOPIC_RECIPE}\0${model}\0${conversationHash}`)
    .digest("hex");
}

function cachePath(root: string, key: string): string {
  return join(root, "analysis", "vault-topic-cache", key.slice(0, 2), `${key}.json`);
}

async function atomicWrite(path: string, data: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, data);
  await rename(temp, path);
}

export async function extractTopics(
  root: string,
  conversation: Conversation,
  opts: { model?: string; endpoint?: string; fetchImpl?: typeof fetch } = {},
): Promise<TopicExtractionResult> {
  const model = opts.model ?? DEFAULT_MODEL;
  const endpoint = opts.endpoint ?? DEFAULT_ENDPOINT;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const key = cacheKey(conversation.contentHash, model);
  const path = cachePath(root, key);
  try {
    const cached = JSON.parse(await readFile(path, "utf8"));
    if (Array.isArray(cached.topics))
      return { ok: true, topics: cached.topics, model, cached: true, latencyMs: 0 };
  } catch (error: any) {
    if (error?.code !== "ENOENT")
      return {
        ok: false,
        topics: [],
        model,
        cached: false,
        latencyMs: 0,
        reason: `cache read failed: ${error?.message ?? String(error)}`,
      };
  }
  const prompt = buildExtractionPrompt(conversation);
  const started = performance.now();
  let response: Response;
  try {
    response = await fetchImpl(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model,
        prompt,
        stream: false,
        options: { temperature: 0, num_ctx: 8192, num_predict: 120 },
      }),
      signal: AbortSignal.timeout(90_000),
    });
  } catch (error: any) {
    return {
      ok: false,
      topics: [],
      model,
      cached: false,
      latencyMs: performance.now() - started,
      reason: `ollama request failed: ${error?.message ?? String(error)}`,
    };
  }
  const latencyMs = performance.now() - started;
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    return {
      ok: false,
      topics: [],
      model,
      cached: false,
      latencyMs,
      reason: `ollama ${response.status}: ${redact(body).slice(0, 200)}`,
    };
  }
  let envelope: any;
  try {
    envelope = JSON.parse(await response.text());
  } catch (error: any) {
    return {
      ok: false,
      topics: [],
      model,
      cached: false,
      latencyMs,
      reason: `invalid ollama response JSON: ${error?.message ?? String(error)}`,
    };
  }
  const topics = parseTopicResponse(String(envelope?.response ?? ""));
  if (!topics.length)
    return {
      ok: false,
      topics: [],
      model,
      cached: false,
      latencyMs,
      reason: "no parseable topics in model response",
    };
  await atomicWrite(
    path,
    JSON.stringify(
      { topics, model, recipe: TOPIC_RECIPE, extractedAt: new Date().toISOString(), latencyMs },
      null,
      2,
    ) + "\n",
  );
  return { ok: true, topics, model, cached: false, latencyMs };
}

// ---------------------------------------------------------------------------
// Note + topic-hub rendering (Hermes-compatible frontmatter/wikilink shape).
// ---------------------------------------------------------------------------

function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return slug || "untitled";
}

export function conversationTitle(conversation: Conversation): string {
  if (conversation.title?.trim()) return conversation.title.trim();
  const firstUser = conversation.turns.find((turn) => turn.role === "user" && turn.content.trim());
  if (firstUser) {
    const line = redact(firstUser.content).trim().split("\n")[0]!.slice(0, 80).trim();
    if (line) return line;
  }
  return `${conversation.harness} session`;
}

function safeDate(iso: string): string {
  const parsed = new Date(iso);
  return Number.isNaN(parsed.valueOf()) ? "00000000" : parsed.toISOString().slice(0, 10).replace(/-/g, "");
}

export function noteFilename(conversation: Conversation): string {
  return `${safeDate(conversation.startedAt)}-${slugify(conversationTitle(conversation))}-${conversation.contentHash.slice(0, 8)}.md`;
}

function roleLabel(role: string): string {
  if (role === "user") return "🧑 You";
  if (role === "assistant") return "🤖 Assistant";
  return `⚙️ ${role}`;
}

export function renderNote(conversation: Conversation, topics: string[]): string {
  const title = conversationTitle(conversation);
  const frontmatter = [
    "---",
    `date: ${conversation.startedAt}`,
    `updated: ${conversation.endedAt}`,
    `title: ${JSON.stringify(title)}`,
    `conversation_id: ${JSON.stringify(conversation.id)}`,
    `content_hash: ${conversation.contentHash}`,
    `harness: ${conversation.harness}`,
    `provider: ${conversation.provider}`,
    `message_count: ${conversation.turns.length}`,
    ...(topics.length ? [`topics: [${topics.map((topic) => `'${topic}'`).join(", ")}]`] : []),
    "---",
  ];
  const body: string[] = [`# ${title}`, ""];
  if (topics.length)
    body.push(`**Topics**: ${topics.map((topic) => `[[${topic}]]`).join(", ")}`, "");
  body.push(
    `**Date**: ${safeDate(conversation.startedAt)}  **Harness**: ${conversation.harness}  **Messages**: ${conversation.turns.length}`,
    "",
    "## Conversation",
    "",
  );
  for (const turn of conversation.turns) {
    if (turn.role !== "user" && turn.role !== "assistant") continue;
    const text = redact(turn.content).trim();
    const toolNote = turn.toolCalls?.length
      ? `\n\n*used tools: ${redact(turn.toolCalls.map((call) => call.name).join(", "))}*`
      : "";
    if (!text && !toolNote) continue;
    body.push(`### ${roleLabel(turn.role)}`, "", `${text}${toolNote}`, "");
  }
  return redact(`${frontmatter.join("\n")}\n\n${body.join("\n")}`);
}

export interface TopicBacklink {
  notePath: string;
  title: string;
  date: string;
}

export function renderTopicHub(topic: string, backlinks: TopicBacklink[]): string {
  const sorted = backlinks.toSorted((a, b) => a.date.localeCompare(b.date));
  const lines = [
    "---",
    `topic: ${JSON.stringify(topic)}`,
    `conversation_count: ${sorted.length}`,
    "---",
    "",
    `# ${topic}`,
    "",
    `${sorted.length} conversation${sorted.length === 1 ? "" : "s"} touch this topic.`,
    "",
    "## Conversations",
    "",
    ...sorted.map(
      (link) => `- [[${link.notePath.replace(/\.md$/, "")}|${redact(link.title)}]] (${link.date})`,
    ),
  ];
  return redact(lines.join("\n"));
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

export interface VaultOptions {
  limit?: number;
  since?: string;
  concurrency?: number;
  model?: string;
  endpoint?: string;
}

export interface VaultSummary {
  outputDir: string;
  candidates: number;
  notesWritten: number;
  skipped: number;
  extraction: {
    model: string;
    endpoint: string;
    ok: number;
    cached: number;
    failed: number;
    totalLatencyMs: number;
    averageLatencyMs: number;
  };
  vocabulary: {
    distinctRawTopics: number;
    distinctCanonicalTopics: number;
    topicHubsWritten: number;
    top20: Array<{ topic: string; count: number }>;
  };
  harnessCounts: Record<string, number>;
}

async function readCurrentHashes(root: string): Promise<string[]> {
  const text = await readFile(join(root, "derived", "current-hashes.jsonl"), "utf8");
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => (JSON.parse(line) as { conversationHash: string }).conversationHash);
}

async function loadConversation(root: string, hash: string): Promise<Conversation | undefined> {
  const path = join(root, "corpus", "objects", hash.slice(0, 2), `${hash}.json`);
  try {
    const conversation = JSON.parse(await readFile(path, "utf8")) as Conversation;
    return conversation.contentHash === hash ? conversation : undefined;
  } catch {
    return undefined;
  }
}

async function loadStartedAt(root: string, hash: string): Promise<string | undefined> {
  const path = join(root, "derived", "objects", hash.slice(0, 2), `${hash}.json`);
  try {
    const derived = JSON.parse(await readFile(path, "utf8")) as { startedAt?: string };
    return derived.startedAt;
  } catch {
    return undefined;
  }
}

async function mapPool<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = Array.from({ length: items.length });
  let cursor = 0;
  async function worker(): Promise<void> {
    for (let index = cursor++; index < items.length; index = cursor++) {
      results[index] = await fn(items[index]!);
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, worker));
  return results;
}

export async function emitVault(
  root: string,
  outputDir: string,
  opts: VaultOptions = {},
): Promise<VaultSummary> {
  const model = opts.model ?? DEFAULT_MODEL;
  const endpoint = opts.endpoint ?? DEFAULT_ENDPOINT;
  const concurrency = opts.concurrency ?? DEFAULT_CONCURRENCY;
  let candidates = await readCurrentHashes(root);
  if (opts.since) {
    const sinceMs = new Date(opts.since).valueOf();
    const filtered: string[] = [];
    for (const hash of candidates) {
      const startedAt = await loadStartedAt(root, hash);
      if (startedAt && new Date(startedAt).valueOf() >= sinceMs) filtered.push(hash);
    }
    candidates = filtered;
  }
  if (opts.limit != null) candidates = candidates.slice(0, opts.limit);

  const loaded = await mapPool(candidates, concurrency, async (hash) => {
    const conversation = await loadConversation(root, hash);
    if (!conversation || conversation.turns.length === 0) return undefined;
    const extraction = await extractTopics(root, conversation, { model, endpoint });
    return { conversation, extraction };
  });
  const entries = loaded.filter(
    (entry): entry is { conversation: Conversation; extraction: TopicExtractionResult } =>
      Boolean(entry),
  );

  const counts = new Map<string, number>();
  for (const entry of entries)
    if (entry.extraction.ok)
      for (const topic of entry.extraction.topics) counts.set(topic, (counts.get(topic) ?? 0) + 1);
  const { canonicalOf, clusters } = clusterTopics(counts);

  await mkdir(join(outputDir, "topics"), { recursive: true });
  const hubBacklinks = new Map<string, TopicBacklink[]>();
  const harnessCounts: Record<string, number> = {};
  let notesWritten = 0;
  for (const entry of entries) {
    const { conversation, extraction } = entry;
    harnessCounts[conversation.harness] = (harnessCounts[conversation.harness] ?? 0) + 1;
    const canonicalTopics = [
      ...new Set(extraction.topics.map((raw) => canonicalOf.get(raw) ?? raw)),
    ].toSorted();
    const filename = noteFilename(conversation);
    await writeFile(join(outputDir, filename), renderNote(conversation, canonicalTopics));
    notesWritten++;
    for (const topic of canonicalTopics) {
      const list = hubBacklinks.get(topic) ?? [];
      list.push({
        notePath: filename,
        title: conversationTitle(conversation),
        date: safeDate(conversation.startedAt),
      });
      hubBacklinks.set(topic, list);
    }
  }
  for (const [topic, backlinks] of hubBacklinks)
    await writeFile(join(outputDir, "topics", `${topic}.md`), renderTopicHub(topic, backlinks));

  const freshLatencies = entries
    .filter((entry) => entry.extraction.ok && !entry.extraction.cached)
    .map((entry) => entry.extraction.latencyMs);
  const totalLatencyMs = freshLatencies.reduce((sum, value) => sum + value, 0);

  return {
    outputDir,
    candidates: candidates.length,
    notesWritten,
    skipped: candidates.length - entries.length,
    extraction: {
      model,
      endpoint,
      ok: entries.filter((entry) => entry.extraction.ok).length,
      cached: entries.filter((entry) => entry.extraction.cached).length,
      failed: entries.filter((entry) => !entry.extraction.ok).length,
      totalLatencyMs,
      averageLatencyMs: freshLatencies.length ? totalLatencyMs / freshLatencies.length : 0,
    },
    vocabulary: {
      distinctRawTopics: counts.size,
      distinctCanonicalTopics: clusters.length,
      topicHubsWritten: hubBacklinks.size,
      top20: clusters.slice(0, 20).map((cluster) => ({ topic: cluster.canonical, count: cluster.count })),
    },
    harnessCounts,
  };
}
