import { chmod, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  ACTIVE_SOURCE_AUTHORITY_VERSION,
  SEMANTIC_LOSS_CODES,
  sha256,
  stableStringify,
  type EventBatch,
} from "./events";
import { eventBatchHash } from "./event-store";
import {
  semanticLossCounts,
  sourceItemAccounting,
  unknownShapeNominations,
  validateSourceItemAccounting,
  type SourceItemAccounting,
  type UnknownShapeNomination,
} from "./adapter-conformance";

export const SOURCE_RECEIPT_SCHEMA = "chatlog/source-receipt-v1" as const;
export const UNKNOWN_NOMINATION_SCHEMA = "chatlog/unknown-shape-nominations-v1" as const;
export const SOURCE_RECEIPT_DIRECTORY = "receipts/sources" as const;
export const UNKNOWN_NOMINATION_DIRECTORY = "receipts/nominations" as const;
export const UNKNOWN_NOMINATION_FILE = "unknown-shapes.json" as const;
export const UNKNOWN_NOMINATION_STORAGE_LIMIT = 256 as const;

export interface SourceReceipt {
  schema: typeof SOURCE_RECEIPT_SCHEMA;
  receiptHash: string;
  source: {
    path: string;
    hash: string;
    provider: string;
    harness: string;
    sourceKind: string;
    nativeSessionId?: string;
  };
  eventBatchHash: string;
  adapterRecipe: string;
  capturePolicyVersion: string;
  itemCounts: SourceItemAccounting;
  lossCounts: Partial<Record<(typeof SEMANTIC_LOSS_CODES)[number], number>>;
  partialTail: boolean;
  activeSourceAuthorityVersion: string;
  eventProjectionHash: string;
  conversationProjectionHash: string;
}

export interface SourceReceiptInput {
  batch: EventBatch;
  batchHash?: string;
  conversationProjectionHash: string;
  activeSourceAuthorityVersion?: string;
}

interface SourceReceiptBody extends Omit<SourceReceipt, "receiptHash"> {}

interface NominationContribution {
  sourceKey: string;
  sourceHash: string;
  occurrences: number;
  distinctSessions: number;
  firstSeen?: string;
  lastSeen?: string;
}

export interface StoredUnknownShapeNomination extends UnknownShapeNomination {
  sourceHashes: readonly string[];
  sourceContributions: readonly NominationContribution[];
}

interface UnknownShapeNominationStore {
  schema: typeof UNKNOWN_NOMINATION_SCHEMA;
  nominations: unknown[];
}

function invalidReceipt(message: string): never {
  throw new Error(message);
}

function boundedText(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string" || !value || value.length > maximum)
    invalidReceipt(`${label} is not bounded text`);
  return value;
}

function boundedHash(value: unknown, label: string): string {
  const text = boundedText(value, label, 128);
  if (!/^[a-f0-9]{64}$/.test(text)) invalidReceipt(`${label} must be a SHA-256 hash`);
  return text;
}

function boundedCount(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0)
    invalidReceipt(`${label} must be a non-negative integer`);
  return Number(value);
}

function validateItemCounts(value: unknown): SourceItemAccounting {
  if (!value || typeof value !== "object" || Array.isArray(value))
    invalidReceipt("source receipt itemCounts must be an object");
  const record = value as Record<string, unknown>;
  for (const key of [
    "sourceItems",
    "eventBackedItems",
    "lossOnlyItems",
    "unaccountedItems",
    "opaqueItems",
    "redactedItems",
    "policyOmissions",
  ])
    boundedCount(record[key], `itemCounts.${key}`);
  const dispositions = record.dispositions;
  if (!dispositions || typeof dispositions !== "object" || Array.isArray(dispositions))
    invalidReceipt("source receipt dispositions must be an object");
  const dispositionRecord = dispositions as Record<string, unknown>;
  for (const key of ["normalized", "opaque", "redacted", "omitted"])
    boundedCount(dispositionRecord[key], `itemCounts.dispositions.${key}`);
  const accounting = {
    sourceItems: Number(record.sourceItems),
    eventBackedItems: Number(record.eventBackedItems),
    lossOnlyItems: Number(record.lossOnlyItems),
    unaccountedItems: Number(record.unaccountedItems),
    opaqueItems: Number(record.opaqueItems),
    redactedItems: Number(record.redactedItems),
    policyOmissions: Number(record.policyOmissions),
    dispositions: {
      normalized: Number(dispositionRecord.normalized),
      opaque: Number(dispositionRecord.opaque),
      redacted: Number(dispositionRecord.redacted),
      omitted: Number(dispositionRecord.omitted),
    },
  } satisfies SourceItemAccounting;
  validateSourceItemAccounting(accounting);
  return accounting;
}

function validateLossCounts(
  value: unknown,
): Partial<Record<(typeof SEMANTIC_LOSS_CODES)[number], number>> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    invalidReceipt("source receipt lossCounts must be an object");
  const result: Partial<Record<(typeof SEMANTIC_LOSS_CODES)[number], number>> = {};
  for (const [code, count] of Object.entries(value as Record<string, unknown>)) {
    if (!(SEMANTIC_LOSS_CODES as readonly string[]).includes(code))
      invalidReceipt(`source receipt lossCounts has unknown code ${code}`);
    result[code as (typeof SEMANTIC_LOSS_CODES)[number]] = boundedCount(
      count,
      `lossCounts.${code}`,
    );
  }
  return Object.fromEntries(Object.entries(result).sort(([a], [b]) => a.localeCompare(b)));
}

export function validateSourceReceipt(value: unknown): SourceReceipt {
  if (!value || typeof value !== "object" || Array.isArray(value))
    invalidReceipt("source receipt must be an object");
  const receipt = value as Record<string, unknown>;
  if (receipt.schema !== SOURCE_RECEIPT_SCHEMA) invalidReceipt("unsupported source receipt schema");
  const receiptHash = boundedHash(receipt.receiptHash, "receiptHash");
  if (!receipt.source || typeof receipt.source !== "object" || Array.isArray(receipt.source))
    invalidReceipt("source receipt source must be an object");
  const source = receipt.source as Record<string, unknown>;
  boundedText(source.path, "source.path", 4096);
  boundedHash(source.hash, "source.hash");
  boundedText(source.provider, "source.provider", 128);
  boundedText(source.harness, "source.harness", 128);
  boundedText(source.sourceKind, "source.sourceKind", 128);
  if (source.nativeSessionId !== undefined)
    boundedText(source.nativeSessionId, "source.nativeSessionId", 256);
  const eventBatchHashValue = boundedHash(receipt.eventBatchHash, "eventBatchHash");
  const adapterRecipe = boundedText(receipt.adapterRecipe, "adapterRecipe", 256);
  const capturePolicyVersion = boundedText(
    receipt.capturePolicyVersion,
    "capturePolicyVersion",
    256,
  );
  const itemCounts = validateItemCounts(receipt.itemCounts);
  const lossCounts = validateLossCounts(receipt.lossCounts);
  if (typeof receipt.partialTail !== "boolean")
    invalidReceipt("source receipt partialTail must be boolean");
  const activeSourceAuthorityVersion = boundedText(
    receipt.activeSourceAuthorityVersion,
    "activeSourceAuthorityVersion",
    256,
  );
  const eventProjectionHash = boundedHash(receipt.eventProjectionHash, "eventProjectionHash");
  const conversationProjectionHash = boundedHash(
    receipt.conversationProjectionHash,
    "conversationProjectionHash",
  );
  const body: SourceReceiptBody = {
    schema: SOURCE_RECEIPT_SCHEMA,
    source: {
      path: String(source.path),
      hash: String(source.hash),
      provider: String(source.provider),
      harness: String(source.harness),
      sourceKind: String(source.sourceKind),
      ...(source.nativeSessionId !== undefined
        ? { nativeSessionId: String(source.nativeSessionId) }
        : {}),
    },
    eventBatchHash: eventBatchHashValue,
    adapterRecipe,
    capturePolicyVersion,
    itemCounts,
    lossCounts,
    partialTail: receipt.partialTail,
    activeSourceAuthorityVersion,
    eventProjectionHash,
    conversationProjectionHash,
  };
  if (sha256(stableStringify(body)) !== receiptHash)
    invalidReceipt("source receipt integrity check failed");
  return { ...body, receiptHash };
}

function sourceReceiptBody(
  input: SourceReceiptInput,
  accounting: SourceItemAccounting,
): SourceReceiptBody {
  const origin = input.batch.origin;
  if (origin.kind !== "observed") invalidReceipt("source receipts require an observed batch");
  const source = origin.source;
  const batchHash = input.batchHash ?? eventBatchHash(input.batch);
  boundedHash(batchHash, "eventBatchHash");
  const body: SourceReceiptBody = {
    schema: SOURCE_RECEIPT_SCHEMA,
    source: {
      path: boundedText(source.sourcePath, "source.path", 4096),
      hash: boundedHash(source.redactedSourceHash, "source.hash"),
      provider: boundedText(source.provider, "source.provider", 128),
      harness: boundedText(source.harness, "source.harness", 128),
      sourceKind: boundedText(source.sourceKind, "source.sourceKind", 128),
      ...(source.nativeSessionId
        ? { nativeSessionId: boundedText(source.nativeSessionId, "source.nativeSessionId", 256) }
        : {}),
    },
    eventBatchHash: batchHash,
    adapterRecipe: boundedText(source.adapterRecipe, "adapterRecipe", 256),
    capturePolicyVersion: boundedText(source.capturePolicyVersion, "capturePolicyVersion", 256),
    itemCounts: accounting,
    lossCounts: semanticLossCounts(input.batch.semanticLoss),
    partialTail: input.batch.partialTail,
    activeSourceAuthorityVersion: boundedText(
      input.activeSourceAuthorityVersion ?? ACTIVE_SOURCE_AUTHORITY_VERSION,
      "activeSourceAuthorityVersion",
      256,
    ),
    eventProjectionHash: batchHash,
    conversationProjectionHash: boundedHash(
      input.conversationProjectionHash,
      "conversationProjectionHash",
    ),
  };
  return body;
}

export function buildSourceReceipt(input: SourceReceiptInput): SourceReceipt {
  const accounting = sourceItemAccounting(input.batch);
  validateSourceItemAccounting(accounting);
  const body = sourceReceiptBody(input, accounting);
  return { ...body, receiptHash: sha256(stableStringify(body)) };
}

function sourceReceiptPath(root: string, hash: string): string {
  boundedHash(hash, "receiptHash");
  return join(root, SOURCE_RECEIPT_DIRECTORY, hash.slice(0, 2), `${hash}.json`);
}

async function atomicWrite(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await chmod(dirname(path), 0o700);
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, text, { mode: 0o600 });
  await rename(temporary, path);
  await chmod(path, 0o600);
}

export async function persistSourceReceipt(root: string, receipt: SourceReceipt): Promise<string> {
  const validated = validateSourceReceipt(receipt);
  const path = sourceReceiptPath(root, validated.receiptHash);
  try {
    const info = await stat(path);
    if (!info.isFile()) invalidReceipt(`${path}: source receipt path is not a file`);
    const existing = validateSourceReceipt(JSON.parse(await readFile(path, "utf8")));
    if (existing.receiptHash !== validated.receiptHash)
      invalidReceipt(`${path}: source receipt hash mismatch`);
    return validated.receiptHash;
  } catch (error: unknown) {
    if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT"))
      throw error;
  }
  await atomicWrite(path, `${stableStringify(validated)}\n`);
  return validated.receiptHash;
}

export async function readSourceReceipt(root: string, hash: string): Promise<SourceReceipt> {
  return validateSourceReceipt(JSON.parse(await readFile(sourceReceiptPath(root, hash), "utf8")));
}

export async function listSourceReceipts(root: string, limit = 100): Promise<SourceReceipt[]> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200)
    invalidReceipt("source receipt limit must be between 1 and 200");
  const directory = join(root, SOURCE_RECEIPT_DIRECTORY);
  const names: string[] = [];
  try {
    for await (const entry of new Bun.Glob("**/*.json").scan({ cwd: directory, onlyFiles: true }))
      names.push(String(entry));
  } catch (error: any) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  const receipts: SourceReceipt[] = [];
  for (const name of names.toSorted().reverse().slice(0, limit))
    receipts.push(validateSourceReceipt(JSON.parse(await readFile(join(directory, name), "utf8"))));
  return receipts;
}

function nominationKey(nomination: UnknownShapeNomination): string {
  return [
    nomination.provider,
    nomination.harness,
    nomination.sourceKind,
    nomination.nativeItemKind,
  ].join("\u0000");
}

function nominationStorePath(root: string): string {
  return join(root, UNKNOWN_NOMINATION_DIRECTORY, UNKNOWN_NOMINATION_FILE);
}

function validateNomination(value: unknown): StoredUnknownShapeNomination {
  if (!value || typeof value !== "object" || Array.isArray(value))
    invalidReceipt("invalid nomination");
  const nomination = value as Record<string, unknown>;
  for (const key of ["provider", "harness", "sourceKind", "nativeItemKind"])
    boundedText(nomination[key], `nomination.${key}`, 128);
  const occurrences = boundedCount(nomination.occurrences, "nomination.occurrences");
  if (occurrences < 1) invalidReceipt("nomination.occurrences must be positive");
  const distinctSessions = boundedCount(nomination.distinctSessions, "nomination.distinctSessions");
  for (const key of ["firstSeen", "lastSeen"])
    if (nomination[key] !== undefined) boundedText(nomination[key], `nomination.${key}`, 64);
  if (!Array.isArray(nomination.sourceHashes))
    invalidReceipt("nomination.sourceHashes must be an array");
  const sourceHashes = nomination.sourceHashes.map((hash) =>
    boundedHash(hash, "nomination.sourceHash"),
  );
  if (sourceHashes.length > UNKNOWN_NOMINATION_STORAGE_LIMIT)
    invalidReceipt("nomination source hash bound exceeded");
  if (!Array.isArray(nomination.sourceContributions))
    invalidReceipt("nomination.sourceContributions must be an array");
  const sourceContributions = nomination.sourceContributions.map((value, index) => {
    if (!value || typeof value !== "object" || Array.isArray(value))
      invalidReceipt(`nomination.sourceContributions[${index}] must be an object`);
    const contribution = value as Record<string, unknown>;
    boundedHash(contribution.sourceKey, `nomination.sourceContributions[${index}].sourceKey`);
    boundedHash(contribution.sourceHash, `nomination.sourceContributions[${index}].sourceHash`);
    const contributionOccurrences = boundedCount(
      contribution.occurrences,
      `nomination.sourceContributions[${index}].occurrences`,
    );
    if (contributionOccurrences < 1)
      invalidReceipt("nomination contribution occurrences must be positive");
    const contributionSessions = boundedCount(
      contribution.distinctSessions,
      `nomination.sourceContributions[${index}].distinctSessions`,
    );
    for (const key of ["firstSeen", "lastSeen"])
      if (contribution[key] !== undefined)
        boundedText(contribution[key], `nomination.sourceContributions[${index}].${key}`, 64);
    return {
      sourceKey: String(contribution.sourceKey),
      sourceHash: String(contribution.sourceHash),
      occurrences: contributionOccurrences,
      distinctSessions: contributionSessions,
      ...(typeof contribution.firstSeen === "string" ? { firstSeen: contribution.firstSeen } : {}),
      ...(typeof contribution.lastSeen === "string" ? { lastSeen: contribution.lastSeen } : {}),
    };
  });
  if (sourceContributions.length > UNKNOWN_NOMINATION_STORAGE_LIMIT)
    invalidReceipt("nomination source contribution bound exceeded");
  return {
    provider: String(nomination.provider),
    harness: String(nomination.harness),
    sourceKind: String(nomination.sourceKind),
    nativeItemKind: String(nomination.nativeItemKind),
    occurrences,
    distinctSessions,
    ...(typeof nomination.firstSeen === "string" ? { firstSeen: nomination.firstSeen } : {}),
    ...(typeof nomination.lastSeen === "string" ? { lastSeen: nomination.lastSeen } : {}),
    sourceHashes,
    sourceContributions,
  };
}

async function readNominationStore(root: string): Promise<StoredUnknownShapeNomination[]> {
  try {
    const value = JSON.parse(
      await readFile(nominationStorePath(root), "utf8"),
    ) as UnknownShapeNominationStore;
    if (value.schema !== UNKNOWN_NOMINATION_SCHEMA || !Array.isArray(value.nominations))
      invalidReceipt("unsupported unknown nomination store");
    return value.nominations.map(validateNomination);
  } catch (error: unknown) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
}

function nominationSourceKey(batch: EventBatch): string {
  if (batch.origin.kind !== "observed") return sha256("unobserved");
  return sha256(batch.origin.source.sourcePath);
}

function aggregateContributions(
  nomination: UnknownShapeNomination,
  contributions: readonly NominationContribution[],
): StoredUnknownShapeNomination {
  const firstSeen = contributions
    .map((item) => item.firstSeen)
    .filter(Boolean)
    .toSorted()[0];
  const lastSeen = contributions
    .map((item) => item.lastSeen)
    .filter(Boolean)
    .toSorted()
    .at(-1);
  const sourceHashes = [...new Set(contributions.map((item) => item.sourceHash))].slice(
    -UNKNOWN_NOMINATION_STORAGE_LIMIT,
  );
  return {
    ...nomination,
    occurrences: contributions.reduce((sum, item) => sum + item.occurrences, 0),
    distinctSessions: contributions.reduce((sum, item) => sum + item.distinctSessions, 0),
    ...(firstSeen ? { firstSeen } : {}),
    ...(lastSeen ? { lastSeen } : {}),
    sourceHashes,
    sourceContributions: contributions.slice(-UNKNOWN_NOMINATION_STORAGE_LIMIT),
  };
}

export async function persistUnknownShapeNominations(
  root: string,
  batches: readonly EventBatch[],
  sourceHash: string,
): Promise<UnknownShapeNomination[]> {
  const boundedSourceHash = boundedHash(sourceHash, "sourceHash");
  const incoming = batches.flatMap((batch) => {
    const sourceKey = nominationSourceKey(batch);
    return unknownShapeNominations([batch]).map((nomination) => ({ nomination, sourceKey }));
  });
  if (!incoming.length) return readUnknownShapeNominations(root);
  const stored = await readNominationStore(root);
  const byKey = new Map(stored.map((nomination) => [nominationKey(nomination), nomination]));
  for (const { nomination, sourceKey } of incoming) {
    const current = byKey.get(nominationKey(nomination));
    const contributions = [...(current?.sourceContributions ?? [])];
    const contribution: NominationContribution = {
      sourceKey,
      sourceHash: boundedSourceHash,
      occurrences: nomination.occurrences,
      distinctSessions: nomination.distinctSessions,
      ...(nomination.firstSeen ? { firstSeen: nomination.firstSeen } : {}),
      ...(nomination.lastSeen ? { lastSeen: nomination.lastSeen } : {}),
    };
    const existingIndex = contributions.findIndex((item) => item.sourceKey === sourceKey);
    if (existingIndex >= 0) contributions[existingIndex] = contribution;
    else contributions.push(contribution);
    byKey.set(nominationKey(nomination), aggregateContributions(nomination, contributions));
  }
  const nominations = [...byKey.values()]
    .toSorted(
      (left, right) =>
        right.occurrences - left.occurrences ||
        nominationKey(left).localeCompare(nominationKey(right)),
    )
    .slice(0, UNKNOWN_NOMINATION_STORAGE_LIMIT);
  await atomicWrite(
    nominationStorePath(root),
    `${stableStringify({ schema: UNKNOWN_NOMINATION_SCHEMA, nominations })}\n`,
  );
  return nominations.map(
    ({ sourceHashes: _sourceHashes, sourceContributions: _sourceContributions, ...nomination }) =>
      nomination,
  );
}

export async function readUnknownShapeNominations(root: string): Promise<UnknownShapeNomination[]> {
  const stored = await readNominationStore(root);
  return stored
    .toSorted(
      (left, right) =>
        right.occurrences - left.occurrences ||
        nominationKey(left).localeCompare(nominationKey(right)),
    )
    .slice(0, UNKNOWN_NOMINATION_STORAGE_LIMIT)
    .map(
      ({ sourceHashes: _sourceHashes, sourceContributions: _sourceContributions, ...nomination }) =>
        nomination,
    );
}
