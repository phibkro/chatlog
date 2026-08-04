import { expect, test } from "bun:test";
import {
  verifyClosedLoopGate,
  type ClosedLoopEvidenceObservation,
  type ClosedLoopRecommendation,
  type ClosedLoopGateArtifact,
  type ClosedLoopRun,
} from "../src/closed-loop-gate";
import {
  CLOSED_LOOP_EVALUATOR_ADAPTER_RECIPE,
  CLOSED_LOOP_EVALUATOR_SOURCE_KIND,
} from "../src/closed-loop-evaluation";

const HASH = (digit: string): string => digit.repeat(64);

function reference(batch: string, event: string) {
  return { batchHash: HASH(batch), eventId: HASH(event) };
}

const artifact: ClosedLoopGateArtifact = {
  schema: "chatlog/closed-loop-gate-v1",
  evaluationId: "limited-insight-crossover-1",
  stage: "limited-insight",
  candidate: { id: "insight-1", contentHash: HASH("a") },
  pairs: ["one", "two", "three"].map((pairId, index) => ({
    pairId,
    control: {
      arm: "no-memory",
      contextSessionId: HASH(String(index + 1)),
      intervention: null,
      outcome: reference("b", String(index + 4)),
      gatePassed: true,
      userCorrections: 1,
      rederivationCount: 3,
      tokensToGate: 1_000,
      unresolved: false,
    },
    treatment: {
      arm: "active-insight",
      contextSessionId: HASH(String(index + 7)),
      intervention: reference("c", String(index + 1)),
      outcome: reference("d", String(index + 4)),
      gatePassed: true,
      userCorrections: 0,
      rederivationCount: 1,
      tokensToGate: 700,
      unresolved: false,
    },
  })),
  findings: { harmfulScope: [], staleContext: [] },
  recommendation: "keep",
  review: {
    kind: "human-review",
    actor: "operator",
    reviewedAt: "2026-08-03T12:00:00.000Z",
  },
};

function observation(
  pointer: { batchHash: string; eventId: string },
  kind: ClosedLoopEvidenceObservation["kind"],
  contextSessionId: string,
  run: ClosedLoopRun | null,
  candidate: ClosedLoopGateArtifact["candidate"],
): ClosedLoopEvidenceObservation {
  const metrics = run
    ? {
        gatePassed: run.gatePassed,
        userCorrections: run.userCorrections,
        rederivationCount: run.rederivationCount,
        tokensToGate: run.tokensToGate,
        unresolved: run.unresolved,
      }
    : null;
  const source = {
    pointer: reference("e", pointer.eventId.slice(0, 1)),
    kind: "evaluation.recorded" as const,
    contextSessionId,
    originKind: "observed" as const,
    captureDisposition: "normalized" as const,
    actorKind: "system",
    sourceKind: CLOSED_LOOP_EVALUATOR_SOURCE_KIND,
    adapterRecipe: CLOSED_LOOP_EVALUATOR_ADAPTER_RECIPE,
    recordedAt: "2026-08-04T00:00:02.000Z",
    metrics,
  };
  return {
    pointer,
    kind,
    contextSessionId,
    evidenceGrade: run ? "gate-observed" : null,
    originKind: "chatlog",
    captureDisposition: "normalized",
    actorKind: "provider",
    recordedAt: run ? "2026-08-04T00:00:03.000Z" : "2026-08-04T00:00:01.000Z",
    metrics,
    interventionId: run ? (run.intervention?.eventId ?? null) : null,
    inputEventIds: run ? [source.pointer.eventId] : [],
    sources: run ? [source] : [],
    candidateId: run ? null : candidate.id,
    candidateContentHash: run ? null : candidate.contentHash,
  };
}

function evidenceResolver(input: ClosedLoopGateArtifact, canonical = input) {
  const observations = new Map<string, ClosedLoopEvidenceObservation>();
  for (const [index, pair] of input.pairs.entries()) {
    const canonicalPair = canonical.pairs[index]!;
    observations.set(
      `${pair.control.outcome.batchHash}:${pair.control.outcome.eventId}`,
      observation(
        pair.control.outcome,
        "context.outcome.observed",
        canonicalPair.control.contextSessionId,
        canonicalPair.control,
        canonical.candidate,
      ),
    );
    observations.set(
      `${pair.treatment.intervention!.batchHash}:${pair.treatment.intervention!.eventId}`,
      observation(
        pair.treatment.intervention!,
        "context.bundle.emitted",
        canonicalPair.treatment.contextSessionId,
        null,
        canonical.candidate,
      ),
    );
    observations.set(
      `${pair.treatment.outcome.batchHash}:${pair.treatment.outcome.eventId}`,
      observation(
        pair.treatment.outcome,
        "context.outcome.observed",
        canonicalPair.treatment.contextSessionId,
        canonicalPair.treatment,
        canonical.candidate,
      ),
    );
  }
  return async (pointer: { batchHash: string; eventId: string }) => {
    const found = observations.get(`${pointer.batchHash}:${pointer.eventId}`);
    return found
      ? { ok: true as const, value: found }
      : { ok: false as const, error: "missing event" };
  };
}

test("a source-bound crossover with no regression and lower rederivation passes the keep gate", async () => {
  const result = await verifyClosedLoopGate(artifact, evidenceResolver(artifact));
  if (!result.ok) throw new Error(JSON.stringify(result.error));

  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.value.verdict).toBe("keep");
  expect(result.value.metrics.gateRegression).toBe(false);
  expect(result.value.metrics.correctionRegression).toBe(false);
  expect(result.value.metrics.rederivationImproved).toBe(true);
  expect(result.value.metrics.tokensImproved).toBe(true);
});

test.each([
  [
    "revise",
    {
      ...artifact,
      pairs: artifact.pairs.map((pair, index) =>
        index === 0 ? { ...pair, treatment: { ...pair.treatment, gatePassed: false } } : pair,
      ),
      recommendation: "revise",
    },
  ],
  [
    "retire",
    {
      ...artifact,
      findings: {
        ...artifact.findings,
        harmfulScope: [artifact.pairs[0]!.treatment.outcome],
      },
      recommendation: "retire",
    },
  ],
  [
    "inconclusive",
    {
      ...artifact,
      pairs: artifact.pairs.map((pair) => ({
        ...pair,
        treatment: {
          ...pair.treatment,
          rederivationCount: pair.control.rederivationCount,
          tokensToGate: pair.control.tokensToGate,
        },
      })),
      recommendation: "inconclusive",
    },
  ],
] satisfies ReadonlyArray<readonly [ClosedLoopRecommendation, ClosedLoopGateArtifact]>)(
  "returns the source-bound %s verdict when metrics require it",
  async (expected, input) => {
    const result = await verifyClosedLoopGate(input, evidenceResolver(input));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.verdict).toBe(expected);
  },
);

test("rejects a reviewed recommendation that contradicts the source-bound metrics", async () => {
  const input: ClosedLoopGateArtifact = {
    ...artifact,
    pairs: artifact.pairs.map((pair, index) =>
      index === 0 ? { ...pair, treatment: { ...pair.treatment, gatePassed: false } } : pair,
    ),
  };
  const result = await verifyClosedLoopGate(input, evidenceResolver(input));
  expect(result).toMatchObject({ ok: false, error: { code: "invalid-gate" } });
});

test("rejects a keep artifact that invents improved canonical metrics", async () => {
  const fabricated: ClosedLoopGateArtifact = {
    ...artifact,
    pairs: artifact.pairs.map((pair) => ({
      ...pair,
      treatment: {
        ...pair.treatment,
        userCorrections: 0,
        rederivationCount: 0,
        tokensToGate: 1,
      },
    })),
  };
  const result = await verifyClosedLoopGate(fabricated, evidenceResolver(fabricated, artifact));
  expect(result).toMatchObject({ ok: false, error: { code: "invalid-gate" } });
});

test("rejects reused evidence pointers across paired runs", async () => {
  const duplicated: ClosedLoopGateArtifact = {
    ...artifact,
    pairs: artifact.pairs.map((pair, index) =>
      index === 1
        ? {
            ...pair,
            treatment: {
              ...pair.treatment,
              outcome: artifact.pairs[0]!.treatment.outcome,
            },
          }
        : pair,
    ),
  };
  const result = await verifyClosedLoopGate(duplicated, evidenceResolver(duplicated));
  expect(result).toMatchObject({ ok: false, error: { code: "invalid-gate" } });
});

test("rejects a treatment intervention without exact candidate content lineage", async () => {
  const target = artifact.pairs[0]!.treatment.intervention!;
  const resolver = evidenceResolver(artifact);
  const result = await verifyClosedLoopGate(artifact, async (pointer) => {
    const resolved = await resolver(pointer);
    if (resolved.ok && pointer.batchHash === target.batchHash && pointer.eventId === target.eventId)
      return {
        ok: true as const,
        value: { ...resolved.value, candidateContentHash: null },
      };
    return resolved;
  });
  expect(result).toMatchObject({ ok: false, error: { code: "invalid-gate" } });
});
test("rejects an outcome event used as a treatment intervention", async () => {
  const target = artifact.pairs[0]!.treatment.intervention!;
  const resolver = evidenceResolver(artifact);
  const result = await verifyClosedLoopGate(artifact, async (pointer) => {
    const resolved = await resolver(pointer);
    if (resolved.ok && pointer.batchHash === target.batchHash && pointer.eventId === target.eventId)
      return {
        ok: true as const,
        value: { ...resolved.value, kind: "context.outcome.observed" as const },
      };
    return resolved;
  });
  expect(result).toMatchObject({ ok: false, error: { code: "invalid-gate" } });
});
test("rejects outcome evidence from a different context session", async () => {
  const target = artifact.pairs[0]!.control.outcome;
  const resolver = evidenceResolver(artifact);
  const result = await verifyClosedLoopGate(artifact, async (pointer) => {
    const resolved = await resolver(pointer);
    if (resolved.ok && pointer.batchHash === target.batchHash && pointer.eventId === target.eventId)
      return {
        ok: true as const,
        value: { ...resolved.value, contextSessionId: HASH("f") },
      };
    return resolved;
  });
  expect(result).toMatchObject({ ok: false, error: { code: "invalid-gate" } });
});
test("rejects evidence returned for a different pointer", async () => {
  const target = artifact.pairs[0]!.control.outcome;
  const resolver = evidenceResolver(artifact);
  const result = await verifyClosedLoopGate(artifact, async (pointer) => {
    const resolved = await resolver(pointer);
    if (resolved.ok && pointer.batchHash === target.batchHash && pointer.eventId === target.eventId)
      return {
        ok: true as const,
        value: { ...resolved.value, pointer: reference("f", "f") },
      };
    return resolved;
  });
  expect(result).toMatchObject({ ok: false, error: { code: "invalid-gate" } });
});

test.each([
  [
    "ordinary source kind",
    (source: ClosedLoopEvidenceObservation["sources"][number]) => ({
      ...source,
      kind: "message.created" as const,
    }),
  ],
  [
    "provider self-claim",
    (source: ClosedLoopEvidenceObservation["sources"][number]) => ({
      ...source,
      actorKind: "provider",
    }),
  ],
  [
    "unknown evaluator time",
    (source: ClosedLoopEvidenceObservation["sources"][number]) => ({
      ...source,
      recordedAt: null,
    }),
  ],
  [
    "mismatched evaluator metrics",
    (source: ClosedLoopEvidenceObservation["sources"][number]) => ({
      ...source,
      metrics: source.metrics ? { ...source.metrics, rederivationCount: 99 } : null,
    }),
  ],
])("rejects gate outcomes backed by %s", async (_label, mutateSource) => {
  const target = artifact.pairs[0]!.treatment.outcome;
  const resolver = evidenceResolver(artifact);
  const result = await verifyClosedLoopGate(artifact, async (pointer) => {
    const resolved = await resolver(pointer);
    if (resolved.ok && pointer.batchHash === target.batchHash && pointer.eventId === target.eventId)
      return {
        ok: true as const,
        value: {
          ...resolved.value,
          sources: resolved.value.sources.map((source) => mutateSource(source)),
        },
      };
    return resolved;
  });
  expect(result).toMatchObject({ ok: false, error: { code: "invalid-gate" } });
});

test("rejects mismatched treatment outcome intervention lineage", async () => {
  const resolver = evidenceResolver(artifact);
  const result = await verifyClosedLoopGate(artifact, async (pointer) => {
    const resolved = await resolver(pointer);
    if (resolved.ok && pointer.eventId === artifact.pairs[0]!.treatment.outcome.eventId)
      return {
        ok: true as const,
        value: { ...resolved.value, interventionId: "f".repeat(64) },
      };
    return resolved;
  });
  expect(result).toMatchObject({ ok: false, error: { code: "invalid-gate" } });
});

test("rejects a treatment session that differs from canonical evidence", async () => {
  const mismatched: ClosedLoopGateArtifact = {
    ...artifact,
    pairs: artifact.pairs.map((pair, index) =>
      index === 0
        ? {
            ...pair,
            treatment: { ...pair.treatment, contextSessionId: HASH("f") },
          }
        : pair,
    ),
  };
  const result = await verifyClosedLoopGate(mismatched, evidenceResolver(mismatched, artifact));
  expect(result).toMatchObject({ ok: false, error: { code: "invalid-gate" } });
});
