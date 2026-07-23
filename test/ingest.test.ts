import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdir, mkdtemp, readFile, rmdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ingest } from "../src/ingest";
import { assertActiveProjection } from "../src/source-authority";
import type { SourceAdapter } from "../src/types";

test("local ingestion reconciles the manifest-backed active projection", async () => {
  const root = await mkdtemp(join(tmpdir(), "chatlog-ingest-projection-"));
  const sourcePath = join(root, "session.jsonl");
  await writeFile(sourcePath, "{}\n");
  let content = "Reconcile the active projection.";
  const adapter: SourceAdapter = {
    harness: "test-harness",
    async discover() {
      const info = await stat(sourcePath);
      return [{ path: sourcePath, size: info.size, mtimeMs: info.mtimeMs }];
    },
    async adapt() {
      return {
        partialTail: false,
        conversation: {
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
        },
      };
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
  const blockedTemporary = `${manifestPath}.${process.pid}.tmp`;
  await mkdir(blockedTemporary);
  try {
    await expect(ingest([adapter], root)).rejects.toThrow();
  } finally {
    await rmdir(blockedTemporary);
  }

  const after = JSON.parse(await readFile(manifestPath, "utf8"));
  expect(after.sources[sourcePath].contentHash).toBe(beforeHash);
  db = new Database(databasePath, { readonly: true, create: false });
  expect(assertActiveProjection(root, db).activeSources).toBe(1);
  expect(db.query("SELECT content_hash contentHash FROM current_conversations").get())
    .toEqual({ contentHash: beforeHash });
  expect(db.query("SELECT count(*) count FROM conversations").get())
    .toEqual({ count: 2 });
  db.close();
});
