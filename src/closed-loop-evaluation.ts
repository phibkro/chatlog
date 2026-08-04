export const CLOSED_LOOP_EVALUATOR_SOURCE_KIND = "chatlog-closed-loop-evaluator" as const;
export const CLOSED_LOOP_EVALUATOR_ADAPTER_RECIPE = "chatlog-closed-loop-evaluator-v1" as const;

export interface ClosedLoopCanonicalMetrics {
  gatePassed: boolean;
  userCorrections: number;
  rederivationCount: number;
  tokensToGate: number | null;
  unresolved: boolean;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function metricValue(
  payload: Record<string, unknown>,
  nested: Record<string, unknown>,
  name: keyof ClosedLoopCanonicalMetrics,
): unknown {
  if (name in payload) return payload[name];
  if (name in nested) return nested[name];
  return undefined;
}

function nonnegativeInteger(value: unknown): value is number {
  return (
    typeof value === "number" && Number.isFinite(value) && Number.isSafeInteger(value) && value >= 0
  );
}

export function parseClosedLoopEvaluatorMetrics(value: unknown): ClosedLoopCanonicalMetrics | null {
  if (!record(value)) return null;
  const nested = record(value.metrics) ? value.metrics : {};
  const gatePassed = metricValue(value, nested, "gatePassed");
  const userCorrections = metricValue(value, nested, "userCorrections");
  const rederivationCount = metricValue(value, nested, "rederivationCount");
  const tokensToGate = metricValue(value, nested, "tokensToGate");
  const unresolved = metricValue(value, nested, "unresolved");
  if (
    typeof gatePassed !== "boolean" ||
    !nonnegativeInteger(userCorrections) ||
    !nonnegativeInteger(rederivationCount) ||
    (tokensToGate !== null && !nonnegativeInteger(tokensToGate)) ||
    typeof unresolved !== "boolean"
  )
    return null;
  return {
    gatePassed,
    userCorrections,
    rederivationCount,
    tokensToGate,
    unresolved,
  };
}

export function canonicalMetricsEqual(
  left: ClosedLoopCanonicalMetrics,
  right: ClosedLoopCanonicalMetrics,
): boolean {
  return (
    left.gatePassed === right.gatePassed &&
    left.userCorrections === right.userCorrections &&
    left.rederivationCount === right.rederivationCount &&
    left.tokensToGate === right.tokensToGate &&
    left.unresolved === right.unresolved
  );
}

export function isTrustedClosedLoopEvaluatorSource(input: {
  kind: string;
  sourceKind: string;
  adapterRecipe: string;
}): boolean {
  return (
    input.kind === "evaluation.recorded" &&
    input.sourceKind === CLOSED_LOOP_EVALUATOR_SOURCE_KIND &&
    input.adapterRecipe === CLOSED_LOOP_EVALUATOR_ADAPTER_RECIPE
  );
}

export function isUntrustedEvaluatorActor(actorKind: string): boolean {
  const normalized = actorKind.trim().toLowerCase();
  return normalized === "assistant" || normalized === "agent" || normalized === "provider";
}
