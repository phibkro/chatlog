import {
  canonicalEventBatch,
  sha256,
  type AgentEventEnvelope,
  type AgentEventPayload,
  type EventBatch,
  type EventRelations,
} from "./events";
import { eventBatchHash } from "./event-store";
import type { Conversation, ConversationDomain, TokenUsage, ToolCall, Turn } from "./types";
import { redact } from "./redact";

function payload(value: AgentEventPayload, key: string): unknown {
  return value[key];
}

function stringPayload(value: AgentEventPayload, key: string, fallback = ""): string {
  const candidate = value[key];
  return typeof candidate === "string" ? candidate : fallback;
}

function nonEmptyStringPayload(value: AgentEventPayload, key: string): string | undefined {
  const candidate = value[key];
  return typeof candidate === "string" && candidate ? candidate : undefined;
}

function recordPayload(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function tokensPayload(value: unknown): TokenUsage | undefined {
  const tokenValue = recordPayload(value);
  const keys = ["input", "output", "cachedInput", "cacheWrite", "reasoning", "total"] as const;
  if (!keys.some((key) => typeof tokenValue[key] === "number")) return undefined;
  return Object.fromEntries(
    keys.filter((key) => typeof tokenValue[key] === "number").map((key) => [key, tokenValue[key]]),
  ) as TokenUsage;
}

function sourceFromBatch(batch: EventBatch): {
  provider: string;
  harness: string;
  sourceKind: string;
  sourcePath: string;
  sessionId?: string;
} {
  if (batch.origin.kind === "observed") {
    return {
      provider: batch.origin.source.provider,
      harness: batch.origin.source.harness,
      sourceKind: batch.origin.source.sourceKind,
      sourcePath: batch.origin.source.sourcePath,
      ...(batch.origin.source.nativeSessionId
        ? { sessionId: batch.origin.source.nativeSessionId }
        : {}),
    };
  }
  const event = batch.events.find((item) => item.origin.kind === "observed");
  if (event?.origin.kind === "observed") {
    return {
      provider: event.origin.source.provider,
      harness: event.origin.source.harness,
      sourceKind: event.origin.source.sourceKind,
      sourcePath: event.origin.source.sourcePath,
      ...(event.origin.source.nativeSessionId
        ? { sessionId: event.origin.source.nativeSessionId }
        : {}),
    };
  }
  return {
    provider: "chatlog",
    harness: "chatlog",
    sourceKind: "derived",
    sourcePath: "chatlog://derived",
  };
}

function relationsFor(event: AgentEventEnvelope): EventRelations {
  return event.relations;
}

function payloadCallId(event: AgentEventEnvelope): string | undefined {
  const value = payload(event.payload, "callId") ?? payload(event.payload, "id");
  return typeof value === "string" && value ? value : undefined;
}

function sourceIds(event: AgentEventEnvelope, ...extra: string[]): string[] {
  return [...new Set([event.eventId, ...extra])];
}

function appendCall(
  turn: Turn,
  event: AgentEventEnvelope,
  callsById: Map<string, ToolCall>,
): ToolCall {
  const id = payloadCallId(event);
  const call: ToolCall = {
    ...(id ? { id } : {}),
    name: stringPayload(event.payload, "name", stringPayload(event.payload, "tool", "tool")),
    ...(typeof payload(event.payload, "arguments") === "string"
      ? { arguments: redact(String(payload(event.payload, "arguments"))) }
      : typeof payload(event.payload, "input") === "string"
        ? { arguments: redact(String(payload(event.payload, "input"))) }
        : payload(event.payload, "arguments") !== undefined ||
            payload(event.payload, "input") !== undefined
          ? {
              arguments: redact(
                JSON.stringify(
                  payload(event.payload, "arguments") ?? payload(event.payload, "input"),
                ),
              ),
            }
          : {}),
    sourceEventIds: [event.eventId],
  };
  turn.toolCalls ??= [];
  turn.toolCalls.push(call);
  if (id) callsById.set(id, call);
  return call;
}

function findTargetTurn(
  event: AgentEventEnvelope,
  turnsByEvent: Map<string, Turn>,
  callsById: Map<string, ToolCall>,
): Turn | undefined {
  for (const parent of relationsFor(event).causedBy ?? []) {
    const turn = turnsByEvent.get(parent);
    if (turn) return turn;
  }
  const call = payloadCallId(event) ? callsById.get(payloadCallId(event)!) : undefined;
  if (call) {
    for (const turn of turnsByEvent.values()) if (turn.toolCalls?.includes(call)) return turn;
  }
  return undefined;
}

function addToolLifecycle(
  event: AgentEventEnvelope,
  turnsByEvent: Map<string, Turn>,
  callsById: Map<string, ToolCall>,
  allTurns: Turn[],
): void {
  const id = payloadCallId(event);
  let call = id ? callsById.get(id) : undefined;
  let turn = findTargetTurn(event, turnsByEvent, callsById);
  if (!call && event.kind === "tool.call.proposed") {
    if (!turn) {
      turn = { role: "assistant", content: "", sourceEventIds: [] };
      allTurns.push(turn);
    }
    call = appendCall(turn, event, callsById);
  }
  if (!call) {
    if (event.kind === "tool.result.observed") {
      const standalone = {
        role: "tool",
        content: redact(
          stringPayload(event.payload, "output", stringPayload(event.payload, "result", "")),
        ),
        ...(event.occurredAt ? { at: event.occurredAt } : {}),
        sourceEventIds: [event.eventId],
        toolCalls: [
          {
            ...(id ? { id } : {}),
            name: stringPayload(event.payload, "name", "tool_result"),
            output: redact(
              stringPayload(event.payload, "output", stringPayload(event.payload, "result", "")),
            ),
            result: payload(event.payload, "isError") === true ? "error" : "observed",
            sourceEventIds: [event.eventId],
          },
        ],
      } satisfies Turn;
      allTurns.push(standalone);
    }
    return;
  }
  call.sourceEventIds = sourceIds(event, ...(call.sourceEventIds ?? []));
  if (event.kind === "tool.call.approved") call.approval = "approved";
  if (event.kind === "tool.call.denied") call.approval = "denied";
  if (event.kind === "tool.execution.observed") {
    const status = stringPayload(event.payload, "status", "unknown");
    call.execution = ["started", "succeeded", "failed", "unknown"].includes(status)
      ? (status as ToolCall["execution"])
      : "unknown";
  }
  if (event.kind === "tool.result.observed") {
    const output = payload(event.payload, "output") ?? payload(event.payload, "result");
    if (output !== undefined)
      call.output = redact(typeof output === "string" ? output : JSON.stringify(output));
    call.result = payload(event.payload, "isError") === true ? "error" : "observed";
    if (!turn) {
      turn = [...turnsByEvent.values()].find((candidate) => candidate.toolCalls?.includes(call!));
    }
    if (!turn && call.output) {
      allTurns.push({ role: "tool", content: call.output, sourceEventIds: [event.eventId] });
    }
  }
}

export function canonicalizeConversation(value: Omit<Conversation, "contentHash">): Conversation {
  const scrub = (item: unknown): unknown => {
    if (typeof item === "string") return redact(item);
    if (Array.isArray(item)) return item.map(scrub);
    if (item && typeof item === "object")
      return Object.fromEntries(Object.entries(item).map(([key, child]) => [key, scrub(child)]));
    return item;
  };
  const scrubbed = scrub(value) as Omit<Conversation, "contentHash">;
  const hash = sha256(JSON.stringify(scrubbed));
  return { ...scrubbed, contentHash: hash };
}

function optionalStringField(value: Record<string, unknown>, key: string): boolean {
  return !(key in value) || typeof value[key] === "string";
}

function optionalStringArrayField(value: Record<string, unknown>, key: string): boolean {
  return (
    !(key in value) ||
    (Array.isArray(value[key]) && value[key].every((item) => typeof item === "string"))
  );
}

function validCanonicalTurn(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const turn = value as Record<string, unknown>;
  if (typeof turn.role !== "string" || typeof turn.content !== "string") return false;
  if (!optionalStringField(turn, "at") || !optionalStringArrayField(turn, "sourceEventIds"))
    return false;
  if ("tokens" in turn) {
    const tokens = turn.tokens;
    if (
      !tokens ||
      typeof tokens !== "object" ||
      Array.isArray(tokens) ||
      Object.values(tokens).some((item) => typeof item !== "number" || !Number.isFinite(item))
    )
      return false;
  }
  if ("toolCalls" in turn) {
    if (
      !Array.isArray(turn.toolCalls) ||
      turn.toolCalls.some((callValue) => {
        if (!callValue || typeof callValue !== "object" || Array.isArray(callValue)) return true;
        const call = callValue as Record<string, unknown>;
        return (
          typeof call.name !== "string" ||
          !optionalStringField(call, "id") ||
          !optionalStringField(call, "arguments") ||
          !optionalStringField(call, "output") ||
          !optionalStringField(call, "approval") ||
          !optionalStringField(call, "execution") ||
          !optionalStringField(call, "result") ||
          !optionalStringArrayField(call, "sourceEventIds")
        );
      })
    )
      return false;
  }
  return true;
}

function validCanonicalConversation(value: unknown): value is Conversation {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const conversation = value as Record<string, unknown>;
  if (
    typeof conversation.id !== "string" ||
    typeof conversation.provider !== "string" ||
    typeof conversation.harness !== "string" ||
    typeof conversation.project !== "string" ||
    typeof conversation.cwd !== "string" ||
    typeof conversation.model !== "string" ||
    typeof conversation.startedAt !== "string" ||
    typeof conversation.endedAt !== "string" ||
    typeof conversation.sourcePath !== "string" ||
    typeof conversation.contentHash !== "string" ||
    !Array.isArray(conversation.turns) ||
    conversation.turns.some((turn) => !validCanonicalTurn(turn))
  )
    return false;
  return (
    optionalStringField(conversation, "title") &&
    optionalStringField(conversation, "domain") &&
    optionalStringField(conversation, "sourceKind") &&
    optionalStringField(conversation, "resumeId") &&
    optionalStringField(conversation, "eventBatchHash")
  );
}

export function validateCanonicalConversation(
  value: unknown,
  expected: Pick<Conversation, "contentHash" | "sourcePath">,
): Conversation | null {
  if (
    !validCanonicalConversation(value) ||
    value.contentHash !== expected.contentHash ||
    value.sourcePath !== expected.sourcePath
  )
    return null;
  const { contentHash: _contentHash, ...body } = value;
  try {
    return canonicalizeConversation(body).contentHash === expected.contentHash ? value : null;
  } catch {
    return null;
  }
}

export function projectConversation(input: EventBatch): Conversation {
  const batch = canonicalEventBatch(input);
  const batchHash = eventBatchHash(batch);
  const source = sourceFromBatch(batch);
  const selectedBranch = [...batch.events]
    .filter((event) => event.kind === "branch.selected")
    .map((event) => stringPayload(event.payload, "branchId", event.scope.branchId ?? ""))
    .filter(Boolean)
    .at(-1);
  const events = batch.events.filter(
    (event) => !selectedBranch || !event.scope.branchId || event.scope.branchId === selectedBranch,
  );
  const turns: Turn[] = [];
  const turnsByEvent = new Map<string, Turn>();
  const callsById = new Map<string, ToolCall>();
  let sessionId = source.sessionId ?? "session";
  let domain: ConversationDomain | undefined;
  let project = "";
  let title = "";
  let cwd = "";
  let model = "(unknown)";
  let resumeId: string | undefined;
  let latestEvaluationTokens: TokenUsage | undefined;
  let startedAt: string | undefined;
  let endedAt: string | undefined;
  let provider = source.provider;
  let harness = source.harness;
  let sourceKind = source.sourceKind;
  for (const event of events) {
    const value = event.payload;
    if (event.scope.sessionId) sessionId = event.scope.sessionId;
    if (event.scope.project) project = event.scope.project;
    if (event.scope.cwd) cwd = event.scope.cwd;
    if (event.kind === "session.started") {
      sessionId = stringPayload(value, "sessionId") || stringPayload(value, "id") || sessionId;
      title = nonEmptyStringPayload(value, "title") || title;
      provider = nonEmptyStringPayload(value, "provider") || provider;
      harness = nonEmptyStringPayload(value, "harness") || harness;
      sourceKind = nonEmptyStringPayload(value, "sourceKind") || sourceKind;
      domain = nonEmptyStringPayload(value, "domain") || domain;
      project = nonEmptyStringPayload(value, "project") || project;
      cwd = nonEmptyStringPayload(value, "cwd") || cwd;
      model = nonEmptyStringPayload(value, "model") || model;
      const observedResumeId = nonEmptyStringPayload(value, "resumeId");
      if (observedResumeId) resumeId = observedResumeId;
      else if (harness === "claude-code" && !resumeId && sessionId !== "session")
        resumeId = sessionId;
      startedAt = event.occurredAt ?? startedAt;
      continue;
    }
    if (event.kind === "session.ended") {
      endedAt = event.occurredAt ?? endedAt;
      continue;
    }
    if (event.kind === "message.created") {
      const messageModel = nonEmptyStringPayload(value, "model");
      if (messageModel) model = messageModel;
      const messageResumeId = nonEmptyStringPayload(value, "resumeId");
      if (messageResumeId) resumeId = messageResumeId;
      const messageTokens = tokensPayload(payload(value, "tokens"));
      const turn: Turn = {
        role: stringPayload(
          value,
          "role",
          event.actor.kind === "human" ? "user" : event.actor.kind,
        ),
        content: redact(stringPayload(value, "content", stringPayload(value, "text"))),
        ...(event.occurredAt ? { at: event.occurredAt } : {}),
        ...(messageTokens ? { tokens: messageTokens } : {}),
        sourceEventIds: [event.eventId],
      };
      turns.push(turn);
      turnsByEvent.set(event.eventId, turn);
      continue;
    }
    if (
      event.kind === "tool.call.proposed" ||
      event.kind === "tool.call.approved" ||
      event.kind === "tool.call.denied" ||
      event.kind === "tool.execution.observed" ||
      event.kind === "tool.result.observed"
    ) {
      addToolLifecycle(event, turnsByEvent, callsById, turns);
      continue;
    }
    if (event.kind === "evaluation.recorded") {
      if (stringPayload(value, "evaluationKind") === "token_count") {
        const tokens = tokensPayload(payload(value, "tokens")) ?? tokensPayload(value);
        if (tokens) latestEvaluationTokens = tokens;
      }
      continue;
    }
    if (event.kind === "provider.opaque") {
      const itemKind = nonEmptyStringPayload(value, "itemKind");
      const opaqueModel = nonEmptyStringPayload(value, "model");
      const opaqueProvider = nonEmptyStringPayload(value, "provider");
      const opaqueProject = nonEmptyStringPayload(value, "project");
      const opaqueCwd = nonEmptyStringPayload(value, "cwd");
      if (opaqueModel && (itemKind === "model_change" || itemKind === "turn_context"))
        model = opaqueModel;
      if (opaqueProvider) provider = opaqueProvider;
      if (opaqueProject) project = opaqueProject;
      if (opaqueCwd) cwd = opaqueCwd;
    }
  }

  if (harness === "claude-code" && !resumeId && sessionId !== "session") resumeId = sessionId;
  const tokenTurn =
    [...turns].toReversed().find((turn) => turn.role === "assistant") ?? turns.at(-1);
  if (tokenTurn && latestEvaluationTokens) tokenTurn.tokens = latestEvaluationTokens;

  const timestamps = events
    .map((event) => event.occurredAt)
    .filter((value): value is string => Boolean(value))
    .toSorted();
  startedAt ??= timestamps[0] ?? new Date(0).toISOString();
  endedAt ??= timestamps.at(-1) ?? startedAt;
  const projection: Omit<Conversation, "contentHash"> = {
    id: sessionId,
    ...(title ? { title } : {}),
    sourceKind,
    provider,
    harness,
    ...(domain ? { domain } : {}),
    project,
    cwd,
    model,
    startedAt,
    endedAt,
    turns,
    ...(resumeId ? { resumeId } : {}),
    sourcePath: source.sourcePath,
    eventBatchHash: batchHash,
  };
  return canonicalizeConversation(projection);
}

export const conversationFromEventBatch = projectConversation;
export const projectEventBatch = projectConversation;
