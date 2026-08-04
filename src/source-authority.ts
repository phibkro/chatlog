import type { Database } from "bun:sqlite";
import { Effect } from "effect";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { indexConversation, indexEventBatch } from "./analysis";
import { validateCanonicalConversation } from "./conversation-projection";
import { eventBatchHash, readEventBatch } from "./event-store";
import { ACTIVE_SOURCE_AUTHORITY_VERSION, stableStringify } from "./events";
import { validateSourceReceipt, type SourceReceipt } from "./source-receipts";
import type { Conversation } from "./types";
import {
  EXPORT_MAX_CORPUS_OBJECT_BYTES,
  EXPORT_MAX_MANIFEST_BYTES,
  readBoundedFile,
  readBoundedFileSync,
} from "./importers/export-limits";

export { ACTIVE_SOURCE_AUTHORITY_VERSION };

export interface ManifestRecipeSet {
  redactionRecipe: string;
  projectIdentityRecipe: string;
  eventRecipe: string;
}

export interface ManifestSourceEntry {
  contentHash: string;
  eventBatchHash?: string;
  conversationProjectionHash?: string;
  receiptHash?: string;
  size?: number;
  mtimeMs?: number;
  redactionRecipe?: string;
  projectIdentityRecipe?: string;
  eventRecipe?: string;
}

export interface CorpusManifest {
  version: 1;
  redactionRecipe?: string;
  projectIdentityRecipe?: string;
  eventRecipe?: string;
  recipeMigration?: ManifestRecipeSet;
  sources: Record<string, ManifestSourceEntry>;
}

export interface ProjectionReceipt {
  manifestSourcesHash: string;
  activeSources: number;
  reconciledAt: string;
}

export class ActiveProjectionDriftError extends Error {
  constructor(
    message = "active source projection is unavailable or stale; run `chatlog source reconcile`",
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "ActiveProjectionDriftError";
  }
}

export class MissingIndexedSourceError extends Error {
  constructor(
    readonly sourcePath: string,
    readonly contentHash: string,
    options?: { cause?: unknown },
  ) {
    super(`manifest source is not indexed: ${sourcePath}`, options);
    this.name = "MissingIndexedSourceError";
  }
}

export class SourceAuthorityError extends Error {
  override readonly name = "SourceAuthorityError";
}

function invalidSourceAuthority(message: string): never {
  return Effect.runSync(Effect.fail(new SourceAuthorityError(message)));
}

function sha256(value: string): string {
  return new Bun.CryptoHasher("sha256").update(value).digest("hex");
}

function validateManifest(value: unknown, path: string): CorpusManifest {
  const manifest = value as Partial<CorpusManifest>;
  if (manifest?.version !== 1 || !manifest.sources || typeof manifest.sources !== "object")
    invalidSourceAuthority(`${path}: unsupported corpus manifest`);
  const validRecipe = (recipe: unknown): boolean =>
    typeof recipe === "string" && recipe.length > 0 && recipe.length <= 256;
  for (const key of ["redactionRecipe", "projectIdentityRecipe", "eventRecipe"] as const)
    if (manifest[key] !== undefined && !validRecipe(manifest[key]))
      invalidSourceAuthority(`${path}: invalid corpus recipe`);
  if (
    manifest.recipeMigration !== undefined &&
    (!manifest.recipeMigration ||
      typeof manifest.recipeMigration !== "object" ||
      !validRecipe(manifest.recipeMigration.redactionRecipe) ||
      !validRecipe(manifest.recipeMigration.projectIdentityRecipe) ||
      !validRecipe(manifest.recipeMigration.eventRecipe))
  )
    invalidSourceAuthority(`${path}: invalid corpus recipe migration`);
  for (const [sourcePath, entry] of Object.entries(manifest.sources)) {
    if (!sourcePath || !entry || !/^[a-f0-9]{64}$/.test(entry.contentHash))
      invalidSourceAuthority(`${path}: invalid source mapping`);
    for (const key of ["eventBatchHash", "conversationProjectionHash", "receiptHash"] as const)
      if (entry[key] !== undefined && !/^[a-f0-9]{64}$/.test(entry[key]!))
        invalidSourceAuthority(`${path}: invalid source mapping`);
    for (const key of ["redactionRecipe", "projectIdentityRecipe", "eventRecipe"] as const)
      if (entry[key] !== undefined && !validRecipe(entry[key]))
        invalidSourceAuthority(`${path}: invalid source recipe`);
  }
  return manifest as CorpusManifest;
}

function validateReceiptMappings(root: string, sources: Record<string, ManifestSourceEntry>): void {
  for (const [sourcePath, entry] of Object.entries(sources)) {
    if (!entry.receiptHash) continue;
    const receiptPath = join(
      root,
      "receipts",
      "sources",
      entry.receiptHash.slice(0, 2),
      `${entry.receiptHash}.json`,
    );
    let receipt: SourceReceipt;
    try {
      receipt = validateSourceReceipt(JSON.parse(readFileSync(receiptPath, "utf8")));
    } catch {
      invalidSourceAuthority(`${sourcePath}: source receipt is missing or invalid`);
    }
    if (
      receipt.receiptHash !== entry.receiptHash ||
      receipt.source.path !== sourcePath ||
      receipt.eventBatchHash !== entry.eventBatchHash ||
      receipt.conversationProjectionHash !== (entry.conversationProjectionHash ?? entry.contentHash)
    )
      invalidSourceAuthority(`${sourcePath}: source receipt does not match manifest mapping`);
  }
}
export function manifestSourcesHash(
  sources: Record<
    string,
    {
      contentHash: string;
      eventBatchHash?: string;
      conversationProjectionHash?: string;
      receiptHash?: string;
    }
  >,
): string {
  const canonical = Object.entries(sources)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([sourcePath, entry]) => [
      sourcePath,
      entry.contentHash,
      entry.eventBatchHash ?? null,
      entry.conversationProjectionHash ?? entry.contentHash,
      entry.receiptHash ?? null,
    ]);
  return sha256(stableStringify(canonical));
}

export async function loadCorpusManifest(root: string): Promise<CorpusManifest> {
  const path = join(root, "corpus", "manifest.json");
  const result = await readBoundedFile(
    path,
    EXPORT_MAX_MANIFEST_BYTES,
    `${path} (corpus manifest)`,
    root,
  );
  if (!result.ok) invalidSourceAuthority(result.error.message);
  return validateManifest(JSON.parse(result.value.text), path);
}

export function loadCorpusManifestSync(root: string): CorpusManifest {
  const path = join(root, "corpus", "manifest.json");
  const result = readBoundedFileSync(
    path,
    EXPORT_MAX_MANIFEST_BYTES,
    `${path} (corpus manifest)`,
    root,
  );
  if (!result.ok) invalidSourceAuthority(result.error.message);
  return validateManifest(JSON.parse(result.value.text), path);
}

export function reconcileActiveSources(
  db: Database,
  sources: Record<string, ManifestSourceEntry>,
  options: { force?: boolean } = {},
): ProjectionReceipt {
  const manifestSourcesHashValue = manifestSourcesHash(sources);
  const mappings = Object.entries(sources).sort(([left], [right]) => left.localeCompare(right));
  const currentMeta = db
    .query(`SELECT manifest_sources_hash manifestSourcesHash,
    reconciled_at reconciledAt FROM active_projection_meta WHERE singleton = 1`)
    .get() as { manifestSourcesHash: string; reconciledAt: string } | null;
  if (!options.force && currentMeta?.manifestSourcesHash === manifestSourcesHashValue) {
    const currentMappings = db
      .query(
        "SELECT source_path sourcePath, content_hash contentHash, event_batch_hash eventBatchHash, projection_hash projectionHash, receipt_hash receiptHash FROM active_sources ORDER BY source_path",
      )
      .all() as Array<{
      sourcePath: string;
      contentHash: string;
      eventBatchHash: string | null;
      projectionHash: string | null;
      receiptHash: string | null;
    }>;
    const currentHash = manifestSourcesHash(
      Object.fromEntries(
        currentMappings.map((row) => [
          row.sourcePath,
          {
            contentHash: row.contentHash,
            ...(row.eventBatchHash ? { eventBatchHash: row.eventBatchHash } : {}),
            ...(row.projectionHash ? { conversationProjectionHash: row.projectionHash } : {}),
            ...(row.receiptHash ? { receiptHash: row.receiptHash } : {}),
          },
        ]),
      ),
    );
    const missing = db
      .query(`SELECT 1 FROM active_sources a
      LEFT JOIN conversations c ON c.source_path = a.source_path AND c.content_hash = a.content_hash
      WHERE c.content_hash IS NULL LIMIT 1`)
      .get();
    const missingEvents = db
      .query(`SELECT 1 FROM active_sources a
      LEFT JOIN event_batches e ON e.batch_hash = a.event_batch_hash
      WHERE a.event_batch_hash IS NOT NULL AND e.batch_hash IS NULL LIMIT 1`)
      .get();
    if (currentHash === manifestSourcesHashValue && !missing && !missingEvents)
      return {
        manifestSourcesHash: manifestSourcesHashValue,
        activeSources: currentMappings.length,
        reconciledAt: currentMeta.reconciledAt,
      };
  }
  const previousTime = Date.parse(currentMeta?.reconciledAt ?? "");
  const reconciledAt = new Date(
    Math.max(Date.now(), Number.isFinite(previousTime) ? previousTime + 1 : 0),
  ).toISOString();
  const insert = db.prepare(`INSERT INTO active_sources
    (source_path, content_hash, event_batch_hash, projection_hash, receipt_hash, updated_at) VALUES (?, ?, ?, ?, ?, ?)`);
  db.transaction(() => {
    db.run("DELETE FROM active_sources");
    for (const [sourcePath, entry] of mappings)
      insert.run(
        sourcePath,
        entry.contentHash,
        entry.eventBatchHash ?? null,
        entry.conversationProjectionHash ?? entry.contentHash,
        entry.receiptHash ?? null,
        reconciledAt,
      );
    const missing = db
      .query(`SELECT a.source_path sourcePath, a.content_hash contentHash
      FROM active_sources a LEFT JOIN conversations c
      ON c.source_path = a.source_path AND c.content_hash = a.content_hash
      WHERE c.content_hash IS NULL ORDER BY a.source_path LIMIT 1`)
      .get() as { sourcePath: string; contentHash: string } | null;
    if (missing)
      return Effect.runSync(
        Effect.fail(new MissingIndexedSourceError(missing.sourcePath, missing.contentHash)),
      );
    const missingEvents = db
      .query(`SELECT a.source_path sourcePath, a.event_batch_hash eventBatchHash
      FROM active_sources a LEFT JOIN event_batches e ON e.batch_hash = a.event_batch_hash
      WHERE a.event_batch_hash IS NOT NULL AND e.batch_hash IS NULL LIMIT 1`)
      .get() as { sourcePath: string; eventBatchHash: string } | null;
    if (missingEvents)
      return Effect.runSync(
        Effect.fail(
          new MissingIndexedSourceError(missingEvents.sourcePath, missingEvents.eventBatchHash),
        ),
      );
    db.query(`INSERT INTO active_projection_meta(singleton, manifest_sources_hash, reconciled_at)
      VALUES (1, ?, ?) ON CONFLICT(singleton) DO UPDATE SET
      manifest_sources_hash=excluded.manifest_sources_hash, reconciled_at=excluded.reconciled_at`).run(
      manifestSourcesHashValue,
      reconciledAt,
    );
  })();
  return {
    manifestSourcesHash: manifestSourcesHashValue,
    activeSources: mappings.length,
    reconciledAt,
  };
}

export interface SourceAuthorityReceipt extends ProjectionReceipt {
  reindexed: number;
}

function indexedMappingExists(
  db: Database,
  sourcePath: string,
  entry: ManifestSourceEntry,
): boolean {
  const conversation = db
    .query(`SELECT 1 FROM conversations WHERE source_path = ? AND content_hash = ?`)
    .get(sourcePath, entry.contentHash);
  if (!conversation) return false;
  if (!entry.eventBatchHash) return true;
  return Boolean(
    db.query("SELECT 1 FROM event_batches WHERE batch_hash = ?").get(entry.eventBatchHash),
  );
}

export async function readCanonicalConversationObject(
  root: string,
  sourcePath: string,
  contentHash: string,
): Promise<Conversation> {
  const objectPath = join(
    root,
    "corpus",
    "objects",
    contentHash.slice(0, 2),
    `${contentHash}.json`,
  );
  const result = await readBoundedFile(
    objectPath,
    EXPORT_MAX_CORPUS_OBJECT_BYTES,
    `${objectPath} (canonical corpus object)`,
    root,
  );
  if (!result.ok)
    throw new MissingIndexedSourceError(sourcePath, contentHash, { cause: result.error });
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.value.text);
  } catch {
    invalidSourceAuthority(`${objectPath}: canonical object is not valid JSON`);
  }
  const conversation = validateCanonicalConversation(parsed, { contentHash, sourcePath });
  if (!conversation)
    invalidSourceAuthority(`${objectPath}: canonical object hash or shape mismatch`);
  return conversation;
}

export async function reconcileSourceAuthority(
  root: string,
  db: Database,
  sources: Record<string, ManifestSourceEntry>,
): Promise<SourceAuthorityReceipt> {
  validateReceiptMappings(root, sources);
  const canonical = new Map<string, Conversation>();
  for (const [sourcePath, entry] of Object.entries(sources).sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    const conversation = await readCanonicalConversationObject(root, sourcePath, entry.contentHash);
    if (
      entry.conversationProjectionHash &&
      conversation.contentHash !== entry.conversationProjectionHash
    )
      invalidSourceAuthority(`${sourcePath}: canonical object does not match projection mapping`);
    canonical.set(sourcePath, conversation);
  }
  try {
    return { ...reconcileActiveSources(db, sources), reindexed: 0 };
  } catch (error) {
    if (!(error instanceof MissingIndexedSourceError)) return Effect.runPromise(Effect.fail(error));
  }

  let reindexed = 0;
  for (const [sourcePath, entry] of Object.entries(sources).sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    if (indexedMappingExists(db, sourcePath, entry)) continue;
    if (entry.eventBatchHash) {
      const batch = await readEventBatch(root, entry.eventBatchHash);
      if (eventBatchHash(batch) !== entry.eventBatchHash)
        invalidSourceAuthority(`${sourcePath}: event batch hash mismatch`);
      indexEventBatch(
        db,
        batch,
        entry.eventBatchHash,
        entry.conversationProjectionHash ?? entry.contentHash,
      );
    }
    const conversation = canonical.get(sourcePath)!;
    if (indexConversation(db, conversation, entry.mtimeMs ?? 0, entry.size ?? 0)) reindexed++;
    if (!indexedMappingExists(db, sourcePath, entry))
      return Effect.runPromise(
        Effect.fail(new MissingIndexedSourceError(sourcePath, entry.contentHash)),
      );
  }
  return { ...reconcileActiveSources(db, sources, { force: reindexed > 0 }), reindexed };
}

export function assertActiveProjection(root: string, db: Database): ProjectionReceipt {
  return new ActiveProjectionGuard(root).assert(db);
}

export class ActiveProjectionGuard {
  private verifiedCache?: {
    manifestHash: string;
    reconciledAt: string;
    dataVersion: number;
    activeSources: number;
  };

  constructor(private readonly root: string) {}

  private expectedManifestHash(): string {
    const manifest = loadCorpusManifestSync(this.root);
    validateReceiptMappings(this.root, manifest.sources);
    return manifestSourcesHash(manifest.sources);
  }

  assert(db: Database): ProjectionReceipt {
    try {
      db.run("PRAGMA busy_timeout=5000");
      const expectedHash = this.expectedManifestHash();
      const meta = db
        .query(`SELECT manifest_sources_hash manifestSourcesHash, reconciled_at reconciledAt
        FROM active_projection_meta WHERE singleton = 1`)
        .get() as { manifestSourcesHash: string; reconciledAt: string } | null;
      if (!meta || meta.manifestSourcesHash !== expectedHash)
        return Effect.runSync(Effect.fail(new ActiveProjectionDriftError()));
      const dataVersion = Number(
        (db.query("PRAGMA data_version").get() as { data_version: number }).data_version,
      );
      if (
        this.verifiedCache?.manifestHash === expectedHash &&
        this.verifiedCache.reconciledAt === meta.reconciledAt &&
        this.verifiedCache.dataVersion === dataVersion
      )
        return {
          manifestSourcesHash: expectedHash,
          activeSources: this.verifiedCache.activeSources,
          reconciledAt: meta.reconciledAt,
        };
      const rows = db
        .query(
          "SELECT source_path sourcePath, content_hash contentHash, event_batch_hash eventBatchHash, projection_hash projectionHash, receipt_hash receiptHash FROM active_sources ORDER BY source_path",
        )
        .all() as Array<{
        sourcePath: string;
        contentHash: string;
        eventBatchHash: string | null;
        projectionHash: string | null;
        receiptHash: string | null;
      }>;
      const actualHash = manifestSourcesHash(
        Object.fromEntries(
          rows.map((row) => [
            row.sourcePath,
            {
              contentHash: row.contentHash,
              ...(row.eventBatchHash ? { eventBatchHash: row.eventBatchHash } : {}),
              ...(row.projectionHash ? { conversationProjectionHash: row.projectionHash } : {}),
              ...(row.receiptHash ? { receiptHash: row.receiptHash } : {}),
            },
          ]),
        ),
      );
      if (actualHash !== expectedHash)
        return Effect.runSync(Effect.fail(new ActiveProjectionDriftError()));
      const missingIndexedSource = db
        .query(`SELECT 1 FROM active_sources a
        LEFT JOIN conversations c ON c.source_path = a.source_path AND c.content_hash = a.content_hash
        WHERE c.content_hash IS NULL LIMIT 1`)
        .get();
      if (missingIndexedSource)
        return Effect.runSync(
          Effect.fail(
            new ActiveProjectionDriftError(
              "active source projection references missing analysis rows; run `chatlog source reconcile`",
            ),
          ),
        );
      const missingEventBatch = db
        .query(`SELECT 1 FROM active_sources a
        LEFT JOIN event_batches e ON e.batch_hash = a.event_batch_hash
        WHERE a.event_batch_hash IS NOT NULL AND e.batch_hash IS NULL LIMIT 1`)
        .get();
      if (missingEventBatch)
        return Effect.runSync(
          Effect.fail(
            new ActiveProjectionDriftError(
              "active source projection references missing event batches; run `chatlog source reconcile`",
            ),
          ),
        );
      this.verifiedCache = {
        manifestHash: expectedHash,
        reconciledAt: meta.reconciledAt,
        dataVersion,
        activeSources: rows.length,
      };
      return {
        manifestSourcesHash: expectedHash,
        activeSources: rows.length,
        reconciledAt: meta.reconciledAt,
      };
    } catch (error) {
      if (error instanceof ActiveProjectionDriftError) return Effect.runSync(Effect.fail(error));
      const code =
        typeof error === "object" && error && "code" in error
          ? String((error as { code?: unknown }).code)
          : "";
      const message = error instanceof Error ? error.message : "";
      if (
        code === "ENOENT" ||
        message.includes("unsupported corpus manifest") ||
        message.includes("invalid source mapping")
      )
        return Effect.runSync(
          Effect.fail(
            new ActiveProjectionDriftError(
              "active source projection cannot be verified because the corpus manifest is unavailable",
              { cause: error },
            ),
          ),
        );
      if (message.includes("source receipt"))
        return Effect.runSync(
          Effect.fail(
            new ActiveProjectionDriftError(
              "active source projection cannot be verified because a source receipt is unavailable or stale",
              { cause: error },
            ),
          ),
        );
      if (message.includes("no such table: active_projection_meta"))
        return Effect.runSync(
          Effect.fail(
            new ActiveProjectionDriftError(
              "active source projection is not initialized; run `chatlog source reconcile`",
              { cause: error },
            ),
          ),
        );
      if (code === "SQLITE_BUSY" || message.includes("database is locked"))
        return Effect.runSync(
          Effect.fail(
            new ActiveProjectionDriftError(
              "active source projection verification is temporarily unavailable",
              { cause: error },
            ),
          ),
        );
      return Effect.runSync(
        Effect.fail(
          new ActiveProjectionDriftError("active source projection verification failed", {
            cause: error,
          }),
        ),
      );
    }
  }
}
