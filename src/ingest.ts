import { chmod, mkdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { Conversation, SourceAdapter } from "./types";
import { backfillCacheWrite, indexConversation, openAnalysis } from "./analysis";
import { durableAtomicWrite } from "./durable-fs";
import { withIngestLock } from "./lock";
import type { DeriveSummary } from "./derive";
import {
  createOperationIntent,
  recoverPendingOperations,
  resolveManifestWriteFailure,
  resumeCommittedOperation,
} from "./operation-intents";
import { redact, REDACTION_RECIPE } from "./redact";
import type { RefinerySummary } from "./refinery";
import { reconcileSourceAuthority } from "./source-authority";

interface ManifestEntry { size: number; mtimeMs: number; contentHash: string }
interface Manifest { version: 1; redactionRecipe?: string; sources: Record<string, ManifestEntry> }

async function loadManifest(path: string): Promise<Manifest> {
  try {
    const value = JSON.parse(await readFile(path, "utf8"));
    if (value.version !== 1 || !value.sources) throw new Error("unsupported manifest shape");
    return value;
  } catch (error: any) {
    if (error?.code === "ENOENT") return { version: 1, sources: {} };
    throw error;
  }
}

async function atomicWrite(path: string, data: string, mode = 0o600): Promise<void> {
  await durableAtomicWrite(path, data, { mode });
}

export function canonicalizeConversation(value: Omit<Conversation, "contentHash">): Conversation {
  // Scrub the serialized canonical value as a final boundary. Adapters still
  // redact eagerly, while this catches nested tool data and future metadata.
  const scrub = (item: unknown): unknown => {
    if (typeof item === "string") return redact(item);
    if (Array.isArray(item)) return item.map(scrub);
    if (item && typeof item === "object") return Object.fromEntries(Object.entries(item).map(([key, child]) => [key, scrub(child)]));
    return item;
  };
  const scrubbed = scrub(value) as Omit<Conversation, "contentHash">;
  const normalized = JSON.stringify(scrubbed);
  const hash = new Bun.CryptoHasher("sha256").update(normalized).digest("hex");
  return { ...scrubbed, contentHash: hash };
}

export interface IngestSummary {
  discovered: Record<string, number>; ingested: Record<string, number>; skipped: Record<string, number>;
  partialTails: number; changedDuringRead: number; corpusBytes: number; derived?: DeriveSummary; refinery?: RefinerySummary;
}

export async function ingest(adapters: SourceAdapter[], root: string): Promise<IngestSummary> {
  return withIngestLock(root, () => ingestUnlocked(adapters, root));
}

async function ingestUnlocked(adapters: SourceAdapter[], root: string): Promise<IngestSummary> {
  await recoverPendingOperations(root);
  const corpusDir = join(root, "corpus");
  const manifestPath = join(corpusDir, "manifest.json");
  const dbPath = join(root, "analysis", "chatlog.sqlite");
  await mkdir(corpusDir, { recursive: true, mode: 0o700 });
  await chmod(corpusDir, 0o700);
  const manifest = await loadManifest(manifestPath);
  const beforeManifest = structuredClone(manifest);
  const redactionChanged = manifest.redactionRecipe !== REDACTION_RECIPE;
  const db = openAnalysis(dbPath);
  const summary: IngestSummary = { discovered: {}, ingested: {}, skipped: {}, partialTails: 0, changedDuringRead: 0, corpusBytes: 0 };
  try {
    await reconcileSourceAuthority(root, db, manifest.sources);
    const backfilled = await backfillCacheWrite(db, corpusDir);
    if (backfilled) console.error(`analysis: backfilled cache-write totals for ${backfilled} corpus objects`);
    for (const adapter of adapters) {
      const files = await adapter.discover();
      summary.discovered[adapter.harness] = files.length;
      summary.ingested[adapter.harness] = 0;
      summary.skipped[adapter.harness] = 0;
      for (const [index, source] of files.entries()) {
        const old = manifest.sources[source.path];
        if (!redactionChanged && old?.size === source.size && old?.mtimeMs === source.mtimeMs) { summary.skipped[adapter.harness]++; continue; }
        const result = await adapter.adapt(source);
        if (result.partialTail) summary.partialTails++;
        const after = await stat(source.path);
        if (after.size !== source.size || after.mtimeMs !== source.mtimeMs) summary.changedDuringRead++;
        const conversation = canonicalizeConversation(result.conversation);
        const outputPath = join(corpusDir, "objects", conversation.contentHash.slice(0, 2), `${conversation.contentHash}.json`);
        try { await stat(outputPath); } catch (error: any) {
          if (error?.code !== "ENOENT") throw error;
          await atomicWrite(outputPath, JSON.stringify(conversation) + "\n");
        }
        indexConversation(db, conversation, source.mtimeMs, source.size);
        manifest.sources[source.path] = { size: source.size, mtimeMs: source.mtimeMs, contentHash: conversation.contentHash };
        summary.ingested[adapter.harness]++;
        if ((index + 1) % 100 === 0) console.error(`${adapter.harness}: ${index + 1}/${files.length}`);
      }
    }
    manifest.redactionRecipe = REDACTION_RECIPE;
  } finally { db.close(); }
  const intent = await createOperationIntent(root, {
    operation: "ingest",
    before: beforeManifest,
    after: manifest,
    derive: true,
  });
  try {
    await atomicWrite(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  } catch (error) {
    await resolveManifestWriteFailure(root, intent, error);
  }
  const operation = await resumeCommittedOperation(root, intent);
  summary.derived = operation.derived;
  summary.refinery = operation.refinery;
  if (operation.derivationFailed) {
    throw new Error(
      `ingest committed as operation ${intent.operationId}, but derived state was explicitly invalidated after derivation failed`,
    );
  }
  async function size(dir: string): Promise<number> {
    let total = 0;
    for (const entry of new Bun.Glob("**/*").scanSync({ cwd: dir, onlyFiles: true, dot: true })) total += (await stat(join(dir, entry))).size;
    return total;
  }
  summary.corpusBytes = await size(corpusDir);
  return summary;
}
