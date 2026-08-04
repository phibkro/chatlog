import {
  SEMANTIC_LOSS_CODE_SET,
  type AgentEventEnvelope,
  type EventBatch,
  type SemanticLossCode,
  type SemanticLossEntry,
} from "./events";
export class AdapterConformanceError extends Error {
  readonly code = "adapter-conformance-invalid";
}

function failClosed(message: string, cause?: unknown): never {
  throw new AdapterConformanceError(message, cause === undefined ? undefined : { cause });
}

export const UNKNOWN_NOMINATION_LIMIT = 256 as const;
export const UNKNOWN_NOMINATION_ITEM_KIND_LIMIT = 128 as const;

export interface EventDispositionCounts {
  normalized: number;
  opaque: number;
  redacted: number;
  omitted: number;
}

export interface SourceItemAccounting {
  sourceItems: number;
  eventBackedItems: number;
  lossOnlyItems: number;
  unaccountedItems: number;
  opaqueItems: number;
  redactedItems: number;
  policyOmissions: number;
  dispositions: EventDispositionCounts;
}

export interface LossCounts {
  [code: string]: number;
}

export interface UnknownShapeNomination {
  provider: string;
  harness: string;
  sourceKind: string;
  nativeItemKind: string;
  occurrences: number;
  distinctSessions: number;
  firstSeen?: string;
  lastSeen?: string;
}

function sourcePositionKey(source: {
  sourcePath: string;
  recordPosition: { line?: number; record?: number };
}): string {
  const position = source.recordPosition;
  return `${source.sourcePath}\u0000${position.line ?? ""}:${position.record ?? ""}`;
}

function eventSourcePosition(event: AgentEventEnvelope): string | undefined {
  if (event.origin.kind !== "observed") return undefined;
  return sourcePositionKey(event.origin.source);
}

function lossSourcePosition(loss: SemanticLossEntry): string {
  if (loss.sourcePath && loss.recordPosition)
    return sourcePositionKey({ sourcePath: loss.sourcePath, recordPosition: loss.recordPosition });
  return `loss\u0000${loss.provider}\u0000${loss.harness}\u0000${loss.sourceItemKind}\u0000${loss.sourceLocator}`;
}

function eventDisposition(events: readonly AgentEventEnvelope[]): keyof EventDispositionCounts {
  if (events.some((event) => event.capture.disposition === "opaque")) return "opaque";
  if (events.some((event) => event.capture.disposition === "redacted")) return "redacted";
  if (events.some((event) => event.capture.disposition === "omitted")) return "omitted";
  return "normalized";
}

export function sourceItemAccounting(batch: EventBatch): SourceItemAccounting {
  const byPosition = new Map<string, AgentEventEnvelope[]>();
  for (const event of batch.events) {
    const position = eventSourcePosition(event);
    if (!position) continue;
    const current = byPosition.get(position);
    if (current) current.push(event);
    else byPosition.set(position, [event]);
  }
  const lossOnly = new Map<string, number>();
  for (const loss of batch.semanticLoss) {
    const position = lossSourcePosition(loss);
    if (!byPosition.has(position))
      lossOnly.set(position, Math.max(lossOnly.get(position) ?? 0, loss.count));
  }
  const dispositions: EventDispositionCounts = {
    normalized: 0,
    opaque: 0,
    redacted: 0,
    omitted: 0,
  };
  for (const events of byPosition.values()) dispositions[eventDisposition(events)]++;
  const eventBackedItems = byPosition.size;
  const lossOnlyItems = [...lossOnly.values()].reduce((total, count) => total + count, 0);
  const sourceItems = batch.sourceItemCount ?? eventBackedItems + lossOnlyItems;
  const unaccountedItems = sourceItems - eventBackedItems - lossOnlyItems;
  return {
    sourceItems,
    eventBackedItems,
    lossOnlyItems,
    unaccountedItems,
    opaqueItems: dispositions.opaque,
    redactedItems: dispositions.redacted,
    policyOmissions: lossOnlyItems + dispositions.omitted,
    dispositions,
  };
}

export function semanticLossCounts(losses: readonly SemanticLossEntry[]): LossCounts {
  const counts: LossCounts = {};
  for (const loss of losses) counts[loss.code] = (counts[loss.code] ?? 0) + loss.count;
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
}

function boundedItemKind(value: unknown): string {
  if (typeof value !== "string" || !value) return "unknown";
  return value.length > UNKNOWN_NOMINATION_ITEM_KIND_LIMIT
    ? value.slice(0, UNKNOWN_NOMINATION_ITEM_KIND_LIMIT)
    : value;
}

export function unknownShapeNominations(
  batches: readonly EventBatch[],
  limit = UNKNOWN_NOMINATION_LIMIT,
): UnknownShapeNomination[] {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > UNKNOWN_NOMINATION_LIMIT)
    failClosed(`unknown nomination limit must be between 1 and ${UNKNOWN_NOMINATION_LIMIT}`);
  const grouped = new Map<string, UnknownShapeNomination & { sessions: Set<string> }>();
  for (const batch of batches) {
    for (const event of batch.events) {
      if (event.kind !== "provider.opaque" || event.origin.kind !== "observed") continue;
      const nativeItemKind =
        typeof event.payload.nativeItemKind === "string" && event.payload.nativeItemKind
          ? boundedItemKind(event.payload.nativeItemKind)
          : undefined;
      if (!nativeItemKind) continue;
      const source = event.origin.source;
      const key = [source.provider, source.harness, source.sourceKind, nativeItemKind].join(
        "\u0000",
      );
      const current = grouped.get(key);
      const observedAt = event.occurredAt ?? event.observedAt;
      if (current) {
        current.occurrences++;
        if (source.nativeSessionId) current.sessions.add(source.nativeSessionId);
        if (observedAt && (!current.firstSeen || observedAt < current.firstSeen))
          current.firstSeen = observedAt;
        if (observedAt && (!current.lastSeen || observedAt > current.lastSeen))
          current.lastSeen = observedAt;
      } else {
        grouped.set(key, {
          provider: source.provider,
          harness: source.harness,
          sourceKind: source.sourceKind,
          nativeItemKind,
          occurrences: 1,
          distinctSessions: source.nativeSessionId ? 1 : 0,
          firstSeen: observedAt,
          lastSeen: observedAt,
          sessions: new Set(source.nativeSessionId ? [source.nativeSessionId] : []),
        });
      }
    }
  }
  return [...grouped.values()]
    .map(({ sessions, ...nomination }) => ({ ...nomination, distinctSessions: sessions.size }))
    .toSorted(
      (left, right) =>
        right.occurrences - left.occurrences ||
        left.provider.localeCompare(right.provider) ||
        left.harness.localeCompare(right.harness) ||
        left.sourceKind.localeCompare(right.sourceKind) ||
        left.nativeItemKind.localeCompare(right.nativeItemKind),
    )
    .slice(0, limit);
}

export function assertSemanticLossCode(code: string): asserts code is SemanticLossCode {
  if (!SEMANTIC_LOSS_CODE_SET.has(code)) failClosed(`unknown semantic-loss code ${code}`);
}

export function validateSourceItemAccounting(accounting: SourceItemAccounting): void {
  if (accounting.unaccountedItems !== 0)
    failClosed("source item accounting contains unaccounted items");
  const eventBackedPartition =
    accounting.dispositions.normalized +
    accounting.dispositions.opaque +
    accounting.dispositions.redacted +
    accounting.dispositions.omitted;
  if (accounting.eventBackedItems !== eventBackedPartition)
    failClosed("event-backed disposition accounting is false");
  const partition = eventBackedPartition + accounting.lossOnlyItems;
  if (accounting.sourceItems !== partition) failClosed("source item accounting partition is false");
  if (accounting.opaqueItems > accounting.eventBackedItems)
    failClosed("opaque items cannot exceed event-backed items");
}
