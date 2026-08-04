import { realpathSync, statSync } from "node:fs";
import { basename, relative } from "node:path";
import { Effect } from "effect";
import { readJsonLines, type JsonlParseError } from "../jsonl";
import { capture, type EventBatch, type AgentEventEnvelope } from "../events";
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
  "assistant",
  "user",
  "system",
  "attachment",
  "file-history-snapshot",
  "file-history-delta",
  "queue-operation",
  "mode",
  "permission-mode",
  "bridge-session",
  "custom-title",
  "ai-title",
  "last-prompt",
  "agent-name",
  "agent-setting",
  "frame-link",
  "pr-link",
  "started",
  "result",
  "branch",
]);
const BLOCKS = new Set([
  "text",
  "thinking",
  "redacted_thinking",
  "tool_use",
  "tool_result",
  "tool_reference",
  "advisor_tool_result",
  "fallback",
  "image",
  "document",
  "server_tool_use",
  "web_search_tool_result",
  "web_fetch_tool_result",
]);

function stringValue(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function isWorkflowJournal(root: string, sourcePath: string): boolean {
  const segments = relative(root, sourcePath).split("/");
  const subagents = segments.indexOf("subagents");
  return (
    segments.at(-1) === "journal.jsonl" && subagents >= 0 && segments[subagents + 1] === "workflows"
  );
}

function sourceProjectKey(root: string, sourcePath: string): string | undefined {
  const relativePath = relative(root, sourcePath);
  if (!relativePath.includes("/") || relativePath.startsWith("../")) return undefined;
  return relativePath.split("/")[0] || undefined;
}

function trustedSourceScope(
  projectKey: string | undefined,
  claimedCwd: string,
): { readonly cwd: string; readonly project: string } | undefined {
  if (!projectKey || claimedCwd.replaceAll(/[^A-Za-z0-9]/g, "-") !== projectKey) return undefined;
  try {
    const cwd = realpathSync(claimedCwd);
    if (!statSync(cwd).isDirectory()) return undefined;
    return { cwd, project: projectOf(cwd) };
  } catch {
    return undefined;
  }
}

function blockText(block: Record<string, unknown>): string {
  if (typeof block.text === "string") return redact(block.text);
  if (typeof block.content === "string") return redact(block.content);
  return "";
}

function blockIdentifier(block: Record<string, unknown>, fallback: string): string {
  return stringValue(block.id, stringValue(block.tool_use_id, fallback));
}

const adaptSource = Effect.fnUntraced(function* (
  harness: "claude-code",
  root: string,
  source: SourceFile,
): Effect.fn.Return<EventBatch, AdaptError | JsonlParseError> {
  let id = basename(source.path, ".jsonl");
  let cwd = "";
  let model = "";
  let project = "";
  const boundProjectKey = sourceProjectKey(root, source.path);
  const builder = new EventBatchBuilder({
    provider: "anthropic",
    harness,
    sourceKind: "claude-code-session",
    source,
    sessionId: id,
  });
  const byNativeId = new Map<string, AgentEventEnvelope>();
  const seenRecordIds = new Set<string>();

  const updateScope = (): void => {
    builder.setScope({
      ...(project ? { project } : {}),
      ...(cwd ? { cwd } : {}),
    });
  };
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
  const retainTrustedScope = (claimedCwd: string, claimedProject: string, line: number): void => {
    const trusted = trustedSourceScope(boundProjectKey, claimedCwd);
    if (!trusted) {
      if (claimedCwd || claimedProject)
        builder.loss(
          "provider-field-unsupported",
          "provider-reported scope does not match the Claude source project binding",
          line,
          undefined,
          { itemType: "provider-scope", sourceProjectKey: boundProjectKey ?? "(unbound)" },
        );
      return;
    }
    cwd = trusted.cwd;
    project = trusted.project;
    if (claimedProject && claimedProject !== project)
      builder.loss(
        "provider-field-unsupported",
        "provider-reported project was replaced by the source-bound project identity",
        line,
        undefined,
        { itemType: "provider-project" },
      );
    updateScope();
  };

  const remember = (nativeId: string, event: AgentEventEnvelope): void => {
    if (nativeId) byNativeId.set(nativeId, event);
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
      if (isWorkflowJournal(root, source.path)) {
        builder.add(
          "provider.opaque",
          value,
          line,
          { nativeItemKind: type || "unknown", payload: redactedJson(value) },
          {
            nativeItemId: `workflow-journal:${line}`,
            capture: capture("opaque"),
            actor: { kind: "provider", name: harness },
          },
        );
        return;
      }
      const recordId = stringValue(value.uuid);
      if (recordId) {
        if (seenRecordIds.has(recordId)) {
          builder.loss(
            "duplicate-source-item",
            "repeated Claude native record was omitted after its first occurrence",
            line,
            `duplicate:${recordId}:${line}`,
            {
              itemType: type || "unknown",
              duplicateNativeItemId: recordId,
            },
          );
          return;
        }
        seenRecordIds.add(recordId);
      }
      if (!RECORDS.has(type)) {
        builder.add(
          "provider.opaque",
          value,
          line,
          { nativeItemKind: type || "unknown", payload: redactedJson(value) },
          {
            nativeItemId: `opaque:${type || "unknown"}:${line}`,
            capture: capture("opaque"),
            actor: { kind: "provider", name: harness },
          },
        );
        return;
      }
      const timestampValue = timestamp(value.timestamp);
      if (typeof value.sessionId === "string" && value.sessionId) {
        id = value.sessionId;
        builder.setSessionId(id);
      }
      const observedCwd = stringValue(value.cwd);
      const observedProject = stringValue(value.project);
      if (observedCwd || observedProject) retainTrustedScope(observedCwd, observedProject, line);
      if (stringValue(value.model)) model = stringValue(value.model);

      if (type === "started") {
        const event = builder.add(
          "session.started",
          value,
          line,
          {
            id,
            sessionId: id,
            provider: "anthropic",
            harness,
            cwd,
            project,
            model: stringValue(value.model) || model,
            sourceKind: "claude-code-session",
            ...(stringValue(value.resumeId) ? { resumeId: stringValue(value.resumeId) } : {}),
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

      if (type === "assistant" || type === "user") {
        const message = objectRecord(value.message);
        if (typeof message.role !== "string")
          return yield* Effect.fail(
            new AdaptError({ path: source.path, line, reason: "malformed Claude message" }),
          );
        const messageModel = stringValue(message.model) || stringValue(value.model);
        if (messageModel) model = messageModel;
        const messageResumeId = stringValue(value.resumeId) || stringValue(message.resumeId);
        const messageId = stringValue(value.uuid, stringValue(message.id, `${id}:message:${line}`));
        const parentId = stringValue(value.parentUuid, stringValue(message.parentUuid));
        const parent = byNativeId.get(parentId);
        const blocks = Array.isArray(message.content) ? message.content : [];
        const textParts: string[] = [];
        const toolBlocks: Array<{ block: Record<string, unknown>; index: number }> = [];
        for (const [index, rawBlock] of blocks.entries()) {
          if (!rawBlock || typeof rawBlock !== "object" || Array.isArray(rawBlock))
            return yield* Effect.fail(
              new AdaptError({ path: source.path, line, reason: "malformed Claude content block" }),
            );
          const block = rawBlock as Record<string, unknown>;
          const blockType = stringValue(block.type);
          if (!BLOCKS.has(blockType)) {
            builder.loss(
              "unknown-well-formed-item",
              `Claude content block type ${JSON.stringify(blockType)} was omitted by the adapter`,
              line,
              blockIdentifier(block, `${messageId}:block:${index}`),
              { blockType },
            );
            continue;
          }
          if (blockType === "image" || blockType === "document") {
            builder.loss(
              "attachment-body-excluded",
              `Claude ${JSON.stringify(blockType)} content block body was not captured`,
              line,
              blockIdentifier(block, `${messageId}:block:${index}`),
              { blockType },
            );
          } else if (
            blockType === "advisor_tool_result" ||
            blockType === "web_search_tool_result" ||
            blockType === "web_fetch_tool_result"
          ) {
            builder.loss(
              "provider-field-unsupported",
              `Claude content block type ${JSON.stringify(blockType)} is not modeled`,
              line,
              blockIdentifier(block, `${messageId}:block:${index}`),
              { blockType },
            );
          }
          if (blockType === "text" || blockType === "fallback" || blockType === "tool_reference") {
            const text = blockText(block);
            if (text) textParts.push(text);
          }
          if (blockType === "tool_use" || blockType === "server_tool_use")
            toolBlocks.push({ block, index });
        }
        const usage = objectRecord(message.usage);
        const tokens = Object.keys(usage).length
          ? {
              input: Number(usage.input_tokens ?? 0),
              output: Number(usage.output_tokens ?? 0),
              cachedInput: Number(usage.cache_read_input_tokens ?? 0),
              cacheWrite: Number(usage.cache_creation_input_tokens ?? 0),
              total:
                Number(usage.input_tokens ?? 0) +
                Number(usage.output_tokens ?? 0) +
                Number(usage.cache_read_input_tokens ?? 0) +
                Number(usage.cache_creation_input_tokens ?? 0),
            }
          : undefined;
        const messageEvent = builder.add(
          "message.created",
          value,
          line,
          {
            role: message.role,
            content: textParts.join("\n"),
            ...(tokens ? { tokens } : {}),
            messageId,
            ...(messageModel ? { model: messageModel } : {}),
            ...(messageResumeId ? { resumeId: messageResumeId } : {}),
          },
          {
            nativeItemId: messageId,
            ...(timestampValue ? { occurredAt: timestampValue } : {}),
            ...(parent ? { relations: { parent: parent.eventId } } : {}),
            actor: {
              kind:
                message.role === "user"
                  ? "human"
                  : message.role === "assistant"
                    ? "assistant"
                    : "system",
            },
          },
        );
        remember(messageId, messageEvent);
        for (const [index, rawBlock] of blocks.entries()) {
          const block = rawBlock as Record<string, unknown>;
          const blockType = stringValue(block.type);
          const nativeId = blockIdentifier(block, `${messageId}:block:${index}`);
          if (blockType === "thinking") {
            const thinking = stringValue(block.thinking, blockText(block));
            builder.add(
              "model.reasoning.observed",
              value,
              line,
              { messageId, blockId: nativeId, ...(thinking ? { text: thinking } : {}) },
              {
                nativeItemId: `${nativeId}:reasoning`,
                ...(timestampValue ? { occurredAt: timestampValue } : {}),
                relations: { causedBy: [messageEvent.eventId], parent: messageEvent.eventId },
                actor: { kind: "assistant" },
              },
            );
          } else if (blockType === "redacted_thinking") {
            builder.add(
              "model.reasoning.observed",
              value,
              line,
              { messageId, blockId: nativeId },
              {
                nativeItemId: `${nativeId}:redacted-reasoning`,
                ...(timestampValue ? { occurredAt: timestampValue } : {}),
                relations: { causedBy: [messageEvent.eventId], parent: messageEvent.eventId },
                actor: { kind: "assistant" },
                capture: capture("redacted", "provider redacted Claude reasoning"),
              },
            );
          } else if (blockType === "tool_use" || blockType === "server_tool_use") {
            const toolEvent = builder.add(
              "tool.call.proposed",
              value,
              line,
              {
                id: nativeId,
                callId: nativeId,
                name: stringValue(block.name, blockType),
                ...(block.input !== undefined ? { arguments: redactedJson(block.input) } : {}),
                toolClass: blockType === "server_tool_use" ? "server" : "local",
              },
              {
                nativeItemId: nativeId,
                ...(timestampValue ? { occurredAt: timestampValue } : {}),
                relations: { causedBy: [messageEvent.eventId], parent: messageEvent.eventId },
                actor: { kind: "assistant", name: stringValue(block.name, blockType) },
              },
            );
            remember(nativeId, toolEvent);
          } else if (blockType === "tool_result") {
            const callId = stringValue(block.tool_use_id);
            const causedBy = byNativeId.get(callId);
            if (!causedBy)
              builder.loss(
                "relation-target-missing",
                "Claude tool result did not identify a previously observed tool call",
                line,
                callId || nativeId,
                { relation: "causedBy", target: callId || nativeId },
              );
            builder.add(
              "tool.result.observed",
              value,
              line,
              {
                callId,
                output:
                  block.content === undefined
                    ? ""
                    : typeof block.content === "string"
                      ? redact(block.content)
                      : redactedJson(block.content),
                ...(block.is_error === true ? { isError: true } : {}),
              },
              {
                nativeItemId: `${nativeId}:result`,
                ...(timestampValue ? { occurredAt: timestampValue } : {}),
                relations: causedBy
                  ? { causedBy: [causedBy.eventId], parent: causedBy.eventId }
                  : { parent: messageEvent.eventId },
                actor: { kind: "tool", name: callId || "tool_result" },
              },
            );
          }
        }
        return;
      }
      if (type === "branch") {
        const branchId = stringValue(value.branchId, stringValue(value.id, `${id}:branch:${line}`));
        const previous = builder.events.at(-1);
        const created = builder.add(
          "branch.created",
          value,
          line,
          { branchId, summary: redactedJson(value.summary ?? value) },
          {
            nativeItemId: `${branchId}:created`,
            ...(timestampValue ? { occurredAt: timestampValue } : {}),
            ...(previous ? { relations: { parent: previous.eventId } } : {}),
            scope: { branchId },
            actor: { kind: "provider", name: harness },
          },
        );
        builder.add(
          "branch.selected",
          value,
          line,
          { branchId },
          {
            nativeItemId: `${branchId}:selected`,
            ...(timestampValue ? { occurredAt: timestampValue } : {}),
            relations: { causedBy: [created.eventId], parent: created.eventId },
            scope: { branchId },
            actor: { kind: "provider", name: harness },
          },
        );
        remember(branchId, created);
        return;
      }

      if (type === "system" && typeof value.content === "string") {
        const event = builder.add(
          "message.created",
          value,
          line,
          { role: "system", content: redact(value.content) },
          {
            nativeItemId: stringValue(value.uuid, `${id}:system:${line}`),
            ...(timestampValue ? { occurredAt: timestampValue } : {}),
            actor: { kind: "system", name: harness },
          },
        );
        remember(stringValue(value.uuid, `${id}:system:${line}`), event);
        return;
      }

      if (type === "result") {
        const toolId = stringValue(value.tool_use_id, stringValue(value.toolCallId));
        if (toolId) {
          const causedBy = byNativeId.get(toolId);
          if (!causedBy)
            builder.loss(
              "relation-target-missing",
              "Claude tool result did not identify a previously observed tool call",
              line,
              toolId,
              { relation: "causedBy", target: toolId },
            );
          builder.add(
            "tool.result.observed",
            value,
            line,
            { callId: toolId, output: redact(stringValue(value.result, redactedJson(value))) },
            {
              nativeItemId: `${toolId}:result:${line}`,
              ...(timestampValue ? { occurredAt: timestampValue } : {}),
              ...(causedBy
                ? { relations: { causedBy: [causedBy.eventId], parent: causedBy.eventId } }
                : {}),
              actor: { kind: "tool", name: toolId },
            },
          );
        } else {
          const resultText = typeof value.result === "string" ? redact(value.result) : "";
          if (resultText) {
            builder.add(
              "message.created",
              value,
              line,
              {
                role: "assistant",
                content: resultText,
                messageId: `${id}:result:${line}`,
              },
              {
                nativeItemId: `${id}:result:${line}:message`,
                ...(timestampValue ? { occurredAt: timestampValue } : {}),
                actor: { kind: "assistant" },
              },
            );
          }
          builder.add(
            "session.ended",
            value,
            line,
            { id, result: redact(stringValue(value.result, redactedJson(value))) },
            {
              nativeItemId: `${id}:ended:${line}`,
              ...(timestampValue ? { occurredAt: timestampValue } : {}),
              actor: { kind: "provider", name: harness },
            },
          );
        }
        return;
      }

      if (type === "file-history-snapshot" || type === "attachment") {
        builder.add(
          "artifact.created",
          value,
          line,
          {
            name: redact(stringValue(value.fileName, stringValue(value.filename, type))),
            artifactType: type,
            metadata: redactedJson(value.metadata ?? value.files ?? value),
          },
          {
            nativeItemId: stringValue(value.id, `${id}:${type}:${line}`),
            ...(timestampValue ? { occurredAt: timestampValue } : {}),
            actor: { kind: "provider", name: harness },
          },
        );
        return;
      }
      if (type === "file-history-delta") {
        builder.add(
          "artifact.modified",
          value,
          line,
          { artifactType: type, metadata: redactedJson(value) },
          {
            nativeItemId: stringValue(value.id, `${id}:${type}:${line}`),
            ...(timestampValue ? { occurredAt: timestampValue } : {}),
            actor: { kind: "provider", name: harness },
          },
        );
        return;
      }

      if (type === "permission-mode" || type === "mode") {
        const callId = stringValue(value.tool_use_id, stringValue(value.toolCallId));
        const decision = stringValue(value.decision, stringValue(value.status)).toLowerCase();
        const causedBy = callId ? byNativeId.get(callId) : undefined;
        if (
          callId &&
          (decision === "approved" ||
            decision === "allow" ||
            decision === "denied" ||
            decision === "deny")
        ) {
          builder.add(
            decision === "denied" || decision === "deny"
              ? "tool.call.denied"
              : "tool.call.approved",
            value,
            line,
            { callId, decision },
            {
              nativeItemId: `${callId}:approval:${line}`,
              ...(timestampValue ? { occurredAt: timestampValue } : {}),
              ...(causedBy
                ? { relations: { causedBy: [causedBy.eventId], parent: causedBy.eventId } }
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
              nativeItemId: `${id}:${type}:${line}`,
              ...(timestampValue ? { occurredAt: timestampValue } : {}),
              capture: capture("opaque"),
            },
          );
        }
        return;
      }

      const opaque = builder.add(
        "provider.opaque",
        value,
        line,
        {
          itemKind: type,
          ...(typeof value.title === "string" ? { title: redact(value.title) } : {}),
          data: redactedJson(value),
        },
        {
          nativeItemId: stringValue(value.uuid, `${id}:${type}:${line}`),
          ...(timestampValue ? { occurredAt: timestampValue } : {}),
          capture: capture("opaque"),
        },
      );
      remember(stringValue(value.uuid, `${id}:${type}:${line}`), opaque);
    } catch (error) {
      yield* stopAtCapacity(error, line);
    }
  });

  const parsed = yield* readJsonLines(source.path, processRecord, omitOversizedLine);
  updateScope();
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

export class ClaudeAdapter implements SourceAdapter {
  readonly harness = "claude-code" as const;
  constructor(private readonly root: string) {}
  discover(): Promise<SourceFile[]> {
    return discoverJsonl(this.root);
  }
  adapt(source: SourceFile): Promise<EventBatch> {
    return Effect.runPromise(adaptSource(this.harness, this.root, source));
  }
}
