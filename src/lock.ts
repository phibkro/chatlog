import { chmod, mkdir, open, readFile, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

interface LockRecord { pid: number; runId: string; startedAt: string }

export class IngestLockedError extends Error {
  constructor(public readonly lock: Partial<LockRecord>) {
    super(`ingest already running${lock.pid ? ` (pid ${lock.pid})` : ""}`);
    this.name = "IngestLockedError";
  }
}

function processExists(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error: any) { return error?.code !== "ESRCH"; }
}

async function staleLock(path: string): Promise<{ stale: boolean; record: Partial<LockRecord> }> {
  try {
    const record = JSON.parse(await readFile(path, "utf8")) as Partial<LockRecord>;
    return { stale: typeof record.pid === "number" && !processExists(record.pid), record };
  } catch {
    const ageMs = Date.now() - (await stat(path)).mtimeMs;
    return { stale: ageMs > 6 * 60 * 60 * 1000, record: {} };
  }
}

export async function withIngestLock<T>(root: string, work: () => Promise<T>): Promise<T> {
  const analysisDir = join(root, "analysis");
  const path = join(analysisDir, "ingest.lock");
  const record: LockRecord = { pid: process.pid, runId: randomUUID(), startedAt: new Date().toISOString() };
  await mkdir(analysisDir, { recursive: true, mode: 0o700 });
  await chmod(analysisDir, 0o700);
  for (let attempt = 0; ; attempt++) {
    try {
      const handle = await open(path, "wx", 0o600);
      try { await handle.writeFile(JSON.stringify(record) + "\n"); }
      finally { await handle.close(); }
      await chmod(path, 0o600);
      break;
    } catch (error: any) {
      if (error?.code !== "EEXIST" || attempt > 0) throw error;
      const current = await staleLock(path);
      if (!current.stale) throw new IngestLockedError(current.record);
      await unlink(path);
    }
  }
  try { return await work(); }
  finally {
    try {
      const current = JSON.parse(await readFile(path, "utf8")) as Partial<LockRecord>;
      if (current.runId === record.runId) await unlink(path);
    } catch (error: any) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
}
