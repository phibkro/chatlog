import { basename } from "node:path";
import { Effect } from "effect";
import { readJsonLines, type JsonlParseError } from "../jsonl";
import { capture, type AgentEventEnvelope, type EventBatch } from "../events";
import type { SourceAdapter, SourceFile } from "../types";
import { redact } from "../redact";
import {
  AdaptError,
  admitBoundedRecord,
  assertObject,
  discoverJsonl,
  EventBatchBuilder,
  EventBatchLimitError,
  objectRecord,
  projectOf,
  redactedJson,
  timestamp,
} from "./common";

const RECORDS = new Set([
  "session",
  "session_info",
  "model_change",
  "thinking_level_change",
  "message",
  "compaction",
  "branch_summary",
  "approval",
  "custom",
]);
const BLOCKS = new Set(["text", "thinking", "toolCall", "toolResult", "image"]);

function stringValue(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function blockText(block: Record<string, unknown>): string {
  if (typeof block.text === "string") return redact(block.text);
  if (typeof block.content === "string") return redact(block.content);
  return "";
}

const adaptSource = Effect.fnUntraced(function* (
  harness: "pi" | "omp",
  source: SourceFile,
): Effect.fn.Return<EventBatch, AdaptError | JsonlParseError> {
  let id = basename(source.path, ".jsonl");
  let cwd = "";
  let model = "";
  let provider = "(unknown)";
  const sourceKind = `${harness}-session`;
  const builder = new EventBatchBuilder({
    provider,
    harness,
    sourceKind,
    source,
    sessionId: id,
  });
  const byNativeId = new Map<string, AgentEventEnvelope>();
  let previous: AgentEventEnvelope | undefined;
  let sourceRecordsSeen = 0;
  let capacityOmission: { line: number; record: number } | undefined;

  const stopAtCapacity = (error: unknown, line: number): Effect.Effect<void> => {
    if (!(error instanceof EventBatchLimitError)) return Effect.die(error);
    return Effect.sync(() => {
      capacityOmission ??= { line, record: sourceRecordsSeen };
    });
  };

  const omitOversizedLine = (line: number): Effect.Effect<void> =>
    Effect.suspend(() => {
      sourceRecordsSeen += 1;
      if (capacityOmission) return Effect.void;
      try {
        builder.omitOversizedLine(line);
        return Effect.void;
      } catch (error) {
        return stopAtCapacity(error, line);
      }
    });

  const remember = (nativeId: string, event: AgentEventEnvelope): void => {
    if (nativeId) byNativeId.set(nativeId, event);
    previous = event;
  };

  const processRecord = Effect.fnUntraced(function* (
    rec: unknown,
    line: number,
  ): Effect.fn.Return<void, AdaptError> {
    sourceRecordsSeen += 1;
    if (capacityOmission) return;
    try {
      if (!(yield* admitBoundedRecord(rec, source.path, line))) {
        builder.omitOversizedRecord(rec, line);
        return;
      }
      yield* assertObject(rec, source.path, line);
      const value = objectRecord(rec);
      const type = stringValue(value.type);
      const timestampValue = timestamp(value.timestamp);
      if (!RECORDS.has(type)) {
        builder.add(
          "provider.opaque",
          value,
          line,
          { nativeItemKind: type || "unknown", payload: redactedJson(value) },
          {
            nativeItemId: `opaque:${type || "unknown"}:${line}`,
            ...(timestampValue ? { occurredAt: timestampValue } : {}),
            capture: capture("opaque"),
            actor: { kind: "provider", name: harness },
          },
        );
        return;
      }
      if (type === "session") {
        id = stringValue(value.id, id);
        builder.setSessionId(id);
        cwd = stringValue(value.cwd, cwd);
        const event = builder.add(
          "session.started",
          value,
          line,
          {
            id,
            sessionId: id,
            provider,
            harness,
            cwd,
            project: projectOf(cwd),
            model,
            sourceKind,
            resumeId: id,
          },
          {
            nativeItemId: `session:${id}`,
            ...(timestampValue ? { occurredAt: timestampValue } : {}),
            actor: { kind: "provider", name: harness },
          },
        );
        remember(`session:${id}`, event);
        return;
      }
      if (type === "model_change") {
        model = stringValue(value.modelId, stringValue(value.model, model));
        provider = stringValue(value.provider, provider);
        const event = builder.add(
          "provider.opaque",
          value,
          line,
          { itemKind: "model_change", model, provider, data: redactedJson(value) },
          {
            nativeItemId: stringValue(value.id, `${id}:model:${line}`),
            ...(timestampValue ? { occurredAt: timestampValue } : {}),
            capture: capture("opaque"),
          },
        );
        remember(stringValue(value.id, `${id}:model:${line}`), event);
        return;
      }
      if (type === "thinking_level_change" || type === "session_info") {
        const event = builder.add(
          "provider.opaque",
          value,
          line,
          { itemKind: type, data: redactedJson(value) },
          {
            nativeItemId: stringValue(value.id, `${id}:${type}:${line}`),
            ...(timestampValue ? { occurredAt: timestampValue } : {}),
            capture: capture("opaque"),
          },
        );
        remember(stringValue(value.id, `${id}:${type}:${line}`), event);
        return;
      }
      if (type === "compaction") {
        const event = builder.add(
          "context.compacted",
          value,
          line,
          {
            summary: redactedJson(value.summary ?? value),
            ...(value.id ? { compactionId: value.id } : {}),
          },
          {
            nativeItemId: stringValue(value.id, `${id}:compaction:${line}`),
            ...(timestampValue ? { occurredAt: timestampValue } : {}),
            ...(previous ? { relations: { parent: previous.eventId } } : {}),
            actor: { kind: "provider", name: harness },
          },
        );
        remember(stringValue(value.id, `${id}:compaction:${line}`), event);
        return;
      }
      if (type === "branch_summary") {
        const branchId = stringValue(value.branchId, stringValue(value.id, `${id}:branch:${line}`));
        const event = builder.add(
          "branch.created",
          value,
          line,
          { branchId, summary: redactedJson(value.summary ?? value) },
          {
            nativeItemId: branchId,
            ...(timestampValue ? { occurredAt: timestampValue } : {}),
            ...(previous ? { relations: { parent: previous.eventId } } : {}),
            scope: { branchId },
            actor: { kind: "provider", name: harness },
          },
        );
        const selected = builder.add(
          "branch.selected",
          value,
          line,
          { branchId },
          {
            nativeItemId: `${branchId}:selected`,
            ...(timestampValue ? { occurredAt: timestampValue } : {}),
            relations: { causedBy: [event.eventId], parent: event.eventId },
            scope: { branchId },
            actor: { kind: "provider", name: harness },
          },
        );
        remember(`${branchId}:selected`, selected);
        return;
      }
      if (type === "approval") {
        const callId = stringValue(
          value.toolCallId,
          stringValue(value.callId, stringValue(value.id)),
        );
        const decision = stringValue(value.decision, "unknown").toLowerCase();
        const causedBy = byNativeId.get(callId);
        if (!causedBy)
          builder.loss(
            "relation-target-missing",
            "Pi approval did not identify a previously observed tool call",
            line,
            callId,
            { relation: "causedBy", target: callId },
          );
        if (decision === "approved" || decision === "denied") {
          builder.add(
            decision === "approved" ? "tool.call.approved" : "tool.call.denied",
            value,
            line,
            { callId, decision },
            {
              nativeItemId: `${callId || id}:approval:${line}`,
              ...(timestampValue ? { occurredAt: timestampValue } : {}),
              ...(causedBy
                ? { relations: { causedBy: [causedBy.eventId], parent: causedBy.eventId } }
                : previous
                  ? { relations: { parent: previous.eventId } }
                  : {}),
              actor: { kind: "human" },
            },
          );
        } else {
          builder.add(
            "provider.opaque",
            value,
            line,
            { itemKind: type, data: redactedJson(value) },
            {
              nativeItemId: `${id}:approval:${line}`,
              ...(timestampValue ? { occurredAt: timestampValue } : {}),
              capture: capture("opaque"),
            },
          );
        }
        return;
      }
      if (type === "custom") {
        const event = builder.add(
          "provider.opaque",
          value,
          line,
          { itemKind: type, data: redactedJson(value) },
          {
            nativeItemId: stringValue(value.id, `${id}:custom:${line}`),
            ...(timestampValue ? { occurredAt: timestampValue } : {}),
            capture: capture("opaque"),
          },
        );
        remember(stringValue(value.id, `${id}:custom:${line}`), event);
        return;
      }

      const msg = objectRecord(value.message);
      if (!Object.keys(msg).length)
        return yield* Effect.fail(
          new AdaptError({ path: source.path, line, reason: "malformed pi message" }),
        );
      if (typeof msg.role !== "string")
        return yield* Effect.fail(
          new AdaptError({ path: source.path, line, reason: "malformed pi message" }),
        );
      if (typeof msg.model === "string") model = msg.model;
      if (typeof msg.provider === "string") provider = msg.provider;
      const messageId = stringValue(value.id, stringValue(msg.id, `${id}:message:${line}`));
      const blocks = Array.isArray(msg.content) ? msg.content : [];
      const textParts: string[] = [];
      for (const [index, rawBlock] of blocks.entries()) {
        if (typeof rawBlock === "string") {
          textParts.push(redact(rawBlock));
          continue;
        }
        if (!rawBlock || typeof rawBlock !== "object" || Array.isArray(rawBlock))
          return yield* Effect.fail(
            new AdaptError({ path: source.path, line, reason: "malformed pi content block" }),
          );
        const block = rawBlock as Record<string, unknown>;
        const blockType = stringValue(block.type);
        if (!BLOCKS.has(blockType)) {
          builder.loss(
            "unknown-well-formed-item",
            `Pi content block type ${JSON.stringify(blockType)} was omitted by the adapter`,
            line,
            stringValue(block.id, stringValue(block.toolCallId, `${messageId}:block:${index}`)),
            { blockType, index, messageId },
          );
          continue;
        }
        if (blockType === "image") {
          builder.loss(
            "attachment-body-excluded",
            "Pi image content block body was not captured",
            line,
            stringValue(block.id, stringValue(block.toolCallId, `${messageId}:block:${index}`)),
            { blockType, index, messageId },
          );
        } else if (blockType === "text" || blockType === "toolResult") {
          const text = blockText(block);
          if (text) textParts.push(text);
        }
      }
      const usage = objectRecord(msg.usage);
      const tokens = Object.keys(usage).length
        ? {
            input: Number(usage.input ?? 0),
            output: Number(usage.output ?? 0),
            cachedInput: Number(usage.cacheRead ?? 0),
            cacheWrite: Number(usage.cacheWrite ?? 0),
            reasoning: Number(usage.reasoning ?? 0),
            total: Number(usage.totalTokens ?? 0),
          }
        : undefined;
      const role = msg.role === "toolResult" ? "tool" : msg.role;
      const messageEvent = builder.add(
        "message.created",
        value,
        line,
        { role, content: textParts.join("\n"), messageId, ...(tokens ? { tokens } : {}) },
        {
          nativeItemId: messageId,
          ...(timestampValue ? { occurredAt: timestampValue } : {}),
          ...(previous ? { relations: { parent: previous.eventId } } : {}),
          actor: { kind: role === "user" ? "human" : role === "assistant" ? "assistant" : "tool" },
        },
      );
      remember(messageId, messageEvent);
      for (const [index, rawBlock] of blocks.entries()) {
        if (!rawBlock || typeof rawBlock !== "object" || Array.isArray(rawBlock)) continue;
        const block = rawBlock as Record<string, unknown>;
        const blockType = stringValue(block.type);
        const nativeId = stringValue(
          block.id,
          stringValue(block.toolCallId, `${messageId}:block:${index}`),
        );
        if (blockType === "thinking") {
          const event = builder.add(
            "model.reasoning.observed",
            value,
            line,
            {
              messageId,
              blockId: nativeId,
              text: redact(stringValue(block.thinking, blockText(block))),
            },
            {
              nativeItemId: `${nativeId}:reasoning`,
              ...(timestampValue ? { occurredAt: timestampValue } : {}),
              relations: { causedBy: [messageEvent.eventId], parent: messageEvent.eventId },
              actor: { kind: "assistant" },
            },
          );
          remember(`${nativeId}:reasoning`, event);
        } else if (blockType === "toolCall") {
          const callId = stringValue(block.id, nativeId);
          const event = builder.add(
            "tool.call.proposed",
            value,
            line,
            {
              id: callId,
              callId,
              name: stringValue(block.name, "tool"),
              arguments: redactedJson(block.arguments ?? block.input ?? {}),
              toolClass: "pi",
            },
            {
              nativeItemId: nativeId,
              ...(timestampValue ? { occurredAt: timestampValue } : {}),
              relations: { causedBy: [messageEvent.eventId], parent: messageEvent.eventId },
              actor: { kind: "assistant", name: stringValue(block.name, "tool") },
            },
          );
          remember(callId, event);
          remember(nativeId, event);
        } else if (blockType === "toolResult") {
          const callId = stringValue(block.toolCallId, stringValue(block.id));
          const causedBy = byNativeId.get(callId);
          if (!causedBy)
            builder.loss(
              "relation-target-missing",
              "Pi tool result did not identify a previously observed tool call",
              line,
              callId,
              { relation: "causedBy", target: callId },
            );
          const event = builder.add(
            "tool.result.observed",
            value,
            line,
            {
              callId,
              output: blockText(block),
              ...(block.isError === true ? { isError: true } : {}),
            },
            {
              nativeItemId: `${nativeId}:result`,
              ...(causedBy
                ? { relations: { causedBy: [causedBy.eventId], parent: causedBy.eventId } }
                : {
                    relations: { causedBy: [messageEvent.eventId], parent: messageEvent.eventId },
                  }),
              actor: { kind: "tool", name: stringValue(block.toolName, "tool_result") },
            },
          );
          remember(`${nativeId}:result`, event);
        }
      }
    } catch (error) {
      yield* stopAtCapacity(error, line);
    }
  });

  const parsed = yield* readJsonLines(source.path, processRecord, omitOversizedLine);
  return builder.finish(
    parsed.partialTail,
    parsed.records,
    capacityOmission
      ? {
          line: capacityOmission.line,
          count: parsed.records - capacityOmission.record + 1,
        }
      : undefined,
  );
});

export class PiAdapter implements SourceAdapter {
  readonly harness = "pi" as const;
  constructor(private readonly root: string) {}
  discover(): Promise<SourceFile[]> {
    return discoverJsonl(this.root);
  }
  adapt(source: SourceFile): Promise<EventBatch> {
    return Effect.runPromise(adaptSource(this.harness, source));
  }
}

export class OmpAdapter implements SourceAdapter {
  readonly harness = "omp" as const;
  constructor(private readonly root: string) {}
  discover(): Promise<SourceFile[]> {
    return discoverJsonl(this.root);
  }
  adapt(source: SourceFile): Promise<EventBatch> {
    return Effect.runPromise(adaptSource(this.harness, source));
  }
}
