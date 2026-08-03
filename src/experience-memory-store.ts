import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  compileMemorySnapshot,
  recallMemoryCard,
  validateAcceptedMemoryLedger,
  type AcceptedMemoryLedger,
  type CompiledMemorySnapshot,
  type ExperienceMemoryResult,
  type TierTwoMemoryCard,
} from "./experience-memory";

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
  root: string,
  ledgerPath = join(root, "memory", "accepted-ledger.json"),
): Promise<ExperienceMemoryResult<PublishedMemory>> {
  const loaded = await loadAcceptedMemoryLedger(ledgerPath);
  if (!loaded.ok) return loaded;
  const verified = await verifyAcceptedLedgerProvenance(root, loaded.value);
  if (!verified.ok) return verified;
  const compiled = compileMemorySnapshot(verified.value);
  if (!compiled.ok) return compiled;

  const ledgerContent = jsonBytes(verified.value);
  const pointer: CurrentMemoryPointer = {
    schemaVersion: 1,
    projectIdentity: verified.value.projectIdentity,
    snapshotHash: compiled.value.sha256,
    ledgerHash: sha256(ledgerContent),
  };
  const published: PublishedMemorySnapshot = {
    schemaVersion: 1,
    snapshot: compiled.value,
    ledger: verified.value,
  };

  try {
    const directory = join(resolve(root), "memory");
    const snapshotPath = join(directory, "snapshots", `${compiled.value.sha256}.json`);
    await atomicPrivateWrite(snapshotPath, jsonBytes(published));
    await atomicPrivateWrite(join(directory, "current.json"), jsonBytes(pointer));
    return { ok: true, value: { pointer, published } };
  } catch (error) {
    return storageFailure(error);
  }
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
    return { ok: true, value: { pointer: pointerInput, published } };
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
