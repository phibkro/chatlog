import { expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { PromotionCandidate, RefineryArtifact } from "../src/refinery";
import { matchTopic, queryUndocumented, topicSlug, type DocFile } from "../src/undocumented";

function pointer(turnIndex: number) {
  return { turnIndex, uri: `chatlog://conversation/${"a".repeat(64)}/turn/${turnIndex}` };
}

function evidenceRow(project: string, sessionId: string, turnIndex: number) {
  return {
    conversationHash: "a".repeat(64),
    sessionId,
    project,
    harness: "claude",
    model: "sonnet",
    pointer: pointer(turnIndex),
    snippet: "snippet",
  };
}

function candidate(overrides: Partial<PromotionCandidate>): PromotionCandidate {
  return {
    id: "id",
    type: "claude-md",
    signature: "sig",
    title: "title",
    status: "curation-required",
    frequency: {
      occurrences: 10,
      distinctSnippets: 10,
      conversations: 8,
      sessions: 5,
      projects: 1,
      harnesses: 1,
      threshold: 3,
    },
    evidence: [],
    curation: { principle: "p", route: "r", checks: [] },
    evaluation: {
      contract: "agent-eval/promotion-v1",
      status: "unmeasured",
      minimumRunsPerArm: 3,
      control: "c",
      treatment: "t",
      metrics: [],
      keepRule: "k",
      cutRule: "c",
    },
    ...overrides,
  };
}

async function seedRefinery(root: string, candidates: PromotionCandidate[]): Promise<void> {
  const artifact: RefineryArtifact = {
    schemaVersion: 1,
    inputProjectionHash: "hash",
    recipeHash: "hash",
    threshold: 3,
    policy: {
      autoPromotion: false,
      frequencyIsSignalNotDecision: true,
      referenceWikiDeferred: true,
    },
    candidates,
  };
  const derivedDir = join(root, "derived");
  await mkdir(derivedDir, { recursive: true });
  const artifactPath = "refinery/artifact.json";
  await mkdir(join(derivedDir, "refinery"), { recursive: true });
  await writeFile(join(derivedDir, artifactPath), JSON.stringify(artifact));
  await writeFile(
    join(derivedDir, "refinery-manifest.json"),
    JSON.stringify({
      version: 1,
      current: {
        inputProjectionHash: "hash",
        recipeHash: "hash",
        threshold: 3,
        artifactPath,
        contentHash: "hash",
        processedAt: new Date().toISOString(),
      },
    }),
  );
}

test("topicSlug strips a project prefix but leaves a bare theme alone", () => {
  expect(topicSlug("/srv/share/projects/homelab:test-build-gate-failure")).toBe(
    "test-build-gate-failure",
  );
  expect(topicSlug("timeout-memory-or-resource-limit")).toBe("timeout-memory-or-resource-limit");
});

test("matchTopic requires every term in a group, cites the matching file", () => {
  const docs: DocFile[] = [
    { path: "CLAUDE.md", text: "the flake source is untracked until you commit it" },
  ];
  const hit = matchTopic("nix-flake-source-visibility", docs);
  expect(hit).toEqual({ file: "CLAUDE.md", terms: ["untracked", "flake"] });
  expect(matchTopic("git-worktree-and-index-hygiene", docs)).toBeUndefined();
  expect(matchTopic("no-such-topic", docs)).toBeUndefined();
});

test("matchTopic is order-insensitive within its proximity window", () => {
  const reversed: DocFile[] = [
    { path: "CLAUDE.md", text: "an untracked change makes the flake evaluation blind to it" },
  ];
  expect(matchTopic("nix-flake-source-visibility", reversed)).toEqual({
    file: "CLAUDE.md",
    terms: ["untracked", "flake"],
  });
});

test("matchTopic does not fire on a term hidden inside an unrelated word", () => {
  // "oom" is a substring of "room"/"headroom"/"doom"; a naive substring
  // match would wrongly call this documented (regression for the false
  // "documented" verdict found against the real homelab corpus).
  const docs: DocFile[] = [{ path: "docs/x.md", text: "aurora hdd has 600 gb headroom" }];
  expect(matchTopic("timeout-memory-or-resource-limit", docs)).toBeUndefined();
});

test("matchTopic requires terms within the proximity window, not just the same file", () => {
  const farApart: DocFile[] = [
    {
      path: "docs/x.md",
      text: `this paragraph is invisible in the changelog${"x".repeat(500)}nix is a package manager`,
    },
  ];
  // "invisible" and "nix" are both present, but far enough apart that they
  // describe two unrelated sentences, not one claim about source visibility.
  expect(matchTopic("nix-flake-source-visibility", farApart)).toBeUndefined();
});

test("queryUndocumented excludes a candidate whose topic is covered by project docs", async () => {
  const root = await mkdtemp(join(tmpdir(), "chatlog-undoc-"));
  const project = await mkdtemp(join(tmpdir(), "chatlog-undoc-project-"));
  await writeFile(
    join(project, "CLAUDE.md"),
    "## Push gate (solo review)\n\nAgents never `git push` without approval.",
  );
  await seedRefinery(root, [
    candidate({
      id: "documented",
      signature: `${project}:release-deploy-and-publish-gate`,
      evidence: [evidenceRow(project, "session-a", 1), evidenceRow(project, "session-b", 2)],
    }),
    candidate({
      id: "undocumented",
      signature: `${project}:nix-flake-source-visibility`,
      frequency: {
        occurrences: 20,
        distinctSnippets: 20,
        conversations: 12,
        sessions: 6,
        projects: 1,
        harnesses: 1,
        threshold: 3,
      },
      evidence: [
        evidenceRow(project, "session-c", 1),
        evidenceRow(project, "session-d", 2),
        evidenceRow(project, "session-e", 3),
      ],
    }),
  ]);
  const report = await queryUndocumented(root, project);
  expect(report.candidatesConsidered).toBe(2);
  expect(report.undocumented).toHaveLength(1);
  expect(report.undocumented[0]!.id).toBe("undocumented");
  expect(report.undocumented[0]!.evidence.length).toBeGreaterThanOrEqual(2);
  expect(new Set(report.undocumented[0]!.evidence.map((e) => e.sessionId)).size).toBe(
    report.undocumented[0]!.evidence.length,
  );
  expect(report.documented).toHaveLength(1);
  expect(report.documented[0]!.id).toBe("documented");
  expect(report.documented[0]!.matchedIn).toBe("CLAUDE.md");
});

test("queryUndocumented drops a candidate backed by a single session", async () => {
  const root = await mkdtemp(join(tmpdir(), "chatlog-undoc-"));
  const project = await mkdtemp(join(tmpdir(), "chatlog-undoc-project-"));
  await seedRefinery(root, [
    candidate({
      id: "one-session",
      signature: `${project}:nix-flake-source-visibility`,
      evidence: [evidenceRow(project, "session-a", 1), evidenceRow(project, "session-a", 2)],
    }),
  ]);
  const report = await queryUndocumented(root, project);
  expect(report.candidatesConsidered).toBe(0);
  expect(report.undocumented).toHaveLength(0);
  expect(report.documented).toHaveLength(0);
});

test("queryUndocumented ranks by re-derivation cost (occurrences x sessions)", async () => {
  const root = await mkdtemp(join(tmpdir(), "chatlog-undoc-"));
  const project = await mkdtemp(join(tmpdir(), "chatlog-undoc-project-"));
  await seedRefinery(root, [
    candidate({
      id: "small",
      signature: `${project}:nix-flake-source-visibility`,
      frequency: {
        occurrences: 5,
        distinctSnippets: 5,
        conversations: 5,
        sessions: 2,
        projects: 1,
        harnesses: 1,
        threshold: 3,
      },
      evidence: [evidenceRow(project, "s1", 1), evidenceRow(project, "s2", 2)],
    }),
    candidate({
      id: "big",
      signature: `${project}:git-worktree-and-index-hygiene`,
      frequency: {
        occurrences: 100,
        distinctSnippets: 100,
        conversations: 40,
        sessions: 10,
        projects: 1,
        harnesses: 1,
        threshold: 3,
      },
      evidence: [evidenceRow(project, "s3", 1), evidenceRow(project, "s4", 2)],
    }),
  ]);
  const report = await queryUndocumented(root, project);
  expect(report.undocumented.map((row) => row.id)).toEqual(["big", "small"]);
});

test("queryUndocumented default scope excludes skill and wiki-page-later types", async () => {
  const root = await mkdtemp(join(tmpdir(), "chatlog-undoc-"));
  const project = await mkdtemp(join(tmpdir(), "chatlog-undoc-project-"));
  await seedRefinery(root, [
    candidate({
      id: "skill-type",
      type: "skill",
      signature: "nix-flake-source-visibility",
      evidence: [evidenceRow(project, "s1", 1), evidenceRow(project, "s2", 2)],
    }),
  ]);
  const defaultReport = await queryUndocumented(root, project);
  expect(defaultReport.candidatesConsidered).toBe(0);
  const openedReport = await queryUndocumented(root, project, { types: ["skill"] });
  expect(openedReport.candidatesConsidered).toBe(1);
});
