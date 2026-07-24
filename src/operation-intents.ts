import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { openAnalysis } from "./analysis";
import { assertDerivedProjection } from "./derived-authority";
import {
  clearDerivedInvalidation,
  writeDerivedInvalidation,
} from "./derived-invalidation";
import { deriveCorpus, type DeriveSummary } from "./derive";
import {
  durableAtomicWrite,
  durableUnlink,
  readBoundedText,
  syncDirectory,
} from "./durable-fs";
import {
  writeImportReceipt,
  type ImportReceipt,
  type ImportReceiptInput,
} from "./import-receipts";
import { loadRefinery, refineCorpus, type RefinerySummary } from "./refinery";
import {
  loadCorpusManifest,
  manifestSourcesHash,
  reconcileSourceAuthority,
  type CorpusManifest,
  type ManifestSourceEntry,
  type SourceAuthorityReceipt,
} from "./source-authority";

const OPERATION_INTENT_SCHEMA = "chatlog/operation-intent-v1" as const;
const MAX_INTENT_BYTES = 16 * 1024 * 1024;
const MAX_TRANSITION_CHANGES = 10_000;

type OperationKind = "ingest" | "anthropic-import";
type PendingStatus =
  | "prepared"
  | "authority-committed"
  | "authority-reconciled"
  | "derived-resolved"
  | "receipt-written";
type OperationStatus = PendingStatus | "completed" | "aborted";

interface SourceMappingChange {
  sourcePath: string;
  before: ManifestSourceEntry | null;
  after: ManifestSourceEntry | null;
}

type ImportReceiptBase = Omit<
  ImportReceiptInput,
  "completedAt" | "operationId" | "derivationStatus" | "derived" | "refinery"
>;

interface DerivationResolution {
  status: "not-requested" | "completed" | "failed";
  resolvedAt: string;
  derived?: Pick<DeriveSummary, "discovered" | "processed" | "skipped" | "recipeChanged">;
  refinery?: Pick<RefinerySummary, "inputConversations" | "candidates" | "processed">;
}

export interface OperationIntent {
  schema: typeof OPERATION_INTENT_SCHEMA;
  operationId: string;
  operation: OperationKind;
  status: OperationStatus;
  createdAt: string;
  updatedAt: string;
  transition: {
    beforeManifestHash: string;
    afterManifestHash: string;
    beforeSourcesHash: string;
    afterSourcesHash: string;
    changes: SourceMappingChange[];
    changeCount: number;
    changesTruncated: boolean;
  };
  derivation: {
    requested: boolean;
    resolution?: DerivationResolution;
  };
  projection?: SourceAuthorityReceipt;
  receipt?: {
    kind: "import";
    input: ImportReceiptBase;
    receiptId?: string;
  };
  completion?: {
    completedAt: string;
    receiptId?: string;
  };
  abortReason?: "authority-not-committed";
}

interface PersistedOperationIntent extends OperationIntent {
  integrityHash: string;
}

export interface OperationResumeResult {
  intent: OperationIntent;
  receipt?: ImportReceipt;
  derived?: DeriveSummary;
  refinery?: RefinerySummary;
  derivationFailed: boolean;
}

export interface OperationRecoverySummary {
  discovered: number;
  completed: number;
  aborted: number;
}

export class OperationIntentConflictError extends Error {
  constructor(
    readonly operationId: string,
    options: ErrorOptions = {},
  ) {
    super(
      `operation ${operationId} cannot resume because the corpus manifest matches neither side of its transition`,
      options,
    );
    this.name = "OperationIntentConflictError";
  }
}

function sha256(value: string): string {
  return new Bun.CryptoHasher("sha256").update(value).digest("hex");
}

function canonicalTimestamp(value: string, label: string): string {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.valueOf()) || parsed.toISOString() !== value)
    throw new Error(`${label} is not a canonical ISO-8601 timestamp`);
  return value;
}

function validateHash(value: string, label: string): string {
  if (!/^[a-f0-9]{64}$/.test(value)) throw new Error(`${label} is not a SHA-256 hash`);
  return value;
}

function validateMappingEntry(
  value: ManifestSourceEntry | null,
  label: string,
): void {
  if (value === null) return;
  if (!value || typeof value !== "object") throw new Error(`${label} is invalid`);
  validateHash(value.contentHash, `${label} content hash`);
  for (const [name, item] of [["size", value.size], ["mtime", value.mtimeMs]] as const) {
    if (item != null && (!Number.isFinite(item) || item < 0))
      throw new Error(`${label} ${name} is invalid`);
  }
}

function canonicalManifest(manifest: CorpusManifest): string {
  return JSON.stringify({
    version: manifest.version,
    redactionRecipe: manifest.redactionRecipe ?? null,
    sources: Object.entries(manifest.sources)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([sourcePath, entry]) => [
        sourcePath,
        {
          contentHash: entry.contentHash,
          size: entry.size ?? null,
          mtimeMs: entry.mtimeMs ?? null,
        },
      ]),
  });
}

export function corpusManifestHash(manifest: CorpusManifest): string {
  return sha256(canonicalManifest(manifest));
}

async function loadManifestOrEmpty(root: string): Promise<CorpusManifest> {
  try {
    return await loadCorpusManifest(root);
  } catch (error: any) {
    if (error?.code === "ENOENT") return { version: 1, sources: {} };
    throw error;
  }
}

function mappingChanges(
  before: Record<string, ManifestSourceEntry>,
  after: Record<string, ManifestSourceEntry>,
): Pick<OperationIntent["transition"], "changes" | "changeCount" | "changesTruncated"> {
  const changes: SourceMappingChange[] = [];
  let changeCount = 0;
  const paths = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  for (const sourcePath of paths) {
    const previous = before[sourcePath] ?? null;
    const next = after[sourcePath] ?? null;
    if (JSON.stringify(previous) === JSON.stringify(next)) continue;
    changeCount++;
    if (changes.length < MAX_TRANSITION_CHANGES)
      changes.push({
        sourcePath,
        before: previous ? { ...previous } : null,
        after: next ? { ...next } : null,
      });
  }
  return {
    changes,
    changeCount,
    changesTruncated: changeCount > changes.length,
  };
}

function operationPath(
  root: string,
  state: "pending" | "completed" | "aborted",
  operationId: string,
): string {
  return join(root, "operations", state, `${operationId}.json`);
}

async function durableWrite(path: string, text: string): Promise<void> {
  await durableAtomicWrite(path, text, { maxBytes: MAX_INTENT_BYTES });
}

function seal(intent: OperationIntent): PersistedOperationIntent {
  return {
    ...intent,
    integrityHash: sha256(JSON.stringify(intent)),
  };
}

function validateIntent(value: unknown, path: string): OperationIntent {
  const persisted = value as PersistedOperationIntent;
  if (
    persisted?.schema !== OPERATION_INTENT_SCHEMA
    || !/^[0-9A-Za-z-]{1,128}$/.test(persisted.operationId)
    || !["ingest", "anthropic-import"].includes(persisted.operation)
    || ![
      "prepared",
      "authority-committed",
      "authority-reconciled",
      "derived-resolved",
      "receipt-written",
      "completed",
      "aborted",
    ].includes(persisted.status)
    || !/^[a-f0-9]{64}$/.test(persisted.integrityHash)
  ) {
    throw new Error(`${path}: unsupported operation intent`);
  }
  const { integrityHash, ...intent } = persisted;
  if (sha256(JSON.stringify(intent)) !== integrityHash)
    throw new Error(`${path}: operation intent integrity check failed`);
  canonicalTimestamp(intent.createdAt, "operation creation time");
  canonicalTimestamp(intent.updatedAt, "operation update time");
  validateHash(intent.transition.beforeManifestHash, "before manifest hash");
  validateHash(intent.transition.afterManifestHash, "after manifest hash");
  validateHash(intent.transition.beforeSourcesHash, "before sources hash");
  validateHash(intent.transition.afterSourcesHash, "after sources hash");
  if (
    !Array.isArray(intent.transition.changes)
    || intent.transition.changes.length > MAX_TRANSITION_CHANGES
    || !Number.isSafeInteger(intent.transition.changeCount)
    || intent.transition.changeCount < intent.transition.changes.length
    || intent.transition.changesTruncated
      !== (intent.transition.changeCount > intent.transition.changes.length)
  ) {
    throw new Error(`${path}: operation transition exceeds source mapping bounds`);
  }
  for (const [index, change] of intent.transition.changes.entries()) {
    if (
      !change.sourcePath
      || change.sourcePath.length > 4096
      || (change.before === null && change.after === null)
    ) {
      throw new Error(`${path}: invalid source transition at index ${index}`);
    }
    validateMappingEntry(change.before, `transition ${index} before mapping`);
    validateMappingEntry(change.after, `transition ${index} after mapping`);
  }
  return intent;
}

async function readIntent(path: string): Promise<OperationIntent> {
  const text = await readBoundedText(path, MAX_INTENT_BYTES, "operation intent");
  return validateIntent(JSON.parse(text), path);
}

async function writePending(root: string, intent: OperationIntent): Promise<void> {
  await durableWrite(
    operationPath(root, "pending", intent.operationId),
    JSON.stringify(seal(intent), null, 2) + "\n",
  );
}

async function advance(
  root: string,
  intent: OperationIntent,
  patch: Partial<OperationIntent>,
): Promise<OperationIntent> {
  const next: OperationIntent = {
    ...intent,
    ...patch,
    updatedAt: new Date().toISOString(),
  };
  await writePending(root, next);
  return next;
}

export async function createOperationIntent(
  root: string,
  input: {
    operation: OperationKind;
    before: CorpusManifest;
    after: CorpusManifest;
    derive: boolean;
    receipt?: { kind: "import"; input: ImportReceiptBase };
    operationId?: string;
    createdAt?: string;
  },
): Promise<OperationIntent> {
  const createdAt = input.createdAt ?? new Date().toISOString();
  canonicalTimestamp(createdAt, "operation creation time");
  const operationId = input.operationId
    ?? `${createdAt.replaceAll(/[^0-9A-Za-z]/g, "")}-${randomUUID()}`;
  if (!/^[0-9A-Za-z-]{1,128}$/.test(operationId))
    throw new Error("operation ID must contain only letters, digits, and hyphens");
  const intent: OperationIntent = {
    schema: OPERATION_INTENT_SCHEMA,
    operationId,
    operation: input.operation,
    status: "prepared",
    createdAt,
    updatedAt: createdAt,
    transition: {
      beforeManifestHash: corpusManifestHash(input.before),
      afterManifestHash: corpusManifestHash(input.after),
      beforeSourcesHash: manifestSourcesHash(input.before.sources),
      afterSourcesHash: manifestSourcesHash(input.after.sources),
      ...mappingChanges(input.before.sources, input.after.sources),
    },
    derivation: { requested: input.derive },
    ...(input.receipt ? { receipt: input.receipt } : {}),
  };
  validateIntent(seal(intent), operationPath(root, "pending", operationId));
  await writePending(root, intent);
  return intent;
}

export async function abortOperationIntent(
  root: string,
  intent: OperationIntent,
  reason: "authority-not-committed",
): Promise<OperationIntent> {
  const aborted: OperationIntent = {
    ...intent,
    status: "aborted",
    abortReason: reason,
    updatedAt: new Date().toISOString(),
  };
  await durableWrite(
    operationPath(root, "aborted", intent.operationId),
    JSON.stringify(seal(aborted), null, 2) + "\n",
  );
  await durableUnlink(operationPath(root, "pending", intent.operationId));
  return aborted;
}

async function completeOperationIntent(
  root: string,
  intent: OperationIntent,
): Promise<OperationIntent> {
  const completedAt = intent.derivation.resolution?.resolvedAt
    ?? new Date().toISOString();
  const completed: OperationIntent = {
    ...intent,
    status: "completed",
    completion: {
      completedAt,
      ...(intent.receipt?.receiptId ? { receiptId: intent.receipt.receiptId } : {}),
    },
    updatedAt: new Date().toISOString(),
  };
  await durableWrite(
    operationPath(root, "completed", intent.operationId),
    JSON.stringify(seal(completed), null, 2) + "\n",
  );
  await durableUnlink(operationPath(root, "pending", intent.operationId));
  return completed;
}

async function resolveDerivation(
  root: string,
  intent: OperationIntent,
): Promise<{
  intent: OperationIntent;
  failed: boolean;
  derived?: DeriveSummary;
  refinery?: RefinerySummary;
}> {
  if (intent.derivation.resolution) {
    const resolution = intent.derivation.resolution;
    if (resolution.status === "completed") {
      try {
        await assertDerivedProjection(root);
        await loadRefinery(root);
        return { intent, failed: false };
      } catch (error) {
        if (intent.receipt?.receiptId) {
          await deriveCorpus(root);
          await refineCorpus(root, 3, { allowExplicitInvalidation: true });
          await clearDerivedInvalidation(root);
          await assertDerivedProjection(root);
          await loadRefinery(root);
          return { intent, failed: false };
        }
        intent = await advance(root, intent, {
          status: "authority-reconciled",
          derivation: { requested: intent.derivation.requested },
        });
      }
    } else {
      if (
        resolution.status === "not-requested"
        && intent.transition.beforeSourcesHash === intent.transition.afterSourcesHash
      ) {
        return { intent, failed: false };
      }
      await writeDerivedInvalidation(root, {
        operationId: intent.operationId,
        manifestSourcesHash: intent.transition.afterSourcesHash,
        reason: resolution.status === "failed"
          ? "derivation-failed"
          : "derivation-not-requested",
        invalidatedAt: resolution.resolvedAt,
      });
      return { intent, failed: resolution.status === "failed" };
    }
  }

  let resolution: DerivationResolution;
  let derivedResult: DeriveSummary | undefined;
  let refineryResult: RefinerySummary | undefined;
  if (!intent.derivation.requested) {
    if (intent.transition.beforeSourcesHash !== intent.transition.afterSourcesHash) {
      await writeDerivedInvalidation(root, {
        operationId: intent.operationId,
        manifestSourcesHash: intent.transition.afterSourcesHash,
        reason: "derivation-not-requested",
      });
    }
    resolution = {
      status: "not-requested",
      resolvedAt: new Date().toISOString(),
    };
  } else {
    try {
      derivedResult = await deriveCorpus(root);
      refineryResult = await refineCorpus(root, 3, {
        allowExplicitInvalidation: true,
      });
      await clearDerivedInvalidation(root);
      resolution = {
        status: "completed",
        resolvedAt: new Date().toISOString(),
        derived: {
          discovered: derivedResult.discovered,
          processed: derivedResult.processed,
          skipped: derivedResult.skipped,
          recipeChanged: derivedResult.recipeChanged,
        },
        refinery: {
          inputConversations: refineryResult.inputConversations,
          candidates: refineryResult.candidates,
          processed: refineryResult.processed,
        },
      };
    } catch {
      const resolvedAt = new Date().toISOString();
      await writeDerivedInvalidation(root, {
        operationId: intent.operationId,
        manifestSourcesHash: intent.transition.afterSourcesHash,
        reason: "derivation-failed",
        invalidatedAt: resolvedAt,
      });
      resolution = { status: "failed", resolvedAt };
    }
  }
  return {
    intent: await advance(root, intent, {
      status: "derived-resolved",
      derivation: { ...intent.derivation, resolution },
    }),
    failed: resolution.status === "failed",
    ...(derivedResult ? { derived: derivedResult } : {}),
    ...(refineryResult ? { refinery: refineryResult } : {}),
  };
}

export async function resolveManifestWriteFailure(
  root: string,
  intent: OperationIntent,
  writeError: unknown,
): Promise<void> {
  const actualHash = corpusManifestHash(await loadManifestOrEmpty(root));
  if (
    actualHash === intent.transition.beforeManifestHash
    && intent.transition.beforeManifestHash !== intent.transition.afterManifestHash
  ) {
    await abortOperationIntent(root, intent, "authority-not-committed");
    throw writeError;
  }
  if (actualHash === intent.transition.afterManifestHash) {
    await syncDirectory(join(root, "corpus"));
    return;
  }
  throw new OperationIntentConflictError(intent.operationId, { cause: writeError });
}

export async function resumeCommittedOperation(
  root: string,
  original: OperationIntent,
): Promise<OperationResumeResult> {
  let intent = original;
  const manifest = await loadManifestOrEmpty(root);
  if (corpusManifestHash(manifest) !== intent.transition.afterManifestHash)
    throw new OperationIntentConflictError(intent.operationId);

  if (intent.status === "prepared") {
    intent = await advance(root, intent, { status: "authority-committed" });
  }
  if (
    intent.transition.beforeSourcesHash !== intent.transition.afterSourcesHash
    && !intent.derivation.resolution
  ) {
    await writeDerivedInvalidation(root, {
      operationId: intent.operationId,
      manifestSourcesHash: intent.transition.afterSourcesHash,
      reason: "authority-transition",
    });
  }

  const db = openAnalysis(join(root, "analysis", "chatlog.sqlite"));
  let projection: SourceAuthorityReceipt;
  try {
    projection = await reconcileSourceAuthority(root, db, manifest.sources);
  } finally {
    db.close();
  }
  if (
    !intent.projection
    || intent.projection.manifestSourcesHash !== projection.manifestSourcesHash
    || intent.projection.reconciledAt !== projection.reconciledAt
    || intent.projection.activeSources !== projection.activeSources
    || intent.projection.reindexed !== projection.reindexed
    || intent.status === "prepared"
    || intent.status === "authority-committed"
  ) {
    intent = await advance(root, intent, {
      status: "authority-reconciled",
      projection,
    });
  }

  const resolved = await resolveDerivation(root, intent);
  intent = resolved.intent;
  let receipt: ImportReceipt | undefined;
  if (intent.receipt?.kind === "import") {
    const resolution = intent.derivation.resolution!;
    receipt = await writeImportReceipt(root, {
      ...intent.receipt.input,
      operationId: intent.operationId,
      completedAt: resolution.resolvedAt,
      derivationStatus: resolution.status,
      derived: resolution.derived as DeriveSummary | undefined,
      refinery: resolution.refinery as RefinerySummary | undefined,
    });
    if (intent.receipt.receiptId !== receipt.receiptId) {
      intent = await advance(root, intent, {
        status: "receipt-written",
        receipt: { ...intent.receipt, receiptId: receipt.receiptId },
      });
    }
  }
  intent = await completeOperationIntent(root, intent);
  return {
    intent,
    ...(receipt ? { receipt } : {}),
    ...(resolved.derived ? { derived: resolved.derived } : {}),
    ...(resolved.refinery ? { refinery: resolved.refinery } : {}),
    derivationFailed: resolved.failed,
  };
}

export async function listPendingOperationIntents(
  root: string,
): Promise<OperationIntent[]> {
  const directory = join(root, "operations", "pending");
  let names: string[];
  try {
    names = [...new Bun.Glob("*.json").scanSync({ cwd: directory, onlyFiles: true })]
      .sort();
  } catch (error: any) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  if (names.length > 1_000)
    throw new Error("pending operation intent count exceeds recovery bound");
  const intents: OperationIntent[] = [];
  for (const name of names) {
    const intent = await readIntent(join(directory, name));
    if (name !== `${intent.operationId}.json`)
      throw new Error(`${join(directory, name)}: operation ID does not match filename`);
    intents.push(intent);
  }
  return intents;
}

export async function recoverPendingOperations(
  root: string,
): Promise<OperationRecoverySummary> {
  const intents = await listPendingOperationIntents(root);
  const summary: OperationRecoverySummary = {
    discovered: intents.length,
    completed: 0,
    aborted: 0,
  };
  for (const intent of intents) {
    const completedPath = operationPath(root, "completed", intent.operationId);
    if (await Bun.file(completedPath).exists()) {
      const completed = await readIntent(completedPath);
      if (completed.status !== "completed")
        throw new Error(`${completedPath}: completed operation has invalid status`);
      await durableUnlink(operationPath(root, "pending", intent.operationId));
      summary.completed++;
      continue;
    }
    const manifest = await loadManifestOrEmpty(root);
    const actualHash = corpusManifestHash(manifest);
    if (
      actualHash === intent.transition.beforeManifestHash
      && intent.transition.beforeManifestHash !== intent.transition.afterManifestHash
    ) {
      await abortOperationIntent(root, intent, "authority-not-committed");
      summary.aborted++;
      continue;
    }
    if (actualHash !== intent.transition.afterManifestHash)
      throw new OperationIntentConflictError(intent.operationId);
    await resumeCommittedOperation(root, intent);
    summary.completed++;
  }
  return summary;
}
