import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  assertDerivedProjection,
  DerivedProjectionDriftError,
  loadCurrentDerivedArtifact,
  loadProjectionBoundArtifact,
  type DerivedProjectionReceipt,
} from "./derived-authority";
import { durableAtomicWrite } from "./durable-fs";
import type { SignalName } from "./orchestration-profile";
import type { AgentRole } from "./role-segmentation";
import type {
  WorkflowEvent,
  WorkflowEventKind,
  WorkflowEvolutionArtifact,
} from "./workflow-evolution";
import type {
  WorkflowOutcomeComparison,
  WorkflowOutcomesArtifact,
} from "./workflow-outcomes";
import { loadWorkflowOutcomes } from "./workflow-outcomes";

export type WorkflowPatternSignal =
  | SignalName
  | "approval-policy"
  | "autonomy-general"
  | "ownership-general";

export type WorkflowPatternRelation =
  | "introduced"
  | "reinforced"
  | "reformulated"
  | "returned-to-prior";

export type WorkflowBoundaryEffect =
  | "approval-gate-relaxed"
  | "operating-latitude-expanded"
  | "guardrail-imposed";

export interface WorkflowPatternMetric {
  orientation: "higher-is-favorable" | "lower-is-favorable";
  samples: number;
  favorable: number | null;
  unfavorable: number | null;
  unchanged: number | null;
  medianDelta: number | null;
}

export interface WorkflowPattern {
  id: string;
  kind: WorkflowEventKind;
  signal: WorkflowPatternSignal;
  role: AgentRole;
  title: string;
  claim: string;
  boundaryEffect: WorkflowBoundaryEffect;
  coverage: {
    eventMemberships: number;
    sharedEventMemberships: number;
    distinctEpisodes: number;
    distinctDays: number;
    distinctFormulations: number;
    collapsedSameEpisodeMemberships: number;
    projects: string[];
    harnesses: string[];
    firstSeenAt: string;
    lastSeenAt: string;
    minimumDistinctEpisodes: 3;
    minimumDistinctDays: 2;
  };
  sequence: {
    relations: Record<WorkflowPatternRelation, number>;
    latestRelation: WorkflowPatternRelation;
    timeline: Array<{
      eventId: string;
      episodeId: string;
      occurredAt: string;
      relation: WorkflowPatternRelation;
      statementHash: string;
    }>;
  };
  outcomes: {
    status: "observed" | "insufficient-coverage";
    observedEpisodes: number;
    sparseEpisodes: number;
    minimumObservedEpisodes: 3;
    reasons: string[];
    metrics: {
      completionRate: WorkflowPatternMetric;
      frictionRate: WorkflowPatternMetric;
      reworkRate: WorkflowPatternMetric;
    };
    interpretation: {
      claim: string;
      causal: false;
    };
  };
  examples: Array<{
    eventId: string;
    occurredAt: string;
    relation: WorkflowPatternRelation;
    statement: string;
    evidence: Array<{ pointer: string; snippet: string }>;
  }>;
}

export interface WorkflowPatternsArtifact {
  schema: "chatlog/workflow-patterns-v1";
  schemaVersion: 1;
  outputKind: "workflow-patterns";
  inputProjectionHash: string;
  structureProjectionHash: string;
  workflowContentHash: string;
  outcomesContentHash: string;
  methodology: {
    identity: string;
    repetition: string;
    relations: string;
    boundaryEffect: string;
    outcomes: string;
    causality: string;
  };
  summary: {
    workflowEvents: number;
    candidateSignatures: number;
    repeatedPatterns: number;
    belowFloorSignatures: number;
    outcomeObservedPatterns: number;
    minimumDistinctEpisodes: 3;
    minimumDistinctDays: 2;
    byKind: Record<WorkflowEventKind, number>;
  };
  patterns: WorkflowPattern[];
  egress: {
    performed: false;
    surface: "none";
    hostedCalls: 0;
  };
}

interface PatternInput {
  event: WorkflowEvent;
  signal: WorkflowPatternSignal;
  role: AgentRole;
}

interface PatternOccurrence {
  event: WorkflowEvent;
  relation: WorkflowPatternRelation;
}

const MIN_PATTERN_EPISODES = 3 as const;
const MIN_PATTERN_DAYS = 2 as const;
const MIN_OUTCOME_EPISODES = 3 as const;
const MIN_METRIC_SAMPLES = 3;
const MAX_PATTERNS = 5_000;
const MAX_TIMELINE = 24;
const MAX_EXAMPLES = 4;
const KIND_ORDER: WorkflowEventKind[] = [
  "approval-gate-changed",
  "autonomy-boundary",
  "ownership-boundary",
];
const ROLE_ORDER: AgentRole[] = [
  "manager",
  "worker",
  "reviewer",
  "advisor",
  "unclassified",
];
const SIGNAL_LABELS: Record<WorkflowPatternSignal, string> = {
  "self-propel": "continue autonomously through the active lane",
  "tracer-and-continue": "leave a tracer and continue",
  "recommend-and-proceed": "recommend a path and proceed",
  "dont-wait-for-approval": "avoid waiting for routine approval",
  "one-writer": "keep one writer per mutable working tree",
  "spec-freeze": "freeze and re-read the binding contract",
  "gate-before-act": "gate consequential actions before proceeding",
  "stop-and-report": "stop and report at a true operator boundary",
  "ab-with-recommendation": "present bounded options with a recommendation",
  "approval-policy": "relax a separate operator approval gate after verification",
  "autonomy-general": "expand bounded operating latitude",
  "ownership-general": "impose an explicit ownership boundary",
};
const AUTONOMY_SIGNALS = new Set<WorkflowPatternSignal>([
  "self-propel",
  "tracer-and-continue",
  "recommend-and-proceed",
  "dont-wait-for-approval",
]);
const GUARDRAIL_SIGNALS = new Set<WorkflowPatternSignal>([
  "one-writer",
  "spec-freeze",
  "gate-before-act",
  "stop-and-report",
  "ab-with-recommendation",
]);

function hash(text: string): string {
  return new Bun.CryptoHasher("sha256").update(text).digest("hex");
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function round(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort(compareText);
}

function fallbackSignal(kind: WorkflowEventKind): WorkflowPatternSignal {
  if (kind === "approval-gate-changed") return "approval-policy";
  return kind === "autonomy-boundary"
    ? "autonomy-general"
    : "ownership-general";
}

function eventSignals(event: WorkflowEvent): WorkflowPatternSignal[] {
  if (event.kind === "approval-gate-changed") {
    return uniqueSorted([
      "approval-policy",
      ...event.signals,
    ]) as WorkflowPatternSignal[];
  }
  return event.signals.length
    ? uniqueSorted(event.signals) as WorkflowPatternSignal[]
    : [fallbackSignal(event.kind)];
}

function eventRoles(event: WorkflowEvent): AgentRole[] {
  return event.lineage.roles.length
    ? [...new Set(event.lineage.roles)].sort(
      (a, b) => ROLE_ORDER.indexOf(a) - ROLE_ORDER.indexOf(b),
    )
    : ["unclassified"];
}

function patternKey(input: Pick<PatternInput, "event" | "signal" | "role">): string {
  return JSON.stringify({
    kind: input.event.kind,
    signal: input.signal,
    role: input.role,
  });
}

function representativeEvents(inputs: PatternInput[]): PatternInput[] {
  const representatives = new Map<string, PatternInput>();
  for (const input of inputs) {
    const key = input.event.lineage.episodeId;
    const prior = representatives.get(key);
    if (
      !prior
      || compareText(input.event.occurredAt, prior.event.occurredAt) > 0
      || (
        input.event.occurredAt === prior.event.occurredAt
        && compareText(input.event.id, prior.event.id) > 0
      )
    ) representatives.set(key, input);
  }
  return [...representatives.values()].sort((a, b) =>
    compareText(a.event.occurredAt, b.event.occurredAt)
    || compareText(a.event.id, b.event.id)
  );
}

function occurrenceSequence(inputs: PatternInput[]): PatternOccurrence[] {
  const seen = new Set<string>();
  let previousHash: string | null = null;
  return inputs.map(({ event }, index) => {
    let relation: WorkflowPatternRelation;
    if (index === 0) relation = "introduced";
    else if (event.statementHash === previousHash) relation = "reinforced";
    else if (seen.has(event.statementHash)) relation = "returned-to-prior";
    else relation = "reformulated";
    seen.add(event.statementHash);
    previousHash = event.statementHash;
    return { event, relation };
  });
}

function boundaryEffect(
  kind: WorkflowEventKind,
  signal: WorkflowPatternSignal,
): WorkflowBoundaryEffect {
  if (GUARDRAIL_SIGNALS.has(signal)) return "guardrail-imposed";
  if (AUTONOMY_SIGNALS.has(signal)) return "operating-latitude-expanded";
  if (signal === "approval-policy") return "approval-gate-relaxed";
  if (kind === "approval-gate-changed") return "approval-gate-relaxed";
  return kind === "autonomy-boundary"
    ? "operating-latitude-expanded"
    : "guardrail-imposed";
}

function patternTitle(signal: WorkflowPatternSignal, role: AgentRole): string {
  const label = SIGNAL_LABELS[signal];
  return `${role === "unclassified" ? "Agents" : `${role[0].toUpperCase()}${role.slice(1)} agents`}: ${label}`;
}

function patternClaim(
  signal: WorkflowPatternSignal,
  role: AgentRole,
  episodes: number,
): string {
  const subject = role === "unclassified"
    ? "agent sessions without a stable inferred role"
    : `${role} agent sessions`;
  return `Across ${episodes} distinct opaque episodes, the operator repeatedly instructed ${subject} to ${SIGNAL_LABELS[signal]}.`;
}

function metricAssociation(
  comparisons: WorkflowOutcomeComparison[],
  key: "completionRate" | "frictionRate" | "reworkRate",
  orientation: WorkflowPatternMetric["orientation"],
): WorkflowPatternMetric {
  const values = comparisons.flatMap((comparison) => {
    const value = comparison.deltas[key];
    return typeof value === "number" && Number.isFinite(value) ? [value] : [];
  });
  if (values.length < MIN_METRIC_SAMPLES) {
    return {
      orientation,
      samples: values.length,
      favorable: null,
      unfavorable: null,
      unchanged: null,
      medianDelta: null,
    };
  }
  const oriented = values.map((value) =>
    orientation === "higher-is-favorable" ? value : -value
  );
  return {
    orientation,
    samples: values.length,
    favorable: oriented.filter((value) => value > 0).length,
    unfavorable: oriented.filter((value) => value < 0).length,
    unchanged: oriented.filter((value) => value === 0).length,
    medianDelta: round(median(values)!),
  };
}

function outcomeSummary(
  occurrences: PatternOccurrence[],
  outcomeByEvent: Map<string, WorkflowOutcomeComparison>,
): WorkflowPattern["outcomes"] {
  const comparisons = occurrences.flatMap(({ event }) => {
    const comparison = outcomeByEvent.get(event.id);
    return comparison?.status === "observed" ? [comparison] : [];
  });
  const sparseEpisodes = occurrences.length - comparisons.length;
  const status = comparisons.length >= MIN_OUTCOME_EPISODES
    ? "observed"
    : "insufficient-coverage";
  return {
    status,
    observedEpisodes: comparisons.length,
    sparseEpisodes,
    minimumObservedEpisodes: MIN_OUTCOME_EPISODES,
    reasons: status === "observed"
      ? []
      : [`observed-episodes-below-${MIN_OUTCOME_EPISODES}`],
    metrics: {
      completionRate: metricAssociation(
        comparisons,
        "completionRate",
        "higher-is-favorable",
      ),
      frictionRate: metricAssociation(
        comparisons,
        "frictionRate",
        "lower-is-favorable",
      ),
      reworkRate: metricAssociation(
        comparisons,
        "reworkRate",
        "lower-is-favorable",
      ),
    },
    interpretation: {
      claim: status === "observed"
        ? "Post-event proxy directions are summarized across covered episode windows; overlapping windows and other confounders prevent causal attribution."
        : "Fewer than three distinct episode windows have sufficient event-level outcome coverage, so no repeated outcome association is reported.",
      causal: false,
    },
  };
}

function selectExamples(occurrences: PatternOccurrence[]): PatternOccurrence[] {
  const selected: PatternOccurrence[] = [];
  const add = (item: PatternOccurrence | undefined) => {
    if (item && !selected.some((other) => other.event.id === item.event.id))
      selected.push(item);
  };
  add(occurrences[0]);
  add(occurrences.find((item) => item.relation === "reformulated"));
  add(occurrences.find((item) => item.relation === "returned-to-prior"));
  add(occurrences.at(-1));
  return selected.slice(0, MAX_EXAMPLES);
}

function buildPattern(
  inputs: PatternInput[],
  outcomeByEvent: Map<string, WorkflowOutcomeComparison>,
  membershipCountByEvent: Map<string, number>,
): WorkflowPattern | null {
  const representatives = representativeEvents(inputs);
  const days = uniqueSorted(
    representatives.map((item) => item.event.occurredAt.slice(0, 10)),
  );
  if (
    representatives.length < MIN_PATTERN_EPISODES
    || days.length < MIN_PATTERN_DAYS
  ) return null;
  const occurrences = occurrenceSequence(representatives);
  const first = representatives[0];
  const kind = first.event.kind;
  const signal = first.signal;
  const role = first.role;
  const relations = {
    introduced: 0,
    reinforced: 0,
    reformulated: 0,
    "returned-to-prior": 0,
  } satisfies Record<WorkflowPatternRelation, number>;
  for (const occurrence of occurrences) relations[occurrence.relation]++;
  return {
    id: hash(`workflow-pattern-v1:${patternKey(first)}`),
    kind,
    signal,
    role,
    title: patternTitle(signal, role),
    claim: patternClaim(signal, role, representatives.length),
    boundaryEffect: boundaryEffect(kind, signal),
    coverage: {
      eventMemberships: inputs.length,
      sharedEventMemberships: inputs.filter(
        (item) => (membershipCountByEvent.get(item.event.id) ?? 0) > 1,
      ).length,
      distinctEpisodes: representatives.length,
      distinctDays: days.length,
      distinctFormulations: new Set(
        representatives.map((item) => item.event.statementHash),
      ).size,
      collapsedSameEpisodeMemberships: inputs.length - representatives.length,
      projects: uniqueSorted(
        inputs.flatMap((item) => item.event.lineage.projects),
      ),
      harnesses: uniqueSorted(
        inputs.flatMap((item) => item.event.lineage.harnesses),
      ),
      firstSeenAt: representatives[0].event.occurredAt,
      lastSeenAt: representatives.at(-1)!.event.occurredAt,
      minimumDistinctEpisodes: MIN_PATTERN_EPISODES,
      minimumDistinctDays: MIN_PATTERN_DAYS,
    },
    sequence: {
      relations,
      latestRelation: occurrences.at(-1)!.relation,
      timeline: occurrences.slice(-MAX_TIMELINE).map(({ event, relation }) => ({
        eventId: event.id,
        episodeId: event.lineage.episodeId,
        occurredAt: event.occurredAt,
        relation,
        statementHash: event.statementHash,
      })),
    },
    outcomes: outcomeSummary(occurrences, outcomeByEvent),
    examples: selectExamples(occurrences).map(({ event, relation }) => ({
      eventId: event.id,
      occurredAt: event.occurredAt,
      relation,
      statement: event.statement,
      evidence: event.evidence.slice(0, 1),
    })),
  };
}

function patternsInputHash(
  structureProjectionHash: string,
  workflowContentHash: string,
  outcomesContentHash: string,
): string {
  return hash(JSON.stringify({
    schema: "chatlog/workflow-patterns-input-v1",
    structureProjectionHash,
    workflowContentHash,
    outcomesContentHash,
  }));
}

export function buildWorkflowPatterns(
  workflow: { artifact: WorkflowEvolutionArtifact; contentHash: string },
  outcomes: { artifact: WorkflowOutcomesArtifact; contentHash: string },
): WorkflowPatternsArtifact {
  if (outcomes.artifact.workflowContentHash !== workflow.contentHash)
    throw new DerivedProjectionDriftError(
      "workflow patterns require outcomes bound to the exact workflow artifact",
    );
  const groups = new Map<string, PatternInput[]>();
  for (const event of workflow.artifact.events) {
    for (const signal of eventSignals(event)) {
      for (const role of eventRoles(event)) {
        const input = { event, signal, role };
        const key = patternKey(input);
        const group = groups.get(key) ?? [];
        group.push(input);
        groups.set(key, group);
      }
    }
  }
  if (groups.size > MAX_PATTERNS)
    throw new Error("workflow pattern signature bound exceeded");
  const outcomeByEvent = new Map(
    outcomes.artifact.comparisons.map((comparison) => [
      comparison.eventId,
      comparison,
    ]),
  );
  const membershipCountByEvent = new Map<string, number>();
  for (const inputs of groups.values()) {
    for (const input of inputs) {
      membershipCountByEvent.set(
        input.event.id,
        (membershipCountByEvent.get(input.event.id) ?? 0) + 1,
      );
    }
  }
  const patterns = [...groups.values()]
    .flatMap((inputs) => {
      const pattern = buildPattern(
        inputs,
        outcomeByEvent,
        membershipCountByEvent,
      );
      return pattern ? [pattern] : [];
    })
    .sort((a, b) =>
      b.coverage.distinctEpisodes - a.coverage.distinctEpisodes
      || KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind)
      || compareText(a.signal, b.signal)
      || ROLE_ORDER.indexOf(a.role) - ROLE_ORDER.indexOf(b.role)
      || compareText(a.id, b.id)
    );
  const byKind = Object.fromEntries(
    KIND_ORDER.map((kind) => [
      kind,
      patterns.filter((pattern) => pattern.kind === kind).length,
    ]),
  ) as Record<WorkflowEventKind, number>;
  return {
    schema: "chatlog/workflow-patterns-v1",
    schemaVersion: 1,
    outputKind: "workflow-patterns",
    inputProjectionHash: patternsInputHash(
      outcomes.artifact.structureProjectionHash,
      workflow.contentHash,
      outcomes.contentHash,
    ),
    structureProjectionHash: outcomes.artifact.structureProjectionHash,
    workflowContentHash: workflow.contentHash,
    outcomesContentHash: outcomes.contentHash,
    methodology: {
      identity: "Pattern identity is workflow event kind plus one explicit signal plus one inferred agent role; multi-signal and multi-role events contribute disclosed memberships.",
      repetition: "One newest event per opaque episode is retained, and at least three distinct episodes across two UTC days are required; session lineages are not statistical independence.",
      relations: "Relations describe exact statement formulations: introduced, reinforced, reformulated, or returned to a prior formulation; verbatim recurrence may include cross-session propagation.",
      boundaryEffect: "Effect follows the explicit signal: autonomy signals expand latitude, guardrail signals impose constraints, and approval-policy membership relaxes a separate approval gate; silence never implies reversal.",
      outcomes: "Only event comparisons already meeting Workflow Outcomes coverage are aggregated; a pattern and each metric require at least three distinct episode samples.",
      causality: "Outcome directions are descriptive associations across potentially overlapping windows and do not establish that a repeated instruction caused an observed result.",
    },
    summary: {
      workflowEvents: workflow.artifact.events.length,
      candidateSignatures: groups.size,
      repeatedPatterns: patterns.length,
      belowFloorSignatures: groups.size - patterns.length,
      outcomeObservedPatterns: patterns.filter(
        (pattern) => pattern.outcomes.status === "observed",
      ).length,
      minimumDistinctEpisodes: MIN_PATTERN_EPISODES,
      minimumDistinctDays: MIN_PATTERN_DAYS,
      byKind,
    },
    patterns,
    egress: { performed: false, surface: "none", hostedCalls: 0 },
  };
}

async function currentInputs(
  root: string,
  projection: DerivedProjectionReceipt,
): Promise<{
  workflow: { artifact: WorkflowEvolutionArtifact; contentHash: string };
  outcomes: { artifact: WorkflowOutcomesArtifact; contentHash: string };
}> {
  const workflow = await loadProjectionBoundArtifact<WorkflowEvolutionArtifact>(
    root,
    "workflow-evolution-manifest.json",
    { optional: true, projection },
  );
  if (!workflow) throw new Error("workflow evolution has not been derived");
  const validatedOutcomes = await loadWorkflowOutcomes(root, {
    optional: true,
    projection,
  });
  if (!validatedOutcomes) throw new Error("workflow outcomes have not been derived");
  const outcomes = await loadCurrentDerivedArtifact<WorkflowOutcomesArtifact>(
    root,
    "workflow-outcomes-manifest.json",
    { optional: true },
  );
  if (!outcomes) throw new Error("workflow outcomes have not been derived");
  if (
    outcomes.inputProjectionHash !== outcomes.artifact.inputProjectionHash
    || outcomes.artifact.structureProjectionHash
      !== projection.structureProjectionHash
    || outcomes.artifact.workflowContentHash !== workflow.contentHash
  ) {
    throw new DerivedProjectionDriftError(
      "workflow-outcomes-manifest.json: current artifact does not match workflow and structure projections",
    );
  }
  return { workflow, outcomes };
}

export async function deriveWorkflowPatterns(root: string): Promise<{
  processed: boolean;
  artifactPath: string;
  contentHash: string;
  inputProjectionHash: string;
}> {
  const projection = await assertDerivedProjection(root);
  const { workflow, outcomes } = await currentInputs(root, projection);
  const inputProjectionHash = patternsInputHash(
    projection.structureProjectionHash,
    workflow.contentHash,
    outcomes.contentHash,
  );
  const recipeHash = hash(
    await Bun.file(import.meta.path).text()
    + "\n"
    + await Bun.file(join(import.meta.dir, "workflow-evolution.ts")).text()
    + "\n"
    + await Bun.file(join(import.meta.dir, "workflow-outcomes.ts")).text()
    + "\n"
    + await Bun.file(join(import.meta.dir, "derived-authority.ts")).text(),
  );
  const manifestPath = join(root, "derived", "workflow-patterns-manifest.json");
  let manifest: any = { version: 1 };
  try {
    manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch (error: any) {
    if (error?.code !== "ENOENT") throw error;
  }
  if (
    manifest.current?.inputProjectionHash === inputProjectionHash
    && manifest.current?.recipeHash === recipeHash
  ) {
    try {
      const current = await loadCurrentDerivedArtifact<WorkflowPatternsArtifact>(
        root,
        "workflow-patterns-manifest.json",
      );
      if (
        current?.inputProjectionHash === inputProjectionHash
        && current.artifact?.structureProjectionHash
          === projection.structureProjectionHash
        && current.artifact?.workflowContentHash === workflow.contentHash
        && current.artifact?.outcomesContentHash === outcomes.contentHash
      ) {
        return {
          processed: false,
          artifactPath: join(root, "derived", manifest.current.artifactPath),
          contentHash: manifest.current.contentHash,
          inputProjectionHash,
        };
      }
    } catch (error) {
      if (!(error instanceof DerivedProjectionDriftError)) throw error;
    }
  }
  const artifact = buildWorkflowPatterns(workflow, outcomes);
  const text = JSON.stringify(artifact, null, 2) + "\n";
  const contentHash = hash(text);
  const artifactRel =
    `workflow-patterns/${contentHash.slice(0, 2)}/${contentHash}.json`;
  await durableAtomicWrite(join(root, "derived", artifactRel), text, {
    maxBytes: 64 * 1024 * 1024,
  });
  manifest.current = {
    inputProjectionHash,
    recipeHash,
    artifactPath: artifactRel,
    contentHash,
  };
  await durableAtomicWrite(
    manifestPath,
    JSON.stringify(manifest, null, 2) + "\n",
    { maxBytes: 1024 * 1024 },
  );
  return {
    processed: true,
    artifactPath: join(root, "derived", artifactRel),
    contentHash,
    inputProjectionHash,
  };
}

export async function loadWorkflowPatterns(
  root: string,
  options: {
    optional?: boolean;
    projection?: DerivedProjectionReceipt;
  } = {},
): Promise<WorkflowPatternsArtifact | null> {
  const projection = options.projection ?? await assertDerivedProjection(root);
  const { workflow, outcomes } = await currentInputs(root, projection);
  const expectedInputHash = patternsInputHash(
    projection.structureProjectionHash,
    workflow.contentHash,
    outcomes.contentHash,
  );
  const current = await loadCurrentDerivedArtifact<WorkflowPatternsArtifact>(
    root,
    "workflow-patterns-manifest.json",
    { optional: options.optional },
  );
  if (!current) return null;
  if (
    current.inputProjectionHash !== expectedInputHash
    || current.artifact.inputProjectionHash !== expectedInputHash
    || current.artifact.structureProjectionHash
      !== projection.structureProjectionHash
    || current.artifact.workflowContentHash !== workflow.contentHash
    || current.artifact.outcomesContentHash !== outcomes.contentHash
  ) {
    throw new DerivedProjectionDriftError(
      "workflow-patterns-manifest.json: current artifact does not match workflow and outcome projections",
    );
  }
  return current.artifact;
}
