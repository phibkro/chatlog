import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openAnalysis, indexEventBatch } from "../src/analysis";
import {
  EVENT_ADAPTER_RECIPE,
  EVENT_CAPTURE_POLICY_VERSION,
  capture,
  makeObservedBatchOrigin,
  makeObservedEvent,
  makeObservedSource,
  type EventBatch,
} from "../src/events";
import {
  CLOSED_LOOP_EVALUATOR_ADAPTER_RECIPE,
  CLOSED_LOOP_EVALUATOR_SOURCE_KIND,
  type ClosedLoopCanonicalMetrics,
} from "../src/closed-loop-evaluation";
import {
  recordContextEvent,
  recordContextOutcome,
  readContextEvents,
  type ContextEventInput,
} from "../src/context-events";
import { persistEventBatch } from "../src/event-store";
import { openTestContextSession } from "./context-session-fixture";
const bundleHash = "c".repeat(64);

async function observedEvidence(
  root: string,
  contextSessionId: string,
  index: number,
  payload: Record<string, unknown>,
  actor: { kind: string; id?: string } = { kind: "provider", id: "evaluator" },
  scope: { project?: string; cwd?: string; sessionId?: string } = {},
  options: {
    kind?: "evaluation.recorded" | "message.created";
    sourceKind?: string;
    adapterRecipe?: string;
    occurredAt?: string;
    nativeSessionId?: string;
  } = {},
): Promise<string> {
  const sourceBase = {
    provider: "openai",
    harness: "codex",
    sourceKind: options.sourceKind ?? "outcome-evaluator",
    nativeSessionId: options.nativeSessionId ?? contextSessionId,
    sourcePath: `/outcome-evaluator-${index}.jsonl`,
    adapterRecipe: options.adapterRecipe ?? `${EVENT_ADAPTER_RECIPE}:outcome-test`,
    capturePolicyVersion: EVENT_CAPTURE_POLICY_VERSION,
  };
  const event = makeObservedEvent({
    kind: options.kind ?? "evaluation.recorded",
    sequence: 0,
    ...(options.occurredAt === undefined ? {} : { occurredAt: options.occurredAt }),
    actor,
    scope: { sessionId: contextSessionId, project: "/project", cwd: "/project", ...scope },
    source: makeObservedSource(
      {
        ...sourceBase,
        nativeItemId: `evaluation:${index}`,
        recordPosition: { record: 0 },
      },
      payload,
    ),
    payload,
    relations: {},
    capture: capture("normalized"),
  });
  const batch: EventBatch = {
    schemaVersion: 1,
    origin: makeObservedBatchOrigin(sourceBase, [event]),
    events: [event],
    semanticLoss: [],
    partialTail: false,
    sourceItemCount: 1,
  };
  const batchHash = await persistEventBatch(root, batch);
  const db = openAnalysis(join(root, "analysis", "chatlog.sqlite"));
  try {
    indexEventBatch(db, batch, batchHash);
  } finally {
    db.close();
  }
  return event.eventId;
}

function proposalInput(
  contextSessionId: string,
  overrides: Partial<ContextEventInput> = {},
): ContextEventInput {
  return {
    kind: "context.bundle.emitted",
    contextSessionId,
    idempotencyKey: "emitted-1",
    actor: { kind: "system", id: "delivery" },
    bundleHash,
    occurredAt: "2026-08-04T00:00:00.000Z",
    ...overrides,
  };
}

test("outcomes associate intervention lineage without asserting causation", async () => {
  const root = await mkdtemp(join(tmpdir(), "chatlog-outcomes-"));
  const session = await openTestContextSession(root, "outcome-lineage");
  const emitted = await recordContextEvent(root, proposalInput(session.contextSessionId));
  expect(emitted.ok).toBe(true);
  if (!emitted.ok) return;
  const evidenceId = await observedEvidence(root, session.contextSessionId, 1, {
    evaluationKind: "closed-loop-gate",
    gatePassed: true,
  });
  const outcome = await recordContextOutcome(root, {
    contextSessionId: session.contextSessionId,
    idempotencyKey: "outcome-1",
    actor: { kind: "provider", id: "gate" },
    interventionEventIds: [emitted.value.event.eventId],
    knownInterventionLineage: [emitted.value.event.eventId],
    evidenceGrade: "provider-observed",
    evidenceSource: "provider-gate",
    treatmentArm: "raw-evidence",
    status: "success",
    metrics: { tokensToGate: 42, gatePassed: true },
    unresolved: false,
    inputEventIds: [evidenceId],
    occurredAt: "2026-08-04T00:00:03.000Z",
  });
  expect(outcome.ok).toBe(true);
  const rows = await readContextEvents(root, {
    contextSessionId: session.contextSessionId,
    kinds: ["context.outcome.observed"],
  });
  expect(rows.ok).toBe(true);
  if (!rows.ok) return;
  expect(rows.value).toHaveLength(1);
  expect(rows.value[0]?.interventionEventIds).toEqual([emitted.value.event.eventId]);
  expect(rows.value[0]?.knownInterventionLineage).toEqual([emitted.value.event.eventId]);
  expect(rows.value[0]?.payload.association).toBe("intervention-lineage");
  expect(rows.value[0]?.payload.causalClaim).toBe(false);
  expect(rows.value[0]?.evidenceGrade).toBe("provider-observed");
  expect(rows.value[0]?.treatmentArm).toBe("raw-evidence");
  expect(rows.value[0]?.unresolved).toBe(false);
});

test("agent success text cannot become a gate observation", async () => {
  const root = await mkdtemp(join(tmpdir(), "chatlog-outcome-rejection-"));
  const session = await openTestContextSession(root, "outcome-agent-rejection");
  const result = await recordContextOutcome(root, {
    contextSessionId: session.contextSessionId,
    idempotencyKey: "agent-gate-success",
    actor: { kind: "assistant", id: "agent" },
    evidenceGrade: "gate-observed",
    evidenceSource: "agent-self-report",
    treatmentArm: "active-insight",
    status: "success",
    metrics: { text: "success" },
    unresolved: false,
  });
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.error.code).toBe("invalid-input");
  expect(result.error.message).toContain("trusted post-intervention evaluator evidence");
  const rows = await readContextEvents(root, { contextSessionId: session.contextSessionId });
  expect(rows.ok).toBe(true);
  if (!rows.ok) return;
  expect(rows.value).toHaveLength(0);
});

const GATE_METRICS = {
  gatePassed: true,
  userCorrections: 0,
  rederivationCount: 1,
  tokensToGate: 700,
  unresolved: false,
} as const;

interface GateRejectionVariant {
  readonly kind?: "evaluation.recorded" | "message.created";
  readonly sourceKind?: string;
  readonly adapterRecipe?: string;
  readonly actor: { readonly kind: string; readonly id: string };
  readonly occurredAt?: string;
  readonly evidenceMetrics: ClosedLoopCanonicalMetrics;
  readonly requestedMetrics: ClosedLoopCanonicalMetrics;
}

const GATE_REJECTIONS: ReadonlyArray<readonly [string, GateRejectionVariant]> = [
  [
    "ordinary message evidence",
    {
      kind: "message.created" as const,
      sourceKind: CLOSED_LOOP_EVALUATOR_SOURCE_KIND,
      adapterRecipe: CLOSED_LOOP_EVALUATOR_ADAPTER_RECIPE,
      actor: { kind: "system", id: "evaluator" },
      occurredAt: "2026-08-04T00:00:03.000Z",
      evidenceMetrics: GATE_METRICS,
      requestedMetrics: GATE_METRICS,
    },
  ],
  [
    "imported evaluator claims",
    {
      actor: { kind: "system", id: "evaluator" },
      occurredAt: "2026-08-04T00:00:03.000Z",
      evidenceMetrics: GATE_METRICS,
      requestedMetrics: GATE_METRICS,
    },
  ],
  [
    "provider self-claims",
    {
      sourceKind: CLOSED_LOOP_EVALUATOR_SOURCE_KIND,
      adapterRecipe: CLOSED_LOOP_EVALUATOR_ADAPTER_RECIPE,
      actor: { kind: "provider", id: "evaluator" },
      occurredAt: "2026-08-04T00:00:03.000Z",
      evidenceMetrics: GATE_METRICS,
      requestedMetrics: GATE_METRICS,
    },
  ],
  [
    "pre-intervention evidence",
    {
      sourceKind: CLOSED_LOOP_EVALUATOR_SOURCE_KIND,
      adapterRecipe: CLOSED_LOOP_EVALUATOR_ADAPTER_RECIPE,
      actor: { kind: "system", id: "evaluator" },
      occurredAt: "2026-08-04T00:00:01.000Z",
      evidenceMetrics: GATE_METRICS,
      requestedMetrics: GATE_METRICS,
    },
  ],
  [
    "unknown-time evidence",
    {
      sourceKind: CLOSED_LOOP_EVALUATOR_SOURCE_KIND,
      adapterRecipe: CLOSED_LOOP_EVALUATOR_ADAPTER_RECIPE,
      actor: { kind: "system", id: "evaluator" },
      evidenceMetrics: GATE_METRICS,
      requestedMetrics: GATE_METRICS,
    },
  ],
  [
    "mismatched evaluator metrics",
    {
      sourceKind: CLOSED_LOOP_EVALUATOR_SOURCE_KIND,
      adapterRecipe: CLOSED_LOOP_EVALUATOR_ADAPTER_RECIPE,
      actor: { kind: "system", id: "evaluator" },
      occurredAt: "2026-08-04T00:00:03.000Z",
      evidenceMetrics: GATE_METRICS,
      requestedMetrics: { ...GATE_METRICS, rederivationCount: 2 },
    },
  ],
];

test.each(GATE_REJECTIONS)("gate-observed success rejects %s", async (_label, variant) => {
  const root = await mkdtemp(join(tmpdir(), "chatlog-outcome-gate-authority-"));
  const session = await openTestContextSession(root, `gate-authority-${_label}`);
  const emitted = await recordContextEvent(
    root,
    proposalInput(session.contextSessionId, {
      idempotencyKey: `emitted-${_label}`,
      occurredAt: "2026-08-04T00:00:02.000Z",
    }),
  );
  if (!emitted.ok) throw new Error(emitted.error.message);
  const evidenceId = await observedEvidence(
    root,
    session.contextSessionId,
    100,
    { evaluationKind: "closed-loop-gate", metrics: variant.evidenceMetrics },
    variant.actor,
    {},
    {
      kind: variant.kind,
      sourceKind: variant.sourceKind,
      adapterRecipe: variant.adapterRecipe,
      occurredAt: variant.occurredAt,
    },
  );
  const outcome = await recordContextOutcome(root, {
    contextSessionId: session.contextSessionId,
    idempotencyKey: `outcome-${_label}`,
    actor: { kind: "tool", id: "gate-recorder" },
    actorAuthority: "tool",
    interventionEventIds: [emitted.value.event.eventId],
    evidenceGrade: "gate-observed",
    treatmentArm: "active-insight",
    status: "success",
    metrics: { ...variant.requestedMetrics },
    unresolved: false,
    inputEventIds: [evidenceId],
  });
  expect(outcome).toMatchObject({
    ok: false,
    error: {
      code: "invalid-input",
      message:
        "gate-observed success requires trusted post-intervention evaluator evidence with matching canonical metrics",
    },
  });
});

test("canonical outcome evidence must match the exact session project and cwd", async () => {
  const root = await mkdtemp(join(tmpdir(), "chatlog-outcome-scope-"));
  const session = await openTestContextSession(root, "outcome-scope");
  const evidenceId = await observedEvidence(
    root,
    session.contextSessionId,
    20,
    { evaluationKind: "closed-loop-gate", gatePassed: true },
    { kind: "provider", id: "evaluator" },
    { project: "/other-project", cwd: "/other-project" },
  );
  const outcome = await recordContextOutcome(root, {
    contextSessionId: session.contextSessionId,
    idempotencyKey: "outcome-wrong-scope",
    actor: { kind: "provider", id: "gate" },
    evidenceGrade: "provider-observed",
    evidenceSource: "provider-gate",
    treatmentArm: "raw-evidence",
    status: "success",
    metrics: { gatePassed: true },
    unresolved: false,
    inputEventIds: [evidenceId],
  });
  expect(outcome).toMatchObject({
    ok: false,
    error: { code: "invalid-input" },
  });
});
test("caller repetition flags cannot promote repeated canonical evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "chatlog-outcome-repetition-"));
  const session = await openTestContextSession(root, "outcome-repetition");
  const emitted = await recordContextEvent(
    root,
    proposalInput(session.contextSessionId, {
      idempotencyKey: "emitted-repeat",
      contentHash: "e".repeat(64),
    }),
  );
  expect(emitted.ok).toBe(true);
  if (!emitted.ok) return;
  const evidenceId = await observedEvidence(root, session.contextSessionId, 2, {
    evaluationKind: "closed-loop-gate",
    contentHash: "e".repeat(64),
  });
  const outcome = await recordContextOutcome(root, {
    contextSessionId: session.contextSessionId,
    idempotencyKey: "outcome-repeat",
    actor: { kind: "provider", id: "gate" },
    interventionEventIds: [emitted.value.event.eventId],
    evidenceGrade: "provider-observed",
    treatmentArm: "active-insight",
    status: "success",
    metrics: { repeated: true },
    unresolved: true,
    postInterventionRepetition: false,
    repeatedInjectedProposition: false,
    repetitionOfInjectedProposition: false,
    inputEventIds: [evidenceId],
  });
  expect(outcome.ok).toBe(true);
  const rows = await readContextEvents(root, { contextSessionId: session.contextSessionId });
  expect(rows.ok).toBe(true);
  if (!rows.ok) return;
  const row = rows.value.find((item) => item.kind === "context.outcome.observed");
  expect(row?.evidenceClassification).toBe("non-independent-repetition");
  expect(row?.payload.causalClaim).toBe(false);
  expect(row?.unresolved).toBe(true);
});

test("outcome rejects missing and cross-session source events", async () => {
  const root = await mkdtemp(join(tmpdir(), "chatlog-outcome-source-bound-"));
  const session = await openTestContextSession(root, "outcome-source-bound");
  const missing = await recordContextOutcome(root, {
    contextSessionId: session.contextSessionId,
    idempotencyKey: "outcome-missing-source",
    actor: { kind: "provider", id: "gate" },
    evidenceGrade: "provider-observed",
    treatmentArm: "raw-evidence",
    status: "success",
    metrics: {},
    unresolved: false,
    inputEventIds: ["d".repeat(64)],
  });
  expect(missing.ok).toBe(false);
  if (!missing.ok) expect(missing.error.message).toContain("does not exist");

  const other = await openTestContextSession(root, "outcome-cross-source");
  const sourceId = await observedEvidence(root, other.contextSessionId, 3, {
    evaluationKind: "closed-loop-gate",
  });
  const cross = await recordContextOutcome(root, {
    contextSessionId: session.contextSessionId,
    idempotencyKey: "outcome-cross-source",
    actor: { kind: "provider", id: "gate" },
    evidenceGrade: "provider-observed",
    treatmentArm: "raw-evidence",
    status: "success",
    metrics: {},
    unresolved: false,
    inputEventIds: [sourceId],
  });
  expect(cross.ok).toBe(false);
  if (!cross.ok)
    expect(cross.error.message).toContain("lacks allowed same-session observed provenance");

  const forgedNativeBinding = await observedEvidence(
    root,
    other.contextSessionId,
    4,
    { evaluationKind: "closed-loop-gate" },
    { kind: "provider", id: "evaluator" },
    {},
    { nativeSessionId: session.nativeSessionId ?? undefined },
  );
  const forged = await recordContextOutcome(root, {
    contextSessionId: session.contextSessionId,
    idempotencyKey: "outcome-forged-native-binding",
    actor: { kind: "provider", id: "gate" },
    evidenceGrade: "provider-observed",
    treatmentArm: "raw-evidence",
    status: "success",
    metrics: {},
    unresolved: false,
    inputEventIds: [forgedNativeBinding],
  });
  expect(forged.ok).toBe(false);
  if (!forged.ok)
    expect(forged.error.message).toContain("lacks allowed same-session observed provenance");
});
