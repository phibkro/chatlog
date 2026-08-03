import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { planContext } from "../src/context-planner";
import {
  commitContextBundleBudget,
  createContextSession,
  listContextSessions,
  openContextSession,
} from "../src/context-session";
import type {
  ContextCandidate,
  ContextRequest,
  ContextSession,
  ContextSessionInput,
} from "../src/context-types";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const AT = "2026-08-03T12:00:00.000Z";

function candidate(id: string, overrides: Partial<ContextCandidate> = {}): ContextCandidate {
  return {
    id,
    kind: "insight",
    content: `context ${id}`,
    evidenceReferences: [`chatlog://event/${HASH_A}`],
    selectionReason: "task lexical match",
    scores: { lexical: 1, semantic: 0, temporal: 1, procedure: 0, total: 2 },
    scope: {
      user: null,
      organization: null,
      project: "/repo",
      repository: "/repo",
      path: null,
      harness: "claude-code",
      model: null,
      tool: null,
      domain: "coding",
    },
    validTime: { start: "2026-01-01T00:00:00.000Z", end: null },
    authority: "human-reviewed",
    advisory: true,
    riskClass: "low",
    estimatedTokens: 10,
    estimatedCharacters: 40,
    estimatedLatencyMs: 0,
    estimatedCostUsd: 0,
    ...overrides,
  };
}

function request(sessionId: string): ContextRequest {
  return {
    task: "repair the compiler",
    query: "compiler failure",
    contextSessionId: sessionId,
    target: {
      provider: "anthropic",
      harness: "claude-code",
      model: "claude-test",
      role: "coding-agent",
    },
    capabilities: {
      startupHook: true,
      toolRecall: true,
      freshSessionPrompt: true,
      checkpoint: false,
      acknowledgment: false,
      maximumContextTokens: 100,
      encodingOverheadTokens: 5,
      receiptEvidence: ["hook-output", "tool-result"],
    },
    scope: {
      user: null,
      organization: null,
      project: "/repo",
      repository: "/repo",
      path: "/repo/src",
      harness: "claude-code",
      model: "claude-test",
      tool: null,
      domain: "coding",
    },
    allowedItemKinds: ["insight"],
    riskCeiling: "medium",
    freshAfter: "2025-01-01T00:00:00.000Z",
    budget: { tokens: 50, results: 2, latencyMs: 50, costUsd: 0 },
    fixedInstructionTokens: 5,
    deliveryMode: "startup-hook",
    exposure: "shadow",
    now: AT,
  };
}

function sessionFor(nativeSessionId: string): ContextSession {
  const created = createContextSession({
    nativeSessionId,
    provider: "anthropic",
    harness: "claude-code",
    model: "claude-test",
    role: "coding-agent",
    projectIdentity: "/repo",
    cwd: "/repo",
    domainPolicy: ["coding"],
    path: "/repo/src",
    pinnedInsightProjectionHash: HASH_A,
    pinnedEvidenceProjectionHash: HASH_B,
    selectionPolicyVersion: "selection-v1",
    deliveryPolicyVersion: "delivery-v1",
    totalBudget: { tokens: 100, results: 4, latencyMs: 100, costUsd: 0 },
    createdAt: AT,
  });
  if (!created.ok) throw new Error(created.error.message);
  return created.value;
}

test("context planning is deterministic and rejects mis-scoped candidates with a typed reason", () => {
  const session = sessionFor("native-1");
  const input = request(session.contextSessionId);
  const candidates = [
    candidate("eligible"),
    candidate("wrong-project", {
      scope: { ...candidate("scope").scope, project: "/other", repository: "/other" },
    }),
  ];

  const first = planContext(input, session, candidates);
  const second = planContext(input, session, candidates.toReversed());

  expect(first).toEqual(second);
  expect(first.ok).toBe(true);
  if (!first.ok) return;
  expect(first.value.items.map((item) => item.id)).toEqual(["eligible"]);
  expect(first.value.omissions).toContainEqual({
    itemId: "wrong-project",
    reason: "project-mismatch",
  });
  expect(first.value.budget).toMatchObject({ beforeTokens: 100, afterTokens: 80 });
  expect(first.value.inputHash).toHaveLength(64);
  expect(first.value.policyHash).toHaveLength(64);
  expect(first.value.bundleHash).toHaveLength(64);
});

test("opening the same native session preserves its initial projection and policy pins", async () => {
  const root = await mkdtemp(join(tmpdir(), "chatlog-context-session-"));
  const initial: ContextSessionInput = {
    nativeSessionId: "native-1",
    provider: "anthropic",
    harness: "claude-code",
    model: "claude-test",
    role: "coding-agent",
    projectIdentity: "/repo",
    cwd: "/repo",
    domainPolicy: ["coding"],
    path: "/repo/src",
    pinnedInsightProjectionHash: HASH_A,
    pinnedEvidenceProjectionHash: HASH_B,
    selectionPolicyVersion: "selection-v1",
    deliveryPolicyVersion: "delivery-v1",
    totalBudget: { tokens: 100, results: 4, latencyMs: 100, costUsd: 0 },
    createdAt: AT,
  };
  const first = await openContextSession(root, initial);
  const second = await openContextSession(root, {
    ...initial,
    pinnedInsightProjectionHash: "c".repeat(64),
    pinnedEvidenceProjectionHash: "d".repeat(64),
    selectionPolicyVersion: "selection-v2",
    deliveryPolicyVersion: "delivery-v2",
    createdAt: "2026-08-04T12:00:00.000Z",
  });

  expect(first.ok).toBe(true);
  expect(second.ok).toBe(true);
  if (!first.ok || !second.ok) return;
  expect(second.value.contextSessionId).toBe(first.value.contextSessionId);
  expect(second.value.pinnedInsightProjectionHash).toBe(HASH_A);
  expect(second.value.pinnedEvidenceProjectionHash).toBe(HASH_B);
  expect(second.value.selectionPolicyVersion).toBe("selection-v1");
});

test("high-risk inferred preferences remain shadow-only", () => {
  const session = sessionFor("native-2");
  const highRisk = candidate("inferred-preference", { riskClass: "high" });
  const shadow = planContext(
    { ...request(session.contextSessionId), riskCeiling: "high", exposure: "shadow" },
    session,
    [highRisk],
  );
  const limited = planContext(
    { ...request(session.contextSessionId), riskCeiling: "high", exposure: "limited-insight" },
    session,
    [highRisk],
  );

  expect(shadow.ok).toBe(true);
  expect(limited.ok).toBe(true);
  if (!shadow.ok || !limited.ok) return;
  expect(shadow.value.items.map((item) => item.id)).toEqual(["inferred-preference"]);
  expect(shadow.value.shadow).toBe(true);
  expect(limited.value.items).toEqual([]);
  expect(limited.value.omissions).toEqual([
    { itemId: "inferred-preference", reason: "exposure-denied" },
  ]);
});

test("committing a delivered bundle spends session budget exactly once", async () => {
  const root = await mkdtemp(join(tmpdir(), "chatlog-context-budget-"));
  const opened = await openContextSession(root, {
    nativeSessionId: "native-budget",
    provider: "anthropic",
    harness: "claude-code",
    model: "claude-test",
    role: "coding-agent",
    projectIdentity: "/repo",
    cwd: "/repo",
    domainPolicy: ["coding"],
    path: "/repo/src",
    pinnedInsightProjectionHash: HASH_A,
    pinnedEvidenceProjectionHash: HASH_B,
    selectionPolicyVersion: "selection-v1",
    deliveryPolicyVersion: "delivery-v1",
    totalBudget: { tokens: 100, results: 4, latencyMs: 100, costUsd: 0 },
    createdAt: AT,
  });
  expect(opened.ok).toBe(true);
  if (!opened.ok) return;
  const planned = planContext(request(opened.value.contextSessionId), opened.value, [
    candidate("eligible"),
  ]);
  expect(planned.ok).toBe(true);
  if (!planned.ok) return;

  const first = await commitContextBundleBudget(root, planned.value, AT);
  const retry = await commitContextBundleBudget(root, planned.value, AT);

  expect(first.ok).toBe(true);
  expect(retry).toEqual(first);
  if (!first.ok) return;
  expect(first.value.budget.remaining.tokens).toBe(80);
  expect(first.value.consumedBundleHashes).toEqual([planned.value.bundleHash]);
});

test("context sessions are listed newest first for operator inspection", async () => {
  const root = await mkdtemp(join(tmpdir(), "chatlog-context-list-"));
  const base: ContextSessionInput = {
    nativeSessionId: "native-old",
    provider: "anthropic",
    harness: "claude-code",
    model: "claude-test",
    role: "coding-agent",
    projectIdentity: "/repo",
    cwd: "/repo",
    domainPolicy: ["coding"],
    path: "/repo/src",
    pinnedInsightProjectionHash: HASH_A,
    pinnedEvidenceProjectionHash: HASH_B,
    selectionPolicyVersion: "selection-v1",
    deliveryPolicyVersion: "delivery-v1",
    totalBudget: { tokens: 100, results: 4, latencyMs: 100, costUsd: 0 },
    createdAt: AT,
  };
  await openContextSession(root, base);
  await openContextSession(root, {
    ...base,
    nativeSessionId: "native-new",
    createdAt: "2026-08-04T12:00:00.000Z",
  });

  const listed = await listContextSessions(root);

  expect(listed.ok).toBe(true);
  if (!listed.ok) return;
  expect(listed.value.map((session) => session.nativeSessionId)).toEqual([
    "native-new",
    "native-old",
  ]);
});
