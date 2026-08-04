import { sha256, stableStringify } from "./events";
import type { RecallBudget, RecallScope } from "./recall-budget";

export type { RecallBudget, RecallScope } from "./recall-budget";

export interface RecallValidTime {
  readonly start?: string;
  readonly end?: string | null;
}

export interface RecallAuthority {
  readonly kind?: string;
  readonly actor?: string;
  readonly reference?: string;
  readonly [key: string]: unknown;
}

/** A reference, not a copied transcript or an executable tool result. */
export interface EvidenceItem {
  readonly id: string;
  readonly content?: string;
  readonly reference?: string;
  readonly references?: readonly string[];
  readonly scope?: RecallScope;
  readonly validTime?: RecallValidTime;
  readonly support?: readonly string[];
  readonly counterevidence?: readonly string[];
  readonly authority?: string | RecallAuthority;
  readonly [key: string]: unknown;
}

export interface InsightItem {
  readonly id: string;
  readonly revisionId?: string;
  readonly proposition?: string;
  readonly content?: string;
  readonly scope?: RecallScope;
  readonly validTime?: RecallValidTime;
  readonly supportEvidence?: readonly string[];
  readonly counterEvidence?: readonly string[];
  readonly authority?: string | RecallAuthority;
  readonly [key: string]: unknown;
}

export interface ProcedureReference {
  /** Stable identity used by recall consolidation. */
  readonly id: string;
  /** Original procedure-memory identity, retained for source-bound provenance. */
  readonly procedureId?: string;
  readonly version?: string;
  readonly sourceUri?: string;
  readonly contentHash?: string;
  readonly authoredBy?: { readonly provider: string; readonly harness: string };
  readonly trigger?: string;
  readonly preconditions?: readonly string[];
  readonly scope?: RecallScope;
  readonly environment?: Readonly<Record<string, string>> | string;
  readonly validTime?: RecallValidTime;
  readonly actions?: readonly string[];
  readonly successObservations?: readonly string[];
  readonly failureObservations?: readonly string[];
  readonly requiredAuthority?: readonly string[];
  readonly evidenceHashes?: readonly string[];
  readonly evaluationHashes?: readonly string[];
  readonly evaluationHash?: string;
  readonly evaluation?: unknown;
  readonly [key: string]: unknown;
}

export interface Contradiction {
  readonly id: string;
  readonly left?: string;
  readonly right?: string;
  readonly claimA?: string;
  readonly claimB?: string;
  readonly support?: readonly string[];
  readonly counterevidence?: readonly string[];
  readonly resolved?: boolean;
  readonly [key: string]: unknown;
}

export interface ConfidenceAssessment {
  readonly id?: string;
  readonly assessor?: string;
  readonly value: number;
  readonly evidence?: readonly string[];
  readonly rationale?: string;
  readonly [key: string]: unknown;
}

export type RecallTerminationReason =
  | "sufficient-evidence"
  | "stable-result"
  | "no-novelty"
  | "budget-exhausted"
  | "timeout"
  | "unresolved-contradiction"
  | "cancelled-parent"
  | "scope-closed";

export type RecallBranchFailureCode =
  | "provider-error"
  | "timeout"
  | "cancelled"
  | "scope-closed"
  | "budget-exhausted"
  | "invalid-observation";

export interface RecallBranchFailure {
  readonly code: RecallBranchFailureCode;
  readonly branchId: string;
  readonly query: string;
  readonly message: string;
  readonly observedAt?: number;
  readonly cause?: unknown;
}

export interface RecallBranchSuccessObservation {
  readonly ok: true;
  readonly branchId: string;
  readonly query?: string;
  readonly answer?: string;
  readonly evidence?: readonly EvidenceItem[];
  readonly insights?: readonly InsightItem[];
  readonly procedures?: readonly ProcedureReference[];
  readonly contradictions?: readonly Contradiction[];
  readonly unresolved?: readonly string[];
  readonly confidence?: readonly ConfidenceAssessment[];
  readonly followUpQueries?: readonly string[];
  readonly usage?: Partial<RecallBudget>;
  readonly tokens?: number;
  readonly costUsd?: number;
  readonly finishedAt?: number;
  readonly [key: string]: unknown;
}

export interface RecallBranchFailureObservation {
  readonly ok: false;
  readonly branchId: string;
  readonly query?: string;
  readonly failure: RecallBranchFailure;
  readonly finishedAt?: number;
  readonly [key: string]: unknown;
}

export type RecallBranchObservation =
  | RecallBranchSuccessObservation
  | RecallBranchFailureObservation;

export type RecallBranchStatus = "succeeded" | "failed" | "timed-out" | "cancelled";

export interface RecallBranchTrace {
  readonly branchId: string;
  readonly query: string;
  readonly status: RecallBranchStatus;
  readonly depth: number;
  readonly budget: RecallBudget;
  readonly deadlineAt: number;
  readonly startedAt?: number;
  readonly finishedAt?: number;
  readonly failure?: RecallBranchFailure;
}

export interface RecallQueryTrace {
  readonly query: string;
  readonly normalized: string;
  readonly depth: number;
  readonly cycle: boolean;
  readonly branchIds: readonly string[];
}

export interface RecallTraceNovelty {
  readonly hash: string;
  readonly isNovel: boolean;
  readonly addedEvidenceIds: readonly string[];
  readonly addedInsightRevisions: readonly string[];
  readonly addedContradictionIds: readonly string[];
  readonly reducedUnresolved: boolean;
}

export interface RecallTraceStability {
  readonly hash: string;
  readonly priorHashes: readonly string[];
  readonly stable: boolean;
}

export interface RecallTrace {
  readonly branches: readonly RecallBranchTrace[];
  readonly queries: readonly RecallQueryTrace[];
  readonly depth: number;
  readonly budget: {
    readonly total: RecallBudget;
    readonly consumed: RecallBudget;
    readonly remaining: RecallBudget;
  };
  readonly consumedBudget: RecallBudget;
  readonly remainingBudget: RecallBudget;
  readonly cancellation: {
    readonly parentRequested: boolean;
    readonly cancelledBranches: readonly string[];
  };
  readonly novelty: RecallTraceNovelty;
  readonly stability: RecallTraceStability;
  readonly terminationReason: RecallTerminationReason;
  readonly scope: RecallScope;
  readonly scopeHash: string;
  readonly queryLineage: readonly string[];
  readonly visitedEvidenceIds: readonly string[];
  readonly visitedInsightRevisions: readonly string[];
  readonly branchFailures: readonly RecallBranchFailure[];
  readonly disagreements: readonly string[];
  readonly omissions: readonly string[];
  readonly contentHash: string;
}

export interface RecallResult {
  readonly answer?: string;
  readonly evidence: readonly EvidenceItem[];
  readonly insights: readonly InsightItem[];
  readonly procedures: readonly ProcedureReference[];
  readonly contradictions: readonly Contradiction[];
  readonly unresolved: readonly string[];
  readonly confidence: readonly ConfidenceAssessment[];
  readonly contentHash: string;
  readonly trace: RecallTrace;
}

export interface RecallConsolidationOptions {
  readonly terminationReason?: RecallTerminationReason;
  readonly totalBudget?: RecallBudget;
  readonly consumedBudget?: RecallBudget;
  readonly remainingBudget?: RecallBudget;
  readonly scope?: RecallScope;
  readonly depth?: number;
  readonly branchTraces?: readonly RecallBranchTrace[];
  readonly queryTraces?: readonly RecallQueryTrace[];
  readonly parentRequestedCancellation?: boolean;
  readonly cancelledBranches?: readonly string[];
  readonly queryLineage?: readonly string[];
  readonly visitedEvidenceIds?: readonly string[];
  readonly visitedInsightRevisions?: readonly string[];
  readonly noveltyVisitedEvidenceIds?: readonly string[];
  readonly noveltyVisitedInsightRevisions?: readonly string[];
  readonly priorConsolidationHashes?: readonly string[];
  readonly previousUnresolved?: readonly string[];
  readonly omissions?: readonly string[];
  readonly trace?: Partial<RecallTrace>;
}

function itemRecord(item: object): Record<string, unknown> {
  return item as Record<string, unknown>;
}

function itemIdentity(kind: string, item: object): string {
  const record = itemRecord(item);
  const id = typeof record.id === "string" ? record.id : "";
  const revision = typeof record.revisionId === "string" ? record.revisionId : "";
  if (id.length > 0) return `${kind}:${id}:${revision}`;
  return `${kind}:hash:${sha256(stableStringify(item))}`;
}

function sortedUnique(values: readonly string[]): string[] {
  return [
    ...new Set(
      values.filter(
        (value): value is string => typeof value === "string" && value.trim().length > 0,
      ),
    ),
  ].toSorted((a, b) => a.localeCompare(b));
}

function mergeArrayField(candidates: readonly object[], key: string): string[] | undefined {
  const values = candidates.flatMap((candidate) => {
    const value = itemRecord(candidate)[key];
    return Array.isArray(value)
      ? value.filter((item): item is string => typeof item === "string")
      : [];
  });
  return values.length === 0 ? undefined : sortedUnique(values);
}

function deduplicateItems<T extends object>(items: readonly T[], kind: string): T[] {
  const grouped = new Map<string, T[]>();
  for (const item of items) {
    const identity = itemIdentity(kind, item);
    const candidates = grouped.get(identity) ?? [];
    candidates.push(item);
    grouped.set(identity, candidates);
  }
  return [...grouped.entries()]
    .toSorted(([left], [right]) => left.localeCompare(right))
    .map(([, candidates]) => {
      const ordered = candidates.toSorted((left, right) =>
        stableStringify(itemRecord(left)).localeCompare(stableStringify(itemRecord(right))),
      );
      const merged: Record<string, unknown> = Object.assign({}, itemRecord(ordered[0]!));
      for (const key of [
        "references",
        "support",
        "counterevidence",
        "supportEvidence",
        "counterEvidence",
        "evidenceHashes",
      ]) {
        const values = mergeArrayField(ordered, key);
        if (values !== undefined) merged[key] = values;
      }
      return merged as T;
    });
}
function identifiedItems<T extends object>(items: readonly T[] | undefined): T[] {
  if (!Array.isArray(items)) return [];
  return items.filter((item): item is T => {
    if (item === null || typeof item !== "object" || Array.isArray(item)) return false;
    const id = (item as Record<string, unknown>).id;
    return typeof id === "string" && id.length > 0;
  });
}

function normalizeEvidence(items: readonly EvidenceItem[]): EvidenceItem[] {
  return deduplicateItems(items, "evidence");
}

function normalizeInsights(items: readonly InsightItem[]): InsightItem[] {
  return deduplicateItems(items, "insight");
}

function normalizeProcedures(items: readonly ProcedureReference[]): ProcedureReference[] {
  return deduplicateItems(items, "procedure");
}

function normalizeContradictions(items: readonly Contradiction[]): Contradiction[] {
  return deduplicateItems(items, "contradiction");
}

function normalizeConfidence(items: readonly ConfidenceAssessment[]): ConfidenceAssessment[] {
  const grouped = new Map<string, ConfidenceAssessment>();
  for (const item of items) {
    const key = item.id ?? `${item.assessor ?? ""}:${item.value}:${sha256(stableStringify(item))}`;
    const prior = grouped.get(key);
    if (!prior || stableStringify(item).localeCompare(stableStringify(prior)) < 0)
      grouped.set(key, item);
  }
  return [...grouped.entries()]
    .toSorted(([left], [right]) => left.localeCompare(right))
    .map(([, value]) => value);
}

function failureOf(observation: RecallBranchObservation): RecallBranchFailure | undefined {
  return observation.ok ? undefined : observation.failure;
}

function identityFromInsight(item: InsightItem): string {
  return item.revisionId ?? item.id;
}

function finiteBudget(value: RecallBudget | undefined): RecallBudget {
  return (
    value ?? {
      maxDepth: 0,
      maxBranches: 0,
      maxQueries: 0,
      maxResults: 0,
      maxTokens: 0,
      maxLatencyMs: 0,
      maxCostUsd: 0,
    }
  );
}

/** Hash the novelty-bearing identities without depending on branch order. */
export function recallNoveltyHash(input: {
  readonly evidenceIds: readonly string[];
  readonly insightRevisions: readonly string[];
  readonly contradictionIds: readonly string[];
  readonly unresolved: readonly string[];
}): string {
  return sha256(
    stableStringify({
      evidenceIds: sortedUnique(input.evidenceIds),
      insightRevisions: sortedUnique(input.insightRevisions),
      contradictionIds: sortedUnique(input.contradictionIds),
      unresolved: sortedUnique(input.unresolved),
    }),
  );
}

/** Hash the bounded semantic result; completion order cannot affect it. */
export function recallStabilityHash(input: {
  readonly answer?: string;
  readonly evidence: readonly EvidenceItem[];
  readonly insights: readonly InsightItem[];
  readonly procedures: readonly ProcedureReference[];
  readonly contradictions: readonly Contradiction[];
  readonly unresolved: readonly string[];
  readonly confidence: readonly ConfidenceAssessment[];
}): string {
  return sha256(
    stableStringify({
      answer: input.answer,
      evidence: input.evidence,
      insights: input.insights,
      procedures: input.procedures,
      contradictions: input.contradictions,
      unresolved: input.unresolved,
      confidence: input.confidence,
    }),
  );
}

const RECALL_TOKEN_BYTES = 3;
const RESULT_KEY_ORDER = [
  "answer",
  "evidence",
  "insights",
  "procedures",
  "contradictions",
  "unresolved",
  "confidence",
  "omissions",
] as const;
const ITEM_KEY_ORDER = [
  "id",
  "revisionId",
  "procedureId",
  "reference",
  "references",
  "support",
  "counterevidence",
  "supportEvidence",
  "counterEvidence",
  "scope",
  "validTime",
  "authority",
] as const;

function tokenCount(value: unknown): number {
  const serialized = stableStringify(value);
  return Math.ceil(new TextEncoder().encode(serialized ?? "").byteLength / RECALL_TOKEN_BYTES);
}

function keyPriority(key: string, order: readonly string[]): number {
  const index = order.indexOf(key);
  return index < 0 ? order.length : index;
}

/**
 * Deterministically retain the largest JSON-safe prefix that fits a token
 * budget. Identity and provenance fields are visited before free-form text.
 */
function truncateForTokens(value: unknown, maxTokens: number): unknown {
  if (!Number.isFinite(maxTokens)) return value;
  const limit = Math.max(0, Math.floor(maxTokens));
  if (typeof value === "string") {
    if (tokenCount(value) <= limit) return value;
    let low = 0;
    let high = value.length;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (tokenCount(value.slice(0, middle)) <= limit) low = middle;
      else high = middle - 1;
    }
    return value.slice(0, low);
  }
  if (value === null || typeof value !== "object")
    return tokenCount(value) <= limit ? value : undefined;
  if (Array.isArray(value)) {
    if (tokenCount(value) <= limit) return [...value];
    const result: unknown[] = [];
    for (const item of value) {
      let low = 0;
      let high = Math.max(0, limit - tokenCount(result));
      let accepted = false;
      let acceptedValue: unknown;
      while (low <= high) {
        const middle = Math.floor((low + high) / 2);
        const bounded = truncateForTokens(item, middle);
        if (bounded === undefined) {
          low = middle + 1;
          continue;
        }
        if (tokenCount([...result, bounded]) <= limit) {
          accepted = true;
          acceptedValue = bounded;
          low = middle + 1;
        } else {
          high = middle - 1;
        }
      }
      if (!accepted) break;
      result.push(acceptedValue);
    }
    return result;
  }
  const record = value as Record<string, unknown>;
  const order = Object.keys(record).some((key) =>
    (RESULT_KEY_ORDER as readonly string[]).includes(key),
  )
    ? RESULT_KEY_ORDER
    : ITEM_KEY_ORDER;
  const keys = Object.keys(record).toSorted(
    (left, right) =>
      keyPriority(left, order) - keyPriority(right, order) || left.localeCompare(right),
  );
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    let low = 0;
    let high = Math.max(0, limit - tokenCount(result));
    let accepted = false;
    let acceptedValue: unknown;
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      const bounded = truncateForTokens(record[key], middle);
      if (bounded === undefined) {
        low = middle + 1;
        continue;
      }
      if (tokenCount({ ...result, [key]: bounded }) <= limit) {
        accepted = true;
        acceptedValue = bounded;
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }
    if (accepted) result[key] = acceptedValue;
  }
  return result;
}

function capItems<T>(items: readonly T[], remaining: { value: number }, maxResults: number): T[] {
  if (!Number.isFinite(maxResults)) return [...items];
  const allowed = Math.max(0, Math.floor(Math.min(remaining.value, maxResults)));
  const result = items.slice(0, allowed);
  remaining.value -= result.length;
  return result;
}

function boundedStrings(
  values: readonly string[],
  remaining: { value: number },
  maxResults: number,
): string[] {
  return capItems(sortedUnique(values), remaining, maxResults);
}

/**
 * Consolidate all branch observations into one bounded, deterministic result.
 * Every semantic list is retained separately; answer text never substitutes for
 * evidence, procedures, contradictions, or confidence.
 */
export function consolidateRecall(
  observations: readonly RecallBranchObservation[],
  options: RecallConsolidationOptions = {},
): RecallResult {
  const successes = observations.filter(
    (observation): observation is RecallBranchSuccessObservation => observation.ok,
  );
  const failures = observations
    .map(failureOf)
    .filter((failure): failure is RecallBranchFailure => failure !== undefined)
    .toSorted((left, right) =>
      `${left.branchId}:${left.code}:${left.message}`.localeCompare(
        `${right.branchId}:${right.code}:${right.message}`,
      ),
    );
  const answers = sortedUnique(
    successes
      .map((observation) => observation.answer)
      .filter((answer): answer is string => typeof answer === "string" && answer.trim().length > 0),
  );
  const answer = answers[0];
  const evidence = normalizeEvidence(
    successes.flatMap((observation) => identifiedItems(observation.evidence)),
  );
  const insights = normalizeInsights(
    successes.flatMap((observation) => identifiedItems(observation.insights)),
  );
  const procedures = normalizeProcedures(
    successes.flatMap((observation) => identifiedItems(observation.procedures)),
  );
  const contradictions = normalizeContradictions(
    successes.flatMap((observation) => identifiedItems(observation.contradictions)),
  );
  const unresolved = sortedUnique(
    successes.flatMap((observation) =>
      Array.isArray(observation.unresolved) ? observation.unresolved : [],
    ),
  );
  const confidence = normalizeConfidence(
    successes.flatMap((observation) =>
      Array.isArray(observation.confidence)
        ? observation.confidence.filter((item) => Number.isFinite(item.value))
        : [],
    ),
  );
  const maxResults = options.totalBudget?.maxResults ?? Number.POSITIVE_INFINITY;
  const remainingItems = { value: maxResults };
  const boundedEvidence = capItems(evidence, remainingItems, maxResults);
  const boundedInsights = capItems(insights, remainingItems, maxResults);
  const boundedProcedures = capItems(procedures, remainingItems, maxResults);
  const boundedContradictions = capItems(contradictions, remainingItems, maxResults);
  const boundedUnresolved = boundedStrings(unresolved, remainingItems, maxResults);
  const boundedConfidence = capItems(confidence, remainingItems, maxResults);
  const previousUnresolved = new Set(options.previousUnresolved ?? []);
  const visitedEvidence = new Set(
    options.noveltyVisitedEvidenceIds ?? options.visitedEvidenceIds ?? [],
  );
  const visitedInsights = new Set(
    options.noveltyVisitedInsightRevisions ?? options.visitedInsightRevisions ?? [],
  );
  const evidenceIds = boundedEvidence.map((item) => item.id);
  const insightRevisions = boundedInsights.map(identityFromInsight);
  const contradictionIds = boundedContradictions.map((item) => item.id);
  const noveltyHash = recallNoveltyHash({
    evidenceIds,
    insightRevisions,
    contradictionIds,
    unresolved: boundedUnresolved,
  });
  const novelty: RecallTraceNovelty = {
    hash: noveltyHash,
    isNovel:
      evidenceIds.some((id) => !visitedEvidence.has(id)) ||
      insightRevisions.some((id) => !visitedInsights.has(id)) ||
      contradictionIds.length > 0 ||
      boundedUnresolved.some((item) => !previousUnresolved.has(item)),
    addedEvidenceIds: sortedUnique(evidenceIds.filter((id) => !visitedEvidence.has(id))),
    addedInsightRevisions: sortedUnique(insightRevisions.filter((id) => !visitedInsights.has(id))),
    addedContradictionIds: sortedUnique(contradictionIds),
    reducedUnresolved: [...previousUnresolved].some((item) => !boundedUnresolved.includes(item)),
  };
  const scope = options.scope ?? {};
  const branchTraces = [...(options.branchTraces ?? [])].toSorted((left, right) =>
    `${left.query}:${left.branchId}`.localeCompare(`${right.query}:${right.branchId}`),
  );
  const queryTraces = [...(options.queryTraces ?? [])].toSorted((left, right) =>
    `${left.depth}:${left.normalized}`.localeCompare(`${right.depth}:${right.normalized}`),
  );
  const totalBudget = finiteBudget(options.totalBudget);
  const consumedBudget = finiteBudget(options.consumedBudget);
  const remainingBudget = finiteBudget(options.remainingBudget);
  const omissionValues = sortedUnique([
    ...(options.omissions ?? []),
    ...(boundedEvidence.length < evidence.length
      ? [`evidence-truncated:${evidence.length - boundedEvidence.length}`]
      : []),
    ...(boundedInsights.length < insights.length
      ? [`insights-truncated:${insights.length - boundedInsights.length}`]
      : []),
    ...(boundedProcedures.length < procedures.length
      ? [`procedures-truncated:${procedures.length - boundedProcedures.length}`]
      : []),
    ...(boundedContradictions.length < contradictions.length
      ? [`contradictions-truncated:${contradictions.length - boundedContradictions.length}`]
      : []),
    ...(boundedUnresolved.length < unresolved.length
      ? [`unresolved-truncated:${unresolved.length - boundedUnresolved.length}`]
      : []),
    ...(boundedConfidence.length < confidence.length
      ? [`confidence-truncated:${confidence.length - boundedConfidence.length}`]
      : []),
  ]);
  const boundedOmissions = boundedStrings(omissionValues, remainingItems, maxResults);
  const semanticForBudget = {
    ...(answer === undefined ? {} : { answer }),
    ...(boundedEvidence.length === 0 ? {} : { evidence: boundedEvidence }),
    ...(boundedInsights.length === 0 ? {} : { insights: boundedInsights }),
    ...(boundedProcedures.length === 0 ? {} : { procedures: boundedProcedures }),
    ...(boundedContradictions.length === 0 ? {} : { contradictions: boundedContradictions }),
    ...(boundedUnresolved.length === 0 ? {} : { unresolved: boundedUnresolved }),
    ...(boundedConfidence.length === 0 ? {} : { confidence: boundedConfidence }),
    ...(boundedOmissions.length === 0 ? {} : { omissions: boundedOmissions }),
  };
  const budgetedSemanticValue = truncateForTokens(
    semanticForBudget,
    options.totalBudget?.maxTokens ?? Number.POSITIVE_INFINITY,
  );
  const budgetedSemantic =
    budgetedSemanticValue !== null &&
    typeof budgetedSemanticValue === "object" &&
    !Array.isArray(budgetedSemanticValue)
      ? (budgetedSemanticValue as Record<string, unknown>)
      : {};
  const outputAnswer =
    typeof budgetedSemantic.answer === "string" ? budgetedSemantic.answer : undefined;
  const outputEvidence = Array.isArray(budgetedSemantic.evidence)
    ? (budgetedSemantic.evidence as EvidenceItem[])
    : [];
  const outputInsights = Array.isArray(budgetedSemantic.insights)
    ? (budgetedSemantic.insights as InsightItem[])
    : [];
  const outputProcedures = Array.isArray(budgetedSemantic.procedures)
    ? (budgetedSemantic.procedures as ProcedureReference[])
    : [];
  const outputContradictions = Array.isArray(budgetedSemantic.contradictions)
    ? (budgetedSemantic.contradictions as Contradiction[])
    : [];
  const outputUnresolved = Array.isArray(budgetedSemantic.unresolved)
    ? (budgetedSemantic.unresolved as string[])
    : [];
  const outputConfidence = Array.isArray(budgetedSemantic.confidence)
    ? (budgetedSemantic.confidence as ConfidenceAssessment[])
    : [];
  const outputOmissions = Array.isArray(budgetedSemantic.omissions)
    ? (budgetedSemantic.omissions as string[])
    : [];
  const outputEvidenceIds = outputEvidence.map((item) => item.id);
  const outputInsightRevisions = outputInsights.map(identityFromInsight);
  const outputContradictionIds = outputContradictions.map((item) => item.id);
  const disagreements = boundedStrings(answers.slice(1), remainingItems, maxResults);
  const outputStabilityHash = recallStabilityHash({
    answer: outputAnswer,
    evidence: outputEvidence,
    insights: outputInsights,
    procedures: outputProcedures,
    contradictions: outputContradictions,
    unresolved: outputUnresolved,
    confidence: outputConfidence,
  });
  const priorHashes = sortedUnique(options.priorConsolidationHashes ?? []);
  const stability: RecallTraceStability = {
    hash: outputStabilityHash,
    priorHashes,
    stable: priorHashes.includes(outputStabilityHash),
  };
  const traceWithoutHash: Omit<RecallTrace, "contentHash"> = {
    branches: branchTraces,
    queries: queryTraces,
    depth: options.depth ?? 0,
    budget: { total: totalBudget, consumed: consumedBudget, remaining: remainingBudget },
    consumedBudget,
    remainingBudget,
    cancellation: {
      parentRequested: options.parentRequestedCancellation ?? false,
      cancelledBranches: sortedUnique(options.cancelledBranches ?? []),
    },
    novelty: {
      ...novelty,
      hash: recallNoveltyHash({
        evidenceIds: outputEvidenceIds,
        insightRevisions: outputInsightRevisions,
        contradictionIds: outputContradictionIds,
        unresolved: outputUnresolved,
      }),
      isNovel:
        outputEvidenceIds.some((id) => !visitedEvidence.has(id)) ||
        outputInsightRevisions.some((id) => !visitedInsights.has(id)) ||
        outputContradictionIds.length > 0 ||
        outputUnresolved.some((item) => !previousUnresolved.has(item)),
      addedEvidenceIds: sortedUnique(outputEvidenceIds.filter((id) => !visitedEvidence.has(id))),
      addedInsightRevisions: sortedUnique(
        outputInsightRevisions.filter((id) => !visitedInsights.has(id)),
      ),
      addedContradictionIds: sortedUnique(outputContradictionIds),
      reducedUnresolved: [...previousUnresolved].some((item) => !outputUnresolved.includes(item)),
    },
    stability,
    terminationReason: options.terminationReason ?? "no-novelty",
    scope,
    scopeHash: sha256(stableStringify(scope)),
    queryLineage: sortedUnique(options.queryLineage ?? []),
    visitedEvidenceIds: sortedUnique([...visitedEvidence, ...outputEvidenceIds]),
    visitedInsightRevisions: sortedUnique([...visitedInsights, ...outputInsightRevisions]),
    branchFailures: failures,
    disagreements,
    omissions: outputOmissions,
  };
  const traceContentHash = sha256(stableStringify(traceWithoutHash));
  const resultWithoutHash = {
    ...(outputAnswer === undefined ? {} : { answer: outputAnswer }),
    evidence: outputEvidence,
    insights: outputInsights,
    procedures: outputProcedures,
    contradictions: outputContradictions,
    unresolved: outputUnresolved,
    confidence: outputConfidence,
  };
  const contentHash = recallStabilityHash(resultWithoutHash);
  return {
    ...resultWithoutHash,
    contentHash,
    trace: { ...traceWithoutHash, contentHash: traceContentHash },
  };
}
export const consolidateRecallResult = consolidateRecall;
