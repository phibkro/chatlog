import { expect, test } from "bun:test";
import {
  RecallBudgetError,
  RecallBudgetLedger,
  createRecallBudget,
  deriveChildBudget,
  inheritRecallScope,
  validateRecallBudget,
  validateRecallScope,
  type RecallBudget,
} from "../src/recall-budget";

const budget = (overrides: Partial<RecallBudget> = {}) =>
  createRecallBudget({
    maxDepth: 3,
    maxBranches: 3,
    maxQueries: 6,
    maxResults: 12,
    maxTokens: 100,
    maxLatencyMs: 1_000,
    maxCostUsd: 1,
    ...overrides,
  });

test("rejects zero, negative, non-finite, and non-integral count budgets", () => {
  expect(
    validateRecallBudget({
      maxDepth: -1,
      maxBranches: 0,
      maxQueries: 0,
      maxResults: 0,
      maxTokens: 0,
      maxLatencyMs: 0,
      maxCostUsd: 0,
    }).ok,
  ).toBe(false);
  expect(() =>
    createRecallBudget({
      maxDepth: 1,
      maxBranches: 1.5,
      maxQueries: 1,
      maxResults: 1,
      maxTokens: 1,
      maxLatencyMs: 1,
      maxCostUsd: 0,
    }),
  ).toThrow(RecallBudgetError);
  expect(() =>
    createRecallBudget({
      maxDepth: Number.POSITIVE_INFINITY,
      maxBranches: 1,
      maxQueries: 1,
      maxResults: 1,
      maxTokens: 1,
      maxLatencyMs: 1,
      maxCostUsd: 0,
    }),
  ).toThrow(RecallBudgetError);
});

test("child depth strictly decreases and hard totals cannot widen", () => {
  const parent = budget();
  const child = deriveChildBudget(parent, { ...parent, maxDepth: 2, maxBranches: 2 });
  expect(child.ok).toBe(true);
  if (child.ok) expect(child.value.maxDepth).toBe(2);

  const equalDepth = deriveChildBudget(parent, { ...parent, maxDepth: parent.maxDepth });
  expect(equalDepth.ok).toBe(false);
  if (!equalDepth.ok) expect(equalDepth.error.code).toBe("depth-not-decreased");

  const widened = deriveChildBudget(parent, {
    ...parent,
    maxDepth: 2,
    maxQueries: parent.maxQueries + 1,
  });
  expect(widened.ok).toBe(false);
});

test("budget consumption is atomic and leaves a complete snapshot", () => {
  const ledger = new RecallBudgetLedger(budget({ maxBranches: 1, maxQueries: 1 }));
  const consumed = ledger.consume({
    ...budget({
      maxDepth: 0,
      maxBranches: 1,
      maxQueries: 1,
      maxResults: 0,
      maxTokens: 0,
      maxLatencyMs: 0,
      maxCostUsd: 0,
    }),
  });
  expect(consumed.ok).toBe(true);
  const before = ledger.snapshot();
  const rejected = ledger.consume({
    ...budget({
      maxDepth: 0,
      maxBranches: 1,
      maxQueries: 1,
      maxResults: 0,
      maxTokens: 0,
      maxLatencyMs: 0,
      maxCostUsd: 0,
    }),
  });
  expect(rejected.ok).toBe(false);
  expect(ledger.snapshot()).toEqual(before);
  expect(before.consumed.maxBranches).toBe(1);
  expect(before.remaining.maxBranches).toBe(0);
});

test("child scope inherits identity and only narrows path and permissions", () => {
  const parent = {
    domain: "coding",
    project: "/repo",
    provider: "provider-a",
    path: "/repo",
    itemPermissions: ["e1", "e2"],
  };
  const child = inheritRecallScope(parent, {
    path: "/repo/src",
    itemPermissions: ["e1"],
  });
  expect(child.ok).toBe(true);
  if (child.ok) expect(child.value.project).toBe("/repo");

  const widened = inheritRecallScope(parent, { provider: "provider-b" });
  expect(widened.ok).toBe(false);
  const permissionWidened = inheritRecallScope(parent, { itemPermissions: ["e3"] });
  expect(permissionWidened.ok).toBe(false);
});
test("recall paths are absolute, dot-free, canonical, and component-contained", () => {
  expect(validateRecallScope({ path: "repo/docs" }).ok).toBe(false);
  expect(validateRecallScope({ path: "/repo/docs/../private" }).ok).toBe(false);

  const child = inheritRecallScope({ path: "/repo/docs/" }, { path: "/repo/docs/private/" });
  expect(child.ok).toBe(true);
  if (child.ok) expect(child.value.path).toBe("/repo/docs/private");

  expect(inheritRecallScope({ path: "/repo/docs" }, { path: "/repo/docs/../private" }).ok).toBe(
    false,
  );
  expect(inheritRecallScope({ path: "/repo/docs" }, { path: "/repo/docs-old" }).ok).toBe(false);
});
