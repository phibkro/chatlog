import { type Dir } from "node:fs";
import { opendir, stat } from "node:fs/promises";
import { join } from "node:path";
import { Data, Effect } from "effect";
import {
  validateBoundedRecord as validateRecordWithin,
  type BoundedRecordLimits,
} from "../bounded-input";
import { JSONL_MAX_FILE_BYTES, JSONL_MAX_LINE_BYTES, JSONL_MAX_RECORDS } from "../jsonl";
import {
  capture,
  EVENT_ADAPTER_RECIPE,
  EVENT_CAPTURE_POLICY_VERSION,
  makeEvent,
  makeObservedBatchOrigin,
  makeObservedSource,
  makeSemanticLoss,
  redactedHash,
  stableStringify,
  type AgentEventEnvelope,
  type AgentEventKind,
  type AgentEventPayload,
  type EventBatch,
  type EventRelations,
  type EventScope,
  type EventActor,
  type CaptureDisposition,
  type SemanticLossCode,
  type SemanticLossEntry,
} from "../events";
import { redact } from "../redact";
import type { SourceFile, TokenUsage, Turn } from "../types";

export { projectOf } from "../project-identity";

export const NATIVE_JSONL_MAX_DIRECTORY_DEPTH = 32;
export const NATIVE_JSONL_MAX_DIRECTORY_ENTRIES = 100_000;
export const NATIVE_JSONL_MAX_ACCEPTED_FILES = 4_096;

export async function discoverJsonl(
  root: string,
  accept: (path: string) => boolean = () => true,
): Promise<SourceFile[]> {
  const found: SourceFile[] = [];
  let visitedEntries = 0;
  let acceptedFiles = 0;
  const errorMessage = (error: unknown): string =>
    error instanceof Error ? error.message : String(error);
  const errorCode = (error: unknown): string | undefined =>
    error && typeof error === "object" && "code" in error && typeof error.code === "string"
      ? error.code
      : undefined;
  const directoryError = (path: string, error: unknown): AdaptError =>
    new AdaptError({
      path,
      line: 0,
      reason: `could not read adapter source directory: ${errorMessage(error)}`,
      ...(errorCode(error) ? { code: errorCode(error) } : {}),
    });
  const walk = Effect.fnUntraced(function* (
    dir: string,
    depth: number,
    allowMissing = false,
  ): Effect.fn.Return<void, AdaptError> {
    const directory = yield* Effect.tryPromise({
      try: () => opendir(dir),
      catch: (error) => directoryError(dir, error),
    }).pipe(
      Effect.catch((error) =>
        allowMissing && error.code === "ENOENT"
          ? Effect.succeed<Dir | undefined>(undefined)
          : Effect.fail(error),
      ),
    );
    if (!directory) return;
    try {
      while (true) {
        const entry = yield* Effect.tryPromise({
          try: () => directory.read(),
          catch: (error) => directoryError(dir, error),
        }).pipe(
          Effect.catch((error) =>
            allowMissing && error.code === "ENOENT" ? Effect.succeed(null) : Effect.fail(error),
          ),
        );
        if (!entry) break;
        visitedEntries += 1;
        if (visitedEntries > NATIVE_JSONL_MAX_DIRECTORY_ENTRIES)
          return yield* Effect.fail(
            new AdaptError({
              path: dir,
              line: 0,
              reason: `adapter source directory exceeds the ${NATIVE_JSONL_MAX_DIRECTORY_ENTRIES}-entry limit`,
              code: "directory-entry-limit",
            }),
          );
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (depth >= NATIVE_JSONL_MAX_DIRECTORY_DEPTH)
            return yield* Effect.fail(
              new AdaptError({
                path,
                line: 0,
                reason: `adapter source directory exceeds the ${NATIVE_JSONL_MAX_DIRECTORY_DEPTH}-directory depth limit`,
                code: "directory-depth-limit",
              }),
            );
          yield* walk(path, depth + 1);
        } else if (entry.isFile() && entry.name.endsWith(".jsonl") && accept(path)) {
          if (acceptedFiles >= NATIVE_JSONL_MAX_ACCEPTED_FILES)
            return yield* Effect.fail(
              new AdaptError({
                path,
                line: 0,
                reason: `adapter source exceeds the ${NATIVE_JSONL_MAX_ACCEPTED_FILES}-accepted-file limit`,
                code: "accepted-file-limit",
              }),
            );
          acceptedFiles += 1;
          const info = yield* Effect.tryPromise({
            try: () => stat(path),
            catch: (error) =>
              new AdaptError({
                path,
                line: 0,
                reason: `could not stat adapter source: ${errorMessage(error)}`,
                ...(errorCode(error) ? { code: errorCode(error) } : {}),
              }),
          });
          found.push({ path, size: info.size, mtimeMs: info.mtimeMs });
        }
      }
    } finally {
      yield* Effect.promise(async () => {
        try {
          await directory.close();
        } catch {
          // A runtime may already close the handle when read() reaches EOF.
        }
      });
    }
  });
  return Effect.runPromise(
    Effect.gen(function* () {
      yield* walk(root, 0, true);
      return found.toSorted((a, b) => a.path.localeCompare(b.path));
    }),
  );
}
export class AdaptError extends Data.TaggedError("AdaptError")<{
  readonly path: string;
  readonly line: number;
  readonly reason: string;
  readonly itemType?: string;
  readonly code?: string;
}> {
  override get message(): string {
    return `${this.path}:${this.line}: ${this.reason}`;
  }
}
export const NATIVE_JSONL_RECORD_LIMITS: BoundedRecordLimits = {
  maxDepth: 32,
  maxKeys: 8_192,
  maxArrayItems: 4_096,
  maxStringLength: 64 * 1024,
  maxBytes: JSONL_MAX_FILE_BYTES,
};

export const NATIVE_EVENT_MAX_EVENTS = JSONL_MAX_RECORDS;
export const NATIVE_EVENT_MAX_SEMANTIC_LOSSES = JSONL_MAX_RECORDS;
export const NATIVE_EVENT_MAX_RECORD_HASHES = JSONL_MAX_RECORDS;
export const NATIVE_EVENT_MAX_BATCH_BYTES = 64 * 1024 * 1024;
const NATIVE_EVENT_RESERVED_LOSS_BYTES = 32 * 1024;
const NATIVE_EVENT_RESERVED_LOSS_SLOTS = 2;

export class EventBatchLimitError extends Error {
  readonly code = "event-batch-limit" as const;

  constructor(
    readonly path: string,
    readonly line: number,
    readonly resource: string,
    readonly limit: number,
    readonly observed: number,
  ) {
    super(`${path}:${line}: ${resource} exceeds ${limit}`);
    this.name = "EventBatchLimitError";
  }
}

export function admitBoundedRecord(
  record: unknown,
  path: string,
  line: number,
): Effect.Effect<boolean, AdaptError> {
  const validation = validateRecordWithin(
    record,
    "native JSONL record",
    NATIVE_JSONL_RECORD_LIMITS,
  );
  if (validation.ok) return Effect.succeed(true);
  if (validation.violation === "string-value-length") return Effect.succeed(false);
  return Effect.fail(
    new AdaptError({
      path,
      line,
      reason: validation.error,
      code: "record-limit",
    }),
  );
}

export function assertObject(
  record: unknown,
  path: string,
  line: number,
): Effect.Effect<void, AdaptError> {
  if (
    record &&
    typeof record === "object" &&
    !Array.isArray(record) &&
    "type" in record &&
    typeof record.type === "string"
  )
    return Effect.void;
  return Effect.fail(
    new AdaptError({
      path,
      line,
      reason: "unknown record shape (object with string type required)",
    }),
  );
}

export const contentText = Effect.fnUntraced(function* (
  content: unknown,
  path: string,
  line: number,
  allowed: Set<string>,
): Effect.fn.Return<string, AdaptError> {
  if (typeof content === "string") return redact(content);
  if (content == null) return "";
  if (!Array.isArray(content))
    return yield* Effect.fail(new AdaptError({ path, line, reason: "unknown content shape" }));
  const parts: string[] = [];
  for (const block of content) {
    if (typeof block === "string") {
      parts.push(redact(block));
      continue;
    }
    if (
      !block ||
      typeof block !== "object" ||
      !("type" in block) ||
      typeof block.type !== "string" ||
      !allowed.has(block.type)
    ) {
      return yield* Effect.fail(
        new AdaptError({
          path,
          line,
          reason: `unknown content block type ${JSON.stringify(
            block && typeof block === "object" && "type" in block ? block.type : undefined,
          )}`,
          itemType:
            block && typeof block === "object" && "type" in block && typeof block.type === "string"
              ? block.type
              : undefined,
        }),
      );
    }
    const value = block as Record<string, unknown>;
    if (typeof value.text === "string") parts.push(redact(value.text));
    else if (typeof value.content === "string") parts.push(redact(value.content));
    else if (Array.isArray(value.content))
      parts.push(yield* contentText(value.content, path, line, allowed));
  }
  return parts.filter(Boolean).join("\n");
});

export function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  const result: TokenUsage = { ...a };
  for (const key of [
    "input",
    "output",
    "cachedInput",
    "cacheWrite",
    "reasoning",
    "total",
  ] as const) {
    if (b[key] != null) result[key] = (result[key] ?? 0) + b[key]!;
  }
  return result;
}

export function finishTimes(turns: Turn[], fallback: string): [string, string] {
  const times = turns
    .map((t) => t.at)
    .filter((x): x is string => Boolean(x))
    .toSorted();
  return [times[0] ?? fallback, times.at(-1) ?? fallback];
}

export interface EventBuilderOptions {
  provider: string;
  harness: string;
  sourceKind: string;
  source: SourceFile;
  sessionId: string;
  project?: string;
  cwd?: string;
}

export class EventBatchBuilder {
  readonly events: AgentEventEnvelope[] = [];
  readonly semanticLoss: SemanticLossEntry[] = [];
  private readonly recordHashes = new Map<number, string>();
  private estimatedBytes = 0;
  private sessionId: string;
  private scope: Pick<EventScope, "project" | "cwd"> = {};

  constructor(private readonly options: EventBuilderOptions) {
    this.sessionId = options.sessionId;
    this.setScope({ project: options.project, cwd: options.cwd });
  }

  setSessionId(value: string): void {
    if (value) this.sessionId = value;
  }

  setScope(scope: { project?: string; cwd?: string }): void {
    if (scope.project) this.scope.project = scope.project;
    if (scope.cwd) this.scope.cwd = scope.cwd;
  }

  add(
    kind: AgentEventKind,
    record: unknown,
    line: number,
    payload: AgentEventPayload,
    options: {
      nativeItemId?: string;
      occurredAt?: string;
      relations?: EventRelations;
      actor?: EventActor;
      scope?: EventScope;
      capture?: CaptureDisposition;
    } = {},
  ): AgentEventEnvelope {
    const isNewRecord = !this.recordHashes.has(line);
    if (isNewRecord && this.recordHashes.size >= NATIVE_EVENT_MAX_RECORD_HASHES)
      throw new EventBatchLimitError(
        this.options.source.path,
        line,
        "record hash count",
        NATIVE_EVENT_MAX_RECORD_HASHES,
        this.recordHashes.size + 1,
      );
    const nativeItemId = options.nativeItemId ?? `${line}:${this.events.length}`;
    const source = makeObservedSource(
      {
        provider: this.options.provider,
        harness: this.options.harness,
        sourceKind: this.options.sourceKind,
        nativeSessionId: this.sessionId,
        nativeItemId,
        sourcePath: this.options.source.path,
        recordPosition: { line },
        adapterRecipe: EVENT_ADAPTER_RECIPE,
        capturePolicyVersion: EVENT_CAPTURE_POLICY_VERSION,
      },
      record,
    );
    const optionScope = options.scope ?? {};
    const event = makeEvent({
      kind,
      sequence: this.events.length,
      ...(options.occurredAt ? { occurredAt: options.occurredAt } : {}),
      actor: options.actor ?? { kind: "provider", name: this.options.harness },
      scope: {
        sessionId: this.sessionId,
        ...(this.scope.project ? { project: this.scope.project } : {}),
        ...(this.scope.cwd ? { cwd: this.scope.cwd } : {}),
        ...optionScope,
        ...(optionScope.project ? {} : this.scope.project ? { project: this.scope.project } : {}),
        ...(optionScope.cwd ? {} : this.scope.cwd ? { cwd: this.scope.cwd } : {}),
      },
      origin: { kind: "observed", source },
      relations: options.relations ?? {},
      payload,
      capture: options.capture ?? capture("normalized"),
    });
    const eventBytes = Buffer.byteLength(stableStringify(event) ?? "");
    if (this.events.length >= NATIVE_EVENT_MAX_EVENTS)
      throw new EventBatchLimitError(
        this.options.source.path,
        line,
        "event count",
        NATIVE_EVENT_MAX_EVENTS,
        this.events.length + 1,
      );
    if (
      eventBytes >
      NATIVE_EVENT_MAX_BATCH_BYTES - NATIVE_EVENT_RESERVED_LOSS_BYTES - this.estimatedBytes
    )
      throw new EventBatchLimitError(
        this.options.source.path,
        line,
        "estimated batch bytes",
        NATIVE_EVENT_MAX_BATCH_BYTES,
        this.estimatedBytes + eventBytes,
      );
    if (isNewRecord) this.recordHashes.set(line, redactedHash(record));
    this.estimatedBytes += eventBytes;
    this.events.push(event);
    return event;
  }

  omitOversizedRecord(record: unknown, line: number): void {
    const value = objectRecord(record);
    const itemType = typeof value.type === "string" && value.type ? value.type : "unknown";
    this.loss(
      "capture-policy-omission",
      "native JSONL record omitted because a text field exceeds the capture limit",
      line,
      `oversized:${itemType}:${line}`,
      {
        itemType,
        violation: "string-value-length",
        limit: NATIVE_JSONL_RECORD_LIMITS.maxStringLength,
      },
    );
  }

  omitOversizedLine(line: number): void {
    this.loss(
      "capture-policy-omission",
      "native JSONL record omitted because its encoded line exceeds the capture limit",
      line,
      `oversized-line:${line}`,
      {
        itemType: "unknown",
        violation: "line-byte-length",
        limit: JSONL_MAX_LINE_BYTES,
      },
    );
  }

  private appendLoss(loss: SemanticLossEntry, reserved = false): void {
    const slotLimit = reserved
      ? NATIVE_EVENT_MAX_SEMANTIC_LOSSES
      : NATIVE_EVENT_MAX_SEMANTIC_LOSSES - NATIVE_EVENT_RESERVED_LOSS_SLOTS;
    if (this.semanticLoss.length >= slotLimit)
      throw new EventBatchLimitError(
        this.options.source.path,
        loss.recordPosition?.line ?? 0,
        "semantic-loss count",
        slotLimit,
        this.semanticLoss.length + 1,
      );
    const byteLimit = reserved
      ? NATIVE_EVENT_MAX_BATCH_BYTES
      : NATIVE_EVENT_MAX_BATCH_BYTES - NATIVE_EVENT_RESERVED_LOSS_BYTES;
    const lossBytes = Buffer.byteLength(stableStringify(loss) ?? "");
    if (lossBytes > byteLimit - this.estimatedBytes)
      throw new EventBatchLimitError(
        this.options.source.path,
        loss.recordPosition?.line ?? 0,
        "estimated batch bytes",
        byteLimit,
        this.estimatedBytes + lossBytes,
      );
    this.estimatedBytes += lossBytes;
    this.semanticLoss.push(loss);
  }

  private makeLoss(
    code: SemanticLossCode,
    reason: string,
    line: number | undefined,
    nativeItemId: string | undefined,
    details: Record<string, unknown> | undefined,
    count: number,
  ): SemanticLossEntry {
    const sourceItemKind =
      typeof details?.itemType === "string"
        ? details.itemType
        : typeof details?.blockType === "string"
          ? details.blockType
          : "provider-item";
    const sourceLocator =
      nativeItemId || `${this.options.source.path}:${line === undefined ? "batch" : line}`;
    return makeSemanticLoss({
      code,
      reason,
      provider: this.options.provider,
      harness: this.options.harness,
      sourceItemKind,
      sourceLocator,
      count,
      adapterRecipe: EVENT_ADAPTER_RECIPE,
      capturePolicyVersion: EVENT_CAPTURE_POLICY_VERSION,
      recoverable: code !== "capture-policy-omission",
      sourcePath: this.options.source.path,
      ...(line !== undefined ? { recordPosition: { line } } : {}),
      ...(nativeItemId ? { nativeItemId } : {}),
      ...(details ? { details } : {}),
    });
  }

  loss(
    code: SemanticLossCode,
    reason: string,
    line?: number,
    nativeItemId?: string,
    details?: Record<string, unknown>,
  ): void {
    this.appendLoss(this.makeLoss(code, reason, line, nativeItemId, details, 1));
  }

  private omitCapacityTail(line: number, count: number): void {
    this.appendLoss(
      this.makeLoss(
        "capture-policy-omission",
        "remaining native records omitted because the bounded event batch reached capacity",
        line,
        `batch-capacity-tail:${line}`,
        {
          itemType: "provider-item",
          violation: "event-batch-capacity",
          limit: NATIVE_EVENT_MAX_BATCH_BYTES,
          omittedSourceItems: count,
        },
        count,
      ),
      true,
    );
  }

  finish(
    partialTail: boolean,
    sourceItemCount: number,
    capacityOmission?: { line: number; count: number },
  ): EventBatch {
    if (partialTail && !this.semanticLoss.some((loss) => loss.code === "partial-live-tail"))
      this.loss(
        "partial-live-tail",
        "JSONL source ended with an incomplete final item",
        undefined,
        "partial-tail",
        { itemType: "partial-tail" },
      );
    if (capacityOmission && capacityOmission.count > 0)
      this.omitCapacityTail(capacityOmission.line, capacityOmission.count);
    return {
      schemaVersion: 1,
      origin: makeObservedBatchOrigin(
        {
          provider: this.options.provider,
          harness: this.options.harness,
          sourceKind: this.options.sourceKind,
          nativeSessionId: this.sessionId,
          sourcePath: this.options.source.path,
          adapterRecipe: EVENT_ADAPTER_RECIPE,
          capturePolicyVersion: EVENT_CAPTURE_POLICY_VERSION,
        },
        redactedHash([...this.recordHashes.values()]),
      ),
      events: this.events,
      semanticLoss: this.semanticLoss,
      partialTail,
      sourceItemCount,
    };
  }
}

export function objectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function redactedJson(value: unknown): string {
  try {
    return redact(JSON.stringify(value ?? {}));
  } catch {
    return "[unserializable provider value]";
  }
}

export function timestamp(value: unknown): string | undefined {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : undefined;
}
