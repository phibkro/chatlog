import type { Dirent } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { Data, Effect } from "effect";
import {
  capture,
  EVENT_ADAPTER_RECIPE,
  EVENT_CAPTURE_POLICY_VERSION,
  makeEvent,
  makeObservedBatchOrigin,
  makeObservedSource,
  makeSemanticLoss,
  redactedHash,
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

export async function discoverJsonl(
  root: string,
  accept: (path: string) => boolean = () => true,
): Promise<SourceFile[]> {
  const found: SourceFile[] = [];
  async function walk(dir: string, allowMissing = false): Promise<void> {
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      if (
        allowMissing &&
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "ENOENT"
      )
        return;
      throw error;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile() && entry.name.endsWith(".jsonl") && accept(path)) {
        const s = await stat(path);
        found.push({ path, size: s.size, mtimeMs: s.mtimeMs });
      }
    }
  }
  await walk(root, true);
  return found.toSorted((a, b) => a.path.localeCompare(b.path));
}

export class AdaptError extends Data.TaggedError("AdaptError")<{
  readonly path: string;
  readonly line: number;
  readonly reason: string;
  readonly itemType?: string;
}> {
  override get message(): string {
    return `${this.path}:${this.line}: ${this.reason}`;
  }
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
    if (!this.recordHashes.has(line)) this.recordHashes.set(line, redactedHash(record));
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
    this.events.push(event);
    return event;
  }

  loss(
    code: SemanticLossCode,
    reason: string,
    line?: number,
    nativeItemId?: string,
    details?: Record<string, unknown>,
  ): void {
    const sourceItemKind =
      typeof details?.itemType === "string"
        ? details.itemType
        : typeof details?.blockType === "string"
          ? details.blockType
          : "provider-item";
    const sourceLocator =
      nativeItemId || `${this.options.source.path}:${line === undefined ? "batch" : line}`;
    this.semanticLoss.push(
      makeSemanticLoss({
        code,
        reason,
        provider: this.options.provider,
        harness: this.options.harness,
        sourceItemKind,
        sourceLocator,
        count: 1,
        adapterRecipe: EVENT_ADAPTER_RECIPE,
        capturePolicyVersion: EVENT_CAPTURE_POLICY_VERSION,
        recoverable: code !== "capture-policy-omission",
        sourcePath: this.options.source.path,
        ...(line !== undefined ? { recordPosition: { line } } : {}),
        ...(nativeItemId ? { nativeItemId } : {}),
        ...(details ? { details } : {}),
      }),
    );
  }
  finish(partialTail: boolean, sourceItemCount: number): EventBatch {
    if (partialTail && !this.semanticLoss.some((loss) => loss.code === "partial-live-tail"))
      this.loss(
        "partial-live-tail",
        "JSONL source ended with an incomplete final item",
        undefined,
        "partial-tail",
        { itemType: "partial-tail" },
      );
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
