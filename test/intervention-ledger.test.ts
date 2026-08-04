import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  CONTEXT_EVENT_KINDS,
  type ContextEventInput,
  recordContextEvent,
  recordContextFeedback,
  readContextEvents,
} from "../src/context-events";
import { openTestContextSession } from "./context-session-fixture";

const bundleHash = "b".repeat(64);
const session = "context-session-intervention";

function eventInput(overrides: Partial<ContextEventInput>): ContextEventInput {
  return {
    kind: "context.bundle.proposed",
    contextSessionId: session,
    idempotencyKey: "proposal-1",
    actor: { kind: "system", id: "planner" },
    bundleHash,
    inputEventIds: [],
    inputHashes: [],
    occurredAt: "2026-08-04T00:00:00.000Z",
    ...overrides,
  };
}

test("canonical context states do not imply delivery or acknowledgment", async () => {
  const root = await mkdtemp(join(tmpdir(), "chatlog-intervention-"));
  const proposed = await recordContextEvent(
    root,
    eventInput({
      idempotencyKey: "proposal-1",
      occurredAt: "2026-08-04T00:00:00.000Z",
    }),
  );
  const rendered = await recordContextEvent(
    root,
    eventInput({
      kind: "context.bundle.rendered",
      idempotencyKey: "render-1",
      occurredAt: "2026-08-04T00:00:01.000Z",
    }),
  );
  const acknowledged = await recordContextEvent(
    root,
    eventInput({
      kind: "context.bundle.acknowledged",
      idempotencyKey: "ack-1",
      actor: { kind: "provider", id: "provider-receipt" },
      actorAuthority: "provider",
      providerReported: true,
      occurredAt: "2026-08-04T00:00:02.000Z",
    }),
  );
  expect(proposed.ok).toBe(true);
  expect(rendered.ok).toBe(true);
  expect(acknowledged.ok).toBe(true);
  const rows = await readContextEvents(root, { contextSessionId: session });
  expect(rows.ok).toBe(true);
  if (!rows.ok) return;
  expect(rows.value.map((row) => [row.kind, row.state])).toEqual([
    ["context.bundle.proposed", "proposed"],
    ["context.bundle.rendered", "rendered"],
    ["context.bundle.acknowledged", "acknowledged"],
  ]);
  expect(rows.value[2]?.payload.providerReported).toBe(true);
  expect(rows.value.some((row) => row.state === "emitted")).toBe(false);
  expect(rows.value[1]?.state).not.toBe("acknowledged");
});

test("provider acknowledgment requires explicit provider-reported provenance", async () => {
  const root = await mkdtemp(join(tmpdir(), "chatlog-intervention-authority-"));
  const missingProvenance = await recordContextEvent(
    root,
    eventInput({
      kind: "context.bundle.acknowledged",
      idempotencyKey: "ack-missing-provenance",
      actorAuthority: "provider",
      actor: { kind: "provider", id: "provider" },
    }),
  );
  expect(missingProvenance).toMatchObject({
    ok: false,
    error: {
      code: "invalid-input",
      message: "context.bundle.acknowledged requires providerReported",
    },
  });
  const forgedProvenance = await recordContextEvent(
    root,
    eventInput({
      kind: "context.bundle.emitted",
      idempotencyKey: "emitted-forged-provenance",
      providerReported: true,
    }),
  );
  expect(forgedProvenance).toMatchObject({
    ok: false,
    error: {
      code: "invalid-input",
      message: "providerReported is only valid for context.bundle.acknowledged",
    },
  });
});

test("equal-timestamp context events use canonical lifecycle order", async () => {
  const root = await mkdtemp(join(tmpdir(), "chatlog-intervention-order-"));
  const timestamp = "2026-08-04T00:00:00.000Z";
  await recordContextEvent(
    root,
    eventInput({
      kind: "context.bundle.acknowledged",
      idempotencyKey: "ack-order",
      actorAuthority: "provider",
      actor: { kind: "provider", id: "provider" },
      providerReported: true,
      occurredAt: timestamp,
    }),
  );
  await recordContextEvent(
    root,
    eventInput({
      kind: "context.bundle.rendered",
      idempotencyKey: "render-order",
      occurredAt: timestamp,
    }),
  );
  await recordContextEvent(
    root,
    eventInput({
      kind: "context.bundle.proposed",
      idempotencyKey: "proposed-order",
      occurredAt: timestamp,
    }),
  );
  const rows = await readContextEvents(root, { contextSessionId: session });
  expect(rows.ok).toBe(true);
  if (!rows.ok) return;
  expect(rows.value.map((row) => row.kind)).toEqual([
    "context.bundle.proposed",
    "context.bundle.rendered",
    "context.bundle.acknowledged",
  ]);
});

test("retrying one event preserves one logical event and records all canonical kinds", async () => {
  const root = await mkdtemp(join(tmpdir(), "chatlog-intervention-retry-"));
  const input = eventInput({ idempotencyKey: "retry-1" });
  const first = await recordContextEvent(root, input);
  const retry = await recordContextEvent(root, input);
  expect(first.ok).toBe(true);
  expect(retry.ok).toBe(true);
  if (!first.ok || !retry.ok) return;
  expect(retry.value.idempotent).toBe(true);
  expect(retry.value.event.eventId).toBe(first.value.event.eventId);
  expect(retry.value.batchHash).toBe(first.value.batchHash);
  const rows = await readContextEvents(root, { contextSessionId: session });
  expect(rows.ok).toBe(true);
  if (!rows.ok) return;
  expect(rows.value).toHaveLength(1);
  expect(CONTEXT_EVENT_KINDS).toEqual([
    "context.bundle.proposed",
    "context.bundle.rendered",
    "context.bundle.emitted",
    "context.bundle.acknowledged",
    "context.recall.returned",
    "context.recall.branch.started",
    "context.recall.branch.completed",
    "context.recall.branch.failed",
    "context.recall.branch.cancelled",
    "context.recall.terminated",
    "context.procedure.returned",
    "context.advisor.advice",
    "context.delivery.failed",
    "context.feedback.asserted",
    "context.outcome.observed",
  ]);
});
test("feedback records actor authority without mutating the current session", async () => {
  const root = await mkdtemp(join(tmpdir(), "chatlog-feedback-"));
  const contextSession = await openTestContextSession(root, "feedback-authority");
  const proposal = await recordContextEvent(
    root,
    eventInput({
      contextSessionId: contextSession.contextSessionId,
      idempotencyKey: "feedback-proposal",
    }),
  );
  expect(proposal.ok).toBe(true);
  if (!proposal.ok) return;
  const human = await recordContextFeedback(root, {
    contextSessionId: contextSession.contextSessionId,
    idempotencyKey: "feedback-human",
    actor: { kind: "human", id: "operator" },
    interventionEventId: proposal.value.event.eventId,
    signal: "harmful",
    note: "The item was out of scope.",
  });
  const agent = await recordContextFeedback(root, {
    contextSessionId: contextSession.contextSessionId,
    idempotencyKey: "feedback-agent",
    actor: { kind: "assistant", id: "agent" },
    interventionEventId: proposal.value.event.eventId,
    signal: "helpful",
    note: "It looked useful.",
  });
  expect(human.ok).toBe(true);
  expect(agent.ok).toBe(true);
  const rows = await readContextEvents(root, {
    contextSessionId: contextSession.contextSessionId,
    kinds: ["context.feedback.asserted"],
  });
  expect(rows.ok).toBe(true);
  if (!rows.ok) return;
  expect(rows.value).toHaveLength(2);
  expect(rows.value.map((row) => row.actorAuthority).toSorted()).toEqual(["agent", "human"]);
  expect(rows.value.map((row) => row.payload.feedbackAuthority).toSorted()).toEqual([
    "strong",
    "weak",
  ]);
  expect(rows.value.every((row) => row.kind === "context.feedback.asserted")).toBe(true);
});

test("feedback rejects missing and cross-session references", async () => {
  const root = await mkdtemp(join(tmpdir(), "chatlog-feedback-source-bound-"));
  const contextSession = await openTestContextSession(root, "feedback-source-bound");
  const missing = await recordContextFeedback(root, {
    contextSessionId: contextSession.contextSessionId,
    idempotencyKey: "feedback-missing",
    actor: { kind: "human", id: "operator" },
    interventionEventId: "e".repeat(64),
    signal: "harmful",
  });
  expect(missing.ok).toBe(false);
  if (!missing.ok) expect(missing.error.message).toContain("does not exist");

  const other = await openTestContextSession(root, "feedback-cross-source");
  const source = await recordContextEvent(
    root,
    eventInput({
      contextSessionId: other.contextSessionId,
      idempotencyKey: "feedback-other-source",
    }),
  );
  expect(source.ok).toBe(true);
  if (!source.ok) return;
  const cross = await recordContextFeedback(root, {
    contextSessionId: contextSession.contextSessionId,
    idempotencyKey: "feedback-cross",
    actor: { kind: "human", id: "operator" },
    interventionEventId: source.value.event.eventId,
    signal: "harmful",
  });
  expect(cross.ok).toBe(false);
  if (!cross.ok) expect(cross.error.message).toContain("different context session");
});
