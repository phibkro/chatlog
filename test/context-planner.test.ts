import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readContextEvents, stageContextEvent } from "../src/context-events";
import { validateContextRequest } from "../src/context-policy";
import { planContext } from "../src/context-planner";
import {
  commitContextBundleBudget,
  contextSessionIdentity,
  createContextSession,
  listContextSessions,
  openContextSession,
  readContextSession,
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
test("context planning rejects fixed instruction tokens that could credit the budget", () => {
  const session = sessionFor("native-negative-fixed-tokens");
  const input = request(session.contextSessionId);

  for (const fixedInstructionTokens of [-1, 0.5, Number.NaN]) {
    expect(planContext({ ...input, fixedInstructionTokens }, session, [])).toMatchObject({
      ok: false,
      error: { code: "invalid-request" },
    });
  }
});
test("context planning rejects a malformed freshness boundary", () => {
  const session = sessionFor("native-invalid-freshness");
  const input = request(session.contextSessionId);

  expect(planContext({ ...input, freshAfter: "not-a-timestamp" }, session, [])).toMatchObject({
    ok: false,
    error: { code: "invalid-request" },
  });
});

test("context candidates stay within the request path boundary", () => {
  const session = sessionFor("native-path-scope");
  const input = request(session.contextSessionId);
  const result = planContext(input, session, [
    candidate("ancestor", {
      scope: { ...candidate("scope").scope, path: "/repo" },
    }),
    candidate("descendant", {
      scope: { ...candidate("scope").scope, path: "/repo/src/module" },
    }),
    candidate("prefix-collision", {
      scope: { ...candidate("scope").scope, path: "/repo/src-private" },
    }),
  ]);

  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.value.items.map((item) => item.id)).toEqual(["descendant"]);
  expect(result.value.omissions).toContainEqual({
    itemId: "ancestor",
    reason: "path-mismatch",
  });
  expect(result.value.omissions).toContainEqual({
    itemId: "prefix-collision",
    reason: "path-mismatch",
  });
});

test("context requests cannot widen repository or neutral session dimensions", () => {
  const session = sessionFor("native-scope-binding");
  const input = request(session.contextSessionId);
  for (const scope of [
    { ...input.scope, repository: "/other" },
    { ...input.scope, user: "user-1" },
    { ...input.scope, organization: "org-1" },
    { ...input.scope, tool: "tool-1" },
    { ...input.scope, itemPermissions: ["item-1"] },
  ]) {
    const result = validateContextRequest({ ...input, scope }, session);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("scope-denied");
  }
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

test("a native session ID cannot be rebound to a different immutable identity", async () => {
  const root = await mkdtemp(join(tmpdir(), "chatlog-context-native-binding-"));
  const initial: ContextSessionInput = {
    nativeSessionId: "native-binding",
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
  expect(first.ok).toBe(true);
  if (!first.ok) return;

  for (const change of [
    { provider: "openai" },
    { harness: "codex" },
    { model: "other-model" },
    { role: "reviewer" },
    { projectIdentity: "/other-project" },
    { cwd: "/other-project" },
    { domainPolicy: ["research"] as string[] },
    { path: "/repo/other" },
  ] as const) {
    const rebound = await openContextSession(root, {
      ...initial,
      ...change,
      createdAt: "2026-08-04T12:00:00.000Z",
    });
    expect(rebound.ok).toBe(false);
    if (rebound.ok) continue;
    expect(rebound.error.code).toBe("session-conflict");
  }
});

test("stored context sessions reject malformed exact fields instead of coercing them", async () => {
  const root = await mkdtemp(join(tmpdir(), "chatlog-context-session-parser-"));
  const input: ContextSessionInput = {
    nativeSessionId: "native-parser",
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
  const opened = await openContextSession(root, input);
  expect(opened.ok).toBe(true);
  if (!opened.ok) return;
  const path = join(root, "memory", "context-sessions", `${opened.value.contextSessionId}.json`);
  const base = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  const legacy = { ...base };
  delete legacy.pendingEventBatchHashes;
  delete legacy.consumedRecallHashes;
  delete legacy.sessionNonce;
  await writeFile(path, JSON.stringify(legacy));
  const migrated = await readContextSession(root, opened.value.contextSessionId);
  expect(migrated.ok).toBe(true);
  if (migrated.ok) expect(migrated.value.pendingEventBatchHashes).toEqual([]);
  const total = {
    ...((base.budget as Record<string, unknown>).total as Record<string, unknown>),
  };
  const missingBudgetKey = { ...total };
  delete missingBudgetKey.costUsd;
  const extraBudgetKey = { ...total, unexpected: 0 };
  const malformedCases = [
    { ...base, budget: { ...(base.budget as object), total: missingBudgetKey } },
    { ...base, budget: { ...(base.budget as object), total: extraBudgetKey } },
    { ...base, target: { ...(base.target as object), provider: 42 } },
    { ...base, domainPolicy: ["coding", 42] },
    { ...base, consumedRecallHashes: [42] },
    { ...base, extra: true },
  ];
  for (const malformed of malformedCases) {
    await writeFile(path, JSON.stringify(malformed));
    const parsed = await readContextSession(root, opened.value.contextSessionId);
    expect(parsed.ok).toBe(false);
  }
  await writeFile(path, "{");
  const malformedJson = await readContextSession(root, opened.value.contextSessionId);
  expect(malformedJson.ok).toBe(false);
});

test("legacy anonymous sessions migrate a stable nonce in place", async () => {
  const root = await mkdtemp(join(tmpdir(), "chatlog-context-session-legacy-anonymous-"));
  const input: ContextSessionInput = {
    nativeSessionId: null,
    provider: "openai",
    harness: "codex",
    model: "test-model",
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
  const created = createContextSession(input);
  expect(created.ok).toBe(true);
  if (!created.ok) return;
  const contextSessionId = contextSessionIdentity(input);
  const legacy = { ...created.value } as Record<string, unknown>;
  legacy.contextSessionId = contextSessionId;
  delete legacy.sessionNonce;
  const path = join(root, "memory", "context-sessions", `${contextSessionId}.json`);
  await mkdir(join(root, "memory", "context-sessions"), { recursive: true });
  await writeFile(path, JSON.stringify(legacy));

  const first = await readContextSession(root, contextSessionId);
  expect(first.ok).toBe(true);
  if (!first.ok) return;
  expect(first.value.contextSessionId).toBe(contextSessionId);
  expect(first.value.nativeSessionId).toBeNull();
  expect(first.value.sessionNonce).toBeString();
  expect(first.value.sessionNonce).not.toHaveLength(0);
  const persisted = await readFile(path, "utf8");
  const persistedValue = JSON.parse(persisted) as Record<string, unknown>;
  expect(persistedValue.contextSessionId).toBe(contextSessionId);
  expect(persistedValue.sessionNonce).toBe(first.value.sessionNonce);

  const second = await readContextSession(root, contextSessionId);
  expect(second.ok).toBe(true);
  if (!second.ok) return;
  expect(second.value.contextSessionId).toBe(contextSessionId);
  expect(second.value.sessionNonce).toBe(first.value.sessionNonce);
  expect(await readFile(path, "utf8")).toBe(persisted);
});

test("anonymous context deliveries receive distinct session identities", async () => {
  const root = await mkdtemp(join(tmpdir(), "chatlog-context-anonymous-"));
  const input: ContextSessionInput = {
    nativeSessionId: null,
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
    totalBudget: { tokens: 100, results: 4, latencyMs: 100, costUsd: 0 },
    createdAt: AT,
  };
  const first = await openContextSession(root, input);
  const second = await openContextSession(root, input);

  expect(first.ok).toBe(true);
  expect(second.ok).toBe(true);
  if (!first.ok || !second.ok) return;
  expect(second.value.contextSessionId).not.toBe(first.value.contextSessionId);
  expect(second.value.nativeSessionId).toBeNull();
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

test("context with no lexical task match is omitted", () => {
  const session = sessionFor("native-unrelated");
  const unrelated = candidate("unrelated", {
    scores: { lexical: 0, semantic: 0, temporal: 1, procedure: 1, total: 2 },
  });
  const planned = planContext(request(session.contextSessionId), session, [unrelated]);
  expect(planned.ok).toBe(true);
  if (!planned.ok) return;
  expect(planned.value.items).toEqual([]);
  expect(planned.value.omissions).toEqual([{ itemId: "unrelated", reason: "task-mismatch" }]);
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
  const planned = planContext(
    { ...request(opened.value.contextSessionId), deliveryMode: "tool-recall" },
    opened.value,
    [candidate("eligible")],
  );
  expect(planned.ok).toBe(true);
  if (!planned.ok) return;

  const rendered = await stageContextEvent(root, {
    kind: "context.bundle.rendered",
    contextSessionId: opened.value.contextSessionId,
    idempotencyKey: `${planned.value.bundleHash}:context.bundle.rendered`,
    actor: { kind: "system", id: "context-planner-test" },
    bundleHash: planned.value.bundleHash,
    inputHash: planned.value.inputHash,
    inputHashes: [HASH_A, HASH_B],
    policyHash: planned.value.policyHash,
    bounds: { ...planned.value.budget },
    payload: { itemIds: [planned.value.items[0]!.id], omissionCount: 0 },
    occurredAt: AT,
  });
  expect(rendered.ok).toBe(true);
  if (!rendered.ok) return;
  const staged = await stageContextEvent(root, {
    kind: "context.recall.returned",
    contextSessionId: opened.value.contextSessionId,
    idempotencyKey: `${planned.value.bundleHash}:context.recall.returned`,
    actor: { kind: "system", id: "context-planner-test" },
    bundleHash: planned.value.bundleHash,
    itemId: planned.value.items[0]!.id,
    inputHash: planned.value.inputHash,
    inputHashes: [rendered.value.batchHash],
    contentHash: planned.value.bundleHash,
    candidateContentHash: HASH_A,
    policyHash: planned.value.policyHash,
    inputEventIds: [rendered.value.event.eventId],
    bounds: { ...planned.value.budget },
    payload: { receiptEvidence: "prompt-artifact" },
    occurredAt: AT,
  });
  expect(staged.ok).toBe(true);
  if (!staged.ok) return;
  const forgedDelivery = await stageContextEvent(root, {
    kind: "context.recall.returned",
    contextSessionId: opened.value.contextSessionId,
    idempotencyKey: `${planned.value.bundleHash}:context.recall.returned`,
    actor: { kind: "system", id: "context-planner-test" },
    bundleHash: planned.value.bundleHash,
    itemId: planned.value.items[0]!.id,
    inputHash: planned.value.inputHash,
    inputHashes: [rendered.value.batchHash],
    contentHash: planned.value.bundleHash,
    candidateContentHash: HASH_B,
    policyHash: planned.value.policyHash,
    inputEventIds: [rendered.value.event.eventId],
    bounds: { ...planned.value.budget },
    payload: { receiptEvidence: "prompt-artifact" },
    occurredAt: AT,
  });
  expect(forgedDelivery.ok).toBe(true);
  if (!forgedDelivery.ok) return;
  const blocked = await stageContextEvent(root, {
    kind: "context.recall.returned",
    contextSessionId: opened.value.contextSessionId,
    idempotencyKey: "blocked-recall-return",
    actor: { kind: "system", id: "context-planner-test" },
    payload: { contentHash: HASH_A, traceHash: HASH_B },
    occurredAt: AT,
  });
  expect(blocked.ok).toBe(true);
  if (!blocked.ok) return;
  const sessionPath = join(
    root,
    "memory",
    "context-sessions",
    `${opened.value.contextSessionId}.json`,
  );
  const stored = JSON.parse(await readFile(sessionPath, "utf8")) as Record<string, unknown>;
  await writeFile(
    sessionPath,
    `${JSON.stringify({
      ...stored,
      pendingEventBatchHashes: [blocked.value.batchHash, forgedDelivery.value.batchHash],
    })}\n`,
    "utf8",
  );
  const renderedTokens = planned.value.budget.beforeTokens - planned.value.budget.afterTokens;
  const batchHashes = [staged.value.batchHash];
  const first = await commitContextBundleBudget(
    root,
    planned.value,
    AT,
    renderedTokens,
    batchHashes,
  );
  const retry = await commitContextBundleBudget(
    root,
    planned.value,
    AT,
    renderedTokens,
    batchHashes,
  );

  expect(first.ok).toBe(true);
  expect(retry.ok).toBe(true);
  if (!first.ok || !retry.ok) return;
  expect(first.value.committed).toBe(true);
  expect(retry.value.committed).toBe(false);
  expect(retry.value.session.budget).toEqual(first.value.session.budget);
  expect(retry.value.session.consumedBundleHashes).toEqual(
    first.value.session.consumedBundleHashes,
  );
  expect(retry.value.session.pendingEventBatchHashes).toEqual([
    blocked.value.batchHash,
    forgedDelivery.value.batchHash,
  ]);
  expect(first.value.session.budget.remaining.tokens).toBe(80);
  expect(first.value.session.consumedBundleHashes).toEqual([planned.value.bundleHash]);
  expect(first.value.session.committedDeliveryBatchHashes).toEqual([staged.value.batchHash]);
  const recoveredEvents = await readContextEvents(root, {
    contextSessionId: opened.value.contextSessionId,
  });
  expect(recoveredEvents.ok).toBe(true);
  if (!recoveredEvents.ok) return;
  expect(recoveredEvents.value.map((event) => event.kind)).toEqual(["context.recall.returned"]);
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
