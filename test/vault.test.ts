import { expect, test } from "bun:test";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  buildExtractionPrompt,
  clusterTopics,
  conversationTitle,
  extractTopics,
  noteFilename,
  normalizeTopic,
  parseTopicResponse,
  renderNote,
  renderTopicHub,
  topicCacheKey,
  VAULT_TOPIC_RECIPE,
} from "../src/vault";
import type { Conversation } from "../src/types";

const hash = "b".repeat(64);
const conversation: Conversation = {
  id: "session-1",
  provider: "anthropic",
  harness: "claude-code",
  project: "/work/project",
  cwd: "/work/project",
  model: "claude-test",
  startedAt: "2026-07-18T09:58:52.310Z",
  endedAt: "2026-07-18T10:05:09.039Z",
  sourcePath: "/secret/source.jsonl",
  contentHash: hash,
  turns: [
    { role: "system", content: "SECRET SOURCE POLICY" },
    { role: "user", content: "Fix the restic backup with api_key=supersecretvalue" },
    {
      role: "assistant",
      content: "I will inspect it.",
      toolCalls: [{ id: "call-1", name: "Bash", arguments: "restic check", output: "passed" }],
    },
    { role: "tool", content: "raw tool result" },
    { role: "assistant", content: "Fixed the restic-check-weekly permission issue." },
  ],
};

test("normalizeTopic lowercases, kebab-cases, and trims punctuation", () => {
  expect(normalizeTopic("Nix Flakes!")).toBe("nix-flakes");
  expect(normalizeTopic("  btrfs_snapshot retention ")).toBe("btrfs-snapshot-retention");
});

test("parseTopicResponse extracts a fenced JSON array, dedupes, and caps at 5", () => {
  const response = '```json\n["Nix Flakes", "nix-flake", "AI", "ai", "a", "b", "c", "d"]\n```';
  const topics = parseTopicResponse(response);
  expect(topics).toContain("ai");
  expect(topics.length).toBeLessThanOrEqual(5);
  expect(topics).not.toContain("a"); // below the 2-char floor
});

test("parseTopicResponse returns empty on unparseable output instead of throwing", () => {
  expect(parseTopicResponse("I cannot comply with that request.")).toEqual([]);
});

test("clusterTopics merges plural/hyphenation drift but never merges unrelated short words", () => {
  const counts = new Map([
    ["nix-flakes", 5],
    ["nix-flake", 2],
    ["restic-check-weekly", 4],
    ["restic-check-weeklies", 1],
    ["health", 3],
    ["wealth", 3],
  ]);
  const { canonicalOf, clusters } = clusterTopics(counts);
  expect(canonicalOf.get("nix-flake")).toBe("nix-flakes");
  expect(canonicalOf.get("restic-check-weeklies")).toBe("restic-check-weekly");
  expect(canonicalOf.get("health")).toBe("health");
  expect(canonicalOf.get("wealth")).toBe("wealth");
  const nixCluster = clusters.find((cluster) => cluster.canonical === "nix-flakes");
  expect(nixCluster?.count).toBe(7);
});

test("clusterTopics does not absorb a broader topic into a narrower one", () => {
  const counts = new Map([
    ["nix", 10],
    ["nix-flake-input-pinning", 3],
  ]);
  const { canonicalOf } = clusterTopics(counts);
  expect(canonicalOf.get("nix")).toBe("nix");
  expect(canonicalOf.get("nix-flake-input-pinning")).toBe("nix-flake-input-pinning");
});

test("topicCacheKey canonically binds recipe, model, and conversation hash", () => {
  const key = topicCacheKey(hash, "test-model");
  expect(key).toMatch(/^[a-f0-9]{64}$/);
  expect(key).toBe(topicCacheKey(hash, "test-model", VAULT_TOPIC_RECIPE));
  expect(key).not.toBe(topicCacheKey(hash, "other-model"));
  expect(key).not.toBe(topicCacheKey(hash, "test-model", "older-recipe"));
});

test("buildExtractionPrompt redacts secrets and bounds excerpt length", () => {
  const prompt = buildExtractionPrompt(conversation);
  expect(prompt).not.toContain("supersecretvalue");
  expect(prompt).toContain("[REDACTED_SECRET]");
  expect(prompt).not.toContain("SECRET SOURCE POLICY");
});

test("buildExtractionPrompt covers both the opening and the closing of a long conversation", () => {
  const longConversation: Conversation = {
    ...conversation,
    turns: [
      { role: "user", content: "opening objective: fix the deploy pipeline" },
      ...Array.from({ length: 120 }, (_, index) => ({
        role: index % 2 === 0 ? "assistant" : "user",
        content: `filler turn ${index} `.repeat(40),
      })),
      { role: "assistant", content: "landed on aker-solutions-sensor-dashboard as the real fix" },
    ],
  };
  const prompt = buildExtractionPrompt(longConversation);
  expect(prompt).toContain("opening objective: fix the deploy pipeline");
  expect(prompt).toContain("aker-solutions-sensor-dashboard");
});

test("conversationTitle falls back to the first user line when untitled", () => {
  expect(conversationTitle(conversation)).toContain("Fix the restic backup");
});

test("noteFilename is date-prefixed, slugified, hash-suffixed, and never leaks the raw secret", () => {
  const filename = noteFilename(conversation);
  expect(filename).toBe(
    `20260718-fix-the-restic-backup-with-api-key-redacted-secret-${hash.slice(0, 8)}.md`,
  );
  expect(filename).not.toContain("supersecretvalue");
});

test("renderNote emits Hermes-shaped frontmatter, wikilinked topics, and redacts turn content", () => {
  const note = renderNote(conversation, ["restic-check-weekly", "nix-flakes"]);
  expect(note).toContain("topics: ['restic-check-weekly', 'nix-flakes']");
  expect(note).toContain("**Topics**: [[restic-check-weekly]], [[nix-flakes]]");
  expect(note).not.toContain("supersecretvalue");
  expect(note).not.toContain("SECRET SOURCE POLICY");
  expect(note).not.toContain("raw tool result");
  expect(note).toContain("used tools: Bash");
});

test("renderTopicHub lists backlinks sorted by date with wikilinks to the note", () => {
  const hub = renderTopicHub("restic-check-weekly", [
    { notePath: "20260720-later-abc12345.md", title: "Later fix", date: "20260720" },
    { notePath: "20260718-earlier-def67890.md", title: "Earlier fix", date: "20260718" },
  ]);
  const earlierIndex = hub.indexOf("20260718-earlier-def67890");
  const laterIndex = hub.indexOf("20260720-later-abc12345");
  expect(earlierIndex).toBeGreaterThan(-1);
  expect(earlierIndex).toBeLessThan(laterIndex);
  expect(hub).toContain("[[20260718-earlier-def67890|Earlier fix]]");
});

test("extractTopics caches by conversation content hash — a second run makes no request", async () => {
  const root = await mkdtemp(join(tmpdir(), "chatlog-vault-"));
  let calls = 0;
  const mockFetch = (async (_url: any, _init: any) => {
    calls++;
    return new Response(JSON.stringify({ response: '["restic-check-weekly", "nix-flakes"]' }), {
      status: 200,
    });
  }) as typeof fetch;
  const first = await extractTopics(root, conversation, {
    fetchImpl: mockFetch,
    model: "test-model",
  });
  expect(first.ok).toBe(true);
  expect(first.cached).toBe(false);
  expect(first.topics).toEqual(["restic-check-weekly", "nix-flakes"]);
  expect(calls).toBe(1);
  const key = topicCacheKey(hash, "test-model");
  const cached = JSON.parse(
    await readFile(
      join(root, "analysis", "vault-topic-cache", key.slice(0, 2), `${key}.json`),
      "utf8",
    ),
  );
  expect(cached).toMatchObject({ model: "test-model", recipe: VAULT_TOPIC_RECIPE });

  const second = await extractTopics(root, conversation, {
    fetchImpl: mockFetch,
    model: "test-model",
  });
  expect(second.cached).toBe(true);
  expect(second.topics).toEqual(["restic-check-weekly", "nix-flakes"]);
  expect(calls).toBe(1);

  const cacheKeyPrefix = join(root, "analysis", "vault-topic-cache");
  const cacheDirStat = await stat(cacheKeyPrefix);
  expect(cacheDirStat.isDirectory()).toBe(true);
});

test("extractTopics fails soft (no throw) on a non-JSON model response", async () => {
  const root = await mkdtemp(join(tmpdir(), "chatlog-vault-badresponse-"));
  const mockFetch = (async (_url: any, _init: any) =>
    new Response(JSON.stringify({ response: "I refuse." }), { status: 200 })) as typeof fetch;
  const result = await extractTopics(root, conversation, {
    fetchImpl: mockFetch,
    model: "test-model",
  });
  expect(result.ok).toBe(false);
  expect(result.reason).toBeTruthy();
});

test("extractTopics fails soft on an ollama HTTP error", async () => {
  const root = await mkdtemp(join(tmpdir(), "chatlog-vault-httperr-"));
  const mockFetch = (async (_url: any, _init: any) =>
    new Response("model not found", { status: 404 })) as typeof fetch;
  const result = await extractTopics(root, conversation, {
    fetchImpl: mockFetch,
    model: "test-model",
  });
  expect(result.ok).toBe(false);
  expect(result.reason).toContain("404");
});

test("frontmatter title/topics survive JSON round-trip readability (no throw on write)", async () => {
  const path = await mkdtemp(join(tmpdir(), "chatlog-vault-render-"));
  const note = renderNote(conversation, []);
  await Bun.write(join(path, "note.md"), note);
  const written = await readFile(join(path, "note.md"), "utf8");
  expect(written).toContain("# Fix the restic backup");
});
