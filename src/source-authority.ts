import type { Database } from "bun:sqlite";
import { readFileSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { indexConversation } from "./analysis";
import type { Conversation } from "./types";

export interface ManifestSourceEntry {
  contentHash: string;
  size?: number;
  mtimeMs?: number;
}

export interface CorpusManifest {
  version: 1;
  redactionRecipe?: string;
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

function sha256(value: string): string {
  return new Bun.CryptoHasher("sha256").update(value).digest("hex");
}

function validateManifest(value: unknown, path: string): CorpusManifest {
  const manifest = value as Partial<CorpusManifest>;
  if (manifest?.version !== 1 || !manifest.sources || typeof manifest.sources !== "object")
    throw new Error(`${path}: unsupported corpus manifest`);
  for (const [sourcePath, entry] of Object.entries(manifest.sources)) {
    if (!sourcePath || !entry || !/^[a-f0-9]{64}$/.test(entry.contentHash))
      throw new Error(`${path}: invalid source mapping`);
  }
  return manifest as CorpusManifest;
}

export function manifestSourcesHash(
  sources: Record<string, { contentHash: string }>,
): string {
  const canonical = Object.entries(sources)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([sourcePath, entry]) => [sourcePath, entry.contentHash]);
  return sha256(JSON.stringify(canonical));
}

export async function loadCorpusManifest(root: string): Promise<CorpusManifest> {
  const path = join(root, "corpus", "manifest.json");
  return validateManifest(JSON.parse(await readFile(path, "utf8")), path);
}

export function loadCorpusManifestSync(root: string): CorpusManifest {
  const path = join(root, "corpus", "manifest.json");
  return validateManifest(JSON.parse(readFileSync(path, "utf8")), path);
}

export function reconcileActiveSources(
  db: Database,
  sources: Record<string, { contentHash: string }>,
  options: { force?: boolean } = {},
): ProjectionReceipt {
  const manifestSourcesHashValue = manifestSourcesHash(sources);
  const mappings = Object.entries(sources)
    .sort(([left], [right]) => left.localeCompare(right));
  const currentMeta = db.query(`SELECT manifest_sources_hash manifestSourcesHash,
    reconciled_at reconciledAt
    FROM active_projection_meta WHERE singleton = 1`).get() as
    { manifestSourcesHash: string; reconciledAt: string } | null;
  if (!options.force && currentMeta?.manifestSourcesHash === manifestSourcesHashValue) {
    const currentMappings = db.query(
      "SELECT source_path sourcePath, content_hash contentHash FROM active_sources ORDER BY source_path",
    ).all() as Array<{ sourcePath: string; contentHash: string }>;
    const currentHash = manifestSourcesHash(Object.fromEntries(
      currentMappings.map((row) => [row.sourcePath, { contentHash: row.contentHash }]),
    ));
    const missing = db.query(`SELECT 1
      FROM active_sources a
      LEFT JOIN conversations c
        ON c.source_path = a.source_path AND c.content_hash = a.content_hash
      WHERE c.content_hash IS NULL LIMIT 1`).get();
    if (currentHash === manifestSourcesHashValue && !missing) {
      return {
        manifestSourcesHash: manifestSourcesHashValue,
        activeSources: currentMappings.length,
        reconciledAt: currentMeta.reconciledAt,
      };
    }
  }
  const previousTime = Date.parse(currentMeta?.reconciledAt ?? "");
  const reconciledAt = new Date(Math.max(
    Date.now(),
    Number.isFinite(previousTime) ? previousTime + 1 : 0,
  )).toISOString();
  const insert = db.prepare(
    "INSERT INTO active_sources(source_path, content_hash, updated_at) VALUES (?, ?, ?)",
  );
  db.transaction(() => {
    db.run("DELETE FROM active_sources");
    for (const [sourcePath, entry] of mappings)
      insert.run(sourcePath, entry.contentHash, reconciledAt);
    const missing = db.query(`SELECT a.source_path sourcePath, a.content_hash contentHash
      FROM active_sources a
      LEFT JOIN conversations c
        ON c.source_path = a.source_path AND c.content_hash = a.content_hash
      WHERE c.content_hash IS NULL
      ORDER BY a.source_path LIMIT 1`).get() as
      { sourcePath: string; contentHash: string } | null;
    if (missing)
      throw new MissingIndexedSourceError(missing.sourcePath, missing.contentHash);
    db.query(`INSERT INTO active_projection_meta(
      singleton, manifest_sources_hash, reconciled_at
    ) VALUES (1, ?, ?)
    ON CONFLICT(singleton) DO UPDATE SET
      manifest_sources_hash=excluded.manifest_sources_hash,
      reconciled_at=excluded.reconciled_at`).run(manifestSourcesHashValue, reconciledAt);
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
  contentHash: string,
): boolean {
  return Boolean(db.query(`SELECT 1 FROM conversations
    WHERE source_path = ? AND content_hash = ?`).get(sourcePath, contentHash));
}

function canonicalConversationHash(conversation: Conversation): string {
  const { contentHash: _contentHash, ...canonical } = conversation;
  return sha256(JSON.stringify(canonical));
}

export async function reconcileSourceAuthority(
  root: string,
  db: Database,
  sources: Record<string, ManifestSourceEntry>,
): Promise<SourceAuthorityReceipt> {
  try {
    return { ...reconcileActiveSources(db, sources), reindexed: 0 };
  } catch (error) {
    if (!(error instanceof MissingIndexedSourceError)) throw error;
  }

  let reindexed = 0;
  for (const [sourcePath, entry] of Object.entries(sources)
    .sort(([left], [right]) => left.localeCompare(right))) {
    if (indexedMappingExists(db, sourcePath, entry.contentHash)) continue;
    const objectPath = join(
      root,
      "corpus",
      "objects",
      entry.contentHash.slice(0, 2),
      `${entry.contentHash}.json`,
    );
    let conversation: Conversation;
    try {
      conversation = JSON.parse(await readFile(objectPath, "utf8")) as Conversation;
    } catch (cause) {
      throw new MissingIndexedSourceError(sourcePath, entry.contentHash, { cause });
    }
    if (
      conversation.contentHash !== entry.contentHash
      || canonicalConversationHash(conversation) !== entry.contentHash
      || conversation.sourcePath !== sourcePath
      || !Array.isArray(conversation.turns)
    ) {
      throw new Error(`${objectPath}: canonical object does not match manifest source mapping`);
    }
    if (indexConversation(db, conversation, entry.mtimeMs ?? 0, entry.size ?? 0))
      reindexed++;
    if (!indexedMappingExists(db, sourcePath, entry.contentHash))
      throw new MissingIndexedSourceError(sourcePath, entry.contentHash);
  }
  return {
    ...reconcileActiveSources(db, sources, { force: reindexed > 0 }),
    reindexed,
  };
}

export function assertActiveProjection(root: string, db: Database): ProjectionReceipt {
  return new ActiveProjectionGuard(root).assert(db);
}

export class ActiveProjectionGuard {
  private manifestCache?: { signature: string; hash: string };
  private verifiedCache?: {
    manifestHash: string;
    reconciledAt: string;
    dataVersion: number;
    activeSources: number;
  };

  constructor(private readonly root: string) {}

  private expectedManifestHash(): string {
    const path = join(this.root, "corpus", "manifest.json");
    const info = statSync(path, { bigint: true });
    const signature = `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}`;
    if (this.manifestCache?.signature === signature) return this.manifestCache.hash;
    const hash = manifestSourcesHash(loadCorpusManifestSync(this.root).sources);
    this.manifestCache = { signature, hash };
    return hash;
  }

  assert(db: Database): ProjectionReceipt {
    try {
      const expectedHash = this.expectedManifestHash();
      const meta = db.query(`SELECT manifest_sources_hash manifestSourcesHash,
        reconciled_at reconciledAt
        FROM active_projection_meta WHERE singleton = 1`).get() as
        { manifestSourcesHash: string; reconciledAt: string } | null;
      if (!meta || meta.manifestSourcesHash !== expectedHash)
        throw new ActiveProjectionDriftError();
      const dataVersion = Number(
        (db.query("PRAGMA data_version").get() as { data_version: number }).data_version,
      );
      if (
        this.verifiedCache?.manifestHash === expectedHash
        && this.verifiedCache.reconciledAt === meta.reconciledAt
        && this.verifiedCache.dataVersion === dataVersion
      ) {
        return {
          manifestSourcesHash: expectedHash,
          activeSources: this.verifiedCache.activeSources,
          reconciledAt: meta.reconciledAt,
        };
      }
      const rows = db.query(
        "SELECT source_path sourcePath, content_hash contentHash FROM active_sources ORDER BY source_path",
      ).all() as Array<{ sourcePath: string; contentHash: string }>;
      const actualHash = manifestSourcesHash(Object.fromEntries(
        rows.map((row) => [row.sourcePath, { contentHash: row.contentHash }]),
      ));
      if (actualHash !== expectedHash)
        throw new ActiveProjectionDriftError();
      const missingIndexedSource = db.query(`SELECT 1
        FROM active_sources a
        LEFT JOIN conversations c
          ON c.source_path = a.source_path AND c.content_hash = a.content_hash
        WHERE c.content_hash IS NULL LIMIT 1`).get();
      if (missingIndexedSource)
        throw new ActiveProjectionDriftError(
          "active source projection references missing analysis rows; run `chatlog source reconcile`",
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
      if (error instanceof ActiveProjectionDriftError) throw error;
      const code = typeof error === "object" && error && "code" in error
        ? String((error as { code?: unknown }).code)
        : "";
      const message = error instanceof Error ? error.message : "";
      if (code === "ENOENT" || message.includes("unsupported corpus manifest") || message.includes("invalid source mapping"))
        throw new ActiveProjectionDriftError(
          "active source projection cannot be verified because the corpus manifest is unavailable",
          { cause: error },
        );
      if (message.includes("no such table: active_projection_meta"))
        throw new ActiveProjectionDriftError(
          "active source projection is not initialized; run `chatlog source reconcile`",
          { cause: error },
        );
      if (code === "SQLITE_BUSY" || message.includes("database is locked"))
        throw new ActiveProjectionDriftError(
          "active source projection verification is temporarily unavailable",
          { cause: error },
        );
      throw new ActiveProjectionDriftError(
        "active source projection verification failed",
        { cause: error },
      );
    }
  }
}
