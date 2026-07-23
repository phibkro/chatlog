import { expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";
import { adaptAnthropicConversation, importAnthropicExport } from "../src/importers/anthropic-export";

const fixture = {
  uuid: "conversation-1",
  name: "A broader idea",
  created_at: "2025-01-01T10:00:00Z",
  updated_at: "2025-01-01T10:02:00Z",
  chat_messages: [
    {
      uuid: "message-1",
      sender: "human",
      created_at: "2025-01-01T10:00:00Z",
      content: [{ type: "text", text: "Explore this idea with sk-ant-abcdefghijklmnop" }],
      attachments: [{ file_name: "notes.pdf", file_type: "application/pdf", extracted_content: "not indexed by default" }],
    },
    {
      uuid: "message-2",
      sender: "assistant",
      created_at: "2025-01-01T10:01:00Z",
      content: [
        { type: "thinking", thinking: "private model scratchpad" },
        { type: "text", text: "I would begin with a small experiment." },
        { type: "tool_use", id: "tool-1", name: "search", input: { query: "evidence" } },
      ],
    },
    {
      uuid: "message-3",
      sender: "assistant",
      created_at: "2025-01-01T10:02:00Z",
      content: [{ type: "tool_result", tool_use_id: "tool-1", content: "result" }],
    },
  ],
};

test("adapts Claude Web exports without indexing thinking or attachment bodies", () => {
  const conversation = adaptAnthropicConversation("/export.zip", fixture as any, " Personal ");
  expect(conversation).toMatchObject({
    id: "conversation-1",
    title: "A broader idea",
    harness: "claude-web",
    domain: "personal",
    sourceKind: "anthropic-data-export",
    project: "Claude Web",
  });
  expect(conversation.turns[0].content).toContain("[REDACTED_API_KEY]");
  expect(conversation.turns[0].content).toContain("[Attachment: notes.pdf");
  expect(JSON.stringify(conversation)).not.toContain("not indexed by default");
  expect(JSON.stringify(conversation)).not.toContain("private model scratchpad");
  expect(conversation.turns[1].toolCalls?.[0]).toMatchObject({ name: "search", output: "result" });
  expect(() => adaptAnthropicConversation("/export.zip", fixture as any, "*"))
    .toThrow("invalid conversation domain");
});

test("imports an extracted Anthropic export idempotently", async () => {
  const base = await mkdtemp(join(tmpdir(), "chatlog-anthropic-export-"));
  const source = join(base, "source");
  const root = join(base, "chatlog");
  await mkdir(source);
  await writeFile(join(source, "conversations.json"), JSON.stringify([fixture]));

  const first = await importAnthropicExport(source, root, { domain: "ideas", derive: false });
  expect(first).toMatchObject({ discovered: 1, imported: 1, skipped: 0, turns: 2, attachments: 1 });
  const second = await importAnthropicExport(source, root, { domain: "ideas", derive: false });
  expect(second).toMatchObject({ discovered: 1, imported: 0, skipped: 1 });

  const manifest = JSON.parse(await readFile(join(root, "corpus", "manifest.json"), "utf8"));
  const hash = Object.values(manifest.sources)[0] as { contentHash: string };
  const canonical = JSON.parse(await readFile(join(root, "corpus", "objects", hash.contentHash.slice(0, 2), `${hash.contentHash}.json`), "utf8"));
  expect(canonical).toMatchObject({ title: "A broader idea", domain: "ideas", harness: "claude-web" });

  const db = new Database(join(root, "analysis", "chatlog.sqlite"), { readonly: true });
  expect(db.query("SELECT title, domain, source_kind FROM current_conversations").get()).toEqual({
    title: "A broader idea",
    domain: "ideas",
    source_kind: "anthropic-data-export",
  });
  db.close();
});
