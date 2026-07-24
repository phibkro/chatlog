import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearDerivedInvalidation } from "../src/derived-invalidation";
import { assertDerivedProjection } from "../src/derived-authority";
import { deriveCorpus } from "../src/derive";
import { canonicalizeConversation } from "../src/ingest";
import { listImportReceipts } from "../src/import-receipts";
import {
  corpusManifestHash,
  createOperationIntent,
  listPendingOperationIntents,
  OperationIntentConflictError,
  recoverPendingOperations,
  resolveManifestWriteFailure,
} from "../src/operation-intents";
import { refineCorpus } from "../src/refinery";
import { assertActiveProjection } from "../src/source-authority";
import type { CorpusManifest } from "../src/source-authority";
import type { Conversation } from "../src/types";

function manifest(
  sources: CorpusManifest["sources"] = {},
): CorpusManifest {
  return { version: 1, sources };
}

async function writeManifest(root: string, value: CorpusManifest): Promise<void> {
  await mkdir(join(root, "corpus"), { recursive: true });
  await writeFile(
    join(root, "corpus", "manifest.json"),
    JSON.stringify(value, null, 2) + "\n",
  );
}

function conversation(sourcePath = "/private/export#conversations/one"): Conversation {
  return canonicalizeConversation({
    id: "one",
    title: "Private title",
    provider: "anthropic",
    harness: "claude-web",
    domain: "personal",
    sourceKind: "anthropic-data-export",
    project: "Claude Web",
    cwd: "",
    model: "unknown",
    startedAt: "2026-07-24T10:00:00.000Z",
    endedAt: "2026-07-24T10:01:00.000Z",
    sourcePath,
    turns: [{ role: "user", content: "private conversation content" }],
  });
}

async function writeCanonical(root: string, value: Conversation): Promise<void> {
  const directory = join(root, "corpus", "objects", value.contentHash.slice(0, 2));
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, `${value.contentHash}.json`), JSON.stringify(value) + "\n");
}

function receiptInput(before: CorpusManifest, after: CorpusManifest) {
  return {
    source: {
      path: "/private/export.zip",
      contentHash: "e".repeat(64),
      bytes: 42,
      modifiedAt: "2026-07-24T10:00:00.000Z",
    },
    domain: "personal",
    counts: {
      discovered: 1,
      imported: 1,
      skipped: 0,
      turns: 1,
      attachments: 0,
      files: 0,
    },
    manifest: {
      beforeHash: new Bun.CryptoHasher("sha256")
        .update(JSON.stringify([]))
        .digest("hex"),
      afterHash: new Bun.CryptoHasher("sha256")
        .update(JSON.stringify(Object.entries(after.sources)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([path, entry]) => [path, entry.contentHash])))
        .digest("hex"),
      beforeSources: Object.keys(before.sources).length,
      afterSources: Object.keys(after.sources).length,
      added: 1,
      replaced: 0,
      unchanged: 0,
    },
    deriveEnabled: false,
  };
}

test("manifest intent hashing includes mapping metadata while source authority does not", () => {
  const left = manifest({ "/source": { contentHash: "a".repeat(64), size: 1 } });
  const right = manifest({ "/source": { contentHash: "a".repeat(64), size: 2 } });
  expect(corpusManifestHash(left)).not.toBe(corpusManifestHash(right));
});

test("bounds large transition details without blocking the authority hash", async () => {
  const root = await mkdtemp(join(tmpdir(), "chatlog-operation-large-transition-"));
  const sources = Object.fromEntries(
    Array.from({ length: 10_001 }, (_, index) => [
      `/source/${index}`,
      { contentHash: index.toString(16).padStart(64, "0") },
    ]),
  );
  const intent = await createOperationIntent(root, {
    operation: "ingest",
    before: manifest(),
    after: manifest(sources),
    derive: false,
    operationId: "large-transition",
    createdAt: "2026-07-24T10:00:00.000Z",
  });
  expect(intent.transition).toMatchObject({
    changeCount: 10_001,
    changesTruncated: true,
  });
  expect(intent.transition.changes).toHaveLength(10_000);
});

test("recovers a committed transition through projection, invalidation, receipt, and completion", async () => {
  const root = await mkdtemp(join(tmpdir(), "chatlog-operation-recovery-"));
  const canonical = conversation();
  const before = manifest();
  const after = manifest({
    [canonical.sourcePath]: {
      contentHash: canonical.contentHash,
      size: 42,
      mtimeMs: 17,
    },
  });
  await writeManifest(root, before);
  await writeCanonical(root, canonical);
  const intent = await createOperationIntent(root, {
    operation: "anthropic-import",
    before,
    after,
    derive: false,
    receipt: { kind: "import", input: receiptInput(before, after) },
    operationId: "committed-recovery",
    createdAt: "2026-07-24T10:00:00.000Z",
  });
  expect(intent.transition.changes).toHaveLength(1);
  expect(await listPendingOperationIntents(root)).toHaveLength(1);

  await writeManifest(root, after);
  expect(await recoverPendingOperations(root)).toEqual({
    discovered: 1,
    completed: 1,
    aborted: 0,
  });
  expect(await listPendingOperationIntents(root)).toEqual([]);
  expect(await recoverPendingOperations(root)).toEqual({
    discovered: 0,
    completed: 0,
    aborted: 0,
  });

  const completedPath = join(root, "operations", "completed", "committed-recovery.json");
  const completed = JSON.parse(await readFile(completedPath, "utf8"));
  expect(completed).toMatchObject({
    status: "completed",
    operationId: "committed-recovery",
    derivation: { resolution: { status: "not-requested" } },
    projection: { activeSources: 1, reindexed: 1 },
  });
  expect(JSON.stringify(completed)).not.toContain("private conversation content");
  expect((await stat(completedPath)).mode & 0o777).toBe(0o600);
  expect(JSON.parse(
    await readFile(join(root, "derived", "invalidation.json"), "utf8"),
  )).toMatchObject({
    operationId: "committed-recovery",
    reason: "derivation-not-requested",
  });
  await expect(assertDerivedProjection(root))
    .rejects.toThrow("explicitly invalidated");

  const receipts = await listImportReceipts(root);
  expect(receipts).toHaveLength(1);
  expect(receipts[0]).toMatchObject({
    operationId: "committed-recovery",
    derivation: { status: "not-requested" },
  });
  const db = new Database(join(root, "analysis", "chatlog.sqlite"), {
    readonly: true,
    create: false,
  });
  expect(assertActiveProjection(root, db).activeSources).toBe(1);
  expect(db.query("SELECT content FROM current_turns").get())
    .toEqual({ content: "private conversation content" });
  db.close();

  await deriveCorpus(root);
  await refineCorpus(root, 3, { allowExplicitInvalidation: true });
  await clearDerivedInvalidation(root);
  expect((await assertDerivedProjection(root)).conversations).toBe(1);
});

test("aborts an intent whose manifest never crossed the authority point", async () => {
  const root = await mkdtemp(join(tmpdir(), "chatlog-operation-abort-"));
  const before = manifest();
  const after = manifest({ "/source": { contentHash: "a".repeat(64) } });
  await writeManifest(root, before);
  await createOperationIntent(root, {
    operation: "ingest",
    before,
    after,
    derive: true,
    operationId: "not-committed",
    createdAt: "2026-07-24T10:00:00.000Z",
  });

  expect(await recoverPendingOperations(root)).toEqual({
    discovered: 1,
    completed: 0,
    aborted: 1,
  });
  expect(await listPendingOperationIntents(root)).toEqual([]);
  expect(JSON.parse(
    await readFile(join(root, "operations", "aborted", "not-committed.json"), "utf8"),
  )).toMatchObject({
    status: "aborted",
    abortReason: "authority-not-committed",
  });
  expect(await listImportReceipts(root)).toEqual([]);
});

test("fails closed when the manifest matches neither side of a pending transition", async () => {
  const root = await mkdtemp(join(tmpdir(), "chatlog-operation-conflict-"));
  const before = manifest();
  const after = manifest({ "/source": { contentHash: "a".repeat(64) } });
  await writeManifest(root, before);
  await createOperationIntent(root, {
    operation: "ingest",
    before,
    after,
    derive: false,
    operationId: "conflict",
    createdAt: "2026-07-24T10:00:00.000Z",
  });
  await writeManifest(root, manifest({
    "/other": { contentHash: "b".repeat(64) },
  }));

  await expect(recoverPendingOperations(root))
    .rejects.toBeInstanceOf(OperationIntentConflictError);
  expect(await listPendingOperationIntents(root)).toHaveLength(1);
});

test("does not abort when a manifest writer reports an error after commit", async () => {
  const root = await mkdtemp(join(tmpdir(), "chatlog-operation-post-rename-"));
  const canonical = conversation();
  const before = manifest();
  const after = manifest({
    [canonical.sourcePath]: { contentHash: canonical.contentHash },
  });
  await writeManifest(root, before);
  await writeCanonical(root, canonical);
  const intent = await createOperationIntent(root, {
    operation: "ingest",
    before,
    after,
    derive: false,
    operationId: "post-rename-error",
    createdAt: "2026-07-24T10:00:00.000Z",
  });
  await writeManifest(root, after);

  await expect(resolveManifestWriteFailure(root, intent, new Error("directory fsync")))
    .resolves.toBeUndefined();
  expect(await listPendingOperationIntents(root)).toHaveLength(1);
  expect(await Bun.file(
    join(root, "operations", "aborted", "post-rename-error.json"),
  ).exists()).toBe(false);
  expect(await recoverPendingOperations(root)).toMatchObject({ completed: 1 });
});

test("rejects a modified pending intent before using its transition", async () => {
  const root = await mkdtemp(join(tmpdir(), "chatlog-operation-integrity-"));
  const before = manifest();
  const after = manifest({ "/source": { contentHash: "a".repeat(64) } });
  await writeManifest(root, before);
  await createOperationIntent(root, {
    operation: "ingest",
    before,
    after,
    derive: false,
    operationId: "integrity",
    createdAt: "2026-07-24T10:00:00.000Z",
  });
  const path = join(root, "operations", "pending", "integrity.json");
  const modified = (await readFile(path, "utf8"))
    .replace(`"afterSourcesHash": "`, `"afterSourcesHash": "f`);
  await writeFile(path, modified);
  await expect(listPendingOperationIntents(root))
    .rejects.toThrow("integrity check failed");
});

test("replays the same receipt after a crash at the receipt-write boundary", async () => {
  const root = await mkdtemp(join(tmpdir(), "chatlog-operation-receipt-replay-"));
  const canonical = conversation();
  const before = manifest();
  const after = manifest({
    [canonical.sourcePath]: { contentHash: canonical.contentHash },
  });
  await writeManifest(root, before);
  await writeCanonical(root, canonical);
  await createOperationIntent(root, {
    operation: "anthropic-import",
    before,
    after,
    derive: false,
    receipt: { kind: "import", input: receiptInput(before, after) },
    operationId: "receipt-replay",
    createdAt: "2026-07-24T10:00:00.000Z",
  });
  await writeManifest(root, after);
  await mkdir(join(root, "receipts"), { recursive: true });
  await writeFile(join(root, "receipts", "imports"), "blocks receipt directory");

  await expect(recoverPendingOperations(root)).rejects.toThrow();
  const [pending] = await listPendingOperationIntents(root);
  expect(pending).toMatchObject({
    status: "derived-resolved",
    derivation: { resolution: { status: "not-requested" } },
  });
  const resolvedAt = pending.derivation.resolution!.resolvedAt;

  await unlink(join(root, "receipts", "imports"));
  expect(await recoverPendingOperations(root)).toMatchObject({ completed: 1 });
  const receipts = await listImportReceipts(root);
  expect(receipts).toHaveLength(1);
  expect(receipts[0]).toMatchObject({
    operationId: "receipt-replay",
    completedAt: resolvedAt,
  });
  expect(await recoverPendingOperations(root)).toMatchObject({ discovered: 0 });
  expect(await listImportReceipts(root)).toHaveLength(1);
});

test("finishes a derived operation after its receipt was durably written", async () => {
  const root = await mkdtemp(join(tmpdir(), "chatlog-operation-completion-replay-"));
  const canonical = conversation();
  const before = manifest();
  const after = manifest({
    [canonical.sourcePath]: { contentHash: canonical.contentHash },
  });
  await writeManifest(root, before);
  await writeCanonical(root, canonical);
  await createOperationIntent(root, {
    operation: "anthropic-import",
    before,
    after,
    derive: true,
    receipt: {
      kind: "import",
      input: { ...receiptInput(before, after), deriveEnabled: true },
    },
    operationId: "derived-completion-replay",
    createdAt: "2026-07-24T10:00:00.000Z",
  });
  await writeManifest(root, after);
  await writeFile(join(root, "operations", "completed"), "blocks completed directory");

  await expect(recoverPendingOperations(root)).rejects.toThrow();
  const [pending] = await listPendingOperationIntents(root);
  expect(pending).toMatchObject({
    status: "receipt-written",
    derivation: { resolution: { status: "completed" } },
  });
  const [receipt] = await listImportReceipts(root);
  expect(receipt).toMatchObject({
    operationId: "derived-completion-replay",
    derivation: { status: "completed" },
  });

  await rm(join(root, "derived"), { recursive: true });
  await unlink(join(root, "operations", "completed"));
  expect(await recoverPendingOperations(root)).toMatchObject({ completed: 1 });
  const replayedReceipts = await listImportReceipts(root);
  expect(replayedReceipts).toHaveLength(1);
  expect(replayedReceipts[0].receiptId).toBe(receipt.receiptId);
  expect(replayedReceipts[0].completedAt).toBe(receipt.completedAt);
  expect((await assertDerivedProjection(root)).conversations).toBe(1);
  expect(await Bun.file(join(root, "derived", "invalidation.json")).exists())
    .toBe(false);
});
