import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { deriveConversation, deriveCorpus, serializeDerived } from "../src/derive";
import type { Conversation } from "../src/types";

function fixture(contentHash: string, sourcePath: string): Conversation {
  return {
    id: contentHash.slice(0, 8), provider: "openai", harness: "codex", project: "/project", cwd: "/project",
    model: "model", startedAt: "2026-07-01T00:00:00Z", endedAt: "2026-07-01T00:01:00Z",
    sourcePath, contentHash,
    turns: [
      { role: "user", content: "Fix the broken DuckDB query" },
      { role: "assistant", content: "I decided to use a projection because it avoids rescanning text", toolCalls: [{ name: "exec" }] },
      { role: "tool", content: "tests passed; exit code 0" },
      { role: "assistant", content: "Fixed and verified." },
    ],
  };
}

test("derived structure is deterministic and pointer-based", () => {
  const conversation = fixture("a".repeat(64), "/source-a");
  const first = deriveConversation(conversation);
  expect(deriveConversation(conversation)).toEqual(first);
  expect(first.decisions[0].pointer.uri).toContain(conversation.contentHash);
  expect(first.outcome.status).toBe("success");
  expect(JSON.stringify(first)).not.toContain("processedAt");
  const malformed = deriveConversation({ ...conversation, turns: [{ role: "user", content: "bad \ud800 value" }] });
  expect(serializeDerived(malformed)).not.toContain("\\ud800");
});

test("derive manifest skips unchanged hashes and processes only additions", async () => {
  const root = await mkdtemp(join(tmpdir(), "chatlog-derive-"));
  const first = fixture("a".repeat(64), "/source-a");
  await mkdir(join(root, "corpus", "objects", "aa"), { recursive: true });
  await writeFile(join(root, "corpus", "objects", "aa", `${first.contentHash}.json`), JSON.stringify(first));
  await writeFile(join(root, "corpus", "manifest.json"), JSON.stringify({ version: 1, sources: { [first.sourcePath]: { contentHash: first.contentHash } } }));
  expect(await deriveCorpus(root)).toMatchObject({ discovered: 1, processed: 1, skipped: 0 });
  expect(await deriveCorpus(root)).toMatchObject({ discovered: 1, processed: 0, skipped: 1, recipeChanged: false });

  const second = fixture("b".repeat(64), "/source-b");
  await mkdir(join(root, "corpus", "objects", "bb"), { recursive: true });
  await writeFile(join(root, "corpus", "objects", "bb", `${second.contentHash}.json`), JSON.stringify(second));
  await writeFile(join(root, "corpus", "manifest.json"), JSON.stringify({ version: 1, sources: {
    [first.sourcePath]: { contentHash: first.contentHash }, [second.sourcePath]: { contentHash: second.contentHash },
  } }));
  expect(await deriveCorpus(root)).toMatchObject({ discovered: 2, processed: 1, skipped: 1 });
  const manifest = JSON.parse(await readFile(join(root, "derived", "manifest.json"), "utf8"));
  expect(Object.keys(manifest.conversations)).toHaveLength(2);
  expect(manifest.currentProjection.contentHash).toHaveLength(64);
});
