import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { indexConversation, openAnalysis } from "../src/analysis";
import {
  ActiveProjectionDriftError,
  ActiveProjectionGuard,
  assertActiveProjection,
  reconcileActiveSources,
  reconcileSourceAuthority,
} from "../src/source-authority";
import type { Conversation } from "../src/types";

function conversation(contentHash: string, endedAt: string, content: string): Conversation {
  return {
    id: "session",
    provider: "openai",
    harness: "codex",
    domain: "coding",
    sourceKind: "session-log",
    project: "/project",
    cwd: "/project",
    model: "model",
    startedAt: "2026-07-01T00:00:00Z",
    endedAt,
    sourcePath: "/source",
    contentHash,
    turns: [{ role: "user", content }],
  };
}

function hashedConversation(endedAt: string, content: string): Conversation {
  const value = conversation("", endedAt, content);
  const { contentHash: _contentHash, ...canonical } = value;
  const contentHash = new Bun.CryptoHasher("sha256")
    .update(JSON.stringify(canonical))
    .digest("hex");
  return { ...canonical, contentHash };
}

async function writeManifest(
  root: string,
  sources: Record<string, { contentHash: string }>,
): Promise<void> {
  await mkdir(join(root, "corpus"), { recursive: true });
  await writeFile(
    join(root, "corpus", "manifest.json"),
    JSON.stringify({ version: 1, sources }),
  );
}

test("migrates legacy newest-row authority and prevents historical resurrection", async () => {
  const root = await mkdtemp(join(tmpdir(), "chatlog-source-authority-migration-"));
  const path = join(root, "analysis", "chatlog.sqlite");
  const oldHash = "a".repeat(64);
  const currentHash = "b".repeat(64);
  let db = openAnalysis(path);
  indexConversation(db, conversation(oldHash, "2026-07-01T00:01:00Z", "old"), 1, 1);
  indexConversation(db, conversation(currentHash, "2026-07-02T00:01:00Z", "current"), 2, 2);
  db.close();

  const legacy = new Database(path);
  legacy.run("DROP VIEW current_token_usage");
  legacy.run("DROP VIEW current_turns");
  legacy.run("DROP VIEW current_conversations");
  legacy.run("DROP TABLE active_projection_meta");
  legacy.run("DROP TABLE active_sources");
  legacy.run(`CREATE VIEW current_conversations AS
    SELECT * FROM (
      SELECT *, row_number() OVER (
        PARTITION BY source_path
        ORDER BY source_mtime DESC, source_size DESC, ingested_at DESC
      ) rn
      FROM conversations
    ) WHERE rn = 1`);
  legacy.close();

  await writeManifest(root, { "/source": { contentHash: currentHash } });
  db = openAnalysis(path);
  const receipt = reconcileActiveSources(db, {
    "/source": { contentHash: currentHash },
  });
  expect(receipt.activeSources).toBe(1);
  expect(reconcileActiveSources(db, {
    "/source": { contentHash: currentHash },
  }).reconciledAt).toBe(receipt.reconciledAt);
  expect(db.query("SELECT content_hash FROM current_conversations").get())
    .toEqual({ content_hash: currentHash });
  expect(assertActiveProjection(root, db).manifestSourcesHash)
    .toBe(receipt.manifestSourcesHash);

  await writeManifest(root, {});
  expect(() => assertActiveProjection(root, db)).toThrow(ActiveProjectionDriftError);
  reconcileActiveSources(db, {});
  expect(db.query("SELECT count(*) count FROM current_conversations").get())
    .toEqual({ count: 0 });
  expect(db.query("SELECT count(*) count FROM conversations").get())
    .toEqual({ count: 2 });
  expect(assertActiveProjection(root, db).activeSources).toBe(0);
  db.close();
});

test("detects manifest, metadata, and active-row drift", async () => {
  const root = await mkdtemp(join(tmpdir(), "chatlog-source-authority-drift-"));
  const path = join(root, "analysis", "chatlog.sqlite");
  const hash = "c".repeat(64);
  await writeManifest(root, { "/source": { contentHash: hash } });
  const writer = openAnalysis(path);
  indexConversation(writer, conversation(hash, "2026-07-01T00:01:00Z", "active"), 1, 1);
  reconcileActiveSources(writer, { "/source": { contentHash: hash } });
  writer.close();

  const reader = new Database(path, { readonly: true, create: false });
  const guard = new ActiveProjectionGuard(root);
  expect(guard.assert(reader).activeSources).toBe(1);

  const corruptor = new Database(path);
  corruptor.run("DELETE FROM active_sources");
  expect(() => guard.assert(reader)).toThrow(ActiveProjectionDriftError);
  reconcileActiveSources(corruptor, { "/source": { contentHash: hash } });
  expect(guard.assert(reader).activeSources).toBe(1);

  corruptor.run("UPDATE active_projection_meta SET manifest_sources_hash=?", ["d".repeat(64)]);
  expect(() => guard.assert(reader)).toThrow(ActiveProjectionDriftError);
  reconcileActiveSources(corruptor, { "/source": { contentHash: hash } });

  corruptor.run("DELETE FROM conversations WHERE content_hash = ?", [hash]);
  expect(() => guard.assert(reader)).toThrow("missing analysis rows");

  await writeManifest(root, {});
  expect(() => guard.assert(reader)).toThrow(ActiveProjectionDriftError);
  reader.close();
  corruptor.close();
});

test("failed reconciliation rolls back the prior projection receipt", async () => {
  const root = await mkdtemp(join(tmpdir(), "chatlog-source-authority-rollback-"));
  const path = join(root, "analysis", "chatlog.sqlite");
  const hash = "e".repeat(64);
  await writeManifest(root, { "/source": { contentHash: hash } });
  const db = openAnalysis(path);
  indexConversation(db, conversation(hash, "2026-07-01T00:01:00Z", "active"), 1, 1);
  const before = reconcileActiveSources(db, { "/source": { contentHash: hash } });

  expect(() => reconcileActiveSources(db, {
    "/missing": { contentHash: "f".repeat(64) },
  })).toThrow("manifest source is not indexed");
  expect(db.query("SELECT source_path sourcePath, content_hash contentHash FROM active_sources").all())
    .toEqual([{ sourcePath: "/source", contentHash: hash }]);
  expect(assertActiveProjection(root, db)).toMatchObject({
    manifestSourcesHash: before.manifestSourcesHash,
    activeSources: 1,
  });
  db.close();
});

test("operator reconciliation command rebuilds a manifest projection", async () => {
  const root = await mkdtemp(join(tmpdir(), "chatlog-source-authority-cli-"));
  const path = join(root, "analysis", "chatlog.sqlite");
  const canonical = hashedConversation("2026-07-01T00:01:00Z", "active");
  const hash = canonical.contentHash;
  await writeManifest(root, { "/source": { contentHash: hash } });
  const objectDir = join(root, "corpus", "objects", hash.slice(0, 2));
  await mkdir(objectDir, { recursive: true });
  await writeFile(
    join(objectDir, `${hash}.json`),
    JSON.stringify(canonical),
  );

  const child = Bun.spawn(
    ["bun", "run", "src/cli.ts", "source", "reconcile"],
    {
      cwd: join(import.meta.dir, ".."),
      env: { ...process.env, CHATLOG_DATA_ROOT: root },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect(exitCode).toBe(0);
  expect(stderr).toBe("");
  expect(JSON.parse(stdout)).toMatchObject({
    activeSources: 1,
    reindexed: 1,
    recovery: { discovered: 0, completed: 0, aborted: 0 },
  });

  const reader = new Database(path, { readonly: true, create: false });
  expect(assertActiveProjection(root, reader).activeSources).toBe(1);
  expect(reader.query("SELECT count(*) count FROM turns_fts").get()).toEqual({ count: 1 });
  reader.close();
});

test("rebuilds a lost analysis database from immutable active corpus objects", async () => {
  const root = await mkdtemp(join(tmpdir(), "chatlog-source-authority-rebuild-"));
  const canonical = hashedConversation("2026-07-01T00:01:00Z", "recoverable");
  const hash = canonical.contentHash;
  const sources = { "/source": { contentHash: hash, size: 17, mtimeMs: 23 } };
  await writeManifest(root, sources);
  const objectDir = join(root, "corpus", "objects", hash.slice(0, 2));
  await mkdir(objectDir, { recursive: true });
  await writeFile(
    join(objectDir, `${hash}.json`),
    JSON.stringify(canonical),
  );
  const db = openAnalysis(join(root, "analysis", "chatlog.sqlite"));
  const receipt = await reconcileSourceAuthority(root, db, sources);
  expect(receipt).toMatchObject({ activeSources: 1, reindexed: 1 });
  expect(db.query(`SELECT source_path sourcePath, source_mtime sourceMtime,
    source_size sourceSize FROM current_conversations`).get()).toEqual({
    sourcePath: "/source",
    sourceMtime: 23,
    sourceSize: 17,
  });
  expect(db.query("SELECT content FROM current_turns").get())
    .toEqual({ content: "recoverable" });
  db.close();
});

test("repairing missing active rows mints a new projection receipt", async () => {
  const root = await mkdtemp(join(tmpdir(), "chatlog-source-authority-repair-receipt-"));
  const canonical = hashedConversation("2026-07-01T00:01:00Z", "repairable");
  const sources = { "/source": { contentHash: canonical.contentHash } };
  await writeManifest(root, sources);
  const objectDir = join(root, "corpus", "objects", canonical.contentHash.slice(0, 2));
  await mkdir(objectDir, { recursive: true });
  await writeFile(
    join(objectDir, `${canonical.contentHash}.json`),
    JSON.stringify(canonical),
  );
  const db = openAnalysis(join(root, "analysis", "chatlog.sqlite"));
  indexConversation(db, canonical, 1, 1);
  const before = reconcileActiveSources(db, sources);
  db.run("DELETE FROM turns_fts WHERE content_hash = ?", [canonical.contentHash]);
  db.run("DELETE FROM turns WHERE content_hash = ?", [canonical.contentHash]);
  db.run("DELETE FROM conversations WHERE content_hash = ?", [canonical.contentHash]);

  const repaired = await reconcileSourceAuthority(root, db, sources);
  expect(repaired.reindexed).toBe(1);
  expect(repaired.reconciledAt).not.toBe(before.reconciledAt);
  expect(db.query("SELECT content FROM current_turns").get())
    .toEqual({ content: "repairable" });
  db.close();
});

test("rebuild rejects a parseable canonical object whose content hash is invalid", async () => {
  const root = await mkdtemp(join(tmpdir(), "chatlog-source-authority-corrupt-object-"));
  const canonical = hashedConversation("2026-07-01T00:01:00Z", "original");
  const sources = { "/source": { contentHash: canonical.contentHash } };
  await writeManifest(root, sources);
  const objectDir = join(root, "corpus", "objects", canonical.contentHash.slice(0, 2));
  await mkdir(objectDir, { recursive: true });
  await writeFile(
    join(objectDir, `${canonical.contentHash}.json`),
    JSON.stringify({
      ...canonical,
      turns: [{ role: "user", content: "tampered but parseable" }],
    }),
  );
  const db = openAnalysis(join(root, "analysis", "chatlog.sqlite"));
  await expect(reconcileSourceAuthority(root, db, sources))
    .rejects.toThrow("canonical object does not match manifest source mapping");
  expect(db.query("SELECT count(*) count FROM conversations").get())
    .toEqual({ count: 0 });
  db.close();
});

test("legacy read-only databases fail closed with an actionable migration error", async () => {
  const root = await mkdtemp(join(tmpdir(), "chatlog-source-authority-legacy-readonly-"));
  const path = join(root, "analysis", "chatlog.sqlite");
  await writeManifest(root, {});
  const writer = openAnalysis(path);
  writer.run("DROP VIEW current_token_usage");
  writer.run("DROP VIEW current_turns");
  writer.run("DROP VIEW current_conversations");
  writer.run("DROP TABLE active_projection_meta");
  writer.run("DROP TABLE active_sources");
  writer.close();

  const reader = new Database(path, { readonly: true, create: false });
  try {
    expect(() => assertActiveProjection(root, reader))
      .toThrow("active source projection is not initialized");
  } finally {
    reader.close();
  }
});

test("CLI queries fail closed until the source projection is reconciled", async () => {
  const root = await mkdtemp(join(tmpdir(), "chatlog-source-authority-query-drift-"));
  await writeManifest(root, {});
  const db = openAnalysis(join(root, "analysis", "chatlog.sqlite"));
  db.close();
  const child = Bun.spawn(
    ["bun", "run", "src/cli.ts", "query", "stats"],
    {
      cwd: join(import.meta.dir, ".."),
      env: { ...process.env, CHATLOG_DATA_ROOT: root },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect(exitCode).not.toBe(0);
  expect(`${stdout}\n${stderr}`).toContain("active source projection");
});
