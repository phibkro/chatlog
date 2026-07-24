import { readFile } from "node:fs/promises";
import { isAbsolute, join, normalize, sep } from "node:path";
import { loadCorpusManifest } from "./source-authority";

export interface DerivedProjectionReceipt {
  contentHash: string;
  structureProjectionHash: string;
  conversations: number;
  conversationHashes: string[];
}

export interface CurrentDerivedArtifact<T = any> {
  artifact: T;
  contentHash: string;
  inputProjectionHash: string;
}

export class DerivedProjectionDriftError extends Error {
  constructor(
    message = "derived projection is unavailable or stale; run `chatlog derive` and `chatlog refine`",
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "DerivedProjectionDriftError";
  }
}

function sha256(value: string): string {
  return new Bun.CryptoHasher("sha256").update(value).digest("hex");
}

export function serializeCurrentProjection(
  sources: Record<string, { contentHash: string }>,
): string {
  const hashes = currentConversationHashes(sources);
  return hashes.map((conversationHash) => JSON.stringify({ conversationHash })).join("\n") + "\n";
}

function currentConversationHashes(
  sources: Record<string, { contentHash: string }>,
): string[] {
  return [...new Set(Object.values(sources).map((entry) => entry.contentHash))].sort();
}

function derivedPath(root: string, relativePath: unknown): string {
  if (typeof relativePath !== "string" || !relativePath || isAbsolute(relativePath))
    throw new DerivedProjectionDriftError("derived manifest contains an invalid artifact path");
  const normalized = normalize(relativePath);
  if (normalized === ".." || normalized.startsWith(`..${sep}`))
    throw new DerivedProjectionDriftError("derived manifest contains an invalid artifact path");
  return join(root, "derived", normalized);
}

export async function assertDerivedProjection(root: string): Promise<DerivedProjectionReceipt> {
  try {
    const corpus = await loadCorpusManifest(root);
    const expectedText = serializeCurrentProjection(corpus.sources);
    const expectedHash = sha256(expectedText);
    const manifest = JSON.parse(
      await readFile(join(root, "derived", "manifest.json"), "utf8"),
    );
    const projection = manifest.currentProjection;
    const actualText = await readFile(derivedPath(root, projection?.path), "utf8");
    if (
      manifest?.version !== 1
      || typeof manifest.recipeHash !== "string"
      || projection.path !== "current-hashes.jsonl"
      || projection.contentHash !== expectedHash
      || sha256(actualText) !== expectedHash
      || actualText !== expectedText
    ) {
      throw new DerivedProjectionDriftError();
    }
    const conversationHashes = currentConversationHashes(corpus.sources);
    const structures = conversationHashes.map((conversationHash) => {
      const structure = manifest.conversations?.[conversationHash]?.derivedArtifacts?.structure;
      if (
        structure?.path !== `objects/${conversationHash.slice(0, 2)}/${conversationHash}.json`
        || !/^[a-f0-9]{64}$/.test(structure?.contentHash ?? "")
      ) {
        throw new DerivedProjectionDriftError(
          `derived manifest has no valid structure artifact for ${conversationHash}`,
        );
      }
      return [conversationHash, structure.contentHash];
    });
    return {
      contentHash: expectedHash,
      structureProjectionHash: sha256(JSON.stringify({
        recipeHash: manifest.recipeHash,
        structures,
      })),
      conversations: conversationHashes.length,
      conversationHashes,
    };
  } catch (error) {
    if (error instanceof DerivedProjectionDriftError) throw error;
    throw new DerivedProjectionDriftError(undefined, { cause: error });
  }
}

export async function loadCurrentDerivedArtifact<T = any>(
  root: string,
  manifestName: string,
  options: { optional?: boolean } = {},
): Promise<CurrentDerivedArtifact<T> | null> {
  let manifest: any;
  try {
    manifest = JSON.parse(
      await readFile(join(root, "derived", manifestName), "utf8"),
    );
  } catch (error: any) {
    if (options.optional && error?.code === "ENOENT") return null;
    throw new DerivedProjectionDriftError(`${manifestName}: current artifact is unavailable`, {
      cause: error,
    });
  }
  try {
    if (manifest?.version !== 1 || !manifest.current)
      throw new DerivedProjectionDriftError(`${manifestName}: no current derived artifact`);
    const current = manifest.current;
    const artifactText = await readFile(derivedPath(root, current.artifactPath), "utf8");
    if (!/^[a-f0-9]{64}$/.test(current.contentHash) || sha256(artifactText) !== current.contentHash)
      throw new DerivedProjectionDriftError(`${manifestName}: current artifact failed integrity validation`);
    return {
      artifact: JSON.parse(artifactText) as T,
      contentHash: current.contentHash,
      inputProjectionHash: String(current.inputProjectionHash ?? ""),
    };
  } catch (error: any) {
    if (error instanceof DerivedProjectionDriftError) throw error;
    throw new DerivedProjectionDriftError(`${manifestName}: current artifact is unavailable`, {
      cause: error,
    });
  }
}

export async function loadProjectionBoundArtifact<T = any>(
  root: string,
  manifestName: string,
  options: {
    optional?: boolean;
    projection?: DerivedProjectionReceipt;
    inputProjectionHash?: string;
  } = {},
): Promise<CurrentDerivedArtifact<T> | null> {
  const projection = options.projection ?? await assertDerivedProjection(root);
  const inputProjectionHash = options.inputProjectionHash ?? projection.contentHash;
  const current = await loadCurrentDerivedArtifact<T>(root, manifestName, options);
  if (current && (
    current.inputProjectionHash !== inputProjectionHash
    || current.artifact?.inputProjectionHash !== inputProjectionHash
  )) {
    throw new DerivedProjectionDriftError(
      `${manifestName}: current artifact does not match the active derived projection`,
    );
  }
  return current;
}
