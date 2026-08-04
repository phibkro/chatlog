import { Console, Effect } from "effect";
import { randomUUID } from "node:crypto";
import { chmod, link, mkdir, open, readFile, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

interface LockRecord {
  pid: number;
  runId: string;
  startedAt: string;
  processStartIdentity?: string;
}

const PARTIAL_LOCK_GRACE_MS = 1_000;
const RECLAIM_CLAIM_STALE_MS = 60_000;

export class IngestLockedError extends Error {
  constructor(
    public readonly lock: Partial<LockRecord>,
    label = "ingest",
  ) {
    super(`${label} already running${lock.pid ? ` (pid ${lock.pid})` : ""}`);
    this.name = "IngestLockedError";
  }
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  const code = error.code;
  return typeof code === "string" ? code : undefined;
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    return errorCode(error) !== "ESRCH";
  }
}
function completeLockRecord(value: unknown): value is LockRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Partial<LockRecord>;
  return (
    Number.isInteger(record.pid) &&
    (record.pid ?? 0) > 0 &&
    typeof record.runId === "string" &&
    record.runId.length > 0 &&
    typeof record.startedAt === "string" &&
    Number.isFinite(Date.parse(record.startedAt)) &&
    (record.processStartIdentity === undefined ||
      (typeof record.processStartIdentity === "string" && record.processStartIdentity.length > 0))
  );
}

async function linuxProcessStartIdentity(pid: number): Promise<string | undefined> {
  if (process.platform !== "linux") return undefined;
  try {
    const contents = await readFile(`/proc/${pid}/stat`, "utf8");
    const closingCommand = contents.lastIndexOf(")");
    if (closingCommand < 0) return undefined;
    const fields = contents
      .slice(closingCommand + 2)
      .trim()
      .split(/\s+/);
    // `/proc/<pid>/stat` field 22 is process start time. After the command
    // name, field 3 becomes index 0, so field 22 is index 19.
    const identity = fields[19];
    return identity && identity.length > 0 ? identity : undefined;
  } catch {
    return undefined;
  }
}

async function ownerIsStale(record: LockRecord): Promise<boolean> {
  if (!processExists(record.pid)) return true;
  if (record.processStartIdentity === undefined) return false;
  const currentIdentity = await linuxProcessStartIdentity(record.pid);
  return currentIdentity !== undefined && currentIdentity !== record.processStartIdentity;
}

type LockObservation = {
  stale: boolean;
  missing: boolean;
  record: Partial<LockRecord>;
};

async function staleLock(path: string): Promise<LockObservation> {
  let record: Partial<LockRecord> = {};
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed))
      record = parsed as Partial<LockRecord>;
    if (completeLockRecord(parsed))
      return {
        stale: await ownerIsStale(parsed),
        missing: false,
        record,
      };
  } catch {
    // A crash can leave an empty or truncated record. It is reclaimable only
    // after the bounded grace period below.
  }
  try {
    const ageMs = Date.now() - (await stat(path)).mtimeMs;
    return {
      stale: ageMs > PARTIAL_LOCK_GRACE_MS,
      missing: false,
      record,
    };
  } catch (error: unknown) {
    if (errorCode(error) === "ENOENT") return { stale: false, missing: true, record: {} };
    return Promise.reject(error);
  }
}

async function removeReclaimClaim(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error: unknown) {
    if (errorCode(error) !== "ENOENT")
      await Effect.runPromise(
        Console.error(`stale lock reclaim cleanup failed for ${path}:`, error),
      );
  }
}

/**
 * `link(lock, claim)` is the compare-and-swap: the fixed claim can name only
 * the inode observed by one reclaimer. Before unlinking, that reclaimer proves
 * the lock path still names the claimed inode. A replacement lock is never
 * removed, even if it appeared after the original stale read.
 */
async function reclaimStaleLock(path: string): Promise<boolean> {
  const claim = `${path}.reclaim`;
  try {
    await link(path, claim);
  } catch (error: unknown) {
    if (errorCode(error) === "ENOENT") return false;
    if (errorCode(error) !== "EEXIST") return Promise.reject(error);
    try {
      const ageMs = Date.now() - (await stat(claim)).ctimeMs;
      if (ageMs > RECLAIM_CLAIM_STALE_MS) await removeReclaimClaim(claim);
    } catch (claimError: unknown) {
      if (errorCode(claimError) !== "ENOENT") return Promise.reject(claimError);
    }
    return false;
  }

  try {
    const observed = await staleLock(claim);
    if (!observed.stale) return false;
    let current;
    let claimed;
    try {
      [current, claimed] = await Promise.all([stat(path), stat(claim)]);
    } catch (error: unknown) {
      if (errorCode(error) === "ENOENT") return false;
      return Promise.reject(error);
    }
    if (current.dev !== claimed.dev || current.ino !== claimed.ino) return false;
    try {
      await unlink(path);
    } catch (error: unknown) {
      if (errorCode(error) !== "ENOENT") return Promise.reject(error);
    }
    return true;
  } finally {
    await removeReclaimClaim(claim);
  }
}

async function acquireFileLock(
  path: string,
  record: LockRecord,
  label: string,
  deadline: number,
): Promise<void> {
  while (true) {
    try {
      const handle = await open(path, "wx", 0o600);
      try {
        await handle.writeFile(JSON.stringify(record) + "\n");
      } finally {
        await handle.close();
      }
      await chmod(path, 0o600);
      return;
    } catch (error: unknown) {
      if (errorCode(error) !== "EEXIST") return Promise.reject(error);
    }

    const current = await staleLock(path);
    if (current.missing) continue;
    if (current.stale && (await reclaimStaleLock(path))) continue;
    if (Date.now() < deadline) {
      await sleep(10);
      continue;
    }
    return Promise.reject(new IngestLockedError(current.record, label));
  }
}

async function withFileLock<T>(
  root: string,
  filename: string,
  label: string,
  work: () => Promise<T>,
  waitMs = 0,
): Promise<T> {
  return Effect.runPromise(
    Effect.acquireUseRelease(
      Effect.tryPromise({
        try: async () => {
          const analysisDir = join(root, "analysis");
          const path = join(analysisDir, filename);
          const processStartIdentity = await linuxProcessStartIdentity(process.pid);
          const record: LockRecord = {
            pid: process.pid,
            runId: randomUUID(),
            startedAt: new Date().toISOString(),
            ...(processStartIdentity === undefined ? {} : { processStartIdentity }),
          };
          await mkdir(analysisDir, { recursive: true, mode: 0o700 });
          const deadline = Date.now() + waitMs;
          await chmod(analysisDir, 0o700);
          await acquireFileLock(path, record, label, deadline);
          return { path, record };
        },
        catch: asError,
      }),
      () => Effect.tryPromise({ try: work, catch: asError }),
      ({ path, record }) =>
        Effect.tryPromise({
          try: async () => {
            const current = JSON.parse(await readFile(path, "utf8")) as Partial<LockRecord>;
            if (current.runId === record.runId) await unlink(path);
          },
          catch: asError,
        }).pipe(
          Effect.catch((error) =>
            errorCode(error) === "ENOENT"
              ? Effect.void
              : Effect.logError(`${label} lock cleanup failed for ${path}:`, error),
          ),
        ),
    ),
  );
}

export function withIngestLock<T>(root: string, work: () => Promise<T>): Promise<T> {
  return withFileLock(root, "ingest.lock", "ingest", work);
}

export function withContextFinalizationLock<T>(root: string, work: () => Promise<T>): Promise<T> {
  return withFileLock(root, "context-finalization.lock", "context finalization", work, 5_000);
}
