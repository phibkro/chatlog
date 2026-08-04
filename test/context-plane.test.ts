import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, readdir, truncate, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ContextPlane, startContextPlaneSession } from "../src/context-plane";
import type { PrepareContextInput, StartContextPlaneSessionInput } from "../src/context-plane";
import { MAX_CLOSED_LOOP_ARTIFACT_BYTES } from "../src/closed-loop-gate";
import { readContextEvents } from "../src/context-events";
import { authorizeContextRelease, resolveContextReleaseEvidence } from "../src/context-release";
import { McpData } from "../src/mcp/data";
import { createMcpState, handleMcpMessage } from "../src/mcp/server";
import { sourceBoundKeepGate } from "./context-gate-fixture";
import { contextPlaneFixture } from "./context-plane-fixture";

test("context session start rejects malformed decoded JSON through the public API", async () => {
  const root = await contextPlaneFixture();
  const validInput = {
    nativeSessionId: "malformed-input",
    target: { provider: "openai", harness: "codex", model: "model", role: "coding-agent" },
    projectIdentity: "/project",
    cwd: "/project",
    domainPolicy: ["coding"],
    path: "/project",
    totalBudget: { tokens: 4_000, results: 8, latencyMs: 100, costUsd: 0 },
    createdAt: "2026-08-03T12:00:00.000Z",
  } satisfies StartContextPlaneSessionInput;
  const malformedInputs: unknown[] = [
    {},
    null,
    [],
    { ...validInput, target: null },
    { ...validInput, target: { ...validInput.target, model: [] } },
    { ...validInput, cwd: 42 },
    { ...validInput, domainPolicy: "coding" },
    { ...validInput, totalBudget: [] },
    { ...validInput, path: {} },
  ];

  for (const input of malformedInputs) {
    const result = await startContextPlaneSession(root, input as StartContextPlaneSessionInput);
    expect(result).toMatchObject({ ok: false, error: { code: "invalid-input" } });
  }
});

test("context start CLI returns invalid-input for malformed JSON shape", async () => {
  const root = await contextPlaneFixture();
  const inputPath = join(root, "malformed-context-start.json");
  await writeFile(inputPath, "{}\n", "utf8");
  const child = Bun.spawn([process.execPath, "run", "src/cli.ts", "context", "start", inputPath], {
    cwd: join(import.meta.dir, ".."),
    env: { ...process.env, CHATLOG_DATA_ROOT: root },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect(exitCode).toBe(1);
  expect(stderr).toBe("");
  expect(JSON.parse(stdout)).toMatchObject({
    ok: false,
    error: { code: "invalid-input" },
  });
});
test("context start CLI rejects an oversized input before parsing it", async () => {
  const root = await contextPlaneFixture();
  const inputPath = join(root, "oversized-context-start.json");
  await writeFile(inputPath, "{}\n", "utf8");
  await truncate(inputPath, MAX_CLOSED_LOOP_ARTIFACT_BYTES + 1);
  const child = Bun.spawn([process.execPath, "run", "src/cli.ts", "context", "start", inputPath], {
    cwd: join(import.meta.dir, ".."),
    env: { ...process.env, CHATLOG_DATA_ROOT: root },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect(exitCode).toBe(1);
  expect(stderr).toBe("");
  expect(JSON.parse(stdout)).toMatchObject({
    ok: false,
    error: { code: "invalid-input", message: expect.stringContaining("file limit") },
  });
});

test("context authorize CLI rejects an oversized gate before parsing it", async () => {
  const root = await contextPlaneFixture();
  const gatePath = join(root, "oversized-context-gate.json");
  await writeFile(gatePath, "{}\n", "utf8");
  await truncate(gatePath, MAX_CLOSED_LOOP_ARTIFACT_BYTES + 1);
  const child = Bun.spawn(
    [process.execPath, "run", "src/cli.ts", "context", "authorize", gatePath],
    {
      cwd: join(import.meta.dir, ".."),
      env: { ...process.env, CHATLOG_DATA_ROOT: root },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect(exitCode).toBe(1);
  expect(stderr).toBe("");
  expect(JSON.parse(stdout)).toMatchObject({
    ok: false,
    error: { code: "invalid-input", message: expect.stringContaining("file limit") },
  });
});

async function eventBatchFileCount(root: string): Promise<number> {
  try {
    const prefixes = await readdir(join(root, "corpus", "events"));
    const files = await Promise.all(
      prefixes.map((prefix) => readdir(join(root, "corpus", "events", prefix))),
    );
    return files.reduce(
      (total, names) => total + names.filter((name) => name.endsWith(".json")).length,
      0,
    );
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")
      return 0;
    throw error;
  }
}

test("a pinned session plans and renders shadow context without claiming live delivery", async () => {
  const root = await contextPlaneFixture();
  const plane = new ContextPlane(root);
  const started = await plane.startSession({
    nativeSessionId: "native-context-test",
    target: { provider: "openai", harness: "codex", model: "model", role: "coding-agent" },
    projectIdentity: "/project",
    cwd: "/project",
    domainPolicy: ["coding"],
    path: "/project",
    totalBudget: { tokens: 4_000, results: 8, latencyMs: 100, costUsd: 0 },
    createdAt: "2026-08-03T12:00:00.000Z",
  });
  expect(started.ok).toBe(true);
  if (!started.ok) return;
  const request = {
    contextSessionId: started.value.contextSessionId,
    task: "Fix router lock contention",
    query: "router lock",
    scope: {
      user: null,
      organization: null,
      project: "/project",
      repository: "/project",
      path: "/project",
      harness: "codex",
      model: "model",
      tool: null,
      domain: "coding",
    },
    allowedItemKinds: ["evidence", "insight", "procedure", "current-state"],
    riskCeiling: "high",
    freshAfter: null,
    budget: { tokens: 3_000, results: 6, latencyMs: 100, costUsd: 0 },
    fixedInstructionTokens: 8,
    deliveryMode: "prompt-bundle",
    exposure: "shadow",
    now: "2026-08-03T12:00:01.000Z",
  } satisfies PrepareContextInput;
  const prepared = await plane.prepare(request);
  if (!prepared.ok) throw new Error(JSON.stringify(prepared.error));
  expect(prepared.ok).toBe(true);
  if (!prepared.ok) return;
  expect(prepared.value.bundle.shadow).toBe(true);
  expect(prepared.value.bundle.items.some((item) => item.id.startsWith("rev-"))).toBe(true);
  expect(prepared.value.encoded.content).toContain("router lock");
  const events = await readContextEvents(root, {
    contextSessionId: started.value.contextSessionId,
  });
  expect(events.ok).toBe(true);
  if (!events.ok) return;
  expect(events.value.map((event) => event.kind)).toEqual([
    "context.bundle.proposed",
    "context.bundle.rendered",
  ]);
  const denied = await plane.confirmEmission({
    prepared: prepared.value,
    releaseGateHash: "f".repeat(64),
    receiptEvidence: "prompt-artifact",
    receipt: {},
  });
  expect(denied).toMatchObject({ ok: false, error: { code: "release-denied" } });

  const livePrepared = await plane.prepare({
    ...request,
    exposure: "limited-insight",
    allowedItemKinds: ["procedure"],
    now: "2026-08-03T12:00:02.000Z",
  });
  if (!livePrepared.ok) throw new Error(JSON.stringify(livePrepared.error));
  const insight = livePrepared.value.bundle.items.find((item) => item.kind === "procedure");
  expect(insight).toBeDefined();
  if (!insight) return;
  const authorization = await authorizeContextRelease(
    root,
    await sourceBoundKeepGate(
      root,
      insight.id,
      createHash("sha256").update(insight.content).digest("hex"),
    ),
    "2026-08-03T12:00:03.000Z",
  );
  if (!authorization.ok) throw new Error(JSON.stringify(authorization.error));
  const replacement = await authorizeContextRelease(
    root,
    await sourceBoundKeepGate(root, "replacement-candidate", "c".repeat(64)),
    "2026-08-03T12:00:03.500Z",
  );
  if (!replacement.ok) throw new Error(JSON.stringify(replacement.error));
  const replaced = await plane.confirmEmission({
    prepared: livePrepared.value,
    releaseGateHash: authorization.value.pointer.gateHash,
    receiptEvidence: "prompt-artifact",
    receipt: { artifact: "/tmp/context-bundle-replaced.txt" },
    occurredAt: "2026-08-03T12:00:03.750Z",
  });
  const eventsAfterReplacement = await readContextEvents(root, {
    contextSessionId: started.value.contextSessionId,
    kinds: ["context.bundle.emitted"],
  });
  expect(eventsAfterReplacement.ok).toBe(true);
  if (eventsAfterReplacement.ok) expect(eventsAfterReplacement.value).toHaveLength(0);
  expect(replaced).toMatchObject({ ok: false, error: { code: "release-denied" } });
  const restored = await authorizeContextRelease(
    root,
    await sourceBoundKeepGate(
      root,
      insight.id,
      createHash("sha256").update(insight.content).digest("hex"),
    ),
    "2026-08-03T12:00:03.900Z",
  );
  if (!restored.ok) throw new Error(JSON.stringify(restored.error));
  const unsupportedAcknowledgment = await plane.confirmEmission({
    prepared: livePrepared.value,
    releaseGateHash: restored.value.pointer.gateHash,
    receiptEvidence: "provider-acknowledgment",
    receipt: { status: "accepted" },
  });
  expect(unsupportedAcknowledgment).toMatchObject({
    ok: false,
    error: { code: "release-denied" },
  });
  const confirmed = await plane.confirmEmission({
    prepared: livePrepared.value,
    releaseGateHash: restored.value.pointer.gateHash,
    receiptEvidence: "prompt-artifact",
    receipt: { artifact: "/tmp/context-bundle.txt" },
    occurredAt: "2026-08-03T12:00:04.000Z",
  });
  expect(confirmed.ok).toBe(true);
  if (!confirmed.ok) return;
  expect(confirmed.value.event.kind).toBe("context.bundle.emitted");
  const deliveredItem = livePrepared.value.bundle.items[0]!;
  const candidateContentHash = createHash("sha256").update(deliveredItem.content).digest("hex");
  expect(confirmed.value.event.payload).toMatchObject({
    contentHash: livePrepared.value.encoded.contentHash,
    candidateContentHash,
  });
  expect(livePrepared.value.encoded.contentHash).not.toBe(candidateContentHash);
  const resolvedIntervention = await resolveContextReleaseEvidence(root, {
    eventId: confirmed.value.event.eventId,
    batchHash: confirmed.value.event.batchHash,
  });
  expect(resolvedIntervention).toMatchObject({
    ok: true,
    value: {
      candidateId: deliveredItem.id,
      candidateContentHash,
    },
  });
  const sessions = await plane.listSessions();
  expect(sessions.ok).toBe(true);
  if (!sessions.ok) return;
  const sessionAfterDelivery = sessions.value.find(
    (session) => session.contextSessionId === started.value.contextSessionId,
  );
  const plannedTokens =
    livePrepared.value.bundle.budget.beforeTokens - livePrepared.value.bundle.budget.afterTokens;
  expect(livePrepared.value.encoded.estimatedTokens).not.toBe(plannedTokens);
  expect(sessionAfterDelivery?.budget.remaining.tokens).toBe(
    4_000 - livePrepared.value.encoded.estimatedTokens,
  );
  const batchesBeforeRetry = await eventBatchFileCount(root);
  const retried = await plane.confirmEmission({
    prepared: livePrepared.value,
    releaseGateHash: restored.value.pointer.gateHash,
    receiptEvidence: "prompt-artifact",
    receipt: { artifact: "/tmp/context-bundle.txt" },
    occurredAt: "2026-08-03T12:00:04.000Z",
  });
  expect(retried.ok).toBe(true);
  expect(await eventBatchFileCount(root)).toBe(batchesBeforeRetry);
  const conflictingRetry = await plane.confirmEmission({
    prepared: livePrepared.value,
    releaseGateHash: restored.value.pointer.gateHash,
    receiptEvidence: "prompt-artifact",
    receipt: { artifact: "/tmp/different-context-bundle.txt" },
  });
  expect(conflictingRetry).toMatchObject({
    ok: false,
    error: { code: "invalid-input" },
  });
  expect(await eventBatchFileCount(root)).toBe(batchesBeforeRetry);
  const sessionsAfterRetry = await plane.listSessions();
  expect(sessionsAfterRetry.ok).toBe(true);
  if (!sessionsAfterRetry.ok) return;
  expect(
    sessionsAfterRetry.value.find(
      (session) => session.contextSessionId === started.value.contextSessionId,
    )?.budget.remaining.tokens,
  ).toBe(4_000 - livePrepared.value.encoded.estimatedTokens);

  const delivered = await plane.deliver({
    nativeSessionId: "native-context-tool",
    target: { provider: "openai", harness: "codex", model: "model", role: "coding-agent" },
    projectIdentity: "/project",
    cwd: "/project",
    domain: "coding",
    task: "Fix router lock contention",
    query: "router lock",
    budget: { tokens: 2_000, results: 4, latencyMs: 100, costUsd: 0 },
    deliveryMode: "tool-recall",
    receiptEvidence: "tool-result",
    receipt: { transport: "MCP" },
    now: "2026-08-03T12:00:06.000Z",
  });
  if (!delivered.ok) throw new Error(JSON.stringify(delivered.error));
  expect(delivered.value.itemId).toBe(insight.id);
  expect(delivered.value.content).toContain("Router writes require serialized lock custody.");
  expect(delivered.value.event.kind).toBe("context.recall.returned");
  expect(delivered.value.event.itemId).toBe(insight.id);

  const data = new McpData(root, ["coding"]);
  const state = createMcpState();
  await handleMcpMessage(
    data,
    {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18" },
    },
    state,
  );
  await handleMcpMessage(data, { jsonrpc: "2.0", method: "notifications/initialized" }, state);
  const mcpDelivery = await handleMcpMessage(
    data,
    {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "chatlog_context",
        arguments: {
          contextSessionId: started.value.contextSessionId,
          nativeSessionId: "native-context-mcp",
          provider: "openai",
          harness: "codex",
          model: "model",
          project: "/project",
          cwd: "/project",
          path: "/project",
          domain: "coding",
          task: "Fix router lock contention",
          query: "router lock",
        },
      },
    },
    state,
  );
  const personalSession = await plane.startSession({
    nativeSessionId: "native-context-personal",
    target: { provider: "openai", harness: "codex", model: "model", role: "coding-agent" },
    projectIdentity: "/project",
    cwd: "/project",
    domainPolicy: ["personal"],
    path: "/project",
    totalBudget: { tokens: 2_000, results: 4, latencyMs: 100, costUsd: 0 },
    createdAt: "2026-08-03T12:00:06.500Z",
  });
  if (!personalSession.ok) throw new Error(personalSession.error.message);
  const deniedMcpDelivery = (await handleMcpMessage(
    data,
    {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "chatlog_context",
        arguments: {
          contextSessionId: personalSession.value.contextSessionId,
          provider: "openai",
          harness: "codex",
          model: "model",
          project: "/project",
          cwd: "/project",
          path: "/project",
          domain: "personal",
          task: "Read personal context",
          query: "personal",
        },
      },
    },
    state,
  )) as {
    result: { isError?: boolean; content: Array<{ text: string }> };
  };
  expect(deniedMcpDelivery.result.isError).toBe(true);
  expect(deniedMcpDelivery.result.content[0]?.text).toContain("domain access denied: personal");
  data.close();
  expect(JSON.stringify(mcpDelivery)).toContain("Router writes require serialized lock custody.");
  expect(JSON.stringify(mcpDelivery)).toContain("context.recall.returned");

  const cliRequestPath = join(root, "context-delivery.json");
  await writeFile(
    cliRequestPath,
    JSON.stringify({
      nativeSessionId: "native-context-cli",
      target: {
        provider: "openai",
        harness: "codex",
        model: "model",
        role: "coding-agent",
      },
      projectIdentity: "/project",
      cwd: "/project",
      domain: "coding",
      path: "/project",
      task: "Fix router lock contention",
      query: "router lock",
      budget: { tokens: 2_000, results: 4, latencyMs: 100, costUsd: 0 },
      deliveryMode: "tool-recall",
      receiptEvidence: "tool-result",
      receipt: { transport: "cli-smoke" },
    }),
  );
  const cli = Bun.spawn(["bun", "run", "src/cli.ts", "context", "deliver", cliRequestPath], {
    cwd: join(import.meta.dir, ".."),
    env: { ...process.env, CHATLOG_DATA_ROOT: root },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    cli.exited,
    new Response(cli.stdout).text(),
    new Response(cli.stderr).text(),
  ]);
  expect(stderr).toBe("");
  if (exitCode !== 0)
    throw new Error(`context deliver CLI exited ${exitCode}: ${stdout || stderr}`);
  expect(stdout).toContain("Router writes require serialized lock custody.");
  expect(stdout).toContain("context.recall.returned");
});

test("confirmation rejects edited prepared JSON before event or budget mutation", async () => {
  const root = await contextPlaneFixture();
  const plane = new ContextPlane(root);
  const started = await plane.startSession({
    nativeSessionId: "native-context-integrity",
    target: { provider: "openai", harness: "codex", model: "model", role: "coding-agent" },
    projectIdentity: "/project",
    cwd: "/project",
    domainPolicy: ["coding"],
    path: "/project",
    totalBudget: { tokens: 4_000, results: 8, latencyMs: 100, costUsd: 0 },
    createdAt: "2026-08-03T13:00:00.000Z",
  });
  expect(started.ok).toBe(true);
  if (!started.ok) return;
  const prepared = await plane.prepare({
    contextSessionId: started.value.contextSessionId,
    task: "Fix router lock contention",
    query: "router lock",
    scope: {
      user: null,
      organization: null,
      project: "/project",
      repository: "/project",
      path: "/project",
      harness: "codex",
      model: "model",
      tool: null,
      domain: "coding",
    },
    allowedItemKinds: ["procedure"],
    riskCeiling: "high",
    freshAfter: null,
    budget: { tokens: 3_000, results: 4, latencyMs: 100, costUsd: 0 },
    fixedInstructionTokens: 8,
    deliveryMode: "prompt-bundle",
    exposure: "limited-insight",
    now: "2026-08-03T13:00:01.000Z",
  });
  if (!prepared.ok) throw new Error(JSON.stringify(prepared.error));
  const item = prepared.value.bundle.items[0];
  expect(item).toBeDefined();
  if (!item) return;
  const authorization = await authorizeContextRelease(
    root,
    await sourceBoundKeepGate(
      root,
      item.id,
      createHash("sha256").update(item.content).digest("hex"),
    ),
    "2026-08-03T13:00:02.000Z",
  );
  if (!authorization.ok) throw new Error(JSON.stringify(authorization.error));

  for (const editPrepared of [
    (forged: typeof prepared.value) =>
      Reflect.set(forged.encoded, "estimatedTokens", forged.encoded.estimatedTokens + 1),
    (forged: typeof prepared.value) =>
      Reflect.set(
        forged.encoded,
        "content",
        `${"oversized wrapper ".repeat(1_000)}${forged.encoded.content}`,
      ),
    (forged: typeof prepared.value) =>
      Reflect.set(forged.bundle.budget, "afterTokens", forged.bundle.budget.afterTokens + 1),
    (forged: typeof prepared.value) => {
      const first = forged.bundle.items[0];
      if (first) Reflect.set(first, "content", `${first.content} forged`);
    },
  ]) {
    const forged = JSON.parse(JSON.stringify(prepared.value)) as typeof prepared.value;
    editPrepared(forged);
    const beforeEvents = await readContextEvents(root, {
      contextSessionId: started.value.contextSessionId,
    });
    const beforeSessions = await plane.listSessions();
    expect(beforeEvents.ok).toBe(true);
    expect(beforeSessions.ok).toBe(true);
    if (!beforeEvents.ok || !beforeSessions.ok) return;
    const beforeRemaining = beforeSessions.value.find(
      (session) => session.contextSessionId === started.value.contextSessionId,
    )?.budget.remaining;
    const denied = await plane.confirmEmission({
      prepared: forged,
      releaseGateHash: authorization.value.pointer.gateHash,
      receiptEvidence: "prompt-artifact",
      receipt: { artifact: "/tmp/context-integrity.txt" },
      occurredAt: "2026-08-03T13:00:03.000Z",
    });
    expect(denied).toMatchObject({ ok: false, error: { code: "invalid-input" } });
    const afterEvents = await readContextEvents(root, {
      contextSessionId: started.value.contextSessionId,
    });
    const afterSessions = await plane.listSessions();
    expect(afterEvents.ok).toBe(true);
    expect(afterSessions.ok).toBe(true);
    if (!afterEvents.ok || !afterSessions.ok) return;
    expect(afterEvents.value).toEqual(beforeEvents.value);
    expect(
      afterSessions.value.find(
        (session) => session.contextSessionId === started.value.contextSessionId,
      )?.budget.remaining,
    ).toEqual(beforeRemaining);
  }
});

test("preparation rejects actual rendered tokens over the request budget", async () => {
  const root = await contextPlaneFixture();
  const plane = new ContextPlane(root);
  const started = await plane.startSession({
    nativeSessionId: "native-context-render-budget",
    target: { provider: "openai", harness: "codex", model: "model", role: "coding-agent" },
    projectIdentity: "/project",
    cwd: "/project",
    domainPolicy: ["coding"],
    path: "/project",
    totalBudget: { tokens: 4_000, results: 8, latencyMs: 100, costUsd: 0 },
    createdAt: "2026-08-03T14:00:00.000Z",
  });
  expect(started.ok).toBe(true);
  if (!started.ok) return;
  const prepared = await plane.prepare({
    contextSessionId: started.value.contextSessionId,
    task: "Fix router lock contention",
    query: "router lock",
    scope: {
      user: null,
      organization: null,
      project: "/project",
      repository: "/project",
      path: "/project",
      harness: "codex",
      model: "model",
      tool: null,
      domain: "coding",
    },
    allowedItemKinds: ["procedure"],
    riskCeiling: "high",
    freshAfter: null,
    budget: { tokens: 80, results: 1, latencyMs: 100, costUsd: 0 },
    fixedInstructionTokens: 0,
    deliveryMode: "prompt-bundle",
    exposure: "shadow",
    now: "2026-08-03T14:00:01.000Z",
  });
  expect(prepared).toMatchObject({
    ok: false,
    error: { code: "delivery-error" },
  });
  const events = await readContextEvents(root, {
    contextSessionId: started.value.contextSessionId,
  });
  expect(events.ok).toBe(true);
  if (!events.ok) return;
  expect(events.value).toHaveLength(1);
  expect(events.value[0]).toMatchObject({
    kind: "context.delivery.failed",
    state: "failed",
    payload: { phase: "admission", code: "budget-overflow" },
  });
  const sessions = await plane.listSessions();
  if (!sessions.ok) throw new Error(sessions.error.message);
  expect(
    sessions.value.find((session) => session.contextSessionId === started.value.contextSessionId)
      ?.budget.remaining,
  ).toEqual(started.value.budget.remaining);
});

test("delivery event storage failure leaves session budget unspent", async () => {
  const root = await contextPlaneFixture();
  const plane = new ContextPlane(root);
  const started = await plane.startSession({
    nativeSessionId: "native-context-storage-failure",
    target: { provider: "openai", harness: "codex", model: "model", role: "coding-agent" },
    projectIdentity: "/project",
    cwd: "/project",
    domainPolicy: ["coding"],
    path: "/project",
    totalBudget: { tokens: 4_000, results: 8, latencyMs: 100, costUsd: 0 },
    createdAt: "2026-08-03T15:00:00.000Z",
  });
  if (!started.ok) throw new Error(JSON.stringify(started.error));
  const prepared = await plane.prepare({
    contextSessionId: started.value.contextSessionId,
    task: "Fix router lock contention",
    query: "router lock",
    scope: {
      user: null,
      organization: null,
      project: "/project",
      repository: "/project",
      path: "/project",
      harness: "codex",
      model: "model",
      tool: null,
      domain: "coding",
    },
    allowedItemKinds: ["procedure"],
    riskCeiling: "high",
    freshAfter: null,
    budget: { tokens: 3_000, results: 4, latencyMs: 100, costUsd: 0 },
    fixedInstructionTokens: 8,
    deliveryMode: "prompt-bundle",
    exposure: "limited-insight",
    now: "2026-08-03T15:00:01.000Z",
  });
  if (!prepared.ok) throw new Error(JSON.stringify(prepared.error));
  const item = prepared.value.bundle.items[0];
  if (!item) throw new Error("expected a prepared procedure");
  const authorization = await authorizeContextRelease(
    root,
    await sourceBoundKeepGate(
      root,
      item.id,
      createHash("sha256").update(item.content).digest("hex"),
    ),
    "2026-08-03T15:00:02.000Z",
  );
  if (!authorization.ok) throw new Error(JSON.stringify(authorization.error));

  const eventDirectory = join(root, "corpus", "events");
  await chmod(eventDirectory, 0o500);
  const confirmed = await plane.confirmEmission({
    prepared: prepared.value,
    releaseGateHash: authorization.value.pointer.gateHash,
    receiptEvidence: "prompt-artifact",
    receipt: { artifact: "/tmp/context-storage-failure.txt" },
    occurredAt: "2026-08-03T15:00:03.000Z",
  });
  await chmod(eventDirectory, 0o700);

  expect(confirmed).toMatchObject({ ok: false, error: { code: "event-error" } });
  const sessions = await plane.listSessions();
  if (!sessions.ok) throw new Error(sessions.error.message);
  const stored = sessions.value.find(
    (session) => session.contextSessionId === started.value.contextSessionId,
  );
  expect(stored?.budget.remaining).toEqual(started.value.budget.remaining);
  expect(stored?.consumedBundleHashes).toEqual([]);
  const events = await readContextEvents(root, {
    contextSessionId: started.value.contextSessionId,
  });
  if (!events.ok) throw new Error(events.error.message);
  expect(events.value.map((event) => event.kind)).toEqual([
    "context.bundle.proposed",
    "context.bundle.rendered",
  ]);
});
