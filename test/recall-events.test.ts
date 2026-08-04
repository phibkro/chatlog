import { expect, test } from "bun:test";
import { Effect } from "effect";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openAnalysis } from "../src/analysis";
import { consolidateRecall } from "../src/recall-consolidation";
import type { ContextSession } from "../src/context-types";
import {
  MAX_CONTEXT_EVENT_RECORD_DEPTH,
  MAX_CONTEXT_EVENT_RECORD_STRING,
  readContextEvents,
  stageContextEvent,
} from "../src/context-events";
import {
  MAX_STAGED_RECALL_EVENT_BATCHES,
  MAX_CONTEXT_RECALL_INVOCATIONS,
  commitContextRecallBudget,
  openContextSession,
  readContextSession,
} from "../src/context-session";
import { readEventBatch } from "../src/event-store";
import { createRecordedRecallRuntime } from "../src/recall-events";
import {
  MAX_RECALL_VECTOR_ITEMS,
  RecallError,
  type RecallBranchObservation,
  type RecallBranchContext,
  type RecallRequest,
} from "../src/recall-runtime";
import { FakeRecallClock } from "./recall-clock";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
async function persistedBatchHashes(root: string): Promise<string[]> {
  try {
    const prefixes = await readdir(join(root, "corpus", "events"));
    const nested = await Promise.all(
      prefixes.map(async (prefix) => readdir(join(root, "corpus", "events", prefix))),
    );
    return nested
      .flatMap((files) =>
        files.filter((name) => name.endsWith(".json")).map((name) => name.slice(0, -5)),
      )
      .toSorted();
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")
      return [];
    throw error;
  }
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "chatlog-recall-events-"));
  openAnalysis(join(root, "analysis", "chatlog.sqlite")).close();
  const opened = await openContextSession(root, {
    nativeSessionId: "native-recall",
    provider: "openai",
    harness: "codex",
    model: "model",
    role: "coding-agent",
    projectIdentity: "/repo",
    cwd: "/repo",
    domainPolicy: ["coding"],
    path: "/repo",
    pinnedInsightProjectionHash: HASH_A,
    pinnedEvidenceProjectionHash: HASH_B,
    selectionPolicyVersion: "selection-v1",
    deliveryPolicyVersion: "delivery-v1",
    totalBudget: { tokens: 1_000, results: 10, latencyMs: 1_000, costUsd: 0 },
    createdAt: "2026-08-03T10:00:00.000Z",
  });
  if (!opened.ok) throw new Error(opened.error.message);
  return { root, session: opened.value };
}
function emptyRecallResult(session: ContextSession) {
  const budget = {
    maxDepth: 0,
    maxBranches: 0,
    maxQueries: 0,
    maxResults: 0,
    maxTokens: 0,
    maxLatencyMs: 0,
    maxCostUsd: 0,
  };
  return consolidateRecall([], {
    totalBudget: budget,
    consumedBudget: budget,
    remainingBudget: budget,
    scope: {
      user: null,
      organization: null,
      domain: "coding",
      project: session.projectIdentity,
      repository: session.projectIdentity,
      provider: session.target.provider,
      harness: session.target.harness,
      model: session.target.model,
      path: session.path,
      tool: null,
      itemPermissions: [],
    },
    terminationReason: "budget-exhausted",
  });
}

function request(contextSessionId: string): RecallRequest {
  return {
    invocationId: "test-invocation",
    contextSessionId,
    query: "repair compiler",
    scope: {
      domain: "coding",
      project: "/repo",
      provider: "openai",
      harness: "codex",
      path: "/repo",
    },
    budget: {
      maxDepth: 1,
      maxBranches: 1,
      maxQueries: 1,
      maxResults: 2,
      maxTokens: 100,
      maxLatencyMs: 20,
      maxCostUsd: 0,
    },
  };
}
test("recorded recall refuses invocations beyond the durable session cap", async () => {
  const { root, session } = await fixture();
  const sessionPath = join(root, "memory", "context-sessions", `${session.contextSessionId}.json`);
  const stored = JSON.parse(await readFile(sessionPath, "utf8")) as Record<string, unknown>;
  const invocations = Array.from({ length: MAX_CONTEXT_RECALL_INVOCATIONS }, (_, index) => {
    const hash = index.toString(16).padStart(64, "0");
    return {
      invocationId: `prior-${index}`,
      invocationHash: hash,
      contentHash: hash,
      traceHash: hash,
    };
  });
  await writeFile(
    sessionPath,
    `${JSON.stringify(
      {
        ...stored,
        consumedRecallHashes: invocations.map((invocation) => invocation.contentHash),
        consumedRecallInvocations: invocations,
      },
      null,
      2,
    )}\n`,
  );
  const runtime = createRecordedRecallRuntime(root, {
    adapters: [
      {
        id: "never-run",
        run: () =>
          Effect.succeed({
            ok: true as const,
            branchId: "never-run",
            evidence: [],
          }),
      },
    ],
    clock: new FakeRecallClock(),
  });
  await expect(
    Effect.runPromise(
      runtime.recall({ ...request(session.contextSessionId), invocationId: "overflow" }),
    ),
  ).rejects.toMatchObject({
    code: "invalid-request",
    message: `context session recall invocations are limited to ${MAX_CONTEXT_RECALL_INVOCATIONS}`,
  });
  const events = await readContextEvents(root, {
    contextSessionId: session.contextSessionId,
  });
  if (!events.ok) throw new Error(events.error.message);
  expect(events.value).toHaveLength(0);
});

test("recorded recall requires a live parent session before a branch starts", async () => {
  const root = await mkdtemp(join(tmpdir(), "chatlog-recall-events-missing-"));
  openAnalysis(join(root, "analysis", "chatlog.sqlite")).close();
  let calls = 0;
  const runtime = createRecordedRecallRuntime(root, {
    adapters: [
      () => {
        calls += 1;
        return { ok: true, branchId: "lexical" };
      },
    ],
  });

  await expect(Effect.runPromise(runtime.recall(request("c".repeat(64))))).rejects.toMatchObject({
    code: "persistence-error",
    retryable: true,
    phase: "parent-read",
  });
  expect(calls).toBe(0);
});

test("recorded recall rejects malformed vectors before any event is staged", async () => {
  const { root, session } = await fixture();
  const runtime = createRecordedRecallRuntime(root, {
    adapters: [() => ({ ok: true, branchId: "unused" })],
  });
  const malformed: readonly Partial<RecallRequest>[] = [
    { queryAncestry: {} as never },
    { adapters: {} as never },
    {
      visitedEvidenceIds: Array.from(
        { length: MAX_RECALL_VECTOR_ITEMS + 1 },
        (_, index) => `evidence-${index}`,
      ),
    },
  ];
  for (const input of malformed) {
    const rejected = await Effect.runPromise(
      runtime.recall({ ...request(session.contextSessionId), ...input }),
    ).then(
      () => null,
      (error: unknown) => error,
    );
    expect(rejected).toBeInstanceOf(RecallError);
    expect((rejected as RecallError).code).toBe("invalid-request");
  }
  const events = await readContextEvents(root, {
    contextSessionId: session.contextSessionId,
  });
  expect(events).toMatchObject({ ok: true, value: [] });
  expect(await persistedBatchHashes(root)).toEqual([]);
});

test("a pre-finalization guard prevents recall debit and event publication", async () => {
  const { root, session } = await fixture();
  const runtime = createRecordedRecallRuntime(root, {
    beforeFinalize: async () =>
      new RecallError("finalization-error", "projection pins changed", { phase: "debit" }),
    adapters: [
      {
        id: "lexical",
        run: (context) => ({
          ok: true,
          branchId: context.branchId,
          evidence: [
            {
              id: "evidence-1",
              reference: `chatlog://event/${HASH_A}/${HASH_B}`,
              support: [HASH_A],
              scope: context.scope,
            },
          ],
          tokens: 8,
        }),
      },
    ],
  });
  const rejected = await Effect.runPromise(runtime.recall(request(session.contextSessionId))).then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(rejected).toMatchObject({
    code: "finalization-error",
    phase: "debit",
    message: "projection pins changed",
  });
  const stored = await readContextSession(root, session.contextSessionId);
  if (!stored.ok) throw new Error(stored.error.message);
  expect(stored.value.budget).toEqual(session.budget);
  expect(stored.value.consumedRecallInvocations).toEqual([]);
  expect(
    await readContextEvents(root, { contextSessionId: session.contextSessionId }),
  ).toMatchObject({ ok: true, value: [] });
  expect(await persistedBatchHashes(root)).toEqual([]);
});
test("global event recovery does not publish recall batches without a durable result", async () => {
  const { root, session } = await fixture();
  const staged = await stageContextEvent(root, {
    kind: "context.recall.returned",
    contextSessionId: session.contextSessionId,
    idempotencyKey: "orphaned-recall-return",
    actor: { kind: "system", id: "test" },
    payload: {
      invocationId: "orphaned-invocation",
      invocationHash: HASH_A,
      contentHash: HASH_A,
      traceHash: HASH_B,
    },
  });
  if (!staged.ok) throw new Error(staged.error.message);
  const malformed = await stageContextEvent(root, {
    kind: "context.recall.returned",
    contextSessionId: session.contextSessionId,
    idempotencyKey: "identity-free-recall-return",
    actor: { kind: "system", id: "test" },
    payload: {},
  });
  if (!malformed.ok) throw new Error(malformed.error.message);
  const other = await openContextSession(root, {
    nativeSessionId: "other-outbox-session",
    provider: session.target.provider,
    harness: session.target.harness,
    model: session.target.model,
    role: session.target.role,
    projectIdentity: session.projectIdentity,
    cwd: session.cwd,
    domainPolicy: [...session.domainPolicy],
    path: session.path,
    pinnedInsightProjectionHash: session.pinnedInsightProjectionHash,
    pinnedEvidenceProjectionHash: session.pinnedEvidenceProjectionHash,
    selectionPolicyVersion: session.selectionPolicyVersion,
    deliveryPolicyVersion: session.deliveryPolicyVersion,
    totalBudget: session.budget.total,
    createdAt: "2026-08-03T10:00:00.500Z",
  });
  if (!other.ok) throw new Error(other.error.message);
  const crossSession = await stageContextEvent(root, {
    kind: "context.bundle.emitted",
    contextSessionId: other.value.contextSessionId,
    idempotencyKey: "cross-session-bundle",
    actor: { kind: "system", id: "test" },
    bundleHash: HASH_A,
    payload: {},
  });
  if (!crossSession.ok) throw new Error(crossSession.error.message);
  const pendingEventBatchHashes = [
    staged.value.batchHash,
    malformed.value.batchHash,
    crossSession.value.batchHash,
  ];
  const sessionPath = join(root, "memory", "context-sessions", `${session.contextSessionId}.json`);
  const stored = JSON.parse(await readFile(sessionPath, "utf8")) as Record<string, unknown>;
  await writeFile(
    sessionPath,
    `${JSON.stringify({ ...stored, pendingEventBatchHashes })}\n`,
    "utf8",
  );

  expect(
    await readContextEvents(root, { contextSessionId: session.contextSessionId }),
  ).toMatchObject({ ok: true, value: [] });
  expect(
    await readContextEvents(root, {
      contextSessionId: other.value.contextSessionId,
      recoverPending: false,
    }),
  ).toMatchObject({ ok: true, value: [] });
  const recovered = JSON.parse(await readFile(sessionPath, "utf8")) as {
    pendingEventBatchHashes: string[];
  };
  expect(recovered.pendingEventBatchHashes).toEqual(pendingEventBatchHashes);
  let calls = 0;
  const runtime = createRecordedRecallRuntime(root, {
    clock: new FakeRecallClock(Date.parse("2026-08-03T10:00:01.000Z")),
    adapters: [
      {
        id: "lexical",
        run: (context) => ({
          ok: true,
          branchId: context.branchId,
          evidence: [{ id: `evidence-${++calls}`, scope: context.scope }],
          tokens: 1,
        }),
      },
    ],
  });
  const first = await Effect.runPromise(runtime.recall(request(session.contextSessionId)));
  const replay = await Effect.runPromise(runtime.recall(request(session.contextSessionId)));
  expect(replay.contentHash).toBe(first.contentHash);
  expect(calls).toBe(1);
  const afterFinalization = JSON.parse(await readFile(sessionPath, "utf8")) as {
    pendingEventBatchHashes: string[];
  };
  expect(afterFinalization.pendingEventBatchHashes).toEqual(pendingEventBatchHashes);
});

test("rejects nested and oversized context payloads before persistence", async () => {
  const { root, session } = await fixture();
  let nested: Record<string, unknown> = {};
  for (let index = 0; index <= MAX_CONTEXT_EVENT_RECORD_DEPTH; index += 1)
    nested = { child: nested };
  const inputs = [
    {
      idempotencyKey: "nested-payload",
      payload: { nested },
    },
    {
      idempotencyKey: "oversized-payload",
      payload: { text: "x".repeat(MAX_CONTEXT_EVENT_RECORD_STRING + 1) },
    },
  ] as const;
  for (const candidate of inputs) {
    const staged = await stageContextEvent(root, {
      kind: "context.recall.returned",
      contextSessionId: session.contextSessionId,
      idempotencyKey: candidate.idempotencyKey,
      actor: { kind: "system", id: "test" },
      payload: candidate.payload,
    });
    expect(staged.ok).toBe(false);
    if (!staged.ok) expect(staged.error.code).toBe("invalid-input");
  }
  const events = await readContextEvents(root, {
    contextSessionId: session.contextSessionId,
  });
  expect(events).toMatchObject({ ok: true, value: [] });
  expect(await persistedBatchHashes(root)).toEqual([]);
});
test("recorded recall persists bounded lifecycle events with Chatlog provenance", async () => {
  const { root, session } = await fixture();
  const clock = new FakeRecallClock(Date.parse("2026-08-03T10:00:01.000Z"));
  let adapterCalls = 0;
  const runtime = createRecordedRecallRuntime(root, {
    clock,
    adapters: [
      {
        id: "lexical",
        run: (context) => ({
          ok: true,
          branchId: context.branchId,
          evidence: [
            {
              id: `evidence-${(adapterCalls += 1)}`,
              reference: `chatlog://event/${HASH_A}/${HASH_B}`,
              support: [HASH_A],
              scope: context.scope,
            },
          ],
          tokens: 8,
        }),
      },
    ],
  });

  const [first, second] = await Promise.all([
    Effect.runPromise(runtime.recall(request(session.contextSessionId))),
    Effect.runPromise(runtime.recall(request(session.contextSessionId))),
  ]);
  expect(second.contentHash).toBe(first.contentHash);
  expect(second.trace.contentHash).toBe(first.trace.contentHash);
  const updatedSession = await readContextSession(root, session.contextSessionId);
  if (!updatedSession.ok) throw new Error(updatedSession.error.message);
  expect(updatedSession.value.budget.remaining).toEqual({
    tokens: 992,
    results: 9,
    latencyMs: 1_000,
    costUsd: 0,
  });
  expect(updatedSession.value.consumedRecallHashes).toHaveLength(1);
  expect(updatedSession.value.consumedRecallHashes[0]).not.toBe(first.contentHash);
  expect(updatedSession.value.consumedRecallInvocations).toEqual([
    {
      invocationId: "test-invocation",
      invocationHash: updatedSession.value.consumedRecallHashes[0],
      contentHash: first.contentHash,
      traceHash: first.trace.contentHash,
      lifecycleTimestampFloor: session.updatedAt,
    },
  ]);

  const events = await readContextEvents(root, { contextSessionId: session.contextSessionId });
  if (!events.ok) throw new Error(events.error.message);
  expect(events.value.map((event) => event.kind).toSorted()).toEqual([
    "context.recall.branch.completed",
    "context.recall.branch.started",
    "context.recall.returned",
    "context.recall.terminated",
  ]);
  const returned = events.value.find((event) => event.kind === "context.recall.returned");
  expect(returned?.payload).toMatchObject({
    contentHash: first.contentHash,
    terminationReason: "sufficient-evidence",
    evidenceIds: first.evidence.map((evidence) => evidence.id),
  });
  expect(returned?.payload).not.toHaveProperty("answer");

  const batches = await Promise.all(
    events.value.map((projected) => readEventBatch(root, projected.batchHash)),
  );
  for (const batch of batches) {
    expect(batch.origin.kind).toBe("chatlog");
    expect(batch.events[0]?.origin.kind).toBe("chatlog");
  }
});
test("post-commit outbox recovery uses the invocation timestamp floor", async () => {
  const { root, session } = await fixture();
  const clock = new FakeRecallClock(Date.parse("2026-08-03T10:00:01.000Z"));
  const runtime = createRecordedRecallRuntime(root, {
    clock,
    adapters: [
      {
        id: "advancing",
        run: (context) => {
          clock.advance(5);
          return {
            ok: true as const,
            branchId: context.branchId,
            evidence: [{ id: "evidence-advancing", scope: context.scope }],
            tokens: 1,
          };
        },
      },
    ],
  });
  await Effect.runPromise(runtime.recall(request(session.contextSessionId)));

  const sessionPath = join(root, "memory", "context-sessions", `${session.contextSessionId}.json`);
  const stored = JSON.parse(await readFile(sessionPath, "utf8")) as {
    pendingEventBatchHashes: string[];
    consumedRecallInvocations: Array<{ lifecycleTimestampFloor?: string }>;
  };
  const lifecycleBatchHashes = await persistedBatchHashes(root);
  expect(stored.consumedRecallInvocations[0]?.lifecycleTimestampFloor).toBe(session.updatedAt);
  await writeFile(
    sessionPath,
    `${JSON.stringify({ ...stored, pendingEventBatchHashes: lifecycleBatchHashes }, null, 2)}\n`,
    "utf8",
  );

  const recovered = await readContextSession(root, session.contextSessionId);
  if (!recovered.ok) throw new Error(recovered.error.message);
  expect(recovered.value.pendingEventBatchHashes).toEqual([]);
});

test("recorded recall recovers an orphaned durable result after session state loss", async () => {
  const { root, session } = await fixture();
  let calls = 0;
  const runtime = createRecordedRecallRuntime(root, {
    clock: new FakeRecallClock(Date.parse("2026-08-03T10:00:01.000Z")),
    adapters: [
      {
        id: "nondeterministic",
        run: (context) => ({
          ok: true,
          branchId: context.branchId,
          evidence: [{ id: `evidence-${++calls}`, scope: context.scope }],
          tokens: 1,
        }),
      },
    ],
  });
  const sessionPath = join(root, "memory", "context-sessions", `${session.contextSessionId}.json`);
  const originalSession = await readFile(sessionPath, "utf8");
  const first = await Effect.runPromise(runtime.recall(request(session.contextSessionId)));
  await writeFile(sessionPath, originalSession, "utf8");

  const recovered = await Effect.runPromise(runtime.recall(request(session.contextSessionId)));
  expect(recovered.contentHash).toBe(first.contentHash);
  expect(calls).toBe(1);
  const committed = await readContextSession(root, session.contextSessionId);
  if (!committed.ok) throw new Error(committed.error.message);
  expect(committed.value.consumedRecallInvocations).toHaveLength(1);
  expect(committed.value.budget.remaining.tokens).toBe(999);
  expect(committed.value.pendingEventBatchHashes).toEqual([]);
  expect(await persistedBatchHashes(root)).toHaveLength(4);
});

test("recorded recall fails closed when its durable replay result is tampered", async () => {
  const { root, session } = await fixture();
  let calls = 0;
  const runtime = createRecordedRecallRuntime(root, {
    clock: new FakeRecallClock(Date.parse("2026-08-03T10:00:01.000Z")),
    adapters: [
      {
        id: "nondeterministic",
        run: (context) => ({
          ok: true,
          branchId: context.branchId,
          evidence: [{ id: `evidence-${++calls}`, scope: context.scope }],
          tokens: 1,
        }),
      },
    ],
  });
  const first = await Effect.runPromise(runtime.recall(request(session.contextSessionId)));
  const committed = await readContextSession(root, session.contextSessionId);
  if (!committed.ok) throw new Error(committed.error.message);
  const invocation = committed.value.consumedRecallInvocations[0]!;
  await writeFile(
    join(
      root,
      "memory",
      "context-recall-results",
      session.contextSessionId,
      `${invocation.invocationHash}.json`,
    ),
    "{}",
  );

  await expect(
    Effect.runPromise(runtime.recall(request(session.contextSessionId))),
  ).rejects.toMatchObject({
    code: "finalization-error",
    retryable: true,
    phase: "storage",
  });
  const retried = await readContextSession(root, session.contextSessionId);
  if (!retried.ok) throw new Error(retried.error.message);
  expect(retried.value.budget.remaining).toEqual(committed.value.budget.remaining);
  expect(retried.value.consumedRecallInvocations).toEqual([
    {
      invocationId: "test-invocation",
      invocationHash: committed.value.consumedRecallHashes[0],
      contentHash: first.contentHash,
      traceHash: first.trace.contentHash,
      lifecycleTimestampFloor: session.updatedAt,
    },
  ]);
  expect(calls).toBe(1);
  expect(await persistedBatchHashes(root)).toHaveLength(4);
});

test("recorded recall inherits omitted parent scope and rejects scope mismatches", async () => {
  const { root, session } = await fixture();
  let calls = 0;
  const runtime = createRecordedRecallRuntime(root, {
    adapters: [
      (context) => {
        calls += 1;
        return { ok: true, branchId: context.branchId };
      },
    ],
  });

  const inherited = await Effect.runPromise(
    runtime.recall({ ...request(session.contextSessionId), scope: {} }),
  );
  expect(inherited.trace.scope).toMatchObject({
    provider: "openai",
    harness: "codex",
    model: "model",
    project: "/repo",
    repository: "/repo",
    user: null,
    organization: null,
    tool: null,
    itemPermissions: [],
    domain: "coding",
    path: "/repo",
  });
  for (const [field, value] of [
    ["provider", "anthropic"],
    ["harness", "claude-code"],
    ["model", "other-model"],
    ["project", "/other"],
    ["repository", "/other"],
    ["user", "other-user"],
    ["organization", "other-org"],
    ["tool", "other-tool"],
    ["itemPermissions", ["other-item"]],
    ["domain", "research"],
    ["path", "/other"],
  ] as const) {
    const rejected = await Effect.runPromise(
      runtime.recall({
        ...request(session.contextSessionId),
        scope: { ...request(session.contextSessionId).scope, [field]: value },
      }),
    ).then(
      () => null,
      (error: unknown) => error,
    );
    expect(rejected).toBeInstanceOf(RecallError);
    expect((rejected as RecallError).code).toBe("scope-denied");
  }
  expect(calls).toBe(1);
});

test("recorded recall replays the exact durable result without running adapters twice", async () => {
  const { root, session } = await fixture();
  const clock = new FakeRecallClock(0);
  let invocations = 0;
  const runtime = createRecordedRecallRuntime(root, {
    clock,
    adapters: [
      {
        id: "timed",
        run: (context) => {
          invocations += 1;
          clock.advance(invocations);
          return {
            ok: true,
            branchId: context.branchId,
            evidence: [
              {
                id: "evidence-semantic",
                reference: `chatlog://event/${HASH_A}/${HASH_B}`,
                support: [HASH_A],
                scope: context.scope,
              },
            ],
            tokens: 8,
          };
        },
      },
    ],
  });

  const first = await Effect.runPromise(runtime.recall(request(session.contextSessionId)));
  const second = await Effect.runPromise(runtime.recall(request(session.contextSessionId)));
  expect(second).toEqual(first);
  expect(invocations).toBe(1);

  const stored = await readContextSession(root, session.contextSessionId);
  if (!stored.ok) throw new Error(stored.error.message);
  expect(stored.value.budget.remaining).toEqual({
    tokens: 992,
    results: 9,
    latencyMs: 999,
    costUsd: 0,
  });
  expect(stored.value.consumedRecallHashes).toHaveLength(1);
  expect(stored.value.consumedRecallHashes[0]).not.toBe(first.contentHash);
  expect(stored.value.consumedRecallInvocations[0]?.invocationId).toBe("test-invocation");
  expect(await persistedBatchHashes(root)).toHaveLength(4);
});

test("recorded recall does not spend budget when event persistence fails", async () => {
  const { root, session } = await fixture();
  await writeFile(join(root, "corpus"), "blocks the event object directory");
  const runtime = createRecordedRecallRuntime(root, {
    adapters: [
      (context) => ({
        ok: true,
        branchId: context.branchId,
        evidence: [
          {
            id: "evidence-1",
            reference: `chatlog://event/${HASH_A}/${HASH_B}`,
            support: [HASH_A],
            scope: context.scope,
          },
        ],
        tokens: 8,
      }),
    ],
  });

  await expect(
    Effect.runPromise(runtime.recall(request(session.contextSessionId))),
  ).rejects.toMatchObject({ code: "persistence-error", retryable: true, phase: "stage" });
  const stored = await readContextSession(root, session.contextSessionId);
  if (!stored.ok) throw new Error(stored.error.message);
  expect(stored.value.budget.remaining).toEqual(session.budget.remaining);
  expect(stored.value.consumedRecallHashes).toEqual([]);
});

test("stale recall budget cannot publish successful recall events", async () => {
  const { root, session } = await fixture();
  const staleAdapter = async (context: RecallBranchContext): Promise<RecallBranchObservation> => {
    const competingRuntime = createRecordedRecallRuntime(root, {
      clock: new FakeRecallClock(Date.parse("2026-08-03T10:00:01.000Z")),
      adapters: [
        {
          id: "competing-recall",
          run: async (competingContext) => ({
            ok: true,
            branchId: competingContext.branchId,
            evidence: [],
            tokens: 1,
          }),
        },
      ],
    });
    await Effect.runPromise(
      competingRuntime.recall({
        ...request(session.contextSessionId),
        invocationId: "competing-recall",
      }),
    );
    return {
      ok: true,
      branchId: context.branchId,
      evidence: [
        {
          id: "evidence-stale",
          reference: `chatlog://event/${HASH_A}/${HASH_B}`,
          support: [HASH_A],
          scope: context.scope,
        },
      ],
      tokens: 8,
    };
  };
  const runtime = createRecordedRecallRuntime(root, {
    adapters: [{ id: "stale-budget", run: (context) => staleAdapter(context) }],
  });

  await expect(
    Effect.runPromise(runtime.recall(request(session.contextSessionId))),
  ).rejects.toMatchObject({ code: "finalization-error", retryable: true, phase: "debit" });
  expect(await persistedBatchHashes(root)).toHaveLength(4);
  const events = await readContextEvents(root, { contextSessionId: session.contextSessionId });
  if (!events.ok) throw new Error(events.error.message);
  expect(events.value.map((event) => event.kind)).toEqual([
    "context.recall.branch.started",
    "context.recall.branch.completed",
    "context.recall.terminated",
    "context.recall.returned",
  ]);
  expect(events.value[2]!.payload.contentHash).toBe(events.value[3]!.payload.contentHash);
});

test("recall budget commit rejects an over-limit staged batch list before reading batches", async () => {
  const { root, session } = await fixture();
  const eventBatchHashes = Array.from({ length: MAX_STAGED_RECALL_EVENT_BATCHES + 1 }, (_, index) =>
    index.toString(16).padStart(64, "0"),
  );
  const rejected = await commitContextRecallBudget(root, {
    contextSessionId: session.contextSessionId,
    invocationId: "over-limit",
    invocationHash: "f".repeat(64),
    expectedRemaining: session.budget.remaining,
    consumed: { tokens: 0, results: 0, latencyMs: 0, costUsd: 0 },
    committedAt: "2026-08-03T10:00:01.000Z",
    lifecycleTimestampFloor: session.updatedAt,
    eventBatchHashes,
    result: emptyRecallResult(session),
  });
  expect(rejected).toMatchObject({
    ok: false,
  });
  const stored = await readContextSession(root, session.contextSessionId);
  if (!stored.ok) throw new Error(stored.error.message);
  expect(stored.value.budget.remaining).toEqual(session.budget.remaining);
  expect(await persistedBatchHashes(root)).toEqual([]);
});

test("recall budget commit rejects forged lifecycle summaries without debit", async () => {
  const { root, session } = await fixture();
  const invocationId = "forged-terminal";
  const invocationHash = "e".repeat(64);
  const result = emptyRecallResult(session);
  const eventScope = {
    sessionId: session.contextSessionId,
    project: session.projectIdentity,
    cwd: session.cwd,
  };
  const invocationPayload = {
    invocationId,
    invocationHash,
    scope: result.trace.scope,
    scopeHash: result.trace.scopeHash,
    contentHash: result.contentHash,
    traceHash: result.trace.contentHash,
    terminationReason: result.trace.terminationReason,
  };
  const terminated = await stageContextEvent(root, {
    kind: "context.recall.terminated",
    contextSessionId: session.contextSessionId,
    idempotencyKey: `recall:${invocationHash}:terminated`,
    actor: { kind: "system", id: "custom-system-actor" },
    scope: eventScope,
    contentHash: result.contentHash,
    bounds: result.trace.budget,
    occurredAt: session.updatedAt,
    payload: {
      ...invocationPayload,
      cancellation: result.trace.cancellation,
      novelty: result.trace.novelty,
      stability: result.trace.stability,
    },
  });
  const returned = await stageContextEvent(root, {
    kind: "context.recall.returned",
    contextSessionId: session.contextSessionId,
    idempotencyKey: `recall:${invocationHash}:returned`,
    actor: { kind: "system", id: "custom-system-actor" },
    scope: eventScope,
    contentHash: result.contentHash,
    bounds: result.trace.budget,
    provenance: { evidenceReferences: [], insightRevisions: [], procedures: [] },
    occurredAt: session.updatedAt,
    payload: {
      ...invocationPayload,
      evidenceIds: ["forged-evidence"],
      insightRevisions: [],
      procedureIds: [],
      contradictionIds: [],
      unresolved: result.unresolved,
      disagreements: result.trace.disagreements,
      omissions: result.trace.omissions,
    },
  });
  expect(terminated.ok).toBe(true);
  expect(returned.ok).toBe(true);
  if (!terminated.ok || !returned.ok) return;
  const rejected = await commitContextRecallBudget(root, {
    contextSessionId: session.contextSessionId,
    invocationId,
    invocationHash,
    expectedRemaining: session.budget.remaining,
    consumed: { tokens: 0, results: 0, latencyMs: 0, costUsd: 0 },
    committedAt: session.updatedAt,
    lifecycleTimestampFloor: session.updatedAt,
    eventBatchHashes: [terminated.value.batchHash, returned.value.batchHash],
    result,
  });
  expect(rejected).toMatchObject({
    ok: false,
    error: { code: "invalid-session" },
  });
  const stored = await readContextSession(root, session.contextSessionId);
  if (!stored.ok) throw new Error(stored.error.message);
  expect(stored.value.budget.remaining).toEqual(session.budget.remaining);
  expect(stored.value.consumedRecallHashes).toEqual([]);
});
