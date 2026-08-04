import { chmod, mkdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { Data, Effect } from "effect";
import { canonicalEventBatch, EVENT_ADAPTER_RECIPE, type EventBatch } from "./events";
import { persistEventBatch } from "./event-store";
import { indexConversation, indexEventBatch, openAnalysis, backfillCacheWrite } from "./analysis";
import { projectConversation } from "./conversation-projection";
import { withIngestLock } from "./lock";
import type { DeriveSummary } from "./derive";
import { durableAtomicWrite } from "./durable-fs";
import { PROJECT_IDENTITY_RECIPE } from "./project-identity";
import { REDACTION_RECIPE } from "./redact";
import {
  createOperationIntent,
  recoverPendingOperations,
  resolveManifestWriteFailure,
  resumeCommittedOperation,
} from "./operation-intents";
import type { RefinerySummary } from "./refinery";
import {
  readCanonicalConversationObject,
  reconcileSourceAuthority,
  type CorpusManifest,
  type ManifestRecipeSet,
  type ManifestSourceEntry,
} from "./source-authority";
import { semanticLossCounts, sourceItemAccounting } from "./adapter-conformance";
import {
  buildSourceReceipt,
  persistSourceReceipt,
  persistUnknownShapeNominations,
} from "./source-receipts";
import type { Conversation, SourceAdapter, SourceFile } from "./types";
export { canonicalizeConversation } from "./conversation-projection";

type RecipeSet = ManifestRecipeSet;
type ManifestEntry = ManifestSourceEntry;
type Manifest = CorpusManifest;

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
  await durableAtomicWrite(path, data, { mode });
}

export interface IngestSummary {
  discovered: Record<string, number>;
  ingested: Record<string, number>;
  skipped: Record<string, number>;
  deferred: Record<string, number>;
  unsettled: Record<string, number>;
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

export const DEFAULT_INGEST_MAX_SOURCES_PER_ADAPTER = 256;

export interface IngestOptions {
  maxSourcesPerAdapter?: number;
  minimumSourceAgeMs?: number;
}

export class IngestConfigurationError extends Error {
  override readonly name = "IngestConfigurationError";
}

export class IngestSourceStatError extends Data.TaggedError("IngestSourceStatError")<{
  readonly message: string;
  readonly path: string;
  readonly code?: string;
  readonly cause: unknown;
}> {}

function eventBatchResult(value: EventBatch): { batch: EventBatch; partialTail: boolean } {
  const batch = canonicalEventBatch(value);
  return { batch, partialTail: batch.partialTail };
}

const CURRENT_RECIPES: RecipeSet = {
  redactionRecipe: REDACTION_RECIPE,
  projectIdentityRecipe: PROJECT_IDENTITY_RECIPE,
  eventRecipe: EVENT_ADAPTER_RECIPE,
};

function sameRecipes(value: Partial<RecipeSet> | undefined, expected: RecipeSet): boolean {
  return (
    value?.redactionRecipe === expected.redactionRecipe &&
    value.projectIdentityRecipe === expected.projectIdentityRecipe &&
    value.eventRecipe === expected.eventRecipe
  );
}

function sourceRecipesCurrent(manifest: Manifest, entry: ManifestEntry | undefined): boolean {
  const entryHasRecipes =
    entry?.redactionRecipe !== undefined ||
    entry?.projectIdentityRecipe !== undefined ||
    entry?.eventRecipe !== undefined;
  if (sameRecipes(manifest, CURRENT_RECIPES))
    return !entryHasRecipes || sameRecipes(entry, CURRENT_RECIPES);
  return (
    sameRecipes(manifest.recipeMigration, CURRENT_RECIPES) && sameRecipes(entry, CURRENT_RECIPES)
  );
}

function normalizeIngestOptions(
  options: IngestOptions,
): Required<IngestOptions> | IngestConfigurationError {
  const maxSourcesPerAdapter =
    options.maxSourcesPerAdapter ?? DEFAULT_INGEST_MAX_SOURCES_PER_ADAPTER;
  const minimumSourceAgeMs = options.minimumSourceAgeMs ?? 0;
  if (!Number.isSafeInteger(maxSourcesPerAdapter) || maxSourcesPerAdapter < 1)
    return new IngestConfigurationError("maxSourcesPerAdapter must be a positive safe integer");
  if (!Number.isSafeInteger(minimumSourceAgeMs) || minimumSourceAgeMs < 0)
    return new IngestConfigurationError("minimumSourceAgeMs must be a non-negative safe integer");
  return { maxSourcesPerAdapter, minimumSourceAgeMs };
}

function selectTemporalSample(
  sources: readonly SourceFile[],
  maximum: number,
): ReadonlySet<string> {
  if (sources.length <= maximum) return new Set(sources.map((source) => source.path));
  const ordered = sources.toSorted(
    (left, right) => left.mtimeMs - right.mtimeMs || left.path.localeCompare(right.path),
  );
  if (maximum === 1) return new Set([ordered.at(-1)!.path]);
  const selected = new Set<string>();
  for (let index = 0; index < maximum; index++) {
    const candidate = ordered[Math.round((index * (ordered.length - 1)) / (maximum - 1))]!;
    selected.add(candidate.path);
  }
  return selected;
}

export async function ingest(
  adapters: SourceAdapter[],
  root: string,
  options: IngestOptions = {},
): Promise<IngestSummary> {
  const normalized = normalizeIngestOptions(options);
  if (normalized instanceof IngestConfigurationError) return Promise.reject(normalized);
  return withIngestLock(root, () => ingestUnlocked(adapters, root, normalized));
}

async function ingestUnlocked(
  adapters: SourceAdapter[],
  root: string,
  options: Required<IngestOptions>,
): Promise<IngestSummary> {
  await recoverPendingOperations(root);
  const corpusDir = join(root, "corpus");
  const manifestPath = join(corpusDir, "manifest.json");
  const dbPath = join(root, "analysis", "chatlog.sqlite");
  await mkdir(corpusDir, { recursive: true, mode: 0o700 });
  await chmod(corpusDir, 0o700);
  const manifest = await loadManifest(manifestPath);
  const beforeManifest = structuredClone(manifest);
  const sampleTime = Date.now();
  let recipeMigrationDeferred = false;
  const db = openAnalysis(dbPath);
  const summary: IngestSummary = {
    discovered: {},
    ingested: {},
    skipped: {},
    deferred: {},
    unsettled: {},
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
    const backfilled = await Effect.runPromise(backfillCacheWrite(db, corpusDir));
    if (backfilled)
      console.error(`analysis: backfilled cache-write totals for ${backfilled} corpus objects`);
    for (const adapter of adapters) {
      const files = await adapter.discover();
      const candidates = files.filter((source) => {
        const old = manifest.sources[source.path];
        return !(
          sourceRecipesCurrent(manifest, old) &&
          old?.eventBatchHash &&
          old.conversationProjectionHash &&
          old.receiptHash &&
          old.size === source.size &&
          old.mtimeMs === source.mtimeMs
        );
      });
      const unsettledPaths = new Set(
        options.minimumSourceAgeMs === 0
          ? []
          : candidates
              .filter((source) => source.mtimeMs > sampleTime - options.minimumSourceAgeMs)
              .map((source) => source.path),
      );
      const eligible = candidates.filter((source) => !unsettledPaths.has(source.path));
      const selectedPaths = selectTemporalSample(eligible, options.maxSourcesPerAdapter);
      const candidatePaths = new Set(candidates.map((source) => source.path));
      for (const source of candidates)
        if (
          !selectedPaths.has(source.path) &&
          !sourceRecipesCurrent(manifest, manifest.sources[source.path])
        )
          recipeMigrationDeferred = true;
      summary.discovered[adapter.harness] = files.length;
      summary.ingested[adapter.harness] = 0;
      summary.skipped[adapter.harness] = 0;
      summary.deferred[adapter.harness] = candidates.length - selectedPaths.size;
      summary.unsettled[adapter.harness] = unsettledPaths.size;
      for (const source of files) {
        if (!candidatePaths.has(source.path)) {
          summary.skipped[adapter.harness]++;
          continue;
        }
        if (!selectedPaths.has(source.path)) continue;
        const result = await adapter.adapt(source);
        const adapted = eventBatchResult(result);
        const after = await Effect.runPromise(
          Effect.tryPromise({
            try: () => stat(source.path),
            catch: (cause) =>
              new IngestSourceStatError({
                message: `cannot verify adapted source stability: ${source.path}`,
                path: source.path,
                code:
                  cause && typeof cause === "object" && "code" in cause
                    ? String(cause.code)
                    : undefined,
                cause,
              }),
          }).pipe(
            Effect.catch((error) =>
              error.code === "ENOENT" ? Effect.succeed(null) : Effect.fail(error),
            ),
          ),
        );
        const changedDuringRead =
          after === null || after.size !== source.size || after.mtimeMs !== source.mtimeMs;
        if (changedDuringRead) {
          summary.changedDuringRead++;
          summary.deferred[adapter.harness]++;
          recipeMigrationDeferred = true;
          continue;
        }
        if (adapted.partialTail) summary.partialTails++;
        const accounting = sourceItemAccounting(adapted.batch);
        summary.opaqueItems += accounting.opaqueItems;
        summary.policyOmissions += accounting.policyOmissions;
        for (const [code, count] of Object.entries(semanticLossCounts(adapted.batch.semanticLoss)))
          summary.lossCounts[code] = (summary.lossCounts[code] ?? 0) + count;
        const conversation: Conversation = projectConversation(adapted.batch);
        const outputPath = join(
          corpusDir,
          "objects",
          conversation.contentHash.slice(0, 2),
          `${conversation.contentHash}.json`,
        );
        try {
          await stat(outputPath);
          await readCanonicalConversationObject(
            root,
            conversation.sourcePath,
            conversation.contentHash,
          );
        } catch (error: unknown) {
          const code =
            error && typeof error === "object" && "code" in error ? error.code : undefined;
          if (code !== "ENOENT") throw error;
          await atomicWrite(outputPath, JSON.stringify(conversation) + "\n");
        }
        const batchHash = await persistEventBatch(root, adapted.batch);
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
          ...CURRENT_RECIPES,
        };
        summary.sourceReceipts++;
        summary.ingested[adapter.harness]++;
        if (summary.ingested[adapter.harness] % 100 === 0)
          console.error(
            `${adapter.harness}: adapted ${summary.ingested[adapter.harness]}/${selectedPaths.size}; discovered ${files.length}`,
          );
      }
    }
    if (recipeMigrationDeferred) {
      manifest.recipeMigration = { ...CURRENT_RECIPES };
    } else {
      manifest.redactionRecipe = REDACTION_RECIPE;
      manifest.projectIdentityRecipe = PROJECT_IDENTITY_RECIPE;
      manifest.eventRecipe = EVENT_ADAPTER_RECIPE;
      delete manifest.recipeMigration;
    }
  } finally {
    db.close();
  }
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
    for (const entry of new Bun.Glob("**/*").scanSync({ cwd: dir, onlyFiles: true, dot: true }))
      total += (await stat(join(dir, entry))).size;
    return total;
  }
  summary.corpusBytes = await size(corpusDir);
  return summary;
}
