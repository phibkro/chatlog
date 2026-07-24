import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deriveCorpus } from "../src/derive";
import type { Conversation } from "../src/types";
import {
  classifyWorkflowTurn,
  deriveWorkflowEvolution,
  loadWorkflowEvolution,
} from "../src/workflow-evolution";

const approval =
  "Operator decision (2026-07-22): PRs are now ALLOWED and agents MAY merge them autonomously (no operator review gate). Confirm checks green first.";
const autonomy =
  "Continue autonomously until a true operator decision is needed.";
const ownership =
  "Use one named writer per mutable working tree; stop-and-report at a true scope wall.";

function fixture(options: {
  hash: string;
  source: string;
  session: string;
  startedAt: string;
  statements: Array<{ content: string; at: string }>;
  provider?: string;
  harness?: string;
}): Conversation {
  return {
    id: options.session,
    resumeId: options.session,
    provider: options.provider ?? "test",
    harness: options.harness ?? "codex",
    domain: "coding",
    sourceKind: "session-log",
    project: "workflow-project",
    cwd: "/private/workflow-project",
    model: "ephemeral-test-model",
    startedAt: options.startedAt,
    endedAt: options.statements.at(-1)?.at ?? options.startedAt,
    sourcePath: options.source,
    contentHash: options.hash,
    turns: [
      {
        role: "user",
        content: "Take on the role as agent manager-orchestrator and keep the lane moving.",
        at: options.startedAt,
      },
      ...options.statements.map((statement) => ({ role: "user", ...statement })),
    ],
  };
}

async function writeFixture(root: string, conversation: Conversation): Promise<void> {
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

test("workflow turn classification requires an explicit approval instruction", () => {
  expect(classifyWorkflowTurn(approval)).toEqual([expect.objectContaining({
    kind: "approval-gate-changed",
  })]);
  expect(classifyWorkflowTurn(
    "Should we remove the operator review gate?",
  )).toEqual([]);
  expect(classifyWorkflowTurn(
    "Do NOT merge without a separate operator review gate.",
  )).toEqual([]);
  expect(classifyWorkflowTurn(
    "Never remove the operator review gate; agents must wait for review.",
  )).toEqual([]);
  expect(classifyWorkflowTurn(
    "PRs are now allowed to merge, but operator approval is still required.",
  )).toEqual([]);
  expect(classifyWorkflowTurn(
    "Local merge stays gated on verified behavior; agents may merge autonomously.",
  )).toEqual([{ kind: "autonomy-boundary", signals: [] }]);
});

test("workflow evolution deduplicates same-session fan-out and remains local", async () => {
  const root = await mkdtemp(join(tmpdir(), "chatlog-workflow-evolution-"));
  const conversations = [
    fixture({
      hash: "a".repeat(64),
      source: "/sources/alpha-one",
      session: "raw-session-alpha",
      startedAt: "2026-07-22T08:00:00Z",
      statements: [
        { content: approval, at: "2026-07-22T08:01:00Z" },
        { content: autonomy, at: "2026-07-22T08:02:00Z" },
        { content: approval, at: "2026-07-22T08:03:00Z" },
      ],
    }),
    fixture({
      hash: "b".repeat(64),
      source: "/sources/alpha-two",
      session: "raw-session-alpha",
      startedAt: "2026-07-22T08:00:00Z",
      statements: [
        { content: approval, at: "2026-07-22T08:01:00Z" },
        { content: autonomy, at: "2026-07-22T08:02:00Z" },
      ],
    }),
    fixture({
      hash: "c".repeat(64),
      source: "/sources/alpha-three",
      session: "raw-session-alpha",
      startedAt: "2026-07-22T08:00:00Z",
      statements: [{ content: approval, at: "2026-07-22T08:01:00Z" }],
    }),
    fixture({
      hash: "d".repeat(64),
      source: "/sources/alpha-next-day",
      session: "raw-session-alpha",
      startedAt: "2026-07-23T08:00:00Z",
      statements: [{ content: approval, at: "2026-07-23T08:01:00Z" }],
    }),
    fixture({
      hash: "e".repeat(64),
      source: "/sources/beta",
      session: "raw-session-alpha",
      startedAt: "2026-07-22T09:00:00Z",
      provider: "other-provider",
      harness: "claude-code",
      statements: [{ content: approval, at: "2026-07-22T09:01:00Z" }],
    }),
    fixture({
      hash: "f".repeat(64),
      source: "/sources/ownership",
      session: "raw-session-ownership",
      startedAt: "2026-07-24T08:00:00Z",
      statements: [{ content: ownership, at: "2026-07-24T08:01:00Z" }],
    }),
    fixture({
      hash: "1".repeat(64),
      source: "/sources/relay",
      session: "raw-session-relay",
      startedAt: "2026-07-22T10:00:00Z",
      statements: [{
        content: `Context relay follows. <teammate-message teammate_id="worker">${approval}</teammate-message>`,
        at: "2026-07-22T10:01:00Z",
      }],
    }),
    fixture({
      hash: "2".repeat(64),
      source: "/sources/restored",
      session: "raw-session-restored",
      startedAt: "2026-07-22T11:00:00Z",
      statements: [{
        content: `This session is being continued from a previous conversation. ${approval}`,
        at: "2026-07-22T11:01:00Z",
      }],
    }),
  ];
  const toolFollower = fixture({
    hash: "3".repeat(64),
    source: "/sources/tool-follower",
    session: "raw-session-tool-follower",
    startedAt: "2026-07-22T12:00:00Z",
    statements: [],
  });
  toolFollower.turns.push(
    {
      role: "assistant",
      content: "",
      toolCalls: [{ name: "read" }],
      at: "2026-07-22T12:01:00Z",
    },
    { role: "user", content: approval, at: "2026-07-22T12:02:00Z" },
  );
  conversations.push(toolFollower);
  for (const conversation of conversations) await writeFixture(root, conversation);
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

  const first = await deriveWorkflowEvolution(root);
  const second = await deriveWorkflowEvolution(root);
  expect(first.processed).toBe(true);
  expect(second).toMatchObject({ processed: false, contentHash: first.contentHash });
  await unlink(join(root, "derived", "workflow-evolution-manifest.json"));
  const rebuilt = await deriveWorkflowEvolution(root);
  expect(rebuilt).toMatchObject({ processed: true, contentHash: first.contentHash });
  const artifactText = await readFile(first.artifactPath, "utf8");
  expect(
    new Bun.CryptoHasher("sha256").update(artifactText).digest("hex"),
  ).toBe(first.contentHash);

  const report = await loadWorkflowEvolution(root);
  expect(report.summary).toEqual({
    conversationsScanned: 9,
    operatorTurnsScanned: 18,
    candidateEvents: 9,
    uniqueEvents: 5,
    duplicateCopiesCollapsed: 3,
    episodes: 6,
    byKind: {
      "approval-gate-changed": 3,
      "autonomy-boundary": 1,
      "ownership-boundary": 1,
    },
  });
  const july22Alpha = report.events.find((event) =>
    event.kind === "approval-gate-changed"
    && event.occurredAt === "2026-07-22T08:01:00.000Z"
    && event.lineage.conversations === 3
  );
  expect(july22Alpha).toMatchObject({
    confidence: "explicit-instruction",
    lineage: {
      conversations: 3,
      duplicateCopiesCollapsed: 2,
      roles: ["manager"],
    },
    policyDelta: {
      retained: ["required verification remains in force"],
    },
  });
  expect(july22Alpha?.evidence).toHaveLength(3);
  expect(report.tracers.approvalGate?.occurredAt)
    .toBe("2026-07-23T08:01:00.000Z");
  expect(report.egress).toEqual(expect.objectContaining({
    performed: false,
    surface: "none",
    hostedCalls: 0,
  }));
  expect(artifactText).not.toContain("raw-session-");
  expect(artifactText).not.toContain("ephemeral-test-model");
  expect(artifactText).not.toContain("/sources/");
  for (const event of report.events) {
    expect(event.evidence.length).toBeGreaterThan(0);
    expect(event.evidence.length).toBeLessThanOrEqual(8);
    expect(event.lineage.episodeId).toMatch(/^[a-f0-9]{64}$/);
  }
});
