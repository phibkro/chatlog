import { chmod, lstat, mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { indexConversation, indexEventBatch, openAnalysis } from "../analysis";
import { canonicalizeConversation, projectConversation } from "../conversation-projection";
import { normalizeConversationDomain } from "../domain";
import {
  CLOSED_LOOP_EVALUATOR_ADAPTER_RECIPE,
  CLOSED_LOOP_EVALUATOR_SOURCE_KIND,
} from "../closed-loop-evaluation";
import {
  GENERIC_EVENT_MAX_BATCH_BYTES,
  GENERIC_EVENT_MAX_BATCH_EVENTS,
  GENERIC_EVENT_MAX_BATCH_SEMANTIC_LOSSES,
  GENERIC_EVENT_MAX_EVENTS,
  GENERIC_EVENT_MAX_FILE_BYTES,
  GENERIC_EVENT_MAX_LINES,
  GENERIC_EVENT_MAX_LINE_BYTES,
  GENERIC_EVENT_MAX_SEMANTIC_LOSSES,
  type GenericEventHeader,
  validateGenericEventHeader,
} from "../generic-event-schema";
import {
  capture,
  makeEvent,
  makeObservedBatchOrigin,
  makeObservedSource,
  makeSemanticLoss,
  redactedHash,
  sha256,
  stableStringify,
  validateAgentEvent,
  validateSemanticLoss,
  type AgentEventEnvelope,
  type SourceEventReference,
  type EventBatch,
  type EventRelations,
  type SemanticLossEntry,
} from "../events";
import { persistEventBatch } from "../event-store";
import { reconcileSourceAuthority, type CorpusManifest } from "../source-authority";
import { buildSourceReceipt, persistSourceReceipt, type SourceReceipt } from "../source-receipts";
import { withIngestLock } from "../lock";
import { redact } from "../redact";
import type { Conversation, ConversationDomain } from "../types";
import type { DeriveSummary } from "../derive";
import type { RefinerySummary } from "../refinery";
import { deriveCorpus } from "../derive";
import { refineCorpus } from "../refinery";
import {
  EXPORT_MAX_CORPUS_OBJECT_BYTES,
  EXPORT_MAX_MANIFEST_BYTES,
  type ExportLimitFailure,
  readBoundedFile,
} from "./export-limits";
export {
  EXPORT_MAX_CORPUS_OBJECT_BYTES as GENERIC_MAX_CORPUS_OBJECT_BYTES,
  EXPORT_MAX_MANIFEST_BYTES as GENERIC_MAX_MANIFEST_BYTES,
} from "./export-limits";
export class GenericEventImportError extends Error {
  readonly code = "generic-event-import-invalid";
}

function failClosed(message: string, cause?: unknown): never {
  throw new GenericEventImportError(message, cause === undefined ? undefined : { cause });
}

function boundedFailure(error: ExportLimitFailure): never {
  return failClosed(error.message, error);
}
const GENERIC_RECIPE_PREFIX = "chatlog-generic-events-v1";

export interface GenericEventImportOptions {
  domain?: ConversationDomain;
  derive?: boolean;
}

export interface GenericEventPreviewSummary {
  schema: "chatlog/generic-event-import-preview-v1";
  advisory: true;
  ready: boolean;
  source: string;
  sourceBytes: number;
  sourceModifiedAt: string;
  sourceContentHash: string;
  producer: { name: string; version: string };
  provider: string;
  harness: string;
  domain: string;
  headerDomain: string;
  receiptId: string;
  proposalId: string;
  lines: number;
  events: number;
  batches: number;
  partialTail: boolean;
  new: number;
  changed: number;
  reclassified: number;
  unchanged: number;
  wouldImport: number;
  kinds: Readonly<Record<string, number>>;
  losses: Readonly<Record<string, number>>;
  domains: readonly string[];
}

export interface GenericEventImportSummary {
  source: string;
  domain: string;
  producer: { name: string; version: string };
  provider: string;
  harness: string;
  events: number;
  batches: number;
  partialTail: boolean;
  imported: number;
  skipped: number;
  receipts: readonly SourceReceipt[];
  receipt: SourceReceipt;
  derived?: DeriveSummary;
  refinery?: RefinerySummary;
}

interface GenericStream {
  source: string;
  sourceBytes: number;
  sourceModifiedAt: string;
  sourceContentHash: string;
  header: GenericEventHeader;
  batch: EventBatch;
  lines: number;
  batches: number;
  kinds: Record<string, number>;
}

interface GenericLineRecord {
  events: readonly Record<string, unknown>[];
  losses: readonly unknown[];
  origin: unknown;
  isBatch: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function requiredText(value: unknown, label: string): string {
  if (typeof value !== "string" || !value) failClosed(`${label} must be non-empty text`);
  return value;
}

function sourcePositionEqual(value: unknown, expected: { line: number; record?: number }): boolean {
  if (!isRecord(value)) return false;
  if (value.line !== expected.line) return false;
  if (expected.record === undefined) return value.record === undefined;
  return value.record === expected.record;
}

function relationTargets(value: unknown): string[] {
  if (!isRecord(value)) failClosed("event relations must be an object");
  const targets: string[] = [];
  if (value.parent !== undefined) targets.push(requiredText(value.parent, "event relation parent"));
  if (value.branch !== undefined) targets.push(requiredText(value.branch, "event relation branch"));
  for (const name of ["causedBy", "correlatesWith", "derivedFrom"] as const) {
    if (value[name] === undefined) continue;
    if (
      !Array.isArray(value[name]) ||
      !value[name].every((item) => typeof item === "string" && item)
    )
      failClosed(`event relation ${name} must be a string array`);
    targets.push(...(value[name] as string[]));
  }
  return targets;
}
function remapRelations(value: unknown, ids: ReadonlyMap<string, string>): EventRelations {
  if (!isRecord(value)) failClosed("generic event relations must be an object");
  relationTargets(value);
  const map = (target: string): string => {
    const mapped = ids.get(target);
    if (!mapped) failClosed(`generic event relation target is missing or out of order: ${target}`);
    return mapped;
  };
  return {
    ...(value.parent !== undefined
      ? { parent: map(requiredText(value.parent, "event relation parent")) }
      : {}),
    ...(value.branch !== undefined
      ? { branch: map(requiredText(value.branch, "event relation branch")) }
      : {}),
    ...(value.causedBy !== undefined ? { causedBy: (value.causedBy as string[]).map(map) } : {}),
    ...(value.correlatesWith !== undefined
      ? { correlatesWith: (value.correlatesWith as string[]).map(map) }
      : {}),
    ...(value.derivedFrom !== undefined
      ? { derivedFrom: (value.derivedFrom as string[]).map(map) }
      : {}),
  };
}

function lineRecord(value: unknown): GenericLineRecord {
  if (!isRecord(value)) failClosed("generic event line must be an object");
  if (value.type === "event" && isRecord(value.event))
    return { events: [value.event], losses: [], origin: value.origin, isBatch: false };
  if (value.type === "batch" && isRecord(value.batch)) value = value.batch;
  if (!isRecord(value)) failClosed("generic event batch must be an object");
  if (value.type === "batch" || value.events !== undefined) {
    if (!Array.isArray(value.events)) failClosed("generic batch events must be an array");
    if (value.events.length > GENERIC_EVENT_MAX_BATCH_EVENTS)
      failClosed("generic event batch exceeds event limit");
    if (value.events.some((event) => !isRecord(event)))
      failClosed("generic batch event must be an object");
    const losses = value.semanticLoss === undefined ? [] : value.semanticLoss;
    if (!Array.isArray(losses)) failClosed("generic batch semanticLoss must be an array");
    if (losses.length > GENERIC_EVENT_MAX_BATCH_SEMANTIC_LOSSES)
      failClosed("generic event batch exceeds semantic-loss limit");
    return {
      events: value.events,
      losses,
      origin: value.origin,
      isBatch: true,
    };
  }
  if (typeof value.eventId === "string" || typeof value.kind === "string")
    return { events: [value], losses: [], origin: undefined, isBatch: false };
  failClosed("generic event line must be an event or batch envelope");
}

function recipeForHeader(header: GenericEventHeader): string {
  const recipe =
    header.adapterRecipe ??
    `${GENERIC_RECIPE_PREFIX}:${header.producer.name}@${header.producer.version}`;
  if (
    header.sourceKind === CLOSED_LOOP_EVALUATOR_SOURCE_KIND ||
    recipe === CLOSED_LOOP_EVALUATOR_ADAPTER_RECIPE
  )
    failClosed("generic event provenance uses reserved closed-loop evaluator authority");
  if (recipe.length > 256) failClosed("generic event adapter recipe exceeds bounds");
  return recipe;
}

function assertExternalSource(
  source: unknown,
  header: GenericEventHeader,
  sourcePath: string,
  expectedPosition: { line: number; record?: number },
  recipe: string,
): SourceEventReference {
  if (!isRecord(source)) failClosed("generic event origin.source is required");
  if (
    source.provider !== header.provider ||
    source.harness !== header.harness ||
    source.sourceKind !== header.sourceKind
  )
    failClosed("generic event source provenance conflicts with header");
  if (source.sourcePath !== sourcePath)
    failClosed("generic event source provenance conflicts with importer path");
  if (!sourcePositionEqual(source.recordPosition, expectedPosition))
    failClosed("generic event source provenance conflicts with importer position");
  if (source.adapterRecipe !== recipe)
    failClosed("generic event source provenance conflicts with header recipe");
  if (source.capturePolicyVersion !== header.capturePolicyVersion)
    failClosed("generic event capture policy conflicts with header");
  const nativeSessionId =
    source.nativeSessionId === undefined
      ? undefined
      : requiredText(source.nativeSessionId, "nativeSessionId");
  const nativeItemId =
    source.nativeItemId === undefined
      ? undefined
      : requiredText(source.nativeItemId, "nativeItemId");
  const redactedNativeRecordHash = requiredText(
    source.redactedNativeRecordHash,
    "redactedNativeRecordHash",
  );
  if (!/^[a-f0-9]{64}$/i.test(redactedNativeRecordHash))
    failClosed("generic event redactedNativeRecordHash must be SHA-256");
  return {
    provider: header.provider,
    harness: header.harness,
    sourceKind: header.sourceKind,
    sourcePath,
    recordPosition: expectedPosition,
    adapterRecipe: recipe,
    capturePolicyVersion: header.capturePolicyVersion,
    ...(nativeSessionId ? { nativeSessionId } : {}),
    ...(nativeItemId ? { nativeItemId } : {}),
    redactedNativeRecordHash,
  };
}

function unknownEvent(
  raw: Record<string, unknown>,
  header: GenericEventHeader,
  sourcePath: string,
  position: { line: number; record?: number },
  recipe: string,
  sequence: number,
): AgentEventEnvelope {
  const nativeItemId = requiredText(raw.eventId, "unknown event eventId");
  const source = makeObservedSource(
    {
      provider: header.provider,
      harness: header.harness,
      sourceKind: header.sourceKind,
      sourcePath,
      recordPosition: position,
      adapterRecipe: recipe,
      capturePolicyVersion: header.capturePolicyVersion,
      nativeItemId,
      ...(isRecord(raw.origin) &&
      isRecord(raw.origin.source) &&
      typeof raw.origin.source.nativeSessionId === "string"
        ? { nativeSessionId: raw.origin.source.nativeSessionId }
        : {}),
    },
    raw,
  );
  return makeEvent({
    kind: "provider.opaque",
    sequence,
    actor: { kind: "provider", name: header.provider },
    scope: {},
    origin: { kind: "observed", source },
    relations: {},
    payload: {
      nativeItemKind: typeof raw.kind === "string" ? raw.kind : "unknown",
      producerEventId: nativeItemId,
      rawEvent: raw,
    },
    capture: capture("opaque"),
  });
}

function lossForUnknown(
  raw: Record<string, unknown>,
  header: GenericEventHeader,
  sourcePath: string,
  position: { line: number; record?: number },
  recipe: string,
): SemanticLossEntry {
  return makeSemanticLoss({
    code: "unknown-well-formed-item",
    reason:
      "Generic event kind is not in the Chatlog taxonomy; the redacted source item was retained opaque.",
    provider: header.provider,
    harness: header.harness,
    sourceItemKind: typeof raw.kind === "string" ? raw.kind : "unknown",
    sourceLocator: `${sourcePath}:${position.line}`,
    count: 1,
    adapterRecipe: recipe,
    capturePolicyVersion: header.capturePolicyVersion,
    recoverable: true,
    sourcePath,
    recordPosition: position,
    nativeItemId: typeof raw.eventId === "string" ? raw.eventId : undefined,
  });
}

function normalizeEvent(
  raw: Record<string, unknown>,
  header: GenericEventHeader,
  sourcePath: string,
  position: { line: number; record?: number },
  recipe: string,
  sequence: number,
  priorIds: ReadonlyMap<string, string>,
): { event: AgentEventEnvelope; originalId: string; loss?: SemanticLossEntry } {
  const originalId = requiredText(raw.eventId, "eventId");
  if (raw.schemaVersion !== 1) failClosed("generic event schemaVersion must be 1");
  if (
    typeof raw.sequence !== "number" ||
    !Number.isSafeInteger(raw.sequence) ||
    raw.sequence !== sequence
  )
    failClosed("generic event sequence is not contiguous");
  if (!isRecord(raw.origin)) failClosed("generic event origin is required");
  if (raw.origin.kind === "chatlog") failClosed("generic import accepts observed origins only");
  if (raw.origin.kind !== "observed") failClosed("generic event origin.kind must be observed");
  const source = assertExternalSource(raw.origin.source, header, sourcePath, position, recipe);
  const relations = raw.relations === undefined ? {} : remapRelations(raw.relations, priorIds);
  const kind = typeof raw.kind === "string" ? raw.kind : "";
  if (!kind || !raw.actor || !raw.scope || !raw.payload || !raw.capture)
    failClosed("generic event envelope is incomplete");
  let validated: AgentEventEnvelope;
  try {
    validated = validateAgentEvent(raw);
  } catch (error) {
    if (
      kind !== "provider.opaque" &&
      error instanceof Error &&
      error.message.includes("kind is unknown")
    ) {
      const event = unknownEvent(raw, header, sourcePath, position, recipe, sequence);
      return { event, originalId, loss: lossForUnknown(raw, header, sourcePath, position, recipe) };
    }
    failClosed(error instanceof Error ? error.message : String(error), error);
  }
  const stampedSource = makeObservedSource(
    {
      provider: source.provider,
      harness: source.harness,
      sourceKind: source.sourceKind,
      sourcePath: source.sourcePath,
      recordPosition: position,
      adapterRecipe: recipe,
      capturePolicyVersion: header.capturePolicyVersion,
      ...(source.nativeSessionId ? { nativeSessionId: source.nativeSessionId } : {}),
      ...(source.nativeItemId ? { nativeItemId: source.nativeItemId } : {}),
    },
    raw,
  );
  const event = makeEvent({
    kind: validated.kind,
    sequence,
    ...(validated.occurredAt ? { occurredAt: validated.occurredAt } : {}),
    ...(validated.observedAt ? { observedAt: validated.observedAt } : {}),
    actor: validated.actor,
    scope: validated.scope,
    origin: { kind: "observed", source: stampedSource },
    relations,
    payload: { ...validated.payload, producerEventId: originalId },
    capture: validated.capture,
  });
  return { event, originalId };
}

function validateExternalBatchOrigin(
  origin: unknown,
  header: GenericEventHeader,
  sourcePath: string,
  recipe: string,
): void {
  if (origin === undefined) return;
  if (!isRecord(origin)) failClosed("generic batch origin must be an object");
  if (origin.kind === "chatlog") failClosed("generic import accepts observed batch origins only");
  if (origin.kind !== "observed" || !isRecord(origin.source))
    failClosed("generic batch origin.kind must be observed");
  const source = origin.source;
  if (
    source.provider !== header.provider ||
    source.harness !== header.harness ||
    source.sourceKind !== header.sourceKind ||
    source.sourcePath !== sourcePath ||
    source.adapterRecipe !== recipe ||
    source.capturePolicyVersion !== header.capturePolicyVersion
  )
    failClosed("generic batch provenance conflicts with header or importer path");
}

interface GenericTextLine {
  readonly line: string;
  readonly lineNumber: number;
  readonly final: boolean;
}

function* genericTextLines(text: string): Generator<GenericTextLine> {
  let start = 0;
  let lineNumber = 1;
  while (start < text.length) {
    const newline = text.indexOf("\n", start);
    if (newline === -1) {
      yield { line: text.slice(start), lineNumber, final: true };
      return;
    }
    yield { line: text.slice(start, newline), lineNumber, final: false };
    start = newline + 1;
    lineNumber++;
  }
}

export function parseGenericEventText(
  text: string,
  sourcePath: string,
  sourceBytes = Buffer.byteLength(text),
  sourceModifiedAt = new Date(0).toISOString(),
): GenericStream {
  const actualSourceBytes = Buffer.byteLength(text);
  if (
    !Number.isSafeInteger(sourceBytes) ||
    sourceBytes < 0 ||
    sourceBytes !== actualSourceBytes ||
    actualSourceBytes > GENERIC_EVENT_MAX_FILE_BYTES
  )
    failClosed("generic event file exceeds size limit or has inconsistent byte metadata");
  const resolvedSource = resolve(sourcePath);
  const hasTrailingNewline = text.endsWith("\n");
  let partialTail = false;
  let partialTailLine: number | undefined;
  let header: GenericEventHeader | undefined;
  const rawEvents: Array<{ raw: Record<string, unknown>; line: number; record?: number }> = [];
  const rawLosses: Array<{ value: SemanticLossEntry; line: number; record: number }> = [];
  let lineCount = 0;
  let batchCount = 0;
  let physicalLineCount = 0;
  for (const { line, lineNumber, final } of genericTextLines(text)) {
    physicalLineCount++;
    if (physicalLineCount > GENERIC_EVENT_MAX_LINES)
      failClosed(`${resolvedSource}: physical line count exceeds bound`);
    if (!line.trim()) continue;
    lineCount = lineNumber;
    const bytes = Buffer.byteLength(line);
    if (bytes > GENERIC_EVENT_MAX_LINE_BYTES)
      failClosed(`${resolvedSource}:${lineNumber}: line exceeds size limit`);
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch (error) {
      if (!hasTrailingNewline && final) {
        partialTail = true;
        partialTailLine = lineNumber;
        continue;
      }
      failClosed(`${resolvedSource}:${lineNumber}: malformed JSON (${redact(String(error))})`);
    }
    if (!header) {
      header = validateGenericEventHeader(value);
      continue;
    }
    const record = lineRecord(value);
    const batchBytes = Buffer.byteLength(JSON.stringify(value));
    if (record.isBatch && batchBytes > GENERIC_EVENT_MAX_BATCH_BYTES)
      failClosed(`${resolvedSource}:${lineNumber}: batch exceeds size limit`);
    if (record.isBatch) batchCount++;
    validateExternalBatchOrigin(record.origin, header, resolvedSource, recipeForHeader(header));
    if (record.events.length > GENERIC_EVENT_MAX_EVENTS - rawEvents.length)
      failClosed(`${resolvedSource}: event count exceeds bound`);
    if (record.losses.length > GENERIC_EVENT_MAX_SEMANTIC_LOSSES - rawLosses.length)
      failClosed(`${resolvedSource}: semantic-loss count exceeds bound`);
    for (const [index, raw] of record.events.entries())
      rawEvents.push({ raw, line: lineNumber, ...(record.isBatch ? { record: index } : {}) });
    for (const [index, rawLoss] of record.losses.entries()) {
      const loss = validateSemanticLoss(rawLoss, `${resolvedSource}:${lineNumber} semanticLoss`);
      if (loss.provider !== header.provider || loss.harness !== header.harness)
        failClosed(
          `${resolvedSource}:${lineNumber}: semantic loss provenance conflicts with header`,
        );
      rawLosses.push({ value: loss, line: lineNumber, record: record.events.length + index });
    }
  }
  if (!header) failClosed(`${resolvedSource}: missing generic event header`);
  if (rawEvents.length > GENERIC_EVENT_MAX_EVENTS)
    failClosed(`${resolvedSource}: event count exceeds bound`);
  const recipe = recipeForHeader(header);
  const events: AgentEventEnvelope[] = [];
  const losses: SemanticLossEntry[] = [];
  if (partialTailLine !== undefined)
    losses.push(
      makeSemanticLoss({
        code: "partial-live-tail",
        reason: "The final JSONL record was incomplete and was omitted from this preview/import.",
        provider: header.provider,
        harness: header.harness,
        sourceItemKind: "jsonl-tail",
        sourceLocator: `${resolvedSource}:${partialTailLine}`,
        count: 1,
        adapterRecipe: recipe,
        capturePolicyVersion: header.capturePolicyVersion,
        recoverable: true,
        sourcePath: resolvedSource,
        recordPosition: { line: partialTailLine },
      }),
    );
  const priorIds = new Map<string, string>();
  const seenOriginalIds = new Set<string>();
  const kinds: Record<string, number> = {};
  for (const [{ raw, line, record }, sequence] of rawEvents.map(
    (value, index) => [value, index] as const,
  )) {
    const originalId = typeof raw.eventId === "string" ? raw.eventId : "";
    if (!originalId || seenOriginalIds.has(originalId))
      failClosed(`${resolvedSource}:${line}: duplicate or missing event ID`);
    seenOriginalIds.add(originalId);
    const normalized = normalizeEvent(
      raw,
      header,
      resolvedSource,
      { line, ...(record === undefined ? {} : { record }) },
      recipe,
      sequence,
      priorIds,
    );
    events.push(normalized.event);
    priorIds.set(normalized.originalId, normalized.event.eventId);
    const kind = normalized.event.kind;
    kinds[kind] = (kinds[kind] ?? 0) + 1;
    if (normalized.loss) losses.push(normalized.loss);
  }
  for (const { value: loss, line, record } of rawLosses) {
    losses.push(
      makeSemanticLoss({
        ...loss,
        sourcePath: resolvedSource,
        recordPosition: { line, record },
        adapterRecipe: recipe,
        capturePolicyVersion: header.capturePolicyVersion,
      }),
    );
  }
  const source = {
    provider: header.provider,
    harness: header.harness,
    sourceKind: header.sourceKind,
    sourcePath: resolvedSource,
    adapterRecipe: recipe,
    capturePolicyVersion: header.capturePolicyVersion,
  };
  const batch: EventBatch = {
    schemaVersion: 1,
    origin: makeObservedBatchOrigin(source, redactedHash({ header, events, losses })),
    events,
    semanticLoss: losses,
    partialTail,
    sourceItemCount: rawEvents.length + rawLosses.length + (partialTail ? 1 : 0),
  };
  return {
    source: resolvedSource,
    sourceBytes,
    sourceModifiedAt,
    sourceContentHash: sha256(text),
    header,
    batch,
    lines: lineCount,
    batches: batchCount,
    kinds,
  };
}

export async function readGenericEventFile(sourcePath: string): Promise<GenericStream> {
  const source = resolve(sourcePath);
  const content = await readBoundedFile(
    source,
    GENERIC_EVENT_MAX_FILE_BYTES,
    `${source} (generic event source)`,
  );
  if (!content.ok) boundedFailure(content.error);
  return parseGenericEventText(
    content.value.text,
    source,
    content.value.bytes,
    new Date(content.value.mtimeMs).toISOString(),
  );
}

async function atomicWrite(path: string, value: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, value, { mode: 0o600 });
  await rename(temporary, path);
  await chmod(path, 0o600);
}

async function loadManifest(root: string): Promise<CorpusManifest> {
  const path = join(root, "corpus", "manifest.json");
  let info;
  try {
    info = await lstat(path);
  } catch (error: unknown) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")
      return { version: 1, sources: {} };
    failClosed(
      `cannot read generic-event corpus manifest ${path}: ${redact(
        error instanceof Error ? error.message : String(error),
      )}`,
      error,
    );
  }
  if (!info.isFile()) failClosed(`${path}: generic-event corpus manifest is not a regular file`);
  const contentResult = await readBoundedFile(
    path,
    EXPORT_MAX_MANIFEST_BYTES,
    `${path} (generic-event corpus manifest)`,
    root,
  );
  if (!contentResult.ok) return boundedFailure(contentResult.error);
  try {
    const value = JSON.parse(contentResult.value.text) as CorpusManifest;
    if (value.version !== 1 || !value.sources) failClosed("unsupported corpus manifest");
    return value;
  } catch (error: unknown) {
    if (error instanceof GenericEventImportError) throw error;
    failClosed(
      `cannot parse generic-event corpus manifest ${path}: ${redact(
        error instanceof Error ? error.message : String(error),
      )}`,
      error,
    );
  }
}

async function readPriorConversation(
  root: string,
  contentHash: string,
): Promise<Conversation | null> {
  const path = join(root, "corpus", "objects", contentHash.slice(0, 2), `${contentHash}.json`);
  let info;
  try {
    info = await lstat(path);
  } catch (error: unknown) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")
      return null;
    failClosed(
      `cannot read generic-event prior corpus object ${path}: ${redact(
        error instanceof Error ? error.message : String(error),
      )}`,
      error,
    );
  }
  if (!info.isFile())
    failClosed(`${path}: generic-event prior corpus object is not a regular file`);
  const contentResult = await readBoundedFile(
    path,
    EXPORT_MAX_CORPUS_OBJECT_BYTES,
    `${path} (generic-event prior corpus object)`,
    root,
  );
  if (!contentResult.ok) return boundedFailure(contentResult.error);
  try {
    return JSON.parse(contentResult.value.text) as Conversation;
  } catch (error: unknown) {
    failClosed(
      `cannot parse generic-event prior corpus object ${path}: ${redact(
        error instanceof Error ? error.message : String(error),
      )}`,
      error,
    );
  }
}

async function classify(
  root: string,
  manifest: CorpusManifest,
  conversation: Conversation,
  domain: string,
): Promise<"new" | "changed" | "reclassified" | "unchanged"> {
  const previous = manifest.sources[conversation.sourcePath];
  if (!previous) return "new";
  if (previous.contentHash === conversation.contentHash) return "unchanged";
  if (!previous.contentHash) return "changed";
  try {
    const oldConversation = await readPriorConversation(root, previous.contentHash);
    if (!oldConversation) return "changed";
    return normalizeConversationDomain(oldConversation.domain ?? "general") !== domain
      ? "reclassified"
      : "changed";
  } catch (error) {
    if (error instanceof GenericEventImportError) throw error;
    return "changed";
  }
}

function lossCounts(batch: EventBatch): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const loss of batch.semanticLoss) counts[loss.code] = (counts[loss.code] ?? 0) + loss.count;
  return Object.fromEntries(
    Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)),
  );
}

export async function previewGenericEvents(
  sourcePath: string,
  root: string,
  options: Pick<GenericEventImportOptions, "domain"> = {},
): Promise<GenericEventPreviewSummary> {
  const stream = await readGenericEventFile(sourcePath);
  const domain = normalizeConversationDomain(options.domain ?? stream.header.domain);
  const manifest = await loadManifest(root);
  const projected = canonicalizeConversation({ ...projectConversation(stream.batch), domain });
  const classification = await classify(root, manifest, projected, domain);
  const classifications = { new: 0, changed: 0, reclassified: 0, unchanged: 0 };
  classifications[classification]++;
  const losses = lossCounts(stream.batch);
  const proposalId = sha256(
    stableStringify({
      schema: "chatlog/generic-event-import-preview-v1",
      source: stream.source,
      sourceContentHash: stream.sourceContentHash,
      producer: stream.header.producer,
      domain,
      batchHash: sha256(stableStringify(stream.batch)),
    }),
  );
  const receiptId = sha256(stableStringify({ proposalId, classifications, losses }));
  return {
    schema: "chatlog/generic-event-import-preview-v1",
    advisory: true,
    ready: true,
    source: stream.source,
    sourceBytes: stream.sourceBytes,
    sourceModifiedAt: stream.sourceModifiedAt,
    sourceContentHash: stream.sourceContentHash,
    producer: stream.header.producer,
    provider: stream.header.provider,
    harness: stream.header.harness,
    domain,
    headerDomain: stream.header.domain,
    receiptId,
    proposalId,
    lines: stream.lines,
    events: stream.batch.events.length,
    batches: stream.batches,
    partialTail: stream.batch.partialTail,
    ...classifications,
    wouldImport: classifications.new + classifications.changed + classifications.reclassified,
    kinds: stream.kinds,
    losses,
    domains: [domain],
  };
}

export async function importGenericEvents(
  sourcePath: string,
  root: string,
  options: GenericEventImportOptions = {},
): Promise<GenericEventImportSummary> {
  return withIngestLock(root, async () => {
    const stream = await readGenericEventFile(sourcePath);
    const domain = normalizeConversationDomain(options.domain ?? stream.header.domain);
    const manifestPath = join(root, "corpus", "manifest.json");
    const manifest = await loadManifest(root);
    const db = openAnalysis(join(root, "analysis", "chatlog.sqlite"));
    try {
      await reconcileSourceAuthority(root, db, manifest.sources);
      const batchHash = await persistEventBatch(root, stream.batch);
      const projected = projectConversation(stream.batch);
      const conversation = canonicalizeConversation({ ...projected, domain });
      const sourceReceipt = buildSourceReceipt({
        batch: stream.batch,
        batchHash,
        conversationProjectionHash: conversation.contentHash,
      });
      await persistSourceReceipt(root, sourceReceipt);
      const previous = manifest.sources[conversation.sourcePath];
      let imported = 0;
      let skipped = 0;
      if (
        previous?.contentHash === conversation.contentHash &&
        previous.eventBatchHash === batchHash &&
        previous.conversationProjectionHash === conversation.contentHash &&
        previous.receiptHash === sourceReceipt.receiptHash
      )
        skipped++;
      else {
        const objectPath = join(
          root,
          "corpus",
          "objects",
          conversation.contentHash.slice(0, 2),
          `${conversation.contentHash}.json`,
        );
        if (!(await Bun.file(objectPath).exists()))
          await atomicWrite(objectPath, JSON.stringify(conversation) + "\n");
        indexEventBatch(db, stream.batch, batchHash, conversation.contentHash);
        indexConversation(
          db,
          conversation,
          Date.parse(stream.sourceModifiedAt),
          stream.sourceBytes,
        );
        manifest.sources[conversation.sourcePath] = {
          contentHash: conversation.contentHash,
          eventBatchHash: batchHash,
          conversationProjectionHash: conversation.contentHash,
          receiptHash: sourceReceipt.receiptHash,
          size: stream.sourceBytes,
          mtimeMs: Date.parse(stream.sourceModifiedAt),
        };
        imported++;
      }
      await atomicWrite(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
      await reconcileSourceAuthority(root, db, manifest.sources);
      let derived: DeriveSummary | undefined;
      let refinery: RefinerySummary | undefined;
      if (options.derive) {
        derived = await deriveCorpus(root);
        refinery = await refineCorpus(root);
      }
      return {
        source: stream.source,
        domain,
        producer: stream.header.producer,
        provider: stream.header.provider,
        harness: stream.header.harness,
        events: stream.batch.events.length,
        batches: stream.batches,
        partialTail: stream.batch.partialTail,
        imported,
        skipped,
        receipts: [sourceReceipt],
        receipt: sourceReceipt,
        ...(derived ? { derived } : {}),
        ...(refinery ? { refinery } : {}),
      };
    } finally {
      db.close();
    }
  });
}

export const previewGenericEventImport = previewGenericEvents;
export const importGenericEventFile = importGenericEvents;
