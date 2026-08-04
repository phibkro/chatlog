import { Effect } from "effect";
import { join, resolve } from "node:path";
import { indexEventBatch, openAnalysis } from "./analysis";
import { readEventBatch } from "./event-store";
import { MAX_STAGED_RECALL_EVENT_BATCHES } from "./context-types";
import { withIngestLock } from "./lock";

const HASH = /^[a-f0-9]{64}$/u;

type EventBatchHashesResult =
  | { readonly ok: true; readonly value: string[] }
  | { readonly ok: false; readonly error: Error };

function eventBatchHashes(value: unknown, source: string): EventBatchHashesResult {
  if (
    !Array.isArray(value) ||
    value.length > MAX_STAGED_RECALL_EVENT_BATCHES ||
    value.some((hash) => typeof hash !== "string" || !HASH.test(hash))
  )
    return {
      ok: false,
      error: new Error(
        `${source} pendingEventBatchHashes must contain at most ${MAX_STAGED_RECALL_EVENT_BATCHES} lowercase SHA-256 hashes`,
      ),
    };
  return { ok: true, value: [...new Set(value)] };
}

export async function publishContextEventBatches(
  root: string,
  batchHashes: readonly string[],
): Promise<void> {
  const parsed = eventBatchHashes(batchHashes, "context event outbox");
  if (!parsed.ok) return Promise.reject(parsed.error);
  const hashes = parsed.value;
  if (hashes.length === 0) return;
  const batches = await Effect.runPromise(
    Effect.all(
      hashes.map((hash) => Effect.promise(() => readEventBatch(root, hash))),
      { concurrency: 8 },
    ),
  );
  await withIngestLock(root, async () => {
    const db = openAnalysis(join(resolve(root), "analysis", "chatlog.sqlite"));
    try {
      for (const [index, batch] of batches.entries()) indexEventBatch(db, batch, hashes[index]!);
    } finally {
      db.close();
    }
  });
}
