import { expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { indexConversation, openAnalysis } from "../src/analysis";
import { WorkbenchData } from "../src/workbench/data";
import { resolveBindConfig, workbenchHandler } from "../src/workbench/server";
import type { Conversation } from "../src/types";

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
      current: { inputProjectionHash, artifactPath, contentHash },
    }),
  );
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
  data.close();
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
