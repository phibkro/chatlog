import { expect, test } from "bun:test";
import {
  canonicalEventBatch,
  capture,
  makeEvent,
  makeObservedBatchOrigin,
  makeObservedSource,
  stableStringify,
  validateEventBatch,
  type EventBatch,
} from "../src/events";
import { eventBatchHash, serializeEventBatch } from "../src/event-store";
import { projectConversation } from "../src/conversation-projection";

const sourceBase = {
  provider: "test-provider",
  harness: "test-harness",
  sourceKind: "synthetic",
  sourcePath: "/synthetic/session.jsonl",
  adapterRecipe: "synthetic-v1",
  capturePolicyVersion: "synthetic-redacted-v1",
};
const record = { type: "synthetic", secret: "sk-ant-abcdefghijklmnopqrstuvwxyz" };

function batchWithLifecycle(): EventBatch {
  const events = [] as ReturnType<typeof makeEvent>[];
  const add = (
    kind: ReturnType<typeof makeEvent>["kind"],
    payload: Record<string, unknown>,
    relation: Record<string, unknown> = {},
    nativeId: string,
  ) => {
    const source = makeObservedSource(
      {
        ...sourceBase,
        nativeSessionId: "session-1",
        nativeItemId: nativeId,
        recordPosition: { record: events.length },
      },
      record,
    );
    const event = makeEvent({
      kind,
      sequence: events.length,
      actor: { kind: kind.startsWith("tool") ? "tool" : "assistant" },
      scope: { sessionId: "session-1" },
      origin: { kind: "observed", source },
      relations: relation,
      payload,
      capture: capture("normalized"),
    });
    events.push(event);
    return event;
  };
  const started = add(
    "session.started",
    {
      id: "session-1",
      sessionId: "session-1",
      provider: "test-provider",
      harness: "test-harness",
      model: "test",
      project: "/synthetic",
      cwd: "/synthetic",
    },
    {},
    "session",
  );
  const message = add(
    "message.created",
    { role: "assistant", content: "inspect" },
    { parent: started.eventId },
    "message",
  );
  const proposed = add(
    "tool.call.proposed",
    { callId: "call-1", id: "call-1", name: "shell", arguments: "false" },
    { causedBy: [message.eventId], parent: message.eventId },
    "call",
  );
  const approved = add(
    "tool.call.approved",
    { callId: "call-1" },
    { causedBy: [proposed.eventId], parent: proposed.eventId },
    "approval",
  );
  const execution = add(
    "tool.execution.observed",
    { callId: "call-1", status: "failed" },
    { causedBy: [approved.eventId], parent: approved.eventId },
    "execution",
  );
  add(
    "tool.result.observed",
    { callId: "call-1", output: "exit 1", isError: true },
    { causedBy: [execution.eventId], parent: execution.eventId },
    "result",
  );
  return {
    schemaVersion: 1,
    origin: makeObservedBatchOrigin({ ...sourceBase, nativeSessionId: "session-1" }, [record]),
    events,
    semanticLoss: [],
    partialTail: false,
    sourceItemCount: 1,
  };
}

test("tool proposal, approval, execution, and result remain distinct", () => {
  const batch = validateEventBatch(batchWithLifecycle());
  expect(batch.events.map((event) => event.kind)).toEqual([
    "session.started",
    "message.created",
    "tool.call.proposed",
    "tool.call.approved",
    "tool.execution.observed",
    "tool.result.observed",
  ]);
  const conversation = projectConversation(batch);
  expect(conversation.turns[0]?.toolCalls?.[0]).toMatchObject({
    id: "call-1",
    approval: "approved",
    execution: "failed",
    result: "error",
    output: "exit 1",
  });
});

test("reasoning and opaque events do not become ordinary message content", () => {
  const source = makeObservedSource(
    {
      ...sourceBase,
      nativeSessionId: "session-2",
      nativeItemId: "session",
      recordPosition: { record: 0 },
    },
    record,
  );
  const started = makeEvent({
    kind: "session.started",
    sequence: 0,
    actor: { kind: "provider" },
    scope: { sessionId: "session-2" },
    origin: { kind: "observed", source },
    relations: {},
    payload: {
      id: "session-2",
      sessionId: "session-2",
      provider: "test-provider",
      harness: "test-harness",
      model: "test",
      project: "/synthetic",
      cwd: "/synthetic",
    },
    capture: capture("normalized"),
  });
  const messageSource = makeObservedSource(
    {
      ...sourceBase,
      nativeSessionId: "session-2",
      nativeItemId: "message",
      recordPosition: { record: 1 },
    },
    record,
  );
  const message = makeEvent({
    kind: "message.created",
    sequence: 1,
    actor: { kind: "human" },
    scope: { sessionId: "session-2" },
    origin: { kind: "observed", source: messageSource },
    relations: { parent: started.eventId },
    payload: { role: "user", content: "visible" },
    capture: capture("normalized"),
  });
  const reasoningSource = makeObservedSource(
    {
      ...sourceBase,
      nativeSessionId: "session-2",
      nativeItemId: "reasoning",
      recordPosition: { record: 2 },
    },
    record,
  );
  const reasoning = makeEvent({
    kind: "model.reasoning.observed",
    sequence: 2,
    actor: { kind: "assistant" },
    scope: { sessionId: "session-2" },
    origin: { kind: "observed", source: reasoningSource },
    relations: { parent: message.eventId },
    payload: { text: "private" },
    capture: capture("normalized"),
  });
  const opaqueSource = makeObservedSource(
    {
      ...sourceBase,
      nativeSessionId: "session-2",
      nativeItemId: "opaque",
      recordPosition: { record: 3 },
    },
    record,
  );
  const opaque = makeEvent({
    kind: "provider.opaque",
    sequence: 3,
    actor: { kind: "provider" },
    scope: { sessionId: "session-2" },
    origin: { kind: "observed", source: opaqueSource },
    relations: { parent: reasoning.eventId },
    payload: { data: "opaque" },
    capture: capture("opaque"),
  });
  const batch = {
    schemaVersion: 1,
    origin: makeObservedBatchOrigin({ ...sourceBase, nativeSessionId: "session-2" }, [record]),
    events: [started, message, reasoning, opaque],
    semanticLoss: [],
    partialTail: false,
    sourceItemCount: 1,
  } satisfies EventBatch;
  const conversation = projectConversation(batch);
  expect(conversation.turns).toHaveLength(1);
  expect(conversation.turns[0]?.content).toBe("visible");
});

test("event bytes, IDs, and batch invariants are deterministic", () => {
  const first = batchWithLifecycle();
  const second = batchWithLifecycle();
  expect(serializeEventBatch(first)).toBe(serializeEventBatch(second));
  expect(eventBatchHash(first)).toBe(eventBatchHash(second));
  const canonical = canonicalEventBatch(first);
  expect(canonicalEventBatch(canonical)).toBe(canonical);
  expect(stableStringify({ á: 4, a: 3, _: 2, A: 1 })).toBe('{"A":1,"_":2,"a":3,"á":4}');
  expect(validateEventBatch({ ...first, partialTail: true }).partialTail).toBe(true);
  expect(() =>
    validateEventBatch({
      ...first,
      events: [{ ...first.events[0], occurredAt: "not-a-timestamp" }, ...first.events.slice(1)],
    }),
  ).toThrow("ISO timestamp");
  expect(() =>
    validateEventBatch({
      ...first,
      events: [
        { ...first.events[0], payload: { ...first.events[0]!.payload, id: "tampered" } },
        ...first.events.slice(1),
      ],
    }),
  ).toThrow("canonical event identity");
  expect(() =>
    validateEventBatch({
      ...first,
      events: [{ ...first.events[0], kind: "unknown.kind" }, ...first.events.slice(1)],
    }),
  ).toThrow("unknown");
  const firstOrigin = first.events[0]!.origin;
  const secondEvent = first.events[1]!;
  if (firstOrigin.kind !== "observed" || secondEvent.origin.kind !== "observed")
    throw new Error("synthetic events must have observed origins");
  const {
    eventId: _danglingId,
    schemaVersion: _danglingSchema,
    ...danglingInput
  } = {
    ...secondEvent,
    relations: { parent: "f".repeat(64) },
  };
  const dangling = makeEvent(danglingInput);
  expect(() =>
    validateEventBatch({
      ...first,
      events: [first.events[0]!, dangling, ...first.events.slice(2)],
    }),
  ).toThrow("dangling");
  const {
    eventId: _eventId,
    schemaVersion: _schemaVersion,
    ...duplicateInput
  } = {
    ...secondEvent,
    origin: {
      ...secondEvent.origin,
      source: {
        ...secondEvent.origin.source,
        nativeItemId: firstOrigin.source.nativeItemId,
      },
    },
  };
  const duplicateNativeId = makeEvent(duplicateInput);
  expect(() =>
    validateEventBatch({
      ...first,
      events: [first.events[0]!, duplicateNativeId, ...first.events.slice(2)],
    }),
  ).toThrow("duplicate native item id");
});
