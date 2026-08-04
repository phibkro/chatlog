import { expect, test } from "bun:test";
import { mkdtemp, readFile, stat, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  makeSemanticLoss,
  validateSemanticLoss,
  validateEventBatch,
  type EventBatch,
} from "../src/events";
import {
  buildSourceReceipt,
  persistSourceReceipt,
  persistUnknownShapeNominations,
  readSourceReceipt,
  readUnknownShapeNominations,
} from "../src/source-receipts";
import { eventBatchHash } from "../src/event-store";
import { sourceItemAccounting } from "../src/adapter-conformance";
import { CodexAdapter } from "../src/adapters/codex";
import { PiAdapter } from "../src/adapters/pi";
import { ingest } from "../src/ingest";
import type { SourceAdapter } from "../src/types";
const lossInput = {
  code: "unknown-well-formed-item" as const,
  reason: "synthetic unknown provider item was retained as opaque evidence",
  provider: "synthetic-provider",
  harness: "synthetic-harness",
  sourceItemKind: "synthetic_unknown",
  sourceLocator: "/synthetic/session.jsonl:4",
  count: 1,
  adapterRecipe: "synthetic-adapter-v2",
  capturePolicyVersion: "synthetic-capture-v1",
  recoverable: true,
};

test("semantic loss validation is closed and requires complete provenance", () => {
  const loss = makeSemanticLoss(lossInput);
  expect(validateSemanticLoss(loss)).toMatchObject(lossInput);
  expect(() => validateSemanticLoss({ ...lossInput, code: "invented-code" })).toThrow("unknown");
  expect(() => validateSemanticLoss({ ...lossInput, count: 0 })).toThrow("positive");
  expect(() => validateSemanticLoss({ ...lossInput, recoverable: "yes" })).toThrow("boolean");
  expect(() => validateSemanticLoss({ ...lossInput, sourceLocator: "" })).toThrow("sourceLocator");
});

test("partial tails are explicit loss entries and receipts are deterministic", async () => {
  const fixture = join(import.meta.dir, "fixtures", "providers", "pi-matrix.jsonl");
  const root = await mkdtemp(join(tmpdir(), "chatlog-loss-receipt-"));
  const sourcePath = join(root, "partial.jsonl");
  await writeFile(sourcePath, `${await readFile(fixture, "utf8")}{"type":"partial"`);
  const info = await stat(sourcePath);
  const batch = (await new PiAdapter(root).adapt({
    path: sourcePath,
    size: info.size,
    mtimeMs: info.mtimeMs,
  })) as EventBatch;
  const partial = validateEventBatch(batch);
  expect(partial.partialTail).toBe(true);
  expect(partial.semanticLoss).toEqual(
    expect.arrayContaining([expect.objectContaining({ code: "partial-live-tail", count: 1 })]),
  );
  const accounting = sourceItemAccounting(partial);
  const projectionHash = "a".repeat(64);
  const first = buildSourceReceipt({ batch: partial, conversationProjectionHash: projectionHash });
  const second = buildSourceReceipt({ batch: partial, conversationProjectionHash: projectionHash });
  expect(first.receiptHash).toBe(second.receiptHash);
  expect(first.eventBatchHash).toBe(eventBatchHash(partial));
  expect(first.itemCounts.unaccountedItems).toBe(0);
  expect(first.itemCounts.sourceItems).toBe(
    accounting.eventBackedItems + accounting.lossOnlyItems + accounting.unaccountedItems,
  );
  await persistSourceReceipt(root, first);
  expect(await readSourceReceipt(root, first.receiptHash)).toEqual(first);
});

test("unknown nomination replay replaces a source contribution instead of inflating counts", async () => {
  const root = await mkdtemp(join(tmpdir(), "chatlog-nomination-replay-"));
  const sourcePath = join(root, "pi-matrix.jsonl");
  const fixture = join(import.meta.dir, "fixtures", "providers", "pi-matrix.jsonl");
  await writeFile(sourcePath, await readFile(fixture, "utf8"));
  const info = await stat(sourcePath);
  const batch = await new PiAdapter(root).adapt({
    path: sourcePath,
    size: info.size,
    mtimeMs: info.mtimeMs,
  });
  const first = await persistUnknownShapeNominations(root, [batch], "a".repeat(64));
  const second = await persistUnknownShapeNominations(root, [batch], "a".repeat(64));
  const third = await persistUnknownShapeNominations(root, [batch], "b".repeat(64));
  expect(second).toEqual(first);
  expect(third).toEqual(first);
  expect(await readUnknownShapeNominations(root)).toEqual(first);
});

test("malformed provider records fail with source position and write no receipt", async () => {
  const root = await mkdtemp(join(tmpdir(), "chatlog-malformed-source-"));
  const sourcePath = join(root, "rollout.jsonl");
  await writeFile(
    sourcePath,
    '{"type":"session_meta","payload":{"id":"ok"}}\n{"type":"session_meta"}\n',
  );
  await expect(ingest([new CodexAdapter(root)], root)).rejects.toThrow(`${sourcePath}:2`);
  await expect(stat(join(root, "receipts", "sources"))).rejects.toMatchObject({ code: "ENOENT" });
});

test("recipe replay creates new immutable batch and receipt objects", async () => {
  const root = await mkdtemp(join(tmpdir(), "chatlog-recipe-replay-"));
  const sourcePath = join(root, "rollout.jsonl");
  const fixture = join(import.meta.dir, "fixtures", "events", "codex.jsonl");
  await writeFile(sourcePath, await readFile(fixture, "utf8"));
  await ingest([new CodexAdapter(root)], root);
  const manifestPath = join(root, "corpus", "manifest.json");
  const firstManifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const first = firstManifest.sources[sourcePath];
  const firstBatchPath = join(
    root,
    "corpus",
    "events",
    first.eventBatchHash.slice(0, 2),
    `${first.eventBatchHash}.json`,
  );
  const firstReceiptPath = join(
    root,
    "receipts",
    "sources",
    first.receiptHash.slice(0, 2),
    `${first.receiptHash}.json`,
  );
  const firstBatchBytes = await readFile(firstBatchPath);
  const firstReceiptBytes = await readFile(firstReceiptPath);
  const future = new Date(Date.now() + 2000);
  await utimes(sourcePath, future, future);
  const baseAdapter = new CodexAdapter(root);
  const replayAdapter: SourceAdapter = {
    harness: "codex",
    discover: () => baseAdapter.discover(),
    adapt: async (source) => {
      const batch = await baseAdapter.adapt(source);
      if (batch.origin.kind !== "observed") return batch;
      return {
        ...batch,
        origin: {
          ...batch.origin,
          source: {
            ...batch.origin.source,
            adapterRecipe: "chatlog-agent-events-test-replay-v1",
          },
        },
      };
    },
  };
  await ingest([replayAdapter], root);
  const secondManifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const second = secondManifest.sources[sourcePath];
  expect(second.receiptHash).not.toBe(first.receiptHash);
  expect(second.eventBatchHash).not.toBe(first.eventBatchHash);
  expect(await readFile(firstBatchPath)).toEqual(firstBatchBytes);
  expect(await readFile(firstReceiptPath)).toEqual(firstReceiptBytes);
});
