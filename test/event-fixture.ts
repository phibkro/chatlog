import {
  EVENT_ADAPTER_RECIPE,
  EVENT_CAPTURE_POLICY_VERSION,
  capture,
  makeEvent,
  makeObservedBatchOrigin,
  makeObservedSource,
  type AgentEventEnvelope,
  type EventBatch,
  type EventRelations,
} from "../src/events";
import type { Conversation } from "../src/types";

export function syntheticEventBatch(
  conversation: Omit<Conversation, "contentHash">,
  partialTail = false,
): EventBatch {
  const sourceBase = {
    provider: conversation.provider,
    harness: conversation.harness,
    sourceKind: conversation.sourceKind ?? "synthetic-session",
    nativeSessionId: conversation.id,
    sourcePath: conversation.sourcePath,
    adapterRecipe: `${EVENT_ADAPTER_RECIPE}:synthetic-test`,
    capturePolicyVersion: EVENT_CAPTURE_POLICY_VERSION,
  };
  const records = [conversation, ...conversation.turns];
  const events: AgentEventEnvelope[] = [];
  const add = (
    kind: AgentEventEnvelope["kind"],
    payload: Record<string, unknown>,
    recordIndex: number,
    occurredAt: string | undefined,
    relations: EventRelations = {},
    actor: AgentEventEnvelope["actor"] = { kind: "provider", name: conversation.harness },
  ): AgentEventEnvelope => {
    const event = makeEvent({
      kind,
      sequence: events.length,
      ...(occurredAt ? { occurredAt } : {}),
      actor,
      scope: {
        sessionId: conversation.id,
        project: conversation.project,
        cwd: conversation.cwd,
      },
      origin: {
        kind: "observed",
        source: makeObservedSource(
          {
            ...sourceBase,
            nativeItemId: `${conversation.id}:${recordIndex}:${events.length}`,
            recordPosition: { record: recordIndex },
          },
          records[recordIndex],
        ),
      },
      relations,
      payload,
      capture: capture("normalized"),
    });
    events.push(event);
    return event;
  };

  const started = add(
    "session.started",
    {
      id: conversation.id,
      sessionId: conversation.id,
      ...(conversation.title ? { title: conversation.title } : {}),
      provider: conversation.provider,
      harness: conversation.harness,
      ...(conversation.domain ? { domain: conversation.domain } : {}),
      sourceKind: conversation.sourceKind ?? "synthetic-session",
      project: conversation.project,
      cwd: conversation.cwd,
      model: conversation.model,
      ...(conversation.resumeId ? { resumeId: conversation.resumeId } : {}),
    },
    0,
    conversation.startedAt,
  );
  let previous = started.eventId;
  for (const [turnIndex, turn] of conversation.turns.entries()) {
    const message = add(
      "message.created",
      {
        role: turn.role,
        content: turn.content,
        ...(turn.tokens ? { tokens: turn.tokens } : {}),
      },
      turnIndex + 1,
      turn.at,
      { parent: previous },
      {
        kind:
          turn.role === "user"
            ? "human"
            : turn.role === "assistant"
              ? "assistant"
              : turn.role === "tool"
                ? "tool"
                : "unknown",
      },
    );
    previous = message.eventId;
  }
  add(
    "session.ended",
    { id: conversation.id },
    Math.max(0, records.length - 1),
    conversation.endedAt,
    { parent: previous },
  );

  return {
    schemaVersion: 1,
    origin: makeObservedBatchOrigin(sourceBase, records),
    events,
    semanticLoss: [],
    partialTail,
    sourceItemCount: records.length,
  };
}
