import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { indexEventBatch, openAnalysis } from "../src/analysis";
import {
  authorizeContextRelease,
  readAuthorizedContextRelease,
  resolveContextReleaseEvidence,
} from "../src/context-release";
import { stageContextEvent } from "../src/context-events";
import { readEventBatch, persistEventBatch } from "../src/event-store";
import { makeEvent } from "../src/events";
import { withContextFinalizationLock } from "../src/lock";
import { sourceBoundKeepGate } from "./context-gate-fixture";

test("only a source-bound keep gate becomes the operator-authorized release", async () => {
  const root = await mkdtemp(join(tmpdir(), "chatlog-context-release-"));
  const gate = await sourceBoundKeepGate(root);
  const authorized = await authorizeContextRelease(root, gate, "2026-08-03T12:01:00.000Z");
  if (!authorized.ok) throw new Error(JSON.stringify(authorized.error));
  expect(authorized.value.pointer.gateHash).toHaveLength(64);
  const current = await readAuthorizedContextRelease(root);
  expect(current).toEqual(authorized);
});
test("release authorization waits for context finalization custody", async () => {
  const root = await mkdtemp(join(tmpdir(), "chatlog-context-release-lock-"));
  const gate = await sourceBoundKeepGate(root);
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const holder = withContextFinalizationLock(root, async () => {
    entered.resolve();
    await release.promise;
  });
  await entered.promise;
  const authorization = authorizeContextRelease(root, gate, "2026-08-03T12:01:15.000Z");
  await Bun.sleep(20);
  expect(await readAuthorizedContextRelease(root)).toMatchObject({
    ok: false,
    error: { code: "not-authorized" },
  });
  release.resolve();
  await holder;
  expect(await authorization).toMatchObject({ ok: true });
});

test("release evidence resolves provider-native session bindings", async () => {
  const root = await mkdtemp(join(tmpdir(), "chatlog-context-release-native-"));
  const gate = await sourceBoundKeepGate(root, "candidate-native", "c".repeat(64), true);
  const authorized = await authorizeContextRelease(root, gate, "2026-08-03T12:01:30.000Z");
  expect(authorized.ok).toBe(true);
});
test("release evidence rejects a payload session that differs from canonical event scope", async () => {
  const root = await mkdtemp(join(tmpdir(), "chatlog-context-release-scope-"));
  const gate = await sourceBoundKeepGate(root);
  const target = gate.pairs[0]!.control.outcome;
  const batch = await readEventBatch(root, target.batchHash);
  const event = batch.events.find((candidate) => candidate.eventId === target.eventId)!;
  const forgedEvent = makeEvent({
    kind: event.kind,
    sequence: event.sequence,
    ...(event.occurredAt ? { occurredAt: event.occurredAt } : {}),
    ...(event.observedAt ? { observedAt: event.observedAt } : {}),
    actor: event.actor,
    scope: { ...event.scope, sessionId: "f".repeat(64) },
    origin: event.origin,
    relations: event.relations,
    payload: event.payload,
    capture: event.capture,
  });
  const forgedBatch = { ...batch, events: [forgedEvent] };
  const batchHash = await persistEventBatch(root, forgedBatch);
  const db = openAnalysis(join(root, "analysis", "chatlog.sqlite"));
  try {
    indexEventBatch(db, forgedBatch, batchHash);
  } finally {
    db.close();
  }

  expect(
    await resolveContextReleaseEvidence(root, { batchHash, eventId: forgedEvent.eventId }),
  ).toMatchObject({ ok: false });
});
test("release evidence rejects a staged context event that was never canonically published", async () => {
  const root = await mkdtemp(join(tmpdir(), "chatlog-context-release-staged-"));
  const gate = await sourceBoundKeepGate(root);
  const treatment = gate.pairs[0]!.treatment;
  const staged = await stageContextEvent(root, {
    kind: "context.bundle.emitted",
    contextSessionId: treatment.contextSessionId,
    idempotencyKey: "unpublished-treatment",
    actor: { kind: "system", id: "context-plane" },
    bundleHash: "a".repeat(64),
    occurredAt: "2026-08-04T00:00:09.000Z",
    itemId: gate.candidate.id,
    candidateContentHash: gate.candidate.contentHash,
  });
  if (!staged.ok) throw new Error(JSON.stringify(staged.error));

  expect(
    await resolveContextReleaseEvidence(root, {
      batchHash: staged.value.batchHash,
      eventId: staged.value.event.eventId,
    }),
  ).toMatchObject({ ok: false });
});

test("does not install a keep artifact whose metrics are fabricated", async () => {
  const root = await mkdtemp(join(tmpdir(), "chatlog-context-release-fabricated-"));
  const valid = await sourceBoundKeepGate(root);
  const fabricated = {
    ...valid,
    pairs: valid.pairs.map((pair) => ({
      ...pair,
      treatment: {
        ...pair.treatment,
        rederivationCount: 0,
        tokensToGate: 1,
      },
    })),
  };
  const authorization = await authorizeContextRelease(root, fabricated, "2026-08-03T12:02:00.000Z");
  expect(authorization).toMatchObject({ ok: false, error: { code: "invalid-gate" } });
  expect(await readAuthorizedContextRelease(root)).toMatchObject({
    ok: false,
    error: { code: "not-authorized" },
  });
});
