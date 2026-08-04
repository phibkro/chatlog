import { createHash } from "node:crypto";
import {
  activeInsightRevisions,
  insightCurrentPointerHash,
  type InsightCurrentPointer,
  type InsightKind,
  type InsightProjection,
  type InsightRevision,
  type InsightScope,
} from "./insights";
import { stableStringify } from "./events";

export const INSIGHT_COMPILED_SCHEMA_VERSION = 2 as const;
export const SUPPORTED_INSIGHT_RISK_CLASSES: ReadonlySet<InsightRevision["riskClass"]> = new Set([
  "low",
  "medium",
  "high",
]);
const TARGET_TOKENS = 1_500;
const MAX_TOKENS = 2_000;

export interface CompiledInsightEntry {
  id: string;
  kind: InsightKind;
  proposition: string;
  procedure: string | null;
  scope: InsightScope;
  validTime: { start: string; end: string | null };
  supportEvidence: string[];
  counterEvidence: string[];
}

export interface CompiledInsightSnapshot {
  schemaVersion: typeof INSIGHT_COMPILED_SCHEMA_VERSION;
  ledgerHash: string;
  projectIdentity: string;
  compiledAt: string;
  compiledStateHash: string;
  outputHash: string;
  content: string;
  bytes: number;
  estimatedTokens: number;
  withinTarget: boolean;
  entryIds: string[];
  entries: CompiledInsightEntry[];
}

export type ConsolidationKind =
  | "duplicate"
  | "contradiction"
  | "supersession"
  | "expiry"
  | "scope-correction";

export interface ConsolidationProposal {
  schemaVersion: 2;
  proposalId: string;
  kind: ConsolidationKind;
  leftRevisionId: string;
  rightRevisionId: string | null;
  reason: string;
  supportEvidence: string[];
  counterEvidence: string[];
  validTime: { left: InsightRevision["validTime"]; right: InsightRevision["validTime"] | null };
  applied: false;
}

export interface InsightCompileOptions {
  projectIdentity?: string;
  now?: Date;
  scope?: Partial<InsightScope>;
  supportedRiskClasses?: ReadonlySet<"low" | "medium" | "high">;
  activeEvidence?: ReadonlySet<string>;
  staleRevisionIds?: ReadonlySet<string>;
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function estimate(content: string): number {
  return Math.ceil(new TextEncoder().encode(content).byteLength / 3);
}

function scopeMatches(scope: InsightScope, requested: Partial<InsightScope>): boolean {
  return Object.entries(requested).every(([axis, value]) => {
    if (value === undefined || value === null) return true;
    return scope[axis as keyof InsightScope] === value;
  });
}

function evidenceAvailable(
  revision: InsightRevision,
  activeEvidence?: ReadonlySet<string>,
): boolean {
  return (
    activeEvidence === undefined ||
    [...revision.supportEvidence, ...revision.counterEvidence].every((uri) =>
      activeEvidence.has(uri),
    )
  );
}

function noUnresolvedConflict(
  revision: InsightRevision,
  current: Record<string, InsightRevision>,
): boolean {
  return revision.conflictsWith.every((id) => {
    const other = current[id];
    return !other || other.status !== "active";
  });
}

function riskSupported(
  revision: InsightRevision,
  supported: ReadonlySet<"low" | "medium" | "high">,
): boolean {
  const risk =
    (revision as InsightRevision & { riskClass?: "low" | "medium" | "high" | null }).riskClass ??
    "low";
  return supported.has(risk);
}

function renderScope(scope: InsightScope): string {
  const parts = Object.entries(scope)
    .filter(([, value]) => value !== null && value !== undefined)
    .map(([key, value]) => `${key}:${value}`);
  return parts.join(",") || "global";
}

function renderTierOne(entries: readonly CompiledInsightEntry[]): string {
  return `${entries
    .map((entry) => {
      const trigger = entry.proposition.replace(/\s+/gu, " ").trim().slice(0, 240);
      const action =
        entry.procedure?.replace(/\s+/gu, " ").trim().slice(0, 240) ??
        "recall the current insight card";
      return [
        `## ${entry.id}`,
        `- USE WHEN: ${trigger}`,
        `- Scope: ${renderScope(entry.scope)}`,
        `- Kind: ${entry.kind}`,
        `- Action: ${action}`,
      ].join("\n");
    })
    .join("\n\n")}\n`;
}

function eligible(
  revision: InsightRevision,
  projection: InsightProjection,
  options: Required<Pick<InsightCompileOptions, "now" | "supportedRiskClasses">> &
    InsightCompileOptions,
): boolean {
  if (revision.status !== "active") return false;
  if (options.staleRevisionIds?.has(revision.revisionId)) return false;
  if (!scopeMatches(revision.scope, options.scope ?? {})) return false;
  const now = options.now.getTime();
  const start = Date.parse(revision.validTime.start);
  const end =
    revision.validTime.end === null ? Number.POSITIVE_INFINITY : Date.parse(revision.validTime.end);
  if (!(start <= now && now < end)) return false;
  if (!evidenceAvailable(revision, options.activeEvidence)) return false;
  if (
    !revision.authority.some(
      (record) => record.kind === "human-review" || record.kind === "human-assertion",
    )
  )
    return false;
  if (!noUnresolvedConflict(revision, projection.current)) return false;
  if (revision.duplicateOf !== null) return false;
  return riskSupported(revision, options.supportedRiskClasses);
}

export function compileInsightProjection(
  projection: InsightProjection,
  options: InsightCompileOptions = {},
): { ok: true; value: CompiledInsightSnapshot } | { ok: false; error: string } {
  const now = options.now ?? new Date();
  const compiledAt = now.toISOString();
  const supportedRiskClasses =
    options.supportedRiskClasses ?? new Set<"low" | "medium" | "high">(["low", "medium"]);
  const revisions = activeInsightRevisions(projection, now)
    .filter((revision) => eligible(revision, projection, { ...options, now, supportedRiskClasses }))
    .toSorted(
      (left, right) =>
        left.insightId.localeCompare(right.insightId) ||
        left.revisionId.localeCompare(right.revisionId),
    );
  const entries: CompiledInsightEntry[] = revisions.map((revision) => ({
    id: revision.insightId,
    kind: revision.kind,
    proposition: revision.proposition,
    procedure: revision.procedure,
    scope: { ...revision.scope },
    validTime: { ...revision.validTime },
    supportEvidence: [...revision.supportEvidence],
    counterEvidence: [...revision.counterEvidence],
  }));
  const stateBytes = stableStringify({
    compiledAt,
    ledgerHash: projection.ledgerHash,
    projectIdentity: projection.projectIdentity,
    revisions,
  });
  const content = renderTierOne(entries);
  const estimatedTokens = estimate(content);
  if (estimatedTokens > MAX_TOKENS)
    return { ok: false, error: `compiled Tier 1 snapshot exceeds ${MAX_TOKENS} tokens` };
  const outputHash = hash(content);
  return {
    ok: true,
    value: {
      schemaVersion: INSIGHT_COMPILED_SCHEMA_VERSION,
      ledgerHash: projection.ledgerHash,
      projectIdentity: options.projectIdentity ?? projection.projectIdentity,
      compiledAt,
      compiledStateHash: hash(stateBytes),
      outputHash,
      content,
      bytes: new TextEncoder().encode(content).byteLength,
      estimatedTokens,
      withinTarget: estimatedTokens <= TARGET_TOKENS,
      entryIds: entries.map((entry) => entry.id),
      entries,
    },
  };
}

export function proposeInsightConsolidations(
  projection: InsightProjection,
  now = new Date(),
): ConsolidationProposal[] {
  const revisions = Object.values(projection.current)
    .filter((revision) => revision.status === "active" || revision.status === "disputed")
    .toSorted((left, right) => left.revisionId.localeCompare(right.revisionId));
  const proposals: ConsolidationProposal[] = [];
  const add = (
    kind: ConsolidationKind,
    left: InsightRevision,
    right: InsightRevision | null,
    reason: string,
    supportEvidence: string[],
    counterEvidence: string[],
  ): void => {
    const seed = `${kind}:${left.revisionId}:${right?.revisionId ?? ""}:${reason}`;
    proposals.push({
      schemaVersion: 2,
      proposalId: `con-${hash(seed).slice(0, 40)}`,
      kind,
      leftRevisionId: left.revisionId,
      rightRevisionId: right?.revisionId ?? null,
      reason,
      supportEvidence: [...supportEvidence].toSorted(),
      counterEvidence: [...counterEvidence].toSorted(),
      validTime: { left: { ...left.validTime }, right: right ? { ...right.validTime } : null },
      applied: false,
    });
  };
  for (const revision of revisions) {
    if (revision.validTime.end !== null && Date.parse(revision.validTime.end) <= now.getTime())
      add(
        "expiry",
        revision,
        null,
        "valid time has ended",
        revision.supportEvidence,
        revision.counterEvidence,
      );
    for (const other of revisions) {
      if (revision.revisionId >= other.revisionId) continue;
      const sameIdentity =
        revision.kind === other.kind && revision.proposition === other.proposition;
      if (sameIdentity && JSON.stringify(revision.scope) === JSON.stringify(other.scope))
        add(
          "duplicate",
          revision,
          other,
          "same semantic kind, proposition, and scope",
          [...revision.supportEvidence, ...other.supportEvidence],
          [...revision.counterEvidence, ...other.counterEvidence],
        );
      else if (
        revision.kind === other.kind &&
        revision.scope.domain === other.scope.domain &&
        revision.proposition !== other.proposition
      )
        add(
          "contradiction",
          revision,
          other,
          "same kind and domain with different propositions; operator review required",
          [...revision.supportEvidence, ...other.supportEvidence],
          [...revision.counterEvidence, ...other.counterEvidence],
        );
      else if (
        revision.proposition === other.proposition &&
        JSON.stringify(revision.scope) !== JSON.stringify(other.scope)
      )
        add(
          "scope-correction",
          revision,
          other,
          "same proposition has different scopes",
          [...revision.supportEvidence, ...other.supportEvidence],
          [...revision.counterEvidence, ...other.counterEvidence],
        );
      else if (
        revision.kind === other.kind &&
        revision.scope.domain === other.scope.domain &&
        revision.validTime.end === other.validTime.start
      )
        add(
          "supersession",
          revision,
          other,
          "adjacent valid-time intervals require explicit replacement review",
          [...revision.supportEvidence, ...other.supportEvidence],
          [...revision.counterEvidence, ...other.counterEvidence],
        );
    }
  }
  return proposals.toSorted((left, right) => left.proposalId.localeCompare(right.proposalId));
}

export function makeInsightCurrentPointer(input: {
  projectIdentity: string;
  inputProjectionHash: string;
  sourceAuthorityHash: string;
  recipeHashes: Record<string, string>;
  ledgerHash: string;
  compiledAt: string;
  compiledStateHash: string;
  outputHash: string;
}): InsightCurrentPointer {
  return {
    schemaVersion: 2,
    ...input,
  };
}

export function currentPointerOutputHash(
  pointer: Omit<InsightCurrentPointer, "outputHash">,
): string {
  return insightCurrentPointerHash(pointer);
}
