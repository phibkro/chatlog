import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { indexConversation, indexEventBatch, openAnalysis } from "../src/analysis";
import { readContextEvents } from "../src/context-events";
import { startContextPlaneSession } from "../src/context-plane";
import { openContextSession } from "../src/context-session";
import { deriveCorpus } from "../src/derive";
import { persistEventBatch } from "../src/event-store";
import { eventEvidenceUri } from "../src/evidence-uri";
import { canonicalizeConversation } from "../src/conversation-projection";
import { capture, makeEvent, makeObservedSource } from "../src/events";
import { isMcpDataFailure, McpData, parseDomainPolicy } from "../src/mcp/data";
import {
  createMcpState,
  handleMcpMessage,
  MCP_MAX_LINE_BYTES,
  processMcpLine,
} from "../src/mcp/server";
import { reconcileActiveSources } from "../src/source-authority";
import type { Conversation } from "../src/types";
import { applyInsightMigration } from "../src/insight-migration";
import { readCurrentInsightLedger, recompileCurrentInsightLedger } from "../src/insight-ledger";
import type { AcceptedMemoryLedger } from "../src/experience-memory";
import { syntheticEventBatch } from "./event-fixture";

async function fixture(): Promise<{
  root: string;
  coding: Conversation;
  staleCoding: Conversation;
  personal: Conversation;
  codingEventUri: string;
  reasoningEventUri: string;
  opaqueEventUri: string;
  codingBatchHash: string;
  staleEventUri: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "chatlog-mcp-"));
  const coding = canonicalizeConversation({
    id: "coding-session",
    title: "Projection repair",
    provider: "openai",
    harness: "codex",
    domain: "Coding",
    sourceKind: "session-log",
    project: "/project",
    cwd: "/project",
    model: "model",
    startedAt: "2026-07-01T00:00:00Z",
    endedAt: "2026-07-01T00:01:00Z",
    sourcePath: "/coding",
    turns: [
      { role: "user", content: `Remember the projection repair. ${"x".repeat(13_000)}` },
      { role: "assistant", content: "I decided to rebuild the index and the tests passed." },
      { role: "tool", content: "toolsecret should never appear in agent discovery or evidence" },
    ],
  });
  const personal: Conversation = {
    id: "personal-session",
    title: "Private memory",
    provider: "anthropic",
    harness: "claude-web",
    domain: "personal",
    sourceKind: "anthropic-data-export",
    project: "/project",
    cwd: "",
    model: "model",
    startedAt: "2026-07-02T00:00:00Z",
    endedAt: "2026-07-02T00:01:00Z",
    sourcePath: "/personal",
    contentHash: "b".repeat(64),
    turns: [{ role: "user", content: "Remember an extremely private family memory." }],
  };
  const staleCoding: Conversation = {
    ...coding,
    id: "stale-coding-session",
    contentHash: "c".repeat(64),
    turns: [{ role: "user", content: "This indexed object is no longer active." }],
  };
  const db = openAnalysis(join(root, "analysis", "chatlog.sqlite"));
  indexConversation(db, staleCoding, 0, 1);
  indexConversation(db, coding, 1, 1);
  indexConversation(db, personal, 1, 1);
  for (const conversation of [staleCoding, coding, personal]) {
    const directory = join(root, "corpus", "objects", conversation.contentHash.slice(0, 2));
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, `${conversation.contentHash}.json`),
      JSON.stringify(conversation),
    );
  }
  const { contentHash: _codingHash, ...codingProjection } = coding;
  const codingBatch = syntheticEventBatch(codingProjection);
  const sourceOrigin = codingBatch.events[0]!.origin;
  if (sourceOrigin.kind !== "observed") throw new Error("synthetic event source is not observed");
  const { redactedNativeRecordHash: _redactedNativeRecordHash, ...sourceBase } =
    sourceOrigin.source;
  const appendBlockedEvent = (
    kind: "model.reasoning.observed" | "provider.opaque",
    disposition: "normalized" | "opaque",
    sequence: number,
    parent: string,
  ) =>
    makeEvent({
      kind,
      sequence,
      actor: { kind: "provider", name: coding.harness },
      scope: codingBatch.events[0]!.scope,
      origin: {
        kind: "observed",
        source: makeObservedSource(
          {
            ...sourceBase,
            nativeItemId: `${coding.id}:blocked:${sequence}`,
            recordPosition: { record: sequence },
          },
          { kind, secret: `blocked-${sequence}` },
        ),
      },
      relations: { parent },
      payload: { kind, secret: `blocked-${sequence}` },
      capture: capture(disposition),
    });
  const reasoningEvent = appendBlockedEvent(
    "model.reasoning.observed",
    "normalized",
    codingBatch.events.length,
    codingBatch.events.at(-1)!.eventId,
  );
  const opaqueEvent = appendBlockedEvent(
    "provider.opaque",
    "opaque",
    codingBatch.events.length + 1,
    reasoningEvent.eventId,
  );
  const restrictedCodingBatch = {
    ...codingBatch,
    events: [...codingBatch.events, reasoningEvent, opaqueEvent],
  };
  const codingBatchHash = await persistEventBatch(root, restrictedCodingBatch);
  indexEventBatch(db, restrictedCodingBatch, codingBatchHash, coding.contentHash);
  const { contentHash: _staleHash, ...staleProjection } = staleCoding;
  const staleBatch = syntheticEventBatch(staleProjection);
  const staleBatchHash = await persistEventBatch(root, staleBatch);
  indexEventBatch(db, staleBatch, staleBatchHash, staleCoding.contentHash);
  await writeFile(
    join(root, "corpus", "manifest.json"),
    JSON.stringify({
      version: 1,
      sources: {
        "/coding": {
          contentHash: coding.contentHash,
          eventBatchHash: codingBatchHash,
          conversationProjectionHash: coding.contentHash,
        },
        "/personal": { contentHash: personal.contentHash },
      },
    }),
  );
  reconcileActiveSources(db, {
    "/coding": {
      contentHash: coding.contentHash,
      eventBatchHash: codingBatchHash,
      conversationProjectionHash: coding.contentHash,
    },
    "/personal": { contentHash: personal.contentHash },
  });
  db.close();
  await deriveCorpus(root);
  const fixtureEvidenceUri = eventEvidenceUri(
    codingBatchHash,
    codingBatch.events[0]!.eventId,
  ) as `chatlog://${string}`;
  const memoryLedger: AcceptedMemoryLedger = {
    schemaVersion: 1,
    ledgerId: "mcp-fixture",
    projectIdentity: "/project",
    entries: [
      {
        id: "fixture-memory",
        status: "accepted",
        judgment: "correct",
        valence: "positive",
        provenance: {
          packetHash: "d".repeat(64),
          proposalSetHash: "e".repeat(64),
          operatorReviewHash: "f".repeat(64),
          candidateAlias: "C001",
          candidateId: "a".repeat(20),
        },
        trigger: "MCP fixture context",
        scope: { kind: "global", value: null },
        polarity: "check",
        action: "Use the pinned context projection.",
        situation: "MCP context validation is under test.",
        outcome: "The current insight projection is available.",
        lesson: "Pin the current insight projection before context delivery.",
        confidence: 0.9,
        freshness: "current",
        canonicalDocs: ["design-specs/experience-memory.md"],
        evidencePointers: [fixtureEvidenceUri],
      },
    ],
  };
  const memory = memoryLedger.entries[0]!;
  const packetHash = memory.provenance.packetHash;
  const proposals = {
    schemaVersion: 1,
    packetHash,
    generator: { provider: "test" },
    proposals: {
      C001: {
        lesson: memory.lesson,
        suggestedValence: "positive",
        rationale: "fixture",
      },
    },
  };
  const proposalBytes = `${JSON.stringify(proposals, null, 2)}\n`;
  memory.provenance.proposalSetHash = createHash("sha256").update(proposalBytes).digest("hex");
  const reviews = {
    schemaVersion: 1,
    packetHash,
    proposalSetHash: memory.provenance.proposalSetHash,
    reviewer: { id: "fixture" },
    reviews: {
      C001: {
        status: "reviewed",
        judgment: "correct",
        valence: "positive",
        feedback: "",
      },
    },
  };
  const reviewBytes = `${JSON.stringify(reviews, null, 2)}\n`;
  memory.provenance.operatorReviewHash = createHash("sha256").update(reviewBytes).digest("hex");
  await Promise.all([
    mkdir(join(root, "derived", "adjudication", "refinery", packetHash, "public"), {
      recursive: true,
    }),
    mkdir(join(root, "derived", "adjudication", "refinery-private", packetHash), {
      recursive: true,
    }),
    mkdir(join(root, "memory"), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(
      join(root, "derived", "adjudication", "refinery", packetHash, "public", "proposals.json"),
      proposalBytes,
    ),
    writeFile(
      join(
        root,
        "derived",
        "adjudication",
        "refinery",
        packetHash,
        "public",
        "operator-reviews.json",
      ),
      reviewBytes,
    ),
    writeFile(
      join(root, "derived", "adjudication", "refinery-private", packetHash, "manifest.json"),
      `${JSON.stringify({
        schemaVersion: 1,
        packetHash,
        candidates: [{ candidateAlias: "C001", candidateId: memory.provenance.candidateId }],
      })}\n`,
    ),
    writeFile(join(root, "memory", "accepted-ledger.json"), `${JSON.stringify(memoryLedger)}\n`, {
      mode: 0o600,
    }),
  ]);
  const migrated = await applyInsightMigration(root);
  if (!migrated.ok) throw new Error(JSON.stringify(migrated.error));
  return {
    root,
    coding,
    staleCoding,
    personal,
    codingEventUri: eventEvidenceUri(codingBatchHash, codingBatch.events[0]!.eventId),
    reasoningEventUri: eventEvidenceUri(codingBatchHash, reasoningEvent.eventId),
    opaqueEventUri: eventEvidenceUri(codingBatchHash, opaqueEvent.eventId),
    codingBatchHash,
    staleEventUri: eventEvidenceUri(staleBatchHash, staleBatch.events[0]!.eventId),
  };
}

function expectMcpFailure(value: unknown, message: string): void {
  expect(isMcpDataFailure(value)).toBe(true);
  if (isMcpDataFailure(value)) expect(value.error.message).toContain(message);
}

test("MCP data applies domain policy before limits and rechecks canonical evidence", async () => {
  expect(parseDomainPolicy("")).toEqual(["coding"]);
  expect(parseDomainPolicy("research,coding,research")).toEqual(["coding", "research"]);
  const {
    root,
    coding,
    staleCoding,
    personal,
    codingBatchHash,
    codingEventUri,
    reasoningEventUri,
    opaqueEventUri,
    staleEventUri,
  } = await fixture();
  const data = new McpData(root);
  try {
    const search = data.search({ query: "remember", limit: 1 }) as any;
    expect(search.policy).toEqual({ configuredDomains: ["coding"], effectiveDomains: ["coding"] });
    expect(search.hits).toHaveLength(1);
    expect(search.hits[0].sessionId).toBe(coding.id);
    expect(JSON.stringify(search)).not.toContain("private family");
    expect((data.search({ query: "toolsecret" }) as any).hits).toHaveLength(0);

    const recent = data.recentWork({ project: "/project", limit: 20 }) as any;
    expect(recent.sessions).toHaveLength(1);
    expect(recent.sessions[0].sessionId).toBe(coding.id);

    await unlink(
      join(
        root,
        "derived",
        "objects",
        coding.contentHash.slice(0, 2),
        `${coding.contentHash}.json`,
      ),
    );
    const brief = (await data.projectBrief({ project: "/project" })) as any;
    expect(brief.overview.sessions).toBe(1);
    expect(brief.derivedMissing).toBe(1);
    expect(JSON.stringify(brief)).not.toContain(personal.id);

    const codingEvidence = (await data.evidence({
      uri: `chatlog://conversation/${coding.contentHash.toUpperCase()}/turn/0`,
    })) as any;
    expect(codingEvidence.evidenceUri).toBe(`chatlog://conversation/${coding.contentHash}/turn/0`);
    expect(codingEvidence.truncated).toBe(true);
    expect(codingEvidence.turn.content).toHaveLength(12_000);
    expect(codingEvidence.fullLength).toBeGreaterThan(12_000);
    expect(codingEvidence.turn.toolCalls).toBeUndefined();
    const codingObjectPath = join(
      root,
      "corpus",
      "objects",
      coding.contentHash.slice(0, 2),
      `${coding.contentHash}.json`,
    );
    await writeFile(
      codingObjectPath,
      JSON.stringify({
        ...coding,
        turns: coding.turns.map((turn, index) =>
          index === 0 ? { ...turn, content: `${turn.content} tampered` } : turn,
        ),
      }),
    );
    expectMcpFailure(
      await data.evidence({
        uri: `chatlog://conversation/${coding.contentHash}/turn/0`,
      }),
      "evidence not found or not permitted",
    );
    await writeFile(codingObjectPath, JSON.stringify(coding));
    const eventEvidence = await data.evidence({ uri: codingEventUri });
    expect(eventEvidence).toMatchObject({
      evidenceUri: codingEventUri,
      conversationHash: coding.contentHash,
      sessionId: coding.id,
      eventKind: "session.started",
      domain: "coding",
    });
    if (!eventEvidence || typeof eventEvidence !== "object" || !("event" in eventEvidence))
      throw new Error("event evidence response is missing event data");
    const eventPayload = eventEvidence.event;
    if (!eventPayload || typeof eventPayload !== "object" || !("payload" in eventPayload))
      throw new Error("event evidence response is missing its payload");
    expect(eventPayload.payload).toContain('"sessionId":"coding-session"');
    expectMcpFailure(
      await data.evidence({ uri: reasoningEventUri }),
      "evidence not found or not permitted",
    );
    expectMcpFailure(
      await data.evidence({ uri: opaqueEventUri }),
      "evidence not found or not permitted",
    );
    expectMcpFailure(
      await data.evidence({ uri: staleEventUri }),
      "evidence not found or not permitted",
    );

    const inFlightEvidence = data.evidence({
      uri: `chatlog://conversation/${coding.contentHash}/turn/0`,
    });
    const projectionWriter = new Database(join(root, "analysis", "chatlog.sqlite"));
    projectionWriter.run(
      "UPDATE active_projection_meta SET reconciled_at = ? WHERE singleton = 1",
      ["2099-01-01T00:00:00.000Z"],
    );
    expectMcpFailure(
      await inFlightEvidence,
      "active source projection changed while serving the request; retry",
    );
    reconcileActiveSources(projectionWriter, {
      "/coding": {
        contentHash: coding.contentHash,
        eventBatchHash: codingBatchHash,
        conversationProjectionHash: coding.contentHash,
      },
      "/personal": { contentHash: personal.contentHash },
    });
    projectionWriter.close();

    expectMcpFailure(
      await data.evidence({
        uri: `chatlog://conversation/${personal.contentHash}/turn/0`,
      }),
      "evidence not found or not permitted",
    );
    expectMcpFailure(
      await data.evidence({
        uri: `chatlog://conversation/${staleCoding.contentHash}/turn/0`,
      }),
      "evidence not found or not permitted",
    );
    expectMcpFailure(
      await data.evidence({
        uri: `chatlog://conversation/${coding.contentHash}/turn/2`,
      }),
      "evidence not found or not permitted",
    );

    await writeFile(
      join(root, "corpus", "objects", coding.contentHash.slice(0, 2), `${coding.contentHash}.json`),
      JSON.stringify({ ...coding, domain: "personal" }),
    );
    expectMcpFailure(
      await data.evidence({
        uri: `chatlog://conversation/${coding.contentHash}/turn/0`,
      }),
      "evidence not found or not permitted",
    );
    expectMcpFailure(
      await data.evidence({
        uri: `chatlog://conversation/${"c".repeat(64)}/turn/0`,
      }),
      "evidence not found or not permitted",
    );
    expectMcpFailure(
      data.search({ query: "memory", domains: ["personal"] }),
      "domain access denied",
    );

    await writeFile(
      join(root, "corpus", "manifest.json"),
      JSON.stringify({
        version: 1,
        sources: {
          "/personal": { contentHash: personal.contentHash },
        },
      }),
    );
    expectMcpFailure(
      data.search({ query: "remember" }),
      "active source projection is unavailable or stale",
    );
  } finally {
    data.close();
  }
});

test("MCP direct context and recall validation failures use a typed channel", async () => {
  const { root } = await fixture();
  const codingSession = await startContextPlaneSession(root, {
    nativeSessionId: "validation-coding",
    target: { provider: "openai", harness: "codex", model: "model", role: "coding-agent" },
    projectIdentity: "/project",
    cwd: "/project",
    domainPolicy: ["coding"],
    path: "/project",
    totalBudget: { tokens: 2_000, results: 4, latencyMs: 250, costUsd: 0 },
  });
  if (!codingSession.ok) throw new Error(codingSession.error.message);
  const personalSession = await startContextPlaneSession(root, {
    nativeSessionId: "validation-personal",
    target: { provider: "openai", harness: "codex", model: "model", role: "coding-agent" },
    projectIdentity: "/project",
    cwd: "/project",
    domainPolicy: ["personal"],
    path: "/project",
    totalBudget: { tokens: 2_000, results: 4, latencyMs: 250, costUsd: 0 },
  });
  if (!personalSession.ok) throw new Error(personalSession.error.message);
  const data = new McpData(root);
  try {
    expectMcpFailure(
      await data.deliverContext({
        contextSessionId: "not-a-session",
        task: "validate context",
        query: "context validation",
      }),
      "contextSessionId must be a lowercase SHA-256",
    );
    expectMcpFailure(
      await data.deliverContext({
        contextSessionId: personalSession.value.contextSessionId,
        task: "validate scope",
        query: "scope validation",
      }),
      "domain access denied: personal",
    );
    expectMcpFailure(
      data.search({ query: "q".repeat(1_001) }),
      "query must be at most 1000 characters",
    );
    expectMcpFailure(
      await data.evidence({ uri: "u".repeat(513) }),
      "uri must be at most 512 characters",
    );
    expectMcpFailure(
      await data.deliverContext({
        contextSessionId: codingSession.value.contextSessionId,
        task: "validate context",
        query: "q".repeat(1_001),
      }),
      "query must be at most 1000 characters",
    );
    expectMcpFailure(
      data.search({ query: "memory", domains: Array.from({ length: 33 }, () => "coding") }),
      "domains must contain at most 32 items",
    );
    expectMcpFailure(
      await data.boundedRecall({
        contextSessionId: "not-a-session",
        query: "invalid session",
        budget: {
          maxDepth: 1,
          maxBranches: 1,
          maxQueries: 1,
          maxResults: 1,
          maxTokens: 10,
          maxLatencyMs: 10,
          maxCostUsd: 0,
        },
      }),
      "contextSessionId must be a lowercase SHA-256",
    );
  } finally {
    data.close();
  }
});

test("MCP protocol initializes, lists bounded tools, calls them, and reports structured errors", async () => {
  const { root, personal } = await fixture();
  const memoryLedger: AcceptedMemoryLedger = {
    schemaVersion: 1,
    ledgerId: "mcp-test",
    projectIdentity: "/project",
    entries: [
      {
        id: "memory-a",
        status: "accepted",
        judgment: "correct",
        valence: "positive",
        provenance: {
          packetHash: "a".repeat(64),
          proposalSetHash: "b".repeat(64),
          operatorReviewHash: "c".repeat(64),
          candidateAlias: "C001",
          candidateId: "d".repeat(20),
        },
        trigger: "the MCP test needs a memory",
        scope: { kind: "global", value: null },
        polarity: "check",
        action: "recall the card",
        situation: "MCP recall is under test.",
        outcome: "The pinned card was returned.",
        lesson: "Require a snapshot hash for recall.",
        confidence: 0.9,
        freshness: "current",
        canonicalDocs: ["design-specs/experience-memory.md"],
        evidencePointers: [`chatlog://conversation/${personal.contentHash}/turn/0`],
      },
    ],
  };
  const packetHash = memoryLedger.entries[0]!.provenance.packetHash;
  const proposals = {
    schemaVersion: 1,
    packetHash,
    generator: { provider: "test" },
    proposals: {
      C001: {
        lesson: memoryLedger.entries[0]!.lesson,
        suggestedValence: "positive",
        rationale: "test",
      },
    },
  };
  const proposalBytes = `${JSON.stringify(proposals, null, 2)}\n`;
  memoryLedger.entries[0]!.provenance.proposalSetHash = createHash("sha256")
    .update(proposalBytes)
    .digest("hex");
  const reviews = {
    schemaVersion: 1,
    packetHash,
    proposalSetHash: memoryLedger.entries[0]!.provenance.proposalSetHash,
    reviewer: { id: "test" },
    reviews: {
      C001: {
        status: "reviewed",
        judgment: "correct",
        valence: "positive",
        feedback: "",
      },
    },
  };
  const reviewBytes = `${JSON.stringify(reviews, null, 2)}\n`;
  memoryLedger.entries[0]!.provenance.operatorReviewHash = createHash("sha256")
    .update(reviewBytes)
    .digest("hex");
  const publicDirectory = join(root, "derived", "adjudication", "refinery", packetHash, "public");
  const privateDirectory = join(root, "derived", "adjudication", "refinery-private", packetHash);
  await Promise.all([
    mkdir(publicDirectory, { recursive: true }),
    mkdir(privateDirectory, { recursive: true }),
  ]);
  await Promise.all([
    writeFile(join(publicDirectory, "proposals.json"), proposalBytes),
    writeFile(join(publicDirectory, "operator-reviews.json"), reviewBytes),
    writeFile(
      join(privateDirectory, "manifest.json"),
      `${JSON.stringify({
        schemaVersion: 1,
        packetHash,
        candidates: [{ candidateAlias: "C001", candidateId: "d".repeat(20) }],
      })}\n`,
    ),
  ]);
  await mkdir(join(root, "memory"), { recursive: true });
  await writeFile(
    join(root, "memory", "accepted-ledger.json"),
    `${JSON.stringify(memoryLedger)}\n`,
    { mode: 0o600 },
  );
  const migrated = await applyInsightMigration(root);
  if (!migrated.ok) throw new Error(JSON.stringify(migrated.error));
  expect(migrated.ok).toBe(true);
  const projectionDb = new Database(join(root, "analysis", "chatlog.sqlite"));
  const originalAuthority = projectionDb
    .query("SELECT manifest_sources_hash hash FROM active_projection_meta WHERE singleton = 1")
    .get() as { hash: string };
  projectionDb
    .query("UPDATE active_projection_meta SET manifest_sources_hash = ? WHERE singleton = 1")
    .run("f".repeat(64));
  projectionDb.close();
  const stale = await readCurrentInsightLedger(root);
  expect(stale.ok).toBe(false);
  if (!stale.ok) expect(stale.error.code).toBe("stale-ledger");
  const recompiled = await recompileCurrentInsightLedger(root);
  if (!recompiled.ok) throw new Error(JSON.stringify(recompiled.error));
  expect(recompiled.ok).toBe(true);
  const restoreDb = new Database(join(root, "analysis", "chatlog.sqlite"));
  restoreDb
    .query("UPDATE active_projection_meta SET manifest_sources_hash = ? WHERE singleton = 1")
    .run(originalAuthority.hash);
  restoreDb.close();
  const restored = await recompileCurrentInsightLedger(root);
  expect(restored.ok).toBe(true);
  const currentInsight = await readCurrentInsightLedger(root);
  if (!currentInsight.ok) throw new Error(currentInsight.error.message);
  if (!migrated.ok) return;
  const contextSession = await openContextSession(root, {
    nativeSessionId: "mcp-bounded-recall",
    provider: "openai",
    harness: "codex",
    model: "model",
    role: "coding-agent",
    projectIdentity: "/project",
    cwd: "/project",
    domainPolicy: ["coding"],
    path: "/project",
    pinnedInsightProjectionHash: currentInsight.value.pointer.outputHash,
    pinnedEvidenceProjectionHash: originalAuthority.hash,
    selectionPolicyVersion: "selection-v1",
    deliveryPolicyVersion: "delivery-v1",
    totalBudget: { tokens: 1_000, results: 10, latencyMs: 1_000, costUsd: 0 },
    createdAt: "2026-08-03T10:00:00.000Z",
  });
  if (!contextSession.ok) throw new Error(contextSession.error.message);
  const data = new McpData(root);
  const state = createMcpState();
  try {
    const beforeInitialization = (await handleMcpMessage(
      data,
      {
        jsonrpc: "2.0",
        id: 0,
        method: "tools/list",
      },
      state,
    )) as any;
    expect(beforeInitialization.error).toEqual({
      code: -32002,
      message: "server not initialized",
    });

    const initialized = (await handleMcpMessage(
      data,
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "test", version: "1" },
        },
      },
      state,
    )) as any;
    expect(initialized.result).toMatchObject({
      protocolVersion: "2025-11-25",
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "chatlog" },
    });
    expect(
      await handleMcpMessage(
        data,
        {
          jsonrpc: "2.0",
          method: "notifications/initialized",
        },
        state,
      ),
    ).toBeNull();
    expect(state.initialized).toBe(true);

    const listed = (await handleMcpMessage(
      data,
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/list",
      },
      state,
    )) as any;
    expect(listed.result.tools.map((tool: any) => tool.name)).toEqual([
      "chatlog_search",
      "chatlog_get_evidence",
      "chatlog_recent_work",
      "chatlog_project_brief",
      "chatlog_context",
      "chatlog_bounded_recall",
    ]);

    const called = (await handleMcpMessage(
      data,
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "chatlog_search", arguments: { query: "projection" } },
      },
      state,
    )) as any;
    expect(called.result.isError).toBeUndefined();
    expect(called.result.structuredContent.hits).toHaveLength(1);

    const missingContextSession = (await handleMcpMessage(
      data,
      {
        jsonrpc: "2.0",
        id: 29,
        method: "tools/call",
        params: {
          name: "chatlog_context",
          arguments: {
            task: "validate context",
            query: "context validation",
          },
        },
      },
      state,
    )) as any;
    expect(missingContextSession.result.isError).toBe(true);
    expect(missingContextSession.result.content[0].text).toBe("contextSessionId must be a string");
    const invalidContext = (await handleMcpMessage(
      data,
      {
        jsonrpc: "2.0",
        id: 30,
        method: "tools/call",
        params: {
          name: "chatlog_context",
          arguments: {
            contextSessionId: "not-a-session",
            task: "validate context",
            query: "context validation",
          },
        },
      },
      state,
    )) as any;
    expect(invalidContext.result.isError).toBe(true);
    expect(invalidContext.result.content[0].text).toBe(
      "contextSessionId must be a lowercase SHA-256",
    );

    const invalidRecall = (await handleMcpMessage(
      data,
      {
        jsonrpc: "2.0",
        id: 31,
        method: "tools/call",
        params: {
          name: "chatlog_bounded_recall",
          arguments: {
            contextSessionId: "not-a-session",
            query: "invalid session",
            budget: {
              maxDepth: 1,
              maxBranches: 1,
              maxQueries: 1,
              maxResults: 1,
              maxTokens: 10,
              maxLatencyMs: 10,
              maxCostUsd: 0,
            },
          },
        },
      },
      state,
    )) as any;
    expect(invalidRecall.result.isError).toBe(true);
    expect(invalidRecall.result.content[0].text).toBe(
      "contextSessionId must be a lowercase SHA-256",
    );

    const boundedRecall = (await handleMcpMessage(
      data,
      {
        jsonrpc: "2.0",
        id: 32,
        method: "tools/call",
        params: {
          name: "chatlog_bounded_recall",
          arguments: {
            invocationId: "mcp-recall-1",
            contextSessionId: contextSession.value.contextSessionId,
            query: "projection repair",
            budget: {
              maxDepth: 1,
              maxBranches: 1,
              maxQueries: 1,
              maxResults: 2,
              maxTokens: 100,
              maxLatencyMs: 100,
              maxCostUsd: 0,
            },
          },
        },
      },
      state,
    )) as any;
    expect(boundedRecall.result.isError).toBeUndefined();
    expect(boundedRecall.result.structuredContent.evidence).toHaveLength(1);
    expect(boundedRecall.result.structuredContent.trace.terminationReason).toBe(
      "sufficient-evidence",
    );
    const rootScopedSession = await openContextSession(root, {
      nativeSessionId: "mcp-bounded-recall-root",
      provider: "openai",
      harness: "codex",
      model: "model",
      role: "coding-agent",
      projectIdentity: "/project",
      cwd: "/project",
      domainPolicy: ["coding"],
      path: "/",
      pinnedInsightProjectionHash: currentInsight.value.pointer.outputHash,
      pinnedEvidenceProjectionHash: originalAuthority.hash,
      selectionPolicyVersion: "selection-v1",
      deliveryPolicyVersion: "delivery-v1",
      totalBudget: { tokens: 1_000, results: 10, latencyMs: 1_000, costUsd: 0 },
      createdAt: "2026-08-03T10:00:00.500Z",
    });
    if (!rootScopedSession.ok) throw new Error(rootScopedSession.error.message);
    const rootScopedRecall = (await data.boundedRecall({
      contextSessionId: rootScopedSession.value.contextSessionId,
      query: "projection repair",
      budget: {
        maxDepth: 1,
        maxBranches: 1,
        maxQueries: 1,
        maxResults: 2,
        maxTokens: 100,
        maxLatencyMs: 100,
        maxCostUsd: 0,
      },
    })) as any;
    expect(rootScopedRecall.evidence).toHaveLength(1);
    const mismatchedSession = await openContextSession(root, {
      nativeSessionId: "mcp-bounded-recall-mismatched",
      provider: "openai",
      harness: "codex",
      model: "model",
      role: "coding-agent",
      projectIdentity: "/other-project",
      cwd: "/other-project",
      domainPolicy: ["coding"],
      path: "/other-project",
      pinnedInsightProjectionHash: currentInsight.value.pointer.outputHash,
      pinnedEvidenceProjectionHash: originalAuthority.hash,
      selectionPolicyVersion: "selection-v1",
      deliveryPolicyVersion: "delivery-v1",
      totalBudget: { tokens: 1_000, results: 10, latencyMs: 1_000, costUsd: 0 },
      createdAt: "2026-08-03T10:00:01.000Z",
    });
    if (!mismatchedSession.ok) throw new Error(mismatchedSession.error.message);
    const mismatchedRecall = (await data.boundedRecall({
      contextSessionId: mismatchedSession.value.contextSessionId,
      query: "projection repair",
      budget: {
        maxDepth: 1,
        maxBranches: 1,
        maxQueries: 1,
        maxResults: 2,
        maxTokens: 100,
        maxLatencyMs: 100,
        maxCostUsd: 0,
      },
    })) as any;
    expect(mismatchedRecall.evidence).toHaveLength(0);
    const recallEvents = await readContextEvents(root, {
      contextSessionId: contextSession.value.contextSessionId,
    });
    if (!recallEvents.ok) throw new Error(recallEvents.error.message);
    expect(recallEvents.value.map((event) => event.kind)).toContain("context.recall.returned");

    const cliRequestPath = join(root, "bounded-recall-request.json");
    await writeFile(
      cliRequestPath,
      JSON.stringify({
        invocationId: "mcp-cli-recall-1",
        contextSessionId: contextSession.value.contextSessionId,
        query: "projection repair",
        budget: {
          maxDepth: 1,
          maxBranches: 1,
          maxQueries: 1,
          maxResults: 2,
          maxTokens: 100,
          maxLatencyMs: 100,
          maxCostUsd: 0,
        },
      }),
    );
    const recallCli = Bun.spawn(["bun", "run", "src/cli.ts", "context", "recall", cliRequestPath], {
      cwd: join(import.meta.dir, ".."),
      env: {
        ...process.env,
        CHATLOG_DATA_ROOT: root,
        CHATLOG_MCP_DOMAINS: "coding",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await recallCli.exited).toBe(0);
    const cliRecall = (await new Response(recallCli.stdout).json()) as {
      value: { evidence: unknown[] };
    };
    expect(cliRecall.value.evidence).toHaveLength(1);

    const denied = (await handleMcpMessage(
      data,
      {
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: {
          name: "chatlog_get_evidence",
          arguments: { uri: `chatlog://conversation/${personal.contentHash}/turn/0` },
        },
      },
      state,
    )) as any;
    expect(denied.result.isError).toBe(true);
    expect(denied.result.content[0].text).toBe("evidence not found or not permitted");

    const unknownMethod = (await handleMcpMessage(
      data,
      {
        jsonrpc: "2.0",
        id: 5,
        method: "archive/everything",
      },
      state,
    )) as any;
    expect(unknownMethod.error.code).toBe(-32601);
    expect(((await processMcpLine(data, "{", state)) as any).error.code).toBe(-32700);
    const oversized = (await processMcpLine(
      data,
      " ".repeat(MCP_MAX_LINE_BYTES + 1),
      state,
    )) as any;
    expect(oversized.error.code).toBe(-32600);
    expect(oversized.error.message).toContain("JSON-RPC request exceeds");
    const driftRequest = {
      contextSessionId: contextSession.value.contextSessionId,
      invocationId: "mcp-drift-recall",
      query: "projection repair",
      budget: {
        maxDepth: 1,
        maxBranches: 1,
        maxQueries: 1,
        maxResults: 2,
        maxTokens: 100,
        maxLatencyMs: 100,
        maxCostUsd: 0,
      },
    };
    const evidenceDriftDb = new Database(join(root, "analysis", "chatlog.sqlite"));
    evidenceDriftDb
      .query("UPDATE active_projection_meta SET manifest_sources_hash = ? WHERE singleton = 1")
      .run("f".repeat(64));
    evidenceDriftDb.close();
    expectMcpFailure(
      await data.boundedRecall(driftRequest),
      "active source projection is unavailable or stale",
    );
    const restoredEvidenceDb = new Database(join(root, "analysis", "chatlog.sqlite"));
    restoredEvidenceDb
      .query("UPDATE active_projection_meta SET manifest_sources_hash = ? WHERE singleton = 1")
      .run(originalAuthority.hash);
    restoredEvidenceDb.close();
    await writeFile(
      join(root, "memory", "insight-current.json"),
      JSON.stringify({ ...currentInsight.value.pointer, outputHash: "f".repeat(64) }),
    );
    expectMcpFailure(
      await data.boundedRecall(driftRequest),
      "published insight projection is unavailable or stale",
    );
    await writeFile(
      join(root, "memory", "insight-current.json"),
      JSON.stringify(currentInsight.value.pointer),
    );
  } finally {
    data.close();
  }
});

test("MCP stdio emits one JSON-RPC message per line and no diagnostic stdout", async () => {
  const { root } = await fixture();
  const transcript =
    [
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "test", version: "1" },
        },
      },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "chatlog_search", arguments: { query: "projection" } },
      },
    ]
      .map((message) => JSON.stringify(message))
      .join("\n") + "\n";
  const child = Bun.spawn([process.execPath, "run", "src/mcp/server.ts"], {
    cwd: join(import.meta.dir, ".."),
    env: { ...process.env, CHATLOG_DATA_ROOT: root, CHATLOG_MCP_DOMAINS: "coding" },
    stdin: new Blob([transcript]),
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(exitCode).toBe(0);
  expect(stderr).toBe("");
  const lines = stdout.trim().split("\n");
  expect(lines).toHaveLength(3);
  const messages = lines.map((line) => JSON.parse(line));
  expect(messages.map((message) => message.id)).toEqual([1, 2, 3]);
  expect(messages[2].result.structuredContent.hits).toHaveLength(1);
});
