import { appendFile, chmod, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { SourceAdapter } from "./types";
import type { IngestSummary } from "./ingest";
import { ingest } from "./ingest";
import { redact } from "./redact";

interface ScheduledRun {
  startedAt: string;
  endedAt: string;
  durationMs: number;
  status: "ok" | "error";
  summary?: IngestSummary;
  error?: string;
}

async function recordRun(root: string, run: ScheduledRun): Promise<void> {
  const dir = join(root, "analysis");
  const path = join(dir, "ingest-runs.jsonl");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await appendFile(path, redact(JSON.stringify(run)) + "\n", { mode: 0o600 });
  await chmod(path, 0o600);
}

export async function scheduledIngest(adapters: SourceAdapter[], root: string): Promise<ScheduledRun> {
  const startedAt = new Date();
  try {
    const summary = await ingest(adapters, root);
    const endedAt = new Date();
    const run: ScheduledRun = { startedAt: startedAt.toISOString(), endedAt: endedAt.toISOString(), durationMs: endedAt.getTime() - startedAt.getTime(), status: "ok", summary };
    await recordRun(root, run);
    return run;
  } catch (error) {
    const endedAt = new Date();
    const run: ScheduledRun = { startedAt: startedAt.toISOString(), endedAt: endedAt.toISOString(), durationMs: endedAt.getTime() - startedAt.getTime(), status: "error", error: redact(error instanceof Error ? `${error.name}: ${error.message}` : String(error)) };
    await recordRun(root, run);
    throw error;
  }
}
