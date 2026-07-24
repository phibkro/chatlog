import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deriveCorpus } from "../src/derive";
import type { Conversation } from "../src/types";
import { deriveWorkflowEvolution } from "../src/workflow-evolution";
import {
  buildWorkflowOutcomes,
  deriveWorkflowOutcomes,
  loadWorkflowOutcomes,
} from "../src/workflow-outcomes";

const hash = (text: string) =>
  new Bun.CryptoHasher("sha256").update(text).digest("hex");

async function writeConversation(root: string, conversation: Conversation): Promise<void> {
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
}

function outcomeConversation(options: {
  label: string;
  session?: string;
  project?: string;
  startedAt: string;
  endedAt: string;
  success: boolean;
  friction: boolean;
  tokens: number;
}): Conversation {
  const contentHash = hash(options.label);
  return {
    id: options.session ?? `raw-${options.label}`,
    resumeId: options.session ?? `raw-${options.label}`,
    provider: "test-provider",
    harness: "test-harness",
    domain: "coding",
    sourceKind: "session-log",
    project: options.project ?? "outcome-project",
    cwd: "/private/outcome-project",
    model: "transient-outcome-model",
    startedAt: options.startedAt,
    endedAt: options.endedAt,
    sourcePath: `/private/sources/${options.label}`,
    contentHash,
    turns: [
      {
        role: "user",
        content: options.friction
          ? "The build issue fails and needs a fix."
          : "Implement the bounded feature.",
        at: options.startedAt,
      },
      {
        role: "assistant",
        content: "Run the declared checks.",
        toolCalls: [{ name: "bash" }],
        tokens: { total: options.tokens },
        at: options.startedAt,
      },
      {
        role: "tool",
        content: options.success
          ? "All tests passed; exit code 0."
          : "The build failed with an error; exit code 1.",
        at: options.endedAt,
      },
      {
        role: "assistant",
        content: options.success
          ? "The work completed successfully and is verified."
          : "The build failed with an unresolved error.",
        at: options.endedAt,
      },
    ],
  };
}

test("workflow outcomes use symmetric deduplicated descriptive windows", async () => {
  const root = await mkdtemp(join(tmpdir(), "chatlog-workflow-outcomes-"));
  const conversations: Conversation[] = [];
  for (let index = 0; index < 5; index++) {
    const day = 10 + index;
    conversations.push(outcomeConversation({
      label: `pre-${index}`,
      startedAt: `2026-07-${String(day).padStart(2, "0")}T11:50:00Z`,
      endedAt: `2026-07-${String(day).padStart(2, "0")}T12:00:00Z`,
      success: index < 2,
      friction: true,
      tokens: 100,
    }));
  }
  for (let index = 0; index < 5; index++) {
    const day = 16 + index;
    conversations.push(outcomeConversation({
      label: `post-${index}`,
      startedAt: `2026-07-${String(day).padStart(2, "0")}T11:50:00Z`,
      endedAt: `2026-07-${String(day).padStart(2, "0")}T12:00:00Z`,
      success: index < 4,
      friction: index === 4,
      tokens: 80,
    }));
  }
  conversations.push(outcomeConversation({
    label: "pre-0-newer-snapshot",
    session: "raw-pre-0",
    startedAt: "2026-07-10T12:10:00Z",
    endedAt: "2026-07-10T13:00:00Z",
    success: false,
    friction: true,
    tokens: 100,
  }));
  conversations[0].id = "raw-pre-0";
  conversations[0].resumeId = "raw-pre-0";
  conversations.push(outcomeConversation({
    label: "spanning",
    startedAt: "2026-07-15T11:00:00Z",
    endedAt: "2026-07-15T13:00:00Z",
    success: true,
    friction: false,
    tokens: 90,
  }));
  conversations.push(outcomeConversation({
    label: "pre-window-overhang",
    startedAt: "2026-07-09T11:50:00Z",
    endedAt: "2026-07-11T12:00:00Z",
    success: true,
    friction: false,
    tokens: 90,
  }));
  conversations.push(outcomeConversation({
    label: "post-window-overhang",
    startedAt: "2026-07-20T11:50:00Z",
    endedAt: "2026-07-21T12:00:00Z",
    success: true,
    friction: false,
    tokens: 90,
  }));
  conversations.push(outcomeConversation({
    label: "unrelated",
    project: "other-project",
    startedAt: "2026-07-18T11:50:00Z",
    endedAt: "2026-07-18T12:00:00Z",
    success: true,
    friction: false,
    tokens: 1,
  }));
  const policyHash = hash("policy-event");
  conversations.push({
    id: "raw-policy-session",
    resumeId: "raw-policy-session",
    provider: "test-provider",
    harness: "test-harness",
    domain: "coding",
    sourceKind: "session-log",
    project: "outcome-project",
    cwd: "/private/outcome-project",
    model: "transient-policy-model",
    startedAt: "2026-07-15T11:59:00Z",
    endedAt: "2026-07-15T12:10:00Z",
    sourcePath: "/private/sources/policy",
    contentHash: policyHash,
    turns: [
      {
        role: "user",
        content: "Take on the role as agent manager-orchestrator.",
        at: "2026-07-15T11:59:00Z",
      },
      {
        role: "user",
        content: "PRs are now allowed and agents may merge autonomously with no operator review gate. Confirm checks are green first.",
        at: "2026-07-15T12:00:00Z",
      },
    ],
  });
  const sparseHash = hash("sparse-event");
  conversations.push({
    id: "raw-sparse-session",
    resumeId: "raw-sparse-session",
    provider: "test-provider",
    harness: "test-harness",
    domain: "coding",
    sourceKind: "session-log",
    project: "sparse-project",
    cwd: "/private/sparse-project",
    model: "transient-sparse-model",
    startedAt: "2026-07-19T11:59:00Z",
    endedAt: "2026-07-19T12:10:00Z",
    sourcePath: "/private/sources/sparse",
    contentHash: sparseHash,
    turns: [{
      role: "user",
      content: "Continue autonomously until a true operator decision is needed.",
      at: "2026-07-19T12:00:00Z",
    }],
  });

  for (const conversation of conversations) await writeConversation(root, conversation);
  await mkdir(join(root, "corpus"), { recursive: true });
  await writeFile(join(root, "corpus", "manifest.json"), JSON.stringify({
    version: 1,
    sources: Object.fromEntries(
      conversations.map((conversation) => [
        conversation.sourcePath,
        { contentHash: conversation.contentHash },
      ]),
    ),
  }));
  await deriveCorpus(root);
  await deriveWorkflowEvolution(root);

  const first = await deriveWorkflowOutcomes(root);
  const cached = await deriveWorkflowOutcomes(root);
  expect(first.processed).toBe(true);
  expect(cached).toMatchObject({ processed: false, contentHash: first.contentHash });
  await unlink(join(root, "derived", "workflow-outcomes-manifest.json"));
  const rebuilt = await deriveWorkflowOutcomes(root);
  expect(rebuilt).toMatchObject({ processed: true, contentHash: first.contentHash });
  const artifactText = await readFile(first.artifactPath, "utf8");
  expect(hash(artifactText)).toBe(first.contentHash);

  const report = await loadWorkflowOutcomes(root);
  expect(report).not.toBeNull();
  expect(report!.summary).toEqual({
    events: 2,
    observed: 1,
    insufficientCoverage: 1,
  });
  expect(report!.observationBounds).toEqual({
    firstEndedAt: "2026-07-10T12:00:00.000Z",
    lastEndedAt: "2026-07-21T12:00:00.000Z",
  });
  const comparison = report!.approvalGateTracer!;
  expect(comparison.coverage.representativeEpisodes).toBe(
    comparison.coverage.excludedSpanningAnchor
    + comparison.coverage.excludedOutsideWindow
    + comparison.coverage.preEpisodes
    + comparison.coverage.postEpisodes,
  );
  expect(comparison).toMatchObject({
    status: "observed",
    reasons: [],
    scope: {
      projects: ["outcome-project"],
      observedWindowHours: 120,
      preStart: "2026-07-10T12:00:00.000Z",
      postEnd: "2026-07-20T12:00:00.000Z",
    },
    coverage: {
      scopedConversations: 15,
      representativeEpisodes: 13,
      excludedEventEpisode: 1,
      excludedSpanningAnchor: 1,
      excludedOutsideWindow: 2,
      preEpisodes: 5,
      postEpisodes: 5,
    },
    pre: {
      episodes: 5,
      outcomes: { known: 5, success: 1, completionRate: 0.2 },
      friction: { episodes: 5, rate: 1, problemSignals: 5 },
      rework: { knownAttempts: 5, failedAttempts: 4, rate: 0.8 },
      tokensBySource: [{
        provider: "test-provider",
        harness: "test-harness",
        samples: 5,
        medianReportedTokens: 100,
      }],
    },
    post: {
      episodes: 5,
      outcomes: { known: 5, success: 4, completionRate: 0.8 },
      friction: { episodes: 1, rate: 0.2, problemSignals: 1 },
      rework: { knownAttempts: 5, failedAttempts: 1, rate: 0.2 },
      tokensBySource: [{
        provider: "test-provider",
        harness: "test-harness",
        samples: 5,
        medianReportedTokens: 80,
      }],
    },
    deltas: {
      completionRate: 0.6,
      frictionRate: -0.8,
      reworkRate: -0.6,
      medianTurns: 0,
      medianDurationMinutes: 0,
      reportedTokensBySource: [{
        provider: "test-provider",
        harness: "test-harness",
        preSamples: 5,
        postSamples: 5,
        medianChange: -20,
      }],
    },
    interpretation: { causal: false },
  });
  expect(report!.methodology.causality).toContain("cannot establish");
  const sparse = report!.comparisons.find((item) => item.eventId !== comparison.eventId)!;
  expect(sparse).toMatchObject({
    status: "insufficient-coverage",
    reasons: ["pre-episodes-below-5", "post-episodes-below-5"],
    coverage: { preEpisodes: 0, postEpisodes: 0 },
    deltas: {
      completionRate: null,
      frictionRate: null,
      reworkRate: null,
      reportedTokensBySource: [],
    },
    interpretation: { causal: false },
  });
  expect(report!.egress).toEqual({
    performed: false,
    surface: "none",
    hostedCalls: 0,
  });
  expect(artifactText).not.toContain("raw-");
  expect(artifactText).not.toContain("transient-");
  expect(artifactText).not.toContain("/private/sources");

  const derivedPath = join(
    root,
    "derived",
    "objects",
    conversations[0].contentHash.slice(0, 2),
    `${conversations[0].contentHash}.json`,
  );
  await writeFile(derivedPath, `${await readFile(derivedPath, "utf8")} `);
  await expect(buildWorkflowOutcomes(root))
    .rejects.toThrow("derived structure failed integrity validation");
});
