import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  assertDerivedProjection,
  DerivedProjectionDriftError,
  loadCurrentDerivedArtifact,
  loadProjectionBoundArtifact,
  type DerivedProjectionReceipt,
} from "./derived-authority";
import type { DerivedConversation } from "./derive";
import { durableAtomicWrite } from "./durable-fs";
import type { Conversation, TokenUsage } from "./types";
import {
  workflowEpisodeId,
  type WorkflowEvent,
  type WorkflowEvolutionArtifact,
} from "./workflow-evolution";

export type WorkflowOutcomeStatus =
  | "observed"
  | "insufficient-coverage";

export interface WorkflowWindowMetrics {
  episodes: number;
  outcomes: {
    known: number;
    success: number;
    failure: number;
    mixed: number;
    unknown: number;
    completionRate: number | null;
  };
  friction: {
    episodes: number;
    rate: number | null;
    problemSignals: number;
  };
  rework: {
    knownAttempts: number;
    failedAttempts: number;
    rate: number | null;
  };
  sessionShape: {
    medianTurns: number | null;
    medianDurationMinutes: number | null;
  };
  tokensBySource: Array<{
    provider: string;
    harness: string;
    samples: number;
    medianReportedTokens: number;
  }>;
}

export interface WorkflowOutcomeComparison {
  eventId: string;
  kind: WorkflowEvent["kind"];
  occurredAt: string;
  status: WorkflowOutcomeStatus;
  reasons: string[];
  scope: {
    projects: string[];
    maximumWindowDays: 14;
    observedWindowHours: number;
    preStart: string | null;
    postEnd: string | null;
  };
  coverage: {
    scopedConversations: number;
    representativeEpisodes: number;
    excludedEventEpisode: number;
    excludedSpanningAnchor: number;
    excludedOutsideWindow: number;
    preEpisodes: number;
    postEpisodes: number;
    minimumEpisodesPerSide: 5;
  };
  pre: WorkflowWindowMetrics;
  post: WorkflowWindowMetrics;
  deltas: {
    completionRate: number | null;
    frictionRate: number | null;
    reworkRate: number | null;
    medianTurns: number | null;
    medianDurationMinutes: number | null;
    reportedTokensBySource: Array<{
      provider: string;
      harness: string;
      preSamples: number;
      postSamples: number;
      medianChange: number;
    }>;
  };
  interpretation: {
    claim: string;
    causal: false;
  };
}

export interface WorkflowOutcomesArtifact {
  schema: "chatlog/workflow-outcomes-v1";
  schemaVersion: 1;
  outputKind: "workflow-outcomes";
  inputProjectionHash: string;
  structureProjectionHash: string;
  workflowContentHash: string;
  observationBounds: {
    firstEndedAt: string | null;
    lastEndedAt: string | null;
  };
  methodology: {
    unit: string;
    window: string;
    scope: string;
    metrics: string;
    tokens: string;
    causality: string;
  };
  summary: {
    events: number;
    observed: number;
    insufficientCoverage: number;
  };
  approvalGateTracer: WorkflowOutcomeComparison | null;
  comparisons: WorkflowOutcomeComparison[];
  egress: {
    performed: false;
    surface: "none";
    hostedCalls: 0;
  };
}

interface Observation {
  contentHash: string;
  episodeId: string;
  provider: string;
  harness: string;
  project: string;
  startedAt: string;
  endedAt: string;
  turns: number;
  durationMinutes: number | null;
  outcome: DerivedConversation["outcome"]["status"];
  problems: number;
  knownAttempts: number;
  failedAttempts: number;
  reportedTokens: number | null;
}

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const MAX_WINDOW_DAYS = 14 as const;
const MAX_WINDOW = MAX_WINDOW_DAYS * DAY;
const MIN_WINDOW = DAY;
const MIN_EPISODES = 5;
const MIN_METRIC_SAMPLES = 3;

function hash(text: string): string {
  return new Bun.CryptoHasher("sha256").update(text).digest("hex");
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function round(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

function reportedTokens(tokens: TokenUsage): number | null {
  if (finite(tokens.total)) return tokens.total;
  const pieces = [tokens.input, tokens.output].filter(finite);
  return pieces.length ? pieces.reduce((total, value) => total + value, 0) : null;
}

function validTimestamp(value: string, label: string): string {
  if (Number.isNaN(Date.parse(value))) throw new Error(`invalid ${label} timestamp`);
  return new Date(value).toISOString();
}

async function loadObservation(
  root: string,
  conversationHash: string,
  expectedStructureHash: string,
): Promise<Observation> {
  const canonical = JSON.parse(await readFile(
    join(root, "corpus", "objects", conversationHash.slice(0, 2), `${conversationHash}.json`),
    "utf8",
  )) as Conversation;
  if (canonical.contentHash !== conversationHash)
    throw new Error(`canonical conversation hash mismatch: ${conversationHash}`);
  const derivedText = await readFile(
    join(root, "derived", "objects", conversationHash.slice(0, 2), `${conversationHash}.json`),
    "utf8",
  );
  if (hash(derivedText) !== expectedStructureHash)
    throw new DerivedProjectionDriftError(
      `derived structure failed integrity validation: ${conversationHash}`,
    );
  const derived = JSON.parse(derivedText) as DerivedConversation;
  if (derived.conversationHash !== conversationHash)
    throw new Error(`derived conversation hash mismatch: ${conversationHash}`);
  const startedAt = validTimestamp(canonical.startedAt, "conversation start");
  const endedAt = validTimestamp(canonical.endedAt, "conversation end");
  const duration = Date.parse(endedAt) - Date.parse(startedAt);
  const knownAttempts = derived.attempts.filter((attempt) => attempt.outcome !== "unknown").length;
  return {
    contentHash: conversationHash,
    episodeId: workflowEpisodeId(canonical),
    provider: canonical.provider,
    harness: canonical.harness,
    project: canonical.project,
    startedAt,
    endedAt,
    turns: derived.metrics.turns,
    durationMinutes: duration >= 0 ? round(duration / 60_000) : null,
    outcome: derived.outcome.status,
    problems: derived.problems.length,
    knownAttempts,
    failedAttempts: derived.attempts.filter((attempt) => attempt.outcome === "failure").length,
    reportedTokens: reportedTokens(derived.metrics.tokens),
  };
}

function representativeEpisodes(observations: Observation[]): Observation[] {
  const representatives = new Map<string, Observation>();
  for (const observation of observations) {
    const key = `${observation.episodeId}\u0000${observation.project}`;
    const prior = representatives.get(key);
    if (
      !prior
      || compareText(observation.endedAt, prior.endedAt) > 0
      || (
        observation.endedAt === prior.endedAt
        && (
          observation.turns > prior.turns
          || (
            observation.turns === prior.turns
            && compareText(observation.contentHash, prior.contentHash) > 0
          )
        )
      )
    ) representatives.set(key, observation);
  }
  return [...representatives.values()].sort((a, b) =>
    compareText(a.endedAt, b.endedAt)
    || compareText(a.episodeId, b.episodeId)
    || compareText(a.project, b.project)
  );
}

function windowMetrics(observations: Observation[]): WorkflowWindowMetrics {
  const successes = observations.filter((item) => item.outcome === "success").length;
  const failures = observations.filter((item) => item.outcome === "failure").length;
  const mixed = observations.filter((item) => item.outcome === "mixed").length;
  const unknown = observations.filter((item) => item.outcome === "unknown").length;
  const known = successes + failures + mixed;
  const frictionEpisodes = observations.filter((item) => item.problems > 0).length;
  const knownAttempts = observations.reduce((total, item) => total + item.knownAttempts, 0);
  const failedAttempts = observations.reduce((total, item) => total + item.failedAttempts, 0);
  const durations = observations.flatMap((item) =>
    item.durationMinutes == null ? [] : [item.durationMinutes]
  );
  const tokenGroups = new Map<string, { provider: string; harness: string; values: number[] }>();
  for (const observation of observations) {
    if (observation.reportedTokens == null) continue;
    const key = `${observation.provider}\u0000${observation.harness}`;
    const group = tokenGroups.get(key) ?? {
      provider: observation.provider,
      harness: observation.harness,
      values: [],
    };
    group.values.push(observation.reportedTokens);
    tokenGroups.set(key, group);
  }
  const tokensBySource = [...tokenGroups.values()]
    .filter((group) => group.values.length >= MIN_METRIC_SAMPLES)
    .map((group) => ({
      provider: group.provider,
      harness: group.harness,
      samples: group.values.length,
      medianReportedTokens: median(group.values)!,
    }))
    .sort((a, b) =>
      compareText(a.provider, b.provider) || compareText(a.harness, b.harness)
    );
  return {
    episodes: observations.length,
    outcomes: {
      known,
      success: successes,
      failure: failures,
      mixed,
      unknown,
      completionRate: known >= MIN_METRIC_SAMPLES ? round(successes / known) : null,
    },
    friction: {
      episodes: frictionEpisodes,
      rate: observations.length >= MIN_METRIC_SAMPLES
        ? round(frictionEpisodes / observations.length)
        : null,
      problemSignals: observations.reduce((total, item) => total + item.problems, 0),
    },
    rework: {
      knownAttempts,
      failedAttempts,
      rate: knownAttempts >= MIN_METRIC_SAMPLES
        ? round(failedAttempts / knownAttempts)
        : null,
    },
    sessionShape: {
      medianTurns: median(observations.map((item) => item.turns)),
      medianDurationMinutes: durations.length >= MIN_METRIC_SAMPLES
        ? median(durations)
        : null,
    },
    tokensBySource,
  };
}

function metricDelta(pre: number | null, post: number | null): number | null {
  return pre == null || post == null ? null : round(post - pre);
}

function tokenDeltas(
  pre: WorkflowWindowMetrics,
  post: WorkflowWindowMetrics,
): WorkflowOutcomeComparison["deltas"]["reportedTokensBySource"] {
  const postBySource = new Map(
    post.tokensBySource.map((item) => [`${item.provider}\u0000${item.harness}`, item]),
  );
  return pre.tokensBySource.flatMap((before) => {
    const after = postBySource.get(`${before.provider}\u0000${before.harness}`);
    return after ? [{
      provider: before.provider,
      harness: before.harness,
      preSamples: before.samples,
      postSamples: after.samples,
      medianChange: round(after.medianReportedTokens - before.medianReportedTokens),
    }] : [];
  });
}

function comparisonForEvent(
  event: WorkflowEvent,
  observations: Observation[],
  firstEndedAt: string | null,
  lastEndedAt: string | null,
): WorkflowOutcomeComparison {
  const projects = [...new Set(event.lineage.projects)].sort(compareText);
  const anchor = Date.parse(event.occurredAt);
  const first = firstEndedAt == null ? anchor : Date.parse(firstEndedAt);
  const last = lastEndedAt == null ? anchor : Date.parse(lastEndedAt);
  const radius = Math.max(
    0,
    Math.floor(Math.min(MAX_WINDOW, anchor - first, last - anchor) / HOUR) * HOUR,
  );
  const scoped = observations.filter((item) => projects.includes(item.project));
  const eventExcluded = representativeEpisodes(
    scoped.filter((item) => item.episodeId === event.lineage.episodeId),
  );
  const representatives = representativeEpisodes(
    scoped.filter((item) => item.episodeId !== event.lineage.episodeId),
  );
  const spanning = representatives.filter((item) =>
    Date.parse(item.startedAt) < anchor && Date.parse(item.endedAt) > anchor
  );
  const pre = representatives.filter((item) => {
    const startedAt = Date.parse(item.startedAt);
    const endedAt = Date.parse(item.endedAt);
    return startedAt <= endedAt
      && startedAt >= anchor - radius
      && endedAt < anchor;
  });
  const post = representatives.filter((item) => {
    const startedAt = Date.parse(item.startedAt);
    const endedAt = Date.parse(item.endedAt);
    return startedAt <= endedAt
      && startedAt >= anchor
      && endedAt > anchor
      && endedAt <= anchor + radius;
  });
  const selected = new Set([...spanning, ...pre, ...post]);
  const outsideWindow = representatives.filter((item) => !selected.has(item));
  const reasons: string[] = [];
  if (!projects.length) reasons.push("no-project-scope");
  if (radius < MIN_WINDOW) reasons.push("observation-window-under-24h");
  if (pre.length < MIN_EPISODES)
    reasons.push(`pre-episodes-below-${MIN_EPISODES}`);
  if (post.length < MIN_EPISODES)
    reasons.push(`post-episodes-below-${MIN_EPISODES}`);
  const status: WorkflowOutcomeStatus = reasons.length
    ? "insufficient-coverage"
    : "observed";
  const preMetrics = windowMetrics(pre);
  const postMetrics = windowMetrics(post);
  return {
    eventId: event.id,
    kind: event.kind,
    occurredAt: event.occurredAt,
    status,
    reasons,
    scope: {
      projects,
      maximumWindowDays: MAX_WINDOW_DAYS,
      observedWindowHours: radius / HOUR,
      preStart: radius ? new Date(anchor - radius).toISOString() : null,
      postEnd: radius ? new Date(anchor + radius).toISOString() : null,
    },
    coverage: {
      scopedConversations: scoped.length,
      representativeEpisodes: representatives.length,
      excludedEventEpisode: eventExcluded.length,
      excludedSpanningAnchor: spanning.length,
      excludedOutsideWindow: outsideWindow.length,
      preEpisodes: pre.length,
      postEpisodes: post.length,
      minimumEpisodesPerSide: MIN_EPISODES,
    },
    pre: preMetrics,
    post: postMetrics,
    deltas: {
      completionRate: status === "observed"
        ? metricDelta(preMetrics.outcomes.completionRate, postMetrics.outcomes.completionRate)
        : null,
      frictionRate: status === "observed"
        ? metricDelta(preMetrics.friction.rate, postMetrics.friction.rate)
        : null,
      reworkRate: status === "observed"
        ? metricDelta(preMetrics.rework.rate, postMetrics.rework.rate)
        : null,
      medianTurns: status === "observed"
        ? metricDelta(preMetrics.sessionShape.medianTurns, postMetrics.sessionShape.medianTurns)
        : null,
      medianDurationMinutes: status === "observed"
        ? metricDelta(
          preMetrics.sessionShape.medianDurationMinutes,
          postMetrics.sessionShape.medianDurationMinutes,
        )
        : null,
      reportedTokensBySource: status === "observed"
        ? tokenDeltas(preMetrics, postMetrics)
        : [],
    },
    interpretation: {
      claim: status === "observed"
        ? "These proxy deltas were observed in symmetric project-scoped windows around the workflow event."
        : "The project-scoped window is retained for inspection, but coverage is below the declared comparison floor.",
      causal: false,
    },
  };
}

function outcomesInputHash(
  structureProjectionHash: string,
  workflowContentHash: string,
): string {
  return hash(JSON.stringify({
    schema: "chatlog/workflow-outcomes-input-v1",
    structureProjectionHash,
    workflowContentHash,
  }));
}

async function currentWorkflow(
  root: string,
  projection: DerivedProjectionReceipt,
) {
  const workflow = await loadProjectionBoundArtifact<WorkflowEvolutionArtifact>(
    root,
    "workflow-evolution-manifest.json",
    { optional: true, projection },
  );
  if (!workflow) throw new Error("workflow evolution has not been derived");
  return workflow;
}

export async function buildWorkflowOutcomes(
  root: string,
  projection?: DerivedProjectionReceipt,
  workflow?: { artifact: WorkflowEvolutionArtifact; contentHash: string },
): Promise<WorkflowOutcomesArtifact> {
  const currentProjection = projection ?? await assertDerivedProjection(root);
  const workflowCurrent = workflow ?? await currentWorkflow(root, currentProjection);
  const observations: Observation[] = [];
  for (const conversationHash of currentProjection.conversationHashes) {
    const expectedStructureHash =
      currentProjection.structureContentHashes[conversationHash];
    if (!expectedStructureHash)
      throw new DerivedProjectionDriftError(
        `derived projection has no structure hash for ${conversationHash}`,
      );
    observations.push(await loadObservation(
      root,
      conversationHash,
      expectedStructureHash,
    ));
  }
  const ended = observations.map((item) => item.endedAt).sort(compareText);
  const firstEndedAt = ended[0] ?? null;
  const lastEndedAt = ended.at(-1) ?? null;
  const comparisons = workflowCurrent.artifact.events
    .map((event) => comparisonForEvent(event, observations, firstEndedAt, lastEndedAt))
    .sort((a, b) =>
      compareText(a.occurredAt, b.occurredAt) || compareText(a.eventId, b.eventId)
    );
  const approvalId = workflowCurrent.artifact.tracers.approvalGate?.id;
  return {
    schema: "chatlog/workflow-outcomes-v1",
    schemaVersion: 1,
    outputKind: "workflow-outcomes",
    inputProjectionHash: outcomesInputHash(
      currentProjection.structureProjectionHash,
      workflowCurrent.contentHash,
    ),
    structureProjectionHash: currentProjection.structureProjectionHash,
    workflowContentHash: workflowCurrent.contentHash,
    observationBounds: { firstEndedAt, lastEndedAt },
    methodology: {
      unit: "One newest completed active conversation snapshot per provider/harness/session/project lineage.",
      window: "Symmetric corpus-relative windows of at most 14 days, rounded down to a full hour; episodes must be fully contained, and event plus anchor-spanning episodes are excluded.",
      scope: "Only projects observed on the workflow event are included.",
      metrics: "Completion, friction, and rework are derived proxies with explicit denominators and minimum sample floors.",
      tokens: "Provider-reported token medians are compared only within the same provider and harness with at least three samples per side.",
      causality: "Temporal association is descriptive and cannot establish that the workflow event caused an observed delta.",
    },
    summary: {
      events: comparisons.length,
      observed: comparisons.filter((item) => item.status === "observed").length,
      insufficientCoverage: comparisons.filter(
        (item) => item.status === "insufficient-coverage",
      ).length,
    },
    approvalGateTracer: approvalId
      ? comparisons.find((item) => item.eventId === approvalId) ?? null
      : null,
    comparisons,
    egress: { performed: false, surface: "none", hostedCalls: 0 },
  };
}

export async function deriveWorkflowOutcomes(root: string): Promise<{
  processed: boolean;
  artifactPath: string;
  contentHash: string;
  inputProjectionHash: string;
}> {
  const projection = await assertDerivedProjection(root);
  const workflow = await currentWorkflow(root, projection);
  const inputProjectionHash = outcomesInputHash(
    projection.structureProjectionHash,
    workflow.contentHash,
  );
  const recipeHash = hash(
    await Bun.file(import.meta.path).text()
    + "\n"
    + await Bun.file(join(import.meta.dir, "derive.ts")).text()
    + "\n"
    + await Bun.file(join(import.meta.dir, "derived-authority.ts")).text()
    + "\n"
    + await Bun.file(join(import.meta.dir, "workflow-evolution.ts")).text(),
  );
  const manifestPath = join(root, "derived", "workflow-outcomes-manifest.json");
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
      const current = await loadCurrentDerivedArtifact<WorkflowOutcomesArtifact>(
        root,
        "workflow-outcomes-manifest.json",
      );
      if (
        current?.inputProjectionHash === inputProjectionHash
        && current.artifact?.structureProjectionHash === projection.structureProjectionHash
        && current.artifact?.workflowContentHash === workflow.contentHash
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
  const artifact = await buildWorkflowOutcomes(root, projection, workflow);
  const text = JSON.stringify(artifact, null, 2) + "\n";
  const contentHash = hash(text);
  const artifactRel = `workflow-outcomes/${contentHash.slice(0, 2)}/${contentHash}.json`;
  await durableAtomicWrite(join(root, "derived", artifactRel), text, {
    maxBytes: 64 * 1024 * 1024,
  });
  manifest.current = {
    inputProjectionHash,
    recipeHash,
    artifactPath: artifactRel,
    contentHash,
  };
  await durableAtomicWrite(manifestPath, JSON.stringify(manifest, null, 2) + "\n", {
    maxBytes: 1024 * 1024,
  });
  return {
    processed: true,
    artifactPath: join(root, "derived", artifactRel),
    contentHash,
    inputProjectionHash,
  };
}

export async function loadWorkflowOutcomes(
  root: string,
  options: { optional?: boolean; projection?: DerivedProjectionReceipt } = {},
): Promise<WorkflowOutcomesArtifact | null> {
  const projection = options.projection ?? await assertDerivedProjection(root);
  const workflow = await currentWorkflow(root, projection);
  const expectedInputHash = outcomesInputHash(
    projection.structureProjectionHash,
    workflow.contentHash,
  );
  const current = await loadCurrentDerivedArtifact<WorkflowOutcomesArtifact>(
    root,
    "workflow-outcomes-manifest.json",
    { optional: options.optional },
  );
  if (!current) return null;
  if (
    current.inputProjectionHash !== expectedInputHash
    || current.artifact.inputProjectionHash !== expectedInputHash
    || current.artifact.structureProjectionHash !== projection.structureProjectionHash
    || current.artifact.workflowContentHash !== workflow.contentHash
  ) {
    throw new DerivedProjectionDriftError(
      "workflow-outcomes-manifest.json: current artifact does not match workflow and structure projections",
    );
  }
  return current.artifact;
}
