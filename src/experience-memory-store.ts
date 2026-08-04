import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  compileMemorySnapshot,
  recallMemoryCard,
  validateAcceptedMemoryLedger,
  type AcceptedMemoryLedger,
  type AcceptedMemoryEntry,
  type CompiledMemorySnapshot,
  type ExperienceMemoryResult,
  type TierTwoMemoryCard,
} from "./experience-memory";
import { compileInsightProjection, type CompiledInsightSnapshot } from "./insight-compiler";
import {
  loadInsightLedger,
  readInsightCurrentPointer,
  readInsightPublicationContext,
} from "./insight-ledger";
import {
  projectInsightState,
  validateInsightCurrentPointer,
  type InsightCurrentPointer,
  type InsightLedgerSnapshot,
  type InsightProjection,
  type InsightRevision,
} from "./insights";

const HASH_PATTERN = /^[a-f0-9]{64}$/u;

export interface PublishedMemorySnapshot {
  schemaVersion: 1;
  snapshot: CompiledMemorySnapshot;
  ledger: AcceptedMemoryLedger;
}

export interface CurrentMemoryPointer {
  schemaVersion: 1;
  projectIdentity: string;
  snapshotHash: string;
  ledgerHash: string;
}

export interface PublishedMemory {
  pointer: CurrentMemoryPointer;
  published: PublishedMemorySnapshot;
}

interface ProvenanceSources {
  proposals: Record<string, unknown>;
  reviews: Record<string, unknown>;
  manifest: Record<string, unknown>;
}

function jsonBytes(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

async function atomicPrivateWrite(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
  await chmod(temporary, 0o600);
  await rename(temporary, path);
  await chmod(path, 0o600);
}

function storageFailure<T>(error: unknown): ExperienceMemoryResult<T> {
  const message = error instanceof Error ? error.message : String(error);
  return {
    ok: false,
    error: { code: "storage-error", message: `Could not access published memory: ${message}` },
  };
}

export async function loadAcceptedMemoryLedger(
  ledgerPath: string,
): Promise<ExperienceMemoryResult<AcceptedMemoryLedger>> {
  try {
    const input: unknown = JSON.parse(await readFile(resolve(ledgerPath), "utf8"));
    return validateAcceptedMemoryLedger(input);
  } catch (error) {
    return storageFailure(error);
  }
}

function objectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function loadProvenanceSources(
  root: string,
  packetHash: string,
): Promise<ExperienceMemoryResult<ProvenanceSources>> {
  try {
    const publicDirectory = join(
      resolve(root),
      "derived",
      "adjudication",
      "refinery",
      packetHash,
      "public",
    );
    const privateManifestPath = join(
      resolve(root),
      "derived",
      "adjudication",
      "refinery-private",
      packetHash,
      "manifest.json",
    );
    const [proposalBytes, reviewBytes, manifestBytes] = await Promise.all([
      readFile(join(publicDirectory, "proposals.json"), "utf8"),
      readFile(join(publicDirectory, "operator-reviews.json"), "utf8"),
      readFile(privateManifestPath, "utf8"),
    ]);
    const proposals: unknown = JSON.parse(proposalBytes);
    const reviews: unknown = JSON.parse(reviewBytes);
    const manifest: unknown = JSON.parse(manifestBytes);
    if (!objectRecord(proposals) || !objectRecord(reviews) || !objectRecord(manifest)) {
      return {
        ok: false,
        error: { code: "invalid-ledger", message: "Memory provenance sources are malformed" },
      };
    }
    if (
      proposals.packetHash !== packetHash ||
      reviews.packetHash !== packetHash ||
      manifest.packetHash !== packetHash
    ) {
      return {
        ok: false,
        error: {
          code: "invalid-ledger",
          message: "Memory provenance sources do not match the declared packet hash",
        },
      };
    }
    return {
      ok: true,
      value: {
        proposals: { ...proposals, __bytesSha256: sha256(proposalBytes) },
        reviews: { ...reviews, __bytesSha256: sha256(reviewBytes) },
        manifest,
      },
    };
  } catch (error) {
    return storageFailure(error);
  }
}

export async function verifyAcceptedLedgerProvenance(
  root: string,
  ledger: AcceptedMemoryLedger,
): Promise<ExperienceMemoryResult<AcceptedMemoryLedger>> {
  const sourceCache = new Map<string, ProvenanceSources>();
  const issues: Array<string> = [];
  for (const entry of ledger.entries) {
    const { provenance } = entry;
    let sources = sourceCache.get(provenance.packetHash);
    if (sources === undefined) {
      const loaded = await loadProvenanceSources(root, provenance.packetHash);
      if (!loaded.ok) return loaded;
      sources = loaded.value;
      sourceCache.set(provenance.packetHash, sources);
    }
    if (sources.proposals.__bytesSha256 !== provenance.proposalSetHash) {
      issues.push(`${entry.id}: proposal-set bytes do not match declared provenance`);
    }
    if (sources.reviews.__bytesSha256 !== provenance.operatorReviewHash) {
      issues.push(`${entry.id}: operator-review bytes do not match declared provenance`);
    }
    if (sources.reviews.proposalSetHash !== provenance.proposalSetHash) {
      issues.push(`${entry.id}: operator review targets a different proposal set`);
    }
    const proposals = sources.proposals.proposals;
    if (!objectRecord(proposals) || !objectRecord(proposals[provenance.candidateAlias])) {
      issues.push(`${entry.id}: candidate alias is absent from the proposal set`);
    }
    const reviews = sources.reviews.reviews;
    const review = objectRecord(reviews) ? reviews[provenance.candidateAlias] : undefined;
    if (
      !objectRecord(review) ||
      review.status !== "reviewed" ||
      review.judgment !== "correct" ||
      review.valence !== entry.valence
    ) {
      issues.push(`${entry.id}: candidate lacks a matching finalized correct operator review`);
    }
    const candidates = sources.manifest.candidates;
    const candidate = Array.isArray(candidates)
      ? candidates.find(
          (value) => objectRecord(value) && value.candidateAlias === provenance.candidateAlias,
        )
      : undefined;
    if (!objectRecord(candidate) || candidate.candidateId !== provenance.candidateId) {
      issues.push(`${entry.id}: candidate alias does not map to the declared candidate ID`);
    }
  }
  if (issues.length > 0) {
    return {
      ok: false,
      error: {
        code: "invalid-ledger",
        message: "Accepted memory ledger failed source-bound provenance verification",
        issues,
      },
    };
  }
  return { ok: true, value: ledger };
}

export async function publishAcceptedMemory(
  _root: string,
  _ledgerPath = join(_root, "memory", "accepted-ledger.json"),
): Promise<ExperienceMemoryResult<PublishedMemory>> {
  return {
    ok: false,
    error: {
      code: "storage-error",
      message:
        "v1 accepted-memory publishing is disabled; migrate and apply an insight ledger explicitly",
    },
  };
}

function validPointer(value: unknown): value is CurrentMemoryPointer {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const pointer = value as Record<string, unknown>;
  return (
    Object.keys(pointer).toSorted().join(",") ===
      ["schemaVersion", "projectIdentity", "snapshotHash", "ledgerHash"].toSorted().join(",") &&
    pointer.schemaVersion === 1 &&
    typeof pointer.projectIdentity === "string" &&
    pointer.projectIdentity.length > 0 &&
    typeof pointer.snapshotHash === "string" &&
    HASH_PATTERN.test(pointer.snapshotHash) &&
    typeof pointer.ledgerHash === "string" &&
    HASH_PATTERN.test(pointer.ledgerHash)
  );
}
export async function readPublishedMemory(
  root: string,
  requestedSnapshotHash?: string,
): Promise<ExperienceMemoryResult<PublishedMemory>> {
  try {
    try {
      await readFile(join(resolve(root), "memory", "insight-current.json"), "utf8");
      const insight = await readPublishedInsightMemory(root);
      if (!insight.ok) return { ok: false, error: insight.error };
      if (
        requestedSnapshotHash !== undefined &&
        requestedSnapshotHash !== insight.value.pointer.outputHash
      )
        return {
          ok: false,
          error: {
            code: "invalid-memory-id",
            message: "requested snapshot is not the current insight publication",
          },
        };
      return { ok: true, value: legacyPublishedFromInsight(insight.value) };
    } catch (error: unknown) {
      const code =
        typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
      if (code !== "ENOENT") return storageFailure(error);
    }
    const directory = join(resolve(root), "memory");
    const pointerInput: unknown = JSON.parse(
      await readFile(join(directory, "current.json"), "utf8"),
    );
    if (!validPointer(pointerInput)) {
      return {
        ok: false,
        error: { code: "invalid-ledger", message: "Current memory pointer is invalid" },
      };
    }
    const snapshotHash = requestedSnapshotHash ?? pointerInput.snapshotHash;
    if (!HASH_PATTERN.test(snapshotHash)) {
      return {
        ok: false,
        error: { code: "invalid-memory-id", message: "Snapshot hash must be exact SHA-256" },
      };
    }
    const snapshotInput: unknown = JSON.parse(
      await readFile(join(directory, "snapshots", `${snapshotHash}.json`), "utf8"),
    );
    if (
      typeof snapshotInput !== "object" ||
      snapshotInput === null ||
      Array.isArray(snapshotInput)
    ) {
      return {
        ok: false,
        error: { code: "invalid-ledger", message: "Published memory snapshot is invalid" },
      };
    }
    const row = snapshotInput as Record<string, unknown>;
    if (
      row.schemaVersion !== 1 ||
      !("snapshot" in row) ||
      !("ledger" in row) ||
      Object.keys(row).toSorted().join(",") !==
        ["schemaVersion", "snapshot", "ledger"].toSorted().join(",")
    ) {
      return {
        ok: false,
        error: { code: "invalid-ledger", message: "Published memory snapshot is invalid" },
      };
    }
    const ledger = validateAcceptedMemoryLedger(row.ledger);
    if (!ledger.ok) return ledger;
    const compiled = compileMemorySnapshot(ledger.value);
    if (
      !compiled.ok ||
      compiled.value.sha256 !== snapshotHash ||
      JSON.stringify(compiled.value) !== JSON.stringify(row.snapshot)
    ) {
      return {
        ok: false,
        error: {
          code: "invalid-ledger",
          message: "Published memory snapshot does not match its accepted ledger",
        },
      };
    }
    const published: PublishedMemorySnapshot = {
      schemaVersion: 1,
      snapshot: compiled.value,
      ledger: ledger.value,
    };
    if (pointerInput.ledgerHash !== sha256(jsonBytes(ledger.value))) {
      return {
        ok: false,
        error: { code: "invalid-ledger", message: "Current memory pointer ledger hash is stale" },
      };
    }
    return { ok: true, value: { pointer: pointerInput, published } };
  } catch (error) {
    return storageFailure(error);
  }
}

export interface PublishedInsightMemory {
  pointer: InsightCurrentPointer;
  ledger: InsightLedgerSnapshot;
  projection: InsightProjection;
  compiled: CompiledInsightSnapshot;
}

function insightToLegacyEntry(revision: InsightRevision): AcceptedMemoryEntry {
  const sourceHashes = revision.origin.sourceHashes.filter((value) => HASH_PATTERN.test(value));
  const migratedV1 = revision.derivation?.activity === "v1-accepted-memory-migration";
  const hashOffset = migratedV1 ? 1 : 0;
  const hashes = [
    sourceHashes[hashOffset] ?? sha256(revision.revisionId),
    sourceHashes[hashOffset + 1] ?? sha256(`${revision.revisionId}:proposal`),
    sourceHashes[hashOffset + 2] ?? sha256(`${revision.revisionId}:review`),
  ];
  const scopeAxis =
    revision.scope.repository !== null
      ? { kind: "repository" as const, value: revision.scope.repository }
      : revision.scope.path !== null
        ? { kind: "path" as const, value: revision.scope.path }
        : revision.scope.tool !== null
          ? { kind: "tool" as const, value: revision.scope.tool }
          : revision.scope.model !== null
            ? { kind: "model" as const, value: revision.scope.model }
            : revision.scope.harness !== null
              ? { kind: "harness" as const, value: revision.scope.harness }
              : { kind: "global" as const, value: null };
  return {
    id: revision.insightId,
    status: "accepted",
    judgment: "correct",
    valence: revision.valence,
    provenance: {
      packetHash: hashes[0]!,
      proposalSetHash: hashes[1]!,
      operatorReviewHash: hashes[2]!,
      candidateAlias: "C000",
      candidateId: sha256(revision.insightId).slice(0, 20),
    },
    trigger: revision.proposition.slice(0, 500),
    scope: scopeAxis,
    polarity: revision.kind === "preference" ? "prefer" : "check",
    action: revision.procedure ?? revision.proposition.slice(0, 500),
    situation: revision.proposition,
    outcome: revision.proposition,
    lesson: revision.proposition,
    confidence: revision.confidence.find((assessment) => assessment.role === "human")?.value ?? 0.5,
    freshness: "current",
    canonicalDocs: revision.authoritativeDocs
      .map((document) => document.uri)
      .filter((uri) => !uri.startsWith("chatlog://"))
      .concat(revision.authoritativeDocs.length === 0 ? [`insight://${revision.revisionId}`] : []),
    evidencePointers: [...revision.supportEvidence] as Array<`chatlog://${string}`>,
  };
}

function legacyPublishedFromInsight(published: PublishedInsightMemory): PublishedMemory {
  const entries = Object.values(published.projection.current)
    .filter((revision) => revision.status === "active")
    .toSorted((left, right) => left.insightId.localeCompare(right.insightId))
    .map(insightToLegacyEntry);
  const ledger: AcceptedMemoryLedger = {
    schemaVersion: 1,
    ledgerId: published.ledger.ledgerId,
    projectIdentity: published.pointer.projectIdentity,
    entries,
  };
  const snapshot: CompiledMemorySnapshot = {
    schemaVersion: 1,
    sha256: published.compiled.outputHash,
    content: published.compiled.content,
    bytes: published.compiled.bytes,
    estimatedTokens: published.compiled.estimatedTokens,
    withinTarget: published.compiled.withinTarget,
    entryIds: published.compiled.entryIds,
  };
  return {
    pointer: {
      schemaVersion: 1,
      projectIdentity: published.pointer.projectIdentity,
      snapshotHash: published.pointer.outputHash,
      ledgerHash: published.pointer.ledgerHash,
    },
    published: { schemaVersion: 1, snapshot, ledger },
  };
}

export async function publishInsightMemory(
  root: string,
  published: PublishedInsightMemory,
): Promise<ExperienceMemoryResult<PublishedInsightMemory>> {
  const pointer = validateInsightCurrentPointer(published.pointer);
  if (!pointer.ok)
    return {
      ok: false,
      error: {
        code: "invalid-ledger",
        message: "insight pointer failed validation",
        issues: pointer.errors.map((error) => `${error.path}: ${error.message}`),
      },
    };
  if (published.ledger.ledgerHash !== published.pointer.ledgerHash)
    return {
      ok: false,
      error: {
        code: "invalid-ledger",
        message: "insight pointer ledger hash does not match ledger",
      },
    };
  if (
    published.compiled.ledgerHash !== published.pointer.ledgerHash ||
    published.compiled.compiledStateHash !== published.pointer.compiledStateHash ||
    published.compiled.outputHash !== published.pointer.outputHash
  )
    return {
      ok: false,
      error: {
        code: "invalid-ledger",
        message: "compiled insight artifact does not match current pointer",
      },
    };
  try {
    await atomicPrivateWrite(
      join(resolve(root), "memory", "insight-compiled", `${published.compiled.outputHash}.json`),
      jsonBytes(published.compiled),
    );
    await atomicPrivateWrite(
      join(resolve(root), "memory", "insight-current.json"),
      jsonBytes(published.pointer),
    );
    return { ok: true, value: published };
  } catch (error) {
    return storageFailure(error);
  }
}

export async function readPublishedInsightMemory(
  root: string,
): Promise<ExperienceMemoryResult<PublishedInsightMemory>> {
  try {
    const pointer = await readInsightCurrentPointer(root);
    if (!pointer.ok)
      return { ok: false, error: { code: "invalid-ledger", message: pointer.error.message } };
    const ledger = await loadInsightLedger(root, pointer.value.ledgerHash);
    if (!ledger.ok)
      return {
        ok: false,
        error: {
          code: "invalid-ledger",
          message: ledger.error.message,
          issues: ledger.error.issues,
        },
      };
    if (ledger.value.projectIdentity !== pointer.value.projectIdentity)
      return {
        ok: false,
        error: {
          code: "invalid-ledger",
          message: "insight ledger project identity does not match current pointer",
        },
      };
    const projection = projectInsightState(ledger.value);
    const contextResult = await readInsightPublicationContext(root);
    if (contextResult && !contextResult.ok)
      return { ok: false, error: { code: "invalid-ledger", message: contextResult.error.message } };
    const context = contextResult?.value;
    if (
      context &&
      (pointer.value.inputProjectionHash !== context.inputProjectionHash ||
        pointer.value.sourceAuthorityHash !== context.sourceAuthorityHash)
    )
      return {
        ok: false,
        error: {
          code: "invalid-ledger",
          message: "insight current pointer is stale for the active source projection",
        },
      };
    const compiledResult = compileInsightProjection(projection, {
      projectIdentity: pointer.value.projectIdentity,
      now: new Date(pointer.value.compiledAt),
      supportedRiskClasses: new Set(["low", "medium", "high"]),
      ...(context ? { activeEvidence: context.activeEvidence } : {}),
    });
    if (!compiledResult.ok)
      return { ok: false, error: { code: "invalid-ledger", message: compiledResult.error } };
    const compiled = compiledResult.value;
    if (
      compiled.ledgerHash !== pointer.value.ledgerHash ||
      compiled.compiledStateHash !== pointer.value.compiledStateHash ||
      compiled.outputHash !== pointer.value.outputHash
    )
      return {
        ok: false,
        error: {
          code: "invalid-ledger",
          message: "insight current pointer is stale for its ledger or compiled state",
        },
      };
    const stored: unknown = JSON.parse(
      await readFile(
        join(resolve(root), "memory", "insight-compiled", `${pointer.value.outputHash}.json`),
        "utf8",
      ),
    );
    if (JSON.stringify(stored) !== JSON.stringify(compiled))
      return {
        ok: false,
        error: {
          code: "invalid-ledger",
          message: "compiled insight artifact bytes do not match current pointer",
        },
      };
    return {
      ok: true,
      value: { pointer: pointer.value, ledger: ledger.value, projection, compiled },
    };
  } catch (error) {
    return storageFailure(error);
  }
}
export async function recallPublishedMemory(
  root: string,
  snapshotHash: string,
  memoryId: string,
): Promise<ExperienceMemoryResult<TierTwoMemoryCard>> {
  const published = await readPublishedMemory(root, snapshotHash);
  if (!published.ok) return published;
  return recallMemoryCard(published.value.published.ledger, memoryId);
}
