import { expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  adaptChatGPTConversation,
  importChatGPTExport,
  parseChatGPTConversation,
  previewChatGPTExport,
  readChatGPTExport,
} from "../src/importers/chatgpt-export";
import { readEventBatch } from "../src/event-store";

// Fixture provenance: fresh inert synthetic data informed by the source-verified
// MIT parser report (jcollins-bioinfo/chatgpt-archive-compiler 0.4.0a2,
// commit 64bd7ce; no private export or upstream transcript text is copied).
const fixturePath = new URL("./fixtures/providers/chatgpt/conversations.json", import.meta.url)
  .pathname;

test("schema reader preserves graph nodes, declared branch, and opaque metadata", async () => {
  const result = await readChatGPTExport(fixturePath);
  expect(result.conversations).toHaveLength(2);
  const branched = result.conversations.find(
    (conversation) => conversation.id === "synthetic-branched-001",
  )!;
  expect(Object.keys(branched.mapping)).toHaveLength(6);
  expect(branched.currentPathNodeIds).toEqual(["branch-root", "branch-u1", "branch-current"]);
  expect(branched.mapping["branch-alternate"]?.message?.textParts).toEqual([
    "alternate synthetic answer",
  ]);
  expect(branched.mapping["branch-u1"]?.message?.attachments[0]).toMatchObject({
    id: "synthetic-asset-001",
    mime_type: "image/png",
  });
  expect(branched.sourceExtras.fixture_extension).toEqual({ synthetic: true });
  expect(branched.mapping["branch-u1"]?.message?.sourceExtras.future_message_field).toEqual({
    keep: true,
  });
});

test("missing current node fails closed without discarding mapping evidence", () => {
  const source = {
    id: "missing-current",
    mapping: {
      root: { id: "root", parent: null, children: ["u"], message: null },
      u: {
        id: "u",
        parent: "root",
        children: [],
        message: {
          id: "m-u",
          author: { role: "user" },
          content: { content_type: "text", parts: ["synthetic"] },
        },
      },
    },
  };
  const parsed = parseChatGPTConversation(source, "synthetic.json");
  expect(parsed.currentPathNodeIds).toEqual([]);
  expect(parsed.mapping.u).toBeDefined();
  expect(parsed.warnings.some((warning) => warning.code === "missing_current_node")).toBe(true);
  expect(adaptChatGPTConversation("synthetic.json", parsed, "personal").turns).toEqual([]);
});

test("preview is aggregate-only and creates no corpus, event, or receipt state", async () => {
  const root = await mkdtemp(join(tmpdir(), "chatlog-chatgpt-preview-"));
  const summary = await previewChatGPTExport(fixturePath, root, { domain: "personal" });
  expect(summary.advisory).toBe(true);
  expect(summary.messages).toBeGreaterThan(0);
  expect(summary.attachments).toBe(1);
  expect(summary.new).toBe(2);
  expect(await readdir(root)).toHaveLength(0);
});

test("import preserves alternate branches, receipts, and idempotence", async () => {
  const root = await mkdtemp(join(tmpdir(), "chatlog-chatgpt-import-"));
  const first = await importChatGPTExport(fixturePath, root, { domain: "personal", derive: false });
  expect(first.imported).toBe(2);
  expect(first.receipts).toHaveLength(2);
  const second = await importChatGPTExport(fixturePath, root, {
    domain: "personal",
    derive: false,
  });
  expect(second.skipped).toBe(2);
  const batch = await readEventBatch(root, first.receipts[1]!.eventBatchHash);
  expect(batch.events.some((event) => event.payload.nodeId === "branch-alternate")).toBe(true);
  expect(JSON.stringify(batch)).toContain("file-service://synthetic-asset-001");
});

test("source changes during read fail before import state is committed", async () => {
  const root = await mkdtemp(join(tmpdir(), "chatlog-chatgpt-change-"));
  const copy = join(root, "conversations.json");
  const original = await readFile(fixturePath, "utf8");
  await writeFile(copy, original);
  await expect(
    readChatGPTExport(copy, {
      beforeVerification: async () => {
        await writeFile(copy, `${original}\n`);
      },
    }),
  ).rejects.toThrow("source changed while it was being read");
});

test("dangling parents remain evidence and produce an empty visible projection", () => {
  const source = {
    id: "dangling-parent",
    current_node: "answer",
    mapping: {
      root: { id: "root", parent: null, children: ["answer"], message: null },
      answer: {
        id: "answer",
        parent: "missing-parent",
        children: [],
        message: {
          id: "m-answer",
          author: { role: "assistant" },
          content: { content_type: "text", parts: ["synthetic answer"] },
        },
      },
    },
  };
  const parsed = parseChatGPTConversation(source, "synthetic-dangling.json");
  expect(parsed.mapping.answer).toBeDefined();
  expect(parsed.currentPathNodeIds).toEqual([]);
  expect(parsed.warnings.some((warning) => warning.code === "dangling_parent")).toBe(true);
  expect(adaptChatGPTConversation("synthetic-dangling.json", parsed, "personal").turns).toEqual([]);
});

test("domain-only changes are classified as reclassification", async () => {
  const root = await mkdtemp(join(tmpdir(), "chatlog-chatgpt-reclassify-"));
  await importChatGPTExport(fixturePath, root, { domain: "personal", derive: false });
  const preview = await previewChatGPTExport(fixturePath, root, { domain: "research" });
  expect(preview.reclassified).toBe(2);
});
