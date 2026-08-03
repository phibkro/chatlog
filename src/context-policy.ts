import { sha256, stableStringify } from "./events";
import type {
  ContextCandidate,
  ContextOmissionReason,
  ContextRequest,
  ContextRiskClass,
  ContextSession,
} from "./context-types";

export const CONTEXT_POLICY_VERSION = "chatlog-context-policy-v1";
export const CONTEXT_POLICY_HASH = sha256(CONTEXT_POLICY_VERSION);

const RISK_ORDER: Readonly<Record<ContextRiskClass, number>> = {
  low: 0,
  medium: 1,
  high: 2,
};

export type ContextPolicyDecision =
  | { allowed: true }
  | { allowed: false; reason: ContextOmissionReason };

function pathContains(scopePath: string, requestPath: string): boolean {
  const normalizedScope = scopePath.endsWith("/") ? scopePath : `${scopePath}/`;
  return requestPath === scopePath || requestPath.startsWith(normalizedScope);
}

function scopeDecision(
  candidate: ContextCandidate,
  request: ContextRequest,
): ContextPolicyDecision {
  const candidateScope = candidate.scope;
  const requestScope = request.scope;
  if (candidateScope.domain !== requestScope.domain)
    return { allowed: false, reason: "domain-mismatch" };
  if (candidateScope.user !== null && candidateScope.user !== requestScope.user)
    return { allowed: false, reason: "user-mismatch" };
  if (
    candidateScope.organization !== null &&
    candidateScope.organization !== requestScope.organization
  )
    return { allowed: false, reason: "organization-mismatch" };
  if (candidateScope.project !== null && candidateScope.project !== requestScope.project)
    return { allowed: false, reason: "project-mismatch" };
  if (candidateScope.repository !== null && candidateScope.repository !== requestScope.repository)
    return { allowed: false, reason: "repository-mismatch" };
  if (
    candidateScope.path !== null &&
    (requestScope.path === null || !pathContains(candidateScope.path, requestScope.path))
  )
    return { allowed: false, reason: "path-mismatch" };
  if (candidateScope.harness !== null && candidateScope.harness !== requestScope.harness)
    return { allowed: false, reason: "harness-mismatch" };
  if (candidateScope.model !== null && candidateScope.model !== requestScope.model)
    return { allowed: false, reason: "model-mismatch" };
  if (candidateScope.tool !== null && candidateScope.tool !== requestScope.tool)
    return { allowed: false, reason: "tool-mismatch" };
  return { allowed: true };
}

export function evaluateContextCandidate(
  candidate: ContextCandidate,
  request: ContextRequest,
): ContextPolicyDecision {
  if (!request.allowedItemKinds.includes(candidate.kind))
    return { allowed: false, reason: "kind-not-allowed" };
  if (request.exposure === "evidence-only" && candidate.kind !== "evidence")
    return { allowed: false, reason: "exposure-denied" };
  if (request.exposure !== "shadow" && candidate.riskClass === "high")
    return { allowed: false, reason: "exposure-denied" };
  if (RISK_ORDER[candidate.riskClass] > RISK_ORDER[request.riskCeiling])
    return { allowed: false, reason: "risk-ceiling" };
  const now = Date.parse(request.now);
  const validStart = Date.parse(candidate.validTime.start);
  if (validStart > now) return { allowed: false, reason: "not-yet-valid" };
  if (candidate.validTime.end !== null && Date.parse(candidate.validTime.end) <= now)
    return { allowed: false, reason: "expired" };
  if (request.freshAfter !== null && validStart < Date.parse(request.freshAfter))
    return { allowed: false, reason: "stale" };
  return scopeDecision(candidate, request);
}

export function validateContextRequest(
  request: ContextRequest,
  session: ContextSession,
):
  | { ok: true }
  | { ok: false; code: "invalid-request" | "session-mismatch" | "scope-denied"; message: string } {
  if (!request.task.trim() || !request.query.trim())
    return { ok: false, code: "invalid-request", message: "task and query must be explicit" };
  if (!Number.isFinite(Date.parse(request.now)))
    return { ok: false, code: "invalid-request", message: "now must be an ISO timestamp" };
  if (request.contextSessionId !== session.contextSessionId)
    return { ok: false, code: "session-mismatch", message: "context session does not match" };
  if (
    request.target.provider !== session.target.provider ||
    request.target.harness !== session.target.harness ||
    request.target.model !== session.target.model ||
    request.target.role !== session.target.role
  )
    return {
      ok: false,
      code: "session-mismatch",
      message: "provider target does not match pinned session",
    };
  if (
    request.scope.project !== session.projectIdentity ||
    request.scope.harness !== session.target.harness ||
    request.scope.model !== session.target.model ||
    !session.domainPolicy.includes(request.scope.domain)
  )
    return {
      ok: false,
      code: "scope-denied",
      message: "request is outside the pinned session scope",
    };
  if (
    session.path !== null &&
    (request.scope.path === null || !pathContains(session.path, request.scope.path))
  )
    return {
      ok: false,
      code: "scope-denied",
      message: "request path is outside the pinned session path",
    };
  if (
    request.capabilities.maximumContextTokens < 0 ||
    request.capabilities.encodingOverheadTokens < 0
  )
    return {
      ok: false,
      code: "invalid-request",
      message: "provider token limits must be non-negative",
    };
  for (const [key, value] of Object.entries(request.budget))
    if (!Number.isFinite(value) || value < 0)
      return { ok: false, code: "invalid-request", message: `budget.${key} must be non-negative` };
  return { ok: true };
}

export function contextPolicyInputHash(
  request: ContextRequest,
  session: ContextSession,
  candidates: readonly ContextCandidate[],
): string {
  return sha256(
    stableStringify({
      request,
      session: {
        contextSessionId: session.contextSessionId,
        pinnedInsightProjectionHash: session.pinnedInsightProjectionHash,
        pinnedEvidenceProjectionHash: session.pinnedEvidenceProjectionHash,
        remainingBudget: session.budget.remaining,
      },
      candidates: [...candidates].toSorted((left, right) => left.id.localeCompare(right.id)),
    }),
  );
}
