import { expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { indexConversation, openAnalysis } from "../src/analysis";
import {
  boundedOutcomeComparison,
  boundedWorkflowPattern,
  WorkbenchData,
} from "../src/workbench/data";
import {
  resolveAnnotationConfig,
  resolveBindConfig,
  workbenchHandler,
} from "../src/workbench/server";
import { writeImportReceipt } from "../src/import-receipts";
import { reconcileActiveSources } from "../src/source-authority";
import type { Conversation } from "../src/types";
import { deriveCorpus } from "../src/derive";
import { deriveWorkflowEvolution } from "../src/workflow-evolution";
import { deriveWorkflowOutcomes } from "../src/workflow-outcomes";
import { deriveWorkflowPatterns } from "../src/workflow-patterns";
import { PatternAnnotationConflictError } from "../src/pattern-annotations";

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
  reconcileActiveSources(db, {
    "/source": { contentHash: conversation.contentHash },
  });
  db.close();
  await mkdir(join(root, "corpus"), { recursive: true });
  await writeFile(join(root, "corpus", "manifest.json"), JSON.stringify({
    version: 1,
    sources: {
      "/source": { contentHash: conversation.contentHash },
    },
  }));
  await mkdir(join(root, "corpus", "objects", "aa"), { recursive: true });
  await writeFile(join(root, "corpus", "objects", "aa", `${conversation.contentHash}.json`), JSON.stringify(conversation));
  await mkdir(join(root, "corpus", "objects", "bb"), { recursive: true });
  await writeFile(
    join(root, "corpus", "objects", "bb", `${staleHash}.json`),
    JSON.stringify(superseded),
  );
  await deriveCorpus(root);
  await deriveWorkflowEvolution(root);
  await deriveWorkflowOutcomes(root);
  await deriveWorkflowPatterns(root);
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
  expect(await data.overview()).toMatchObject({ ready: true, corpus: { sessions: 1, projects: 1, turns: 2 } });
  const result = data.search(new URL("http://localhost/api/search?q=nix+flake")) as any;
  expect(result.hits).toHaveLength(1);
  expect(result.hits[0]).toMatchObject({ title: "Nix source visibility", domain: "coding" });
  expect(await data.evidence(result.hits[0].evidenceUri)).toMatchObject({
    title: "Nix source visibility",
    turnIndex: 0,
    turn: { role: "user" },
  });
  await expect(data.evidence(`chatlog://conversation/${staleHash}/turn/0`))
    .rejects.toThrow("Evidence not found");

  const handler = workbenchHandler(data);
  const healthResponse = await handler(new Request("http://localhost/api/health"));
  expect(healthResponse.status).toBe(200);
  expect(await healthResponse.json()).toEqual({ ready: true, activeSources: 1 });
  const overviewResponse = await handler(new Request("http://localhost/api/overview"));
  expect(overviewResponse.status).toBe(200);
  expect(await overviewResponse.json()).toMatchObject({ ready: true, corpus: { sessions: 1 } });
  expect(await data.insights()).toMatchObject({
    workflowPatterns: {
      summary: { repeatedPatterns: 0, candidateSignatures: 0 },
      annotations: {
        enabled: false,
        snapshot: expect.stringMatching(/^[a-f0-9]{24}$/),
        summary: {
          activeAnnotated: 0,
          inactivePatternAnnotations: 0,
        },
      },
      methodology: {
        boundaryEffect: expect.stringContaining("silence never implies reversal"),
      },
      patterns: [],
    },
    workflowOutcomes: {
      summary: { events: 0, observed: 0, insufficientCoverage: 0 },
      comparisons: [],
    },
    workflowEvolution: {
      summary: { conversationsScanned: 1, uniqueEvents: 0 },
      events: [],
    },
  });
  const insightsResponse = await handler(new Request("http://localhost/api/insights"));
  expect(insightsResponse.status).toBe(200);
  expect(await insightsResponse.json()).toMatchObject({
    workflowEvolution: { summary: { uniqueEvents: 0 } },
  });
  const receiptsResponse = await handler(new Request("http://localhost/api/receipts?limit=1"));
  expect(receiptsResponse.status).toBe(200);
  expect(await receiptsResponse.json()).toMatchObject([{
    schema: "chatlog/import-receipt-v1",
    connector: "anthropic-export",
    policy: { domain: "personal" },
    counts: { imported: 1 },
  }]);
  expect(await data.receipts(null)).toHaveLength(2);
  const readOnlyResponse = await handler(new Request("http://localhost/api/overview", { method: "POST" }));
  expect(readOnlyResponse.status).toBe(405);
  expect(await readOnlyResponse.json()).toEqual({ error: "read-only workbench" });
  const staticResponse = await handler(new Request("http://localhost/"));
  expect(staticResponse.status).toBe(200);
  expect(staticResponse.headers.get("Content-Security-Policy")).toContain("frame-ancestors 'none'");
  const staticHtml = await staticResponse.text();
  expect(staticHtml).toContain("Chatlog Workbench");
  expect(staticHtml).toContain("pattern-explorer-toolbar");
  expect(staticHtml).toContain("pattern-annotation-form");

  await writeFile(join(root, "corpus", "manifest.json"), JSON.stringify({
    version: 1,
    sources: {},
  }));
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

test("Workbench bind policy defaults to loopback and requires an explicit remote override", () => {
  expect(resolveBindConfig({})).toEqual({ host: "127.0.0.1", port: 4789 });
  expect(resolveBindConfig({ CHATLOG_HOST: "::1", CHATLOG_PORT: "4790" }))
    .toEqual({ host: "::1", port: 4790 });
  expect(() => resolveBindConfig({ CHATLOG_HOST: "100.64.0.7" }))
    .toThrow("Refusing non-loopback bind");
  expect(resolveBindConfig({
    CHATLOG_HOST: "100.64.0.7",
    CHATLOG_ALLOW_REMOTE: "1",
  })).toEqual({ host: "100.64.0.7", port: 4789 });
  expect(resolveAnnotationConfig(
    { host: "127.0.0.1", port: 4789 },
    {},
  )).toEqual({
    enabled: false,
    allowedOrigins: new Set([
      "http://127.0.0.1:4789",
      "http://localhost:4789",
      "http://[::1]:4789",
    ]),
  });
  expect(resolveAnnotationConfig(
    { host: "127.0.0.1", port: 4789 },
    {
      CHATLOG_ALLOW_ANNOTATIONS: "1",
      CHATLOG_ANNOTATION_ORIGINS: "https://chatlog.example.net",
    },
  )).toMatchObject({
    enabled: true,
    allowedOrigins: expect.any(Set),
  });
  expect(resolveAnnotationConfig(
    { host: "127.0.0.1", port: 80 },
    {
      CHATLOG_ALLOW_ANNOTATIONS: "1",
      CHATLOG_ANNOTATION_ORIGINS:
        "https://Chatlog.Example.net:443",
    },
  ).allowedOrigins).toEqual(new Set([
    "http://127.0.0.1",
    "http://localhost",
    "http://[::1]",
    "https://chatlog.example.net",
  ]));
  expect(() => resolveAnnotationConfig(
    { host: "127.0.0.1", port: 4789 },
    {
      CHATLOG_ALLOW_ANNOTATIONS: "1",
      CHATLOG_ANNOTATION_ORIGINS:
        "https://chatlog.example.net/path",
    },
  )).toThrow("bare HTTP(S) origin");
  expect(() => resolveAnnotationConfig(
    { host: "100.64.0.7", port: 4789 },
    { CHATLOG_ALLOW_ANNOTATIONS: "1" },
  )).toThrow("Refusing annotations on a non-loopback bind");
  expect(resolveAnnotationConfig(
    { host: "100.64.0.7", port: 4789 },
    {
      CHATLOG_ALLOW_ANNOTATIONS: "1",
      CHATLOG_ACK_REMOTE_ANNOTATIONS: "1",
    },
  ).enabled).toBe(true);
});

test("annotation HTTP mutation is opt-in, same-origin, bounded, and conflict aware", async () => {
  const origin = "https://chatlog.example.net";
  const input = {
    handle: "a".repeat(24),
    expectedRevision: 0,
    observedSnapshot: "b".repeat(24),
    disposition: "confirmed",
    label: null,
    note: null,
  };
  const fakeData = {
    annotatePattern: async (value: any) => ({
      disposition: value.disposition,
      label: value.label,
      note: value.note,
      revision: 1,
      updatedAt: "2026-07-24T10:00:00.000Z",
    }),
  } as WorkbenchData;
  const request = (
    body: unknown = input,
    headers: Record<string, string> = {},
  ) => new Request(`${origin}/api/pattern-annotations`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: origin,
      "Sec-Fetch-Site": "same-origin",
      ...headers,
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  const disabled = workbenchHandler(fakeData);
  expect((await disabled(request())).status).toBe(405);

  const enabled = workbenchHandler(fakeData, undefined, {
    enabled: true,
    allowedOrigins: new Set([origin]),
  });
  const success = await enabled(request());
  expect(success.status).toBe(200);
  expect(await success.json()).toMatchObject({
    annotation: { disposition: "confirmed", revision: 1 },
  });
  expect((await enabled(request(input, { Origin: "https://evil.example" }))).status)
    .toBe(403);
  expect((await enabled(request(input, {
    Origin: "https://evil.example",
    "X-Forwarded-Host": "chatlog.example.net",
    "X-Forwarded-Proto": "https",
  }))).status).toBe(403);
  expect((await enabled(request(input, { "Sec-Fetch-Site": "cross-site" }))).status)
    .toBe(403);
  expect((await enabled(request(input, { "Sec-Fetch-Site": "" }))).status)
    .toBe(403);
  expect((await enabled(request(input, { "Content-Type": "text/plain" }))).status)
    .toBe(415);
  expect((await enabled(request("x".repeat(8 * 1024 + 1)))).status)
    .toBe(413);
  expect((await enabled(new Request(`${origin}/api/pattern-annotations`, {
    method: "PUT",
  }))).status).toBe(405);

  const limited = workbenchHandler(fakeData, undefined, {
    enabled: true,
    allowedOrigins: new Set([origin]),
    maximumWritesPerMinute: 1,
  });
  expect((await limited(request())).status).toBe(200);
  expect((await limited(request())).status).toBe(429);

  let failedAttempts = 0;
  const failingData = {
    annotatePattern: async () => {
      failedAttempts++;
      throw new Error("invalid annotation");
    },
  } as WorkbenchData;
  const failedAttemptLimit = workbenchHandler(failingData, undefined, {
    enabled: true,
    allowedOrigins: new Set([origin]),
    maximumWritesPerMinute: 1,
  });
  expect((await failedAttemptLimit(request())).status).toBe(400);
  expect((await failedAttemptLimit(request())).status).toBe(429);
  expect(failedAttempts).toBe(1);

  let releaseWrite: (() => void) | undefined;
  const heldWrite = new Promise<void>((resolve) => {
    releaseWrite = resolve;
  });
  const concurrentData = {
    annotatePattern: async () => {
      await heldWrite;
      return {
        disposition: "confirmed",
        label: null,
        note: null,
        revision: 1,
        updatedAt: "2026-07-24T10:00:00.000Z",
      };
    },
  } as WorkbenchData;
  const concurrentLimit = workbenchHandler(concurrentData, undefined, {
    enabled: true,
    allowedOrigins: new Set([origin]),
    maximumWritesPerMinute: 1,
  });
  const firstConcurrent = concurrentLimit(request());
  const secondConcurrent = await concurrentLimit(request());
  expect(secondConcurrent.status).toBe(429);
  releaseWrite?.();
  expect((await firstConcurrent).status).toBe(200);

  const conflictData = {
    annotatePattern: async () => {
      throw new PatternAnnotationConflictError({
        disposition: "contextual",
        label: null,
        note: "Current note",
        revision: 2,
        updatedAt: "2026-07-24T10:00:00.000Z",
      }, "c".repeat(24));
    },
  } as WorkbenchData;
  const conflictHandler = workbenchHandler(conflictData, undefined, {
    enabled: true,
    allowedOrigins: new Set([origin]),
  });
  const conflict = await conflictHandler(request());
  expect(conflict.status).toBe(409);
  expect(await conflict.json()).toMatchObject({
    current: { disposition: "contextual", revision: 2 },
    snapshot: "c".repeat(24),
  });
});

test("Workflow Outcomes projection removes internal identifiers and project paths", () => {
  const projected = boundedOutcomeComparison({
    eventId: "internal-event-id",
    kind: "approval-gate-changed",
    occurredAt: "2026-07-22T02:09:09.139Z",
    status: "insufficient-coverage",
    reasons: ["pre-episodes-below-5"],
    scope: {
      projects: ["/private/project-one", "/private/project-two"],
      maximumWindowDays: 14,
      observedWindowHours: 9,
      preStart: "2026-07-21T17:09:09.139Z",
      postEnd: "2026-07-22T11:09:09.139Z",
    },
    coverage: { preEpisodes: 0, postEpisodes: 0 },
    pre: { episodes: 0 },
    post: { episodes: 0 },
    deltas: { completionRate: null },
    interpretation: { causal: false },
  });
  expect(projected).toMatchObject({
    kind: "approval-gate-changed",
    scope: {
      projectCount: 2,
      observedWindowHours: 9,
    },
  });
  const encoded = JSON.stringify(projected);
  expect(encoded).not.toContain("internal-event-id");
  expect(encoded).not.toContain("/private/project");
});

test("Workflow Pattern projection keeps evidence drilldown but removes internal lineage", () => {
  const projected = boundedWorkflowPattern({
    id: "internal-pattern-id",
    kind: "ownership-boundary",
    signal: "one-writer",
    role: "worker",
    title: "Worker agents: keep one writer",
    claim: "Repeated in three episodes.",
    boundaryEffect: "guardrail-imposed",
    coverage: {
      eventMemberships: 4,
      sharedEventMemberships: 2,
      distinctEpisodes: 3,
      distinctDays: 2,
      distinctFormulations: 2,
      collapsedSameEpisodeMemberships: 1,
      projects: ["/private/project-one", "/private/project-two"],
      harnesses: ["test-harness"],
      firstSeenAt: "2026-07-01T00:00:00.000Z",
      lastSeenAt: "2026-07-03T00:00:00.000Z",
      minimumDistinctEpisodes: 3,
      minimumDistinctDays: 2,
    },
    sequence: {
      relations: {
        introduced: 1,
        reinforced: 1,
        reformulated: 1,
        "returned-to-prior": 0,
      },
      latestRelation: "reformulated",
      timeline: [{
        eventId: "internal-event-id",
        episodeId: "internal-episode-id",
        statementHash: "internal-statement-hash",
        occurredAt: "2026-07-03T00:00:00.000Z",
        relation: "reformulated",
      }],
    },
    outcomes: {
      status: "insufficient-coverage",
      observedEpisodes: 1,
      sparseEpisodes: 2,
      minimumObservedEpisodes: 3,
      reasons: ["observed-episodes-below-3"],
      metrics: {
        completionRate: {
          orientation: "higher-is-favorable",
          samples: 1,
          favorable: null,
          unfavorable: null,
          unchanged: null,
          medianDelta: null,
        },
        frictionRate: {},
        reworkRate: {},
      },
      interpretation: { causal: false },
      futureInternalEventId: "internal-outcome-id",
      futureProjectPath: "/private/project-three",
    },
    examples: [{
      eventId: "internal-event-id",
      occurredAt: "2026-07-03T00:00:00.000Z",
      relation: "reformulated",
      statement: "Use /private/project-one as the only tree.",
      evidence: [{
        pointer: `chatlog://conversation/${"a".repeat(64)}/turn/0`,
        snippet: "Use /private/project-one.",
      }],
    }],
  }, {
    disposition: "contextual",
    label: "One writer",
    note: "Operator note",
    revision: 2,
    updatedAt: "2026-07-24T10:00:00.000Z",
    contentHash: "internal-annotation-hash",
    storagePath: "/private/annotations/object.json",
  } as any);
  expect(projected).toMatchObject({
    handle: expect.stringMatching(/^[a-f0-9]{24}$/),
    signal: "one-writer",
    annotation: {
      disposition: "contextual",
      label: "One writer",
      revision: 2,
    },
    coverage: {
      projectCount: 2,
      distinctEpisodes: 3,
      distinctDays: 2,
      sharedEventMemberships: 2,
    },
    sequence: {
      timeline: [{
        occurredAt: "2026-07-03T00:00:00.000Z",
        relation: "reformulated",
      }],
    },
    examples: [{
      evidence: [{ pointer: expect.stringContaining("chatlog://") }],
    }],
  });
  const encoded = JSON.stringify(projected);
  expect(encoded).not.toContain("internal-");
  expect(encoded).not.toContain("/private/project");
  expect(encoded).not.toContain("/private/annotations");
});
