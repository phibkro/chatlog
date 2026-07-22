import { expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { IngestLockedError, withIngestLock } from "../src/lock";

test("prevents overlapping ingests and releases afterward", async () => {
  const root = await mkdtemp(join(tmpdir(), "chatlog-lock-"));
  await withIngestLock(root, async () => {
    await expect(withIngestLock(root, async () => "overlap")).rejects.toBeInstanceOf(IngestLockedError);
  });
  await expect(withIngestLock(root, async () => "next")).resolves.toBe("next");
});

test("recovers a dead process lock", async () => {
  const root = await mkdtemp(join(tmpdir(), "chatlog-lock-"));
  await mkdir(join(root, "analysis"));
  await writeFile(join(root, "analysis", "ingest.lock"), JSON.stringify({ pid: 999_999_999, runId: "dead", startedAt: "2020-01-01T00:00:00Z" }));
  await expect(withIngestLock(root, async () => "recovered")).resolves.toBe("recovered");
});
