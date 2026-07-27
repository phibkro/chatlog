import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { indexConversation, openAnalysis } from "../src/analysis";
import { deriveCorpus } from "../src/derive";
import { WorkbenchData } from "../src/workbench/data";
import { resolveBindConfig, workbenchHandler } from "../src/workbench/server";
import type { Conversation } from "../src/types";
import { topicCacheKey, VAULT_TOPIC_RECIPE } from "../src/vault";

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
  contentHash: string,
): Promise<void> {
  const artifactPath = `${collection}/artifact.json`;
  await mkdir(join(root, "derived", collection), { recursive: true });
  await writeFile(join(root, "derived", artifactPath), JSON.stringify(artifact));
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
  const paths = [
    ...new Bun.Glob("**/*").scanSync({ cwd: root, onlyFiles: true, dot: true }),
  ].toSorted();
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
  const db = openAnalysis(join(root, "analysis", "chatlog.sqlite"));
  indexConversation(db, superseded, 1, 1);
  indexConversation(db, current, 2, 1);
  indexConversation(db, second, 1, 1);
  for (const conversation of toolOnly) indexConversation(db, conversation, 1, 1);
  db.close();
  await Promise.all(
    conversations.map(async (conversation) => {
      const directory = join(
        root,
        "corpus",
        "objects",
        conversation.contentHash.slice(0, 2),
      );
      await mkdir(directory, { recursive: true });
      await writeFile(
        join(directory, `${conversation.contentHash}.json`),
        JSON.stringify(conversation),
      );
    }),
  );
  await writeFile(
    join(root, "corpus", "manifest.json"),
    JSON.stringify({
      version: 1,
      sources: Object.fromEntries([
        [current.sourcePath, { contentHash: current.contentHash }],
        [second.sourcePath, { contentHash: second.contentHash }],
        ...toolOnly.map((conversation) => [
          conversation.sourcePath,
          { contentHash: conversation.contentHash },
        ]),
      ]),
    }),
  );
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
  db.close();
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
  await expect(data.evidence(`chatlog://conversation/${staleHash}/turn/0`)).rejects.toThrow(
    "Evidence not found",
  );

  const handler = workbenchHandler(data);
  const overviewResponse = await handler(new Request("http://localhost/api/overview"));
  expect(overviewResponse.status).toBe(200);
  expect(await overviewResponse.json()).toMatchObject({ ready: true, corpus: { sessions: 1 } });
  const readOnlyResponse = await handler(
    new Request("http://localhost/api/overview", { method: "POST" }),
  );
  expect(readOnlyResponse.status).toBe(405);
  expect(await readOnlyResponse.json()).toEqual({ error: "read-only workbench" });
  const staticResponse = await handler(new Request("http://localhost/"));
  expect(staticResponse.status).toBe(200);
  expect(staticResponse.headers.get("Content-Security-Policy")).toContain("frame-ancestors 'none'");
  expect(await staticResponse.text()).toContain("Chatlog Workbench");
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
    expect(result.sessions.every((session: any) => session.matchedEvidence.length <= 2)).toBe(
      true,
    );
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
    const matchedEvidence = (await data.evidence(
      result.sessions[0].matchedEvidence[0].uri,
    )) as any;
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
  const projectionText = '{"contentHash":"current"}\n';
  const projectionHash = sha256(projectionText);
  const roleContentHash = "f".repeat(64);
  const evidence = [...evidencePointers(5), { pointer: "not-a-pointer", snippet: "invalid" }];
  await mkdir(join(root, "derived"), { recursive: true });
  await writeFile(join(root, "derived", "current-hashes.jsonl"), projectionText);
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
    "a".repeat(64),
  );
  await writeInsightArtifact(
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
    roleContentHash,
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
    "b".repeat(64),
  );
  await writeInsightArtifact(
    root,
    "refinery",
    "refinery-manifest.json",
    {
      inputProjectionHash: projectionHash,
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
    projectionHash,
    "c".repeat(64),
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
  const projectionText = '{"contentHash":"current"}\n';
  const projectionHash = sha256(projectionText);
  const candidates = Array.from({ length: 57 }, (_, index) => knowledgeCandidateFixture(index));
  await mkdir(join(root, "derived"), { recursive: true });
  await writeFile(join(root, "derived", "current-hashes.jsonl"), projectionText);
  await writeInsightArtifact(
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
    "c".repeat(64),
  );
  const artifactPath = join(root, "derived", "refinery", "artifact.json");
  const before = await readFile(artifactPath, "utf8");
  const data = new WorkbenchData(root);
  const handler = workbenchHandler(data);
  try {
    const secondPageResponse = await handler(
      new Request(
        "http://localhost/api/knowledge-candidates?page=2&pageSize=10&type=all",
      ),
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
      new Request(
        "http://localhost/api/knowledge-candidates?type=claude-md&pageSize=50",
      ),
    );
    const typed = (await typeResponse.json()) as any;
    expect(typed.pagination.total).toBe(11);
    expect(typed.items.every((candidate: any) => candidate.type === "claude-md")).toBe(true);

    const searchResponse = await handler(
      new Request(
        "http://localhost/api/knowledge-candidates?q=candidate-042&pageSize=50",
      ),
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
      contentHash: "c".repeat(64),
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

test("Knowledge Gaps review marks stale refinery candidates as historical", async () => {
  const root = await mkdtemp(join(tmpdir(), "chatlog-workbench-knowledge-stale-"));
  const projectionText = '{"contentHash":"current"}\n';
  const currentHash = sha256(projectionText);
  const staleHash = "d".repeat(64);
  await mkdir(join(root, "derived"), { recursive: true });
  await writeFile(join(root, "derived", "current-hashes.jsonl"), projectionText);
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
    "c".repeat(64),
  );
  const data = new WorkbenchData(root);
  try {
    const list = (await data.knowledgeCandidates(
      new URL("http://localhost/api/knowledge-candidates"),
    )) as any;
    expect(list.provenance).toMatchObject({
      fresh: false,
      status: "stale",
      reason: "projection-mismatch",
      currentProjectionHash: currentHash,
      artifactProjectionHash: staleHash,
    });
    const detail = (await data.knowledgeCandidate(
      new URL("http://localhost/api/knowledge-candidate?id=candidate-000"),
    )) as any;
    expect(detail.provenance).toMatchObject({
      fresh: false,
      status: "stale",
      reason: "projection-mismatch",
    });
    expect(detail.reviewNotice).toContain("not classified as a project documentation gap");
  } finally {
    data.close();
  }
});

test("experimental Themes explorer reports exact current completed-cache coverage without side effects", async () => {
  const root = await mkdtemp(join(tmpdir(), "chatlog-workbench-themes-"));
  const currentHashes = ["a".repeat(64), "b".repeat(64), "c".repeat(64)];
  const staleHash = "9".repeat(64);
  await mkdir(join(root, "derived"), { recursive: true });
  await writeFile(
    join(root, "derived", "current-hashes.jsonl"),
    `${currentHashes
      .map((conversationHash) => JSON.stringify({ conversationHash }))
      .join("\n")}\n`,
  );
  await writeTopicCache(
    root,
    currentHashes[0]!,
    "model-a",
    VAULT_TOPIC_RECIPE,
    ["nix-flakes", "restic-backups"],
  );
  await writeTopicCache(
    root,
    currentHashes[1]!,
    "model-a",
    VAULT_TOPIC_RECIPE,
    ["nix-flake", "career-planning"],
  );
  await writeTopicCache(
    root,
    staleHash,
    "model-b",
    "older-topic-recipe",
    ["stale-topic-must-not-count"],
  );
  const malformedKey = "f".repeat(64);
  const malformedDirectory = join(
    root,
    "analysis",
    "vault-topic-cache",
    malformedKey.slice(0, 2),
  );
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
    expect(result.clusterRecipe).toBe(
      "vault-topic-token-set-jaccard-current-conversation-v1",
    );
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

    const boundedResponse = await handler(
      new Request("http://localhost/api/themes?scanLimit=2"),
    );
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
    const missing = (await missingData.themes(
      new URL("http://localhost/api/themes"),
    )) as any;
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
    const malformed = (await malformedData.themes(
      new URL("http://localhost/api/themes"),
    )) as any;
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

test("insights mark mismatched projections stale and effectiveness inherits role staleness", async () => {
  const root = await mkdtemp(join(tmpdir(), "chatlog-workbench-insights-stale-"));
  const projectionText = '{"contentHash":"current"}\n';
  const currentHash = sha256(projectionText);
  const staleHash = "d".repeat(64);
  const roleContentHash = "e".repeat(64);
  await mkdir(join(root, "derived"), { recursive: true });
  await writeFile(join(root, "derived", "current-hashes.jsonl"), projectionText);
  await writeInsightArtifact(
    root,
    "orchestration-lean",
    "orchestration-lean-manifest.json",
    { inputProjectionHash: staleHash, finding: { claim: "Old claim", evidence: [] } },
    staleHash,
    "a".repeat(64),
  );
  await writeInsightArtifact(
    root,
    "orchestration-roles",
    "orchestration-roles-manifest.json",
    { inputProjectionHash: staleHash, inferredCounts: {}, profiles: [] },
    staleHash,
    roleContentHash,
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
    "b".repeat(64),
  );
  await writeInsightArtifact(
    root,
    "refinery",
    "refinery-manifest.json",
    { inputProjectionHash: staleHash, threshold: 3, policy: {}, candidates: [] },
    staleHash,
    "c".repeat(64),
  );

  const data = new WorkbenchData(root);
  const insights = (await data.insights()) as any;
  for (const name of ["orchestration", "roles", "refinery"])
    expect(insights[name].provenance).toMatchObject({
      fresh: false,
      status: "stale",
      reason: "projection-mismatch",
      currentProjectionHash: currentHash,
      artifactProjectionHash: staleHash,
    });
  expect(insights.effectiveness.provenance).toMatchObject({
    fresh: false,
    status: "stale",
    reason: "role-profile-stale",
    roleProfileContentHash: roleContentHash,
    currentRoleProfileContentHash: roleContentHash,
  });
  data.close();
});

test("Workbench bind policy defaults to loopback and requires an explicit remote override", () => {
  expect(resolveBindConfig({})).toEqual({ host: "127.0.0.1", port: 4789 });
  expect(resolveBindConfig({ CHATLOG_HOST: "::1", CHATLOG_PORT: "4790" })).toEqual({
    host: "::1",
    port: 4790,
  });
  expect(() => resolveBindConfig({ CHATLOG_HOST: "100.64.0.7" })).toThrow(
    "Refusing non-loopback bind",
  );
  expect(
    resolveBindConfig({
      CHATLOG_HOST: "100.64.0.7",
      CHATLOG_ALLOW_REMOTE: "1",
    }),
  ).toEqual({ host: "100.64.0.7", port: 4789 });
});
