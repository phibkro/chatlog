import { expect, test } from "bun:test";
import { mkdtemp, truncate, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Effect } from "effect";
import {
  JSONL_MAX_FILE_BYTES,
  JSONL_MAX_LINE_BYTES,
  JsonlParseError,
  readJsonLines,
} from "../src/jsonl";

test("accepts an incomplete live tail", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chatlog-test-"));
  const path = join(dir, "live.jsonl");
  await writeFile(path, '{"type":"ok"}\n{"type":');
  const records: any[] = [];
  const result = await Effect.runPromise(
    readJsonLines(path, (record) =>
      Effect.sync(() => {
        records.push(record);
      }),
    ),
  );
  expect(records).toHaveLength(1);
  expect(result.partialTail).toBe(true);
});

test("fails on malformed JSON before the live tail", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chatlog-test-"));
  const path = join(dir, "broken.jsonl");
  await writeFile(path, '{bad}\n{"type":"ok"}\n');
  await expect(Effect.runPromise(readJsonLines(path, () => Effect.void))).rejects.toThrow(
    "before final line",
  );
});
test("accepts a line exactly at the native byte ceiling", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chatlog-jsonl-boundary-"));
  const path = join(dir, "boundary.jsonl");
  const prefix = '{"value":"';
  const suffix = '"}';
  const payload = "x".repeat(JSONL_MAX_LINE_BYTES - Buffer.byteLength(prefix + suffix));
  const line = `${prefix}${payload}${suffix}`;
  expect(Buffer.byteLength(line)).toBe(JSONL_MAX_LINE_BYTES);
  await writeFile(path, `${line}\n`);
  const records: unknown[] = [];
  await Effect.runPromise(
    readJsonLines(path, (record) =>
      Effect.sync(() => {
        records.push(record);
      }),
    ),
  );
  expect(records).toHaveLength(1);
});

test("streams many small native JSONL records in order", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chatlog-jsonl-many-small-"));
  const path = join(dir, "many.jsonl");
  const count = 4_096;
  await writeFile(
    path,
    `${Array.from({ length: count }, (_, index) => JSON.stringify({ type: "ok", index })).join("\n")}\n`,
  );
  const indices: number[] = [];
  const result = await Effect.runPromise(
    readJsonLines(path, (record) =>
      Effect.sync(() => {
        if (!record || typeof record !== "object" || !("index" in record))
          throw new Error("bad record");
        indices.push(record.index as number);
      }),
    ),
  );
  expect(result).toMatchObject({ partialTail: false, records: count, lines: count });
  expect(indices).toEqual(Array.from({ length: count }, (_, index) => index));
});

test("accepts valid native history beyond the legacy 128 MiB ceiling", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chatlog-jsonl-large-history-"));
  const path = join(dir, "large.jsonl");
  const prefix = '{"value":"';
  const suffix = '"}';
  const payload = "x".repeat(JSONL_MAX_LINE_BYTES - Buffer.byteLength(prefix + suffix));
  const line = `${prefix}${payload}${suffix}\n`;
  const count = 513;
  expect(Buffer.byteLength(line) * count).toBeGreaterThan(128 * 1024 * 1024);
  await writeFile(path, line.repeat(count));

  let records = 0;
  const result = await Effect.runPromise(
    readJsonLines(path, () =>
      Effect.sync(() => {
        records++;
      }),
    ),
  );

  expect(result).toEqual({ partialTail: false, lines: count, records: count });
  expect(records).toBe(count);
});

test("rejects a file beyond the current JSONL ceiling before streaming", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chatlog-jsonl-file-limit-"));
  const path = join(dir, "oversized.jsonl");
  await writeFile(path, "");
  await truncate(path, JSONL_MAX_FILE_BYTES + 1);

  await expect(Effect.runPromise(readJsonLines(path, () => Effect.void))).rejects.toMatchObject({
    code: "file-too-large",
    line: 1,
  });
});

test("rejects an oversized unterminated native JSONL line before parsing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chatlog-jsonl-limit-"));
  const path = join(dir, "oversized.jsonl");
  await writeFile(path, Buffer.alloc(JSONL_MAX_LINE_BYTES + 1, 0x78));
  await expect(Effect.runPromise(readJsonLines(path, () => Effect.void))).rejects.toBeInstanceOf(
    JsonlParseError,
  );
  await expect(Effect.runPromise(readJsonLines(path, () => Effect.void))).rejects.toMatchObject({
    code: "line-too-large",
    line: 1,
  });
});

test("can account for and skip an oversized complete JSONL line", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chatlog-jsonl-oversized-skip-"));
  const path = join(dir, "oversized.jsonl");
  await writeFile(
    path,
    `${Buffer.alloc(JSONL_MAX_LINE_BYTES + 1, 0x78).toString()}\n{"type":"ok"}\n`,
  );
  const records: unknown[] = [];
  const omittedLines: number[] = [];

  const result = await Effect.runPromise(
    readJsonLines(
      path,
      (record) =>
        Effect.sync(() => {
          records.push(record);
        }),
      (line) =>
        Effect.sync(() => {
          omittedLines.push(line);
        }),
    ),
  );

  expect(omittedLines).toEqual([1]);
  expect(records).toEqual([{ type: "ok" }]);
  expect(result).toEqual({ partialTail: false, lines: 2, records: 2 });
});
