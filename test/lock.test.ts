import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, unlink, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { IngestLockedError, withContextFinalizationLock, withIngestLock } from "../src/lock";

type PublicLock = (root: string, work: () => Promise<void>) => Promise<unknown>;

async function runStaleContenders(lock: PublicLock, filename: string, count: number) {
  const root = await mkdtemp(join(tmpdir(), "chatlog-lock-"));
  await mkdir(join(root, "analysis"));
  await writeFile(
    join(root, "analysis", filename),
    JSON.stringify({ pid: 999_999_999, runId: "dead", startedAt: "2020-01-01T00:00:00Z" }),
  );

  const { promise: start, resolve: releaseStart } = Promise.withResolvers<void>();
  const { promise: allAttempted, resolve: releaseAllAttempted } = Promise.withResolvers<void>();
  let attempted = 0;
  let active = 0;
  let peak = 0;
  let completed = 0;
  const attempts = Array.from({ length: count }, async () => {
    await start;
    attempted += 1;
    if (attempted === count) releaseAllAttempted();
    try {
      await lock(root, async () => {
        active += 1;
        peak = Math.max(peak, active);
        await allAttempted;
        active -= 1;
        completed += 1;
      });
      return true;
    } catch (error) {
      if (error instanceof IngestLockedError) return false;
      throw error;
    }
  });

  releaseStart();
  const results = await Promise.all(attempts);
  return { completed, peak, successes: results.filter(Boolean).length };
}

test("reclaims one stale lock without overlapping critical sections", async () => {
  const ingest = await runStaleContenders(withIngestLock, "ingest.lock", 96);
  expect(ingest.peak).toBe(1);
  expect(ingest.successes).toBe(1);
  expect(ingest.completed).toBe(1);

  const contextFinalization = await runStaleContenders(
    withContextFinalizationLock,
    "context-finalization.lock",
    96,
  );
  expect(contextFinalization.peak).toBe(1);
  expect(contextFinalization.successes).toBe(96);
  expect(contextFinalization.completed).toBe(96);
});

test("prevents overlapping ingests and releases afterward", async () => {
  const root = await mkdtemp(join(tmpdir(), "chatlog-lock-"));
  await withIngestLock(root, async () => {
    await expect(withIngestLock(root, async () => "overlap")).rejects.toBeInstanceOf(
      IngestLockedError,
    );
  });
  await expect(withIngestLock(root, async () => "next")).resolves.toBe("next");
});

test("recovers a dead process lock", async () => {
  const root = await mkdtemp(join(tmpdir(), "chatlog-lock-"));
  await mkdir(join(root, "analysis"));
  await writeFile(
    join(root, "analysis", "ingest.lock"),
    JSON.stringify({ pid: 999_999_999, runId: "dead", startedAt: "2020-01-01T00:00:00Z" }),
  );
  await expect(withIngestLock(root, async () => "recovered")).resolves.toBe("recovered");
});

async function currentLinuxStartIdentity(): Promise<string | undefined> {
  if (process.platform !== "linux") return undefined;
  const contents = await readFile(`/proc/${process.pid}/stat`, "utf8");
  const closingCommand = contents.lastIndexOf(")");
  return contents
    .slice(closingCommand + 2)
    .trim()
    .split(/\s+/)[19];
}

test("does not steal a newly partial lock during its bounded grace", async () => {
  const root = await mkdtemp(join(tmpdir(), "chatlog-lock-partial-"));
  const path = join(root, "analysis", "ingest.lock");
  await mkdir(join(root, "analysis"));
  await writeFile(path, '{"pid":');
  await expect(withIngestLock(root, async () => "stolen")).rejects.toBeInstanceOf(
    IngestLockedError,
  );
});

test("reclaims an old partial lock after the bounded grace", async () => {
  const root = await mkdtemp(join(tmpdir(), "chatlog-lock-partial-old-"));
  const path = join(root, "analysis", "ingest.lock");
  await mkdir(join(root, "analysis"));
  await writeFile(path, '{"pid":');
  const old = new Date(Date.now() - 5_000);
  await utimes(path, old, old);
  await expect(withIngestLock(root, async () => "reclaimed")).resolves.toBe("reclaimed");
});

test("reclaims a reused PID identity but preserves a matching live owner", async () => {
  const identity = await currentLinuxStartIdentity();
  if (identity === undefined) return;
  const root = await mkdtemp(join(tmpdir(), "chatlog-lock-pid-"));
  const path = join(root, "analysis", "ingest.lock");
  await mkdir(join(root, "analysis"));
  const base = {
    pid: process.pid,
    runId: "owner",
    startedAt: new Date().toISOString(),
  };
  await writeFile(path, JSON.stringify({ ...base, processStartIdentity: "reused-pid" }));
  await expect(withIngestLock(root, async () => "reclaimed")).resolves.toBe("reclaimed");

  await writeFile(path, JSON.stringify({ ...base, processStartIdentity: identity }));
  await expect(withIngestLock(root, async () => "stolen")).rejects.toBeInstanceOf(
    IngestLockedError,
  );
  await unlink(path);
});
