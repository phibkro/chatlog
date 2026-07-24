import { expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deriveCorpus } from "../src/derive";
import type { Conversation } from "../src/types";
import type {
  WorkflowEvent,
  WorkflowEvolutionArtifact,
} from "../src/workflow-evolution";
import {
  deriveWorkflowEvolution,
} from "../src/workflow-evolution";
import type {
  WorkflowOutcomeComparison,
  WorkflowOutcomesArtifact,
} from "../src/workflow-outcomes";
import { deriveWorkflowOutcomes } from "../src/workflow-outcomes";
import {
  buildWorkflowPatterns,
  deriveWorkflowPatterns,
  loadWorkflowPatterns,
} from "../src/workflow-patterns";

const hash = (text: string) =>
  new Bun.CryptoHasher("sha256").update(text).digest("hex");

function workflowEvent(options: {
  id: string;
  episode: string;
  occurredAt: string;
  statementHash: string;
  signals: WorkflowEvent["signals"];
  role?: WorkflowEvent["lineage"]["roles"][number];
  project?: string;
  kind?: WorkflowEvent["kind"];
}): WorkflowEvent {
  return {
    id: options.id,
    kind: options.kind ?? "ownership-boundary",
    occurredAt: options.occurredAt,
    statementHash: options.statementHash,
    statement: `Bounded formulation ${options.statementHash}.`,
    confidence: "explicit-instruction",
    lineage: {
      episodeId: options.episode,
      conversations: 1,
      duplicateCopiesCollapsed: 0,
      projects: [options.project ?? "/private/project"],
      harnesses: ["test-harness"],
      roles: [options.role ?? "worker"],
    },
    signals: options.signals,
    evidence: [{
      pointer: `chatlog://conversation/${hash(options.id)}/turn/0`,
      snippet: "Bounded synthetic evidence.",
    }],
  };
}

function comparison(
  eventId: string,
  status: WorkflowOutcomeComparison["status"],
  deltas: Partial<WorkflowOutcomeComparison["deltas"]> = {},
): WorkflowOutcomeComparison {
  return {
    eventId,
    kind: "ownership-boundary",
    occurredAt: "2026-07-01T00:00:00.000Z",
    status,
    reasons: status === "observed" ? [] : ["pre-episodes-below-5"],
    scope: {
      projects: ["/private/project"],
      maximumWindowDays: 14,
      observedWindowHours: 24,
      preStart: null,
      postEnd: null,
    },
    coverage: {
      scopedConversations: 10,
      representativeEpisodes: 10,
      excludedEventEpisode: 1,
      excludedSpanningAnchor: 0,
      excludedOutsideWindow: 0,
      preEpisodes: 5,
      postEpisodes: 5,
      minimumEpisodesPerSide: 5,
    },
    pre: {} as WorkflowOutcomeComparison["pre"],
    post: {} as WorkflowOutcomeComparison["post"],
    deltas: {
      completionRate: null,
      frictionRate: null,
      reworkRate: null,
      medianTurns: null,
      medianDurationMinutes: null,
      reportedTokensBySource: [],
      ...deltas,
    },
    interpretation: {
      claim: "Synthetic descriptive comparison.",
      causal: false,
    },
  };
}

test("workflow patterns require distinct multi-day episodes and preserve conservative relations", () => {
  const events = [
    workflowEvent({
      id: "older-same-episode",
      episode: "episode-1",
      occurredAt: "2026-07-01T00:00:00.000Z",
      statementHash: "formulation-z",
      signals: ["one-writer", "stop-and-report"],
      project: "/private/older-project",
    }),
    workflowEvent({
      id: "episode-1-newest",
      episode: "episode-1",
      occurredAt: "2026-07-01T01:00:00.000Z",
      statementHash: "formulation-a",
      signals: ["one-writer", "stop-and-report"],
    }),
    workflowEvent({
      id: "episode-2",
      episode: "episode-2",
      occurredAt: "2026-07-02T00:00:00.000Z",
      statementHash: "formulation-a",
      signals: ["one-writer", "stop-and-report"],
    }),
    workflowEvent({
      id: "episode-3",
      episode: "episode-3",
      occurredAt: "2026-07-03T00:00:00.000Z",
      statementHash: "formulation-b",
      signals: ["one-writer", "stop-and-report"],
    }),
    workflowEvent({
      id: "episode-4",
      episode: "episode-4",
      occurredAt: "2026-07-04T00:00:00.000Z",
      statementHash: "formulation-a",
      signals: ["one-writer", "stop-and-report"],
    }),
    workflowEvent({
      id: "below-floor-1",
      episode: "episode-5",
      occurredAt: "2026-07-05T00:00:00.000Z",
      statementHash: "spec-a",
      signals: ["spec-freeze"],
      role: "manager",
    }),
    workflowEvent({
      id: "below-floor-2",
      episode: "episode-6",
      occurredAt: "2026-07-06T00:00:00.000Z",
      statementHash: "spec-a",
      signals: ["spec-freeze"],
      role: "manager",
    }),
    workflowEvent({
      id: "below-floor-same-episode",
      episode: "episode-6",
      occurredAt: "2026-07-06T01:00:00.000Z",
      statementHash: "spec-b",
      signals: ["spec-freeze"],
      role: "manager",
    }),
    workflowEvent({
      id: "same-day-1",
      episode: "episode-7",
      occurredAt: "2026-07-07T00:00:00.000Z",
      statementHash: "option-a",
      signals: ["ab-with-recommendation"],
      role: "advisor",
    }),
    workflowEvent({
      id: "same-day-2",
      episode: "episode-8",
      occurredAt: "2026-07-07T01:00:00.000Z",
      statementHash: "option-b",
      signals: ["ab-with-recommendation"],
      role: "advisor",
    }),
    workflowEvent({
      id: "same-day-3",
      episode: "episode-9",
      occurredAt: "2026-07-07T02:00:00.000Z",
      statementHash: "option-c",
      signals: ["ab-with-recommendation"],
      role: "advisor",
    }),
  ];
  const workflowContentHash = hash("workflow");
  const outcomesContentHash = hash("outcomes");
  const structureProjectionHash = hash("structure");
  const workflow = {
    contentHash: workflowContentHash,
    artifact: {
      schemaVersion: 1,
      outputKind: "workflow-evolution",
      inputProjectionHash: hash("projection"),
      methodology: {},
      summary: {},
      tracers: { approvalGate: null },
      events,
      egress: {
        performed: false,
        surface: "none",
        hostedCalls: 0,
        declaration: "synthetic",
      },
    } as WorkflowEvolutionArtifact,
  };
  const outcomes = {
    contentHash: outcomesContentHash,
    artifact: {
      schema: "chatlog/workflow-outcomes-v1",
      schemaVersion: 1,
      outputKind: "workflow-outcomes",
      inputProjectionHash: hash("outcome-input"),
      structureProjectionHash,
      workflowContentHash,
      comparisons: [
        comparison("older-same-episode", "observed", {
          completionRate: 99,
          frictionRate: -99,
          reworkRate: -99,
        }),
        comparison("episode-1-newest", "observed", {
          completionRate: 0.1,
          frictionRate: -0.1,
          reworkRate: -0.2,
        }),
        comparison("episode-2", "observed", {
          completionRate: 0.2,
          frictionRate: 0.1,
          reworkRate: -0.1,
        }),
        comparison("episode-3", "observed", {
          completionRate: -0.1,
          frictionRate: 0,
          reworkRate: 0.2,
        }),
        comparison("episode-4", "insufficient-coverage"),
      ],
    } as WorkflowOutcomesArtifact,
  };

  const report = buildWorkflowPatterns(workflow, outcomes);
  expect(report.summary).toMatchObject({
    workflowEvents: 11,
    candidateSignatures: 4,
    repeatedPatterns: 2,
    belowFloorSignatures: 2,
    outcomeObservedPatterns: 2,
  });
  expect(report.patterns.map((pattern) => pattern.signal).sort()).toEqual([
    "one-writer",
    "stop-and-report",
  ]);
  const pattern = report.patterns.find((item) => item.signal === "one-writer")!;
  expect(pattern.coverage).toMatchObject({
    eventMemberships: 5,
    sharedEventMemberships: 5,
    distinctEpisodes: 4,
    distinctDays: 4,
    distinctFormulations: 2,
    collapsedSameEpisodeMemberships: 1,
    projects: ["/private/older-project", "/private/project"],
  });
  expect(pattern.sequence).toMatchObject({
    relations: {
      introduced: 1,
      reinforced: 1,
      reformulated: 1,
      "returned-to-prior": 1,
    },
    latestRelation: "returned-to-prior",
  });
  expect(pattern.sequence.timeline.map((item) => item.eventId)).toEqual([
    "episode-1-newest",
    "episode-2",
    "episode-3",
    "episode-4",
  ]);
  expect(pattern.outcomes).toMatchObject({
    status: "observed",
    observedEpisodes: 3,
    sparseEpisodes: 1,
    metrics: {
      completionRate: {
        samples: 3,
        favorable: 2,
        unfavorable: 1,
        unchanged: 0,
        medianDelta: 0.1,
      },
      frictionRate: {
        samples: 3,
        favorable: 1,
        unfavorable: 1,
        unchanged: 1,
        medianDelta: 0,
      },
      reworkRate: {
        samples: 3,
        favorable: 2,
        unfavorable: 1,
        unchanged: 0,
        medianDelta: -0.1,
      },
    },
    interpretation: { causal: false },
  });
  expect(report.egress).toEqual({
    performed: false,
    surface: "none",
    hostedCalls: 0,
  });
  expect(JSON.stringify(buildWorkflowPatterns(workflow, outcomes)))
    .toBe(JSON.stringify(report));
});

test("approval policy and guardrail memberships retain separate boundary effects", () => {
  const workflowContentHash = hash("approval-workflow");
  const events = Array.from({ length: 3 }, (_, index) => workflowEvent({
    id: `approval-${index}`,
    episode: `approval-episode-${index}`,
    occurredAt: `2026-07-0${index + 1}T00:00:00.000Z`,
    statementHash: `approval-formulation-${index}`,
    signals: ["one-writer"],
    role: "manager",
    kind: "approval-gate-changed",
  }));
  const report = buildWorkflowPatterns({
    contentHash: workflowContentHash,
    artifact: {
      events,
    } as WorkflowEvolutionArtifact,
  }, {
    contentHash: hash("approval-outcomes"),
    artifact: {
      structureProjectionHash: hash("approval-structure"),
      workflowContentHash,
      comparisons: [],
    } as WorkflowOutcomesArtifact,
  });
  expect(report.patterns).toHaveLength(2);
  expect(report.patterns.map((pattern) => ({
    signal: pattern.signal,
    effect: pattern.boundaryEffect,
  })).sort((a, b) => a.signal.localeCompare(b.signal))).toEqual([
    {
      signal: "approval-policy",
      effect: "approval-gate-relaxed",
    },
    {
      signal: "one-writer",
      effect: "guardrail-imposed",
    },
  ]);
});

async function writeConversation(
  root: string,
  conversation: Conversation,
): Promise<void> {
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

test("workflow pattern artifact is projection-bound and byte-stable", async () => {
  const root = await mkdtemp(join(tmpdir(), "chatlog-workflow-patterns-"));
  const conversations = Array.from({ length: 3 }, (_, index) => {
    const contentHash = hash(`conversation-${index}`);
    return {
      id: `raw-session-${index}`,
      resumeId: `raw-session-${index}`,
      provider: "test-provider",
      harness: "test-harness",
      domain: "coding",
      sourceKind: "session-log",
      project: "/private/project",
      cwd: "/private/project",
      model: "transient-model",
      startedAt: `2026-07-0${index + 1}T00:00:00.000Z`,
      endedAt: `2026-07-0${index + 1}T00:01:00.000Z`,
      sourcePath: `/private/source-${index}`,
      contentHash,
      turns: [{
        role: "user",
        content: "Build this bounded implementation as the sole writer.",
        at: `2026-07-0${index + 1}T00:00:00.000Z`,
      }],
    } satisfies Conversation;
  });
  for (const conversation of conversations)
    await writeConversation(root, conversation);
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
  await deriveWorkflowOutcomes(root);

  const first = await deriveWorkflowPatterns(root);
  const cached = await deriveWorkflowPatterns(root);
  expect(first.processed).toBe(true);
  expect(cached).toMatchObject({
    processed: false,
    contentHash: first.contentHash,
  });
  await unlink(join(root, "derived", "workflow-patterns-manifest.json"));
  const rebuilt = await deriveWorkflowPatterns(root);
  expect(rebuilt).toMatchObject({
    processed: true,
    contentHash: first.contentHash,
  });
  const artifactText = await readFile(first.artifactPath, "utf8");
  expect(hash(artifactText)).toBe(first.contentHash);
  const report = await loadWorkflowPatterns(root);
  expect(report).toMatchObject({
    summary: {
      workflowEvents: 3,
      repeatedPatterns: 1,
      minimumDistinctEpisodes: 3,
      minimumDistinctDays: 2,
    },
    patterns: [{
      signal: "one-writer",
      role: "worker",
      coverage: {
        distinctEpisodes: 3,
        distinctDays: 3,
      },
      outcomes: {
        status: "insufficient-coverage",
        interpretation: { causal: false },
      },
    }],
  });
  expect(artifactText).not.toContain("raw-session");
  expect(artifactText).not.toContain("transient-model");
  expect(artifactText).not.toContain("/private/source");

  await writeFile(first.artifactPath, `${artifactText} `);
  await expect(loadWorkflowPatterns(root))
    .rejects.toThrow("current artifact failed integrity validation");
  await writeFile(first.artifactPath, artifactText);
  expect(await loadWorkflowPatterns(root)).not.toBeNull();

  const outcomesManifest = JSON.parse(await readFile(
    join(root, "derived", "workflow-outcomes-manifest.json"),
    "utf8",
  ));
  const outcomesPath = join(
    root,
    "derived",
    outcomesManifest.current.artifactPath,
  );
  await writeFile(outcomesPath, `${await readFile(outcomesPath, "utf8")} `);
  await expect(loadWorkflowPatterns(root))
    .rejects.toThrow("current artifact failed integrity validation");
});
