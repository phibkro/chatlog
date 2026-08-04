import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  evaluateShadowAdvice,
  recordShadowAdvice,
  type ShadowAdviceInput,
  type ShadowAdvisorBudget,
} from "../src/advisor-protocol";
import { readContextEvents } from "../src/context-events";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);

const budget: ShadowAdvisorBudget = {
  maxInterruptions: 2,
  maxRecallQueries: 2,
  maxReplanRequests: 1,
  maxAddedTokens: 200,
  deadlineAt: "2026-08-03T13:00:00.000Z",
};

function input(overrides: Partial<ShadowAdviceInput> = {}): ShadowAdviceInput {
  return {
    schemaVersion: 1,
    contextSessionId: HASH_A,
    checkpoint: "before-material-mutation",
    proposedActionHash: HASH_B,
    policyReferences: ["policy://context/write-custody"],
    budget,
    consumed: { interruptions: 0, recallQueries: 0, replanRequests: 0, addedTokens: 0 },
    priorAdviceHashes: [],
    priorEvidenceIds: [],
    parentAdvisorInterventionId: null,
    scopeClosed: false,
    now: "2026-08-03T12:00:00.000Z",
    advice: {
      action: "reconsider",
      note: "Acquire serialized lock custody before the mutation.",
      changedPlanHash: HASH_C,
      escalationReason: null,
      evidenceIds: [HASH_C],
      recallQueries: 1,
      addedTokens: 40,
      basis: [{ kind: "enforced-policy", reference: "policy://context/write-custody" }],
    },
    ...overrides,
  };
}

test("returns bounded shadow advice without blocking the main agent", () => {
  const result = evaluateShadowAdvice(input());
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.value).toMatchObject({
    mode: "shadow",
    status: "accepted",
    action: "reconsider",
    stopReason: "changed-plan",
    canBlock: false,
    canMutate: false,
    canInvokeTools: false,
  });
  expect(result.value.remaining.replanRequests).toBe(0);
});

test("stops repeated identical advice with no novelty", () => {
  const first = evaluateShadowAdvice(input());
  expect(first.ok).toBe(true);
  if (!first.ok) return;
  const repeated = evaluateShadowAdvice(input({ priorAdviceHashes: [first.value.adviceHash] }));
  expect(repeated.ok).toBe(true);
  if (!repeated.ok) return;
  expect(repeated.value.status).toBe("stopped");
  expect(repeated.value.action).toBe(null);
  expect(repeated.value.stopReason).toBe("no-novelty");
});

test("stops when the separate intervention budget is exhausted", () => {
  const result = evaluateShadowAdvice(
    input({
      consumed: { interruptions: 2, recallQueries: 0, replanRequests: 0, addedTokens: 0 },
    }),
  );
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.value.stopReason).toBe("budget-exhausted");
});

test.each(["block", "abort", "tool-call", "mutate", "think-more"])(
  "rejects forbidden advisor action %s",
  (action) => {
    const result = evaluateShadowAdvice(
      input({ advice: { ...input().advice, action: action as never } }),
    );
    expect(result.ok).toBe(false);
  },
);

test("rejects recursive self-supervision", () => {
  const result = evaluateShadowAdvice(input({ parentAdvisorInterventionId: HASH_C }));
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.error.code).toBe("recursive-supervision");
});

test("records every valid shadow decision as a non-blocking intervention event", async () => {
  const root = await mkdtemp(join(tmpdir(), "chatlog-advisor-"));
  const recorded = await recordShadowAdvice(root, {
    ...input(),
    idempotencyKey: "advisor-decision-1",
  });
  expect(recorded.ok).toBe(true);
  if (!recorded.ok) return;
  expect(recorded.value.event.event.kind).toBe("context.advisor.advice");
  const events = await readContextEvents(root, { contextSessionId: HASH_A });
  expect(events.ok).toBe(true);
  if (!events.ok) return;
  expect(events.value).toHaveLength(1);
  expect(events.value[0]).toMatchObject({
    kind: "context.advisor.advice",
    state: "advisor-advice",
    actorAuthority: "system",
  });
});
