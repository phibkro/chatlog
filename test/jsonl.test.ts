import { expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Effect } from "effect";
import { readJsonLines } from "../src/jsonl";

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
