import {
  CONTEXT_POLICY_HASH,
  contextPolicyInputHash,
  evaluateContextCandidate,
  validateContextRequest,
} from "./context-policy";
import {
  CONTEXT_SCHEMA_VERSION,
  type ContextBundle,
  type ContextCandidate,
  type ContextPlanResult,
  type ContextRequest,
  type ContextSession,
} from "./context-types";
import { sha256, stableStringify } from "./events";

function policyHash(session: ContextSession): string {
  return sha256(
    stableStringify({
      corePolicyHash: CONTEXT_POLICY_HASH,
      selectionPolicyVersion: session.selectionPolicyVersion,
      deliveryPolicyVersion: session.deliveryPolicyVersion,
    }),
  );
}

export function planContext(
  request: ContextRequest,
  session: ContextSession,
  candidates: readonly ContextCandidate[],
): ContextPlanResult {
  const validated = validateContextRequest(request, session);
  if (!validated.ok) return { ok: false, error: validated };

  const availableTokens = Math.min(
    session.budget.remaining.tokens,
    request.budget.tokens,
    request.capabilities.maximumContextTokens,
  );
  const availableResults = Math.min(session.budget.remaining.results, request.budget.results);
  const availableLatency = Math.min(session.budget.remaining.latencyMs, request.budget.latencyMs);
  const availableCost = Math.min(session.budget.remaining.costUsd, request.budget.costUsd);
  const fixedTokens = request.fixedInstructionTokens + request.capabilities.encodingOverheadTokens;
  if (fixedTokens > availableTokens || availableResults < 1)
    return {
      ok: false,
      error: {
        code: "budget-exhausted",
        message: "context session has no budget for this request",
      },
    };

  let usedTokens = fixedTokens;
  let usedResults = 0;
  let usedLatency = 0;
  let usedCost = 0;
  const items: ContextBundle["items"] = [];
  const omissions: ContextBundle["omissions"] = [];
  const ordered = [...candidates].toSorted(
    (left, right) => right.scores.total - left.scores.total || left.id.localeCompare(right.id),
  );
  for (const candidate of ordered) {
    const policy = evaluateContextCandidate(candidate, request);
    if (!policy.allowed) {
      omissions.push({ itemId: candidate.id, reason: policy.reason });
      continue;
    }
    if (usedResults + 1 > availableResults) {
      omissions.push({ itemId: candidate.id, reason: "result-budget" });
      continue;
    }
    if (usedTokens + candidate.estimatedTokens > availableTokens) {
      omissions.push({ itemId: candidate.id, reason: "token-budget" });
      continue;
    }
    if (usedLatency + candidate.estimatedLatencyMs > availableLatency) {
      omissions.push({ itemId: candidate.id, reason: "latency-budget" });
      continue;
    }
    if (usedCost + candidate.estimatedCostUsd > availableCost) {
      omissions.push({ itemId: candidate.id, reason: "cost-budget" });
      continue;
    }
    usedTokens += candidate.estimatedTokens;
    usedResults++;
    usedLatency += candidate.estimatedLatencyMs;
    usedCost += candidate.estimatedCostUsd;
    items.push({ ...candidate, rank: items.length + 1 });
  }

  const inputHash = contextPolicyInputHash(request, session, candidates);
  const bundleWithoutHash: Omit<ContextBundle, "bundleHash"> = {
    schemaVersion: CONTEXT_SCHEMA_VERSION,
    contextSessionId: session.contextSessionId,
    target: { ...request.target },
    deliveryMode: request.deliveryMode,
    exposure: request.exposure,
    shadow: request.exposure === "shadow",
    pinnedInsightProjectionHash: session.pinnedInsightProjectionHash,
    pinnedEvidenceProjectionHash: session.pinnedEvidenceProjectionHash,
    inputHash,
    policyHash: policyHash(session),
    items,
    omissions,
    budget: {
      beforeTokens: session.budget.remaining.tokens,
      afterTokens: session.budget.remaining.tokens - usedTokens,
      beforeResults: session.budget.remaining.results,
      afterResults: session.budget.remaining.results - usedResults,
      beforeLatencyMs: session.budget.remaining.latencyMs,
      afterLatencyMs: session.budget.remaining.latencyMs - usedLatency,
      beforeCostUsd: session.budget.remaining.costUsd,
      afterCostUsd: session.budget.remaining.costUsd - usedCost,
      fixedInstructionTokens: request.fixedInstructionTokens,
      encodingOverheadTokens: request.capabilities.encodingOverheadTokens,
    },
    plannedAt: request.now,
  };
  return {
    ok: true,
    value: { ...bundleWithoutHash, bundleHash: sha256(stableStringify(bundleWithoutHash)) },
  };
}
