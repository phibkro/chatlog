import { basename } from "node:path";
import { Effect } from "effect";
import { readJsonLines, type JsonlParseError } from "../jsonl";
import { capture, type AgentEventEnvelope, type EventBatch } from "../events";
import type { SourceAdapter, SourceFile } from "../types";
import { redact } from "../redact";
import {
  AdaptError,
  assertBoundedRecord,
  assertObject,
  discoverJsonl,
  EventBatchBuilder,
  objectRecord,
  projectOf,
  redactedJson,
  timestamp,
} from "./common";

const RECORDS = new Set([
  "session_meta",
  "turn_context",
  "response_item",
  "event_msg",
  "compacted",
  "world_state",
  "inter_agent_communication_metadata",
  "approval",
  "branch",
]);
const RESPONSE_ITEMS = new Set([
  "message",
  "agent_message",
  "reasoning",
  "function_call",
  "function_call_output",
  "custom_tool_call",
  "custom_tool_call_output",
  "tool_search_call",
  "tool_search_output",
  "web_search_call",
  "local_shell_call",
  "computer_call",
]);
const CONTENT_BLOCKS = new Set([
  "input_text",
  "output_text",
  "text",
  "encrypted_content",
  "input_image",
  "image",
  "computer_initialize_state",
  "computer_screenshot",
]);

function stringValue(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

const contentText = Effect.fnUntraced(function* (
  value: unknown,
  path: string,
  line: number,
  onLoss?: (blockType: string, block: Record<string, unknown>, index: number) => void,
): Effect.fn.Return<string, AdaptError> {
  if (typeof value === "string") return redact(value);
  if (!Array.isArray(value)) {
    if (value == null) return "";
    return yield* Effect.fail(
      new AdaptError({ path, line, reason: "unknown Codex message content shape" }),
    );
  }
  const parts: string[] = [];
  for (const [index, rawBlock] of value.entries()) {
    if (typeof rawBlock === "string") {
      parts.push(redact(rawBlock));
      continue;
    }
    if (!rawBlock || typeof rawBlock !== "object" || Array.isArray(rawBlock))
      return yield* Effect.fail(
        new AdaptError({ path, line, reason: "unknown Codex message content block" }),
      );
    const block = rawBlock as Record<string, unknown>;
    const blockType = stringValue(block.type);
    if (!CONTENT_BLOCKS.has(blockType)) {
      onLoss?.(blockType || "unknown", block, index);
      continue;
    }
    if (blockType === "encrypted_content") {
      onLoss?.(blockType, block, index);
      continue;
    }
    if (typeof block.text === "string") parts.push(redact(block.text));
    else if (typeof block.content === "string") parts.push(redact(block.content));
    else if (onLoss) onLoss(blockType, block, index);
  }
  return parts.filter(Boolean).join("\n");
});

function status(value: unknown): "started" | "succeeded" | "failed" | "unknown" | undefined {
  const text = typeof value === "string" ? value.toLowerCase() : "";
  if (["completed", "complete"].includes(text)) return undefined;
  if (["started", "running", "pending", "in_progress"].includes(text)) return "started";
  if (["succeeded", "success"].includes(text)) return "succeeded";
  if (["failed", "failure", "error"].includes(text)) return "failed";
  return text ? "unknown" : undefined;
}

const adaptSource = Effect.fnUntraced(function* (
  harness: "codex",
  source: SourceFile,
): Effect.fn.Return<EventBatch, AdaptError | JsonlParseError> {
  let id = basename(source.path, ".jsonl");
  let cwd = "";
  let model = "";
  let provider = "openai";
  let fallback = new Date(source.mtimeMs).toISOString();
  const builder = new EventBatchBuilder({
    provider,
    harness,
    sourceKind: "codex-session",
    source,
    sessionId: id,
  });
  const byNativeId = new Map<string, AgentEventEnvelope>();
  let previous: AgentEventEnvelope | undefined;

  const remember = (nativeId: string, event: AgentEventEnvelope): void => {
    if (nativeId) byNativeId.set(nativeId, event);
    previous = event;
  };

  const processRecord = Effect.fnUntraced(function* (
    rec: unknown,
    line: number,
  ): Effect.fn.Return<void, AdaptError> {
    yield* assertBoundedRecord(rec, source.path, line);
    yield* assertObject(rec, source.path, line);
    const value = objectRecord(rec);
    const type = stringValue(value.type);
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
    if (timestampValue) fallback = timestampValue;
    const p = objectRecord(value.payload);
    if (!Object.keys(p).length)
      return yield* Effect.fail(
        new AdaptError({ path: source.path, line, reason: "Codex payload missing" }),
      );

    if (type === "session_meta") {
      id = stringValue(p.id, stringValue(p.session_id, id));
      builder.setSessionId(id);
      cwd = stringValue(p.cwd, cwd);
      provider = stringValue(p.model_provider, provider);
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
          sourceKind: "codex-session",
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
    if (type === "turn_context") {
      cwd = stringValue(p.cwd, cwd);
      model = stringValue(p.model, model);
      const event = builder.add(
        "provider.opaque",
        value,
        line,
        { itemKind: type, cwd, model, data: redactedJson(p) },
        {
          nativeItemId: stringValue(p.id, `${id}:turn-context:${line}`),
          ...(timestampValue ? { occurredAt: timestampValue } : {}),
          capture: capture("opaque"),
        },
      );
      remember(stringValue(p.id, `${id}:turn-context:${line}`), event);
      return;
    }
    if (type === "event_msg") {
      if (p.type === "token_count" && p.info && typeof p.info === "object") {
        const info = objectRecord(p.info);
        const u = objectRecord(info.total_token_usage);
        const tokens = {
          input: Number(u.input_tokens ?? 0),
          output: Number(u.output_tokens ?? 0),
          cachedInput: Number(u.cached_input_tokens ?? 0),
          reasoning: Number(u.reasoning_output_tokens ?? 0),
          total: Number(u.total_tokens ?? 0),
        };
        const event = builder.add(
          "evaluation.recorded",
          value,
          line,
          { evaluationKind: "token_count", tokens, ...tokens },
          {
            nativeItemId: stringValue(p.id, `${id}:tokens:${line}`),
            ...(timestampValue ? { occurredAt: timestampValue } : {}),
            actor: { kind: "provider", name: harness },
          },
        );
        remember(stringValue(p.id, `${id}:tokens:${line}`), event);
      } else {
        const event = builder.add(
          "provider.opaque",
          value,
          line,
          { itemKind: type, data: redactedJson(p) },
          {
            nativeItemId: stringValue(p.id, `${id}:event:${line}`),
            ...(timestampValue ? { occurredAt: timestampValue } : {}),
            capture: capture("opaque"),
          },
        );
        remember(stringValue(p.id, `${id}:event:${line}`), event);
      }
      return;
    }
    if (type === "compacted") {
      const event = builder.add(
        "context.compacted",
        value,
        line,
        { summary: redactedJson(p), ...(p.id ? { compactionId: p.id } : {}) },
        {
          nativeItemId: stringValue(p.id, `${id}:compacted:${line}`),
          ...(timestampValue ? { occurredAt: timestampValue } : {}),
          ...(previous ? { relations: { parent: previous.eventId } } : {}),
          actor: { kind: "provider", name: harness },
        },
      );
      remember(stringValue(p.id, `${id}:compacted:${line}`), event);
      return;
    }
    if (type === "world_state") {
      const event = builder.add(
        "artifact.created",
        value,
        line,
        { artifactType: "world_state", references: redactedJson(p) },
        {
          nativeItemId: stringValue(p.id, `${id}:world-state:${line}`),
          ...(timestampValue ? { occurredAt: timestampValue } : {}),
          actor: { kind: "provider", name: harness },
        },
      );
      remember(stringValue(p.id, `${id}:world-state:${line}`), event);
      return;
    }
    if (type === "inter_agent_communication_metadata") {
      const event = builder.add(
        "provider.opaque",
        value,
        line,
        { itemKind: type, data: redactedJson(p) },
        {
          nativeItemId: stringValue(p.id, `${id}:communication:${line}`),
          ...(timestampValue ? { occurredAt: timestampValue } : {}),
          capture: capture("opaque"),
        },
      );
      remember(stringValue(p.id, `${id}:communication:${line}`), event);
      return;
    }

    if (type === "branch") {
      const branchId = stringValue(p.branch_id, stringValue(p.id, `${id}:branch:${line}`));
      const created = builder.add(
        "branch.created",
        value,
        line,
        { branchId, summary: redactedJson(p.summary ?? p) },
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
    if (type === "approval") {
      const callId = stringValue(p.call_id, stringValue(p.id));
      const decision = stringValue(p.decision, "unknown").toLowerCase();
      const causedBy = byNativeId.get(callId);
      if (!causedBy)
        builder.loss(
          "relation-target-missing",
          "Codex approval did not identify a previously observed tool call",
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
          { itemKind: type, data: redactedJson(p) },
          {
            nativeItemId: `${id}:approval:${line}`,
            ...(timestampValue ? { occurredAt: timestampValue } : {}),
            capture: capture("opaque"),
            actor: { kind: "provider", name: harness },
          },
        );
      }
      return;
    }
    const itemType = stringValue(p.type);
    if (!RESPONSE_ITEMS.has(itemType)) {
      builder.add(
        "provider.opaque",
        value,
        line,
        { nativeItemKind: itemType || "unknown", payload: redactedJson(p) },
        {
          nativeItemId: `opaque:${itemType || "unknown"}:${line}`,
          ...(timestampValue ? { occurredAt: timestampValue } : {}),
          capture: capture("opaque"),
          actor: { kind: "provider", name: harness },
        },
      );
      return;
    }
    const itemId = stringValue(p.id, `${id}:response:${line}`);
    if (itemType === "message" || itemType === "agent_message") {
      const role = stringValue(p.role, stringValue(p.author, "assistant"));
      const reportContentLoss = (
        blockType: string,
        block: Record<string, unknown>,
        index: number,
      ): void => {
        const nativeBlockId = stringValue(block.id, `${itemId}:block:${index}`);
        if (!CONTENT_BLOCKS.has(blockType)) {
          builder.loss(
            "unknown-well-formed-item",
            `Codex content block type ${JSON.stringify(blockType)} was omitted by the adapter`,
            line,
            nativeBlockId,
            { blockType },
          );
          return;
        }
        if (blockType === "encrypted_content") {
          builder.loss(
            "encrypted-content-unavailable",
            "Codex encrypted content is provider-encrypted and was not interpreted",
            line,
            nativeBlockId,
            { blockType },
          );
        } else {
          const code = ["input_image", "image", "computer_screenshot"].includes(blockType)
            ? "attachment-body-excluded"
            : "provider-field-unsupported";
          const reason =
            code === "attachment-body-excluded"
              ? `Codex ${JSON.stringify(blockType)} content block body was not captured`
              : `Codex content block type ${JSON.stringify(blockType)} is not modeled`;
          builder.loss(code, reason, line, nativeBlockId, { blockType });
        }
      };
      const event = builder.add(
        "message.created",
        value,
        line,
        {
          role,
          content: yield* contentText(p.content, source.path, line, reportContentLoss),
          messageId: itemId,
        },
        {
          nativeItemId: itemId,
          ...(timestampValue ? { occurredAt: timestampValue } : {}),
          ...(previous ? { relations: { parent: previous.eventId } } : {}),
          actor: { kind: role === "user" ? "human" : "assistant" },
        },
      );
      remember(itemId, event);
      return;
    }
    if (itemType === "reasoning") {
      const event = builder.add(
        "model.reasoning.observed",
        value,
        line,
        { itemType, encrypted: true, ...(p.summary ? { summary: redactedJson(p.summary) } : {}) },
        {
          nativeItemId: itemId,
          ...(timestampValue ? { occurredAt: timestampValue } : {}),
          ...(previous ? { relations: { parent: previous.eventId } } : {}),
          capture: capture(
            "opaque",
            "Codex reasoning is provider-encrypted and was not interpreted",
          ),
          actor: { kind: "assistant" },
        },
      );
      remember(itemId, event);
      return;
    }
    if (itemType.endsWith("_output")) {
      const callId = stringValue(p.call_id, stringValue(p.id));
      const causedBy = byNativeId.get(callId);
      if (!causedBy)
        builder.loss(
          "relation-target-missing",
          "Codex tool result did not identify a previously observed tool call",
          line,
          callId,
          { relation: "causedBy", target: callId },
        );
      const rawOutput = p.output ?? p.tools ?? p.result ?? "";
      const event = builder.add(
        "tool.result.observed",
        value,
        line,
        {
          callId,
          output: typeof rawOutput === "string" ? redact(rawOutput) : redactedJson(rawOutput),
          ...(p.status ? { status: p.status } : {}),
          ...(p.is_error === true || p.error ? { isError: true } : {}),
        },
        {
          nativeItemId: itemId,
          ...(timestampValue ? { occurredAt: timestampValue } : {}),
          ...(causedBy
            ? { relations: { causedBy: [causedBy.eventId], parent: causedBy.eventId } }
            : {}),
          actor: { kind: "tool", name: callId || itemType },
        },
      );
      remember(itemId, event);
      return;
    }
    const callId = stringValue(p.call_id, stringValue(p.id, itemId));
    const proposed = builder.add(
      "tool.call.proposed",
      value,
      line,
      {
        id: callId,
        callId,
        name: stringValue(p.name, itemType),
        arguments:
          typeof p.arguments === "string"
            ? redact(p.arguments)
            : redactedJson(p.arguments ?? p.input ?? {}),
        toolClass: itemType,
      },
      {
        nativeItemId: itemId,
        ...(timestampValue ? { occurredAt: timestampValue } : {}),
        ...(previous ? { relations: { parent: previous.eventId } } : {}),
        actor: { kind: "assistant", name: stringValue(p.name, itemType) },
      },
    );
    remember(callId, proposed);
    remember(itemId, proposed);
    const executionStatus = status(p.status);
    if (executionStatus) {
      const execution = builder.add(
        "tool.execution.observed",
        value,
        line,
        { callId, status: executionStatus },
        {
          nativeItemId: `${itemId}:execution`,
          ...(timestampValue ? { occurredAt: timestampValue } : {}),
          relations: { causedBy: [proposed.eventId], parent: proposed.eventId },
          actor: { kind: "tool", name: stringValue(p.name, itemType) },
        },
      );
      remember(`${itemId}:execution`, execution);
    }
  });

  const parsed = yield* readJsonLines(source.path, processRecord);
  void fallback;
  return builder.finish(parsed.partialTail, parsed.records);
});

export class CodexAdapter implements SourceAdapter {
  readonly harness = "codex" as const;
  constructor(private readonly root: string) {}
  discover(): Promise<SourceFile[]> {
    return discoverJsonl(this.root, (path) => basename(path).startsWith("rollout"));
  }
  adapt(source: SourceFile): Promise<EventBatch> {
    return Effect.runPromise(adaptSource(this.harness, source));
  }
}
