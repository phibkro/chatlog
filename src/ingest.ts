import { chmod, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { canonicalEventBatch, EVENT_ADAPTER_RECIPE, type EventBatch } from "./events";
import { persistEventBatch } from "./event-store";
import { indexConversation, indexEventBatch, openAnalysis, backfillCacheWrite } from "./analysis";
import { projectConversation } from "./conversation-projection";
import { withIngestLock } from "./lock";
import { deriveCorpus, type DeriveSummary } from "./derive";
import { PROJECT_IDENTITY_RECIPE } from "./project-identity";
import { REDACTION_RECIPE } from "./redact";
import { refineCorpus, type RefinerySummary } from "./refinery";
import { reconcileSourceAuthority } from "./source-authority";
import { semanticLossCounts, sourceItemAccounting } from "./adapter-conformance";
import {
  buildSourceReceipt,
  persistSourceReceipt,
  persistUnknownShapeNominations,
} from "./source-receipts";
import type { Conversation, SourceAdapter } from "./types";

interface ManifestEntry {
  size: number;
  mtimeMs: number;
  contentHash: string;
  eventBatchHash?: string;
  conversationProjectionHash?: string;
  receiptHash?: string;
}
interface Manifest {
  version: 1;
  redactionRecipe?: string;
  projectIdentityRecipe?: string;
  eventRecipe?: string;
  sources: Record<string, ManifestEntry>;
}

async function loadManifest(path: string): Promise<Manifest> {
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as Manifest;
    if (value.version !== 1 || !value.sources) throw new Error("unsupported manifest shape");
    return value;
  } catch (error: unknown) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT")
      return { version: 1, sources: {} };
    throw error;
  }
}

async function atomicWrite(path: string, data: string, mode = 0o600): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, data, { mode });
  await rename(tmp, path);
  await chmod(path, mode);
}

export interface IngestSummary {
  discovered: Record<string, number>;
  ingested: Record<string, number>;
  skipped: Record<string, number>;
  partialTails: number;
  changedDuringRead: number;
  corpusBytes: number;
  sourceReceipts: number;
  opaqueItems: number;
  policyOmissions: number;
  lossCounts: Record<string, number>;
  derived?: DeriveSummary;
  refinery?: RefinerySummary;
}

function eventBatchResult(value: EventBatch): { batch: EventBatch; partialTail: boolean } {
  const batch = canonicalEventBatch(value);
  return { batch, partialTail: batch.partialTail };
}

export async function ingest(adapters: SourceAdapter[], root: string): Promise<IngestSummary> {
  return withIngestLock(root, () => ingestUnlocked(adapters, root));
}

async function ingestUnlocked(adapters: SourceAdapter[], root: string): Promise<IngestSummary> {
  const corpusDir = join(root, "corpus");
  const manifestPath = join(corpusDir, "manifest.json");
  const dbPath = join(root, "analysis", "chatlog.sqlite");
  await mkdir(corpusDir, { recursive: true, mode: 0o700 });
  await chmod(corpusDir, 0o700);
  const manifest = await loadManifest(manifestPath);
  const redactionChanged = manifest.redactionRecipe !== REDACTION_RECIPE;
  const projectIdentityChanged = manifest.projectIdentityRecipe !== PROJECT_IDENTITY_RECIPE;
  const eventRecipeChanged = manifest.eventRecipe !== EVENT_ADAPTER_RECIPE;
  const db = openAnalysis(dbPath);
  const summary: IngestSummary = {
    discovered: {},
    ingested: {},
    skipped: {},
    sourceReceipts: 0,
    opaqueItems: 0,
    policyOmissions: 0,
    lossCounts: {},
    partialTails: 0,
    changedDuringRead: 0,
    corpusBytes: 0,
  };
  try {
    await reconcileSourceAuthority(root, db, manifest.sources);
    const backfilled = await backfillCacheWrite(db, corpusDir);
    if (backfilled)
      console.error(`analysis: backfilled cache-write totals for ${backfilled} corpus objects`);
    for (const adapter of adapters) {
      const files = await adapter.discover();
      summary.discovered[adapter.harness] = files.length;
      summary.ingested[adapter.harness] = 0;
      summary.skipped[adapter.harness] = 0;
      for (const [index, source] of files.entries()) {
        const old = manifest.sources[source.path];
        if (
          !redactionChanged &&
          !projectIdentityChanged &&
          !eventRecipeChanged &&
          old?.eventBatchHash &&
          old?.conversationProjectionHash &&
          old?.receiptHash &&
          old.size === source.size &&
          old.mtimeMs === source.mtimeMs
        ) {
          summary.skipped[adapter.harness]++;
          continue;
        }
        const result = await adapter.adapt(source);
        const adapted = eventBatchResult(result);
        if (adapted.partialTail) summary.partialTails++;
        const accounting = sourceItemAccounting(adapted.batch);
        summary.opaqueItems += accounting.opaqueItems;
        summary.policyOmissions += accounting.policyOmissions;
        for (const [code, count] of Object.entries(semanticLossCounts(adapted.batch.semanticLoss)))
          summary.lossCounts[code] = (summary.lossCounts[code] ?? 0) + count;
        const after = await stat(source.path);
        if (after.size !== source.size || after.mtimeMs !== source.mtimeMs)
          summary.changedDuringRead++;
        const batchHash = await persistEventBatch(root, adapted.batch);
        const conversation: Conversation = projectConversation(adapted.batch);
        const outputPath = join(
          corpusDir,
          "objects",
          conversation.contentHash.slice(0, 2),
          `${conversation.contentHash}.json`,
        );
        try {
          await stat(outputPath);
        } catch (error: unknown) {
          const code =
            error && typeof error === "object" && "code" in error ? error.code : undefined;
          if (code !== "ENOENT") throw error;
          await atomicWrite(outputPath, JSON.stringify(conversation) + "\n");
        }
        const receipt = buildSourceReceipt({
          batch: adapted.batch,
          batchHash,
          conversationProjectionHash: conversation.contentHash,
        });
        await persistSourceReceipt(root, receipt);
        await persistUnknownShapeNominations(root, [adapted.batch], receipt.source.hash);
        indexEventBatch(db, adapted.batch, batchHash, conversation.contentHash);
        indexConversation(db, conversation, source.mtimeMs, source.size);
        manifest.sources[source.path] = {
          size: source.size,
          mtimeMs: source.mtimeMs,
          contentHash: conversation.contentHash,
          eventBatchHash: batchHash,
          conversationProjectionHash: conversation.contentHash,
          receiptHash: receipt.receiptHash,
        };
        summary.sourceReceipts++;
        summary.ingested[adapter.harness]++;
        if ((index + 1) % 100 === 0)
          console.error(`${adapter.harness}: ${index + 1}/${files.length}`);
      }
    }
    manifest.redactionRecipe = REDACTION_RECIPE;
    manifest.projectIdentityRecipe = PROJECT_IDENTITY_RECIPE;
    manifest.eventRecipe = EVENT_ADAPTER_RECIPE;
    await atomicWrite(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
    await reconcileSourceAuthority(root, db, manifest.sources);
  } finally {
    db.close();
  }
  async function size(dir: string): Promise<number> {
    let total = 0;
    for (const entry of new Bun.Glob("**/*").scanSync({ cwd: dir, onlyFiles: true, dot: true }))
      total += (await stat(join(dir, entry))).size;
    return total;
  }
  summary.corpusBytes = await size(corpusDir);
  summary.derived = await deriveCorpus(root);
  summary.refinery = await refineCorpus(root);
  return summary;
}
