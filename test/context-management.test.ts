import { expect, test } from "bun:test";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { contextPlaneFixture } from "./context-plane-fixture";
import { recordContextEvent } from "../src/context-events";
import { startContextPlaneSession } from "../src/context-plane";
import { createContextSession, openContextSession } from "../src/context-session";
import {
  ContextManagement,
  CONTEXT_MANAGEMENT_LIMITS,
  type ContextManagementView,
} from "../src/workbench/context-management";
import { MAX_CONTEXT_SESSIONS, type ContextSession } from "../src/context-types";
import { WorkbenchData } from "../src/workbench/data";
import { workbenchHandler } from "./workbench-handler";

const HASH = "a".repeat(64);

async function session(
  root: string,
  nativeSessionId: string,
  createdAt: string,
): Promise<ContextSession> {
  const started = await startContextPlaneSession(root, {
    nativeSessionId,
    target: { provider: "openai", harness: "codex", model: "model", role: "coding-agent" },
    projectIdentity: "/project",
    cwd: "/project",
    domainPolicy: ["coding"],
    path: "/project",
    totalBudget: { tokens: 2_000, results: 4, latencyMs: 100, costUsd: 0 },
    createdAt,
  });
  if (!started.ok) throw new Error(started.error.message);
  return started.value;
}

async function fillContextSessionCapacity(root: string): Promise<readonly [string, string]> {
  const directory = join(root, "memory", "context-sessions");
  await mkdir(directory, { recursive: true });
  const clones = Array.from({ length: MAX_CONTEXT_SESSIONS }, (_, index) => {
    const timestamp = new Date(Date.UTC(2026, 7, 3, 0, 0, index)).toISOString();
    const created = createContextSession({
      nativeSessionId: null,
      sessionNonce: `capacity-${index}`,
      provider: "openai",
      harness: "codex",
      model: "model",
      role: "coding-agent",
      projectIdentity: "/project",
      cwd: "/project",
      domainPolicy: ["coding"],
      path: "/project",
      pinnedInsightProjectionHash: HASH,
      pinnedEvidenceProjectionHash: HASH,
      selectionPolicyVersion: "selection-v1",
      deliveryPolicyVersion: "delivery-v1",
      totalBudget: { tokens: 1, results: 1, latencyMs: 1, costUsd: 0 },
      createdAt: timestamp,
    });
    if (!created.ok) throw new Error(created.error.message);
    return {
      contextSessionId: created.value.contextSessionId,
      path: join(directory, `${created.value.contextSessionId}.json`),
      value: created.value,
    };
  });
  await Promise.all(
    clones.map(({ path, value }) => writeFile(path, `${JSON.stringify(value)}\n`, "utf8")),
  );
  return [clones[0]!.contextSessionId, clones[1]!.contextSessionId];
}

async function emittedEvent(root: string, contextSessionId: string, idempotencyKey: string) {
  const emitted = await recordContextEvent(root, {
    kind: "context.bundle.emitted",
    contextSessionId,
    idempotencyKey,
    actor: { kind: "system", id: "test" },
    bundleHash: HASH,
    itemId: "router-lock",
    payload: { receiptEvidence: "tool-result" },
    occurredAt: "2026-08-04T12:00:00.000Z",
  });
  if (!emitted.ok) throw new Error(emitted.error.message);
  return emitted.value.event.eventId;
}

async function emittedEvents(
  root: string,
  contextSessionId: string,
  count: number,
  index = 0,
): Promise<void> {
  if (index >= count) return;
  await emittedEvent(root, contextSessionId, `bounded-view-${index}`);
  return emittedEvents(root, contextSessionId, count, index + 1);
}

test("context session storage reclaims the oldest clean session at its durable cap", async () => {
  const root = await contextPlaneFixture();
  const [oldestContextSessionId] = await fillContextSessionCapacity(root);
  const opened = await openContextSession(root, {
    nativeSessionId: null,
    sessionNonce: "capacity-test",
    provider: "openai",
    harness: "codex",
    model: "model",
    role: "coding-agent",
    projectIdentity: "/project",
    cwd: "/project",
    domainPolicy: ["coding"],
    path: "/project",
    pinnedInsightProjectionHash: HASH,
    pinnedEvidenceProjectionHash: HASH,
    selectionPolicyVersion: "selection-v1",
    deliveryPolicyVersion: "delivery-v1",
    totalBudget: { tokens: 1, results: 1, latencyMs: 1, costUsd: 0 },
    createdAt: "2026-08-04T12:00:00.000Z",
  });
  if (!opened.ok) throw new Error(JSON.stringify(opened.error));
  expect(opened.ok).toBe(true);
  const storedNames = await readdir(join(root, "memory", "context-sessions"));
  expect(storedNames).toHaveLength(MAX_CONTEXT_SESSIONS);
  expect(storedNames).not.toContain(`${oldestContextSessionId}.json`);
  expect(storedNames).toContain(`${opened.value.contextSessionId}.json`);
});
test("context session storage preserves sessions referenced by durable context events", async () => {
  const root = await contextPlaneFixture();
  const [oldestContextSessionId, nextContextSessionId] = await fillContextSessionCapacity(root);
  await emittedEvent(root, oldestContextSessionId, "capacity-protected");
  const oldestPath = join(root, "memory", "context-sessions", `${oldestContextSessionId}.json`);
  const oldest = JSON.parse(await readFile(oldestPath, "utf8")) as ContextSession;
  await writeFile(
    oldestPath,
    `${JSON.stringify({ ...oldest, updatedAt: "2026-08-03T00:00:00.000Z" })}\n`,
    "utf8",
  );

  const opened = await openContextSession(root, {
    nativeSessionId: null,
    sessionNonce: "capacity-event-protection",
    provider: "openai",
    harness: "codex",
    model: "model",
    role: "coding-agent",
    projectIdentity: "/project",
    cwd: "/project",
    domainPolicy: ["coding"],
    path: "/project",
    pinnedInsightProjectionHash: HASH,
    pinnedEvidenceProjectionHash: HASH,
    selectionPolicyVersion: "selection-v1",
    deliveryPolicyVersion: "delivery-v1",
    totalBudget: { tokens: 1, results: 1, latencyMs: 1, costUsd: 0 },
    createdAt: "2026-08-04T12:00:00.000Z",
  });

  if (!opened.ok) throw new Error(JSON.stringify(opened.error));
  const storedNames = await readdir(join(root, "memory", "context-sessions"));
  expect(storedNames).toContain(`${oldestContextSessionId}.json`);
  expect(storedNames).not.toContain(`${nextContextSessionId}.json`);
  expect(storedNames).toContain(`${opened.value.contextSessionId}.json`);
});
test("context session storage preserves an orphaned durable recall result", async () => {
  const root = await contextPlaneFixture();
  const [oldestContextSessionId, nextContextSessionId] = await fillContextSessionCapacity(root);
  const resultDirectory = join(root, "memory", "context-recall-results", oldestContextSessionId);
  await mkdir(resultDirectory, { recursive: true });
  await writeFile(join(resultDirectory, `${HASH}.json`), "{}\n", "utf8");

  const opened = await openContextSession(root, {
    nativeSessionId: null,
    sessionNonce: "capacity-recall-protection",
    provider: "openai",
    harness: "codex",
    model: "model",
    role: "coding-agent",
    projectIdentity: "/project",
    cwd: "/project",
    domainPolicy: ["coding"],
    path: "/project",
    pinnedInsightProjectionHash: HASH,
    pinnedEvidenceProjectionHash: HASH,
    selectionPolicyVersion: "selection-v1",
    deliveryPolicyVersion: "delivery-v1",
    totalBudget: { tokens: 1, results: 1, latencyMs: 1, costUsd: 0 },
    createdAt: "2026-08-04T12:00:00.000Z",
  });

  if (!opened.ok) throw new Error(JSON.stringify(opened.error));
  const storedNames = await readdir(join(root, "memory", "context-sessions"));
  expect(storedNames).toContain(`${oldestContextSessionId}.json`);
  expect(storedNames).not.toContain(`${nextContextSessionId}.json`);
  expect(storedNames).toContain(`${opened.value.contextSessionId}.json`);
});

test("Workbench context GET returns the bounded governed view", async () => {
  const root = await contextPlaneFixture();
  const started = await session(root, "native-context-view", "2026-08-04T12:00:00.000Z");
  const interventionEventId = await emittedEvent(root, started.contextSessionId, "view-emitted");
  const data = new WorkbenchData(root);
  try {
    const response = await workbenchHandler(data)(new Request("http://localhost/api/context"));
    expect(response.status).toBe(200);
    const view = (await response.json()) as ContextManagementView;
    expect(Object.keys(view).toSorted()).toEqual(["insights", "release", "sessions", "totals"]);
    expect(view.release).toBeNull();
    expect(view.insights[0]).toMatchObject({ status: "active", proposition: expect.any(String) });
    expect(view.sessions).toHaveLength(1);
    expect(view.sessions[0]).toMatchObject({
      session: { contextSessionId: started.contextSessionId },
    });
    expect(view.sessions[0].events).toMatchObject([
      { eventId: interventionEventId, kind: "context.bundle.emitted" },
    ]);
    expect(view.totals).toEqual({ sessions: 1, delivered: 1, feedback: 0, outcomes: 0 });
  } finally {
    data.close();
  }
});

test("Workbench context GET counts all events but materializes only the latest bounded slice", async () => {
  const root = await contextPlaneFixture();
  const started = await session(root, "native-context-bounded-view", "2026-08-04T12:00:00.000Z");
  await emittedEvents(root, started.contextSessionId, 101);

  const data = new WorkbenchData(root);
  try {
    const response = await workbenchHandler(data)(new Request("http://localhost/api/context"));
    expect(response.status).toBe(200);
    const view = (await response.json()) as ContextManagementView;
    expect(view.sessions).toHaveLength(1);

    expect(view.sessions[0].events).toHaveLength(100);
    expect(view.totals).toEqual({ sessions: 1, delivered: 101, feedback: 0, outcomes: 0 });
  } finally {
    data.close();
  }
});
test("Workbench context GET keeps exact session totals while retaining only newest sessions", async () => {
  const root = await contextPlaneFixture();
  const created: ContextSession[] = [];
  for (let index = 0; index < CONTEXT_MANAGEMENT_LIMITS.sessions + 5; index += 1)
    created.push(
      await session(
        root,
        `native-context-total-${index}`,
        new Date(Date.UTC(2026, 7, 4, 0, index)).toISOString(),
      ),
    );

  const data = new WorkbenchData(root);
  try {
    const response = await workbenchHandler(data)(new Request("http://localhost/api/context"));
    expect(response.status).toBe(200);
    const view = (await response.json()) as ContextManagementView;
    expect(view.totals.sessions).toBe(created.length);
    expect(view.sessions).toHaveLength(CONTEXT_MANAGEMENT_LIMITS.sessions);
    expect(view.sessions.map(({ session: value }) => value.contextSessionId)).toEqual(
      created
        .toReversed()
        .slice(0, CONTEXT_MANAGEMENT_LIMITS.sessions)
        .map(({ contextSessionId }) => contextSessionId),
    );
  } finally {
    data.close();
  }
});

test("Workbench context feedback reads only the requested session", async () => {
  const root = await contextPlaneFixture();
  const started = await session(
    root,
    "native-context-feedback-bounded",
    "2026-08-04T12:01:00.000Z",
  );
  const interventionEventId = await emittedEvent(
    root,
    started.contextSessionId,
    "feedback-bounded-session",
  );
  await writeFile(join(root, "memory", "context-sessions", `${"f".repeat(64)}.json`), "{malformed");
  const expected = {
    ok: true as const,
    value: {} as ContextManagementView,
  };
  const management = new ContextManagement(root);
  management.get = async () => expected;
  await expect(
    management.feedback({
      contextSessionId: started.contextSessionId,
      interventionEventId,
      signal: "helpful",
      operatorId: "operator",
    }),
  ).resolves.toBe(expected);
});

test("Workbench context GET bounds session provenance arrays", async () => {
  const root = await contextPlaneFixture();
  const started = await session(
    root,
    "native-context-session-provenance",
    "2026-08-04T12:06:00.000Z",
  );
  const sessionPath = join(root, "memory", "context-sessions", `${started.contextSessionId}.json`);
  const stored = JSON.parse(await readFile(sessionPath, "utf8")) as Record<string, unknown>;
  const total = CONTEXT_MANAGEMENT_LIMITS.sessionReferences + 5;
  const hashes = Array.from({ length: total }, (_, index) => index.toString(16).padStart(64, "0"));
  stored.consumedBundleHashes = hashes;
  stored.consumedRecallHashes = hashes;
  stored.consumedRecallInvocations = hashes.map((invocationHash, index) => ({
    invocationId: `invocation-${index}`,
    invocationHash,
    contentHash: invocationHash,
    traceHash: invocationHash,
  }));
  await writeFile(sessionPath, JSON.stringify(stored));

  const data = new WorkbenchData(root);
  try {
    const response = await workbenchHandler(data)(new Request("http://localhost/api/context"));
    expect(response.status).toBe(200);
    const view = (await response.json()) as ContextManagementView;
    const exposed = view.sessions[0]?.session;
    expect(exposed).toBeDefined();
    expect(exposed?.consumedBundleHashes).toEqual(
      hashes.slice(-CONTEXT_MANAGEMENT_LIMITS.sessionReferences),
    );
    expect(exposed?.consumedBundleHashesTotal).toBe(total);
    expect(exposed?.consumedBundleHashesTruncated).toBe(true);
    expect(exposed?.consumedRecallHashes).toEqual(
      hashes.slice(-CONTEXT_MANAGEMENT_LIMITS.sessionReferences),
    );
    expect(exposed?.consumedRecallHashesTotal).toBe(total);
    expect(exposed?.consumedRecallInvocations).toHaveLength(
      CONTEXT_MANAGEMENT_LIMITS.sessionReferences,
    );
    expect(exposed?.consumedRecallInvocationsTotal).toBe(total);
    expect(exposed?.consumedRecallInvocationsTruncated).toBe(true);
    expect(exposed?.pendingEventBatchHashes).toEqual([]);
    expect(exposed?.pendingEventBatchHashesTotal).toBe(0);
    expect(exposed?.pendingEventBatchHashesTruncated).toBe(false);
  } finally {
    data.close();
  }
});

test("Workbench context feedback records human provenance and returns the refreshed view", async () => {
  const root = await contextPlaneFixture();
  const started = await session(root, "native-context-feedback", "2026-08-04T12:01:00.000Z");
  const interventionEventId = await emittedEvent(
    root,
    started.contextSessionId,
    "feedback-emitted",
  );
  const data = new WorkbenchData(root);
  try {
    const response = await workbenchHandler(
      data,
      undefined,
      null,
      false,
      undefined,
      true,
    )(
      new Request("http://localhost/api/context/feedback", {
        method: "POST",
        headers: { "content-type": "application/json", "X-Chatlog-Context": "1" },
        body: JSON.stringify({
          contextSessionId: started.contextSessionId,
          interventionEventId,
          itemId: "router-lock",
          signal: "helpful",
          operatorId: "operator",
        }),
      }),
    );
    expect(response.status).toBe(200);
    const view = (await response.json()) as ContextManagementView;
    expect(view.totals).toMatchObject({ feedback: 1 });
    expect(view.sessions[0].events).toContainEqual(
      expect.objectContaining({
        kind: "context.feedback.asserted",
        actorAuthority: "human",
        payload: expect.objectContaining({ feedbackAuthority: "strong", signal: "helpful" }),
      }),
    );
  } finally {
    data.close();
  }
});

test("Workbench context outcome records a human observation without a causal claim", async () => {
  const root = await contextPlaneFixture();
  const started = await session(root, "native-context-outcome", "2026-08-04T12:01:00.000Z");
  const interventionEventId = await emittedEvent(root, started.contextSessionId, "outcome-emitted");
  const data = new WorkbenchData(root);
  try {
    const response = await workbenchHandler(
      data,
      undefined,
      null,
      false,
      undefined,
      true,
    )(
      new Request("http://localhost/api/context/outcome", {
        method: "POST",
        headers: { "content-type": "application/json", "X-Chatlog-Context": "1" },
        body: JSON.stringify({
          contextSessionId: started.contextSessionId,
          interventionEventId,
          status: "success",
          treatmentArm: "active-insight",
          unresolved: false,
          note: "The delivered context prevented a repeated configuration error.",
          operatorId: "operator",
        }),
      }),
    );
    expect(response.status).toBe(200);
    const view = (await response.json()) as ContextManagementView;
    expect(view.totals).toMatchObject({ outcomes: 1 });
    expect(view.sessions[0].events).toContainEqual(
      expect.objectContaining({
        kind: "context.outcome.observed",
        actorAuthority: "human",
        payload: expect.objectContaining({
          status: "success",
          treatmentArm: "active-insight",
          evidenceGrade: "human-asserted",
          evidenceClassification: "human-asserted",
          causalClaim: false,
          metrics: {
            note: "The delivered context prevented a repeated configuration error.",
          },
        }),
      }),
    );
  } finally {
    data.close();
  }
});

test("Workbench context feedback rejects an intervention from another session", async () => {
  const root = await contextPlaneFixture();
  const first = await session(root, "native-context-first", "2026-08-04T12:02:00.000Z");
  const second = await session(root, "native-context-second", "2026-08-04T12:03:00.000Z");
  const interventionEventId = await emittedEvent(
    root,
    second.contextSessionId,
    "cross-session-emitted",
  );
  const data = new WorkbenchData(root);
  try {
    const response = await workbenchHandler(
      data,
      undefined,
      null,
      false,
      undefined,
      true,
    )(
      new Request("http://localhost/api/context/feedback", {
        method: "POST",
        headers: { "content-type": "application/json", "X-Chatlog-Context": "1" },
        body: JSON.stringify({
          contextSessionId: first.contextSessionId,
          interventionEventId,
          signal: "harmful",
          operatorId: "operator",
        }),
      }),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "intervention event does not belong to the context session",
    });
  } finally {
    data.close();
  }
});

test("Memory Lab write authority does not enable context feedback", async () => {
  const root = await contextPlaneFixture();
  const started = await session(root, "native-context-authority", "2026-08-04T12:04:00.000Z");
  const interventionEventId = await emittedEvent(
    root,
    started.contextSessionId,
    "authority-emitted",
  );
  const data = new WorkbenchData(root);
  try {
    const response = await workbenchHandler(
      data,
      undefined,
      null,
      true,
    )(
      new Request("http://localhost/api/context/feedback", {
        method: "POST",
        headers: { "content-type": "application/json", "X-Chatlog-Context": "1" },
        body: JSON.stringify({
          contextSessionId: started.contextSessionId,
          interventionEventId,
          itemId: "router-lock",
          signal: "helpful",
          operatorId: "operator",
        }),
      }),
    );
    expect(response.status).toBe(403);
  } finally {
    data.close();
  }
});

test("Workbench context feedback rejects an unidentifiable item", async () => {
  const root = await contextPlaneFixture();
  const started = await session(root, "native-context-item", "2026-08-04T12:05:00.000Z");
  const event = await recordContextEvent(root, {
    kind: "context.recall.returned",
    contextSessionId: started.contextSessionId,
    idempotencyKey: "multi-item-recall",
    actor: { kind: "system", id: "test" },
    payload: { evidenceIds: ["evidence-a", "evidence-b"] },
    occurredAt: "2026-08-04T12:05:01.000Z",
  });
  if (!event.ok) throw new Error(event.error.message);
  const data = new WorkbenchData(root);
  try {
    const response = await workbenchHandler(
      data,
      undefined,
      null,
      false,
      undefined,
      true,
    )(
      new Request("http://localhost/api/context/feedback", {
        method: "POST",
        headers: { "content-type": "application/json", "X-Chatlog-Context": "1" },
        body: JSON.stringify({
          contextSessionId: started.contextSessionId,
          interventionEventId: event.value.event.eventId,
          itemId: "invented-item",
          signal: "harmful",
          operatorId: "operator",
        }),
      }),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "feedback item does not belong to the intervention",
    });
  } finally {
    data.close();
  }
});
