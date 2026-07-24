import { expect, test } from "bun:test";
import {
  mkdtemp,
  mkdir,
  readFile,
  rmdir,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";
import {
  adaptAnthropicConversation,
  importAnthropicExport,
  previewAnthropicExport,
} from "../src/importers/anthropic-export";
import { listImportReceipts } from "../src/import-receipts";

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

  const preview = await previewAnthropicExport(source, root, { domain: " Ideas " });
  expect(preview).toMatchObject({
    schema: "chatlog/anthropic-import-preview-v1",
    advisory: true,
    domain: "ideas",
    ready: true,
    discovered: 1,
    importable: 1,
    invalid: 0,
    new: 1,
    changed: 0,
    reclassified: 0,
    unchanged: 0,
    wouldImport: 1,
    turns: 2,
    attachments: 1,
    files: 0,
    exclusions: {
      modelThinking: true,
      attachmentBodies: true,
      claudeProjects: true,
      memories: true,
    },
  });
  expect(preview.receiptId).toHaveLength(64);
  expect(preview.proposalId).toHaveLength(64);
  expect(preview.sourceContentHash).toHaveLength(64);
  expect(await Bun.file(join(root, "corpus", "manifest.json")).exists()).toBe(false);
  expect(await Bun.file(join(root, "analysis", "chatlog.sqlite")).exists()).toBe(false);
  expect((await previewAnthropicExport(source, root, { domain: "ideas" })).receiptId)
    .toBe(preview.receiptId);

  const first = await importAnthropicExport(source, root, { domain: "ideas", derive: false });
  expect(first).toMatchObject({ discovered: 1, imported: 1, skipped: 0, turns: 2, attachments: 1 });
  expect(first.receipt).toMatchObject({
    schema: "chatlog/import-receipt-v1",
    operation: "import",
    connector: "anthropic-export",
    status: "completed",
    policy: {
      domain: "ideas",
      redaction: "canonical",
      exclusions: {
        modelThinking: true,
        attachmentBodies: true,
        claudeProjects: true,
        memories: true,
      },
    },
    counts: { discovered: 1, imported: 1, skipped: 0, turns: 2, attachments: 1, files: 0 },
    manifest: { beforeSources: 0, afterSources: 1, added: 1, replaced: 0, unchanged: 0 },
    derivation: { enabled: false, status: "not-requested" },
  });
  expect(first.receipt.receiptId).toHaveLength(64);
  expect(first.receipt.source.contentHash).toHaveLength(64);
  const persistedFirst = await listImportReceipts(root);
  expect(persistedFirst).toEqual([first.receipt]);
  expect(JSON.stringify(persistedFirst)).not.toContain("Explore this idea");
  expect(JSON.stringify(persistedFirst)).not.toContain("small experiment");
  expect(await previewAnthropicExport(source, root, { domain: "ideas" })).toMatchObject({
    new: 0,
    changed: 0,
    reclassified: 0,
    unchanged: 1,
    wouldImport: 0,
  });
  const reclassificationPreview = await previewAnthropicExport(source, root, { domain: "personal" });
  expect(reclassificationPreview).toMatchObject({
    new: 0,
    changed: 0,
    reclassified: 1,
    unchanged: 0,
    wouldImport: 1,
  });
  expect(reclassificationPreview.proposalId).not.toBe(preview.proposalId);
  expect((await previewAnthropicExport(source, root, { domain: "ideas" })).receiptId)
    .not.toBe(preview.receiptId);
  const second = await importAnthropicExport(source, root, { domain: "ideas", derive: false });
  expect(second).toMatchObject({ discovered: 1, imported: 0, skipped: 1 });
  expect(second.receipt).toMatchObject({
    counts: { imported: 0, skipped: 1 },
    manifest: { beforeSources: 1, afterSources: 1, added: 0, replaced: 0, unchanged: 1 },
  });
  expect(second.receipt.receiptId).not.toBe(first.receipt.receiptId);
  expect(await listImportReceipts(root)).toHaveLength(2);

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

test("records bounded derivation completion without artifact paths", async () => {
  const base = await mkdtemp(join(tmpdir(), "chatlog-anthropic-derived-"));
  const source = join(base, "source");
  const root = join(base, "chatlog");
  await mkdir(source);
  await writeFile(join(source, "conversations.json"), JSON.stringify([fixture]));

  const result = await importAnthropicExport(source, root, { domain: "ideas" });
  expect(result.receipt.derivation).toMatchObject({
    enabled: true,
    status: "completed",
    derived: { discovered: 1, processed: 1, skipped: 0 },
    refinery: { inputConversations: 1, candidates: 0, processed: true },
  });
  const receiptText = JSON.stringify(result.receipt);
  expect(receiptText).not.toContain("manifestPath");
  expect(receiptText).not.toContain("artifactPath");
});

test("records the committed manifest transition when derivation fails", async () => {
  const base = await mkdtemp(join(tmpdir(), "chatlog-anthropic-derive-failure-"));
  const source = join(base, "source");
  const root = join(base, "chatlog");
  await mkdir(source);
  await writeFile(join(source, "conversations.json"), JSON.stringify([fixture]));
  const invalidHash = "0".repeat(64);
  await mkdir(join(root, "corpus", "objects", "00"), { recursive: true });
  await writeFile(
    join(root, "corpus", "objects", "00", `${invalidHash}.json`),
    "{not valid JSON",
  );

  await expect(importAnthropicExport(source, root, { domain: "ideas" }))
    .rejects.toThrow("import committed as receipt");
  const [receipt] = await listImportReceipts(root);
  expect(receipt).toMatchObject({
    status: "completed",
    counts: { imported: 1, skipped: 0 },
    manifest: { beforeSources: 0, afterSources: 1, added: 1 },
    derivation: { enabled: true, status: "failed" },
  });
  const manifest = JSON.parse(await readFile(join(root, "corpus", "manifest.json"), "utf8"));
  expect(Object.keys(manifest.sources)).toHaveLength(1);
});

test("does not advance authority when journal preparation fails", async () => {
  const base = await mkdtemp(join(tmpdir(), "chatlog-anthropic-commit-failure-"));
  const source = join(base, "source");
  const root = join(base, "chatlog");
  await mkdir(source);
  await writeFile(join(source, "conversations.json"), JSON.stringify([fixture]));
  await importAnthropicExport(source, root, { domain: "ideas", derive: false });
  const manifestPath = join(root, "corpus", "manifest.json");
  const manifestBefore = await readFile(manifestPath, "utf8");
  const receiptsBefore = await listImportReceipts(root);
  const dbPath = join(root, "analysis", "chatlog.sqlite");
  const beforeDb = new Database(dbPath, { readonly: true });
  const activeBefore = beforeDb.query(
    "SELECT content_hash contentHash FROM current_conversations",
  ).get();
  beforeDb.close();

  await writeFile(
    join(source, "conversations.json"),
    JSON.stringify([{ ...fixture, name: "A changed idea" }]),
  );
  const pendingDirectory = join(root, "operations", "pending");
  await rmdir(pendingDirectory);
  await writeFile(pendingDirectory, "blocks operation journal");
  try {
    await expect(importAnthropicExport(source, root, { domain: "ideas", derive: false }))
      .rejects.toThrow();
  } finally {
    await unlink(pendingDirectory);
    await mkdir(pendingDirectory, { mode: 0o700 });
  }

  expect(await readFile(manifestPath, "utf8")).toBe(manifestBefore);
  expect(await listImportReceipts(root)).toEqual(receiptsBefore);
  const afterDb = new Database(dbPath, { readonly: true });
  expect(afterDb.query(
    "SELECT content_hash contentHash FROM current_conversations",
  ).get()).toEqual(activeBefore);
  expect(afterDb.query("SELECT count(*) count FROM conversations").get())
    .toEqual({ count: 1 });
  afterDb.close();
});
