import { join } from "node:path";
import type { ClosedLoopGateArtifact } from "../src/closed-loop-gate";
import { openAnalysis, indexEventBatch } from "../src/analysis";
import { openTestContextSession } from "./context-session-fixture";
import { recordContextEvent, recordContextOutcome } from "../src/context-events";
import {
  CLOSED_LOOP_EVALUATOR_ADAPTER_RECIPE,
  CLOSED_LOOP_EVALUATOR_SOURCE_KIND,
} from "../src/closed-loop-evaluation";
import {
  EVENT_CAPTURE_POLICY_VERSION,
  capture,
  makeObservedBatchOrigin,
  makeObservedEvent,
  sha256,
  makeObservedSource,
  type EventBatch,
} from "../src/events";
import { persistEventBatch } from "../src/event-store";
const BUNDLE_HASH = "a".repeat(64);

async function observedEvaluatorEvent(
  root: string,
  contextSessionId: string,
  index: number,
  sourceSessionId = contextSessionId,
  metrics: {
    gatePassed: boolean;
    userCorrections: number;
    rederivationCount: number;
    tokensToGate: number | null;
    unresolved: boolean;
  },
  occurredAt: string,
): Promise<{ eventId: string; batchHash: string }> {
  const source = {
    provider: "openai",
    harness: "codex",
    sourceKind: CLOSED_LOOP_EVALUATOR_SOURCE_KIND,
    nativeSessionId: sourceSessionId,
    sourcePath: `/gate-evaluator-${index}.jsonl`,
    recordPosition: { record: 0 },
    adapterRecipe: CLOSED_LOOP_EVALUATOR_ADAPTER_RECIPE,
    capturePolicyVersion: EVENT_CAPTURE_POLICY_VERSION,
  };
  const event = makeObservedEvent({
    kind: "evaluation.recorded",
    sequence: 0,
    occurredAt,
    actor: { kind: "system", id: "closed-loop-evaluator" },
    scope: { sessionId: contextSessionId, project: "/project", cwd: "/project" },
    source: makeObservedSource(source, {
      contextSessionId: sourceSessionId,
      index,
      outcome: "success",
      metrics,
    }),
    relations: {},
    payload: {
      contextSessionId,
      evaluationKind: "closed-loop-gate",
      index,
      metrics,
    },
    capture: capture("normalized"),
  });
  const batch: EventBatch = {
    schemaVersion: 1,
    origin: makeObservedBatchOrigin(source, [event]),
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
  return { eventId: event.eventId, batchHash };
}

export async function sourceBoundKeepGate(
  root: string,
  candidateId = "candidate-1",
  contentHash = "b".repeat(64),
  nativeSessionBindings = false,
): Promise<ClosedLoopGateArtifact> {
  const gateKey = sha256(`${candidateId}\u0000${contentHash}`).slice(0, 16);
  const pairs: ClosedLoopGateArtifact["pairs"] = [];
  for (let index = 0; index < 3; index++) {
    const controlNonce = `gate-control-${gateKey}-${index}`;
    const treatmentNonce = `gate-treatment-${gateKey}-${index}`;
    const controlSession = await openTestContextSession(
      root,
      controlNonce,
      nativeSessionBindings ? `native-${controlNonce}` : null,
    );
    const treatmentSession = await openTestContextSession(
      root,
      treatmentNonce,
      nativeSessionBindings ? `native-${treatmentNonce}` : null,
    );
    const controlEvidence = await observedEvaluatorEvent(
      root,
      controlSession.contextSessionId,
      index * 2,
      controlSession.nativeSessionId ?? controlSession.contextSessionId,
      {
        gatePassed: true,
        userCorrections: 1,
        rederivationCount: 3,
        tokensToGate: 1_000,
        unresolved: false,
      },
      `2026-08-04T00:00:0${index + 1}.000Z`,
    );
    const treatmentEvidence = await observedEvaluatorEvent(
      root,
      treatmentSession.contextSessionId,
      index * 2 + 1,
      treatmentSession.nativeSessionId ?? treatmentSession.contextSessionId,
      {
        gatePassed: true,
        userCorrections: 0,
        rederivationCount: 1,
        tokensToGate: 700,
        unresolved: false,
      },
      `2026-08-04T00:00:2${index + 1}.000Z`,
    );
    const treatmentIntervention = await recordContextEvent(root, {
      kind: "context.bundle.emitted",
      contextSessionId: treatmentSession.contextSessionId,
      idempotencyKey: `treatment-intervention-${gateKey}-${index}`,
      actor: { kind: "system", id: "context-plane" },
      bundleHash: BUNDLE_HASH,
      occurredAt: `2026-08-04T00:00:1${index + 1}.000Z`,
      itemId: candidateId,
      candidateContentHash: contentHash,
    });
    if (!treatmentIntervention.ok) throw new Error(JSON.stringify(treatmentIntervention.error));
    const controlOutcome = await recordContextOutcome(root, {
      contextSessionId: controlSession.contextSessionId,
      idempotencyKey: `control-outcome-${gateKey}-${index}`,
      actor: { kind: "provider", id: "gate" },
      evidenceGrade: "gate-observed",
      evidenceSource: "provider-gate",
      treatmentArm: "no-memory",
      status: "success",
      metrics: {
        gatePassed: true,
        userCorrections: 1,
        rederivationCount: 3,
        tokensToGate: 1_000,
        unresolved: false,
      },
      unresolved: false,
      inputEventIds: [controlEvidence.eventId],
    });
    const treatmentOutcome = await recordContextOutcome(root, {
      contextSessionId: treatmentSession.contextSessionId,
      idempotencyKey: `treatment-outcome-${gateKey}-${index}`,
      actor: { kind: "provider", id: "gate" },
      interventionEventIds: [treatmentIntervention.value.event.eventId],
      knownInterventionLineage: [treatmentIntervention.value.event.eventId],
      evidenceGrade: "gate-observed",
      evidenceSource: "provider-gate",
      treatmentArm: "active-insight",
      status: "success",
      metrics: {
        gatePassed: true,
        userCorrections: 0,
        rederivationCount: 1,
        tokensToGate: 700,
        unresolved: false,
      },
      unresolved: false,
      inputEventIds: [treatmentEvidence.eventId],
    });
    if (!controlOutcome.ok || !treatmentOutcome.ok)
      throw new Error(
        JSON.stringify({
          control: controlOutcome.ok ? null : controlOutcome.error,
          treatment: treatmentOutcome.ok ? null : treatmentOutcome.error,
        }),
      );
    pairs.push({
      pairId: `pair-${index}`,
      control: {
        arm: "no-memory",
        contextSessionId: controlSession.contextSessionId,
        intervention: null,
        outcome: {
          eventId: controlOutcome.value.event.eventId,
          batchHash: controlOutcome.value.batchHash,
        },
        gatePassed: true,
        userCorrections: 1,
        rederivationCount: 3,
        tokensToGate: 1_000,
        unresolved: false,
      },
      treatment: {
        arm: "active-insight",
        contextSessionId: treatmentSession.contextSessionId,
        intervention: {
          eventId: treatmentIntervention.value.event.eventId,
          batchHash: treatmentIntervention.value.batchHash,
        },
        outcome: {
          eventId: treatmentOutcome.value.event.eventId,
          batchHash: treatmentOutcome.value.batchHash,
        },
        gatePassed: true,
        userCorrections: 0,
        rederivationCount: 1,
        tokensToGate: 700,
        unresolved: false,
      },
    });
  }
  return {
    schema: "chatlog/closed-loop-gate-v1",
    evaluationId: `operator-release-${candidateId}`,
    stage: "limited-insight",
    candidate: { id: candidateId, contentHash },
    pairs,
    findings: { harmfulScope: [], staleContext: [] },
    recommendation: "keep",
    review: {
      kind: "human-review",
      actor: "operator",
      reviewedAt: "2026-08-03T12:00:00.000Z",
    },
  };
}
