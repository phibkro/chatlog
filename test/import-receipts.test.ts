import { expect, test } from "bun:test";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  listImportReceipts,
  manifestSourcesHash,
  writeImportReceipt,
} from "../src/import-receipts";

const hash = (character: string) => character.repeat(64);

test("manifest source hashes are order-independent and path-sensitive", () => {
  const left = manifestSourcesHash({
    "/b": { contentHash: hash("b") },
    "/a": { contentHash: hash("a") },
  });
  const right = manifestSourcesHash({
    "/a": { contentHash: hash("a") },
    "/b": { contentHash: hash("b") },
  });
  expect(left).toBe(right);
  expect(manifestSourcesHash({ "/c": { contentHash: hash("a") } })).not.toBe(
    manifestSourcesHash({ "/a": { contentHash: hash("a") } }),
  );
});

test("writes private bounded receipts and lists only the requested newest records", async () => {
  const root = await mkdtemp(join(tmpdir(), "chatlog-receipts-"));
  expect(await listImportReceipts(root)).toEqual([]);
  const base = {
    source: {
      path: "/private/export.zip",
      contentHash: hash("a"),
      bytes: 42,
      modifiedAt: "2026-07-24T10:00:00.000Z",
    },
    domain: "personal",
    counts: {
      discovered: 1,
      imported: 1,
      skipped: 0,
      turns: 2,
      attachments: 0,
      files: 0,
    },
    manifest: {
      beforeHash: hash("b"),
      afterHash: hash("c"),
      beforeSources: 0,
      afterSources: 1,
      added: 1,
      replaced: 0,
      unchanged: 0,
    },
    deriveEnabled: false,
  };
  const first = await writeImportReceipt(root, {
    ...base,
    operationId: "first",
    completedAt: "2026-07-24T10:00:00.000Z",
  });
  const second = await writeImportReceipt(root, {
    ...base,
    operationId: "second",
    completedAt: "2026-07-24T10:00:01.000Z",
  });

  expect(await listImportReceipts(root, 1)).toEqual([second]);
  expect((await listImportReceipts(root, 200))[1]).toEqual(first);
  const paths = [...new Bun.Glob("*.json").scanSync({
    cwd: join(root, "receipts", "imports"),
    onlyFiles: true,
  })];
  expect(paths).toHaveLength(2);
  expect((await stat(join(root, "receipts", "imports", paths[0]))).mode & 0o777).toBe(0o600);
});

test("rejects fields that exceed the receipt contract", async () => {
  const root = await mkdtemp(join(tmpdir(), "chatlog-receipts-bounds-"));
  await expect(writeImportReceipt(root, {
    source: {
      path: "/export.zip",
      contentHash: hash("a"),
      bytes: -1,
      modifiedAt: "2026-07-24T10:00:00.000Z",
    },
    domain: "personal",
    counts: {
      discovered: 0,
      imported: 0,
      skipped: 0,
      turns: 0,
      attachments: 0,
      files: 0,
    },
    manifest: {
      beforeHash: hash("b"),
      afterHash: hash("b"),
      beforeSources: 0,
      afterSources: 0,
      added: 0,
      replaced: 0,
      unchanged: 0,
    },
    deriveEnabled: false,
  })).rejects.toThrow("source bytes is not a bounded count");
  expect(await listImportReceipts(root)).toEqual([]);
});

test("rejects a modified persisted receipt", async () => {
  const root = await mkdtemp(join(tmpdir(), "chatlog-receipts-integrity-"));
  const receipt = await writeImportReceipt(root, {
    source: {
      path: "/export.zip",
      contentHash: hash("a"),
      bytes: 10,
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
      beforeHash: hash("b"),
      afterHash: hash("c"),
      beforeSources: 0,
      afterSources: 1,
      added: 1,
      replaced: 0,
      unchanged: 0,
    },
    deriveEnabled: false,
    operationId: "integrity",
    completedAt: "2026-07-24T10:00:00.000Z",
  });
  const directory = join(root, "receipts", "imports");
  const [name] = [...new Bun.Glob("*.json").scanSync({ cwd: directory, onlyFiles: true })];
  const path = join(directory, name);
  const modified = (await readFile(path, "utf8")).replace('"imported": 1', '"imported": 9');
  await writeFile(path, modified);

  expect(receipt.counts.imported).toBe(1);
  await expect(listImportReceipts(root)).rejects.toThrow("integrity check failed");
});

test("CLI rejects receipt limits outside the bounded contract", async () => {
  const root = await mkdtemp(join(tmpdir(), "chatlog-receipts-cli-"));
  for (const [limit, message] of [
    ["abc", "receipt limit must be a positive integer"],
    ["201", "receipt limit must be at most 200"],
  ]) {
    const child = Bun.spawn(
      ["bun", "run", "src/cli.ts", "receipts", "imports", limit],
      {
        cwd: join(import.meta.dir, ".."),
        env: { ...process.env, CHATLOG_DATA_ROOT: root },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [exitCode, stderr] = await Promise.all([
      child.exited,
      new Response(child.stderr).text(),
    ]);
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain(message);
  }
});
