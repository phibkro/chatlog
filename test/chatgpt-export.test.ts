import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, symlink, truncate, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  CHATGPT_MAX_CONTENT_PARTS,
  CHATGPT_MAX_CONTENT_PARTS_PER_MESSAGE,
  CHATGPT_MAX_DIRECTORY_DEPTH,
  CHATGPT_MAX_DIRECTORY_ENTRIES,
  CHATGPT_MAX_MANIFEST_BYTES,
  CHATGPT_MAX_MAPPING_CHILDREN_EDGES,
  CHATGPT_MAX_MAPPING_CHILDREN_PER_NODE,
  adaptChatGPTConversation,
  adaptChatGPTEventBatch,
  importChatGPTExport,
  parseChatGPTConversation,
  previewChatGPTExport,
  readChatGPTExport,
  type ChatGPTImportOptions,
} from "../src/importers/chatgpt-export";
import { readEventBatch } from "../src/event-store";
import {
  createOperationIntent,
  listPendingOperationIntents,
  recoverPendingOperations,
} from "../src/operation-intents";
import type { CorpusManifest } from "../src/source-authority";

// Fixture provenance: fresh inert synthetic data informed by the source-verified
// MIT parser report (jcollins-bioinfo/chatgpt-archive-compiler 0.4.0a2,
// commit 64bd7ce; no private export or upstream transcript text is copied).
const fixturePath = new URL("./fixtures/providers/chatgpt/conversations.json", import.meta.url)
  .pathname;
const emptyZip =
  "UEsDBAoDAAAAAJxRBF0pu0wNAgAAAAIAAAASAAAAY29udmVyc2F0aW9ucy5qc29uW11QSwECPwMKAwAAAACcUQRdKbtMDQIAAAACAAAAEgAkAAAAAAAAACCApIEAAAAAY29udmVyc2F0aW9ucy5qc29uCgAgAAAAAAABABgAgB1kDekj3QGAHWQN6SPdAYAdZA3pI90BUEsFBgAAAAABAAEAZAAAADIAAAAAAA==";

async function importPreviewedChatGPT(
  root: string,
  options: Omit<ChatGPTImportOptions, "preview">,
) {
  const preview = await previewChatGPTExport(fixturePath, root, { domain: options.domain });
  return importChatGPTExport(fixturePath, root, { ...options, preview });
}

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

test("reads conversation members from ZIP archives", async () => {
  const root = await mkdtemp(join(tmpdir(), "chatlog-chatgpt-zip-"));
  const archive = join(root, "export.zip");
  await writeFile(archive, Buffer.from(emptyZip, "base64"));
  const result = await readChatGPTExport(archive);
  expect(result.members.map((member) => member.text)).toEqual(["[]"]);
  expect(result.conversations).toEqual([]);
});

test("rejects symlinked export members before reading them", async () => {
  const root = await mkdtemp(join(tmpdir(), "chatlog-chatgpt-symlink-"));
  const source = join(root, "export");
  await mkdir(source);
  await symlink(fixturePath, join(source, "conversations.json"));
  await expect(readChatGPTExport(source)).rejects.toThrow();
});

test("bounds ignored directory entries before candidate filtering", async () => {
  const root = await mkdtemp(join(tmpdir(), "chatlog-chatgpt-directory-entries-"));
  const source = join(root, "export");
  await mkdir(source);
  await writeFile(join(source, "conversations.json"), "[]");
  await Promise.all(
    Array.from({ length: CHATGPT_MAX_DIRECTORY_ENTRIES }, (_, index) =>
      writeFile(join(source, `ignored-${index}.json`), "[]"),
    ),
  );
  await expect(readChatGPTExport(source)).rejects.toThrow(/entry limit/u);
});

test("rejects directory traversal beyond the explicit depth ceiling", async () => {
  const root = await mkdtemp(join(tmpdir(), "chatlog-chatgpt-directory-depth-"));
  const source = join(root, "export");
  await mkdir(source);
  let nested = source;
  for (let depth = 0; depth <= CHATGPT_MAX_DIRECTORY_DEPTH; depth += 1) {
    nested = join(nested, `nested-${depth}`);
    await mkdir(nested);
  }
  await writeFile(join(nested, "conversations.json"), "[]");
  await expect(readChatGPTExport(source)).rejects.toThrow(/depth limit/u);
});

test("rejects symlinked directories before traversal", async () => {
  const root = await mkdtemp(join(tmpdir(), "chatlog-chatgpt-directory-symlink-"));
  const source = join(root, "export");
  const target = join(root, "target");
  await mkdir(source);
  await mkdir(target);
  await writeFile(join(target, "conversations.json"), "[]");
  await symlink(target, join(source, "linked"));
  await expect(readChatGPTExport(source)).rejects.toThrow(/symlink/u);
});

test("rejects deeply nested ChatGPT records before adaptation", () => {
  let nested: Record<string, unknown> = { value: "leaf" };
  for (let depth = 0; depth < 40; depth += 1) nested = { nested };
  const conversation = {
    id: "synthetic-deep",
    mapping: {
      root: {
        id: "root",
        parent: null,
        children: [],
        message: {
          id: "message-root",
          author: { role: "user" },
          content: { content_type: "text", parts: ["bounded"] },
        },
      },
    },
    nested,
  };
  expect(() => parseChatGPTConversation(conversation)).toThrow(/nested depth/u);
});

test("rejects aggregate ChatGPT content parts before adaptation", () => {
  const nodeCount =
    Math.floor(CHATGPT_MAX_CONTENT_PARTS / CHATGPT_MAX_CONTENT_PARTS_PER_MESSAGE) + 1;
  const mapping = Object.fromEntries(
    Array.from({ length: nodeCount }, (_, index) => {
      const id = `parts-${index}`;
      return [
        id,
        {
          id,
          parent: null,
          children: [],
          message: {
            id: `message-${id}`,
            author: { role: "user" },
            content: {
              content_type: "text",
              parts: Array.from({ length: CHATGPT_MAX_CONTENT_PARTS_PER_MESSAGE }, () => "part"),
            },
          },
        },
      ];
    }),
  );
  expect(() => parseChatGPTConversation({ id: "parts-limit", mapping })).toThrow(
    /conversation limit/u,
  );
});

test("rejects aggregate ChatGPT mapping child edges before adaptation", () => {
  const nodeCount =
    Math.floor(CHATGPT_MAX_MAPPING_CHILDREN_EDGES / CHATGPT_MAX_MAPPING_CHILDREN_PER_NODE) + 1;
  const mapping = Object.fromEntries(
    Array.from({ length: nodeCount }, (_, index) => {
      const id = `edges-${index}`;
      return [
        id,
        {
          id,
          parent: null,
          children: Array.from(
            { length: CHATGPT_MAX_MAPPING_CHILDREN_PER_NODE },
            (_, childIndex) => `child-${childIndex}`,
          ),
          message: null,
        },
      ];
    }),
  );
  expect(() => parseChatGPTConversation({ id: "edge-limit", mapping })).toThrow(/edge limit/u);
});

test("rejects an oversized ChatGPT corpus manifest before parsing", async () => {
  const base = await mkdtemp(join(tmpdir(), "chatlog-chatgpt-manifest-limit-"));
  const source = join(base, "source");
  const root = join(base, "chatlog");
  await mkdir(source);
  await writeFile(join(source, "conversations.json"), "[]");
  const manifestPath = join(root, "corpus", "manifest.json");
  await mkdir(join(root, "corpus"), { recursive: true });
  await writeFile(manifestPath, "");
  await truncate(manifestPath, CHATGPT_MAX_MANIFEST_BYTES + 1);
  await expect(previewChatGPTExport(source, root)).rejects.toThrow(
    /ChatGPT corpus manifest.*file limit/u,
  );
});
test("orders a wide disconnected mapping deterministically within the node limit", () => {
  const mapping = Object.fromEntries(
    Array.from({ length: 2_048 }, (_, index) => {
      const id = `node-${String(index).padStart(4, "0")}`;
      return [
        id,
        {
          id,
          parent: null,
          children: [],
          message: {
            id: `message-${id}`,
            author: { role: index % 2 ? "assistant" : "user" },
            content: { content_type: "text", parts: [id] },
          },
        },
      ];
    }),
  );
  const parsed = parseChatGPTConversation(
    { id: "wide-ordering", current_node: "node-0000", mapping },
    "synthetic-wide.json",
  );
  const batch = adaptChatGPTEventBatch("synthetic-wide.json", parsed, "personal");
  const nodeIds = batch.events
    .filter((event) => event.kind === "message.created")
    .map((event) => event.payload.nodeId);
  expect(nodeIds).toHaveLength(2_048);
  expect(nodeIds[0]).toBe("node-0000");
  expect(nodeIds.at(-1)).toBe("node-2047");
  expect(nodeIds).toEqual([...nodeIds].toSorted());
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

test("ChatGPT import requires preview proposal pins", async () => {
  const root = await mkdtemp(join(tmpdir(), "chatlog-chatgpt-preview-required-"));
  await expect(
    importChatGPTExport(fixturePath, root, {
      domain: "personal",
      derive: false,
      preview: undefined as never,
    }),
  ).rejects.toThrow("ChatGPT import requires preview proposal pins");
});

test("import rejects a source that no longer matches its ChatGPT preview", async () => {
  const base = await mkdtemp(join(tmpdir(), "chatlog-chatgpt-preview-pin-"));
  const source = join(base, "conversations.json");
  const root = join(base, "data");
  const original = await readFile(fixturePath, "utf8");
  await writeFile(source, original);
  const preview = await previewChatGPTExport(source, root, { domain: "personal" });
  await writeFile(source, `${original}\n`);

  await expect(
    importChatGPTExport(source, root, { domain: "personal", derive: false, preview }),
  ).rejects.toThrow("source no longer matches the preview proposal");
  expect(await Bun.file(join(root, "corpus", "manifest.json")).exists()).toBe(false);
});

test("ChatGPT import rejects preview pins after manifest authority changes", async () => {
  const base = await mkdtemp(join(tmpdir(), "chatlog-chatgpt-manifest-preview-pin-"));
  const source = join(base, "conversations.json");
  const root = join(base, "data");
  await writeFile(source, await readFile(fixturePath, "utf8"));
  const preview = await previewChatGPTExport(source, root, { domain: "personal" });
  const manifestPath = join(root, "corpus", "manifest.json");
  await mkdir(join(root, "corpus"), { recursive: true });
  await writeFile(
    manifestPath,
    JSON.stringify({
      version: 1,
      sources: { "/unrelated": { contentHash: "a".repeat(64) } },
    }),
  );

  await expect(
    importChatGPTExport(source, root, { domain: "personal", derive: false, preview }),
  ).rejects.toThrow("source no longer matches the preview proposal");
});

test("import completes a ChatGPT operation intent without an Anthropic receipt", async () => {
  const root = await mkdtemp(join(tmpdir(), "chatlog-chatgpt-operation-"));
  const result = await importPreviewedChatGPT(root, {
    domain: "personal",
    derive: false,
  });
  expect(result.receipts).not.toHaveLength(0);
  expect(result.receipt).toEqual(result.receipts.at(-1)!);
  const directory = join(root, "operations", "completed");
  const [name] = await readdir(directory);
  expect(name).toBeString();
  const operation = JSON.parse(await readFile(join(directory, name!), "utf8"));
  expect(operation).toMatchObject({
    operation: "chatgpt-import",
    status: "completed",
    derivation: {
      requested: false,
      resolution: { status: "not-requested" },
    },
  });
  expect(operation.receipt).toBeUndefined();
});

test("import preserves alternate branches, receipts, and idempotence", async () => {
  const root = await mkdtemp(join(tmpdir(), "chatlog-chatgpt-import-"));
  const first = await importPreviewedChatGPT(root, { domain: "personal", derive: false });
  expect(first.imported).toBe(2);
  expect(first.receipts).toHaveLength(2);
  const second = await importPreviewedChatGPT(root, {
    domain: "personal",
    derive: false,
  });
  expect(second.skipped).toBe(2);
  expect(second.receipts).toEqual(first.receipts);
  expect(second.receipt).toEqual(first.receipt);
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

test("recovers a committed ChatGPT intent across the manifest authority boundary", async () => {
  const root = await mkdtemp(join(tmpdir(), "chatlog-chatgpt-recovery-"));
  await importPreviewedChatGPT(root, { domain: "personal", derive: false });
  const after = JSON.parse(
    await readFile(join(root, "corpus", "manifest.json"), "utf8"),
  ) as CorpusManifest;
  await createOperationIntent(root, {
    operation: "chatgpt-import",
    before: { version: 1, sources: {} },
    after,
    derive: false,
    operationId: "chatgpt-authority-recovery",
    createdAt: "2026-08-04T10:00:00.000Z",
  });
  expect(await listPendingOperationIntents(root)).toHaveLength(1);
  expect(await recoverPendingOperations(root)).toEqual({
    discovered: 1,
    completed: 1,
    aborted: 0,
  });
  const completed = JSON.parse(
    await readFile(
      join(root, "operations", "completed", "chatgpt-authority-recovery.json"),
      "utf8",
    ),
  );
  expect(completed).toMatchObject({
    operation: "chatgpt-import",
    status: "completed",
    projection: { activeSources: 2 },
  });
  expect(await listPendingOperationIntents(root)).toHaveLength(0);
  expect(await recoverPendingOperations(root)).toEqual({
    discovered: 0,
    completed: 0,
    aborted: 0,
  });
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
  await importPreviewedChatGPT(root, { domain: "personal", derive: false });
  const preview = await previewChatGPTExport(fixturePath, root, { domain: "research" });
  expect(preview.reclassified).toBe(2);
});
