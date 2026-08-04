import { expect, test } from "bun:test";
import { join } from "node:path";
import {
  evaluateProcedureTransfer,
  type ProcedureTransferEvaluation,
  type ProcedureTransferEvaluationInput,
  type ProcedureTransferMetrics,
} from "../src/procedure-transfer-evaluation";

const HASH = "a".repeat(64);

function metrics(overrides: Partial<ProcedureTransferMetrics> = {}): ProcedureTransferMetrics {
  return {
    gatePassed: true,
    recognizedPreconditions: 1,
    totalPreconditions: 2,
    repeatedExploration: 2,
    toolCalls: 6,
    tokens: 2_000,
    latencyMs: 1_000,
    corrections: 0,
    environmentMistakes: 0,
    ...overrides,
  };
}

function input(
  procedure: Partial<ProcedureTransferMetrics> = {},
): ProcedureTransferEvaluationInput {
  return {
    schemaVersion: 1,
    evaluationId: "procedure-transfer-1",
    scoringRule: "chatlog/procedure-transfer-v1",
    sourceHashes: [HASH],
    taskIds: ["claude-router-task", "codex-router-task"],
    source: { provider: "anthropic", harness: "claude-code" },
    target: { provider: "openai", harness: "codex" },
    arms: {
      noMemory: metrics(),
      evidenceOnly: metrics({ recognizedPreconditions: 2, repeatedExploration: 1, toolCalls: 5 }),
      procedure: metrics({
        recognizedPreconditions: 2,
        repeatedExploration: 0,
        toolCalls: 3,
        tokens: 1_400,
        latencyMs: 800,
        ...procedure,
      }),
    },
  };
}

test("keeps a source-bound procedure when transfer improves a declared measure without regression", () => {
  const result = evaluateProcedureTransfer(input());
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.value.recommendation).toBe("keep");
  expect(result.value.improved).toContain("repeated-exploration");
  expect(result.value.artifactHash).toHaveLength(64);
  expect(result.value.source).toEqual({ provider: "anthropic", harness: "claude-code" });
  expect(result.value.target).toEqual({ provider: "openai", harness: "codex" });
});

test("adapts a useful procedure that causes environment-specific mistakes", () => {
  const result = evaluateProcedureTransfer(input({ environmentMistakes: 1 }));
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.value.recommendation).toBe("adapt");
  expect(result.value.regressions).toContain("environment-mistakes");
});

test("rejects transfer when the procedure arm fails the task gate", () => {
  const result = evaluateProcedureTransfer(input({ gatePassed: false }));
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.value.recommendation).toBe("reject");
  expect(result.value.regressions).toContain("task-gate");
});

test("rejects malformed or undeclared evaluation inputs", () => {
  const result = evaluateProcedureTransfer({ ...input(), scoringRule: "post-hoc-rule" });
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.error.code).toBe("invalid-evaluation");
});

test("rejects a same-provider same-harness transfer claim", () => {
  const result = evaluateProcedureTransfer({
    ...input(),
    target: { provider: "anthropic", harness: "claude-code" },
  });
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.error.message).toContain("cross a provider or harness boundary");
});

test("replays the synthetic multi-provider keep, adapt, and reject pilot", async () => {
  const pilot = (await Bun.file(
    join(import.meta.dir, "../eval/procedure-transfer-pilot/eval.json"),
  ).json()) as {
    synthetic: boolean;
    hostedCalls: number;
    journeys: Array<{
      input: ProcedureTransferEvaluationInput;
      expected: Pick<
        ProcedureTransferEvaluation,
        "recommendation" | "improved" | "regressions" | "artifactHash"
      >;
    }>;
  };
  expect(pilot.synthetic).toBe(true);
  expect(pilot.hostedCalls).toBe(0);
  expect(pilot.journeys).toHaveLength(3);
  for (const journey of pilot.journeys) {
    const result = evaluateProcedureTransfer(journey.input);
    expect(result.ok).toBe(true);
    if (!result.ok) continue;
    expect({
      recommendation: result.value.recommendation,
      improved: result.value.improved,
      regressions: result.value.regressions,
      artifactHash: result.value.artifactHash,
    }).toEqual(journey.expected);
  }
});
