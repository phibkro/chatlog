import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { indexConversation, indexEventBatch, openAnalysis } from "../src/analysis";
import { deriveCorpus } from "../src/derive";
import { assertDerivedProjection, type DerivedProjectionReceipt } from "../src/derived-authority";
import { persistEventBatch } from "../src/event-store";
import { eventEvidenceUri } from "../src/evidence-uri";
import { capture, makeEvent, makeObservedSource } from "../src/events";
import { WorkbenchData } from "../src/workbench/data";
import { resolveBindConfig, workbenchHandler } from "../src/workbench/server";
import { writeImportReceipt } from "../src/import-receipts";
import {
  buildSourceReceipt,
  persistSourceReceipt,
  persistUnknownShapeNominations,
} from "../src/source-receipts";
import { reconcileActiveSources } from "../src/source-authority";
import type { Conversation } from "../src/types";
import { topicCacheKey, VAULT_TOPIC_RECIPE } from "../src/vault";
import { syntheticEventBatch } from "./event-fixture";

function sha256(text: string): string {
  return new Bun.CryptoHasher("sha256").update(text).digest("hex");
}

function evidencePointers(
  count: number,
): Array<{ pointer: string | { uri: string }; snippet: string }> {
  return Array.from({ length: count }, (_, index) => ({
    pointer:
      index % 2 === 0
        ? `chatlog://conversation/${(index + 1).toString(16).repeat(64)}/turn/${index}`
        : {
            uri: `chatlog://conversation/${(index + 1).toString(16).repeat(64)}/turn/${index}`,
          },
    snippet: `derived snippet ${index}`,
  }));
}

async function writeInsightArtifact(
  root: string,
  collection: string,
  manifestName: string,
  artifact: unknown,
  inputProjectionHash: string,
): Promise<string> {
  const artifactText = JSON.stringify(artifact);
  const contentHash = sha256(artifactText);
  const artifactPath = `${collection}/artifact.json`;
  await mkdir(join(root, "derived", collection), { recursive: true });
  await writeFile(join(root, "derived", artifactPath), artifactText);
  await writeFile(
    join(root, "derived", manifestName),
    JSON.stringify({
      version: 1,
      current: {
        inputProjectionHash,
        artifactPath,
        contentHash,
        processedAt: "2026-07-27T12:34:56Z",
      },
    }),
  );
  return contentHash;
}

function authorityConversation(contentHash = "8".repeat(64), index = 0): Conversation {
  return {
    id: `authority-${index}`,
    title: `Authority fixture ${index}`,
    provider: "openai",
    harness: "codex",
    domain: "coding",
    sourceKind: "session-log",
    project: "/authority",
    cwd: "/authority",
    model: "fixture-model",
    startedAt: "2026-07-27T12:00:00Z",
    endedAt: "2026-07-27T12:01:00Z",
    sourcePath: `/authority-source-${index}`,
    contentHash,
    turns: [{ role: "user", content: `Authority fixture ${index}` }],
  };
}

async function establishAuthority(
  root: string,
  conversations: Conversation[] = [authorityConversation()],
): Promise<DerivedProjectionReceipt> {
  const sources = Object.fromEntries(
    conversations.map((conversation) => [
      conversation.sourcePath,
      { contentHash: conversation.contentHash },
    ]),
  );
  await mkdir(join(root, "corpus"), { recursive: true });
  await Promise.all(
    conversations.map(async (conversation) => {
      const directory = join(root, "corpus", "objects", conversation.contentHash.slice(0, 2));
      await mkdir(directory, { recursive: true });
      await writeFile(
        join(directory, `${conversation.contentHash}.json`),
        JSON.stringify(conversation),
      );
    }),
  );
  await writeFile(join(root, "corpus", "manifest.json"), JSON.stringify({ version: 1, sources }));
  const db = openAnalysis(join(root, "analysis", "chatlog.sqlite"));
  conversations.forEach((conversation, index) => indexConversation(db, conversation, index + 1, 1));
  reconcileActiveSources(db, sources);
  db.close();
  await deriveCorpus(root);
  return assertDerivedProjection(root);
}

const knowledgeCandidateTypes = [
  "skill",
  "gotcha-skill",
  "memory-or-adr",
  "claude-md",
  "wiki-page-later",
] as const;

function knowledgeCandidateFixture(index: number): any {
  const type = knowledgeCandidateTypes[index % knowledgeCandidateTypes.length];
  return {
    id: `candidate-${String(index).padStart(3, "0")}`,
    type,
    signature: `${index % 7 === 0 ? "needle-" : ""}signature-${index}`,
    title: `${index % 11 === 0 ? "Needle " : ""}Review lead ${index}`,
    status: type === "wiki-page-later" ? "deferred-follow-up" : "curation-required",
    frequency: {
      occurrences: index + 20,
      distinctSnippets: index + 3,
      conversations: index + 2,
      sessions: index + 1,
      projects: (index % 4) + 1,
      harnesses: 2,
      threshold: 3,
    },
    evidence: evidencePointers(9),
    curation: {
      principle: `Review principle ${index}`,
      route: `Read-only curation route ${index}`,
      checks: Array.from({ length: 15 }, (_, check) => `Check ${check}`),
    },
    evaluation: {
      contract: "agent-eval/promotion-v1",
      status: "unmeasured",
      minimumRunsPerArm: 3,
      control: "Replay without the candidate.",
      treatment: "Replay with a separately curated candidate.",
      metrics: ["gatePassRate", "tokensToGate"],
      keepRule: "Keep only after a non-regressing measured result.",
      cutRule: "Cut on regression or no measured benefit.",
    },
  };
}

async function writeTopicCache(
  root: string,
  conversationHash: string,
  model: string,
  recipe: string,
  topics: string[],
): Promise<string> {
  const key = topicCacheKey(conversationHash, model, recipe);
  const directory = join(root, "analysis", "vault-topic-cache", key.slice(0, 2));
  const path = join(directory, `${key}.json`);
  await mkdir(directory, { recursive: true });
  await writeFile(
    path,
    `${JSON.stringify({
      topics,
      model,
      recipe,
      extractedAt: "2026-07-27T12:00:00Z",
      latencyMs: 1,
    })}\n`,
  );
  return path;
}

async function fileSnapshot(root: string): Promise<Record<string, string>> {
  const paths = [...new Bun.Glob("**/*").scanSync({ cwd: root, onlyFiles: true, dot: true })]
    .filter((path) => !path.endsWith("-shm"))
    .toSorted();
  return Object.fromEntries(
    await Promise.all(
      paths.map(async (path) => [path, await readFile(join(root, path), "utf8")] as const),
    ),
  );
}

async function slice2Fixture(): Promise<{
  root: string;
  current: Conversation;
  second: Conversation;
  superseded: Conversation;
}> {
  const root = await mkdtemp(join(tmpdir(), "chatlog-workbench-slice2-"));
  const base = {
    provider: "openai",
    harness: "codex",
    domain: "coding",
    sourceKind: "session-log",
    project: "/project",
    cwd: "/project",
  };
  const superseded: Conversation = {
    ...base,
    id: "superseded-session",
    title: "Old projection repair",
    model: "old-model",
    startedAt: "2026-06-30T10:00:00Z",
    endedAt: "2026-06-30T10:01:00Z",
    sourcePath: "/shared-source",
    contentHash: "1".repeat(64),
    turns: [
      { role: "user", content: "Projection repair failed in a superseded session." },
      { role: "assistant", content: "The old repair was fixed." },
    ],
  };
  const current: Conversation = {
    ...base,
    id: "current-one",
    title: "Current projection repair",
    model: "model-a",
    startedAt: "2026-07-01T10:00:00Z",
    endedAt: "2026-07-01T10:01:00Z",
    sourcePath: "/shared-source",
    contentHash: "2".repeat(64),
    turns: [
      {
        role: "user",
        content: "Projection repair failed because the Nix flake input is untracked.",
      },
      {
        role: "assistant",
        content: "For projection repair, we decided to track the file before rebuilding.",
        toolCalls: [{ name: "Bash", arguments: "git add fixture" }],
      },
      { role: "tool", content: "Tests passed with exit code 0." },
      { role: "assistant", content: "The projection repair is resolved and checks passed." },
    ],
  };
  const second: Conversation = {
    ...base,
    id: "current-two",
    title: "Projection drift follow-up",
    model: "model-b",
    startedAt: "2026-07-02T10:00:00Z",
    endedAt: "2026-07-02T10:01:00Z",
    sourcePath: "/second-source",
    contentHash: "3".repeat(64),
    turns: [
      { role: "user", content: "Projection repair failed with stale drifted state." },
      {
        role: "assistant",
        content: "For projection repair, we decided to rebuild the current index instead.",
        toolCalls: [{ name: "Edit", arguments: "fixture" }],
      },
      { role: "tool", content: "Build failed on the first attempt." },
      { role: "assistant", content: "The repair was fixed after retry; all checks passed." },
    ],
  };
  const toolOnly: Conversation[] = Array.from({ length: 40 }, (_, index) => {
    const endedAt = new Date(Date.UTC(2026, 5, 1, 0, index + 1)).toISOString();
    return {
      ...base,
      id: `tool-only-${index}`,
      title: `Tool-only fixture ${index}`,
      model: "tool-model",
      startedAt: new Date(Date.UTC(2026, 5, 1, 0, index)).toISOString(),
      endedAt,
      sourcePath: `/tool-only-${index}`,
      contentHash: (index + 16).toString(16).padStart(64, "0"),
      turns: [
        { role: "user", content: "Routine maintenance request." },
        {
          role: "assistant",
          content: "Inspecting the routine state.",
          toolCalls: [{ name: "Bash", arguments: "fixture" }],
        },
        { role: "tool", content: "Projection repair failed inside tool output only." },
        { role: "assistant", content: "Routine maintenance done." },
      ],
    };
  });
  const conversations = [superseded, current, second, ...toolOnly];
  const sources = Object.fromEntries([
    [current.sourcePath, { contentHash: current.contentHash }],
    [second.sourcePath, { contentHash: second.contentHash }],
    ...toolOnly.map((conversation) => [
      conversation.sourcePath,
      { contentHash: conversation.contentHash },
    ]),
  ]);
  const db = openAnalysis(join(root, "analysis", "chatlog.sqlite"));
  indexConversation(db, superseded, 1, 1);
  indexConversation(db, current, 2, 1);
  indexConversation(db, second, 1, 1);
  for (const conversation of toolOnly) indexConversation(db, conversation, 1, 1);
  reconcileActiveSources(db, sources);
  db.close();
  await Promise.all(
    conversations.map(async (conversation) => {
      const directory = join(root, "corpus", "objects", conversation.contentHash.slice(0, 2));
      await mkdir(directory, { recursive: true });
      await writeFile(
        join(directory, `${conversation.contentHash}.json`),
        JSON.stringify(conversation),
      );
    }),
  );
  await writeFile(join(root, "corpus", "manifest.json"), JSON.stringify({ version: 1, sources }));
  await deriveCorpus(root);
  return { root, current, second, superseded };
}

test("serves overview, local search, and canonical evidence from one corpus", async () => {
  const root = await mkdtemp(join(tmpdir(), "chatlog-workbench-"));
  const conversation: Conversation = {
    id: "session",
    title: "Nix source visibility",
    provider: "openai",
    harness: "codex",
    domain: "coding",
    sourceKind: "session-log",
    project: "/project",
    cwd: "/project",
    model: "model",
    startedAt: "2026-01-01T10:00:00Z",
    endedAt: "2026-01-01T10:01:00Z",
    sourcePath: "/source",
    contentHash: "a".repeat(64),
    turns: [
      { role: "user", content: "Why is the Nix flake source invisible?" },
      { role: "assistant", content: "Track the file before evaluating the flake." },
    ],
  };
  const staleHash = "b".repeat(64);
  const superseded = {
    ...conversation,
    contentHash: staleHash,
    turns: [{ role: "user", content: "An older version of this source." }],
  };
  const db = openAnalysis(join(root, "analysis", "chatlog.sqlite"));
  indexConversation(db, superseded, 0, 1);
  indexConversation(db, conversation, 1, 1);
  const { contentHash: _conversationHash, ...conversationProjection } = conversation;
  const eventBatch = syntheticEventBatch(conversationProjection);
  const sourceOrigin = eventBatch.events[0]!.origin;
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
      actor: { kind: "provider", name: conversation.harness },
      scope: eventBatch.events[0]!.scope,
      origin: {
        kind: "observed",
        source: makeObservedSource(
          {
            ...sourceBase,
            nativeItemId: `${conversation.id}:blocked:${sequence}`,
            recordPosition: { record: sequence },
          },
          { kind, secret: `blocked-${sequence}` },
        ),
      },
      relations: { parent },
      payload: {
        kind,
        secret: `blocked-${sequence}`,
        ...(kind === "provider.opaque" ? { nativeItemKind: "synthetic-opaque" } : {}),
      },
      capture: capture(disposition),
    });
  const reasoningEvent = appendBlockedEvent(
    "model.reasoning.observed",
    "normalized",
    eventBatch.events.length,
    eventBatch.events.at(-1)!.eventId,
  );
  const opaqueEvent = appendBlockedEvent(
    "provider.opaque",
    "opaque",
    eventBatch.events.length + 1,
    reasoningEvent.eventId,
  );
  const restrictedEventBatch = {
    ...eventBatch,
    events: [...eventBatch.events, reasoningEvent, opaqueEvent],
    sourceItemCount: eventBatch.sourceItemCount + 2,
  };
  const eventBatchHash = await persistEventBatch(root, restrictedEventBatch);
  const sourceReceipt = buildSourceReceipt({
    batch: restrictedEventBatch,
    batchHash: eventBatchHash,
    conversationProjectionHash: conversation.contentHash,
  });
  await persistSourceReceipt(root, sourceReceipt);
  await persistUnknownShapeNominations(root, [restrictedEventBatch], sourceReceipt.source.hash);
  indexEventBatch(db, restrictedEventBatch, eventBatchHash, conversation.contentHash);
  reconcileActiveSources(db, {
    "/source": { contentHash: conversation.contentHash, eventBatchHash },
  });
  db.close();
  await mkdir(join(root, "corpus"), { recursive: true });
  await writeFile(
    join(root, "corpus", "manifest.json"),
    JSON.stringify({
      version: 1,
      sources: {
        "/source": { contentHash: conversation.contentHash, eventBatchHash },
      },
    }),
  );
  await mkdir(join(root, "corpus", "objects", "aa"), { recursive: true });
  await writeFile(
    join(root, "corpus", "objects", "aa", `${conversation.contentHash}.json`),
    JSON.stringify(conversation),
  );
  await mkdir(join(root, "corpus", "objects", "bb"), { recursive: true });
  await writeFile(
    join(root, "corpus", "objects", "bb", `${staleHash}.json`),
    JSON.stringify(superseded),
  );
  await deriveCorpus(root);
  const receiptInput = {
    source: {
      path: "/private/anthropic.zip",
      contentHash: "c".repeat(64),
      bytes: 100,
      modifiedAt: "2026-01-01T10:00:00.000Z",
    },
    domain: "personal",
    counts: {
      discovered: 1,
      imported: 1,
      skipped: 0,
      turns: 2,
      attachments: 0,
      files: 0,
    },
    manifest: {
      beforeHash: "d".repeat(64),
      afterHash: "e".repeat(64),
      beforeSources: 0,
      afterSources: 1,
      added: 1,
      replaced: 0,
      unchanged: 0,
    },
    deriveEnabled: false,
    operationId: "workbench-test",
    completedAt: "2026-01-01T10:02:00.000Z",
  } as const;
  await writeImportReceipt(root, receiptInput);
  await writeImportReceipt(root, {
    ...receiptInput,
    operationId: "workbench-test-2",
    completedAt: "2026-01-01T10:03:00.000Z",
  });

  const data = new WorkbenchData(root);
  expect(await data.overview()).toMatchObject({
    ready: true,
    corpus: { sessions: 1, projects: 1, turns: 2 },
  });
  const result = data.search(new URL("http://localhost/api/search?q=nix+flake")) as any;
  expect(result.hits).toHaveLength(1);
  expect(result.hits[0]).toMatchObject({ title: "Nix source visibility", domain: "coding" });
  expect(await data.evidence(result.hits[0].evidenceUri)).toMatchObject({
    title: "Nix source visibility",
    turnIndex: 0,
    turn: { role: "user" },
  });
  const eventUri = eventEvidenceUri(eventBatchHash, eventBatch.events[0]!.eventId);
  const eventEvidence = await data.evidence(eventUri);
  expect(eventEvidence).toMatchObject({
    eventId: eventBatch.events[0]!.eventId,
    eventKind: "session.started",
  });
  if (!eventEvidence || typeof eventEvidence !== "object" || !("event" in eventEvidence))
    throw new Error("event evidence response is missing event data");
  const eventPayload = eventEvidence.event;
  if (!eventPayload || typeof eventPayload !== "object" || !("payload" in eventPayload))
    throw new Error("event evidence response is missing its payload");
  expect(eventPayload.payload).toContain('"sessionId":"session"');
  await expect(
    data.evidence(eventEvidenceUri(eventBatchHash, reasoningEvent.eventId)),
  ).rejects.toThrow("Evidence not found");
  await expect(
    data.evidence(eventEvidenceUri(eventBatchHash, opaqueEvent.eventId)),
  ).rejects.toThrow("Evidence not found");
  await expect(data.evidence(`chatlog://conversation/${staleHash}/turn/0`)).rejects.toThrow(
    "Evidence not found",
  );

  const handler = workbenchHandler(data);
  const healthResponse = await handler(new Request("http://localhost/api/health"));
  const sourceReceiptsResponse = await handler(
    new Request("http://localhost/api/source-receipts?limit=20"),
  );
  expect(sourceReceiptsResponse.status).toBe(200);
  const sourceReceiptsBody = await sourceReceiptsResponse.json();
  expect(sourceReceiptsBody).toMatchObject([
    { itemCounts: { sourceItems: expect.any(Number) }, lossCounts: expect.any(Object) },
  ]);
  expect(JSON.stringify(sourceReceiptsBody)).not.toContain("blocked-");
  const nominationsResponse = await handler(new Request("http://localhost/api/nominations"));
  expect(nominationsResponse.status).toBe(200);
  const nominationsBody = await nominationsResponse.json();
  expect(nominationsBody).toEqual(
    expect.arrayContaining([expect.objectContaining({ nativeItemKind: "synthetic-opaque" })]),
  );
  expect(JSON.stringify(nominationsBody)).not.toContain("blocked-");
  expect(healthResponse.status).toBe(200);
  expect(await healthResponse.json()).toEqual({ ready: true, activeSources: 1 });
  const overviewResponse = await handler(new Request("http://localhost/api/overview"));
  expect(overviewResponse.status).toBe(200);
  expect(await overviewResponse.json()).toMatchObject({ ready: true, corpus: { sessions: 1 } });
  const receiptsResponse = await handler(new Request("http://localhost/api/receipts?limit=1"));
  expect(receiptsResponse.status).toBe(200);
  expect(await receiptsResponse.json()).toMatchObject([
    {
      schema: "chatlog/import-receipt-v1",
      connector: "anthropic-export",
      policy: { domain: "personal" },
      counts: { imported: 1 },
    },
  ]);
  expect(await data.receipts(null)).toHaveLength(2);
  const readOnlyResponse = await handler(
    new Request("http://localhost/api/overview", { method: "POST" }),
  );
  expect(readOnlyResponse.status).toBe(405);
  expect(await readOnlyResponse.json()).toEqual({ error: "read-only workbench" });
  const staticResponse = await handler(new Request("http://localhost/"));
  expect(staticResponse.status).toBe(200);
  expect(staticResponse.headers.get("Content-Security-Policy")).toContain("frame-ancestors 'none'");
  const staticText = await staticResponse.text();
  expect(staticText).toContain("Chatlog Workbench");
  expect(staticText).toContain('id="receipt-list"');
  const missingEvidenceResponse = await handler(
    new Request(
      `http://localhost/api/evidence?uri=${encodeURIComponent(`chatlog://conversation/${staleHash}/turn/0`)}`,
    ),
  );
  expect(missingEvidenceResponse.status).toBe(404);
  expect(await missingEvidenceResponse.json()).toEqual({ error: "Evidence not found" });
  const missingKnowledgeArtifactResponse = await handler(
    new Request("http://localhost/api/knowledge-candidate?id=missing"),
  );
  expect(missingKnowledgeArtifactResponse.status).toBe(404);
  expect(await missingKnowledgeArtifactResponse.json()).toEqual({
    error: "knowledge candidate artifact not found",
  });
  await writeFile(
    join(root, "corpus", "manifest.json"),
    JSON.stringify({ version: 1, sources: {} }),
  );
  await expect(data.overview()).rejects.toThrow("active source projection");
  const driftResponse = await handler(new Request("http://localhost/api/overview"));
  expect(driftResponse.status).toBe(503);
  expect(await driftResponse.json()).toEqual({
    error: "active source projection is unavailable or stale; run `chatlog source reconcile`",
  });
  expect((await handler(new Request("http://localhost/api/health"))).status).toBe(503);
  expect((await handler(new Request("http://localhost/api/sources"))).status).toBe(200);
  data.close();
});

test("Prior Attempts is zero-egress, chronological, current-only, and excludes dense tool-only discovery", async () => {
  const { root, current, second, superseded } = await slice2Fixture();
  const data = new WorkbenchData(root);
  const originalFetch = globalThis.fetch;
  let networkCalls = 0;
  globalThis.fetch = (async () => {
    networkCalls++;
    return new Response("unexpected");
  }) as unknown as typeof fetch;
  try {
    const result = (await data.priorAttempts(
      new URL("http://localhost/api/prior-attempts?q=projection+repair&limit=8"),
    )) as any;
    expect(networkCalls).toBe(0);
    expect(result).toMatchObject({
      mode: "lexical",
      matchedSessions: 2,
      egress: { performed: false, surface: "none" },
    });
    expect(result.sessions.map((session: any) => session.sessionId)).toEqual([
      current.id,
      second.id,
    ]);
    expect(JSON.stringify(result)).not.toContain(superseded.id);
    expect(JSON.stringify(result)).not.toContain("tool-only-");
    expect(result.sessions.every((session: any) => session.matchedEvidence.length <= 2)).toBe(true);
    expect(result.sessions[0].attempts[0]).toMatchObject({
      outcome: "success",
      tools: ["Bash"],
      resultUri: `chatlog://conversation/${current.contentHash}/turn/2`,
    });
    expect(result.sessions[0].endedAt < result.sessions[1].endedAt).toBe(true);
    expect(result.bounds).toMatchObject({
      requestedSessionLimit: 8,
      candidateSessionLimit: 32,
      derivedArtifactReadLimit: 32,
      derivedArtifactsRead: 2,
    });
    expect(JSON.stringify(result).includes("Projection repair")).toBe(true);
    expect(
      Math.max(
        ...result.sessions.flatMap((session: any) =>
          [
            ...session.matchedEvidence,
            ...session.problems,
            ...session.attempts,
            ...session.decisions,
            ...session.resolutions,
          ].map((item: any) => item.snippet.length),
        ),
      ),
    ).toBeLessThanOrEqual(360);
    const matchedEvidence = (await data.evidence(result.sessions[0].matchedEvidence[0].uri)) as any;
    expect(matchedEvidence.sessionId).toBe(current.id);
    expect(["user", "assistant"]).toContain(matchedEvidence.turn.role);
    const response = await workbenchHandler(data)(
      new Request("http://localhost/api/prior-attempts?q=projection+repair&limit=8"),
    );
    expect(response.status).toBe(200);
    expect(((await response.json()) as any).sessions).toHaveLength(2);
    const omittedResponse = await workbenchHandler(data)(
      new Request("http://localhost/api/prior-attempts?q=projection+repair"),
    );
    expect(omittedResponse.status).toBe(200);
    expect(((await omittedResponse.json()) as any).bounds).toMatchObject({
      requestedSessionLimit: 6,
      candidateSessionLimit: 24,
      derivedArtifactReadLimit: 24,
    });
    const blankResponse = await workbenchHandler(data)(
      new Request("http://localhost/api/prior-attempts?q=projection+repair&limit="),
    );
    expect(blankResponse.status).toBe(200);
    expect(((await blankResponse.json()) as any).bounds.requestedSessionLimit).toBe(6);
    expect(networkCalls).toBe(0);
  } finally {
    globalThis.fetch = originalFetch;
    data.close();
  }
});

test("Project Intelligence uses exact current totals and a bounded recent derived sample", async () => {
  const { root, superseded } = await slice2Fixture();
  const data = new WorkbenchData(root);
  try {
    const result = (await data.projectIntelligence(
      new URL(
        "http://localhost/api/project-intelligence?project=%2Fproject&sampleLimit=24&sessionLimit=10",
      ),
    )) as any;
    expect(result.overview.sessions).toBe(42);
    expect(result.scope).toEqual({
      source: "current_conversations",
      totalCurrentSessions: 42,
      derivedSampleLimit: 24,
      sampledCurrentSessions: 24,
      derivedSessions: 24,
      derivedMissing: 0,
    });
    expect(result.sessions).toHaveLength(10);
    expect(JSON.stringify(result)).not.toContain(superseded.id);
    expect(JSON.stringify(result.models)).not.toContain("old-model");
    expect(result.tools).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ tool: "Bash", calls: 41 }),
        expect.objectContaining({ tool: "Edit", calls: 1 }),
      ]),
    );
    expect(result.recurringProblems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ category: "nix-dirty-or-untracked-input", sessions: 1 }),
        expect.objectContaining({ category: "stale-or-drifted-state", sessions: 1 }),
      ]),
    );
    expect(result.recentDecisions).toHaveLength(2);
    expect(Object.values(result.outcomes).reduce((sum: number, count: any) => sum + count, 0)).toBe(
      24,
    );
    expect(result.egress).toEqual({ performed: false, surface: "none" });

    const handler = workbenchHandler(data);
    const omittedResponse = await handler(
      new Request("http://localhost/api/project-intelligence?project=%2Fproject"),
    );
    expect(omittedResponse.status).toBe(200);
    const omitted = (await omittedResponse.json()) as any;
    expect(omitted.scope.derivedSampleLimit).toBe(24);
    expect(omitted.sessions).toHaveLength(40);
    expect(omitted.bounds).toMatchObject({
      requestedDerivedSampleLimit: 24,
      requestedSessionLimit: 40,
    });
    const blankResponse = await handler(
      new Request(
        "http://localhost/api/project-intelligence?project=%2Fproject&sampleLimit=&sessionLimit=",
      ),
    );
    expect(blankResponse.status).toBe(200);
    expect(((await blankResponse.json()) as any).bounds).toMatchObject({
      requestedDerivedSampleLimit: 24,
      requestedSessionLimit: 40,
    });
    const response = await handler(
      new Request("http://localhost/api/project-intelligence?project=%2Fmissing"),
    );
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "project not found: /missing" });
  } finally {
    data.close();
  }
});

test("insights report matched projection provenance and expose only bounded evidence pointers", async () => {
  const root = await mkdtemp(join(tmpdir(), "chatlog-workbench-insights-fresh-"));
  const authority = await establishAuthority(root);
  const projectionHash = authority.contentHash;
  const evidence = [...evidencePointers(5), { pointer: "not-a-pointer", snippet: "invalid" }];
  await writeInsightArtifact(
    root,
    "orchestration-lean",
    "orchestration-lean-manifest.json",
    {
      inputProjectionHash: projectionHash,
      finding: {
        claim: "Bounded autonomy",
        evidence,
        decisionBoundary: {
          grantsAutonomy: { claim: "Inside a lane", evidence },
          imposesGuardrail: { claim: "At authority boundaries", evidence },
        },
      },
      inventories: [],
    },
    projectionHash,
  );
  const roleContentHash = await writeInsightArtifact(
    root,
    "orchestration-roles",
    "orchestration-roles-manifest.json",
    {
      inputProjectionHash: projectionHash,
      inferredCounts: { worker: 4 },
      profiles: [
        {
          role: "worker",
          highConfidenceSessions: 4,
          classifiedChoices: 3,
          autonomyChoiceRate: 1 / 3,
          claim: "Workers stay bounded",
          signalCounts: [],
          evidence,
        },
      ],
    },
    projectionHash,
  );
  await writeInsightArtifact(
    root,
    "orchestration-effectiveness",
    "orchestration-effectiveness-manifest.json",
    {
      roleProfileContentHash: roleContentHash,
      ranking: {
        claim: "Control remains better",
        winner: "control",
        loser: "treatment",
        role: "worker",
        metrics: { recommendation: "revise-or-cut" },
        evidence,
      },
    },
    "composite-effectiveness-input",
  );
  await writeInsightArtifact(
    root,
    "refinery",
    "refinery-manifest.json",
    {
      inputProjectionHash: authority.structureProjectionHash,
      threshold: 3,
      policy: { autoPromotion: false },
      candidates: [
        {
          id: "candidate",
          type: "skill",
          signature: "bounded-pattern",
          title: "Bounded pattern",
          status: "curation-required",
          frequency: { sessions: 4, projects: 2 },
          evidence,
        },
      ],
    },
    authority.structureProjectionHash,
  );

  const data = new WorkbenchData(root);
  const insights = (await data.insights()) as any;
  expect(insights.projection).toEqual({
    path: "derived/current-hashes.jsonl",
    contentHash: projectionHash,
  });
  expect(insights.orchestration.provenance).toMatchObject({
    fresh: true,
    status: "fresh",
    reason: "projection-match",
  });
  expect(insights.roles.provenance.fresh).toBe(true);
  expect(insights.effectiveness.provenance).toMatchObject({
    fresh: true,
    reason: "role-profile-match",
    roleProfileContentHash: roleContentHash,
  });
  expect(insights.refinery.provenance.fresh).toBe(true);
  expect(insights.orchestration.evidence).toHaveLength(3);
  expect(insights.orchestration.decisionBoundary.grantsAutonomy.evidence).toHaveLength(3);
  expect(insights.roles.profiles[0].evidence).toHaveLength(3);
  expect(insights.effectiveness.evidence).toHaveLength(3);
  expect(insights.refinery.candidates[0].evidence).toHaveLength(2);
  expect(insights.orchestration.evidence[0]).toEqual({ uri: evidence[0].pointer });
  expect(JSON.stringify(insights)).not.toContain("derived snippet");
  data.close();
});

test("Knowledge Gaps review pages and searches every candidate without promoting it", async () => {
  const root = await mkdtemp(join(tmpdir(), "chatlog-workbench-knowledge-"));
  const authority = await establishAuthority(root);
  const projectionHash = authority.structureProjectionHash;
  const candidates = Array.from({ length: 57 }, (_, index) => knowledgeCandidateFixture(index));
  const refineryContentHash = await writeInsightArtifact(
    root,
    "refinery",
    "refinery-manifest.json",
    {
      schemaVersion: 1,
      inputProjectionHash: projectionHash,
      recipeHash: "recipe",
      threshold: 3,
      policy: {
        autoPromotion: false,
        frequencyIsSignalNotDecision: true,
        referenceWikiDeferred: true,
      },
      candidates,
    },
    projectionHash,
  );
  const artifactPath = join(root, "derived", "refinery", "artifact.json");
  const before = await readFile(artifactPath, "utf8");
  const data = new WorkbenchData(root);
  const handler = workbenchHandler(data);
  try {
    const secondPageResponse = await handler(
      new Request("http://localhost/api/knowledge-candidates?page=2&pageSize=10&type=all"),
    );
    expect(secondPageResponse.status).toBe(200);
    const secondPage = (await secondPageResponse.json()) as any;
    expect(secondPage.provenance).toMatchObject({
      fresh: true,
      status: "fresh",
      reason: "projection-match",
    });
    expect(secondPage.pagination).toEqual({
      page: 2,
      pageSize: 10,
      total: 57,
      totalPages: 6,
    });
    expect(secondPage.items).toHaveLength(10);
    expect(secondPage.precisionGate).toMatchObject({
      status: "unavailable",
      classification: "possible-only",
      minimumOperatorJudgedPrecisionPercent: 70,
      recordedOperatorJudgedPrecisionPercent: null,
    });
    expect(secondPage.reviewNotice).toContain("not accepted");
    expect(secondPage.reviewNotice).toContain("not promoted");

    const boundedResponse = await handler(
      new Request("http://localhost/api/knowledge-candidates?pageSize=999&page=999999"),
    );
    const bounded = (await boundedResponse.json()) as any;
    expect(bounded.pagination.page).toBe(10_000);
    expect(bounded.pagination.pageSize).toBe(50);
    expect(bounded.bounds).toMatchObject({
      queryCharacters: 160,
      maximumPage: 10_000,
      maximumPageSize: 50,
    });

    const typeResponse = await handler(
      new Request("http://localhost/api/knowledge-candidates?type=claude-md&pageSize=50"),
    );
    const typed = (await typeResponse.json()) as any;
    expect(typed.pagination.total).toBe(11);
    expect(typed.items.every((candidate: any) => candidate.type === "claude-md")).toBe(true);

    const searchResponse = await handler(
      new Request("http://localhost/api/knowledge-candidates?q=candidate-042&pageSize=50"),
    );
    const searched = (await searchResponse.json()) as any;
    expect(searched.items.map((candidate: any) => candidate.id)).toEqual(["candidate-042"]);
    const needleResponse = await handler(
      new Request("http://localhost/api/knowledge-candidates?q=needle&pageSize=50"),
    );
    expect(((await needleResponse.json()) as any).pagination.total).toBeGreaterThan(1);
    const longQueryResponse = await handler(
      new Request(`http://localhost/api/knowledge-candidates?q=${"x".repeat(300)}`),
    );
    expect(((await longQueryResponse.json()) as any).filters.q).toHaveLength(160);
    const unsupportedResponse = await handler(
      new Request("http://localhost/api/knowledge-candidates?type=confirmed-gap"),
    );
    expect(unsupportedResponse.status).toBe(400);
    const userControlledNotFoundResponse = await handler(
      new Request("http://localhost/api/knowledge-candidates?type=not%20found"),
    );
    expect(userControlledNotFoundResponse.status).toBe(400);
    expect(await userControlledNotFoundResponse.json()).toEqual({
      error: "unsupported knowledge candidate type: not found",
    });
    const missingCandidateResponse = await handler(
      new Request("http://localhost/api/knowledge-candidate?id=missing"),
    );
    expect(missingCandidateResponse.status).toBe(404);
    expect(await missingCandidateResponse.json()).toEqual({
      error: "knowledge candidate not found: missing",
    });

    const detailResponse = await handler(
      new Request("http://localhost/api/knowledge-candidate?id=candidate-042"),
    );
    expect(detailResponse.status).toBe(200);
    const detail = (await detailResponse.json()) as any;
    expect(detail.provenance.fresh).toBe(true);
    expect(detail.policy).toEqual({ autoPromotion: false, mutationAvailable: false });
    expect(detail.artifact).toEqual({
      contentHash: refineryContentHash,
      inputProjectionHash: projectionHash,
      recipeHash: "recipe",
      processedAt: "2026-07-27T12:34:56Z",
    });
    expect(detail.candidate).toMatchObject({
      id: "candidate-042",
      status: "curation-required",
      curation: {
        principle: "Review principle 42",
        route: "Read-only curation route 42",
      },
      evaluation: {
        contract: "agent-eval/promotion-v1",
        status: "unmeasured",
        minimumRunsPerArm: 3,
      },
    });
    expect(detail.candidate.curation.checks).toHaveLength(12);
    expect(detail.candidate.evidence).toHaveLength(6);
    expect(detail.candidate.evidence[0]).toEqual({ uri: candidates[42].evidence[0].pointer });
    expect(JSON.stringify(detail)).not.toContain("derived snippet");
    expect(JSON.stringify(detail).toLowerCase()).not.toContain("confirmed documentation gap");
    expect(JSON.stringify(detail).toLowerCase()).not.toContain("is undocumented");

    const defaultInsights = (await data.insights()) as any;
    expect(defaultInsights.refinery.candidates).toHaveLength(57);
    const boundedInsights = (await data.insights(
      new URL("http://localhost/api/insights?candidateLimit=0"),
    )) as any;
    expect(boundedInsights.refinery).toMatchObject({ candidateCount: 57, candidates: [] });

    const mutationResponse = await handler(
      new Request("http://localhost/api/knowledge-candidate?id=candidate-042", {
        method: "POST",
      }),
    );
    expect(mutationResponse.status).toBe(405);
    expect(await mutationResponse.json()).toEqual({ error: "read-only workbench" });
    expect(await readFile(artifactPath, "utf8")).toBe(before);

    const pageSource = await handler(new Request("http://localhost/"));
    const pageText = await pageSource.text();
    expect(pageText).toContain("Knowledge gaps review");
    expect(pageText).toContain("not accepted, not promoted");
    const appSource = await handler(new Request("http://localhost/app.js"));
    const appText = await appSource.text();
    expect(appText).toContain("/api/knowledge-candidates");
    expect(appText.toLowerCase()).not.toContain("is undocumented");
    for (const renderedContract of [
      "frequency.occurrences",
      "frequency.distinctSnippets",
      "frequency.conversations",
      "frequency.sessions",
      "frequency.projects",
      "frequency.harnesses",
      "frequency.threshold",
      "artifact.contentHash",
      "artifact.inputProjectionHash",
      "artifact.recipeHash",
      "formatDate(artifact.processedAt)",
      "Artifact provenance · opaque metadata",
      "Number.isNaN(date.getTime())",
    ])
      expect(appText).toContain(renderedContract);
  } finally {
    data.close();
  }
});

test("Knowledge Gaps review fails closed when refinery authority is stale", async () => {
  const root = await mkdtemp(join(tmpdir(), "chatlog-workbench-knowledge-stale-"));
  await establishAuthority(root);
  const staleHash = "d".repeat(64);
  await writeInsightArtifact(
    root,
    "refinery",
    "refinery-manifest.json",
    {
      schemaVersion: 1,
      inputProjectionHash: staleHash,
      recipeHash: "old-recipe",
      threshold: 3,
      policy: { autoPromotion: false },
      candidates: [knowledgeCandidateFixture(0)],
    },
    staleHash,
  );
  const data = new WorkbenchData(root);
  const handler = workbenchHandler(data);
  try {
    for (const path of ["/api/knowledge-candidates", "/api/knowledge-candidate?id=candidate-000"]) {
      const response = await handler(new Request(`http://localhost${path}`));
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({
        error:
          "refinery-manifest.json: current artifact does not match the active derived projection",
      });
    }
  } finally {
    data.close();
  }
});

test("experimental Themes explorer reports exact current completed-cache coverage without side effects", async () => {
  const root = await mkdtemp(join(tmpdir(), "chatlog-workbench-themes-"));
  const currentHashes = ["a".repeat(64), "b".repeat(64), "c".repeat(64)];
  const staleHash = "9".repeat(64);
  await establishAuthority(
    root,
    currentHashes.map((contentHash, index) => authorityConversation(contentHash, index)),
  );
  await writeTopicCache(root, currentHashes[0]!, "model-a", VAULT_TOPIC_RECIPE, [
    "nix-flakes",
    "restic-backups",
  ]);
  await writeTopicCache(root, currentHashes[1]!, "model-a", VAULT_TOPIC_RECIPE, [
    "nix-flake",
    "career-planning",
  ]);
  await writeTopicCache(root, staleHash, "model-b", "older-topic-recipe", [
    "stale-topic-must-not-count",
  ]);
  const malformedKey = "f".repeat(64);
  const malformedDirectory = join(root, "analysis", "vault-topic-cache", malformedKey.slice(0, 2));
  await mkdir(malformedDirectory, { recursive: true });
  await writeFile(join(malformedDirectory, `${malformedKey}.json`), "{malformed");
  const before = await fileSnapshot(root);
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = (async () => {
    fetchCalls++;
    return new Response("unexpected");
  }) as unknown as typeof fetch;
  const data = new WorkbenchData(root);
  const handler = workbenchHandler(data);
  try {
    const response = await handler(new Request("http://localhost/api/themes?limit=20"));
    expect(response.status).toBe(200);
    const result = (await response.json()) as any;
    expect(result).toMatchObject({
      label: "Experimental · partial cached sample",
      scope: "current-projection cached sample only",
      coverage: {
        exact: true,
        reason: "current-projection",
        currentDenominator: 3,
        currentCovered: 2,
        percent: 66.7,
        currentCompletedCacheEntries: 2,
        keyComputations: 6,
        wholeCorpusClaimed: false,
      },
      cache: {
        scannedFiles: 4,
        totalCompletedEntries: 3,
        staleOtherEntries: 1,
        invalidEntries: 1,
      },
      distribution: {
        totalClusters: 3,
        sharedClusters: 1,
        singletonLongTailClusters: 2,
      },
      attestations: {
        egressPerformed: false,
        extractionPerformed: false,
        cacheWritesPerformed: false,
      },
      clustering: {
        exact: true,
        uniqueNormalizedTopics: 4,
        pairwiseComparisons: 6,
      },
    });
    expect(result.clusterRecipe).toBe("vault-topic-token-set-jaccard-current-conversation-v1");
    expect(result.clusters[0]).toMatchObject({
      topic: "nix-flake",
      conversations: 2,
    });
    expect(result.clusters.map((cluster: any) => cluster.topic)).toEqual(
      expect.arrayContaining(["restic-backups", "career-planning"]),
    );
    expect(JSON.stringify(result)).not.toContain("stale-topic-must-not-count");
    expect(result.variants).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          model: "model-a",
          recipe: VAULT_TOPIC_RECIPE,
          completedCacheEntries: 2,
          currentCacheEntries: 2,
          currentCovered: 2,
          coveragePercent: 66.7,
        }),
        expect.objectContaining({
          model: "model-b",
          recipe: "older-topic-recipe",
          completedCacheEntries: 1,
          currentCacheEntries: 0,
          currentCovered: 0,
        }),
      ]),
    );
    expect(fetchCalls).toBe(0);
    expect(await fileSnapshot(root)).toEqual(before);

    const topicBoundResponse = await handler(
      new Request("http://localhost/api/themes?topicLimit=2"),
    );
    const topicBound = (await topicBoundResponse.json()) as any;
    expect(topicBound.coverage).toMatchObject({
      exact: false,
      reason: "topic-clustering-bound-exceeded",
      currentKeyCoverageExact: true,
      currentDenominator: 3,
      currentCovered: 2,
      wholeCorpusClaimed: false,
    });
    expect(topicBound.clustering).toEqual({
      exact: false,
      reason: "topic-clustering-bound-exceeded",
      uniqueNormalizedTopics: 4,
      appliedUniqueTopicLimit: 2,
      pairwiseComparisons: 6,
      maximumPairwiseComparisons: 500_000,
    });
    expect(topicBound.bounds).toMatchObject({
      requestedTopicLimit: "2",
      appliedTopicLimit: 2,
      maximumUniqueTopics: 1_000,
      maximumPairwiseComparisons: 500_000,
    });
    expect(topicBound.clusters).toEqual([]);
    expect(topicBound.distribution).toBeNull();
    expect(fetchCalls).toBe(0);
    expect(await fileSnapshot(root)).toEqual(before);

    const boundedResponse = await handler(new Request("http://localhost/api/themes?scanLimit=2"));
    const bounded = (await boundedResponse.json()) as any;
    expect(bounded.coverage).toMatchObject({
      exact: false,
      reason: "cache-scan-bound-exceeded",
      wholeCorpusClaimed: false,
    });
    expect(bounded.cache.totalCompletedEntries).toBeNull();
    expect(bounded.clusters).toEqual([]);
    expect(bounded.bounds).toMatchObject({
      requestedScanLimit: "2",
      appliedScanLimit: 2,
      maximumScanLimit: 10_000,
    });
    expect(fetchCalls).toBe(0);
    expect(await fileSnapshot(root)).toEqual(before);

    const postResponse = await handler(
      new Request("http://localhost/api/themes", { method: "POST" }),
    );
    expect(postResponse.status).toBe(405);
    expect(await postResponse.json()).toEqual({ error: "read-only workbench" });

    const appResponse = await handler(new Request("http://localhost/app.js"));
    expect(appResponse.headers.get("Cache-Control")).toBe("no-cache");
    const appSource = await appResponse.text();
    expect(appSource).toContain('api("/api/themes?limit=20")');
    const bootstrap = appSource.slice(
      appSource.indexOf("async function load()"),
      appSource.indexOf('$$(".nav-item")'),
    );
    expect(bootstrap).not.toContain("/api/themes");
    expect(appSource).not.toContain("exact cached sample");
    expect(appSource).toContain(
      "Clusters are withheld because coverage or clustering is not exact.",
    );
    const pageResponse = await handler(new Request("http://localhost/"));
    const pageSource = await pageResponse.text();
    expect(pageSource).toContain("Experimental · partial cached sample");
    for (const banned of ["knowledge graph", "personal↔technical bridge"])
      expect(`${appSource}\n${pageSource}`.toLowerCase()).not.toContain(banned);
  } finally {
    globalThis.fetch = originalFetch;
    data.close();
  }
});

test("experimental Themes explorer fails closed without a valid current projection", async () => {
  const missingRoot = await mkdtemp(join(tmpdir(), "chatlog-workbench-themes-missing-"));
  const missingData = new WorkbenchData(missingRoot);
  try {
    const missing = (await missingData.themes(new URL("http://localhost/api/themes"))) as any;
    expect(missing.coverage).toMatchObject({
      exact: false,
      reason: "projection-missing",
      currentDenominator: null,
      wholeCorpusClaimed: false,
    });
    expect(missing.clusters).toEqual([]);
  } finally {
    missingData.close();
  }

  const malformedRoot = await mkdtemp(join(tmpdir(), "chatlog-workbench-themes-invalid-"));
  await mkdir(join(malformedRoot, "derived"), { recursive: true });
  await writeFile(
    join(malformedRoot, "derived", "current-hashes.jsonl"),
    `${JSON.stringify({ conversationHash: "a".repeat(64) })}\n{"wrong":"shape"}\n`,
  );
  const malformedData = new WorkbenchData(malformedRoot);
  try {
    const malformed = (await malformedData.themes(new URL("http://localhost/api/themes"))) as any;
    expect(malformed.coverage).toMatchObject({
      exact: false,
      reason: "projection-invalid",
      currentDenominator: null,
      wholeCorpusClaimed: false,
    });
    expect(malformed.clusters).toEqual([]);
  } finally {
    malformedData.close();
  }
});

test("insights fail closed when authoritative artifacts are stale", async () => {
  const root = await mkdtemp(join(tmpdir(), "chatlog-workbench-insights-stale-"));
  await establishAuthority(root);
  const staleHash = "d".repeat(64);
  await writeInsightArtifact(
    root,
    "orchestration-lean",
    "orchestration-lean-manifest.json",
    { inputProjectionHash: staleHash, finding: { claim: "Old claim", evidence: [] } },
    staleHash,
  );
  const roleContentHash = await writeInsightArtifact(
    root,
    "orchestration-roles",
    "orchestration-roles-manifest.json",
    { inputProjectionHash: staleHash, inferredCounts: {}, profiles: [] },
    staleHash,
  );
  await writeInsightArtifact(
    root,
    "orchestration-effectiveness",
    "orchestration-effectiveness-manifest.json",
    {
      roleProfileContentHash: roleContentHash,
      ranking: { claim: "Old result", metrics: {}, evidence: [] },
    },
    "composite-effectiveness-input",
  );
  await writeInsightArtifact(
    root,
    "refinery",
    "refinery-manifest.json",
    { inputProjectionHash: staleHash, threshold: 3, policy: {}, candidates: [] },
    staleHash,
  );

  const data = new WorkbenchData(root);
  try {
    const response = await workbenchHandler(data)(new Request("http://localhost/api/insights"));
    expect(response.status).toBe(503);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain("current artifact does not match the active derived projection");
    expect(JSON.stringify(body)).not.toContain("Old claim");
    expect(JSON.stringify(body)).not.toContain("Old result");
  } finally {
    data.close();
  }
});

test("Workbench bind policy keeps remote authority separate from Memory Lab writes", () => {
  expect(resolveBindConfig({})).toEqual({
    host: "127.0.0.1",
    port: 4789,
    memoryLabWrites: true,
  });
  expect(resolveBindConfig({ CHATLOG_HOST: "::1", CHATLOG_PORT: "4790" })).toEqual({
    host: "::1",
    port: 4790,
    memoryLabWrites: true,
  });
  expect(() => resolveBindConfig({ CHATLOG_HOST: "100.64.0.7" })).toThrow(
    "Refusing non-loopback bind",
  );
  expect(
    resolveBindConfig({
      CHATLOG_HOST: "100.64.0.7",
      CHATLOG_ALLOW_REMOTE: "1",
    }),
  ).toEqual({ host: "100.64.0.7", port: 4789, memoryLabWrites: false });
  expect(
    resolveBindConfig({
      CHATLOG_HOST: "100.64.0.7",
      CHATLOG_ALLOW_REMOTE: "1",
      CHATLOG_MEMORY_LAB_WRITES: "1",
    }),
  ).toEqual({ host: "100.64.0.7", port: 4789, memoryLabWrites: true });
  expect(() =>
    resolveBindConfig({
      CHATLOG_HOST: "100.64.0.7",
      CHATLOG_MEMORY_LAB_WRITES: "1",
    }),
  ).toThrow("Refusing non-loopback bind");
});
