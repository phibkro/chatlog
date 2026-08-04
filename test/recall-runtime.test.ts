import { expect, test } from "bun:test";
import { Effect } from "effect";
import {
  consolidateRecall,
  type RecallBranchObservation,
  type RecallBudget,
  type RecallResult,
} from "../src/recall-consolidation";
import {
  MAX_RECALL_VECTOR_ITEMS,
  RecallError,
  createRecallRuntime,
  type RecallBranchAdapter,
  type RecallBranchContext,
  type RecallBranchDefinition,
  type RecallRequest,
} from "../src/recall-runtime";
import { FakeRecallClock } from "./recall-clock";
import { createRecallBudget } from "../src/recall-budget";

const CONTEXT_SESSION_ID = "c".repeat(64);

const budget = (overrides: Partial<RecallBudget> = {}): RecallBudget =>
  createRecallBudget({
    maxDepth: 2,
    maxBranches: 2,
    maxQueries: 4,
    maxResults: 8,
    maxTokens: 100,
    maxLatencyMs: 20,
    maxCostUsd: 1,
    ...overrides,
  });

const request = (overrides: Partial<RecallRequest> = {}): RecallRequest => ({
  invocationId: "test-invocation",
  contextSessionId: CONTEXT_SESSION_ID,
  query: "repair compiler",
  scope: { domain: "coding", project: "/repo", provider: "fake" },
  budget: budget(),
  ...overrides,
});

const evidence = (id: string, reference = `chatlog://${id}`) => ({
  id,
  content: `evidence ${id}`,
  references: [reference],
});

const success = (
  branchId: string,
  ids: string[],
  extra: Record<string, unknown> = {},
): RecallBranchObservation => ({
  ok: true,
  branchId,
  evidence: ids.map((id) => evidence(id)),
  ...extra,
});

const run = (
  adapters: readonly (RecallBranchAdapter | RecallBranchDefinition)[],
  input: Partial<RecallRequest> = {},
  clock = new FakeRecallClock(),
): Promise<RecallResult> =>
  Effect.runPromise(
    createRecallRuntime({ adapters, clock }).recall(
      request({ ...input, budget: input.budget ?? budget() }),
    ),
  );

test("rejects recall without a parent context session", async () => {
  const runtime = createRecallRuntime();
  await expect(
    Effect.runPromise(runtime.recall(request({ contextSessionId: "" }))),
  ).rejects.toThrow("contextSessionId");
});

test("rejects malformed and oversized request vectors before runtime allocation", async () => {
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
    const rejected = await Effect.runPromise(createRecallRuntime().recall(request(input))).then(
      () => null,
      (error: unknown) => error,
    );
    expect(rejected).toBeInstanceOf(RecallError);
    expect((rejected as RecallError).code).toBe("invalid-request");
  }
});

test("rejects duplicate normalized recall adapter IDs", async () => {
  const duplicateDefinitions = [
    { id: "duplicate", run: () => success("first", []) },
    { id: " duplicate ", run: () => success("second", []) },
  ];
  const duplicateFunctions: RecallBranchAdapter[] = [
    function duplicate() {
      return success("first", []);
    },
    function duplicate() {
      return success("second", []);
    },
  ];
  for (const effect of [
    createRecallRuntime({ adapters: duplicateDefinitions }).recall(request()),
    createRecallRuntime().recall(request({ adapters: duplicateFunctions })),
  ])
    await expect(Effect.runPromise(effect)).rejects.toMatchObject({
      code: "invalid-request",
      message: "recall adapter IDs must be unique",
    });
});
test("zero budget starts no branch and reports budget exhaustion", async () => {
  let calls = 0;
  const result = await run(
    [
      () => {
        calls += 1;
        return success("unused", ["e1"]);
      },
    ],
    { budget: budget({ maxDepth: 0, maxBranches: 0, maxQueries: 0, maxResults: 0 }) },
  );
  expect(calls).toBe(0);
  expect(result.trace.terminationReason).toBe("budget-exhausted");
  expect(result.trace.branches).toHaveLength(0);
});

test("one branch is joined and receives a strictly lower depth child budget", async () => {
  let seenDepth = -1;
  let seenScope: unknown;
  const result = await run(
    [
      (context) => {
        seenDepth = context.budget.maxDepth;
        seenScope = context.scope;
        return success(context.branchId, ["e1"]);
      },
    ],
    { budget: budget({ maxDepth: 1, maxBranches: 1, maxQueries: 1, maxResults: 1 }) },
  );
  expect(seenDepth).toBe(0);
  expect(seenScope).toEqual({ domain: "coding", project: "/repo", provider: "fake" });
  expect(result.evidence).toHaveLength(1);
  expect(result.trace.terminationReason).toBe("sufficient-evidence");
});

test("maximum allowed branches all complete before consolidation", async () => {
  const seen: string[] = [];
  const adapters: RecallBranchAdapter[] = ["a", "b", "c"].map(
    (id) => (context: RecallBranchContext) => {
      seen.push(context.branchId);
      return success(id, [id]);
    },
  );
  const result = await run(adapters, {
    budget: budget({ maxDepth: 1, maxBranches: 3, maxQueries: 3, maxResults: 3 }),
  });
  expect(seen).toHaveLength(3);
  expect(result.evidence.map((item) => item.id)).toEqual(["a", "b", "c"]);
  expect(result.trace.branches).toHaveLength(3);
});

test("shared branch usage is admitted in adapter order, not completion order", async () => {
  const first = Promise.withResolvers<RecallBranchObservation>();
  const second = Promise.withResolvers<RecallBranchObservation>();
  const pending = run(
    [
      { id: "a", run: () => first.promise },
      { id: "b", run: () => second.promise },
    ],
    {
      budget: budget({
        maxDepth: 1,
        maxBranches: 2,
        maxQueries: 2,
        maxResults: 2,
        maxTokens: 10,
      }),
    },
  );
  second.resolve(success("b", ["b"], { tokens: 10 }));
  await Promise.resolve();
  first.resolve(success("a", ["a"], { tokens: 10 }));
  const result = await pending;
  expect(result.evidence.map((item) => item.id)).toEqual(["a"]);
  expect(result.trace.branchFailures).toEqual(
    expect.arrayContaining([expect.objectContaining({ branchId: "b", code: "budget-exhausted" })]),
  );
});

test("repeated query cycle stops with no novelty", async () => {
  const result = await run(
    [
      (context) =>
        success(context.branchId, ["e1"], {
          followUpQueries: ["project person"],
        }),
    ],
    {
      budget: budget({ maxDepth: 2, maxBranches: 2, maxQueries: 2, maxResults: 2 }),
      minimumEvidence: 2,
    },
  );
  expect(result.trace.queries.some((query) => query.cycle)).toBe(true);
  expect(result.trace.terminationReason).toBe("no-novelty");
});

test("duplicate evidence from different indexes is consolidated once", async () => {
  const result = await run(
    [
      () => success("lexical", ["same"]),
      () => ({
        ...success("semantic", ["same"]),
        evidence: [evidence("same", "chatlog://second-index")],
      }),
    ],
    { budget: budget({ maxDepth: 1, maxBranches: 2, maxQueries: 2, maxResults: 2 }) },
  );
  expect(result.evidence).toHaveLength(1);
  expect(result.evidence[0]?.id).toBe("same");
  expect(result.evidence[0]?.references).toEqual(["chatlog://same", "chatlog://second-index"]);
});

test("visited evidence produces an observable no-novelty termination", async () => {
  const result = await run([() => success("repeat", ["e1"])], {
    visitedEvidenceIds: ["e1"],
    budget: budget({ maxDepth: 1, maxBranches: 1, maxQueries: 1, maxResults: 1 }),
  });
  expect(result.trace.novelty.isNovel).toBe(false);
  expect(result.trace.terminationReason).toBe("no-novelty");
});

test("a prior content hash gives stable-result", async () => {
  const first = await run([() => success("stable", ["e1"])], {
    budget: budget({ maxDepth: 1, maxBranches: 1, maxQueries: 1, maxResults: 1 }),
  });
  const second = await run([() => success("stable", ["e1"])], {
    visitedEvidenceIds: ["e1"],
    previousResultHash: first.contentHash,
    budget: budget({ maxDepth: 1, maxBranches: 1, maxQueries: 1, maxResults: 1 }),
  });
  expect(second.trace.terminationReason).toBe("stable-result");
  expect(second.contentHash).toBe(first.contentHash);
});

test("unresolved contradictions stop consolidation without dropping counterevidence", async () => {
  const result = await run(
    [
      () => ({
        ok: true,
        branchId: "contradictory",
        contradictions: [{ id: "c1", left: "A", right: "B" }],
      }),
    ],
    { budget: budget({ maxDepth: 1, maxBranches: 1, maxQueries: 1 }) },
  );
  expect(result.contradictions).toHaveLength(1);
  expect(result.trace.terminationReason).toBe("unresolved-contradiction");
});

test("branch deadline times out a never-completing adapter and releases its fake waiter", async () => {
  const clock = new FakeRecallClock();
  const pending = run(
    [() => Effect.never],
    { budget: budget({ maxDepth: 1, maxBranches: 1, maxQueries: 1, maxLatencyMs: 10 }) },
    clock,
  );
  await Promise.resolve();
  clock.advance(10);
  const result = await pending;
  expect(result.trace.terminationReason).toBe("timeout");
  expect(result.trace.branchFailures[0]?.code).toBe("timeout");
  expect(clock.pendingWaiters()).toBe(0);
});

test("parent cancellation interrupts every branch before return", async () => {
  const clock = new FakeRecallClock();
  const controller = new AbortController();
  const pending = run(
    [() => Effect.never, () => Effect.never],
    {
      parentSignal: controller.signal,
      budget: budget({ maxDepth: 1, maxBranches: 2, maxQueries: 2 }),
    },
    clock,
  );
  await Promise.resolve();
  controller.abort();
  const result = await pending;
  expect(result.trace.terminationReason).toBe("cancelled-parent");
  expect(result.trace.cancellation.parentRequested).toBe(true);
  expect(result.trace.cancellation.cancelledBranches).toHaveLength(2);
  expect(clock.pendingWaiters()).toBe(0);
});

test("scope closure prevents branch launch", async () => {
  let calls = 0;
  const result = await run(
    [
      () => {
        calls += 1;
        return success("closed", ["e1"]);
      },
    ],
    { scopeClosed: true },
  );
  expect(calls).toBe(0);
  expect(result.trace.terminationReason).toBe("scope-closed");
});

test("one typed provider failure does not cancel a successful branch", async () => {
  const result = await run(
    [
      () => ({
        ok: false,
        branchId: "failed",
        failure: {
          code: "provider-error",
          branchId: "failed",
          query: "repair compiler",
          message: "provider unavailable",
        },
      }),
      () => success("ok", ["e1"]),
    ],
    { budget: budget({ maxDepth: 1, maxBranches: 2, maxQueries: 2, maxResults: 1 }) },
  );
  expect(result.evidence).toHaveLength(1);
  expect(result.trace.branchFailures).toHaveLength(1);
  expect(result.trace.terminationReason).toBe("sufficient-evidence");
});

test("all typed provider failures return one bounded result", async () => {
  const result = await run(
    [
      () => ({
        ok: false,
        branchId: "a",
        failure: {
          code: "provider-error",
          branchId: "a",
          query: "repair compiler",
          message: "a failed",
        },
      }),
      () => ({
        ok: false,
        branchId: "b",
        failure: {
          code: "provider-error",
          branchId: "b",
          query: "repair compiler",
          message: "b failed",
        },
      }),
    ],
    { budget: budget({ maxDepth: 1, maxBranches: 2, maxQueries: 2 }) },
  );
  expect(result.evidence).toHaveLength(0);
  expect(result.trace.branchFailures).toHaveLength(2);
  expect(result.trace.terminationReason).toBe("no-novelty");
});

test("rejects adapter items that widen the effective recall scope", async () => {
  const result = await run(
    [
      (context) => ({
        ok: true,
        branchId: context.branchId,
        evidence: [
          {
            id: "widened-evidence",
            scope: { domain: "coding", project: "/other", provider: "fake" },
          },
        ],
        insights: [
          {
            id: "widened-insight",
            scope: { domain: "coding", project: "/repo", provider: "other" },
          },
        ],
        procedures: [
          {
            id: "widened-procedure",
            scope: { domain: "coding", project: "/repo", repository: "/other" },
          },
          {
            id: "wrong-harness-procedure",
            scope: {
              domain: "coding",
              project: "/repo",
              provider: "fake",
              harnesses: ["other-harness"],
            },
          },
        ],
        contradictions: [
          {
            id: "widened-contradiction",
            scope: { domain: "coding", project: "/other", provider: "fake" },
          },
        ],
        confidence: [
          {
            id: "widened-confidence",
            value: 0.9,
            scope: { domain: "coding", project: "/repo", provider: "other" },
          },
        ],
      }),
    ],
    {
      scope: {
        domain: "coding",
        project: "/repo",
        provider: "fake",
        harness: "current-harness",
      },
      budget: budget({ maxDepth: 1, maxBranches: 1, maxQueries: 1, maxResults: 6 }),
    },
  );
  expect(result.evidence).toEqual([]);
  expect(result.insights).toEqual([]);
  expect(result.procedures).toEqual([]);
  expect(result.contradictions).toEqual([]);
  expect(result.confidence).toEqual([]);
});

test("branch completion order does not change the consolidated content hash", () => {
  const observations: RecallBranchObservation[] = [success("b", ["e2"]), success("a", ["e1"])];
  const options = {
    totalBudget: budget({ maxResults: 2 }),
    consumedBudget: budget({
      maxDepth: 0,
      maxBranches: 2,
      maxQueries: 2,
      maxResults: 2,
      maxTokens: 0,
      maxLatencyMs: 0,
      maxCostUsd: 0,
    }),
    remainingBudget: budget({
      maxDepth: 0,
      maxBranches: 0,
      maxQueries: 0,
      maxResults: 0,
      maxTokens: 100,
      maxLatencyMs: 20,
      maxCostUsd: 1,
    }),
    scope: { domain: "coding", project: "/repo", provider: "fake" },
    terminationReason: "sufficient-evidence" as const,
  };
  const first = consolidateRecall(observations, options);
  const second = consolidateRecall(observations.toReversed(), options);
  expect(second.contentHash).toBe(first.contentHash);
  expect(second.trace.contentHash).toBe(first.trace.contentHash);
});
