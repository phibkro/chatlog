import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdir, mkdtemp, readFile, rename, rmdir, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { projectConversation } from "../src/conversation-projection";
import { eventBatchHash, eventBatchPath } from "../src/event-store";
import { ingest, IngestConfigurationError } from "../src/ingest";
import { assertActiveProjection } from "../src/source-authority";
import type { SourceAdapter } from "../src/types";
import { syntheticEventBatch } from "./event-fixture";

test("local ingestion rejects invalid sampling bounds before discovery", async () => {
  const root = await mkdtemp(join(tmpdir(), "chatlog-ingest-options-"));
  await expect(ingest([], root, { maxSourcesPerAdapter: 0 })).rejects.toBeInstanceOf(
    IngestConfigurationError,
  );
  await expect(ingest([], root, { minimumSourceAgeMs: -1 })).rejects.toThrow(
    "minimumSourceAgeMs must be a non-negative safe integer",
  );
});
test("local ingestion defers a source that changes during adaptation without persisting it", async () => {
  const root = await mkdtemp(join(tmpdir(), "chatlog-ingest-changing-source-"));
  const sourcePath = join(root, "session.jsonl");
  await writeFile(sourcePath, "{}\n");
  const adapter: SourceAdapter = {
    harness: "changing-harness",
    async discover() {
      const info = await stat(sourcePath);
      return [{ path: sourcePath, size: info.size, mtimeMs: info.mtimeMs }];
    },
    async adapt() {
      await writeFile(sourcePath, '{"changed":true}\n');
      return syntheticEventBatch({
        id: "changing-session",
        provider: "test",
        harness: "changing-harness",
        domain: "coding",
        sourceKind: "session-log",
        project: "/project",
        cwd: "/project",
        model: "model",
        startedAt: "2026-07-24T00:00:00Z",
        endedAt: "2026-07-24T00:01:00Z",
        sourcePath,
        turns: [{ role: "user", content: "This batch came from a moving source." }],
      });
    },
  };

  const result = await ingest([adapter], root);
  expect(result.changedDuringRead).toBe(1);
  expect(result.ingested).toEqual({ "changing-harness": 0 });
  expect(result.deferred).toEqual({ "changing-harness": 1 });
  const manifest = JSON.parse(await readFile(join(root, "corpus", "manifest.json"), "utf8"));
  expect(manifest.sources).toEqual({});
  const db = new Database(join(root, "analysis", "chatlog.sqlite"), {
    readonly: true,
    create: false,
  });
  expect(db.query("SELECT count(*) count FROM conversations").get()).toEqual({ count: 0 });
  expect(db.query("SELECT count(*) count FROM event_batches").get()).toEqual({ count: 0 });
  db.close();
});

test("local ingestion rejects a corrupt existing canonical object before persisting its batch", async () => {
  const root = await mkdtemp(join(tmpdir(), "chatlog-ingest-corrupt-object-"));
  const sourcePath = join(root, "session.jsonl");
  await writeFile(sourcePath, "{}\n");
  const batch = syntheticEventBatch({
    id: "corrupt-object-session",
    provider: "test",
    harness: "corrupt-object-harness",
    domain: "coding",
    sourceKind: "session-log",
    project: "/project",
    cwd: "/project",
    model: "model",
    startedAt: "2026-07-24T00:00:00Z",
    endedAt: "2026-07-24T00:01:00Z",
    sourcePath,
    turns: [{ role: "user", content: "Canonical object integrity must fail closed." }],
  });
  const conversation = projectConversation(batch);
  const objectDirectory = join(root, "corpus", "objects", conversation.contentHash.slice(0, 2));
  await mkdir(objectDirectory, { recursive: true });
  await writeFile(join(objectDirectory, `${conversation.contentHash}.json`), "{}\n");
  const adapter: SourceAdapter = {
    harness: "corrupt-object-harness",
    async discover() {
      const info = await stat(sourcePath);
      return [{ path: sourcePath, size: info.size, mtimeMs: info.mtimeMs }];
    },
    async adapt() {
      return batch;
    },
  };

  await expect(ingest([adapter], root)).rejects.toThrow("canonical object");
  expect(await Bun.file(eventBatchPath(root, eventBatchHash(batch))).exists()).toBe(false);
});
test("local ingestion reconciles the manifest-backed active projection", async () => {
  const root = await mkdtemp(join(tmpdir(), "chatlog-ingest-projection-"));
  const sourcePath = join(root, "session.jsonl");
  await writeFile(sourcePath, "{}\n");
  let content = "Reconcile the active projection.";
  let blockManifestPath: string | undefined;
  const manifestBackupPath = join(root, "corpus", "manifest.json.test-backup");
  const adapter: SourceAdapter = {
    harness: "test-harness",
    async discover() {
      const info = await stat(sourcePath);
      return [{ path: sourcePath, size: info.size, mtimeMs: info.mtimeMs }];
    },
    async adapt() {
      if (blockManifestPath && manifestBackupPath) {
        await rename(blockManifestPath, manifestBackupPath);
        await mkdir(blockManifestPath);
        blockManifestPath = undefined;
      }
      return syntheticEventBatch({
        id: "session",
        provider: "test",
        harness: "test-harness",
        domain: "coding",
        sourceKind: "session-log",
        project: "/project",
        cwd: "/project",
        model: "model",
        startedAt: "2026-07-24T00:00:00Z",
        endedAt: "2026-07-24T00:01:00Z",
        sourcePath,
        turns: [{ role: "user", content }],
      });
    },
  };

  const first = await ingest([adapter], root);
  expect(first.ingested).toEqual({ "test-harness": 1 });
  const databasePath = join(root, "analysis", "chatlog.sqlite");
  let db = new Database(databasePath);
  expect(db.query("SELECT id FROM current_conversations").get()).toEqual({ id: "session" });
  expect(assertActiveProjection(root, db).activeSources).toBe(1);

  db.run("DELETE FROM active_sources");
  db.close();
  const second = await ingest([adapter], root);
  expect(second.skipped).toEqual({ "test-harness": 1 });
  db = new Database(databasePath, { readonly: true, create: false });
  expect(assertActiveProjection(root, db).activeSources).toBe(1);
  expect(db.query("SELECT id FROM current_conversations").get()).toEqual({ id: "session" });
  db.close();

  const manifestPath = join(root, "corpus", "manifest.json");
  const before = JSON.parse(await readFile(manifestPath, "utf8"));
  const beforeHash = before.sources[sourcePath].contentHash;
  content = "A changed conversation that must not become active before the manifest commit.";
  await writeFile(sourcePath, '{"changed":true}\n');
  blockManifestPath = manifestPath;
  try {
    await expect(ingest([adapter], root)).rejects.toThrow();
  } finally {
    if ((await stat(manifestPath)).isDirectory()) {
      await rmdir(manifestPath);
      await rename(manifestBackupPath, manifestPath);
    }
  }

  const after = JSON.parse(await readFile(manifestPath, "utf8"));
  expect(after.sources[sourcePath].contentHash).toBe(beforeHash);
  db = new Database(databasePath, { readonly: true, create: false });
  expect(assertActiveProjection(root, db).activeSources).toBe(1);
  expect(db.query("SELECT content_hash contentHash FROM current_conversations").get()).toEqual({
    contentHash: beforeHash,
  });
  expect(db.query("SELECT count(*) count FROM conversations").get()).toEqual({ count: 2 });
  db.close();
});

test("local ingestion incrementally samples candidate sources across runs", async () => {
  const root = await mkdtemp(join(tmpdir(), "chatlog-ingest-sample-"));
  const sourceDirectory = join(root, "sources");
  await mkdir(sourceDirectory);
  const sourcePaths = Array.from({ length: 5 }, (_, index) =>
    join(sourceDirectory, `session-${index}.jsonl`),
  );
  await Promise.all(sourcePaths.map((path) => writeFile(path, "{}\n")));
  const adaptedPaths: string[] = [];
  const adapter: SourceAdapter = {
    harness: "sample-harness",
    async discover() {
      return Promise.all(
        sourcePaths.map(async (path) => {
          const info = await stat(path);
          return { path, size: info.size, mtimeMs: info.mtimeMs };
        }),
      );
    },
    async adapt(source) {
      adaptedPaths.push(source.path);
      return syntheticEventBatch({
        id: basename(source.path, ".jsonl"),
        provider: "test",
        harness: "sample-harness",
        domain: "coding",
        sourceKind: "session-log",
        project: "/project",
        cwd: "/project",
        model: "model",
        startedAt: "2026-07-24T00:00:00Z",
        endedAt: "2026-07-24T00:01:00Z",
        sourcePath: source.path,
        turns: [{ role: "user", content: source.path }],
      });
    },
  };
  const options = { maxSourcesPerAdapter: 2 };

  const first = await ingest([adapter], root, options);
  expect(first.ingested).toEqual({ "sample-harness": 2 });
  expect(first.deferred).toEqual({ "sample-harness": 3 });
  expect(first.unsettled).toEqual({ "sample-harness": 0 });
  let manifest = JSON.parse(await readFile(join(root, "corpus", "manifest.json"), "utf8"));
  expect(Object.keys(manifest.sources)).toHaveLength(2);
  expect(manifest.recipeMigration).toBeDefined();

  const second = await ingest([adapter], root, options);
  expect(second.ingested).toEqual({ "sample-harness": 2 });
  expect(second.deferred).toEqual({ "sample-harness": 1 });

  const third = await ingest([adapter], root, options);
  expect(third.ingested).toEqual({ "sample-harness": 1 });
  expect(third.deferred).toEqual({ "sample-harness": 0 });
  manifest = JSON.parse(await readFile(join(root, "corpus", "manifest.json"), "utf8"));
  expect(Object.keys(manifest.sources)).toHaveLength(5);
  expect(manifest.recipeMigration).toBeUndefined();
  expect(manifest.redactionRecipe).toBeString();
  expect(new Set(adaptedPaths).size).toBe(5);

  const fourth = await ingest([adapter], root, options);
  expect(fourth.ingested).toEqual({ "sample-harness": 0 });
  expect(fourth.skipped).toEqual({ "sample-harness": 5 });
  expect(fourth.deferred).toEqual({ "sample-harness": 0 });
});
