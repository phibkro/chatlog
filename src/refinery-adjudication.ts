import { redact } from "./redact";
import type { PromotionCandidate, RefineryArtifact } from "./refinery";

export const REFINERY_CHALLENGE_IDS = [
  "1ad36ba6c1fb7fb08211",
  "74e94149e4337a28f731",
  "2b30fe00a74088a7d8e6",
  "dc281ccc417ad9a65d00",
  "db6cfef5927487273969",
  "0e26687832b89604a4b9",
  "813434c9909b44190093",
  "b3df9468fc44c5fd089e",
  "d1e7c4a3455a73033067",
  "7819705d83ee3de7090e",
  "707c237feeef2547ca2f",
] as const;

export const ADJUDICATION_SELECTION_RECIPE = "refinery-human-adjudication-v3";
export const DEFAULT_ADJUDICATION_SEED = "refinery-human-gold-v1";

export type CandidateStratum = "low" | "middle" | "high";
export type HumanVerdict = "genuine" | "boilerplate" | "mixed";
export type HumanDecisionStatus = "unanswered" | "decided" | "insufficient-context";

export interface PublicPacketEvidence {
  evidenceId: string;
  sessionAlias: string;
  projectAlias: string;
  harnessAlias: string;
  snippet: string;
}

export interface PublicPacketCandidate {
  candidateAlias: string;
  signatureTheme: string;
  evidence: PublicPacketEvidence[];
}

export interface AdjudicationPacket {
  schemaVersion: 2;
  packetHash: string;
  sourceBindingHash: string;
  blinded: true;
  selectionRecipe: typeof ADJUDICATION_SELECTION_RECIPE;
  instructions: {
    untrustedEvidence: true;
    verdicts: Record<HumanVerdict, string>;
    evidence: string;
    insufficientContext: string;
  };
  candidates: PublicPacketCandidate[];
}

export type HumanAdjudicationAnswer =
  | {
      status: "unanswered";
      verdict: null;
      genuineEvidenceIds: [];
      confidence: null;
      reasoning: "";
    }
  | {
      status: "insufficient-context";
      verdict: null;
      genuineEvidenceIds: [];
      confidence: null;
      reasoning: string;
    }
  | {
      status: "decided";
      verdict: HumanVerdict;
      genuineEvidenceIds: string[];
      confidence: "low" | "medium" | "high";
      reasoning: string;
    };

export interface HumanAdjudicationAnswers {
  schemaVersion: 2;
  packetHash: string;
  adjudicator: { id: string };
  answers: Record<string, HumanAdjudicationAnswer>;
}

export interface PrivateEvidenceMapping {
  evidenceId: string;
  sourceIndex: number;
  pointerUri: string;
  conversationHash: string;
  sessionId: string;
  project: string;
  harness: string;
}

export interface PrivateCandidateMapping {
  candidateAlias: string;
  candidateId: string;
  type: PromotionCandidate["type"];
  stratum: CandidateStratum;
  signatureFamily: string;
  evidence: PrivateEvidenceMapping[];
}

export interface AdjudicationPrivateManifest {
  schemaVersion: 2;
  packetHash: string;
  sourceBindingHash: string;
  source: {
    inputProjectionHash: string;
    refineryRecipeHash: string;
    refineryThreshold: number;
    refineryCandidates: number;
  };
  selection: {
    recipe: typeof ADJUDICATION_SELECTION_RECIPE;
    seed: string;
    requested: number;
    selected: number;
    fixedChallengeCandidatesAvailable: number;
    artifactStratumSizes: Record<CandidateStratum, number>;
    selectedStrata: Record<CandidateStratum, number>;
    selectedTypes: Partial<Record<PromotionCandidate["type"], number>>;
    targetTypes: Partial<Record<PromotionCandidate["type"], number>>;
    shortages: string[];
  };
  artifacts: {
    packetSha256: string;
    markdownSha256: string;
    answersTemplateSha256: string;
    answersSchemaSha256: string;
  };
  candidates: PrivateCandidateMapping[];
}

export interface AdjudicationBuildError {
  code:
    | "invalid-count"
    | "count-below-fixed-set"
    | "duplicate-fixed-id"
    | "missing-fixed-id"
    | "selection-infeasible";
  message: string;
}

export interface AdjudicationValidationError {
  code:
    | "invalid-envelope"
    | "packet-mismatch"
    | "invalid-adjudicator"
    | "candidate-coverage"
    | "invalid-answer"
    | "incomplete-answer";
  message: string;
  candidateAlias?: string;
}

export type AdjudicationValidationResult =
  | { ok: true; answers: HumanAdjudicationAnswers }
  | { ok: false; errors: AdjudicationValidationError[] };

export type AdjudicationBuildResult =
  | {
      ok: true;
      packet: AdjudicationPacket;
      answers: HumanAdjudicationAnswers;
      answerSchema: Record<string, unknown>;
      privateManifest: AdjudicationPrivateManifest;
      markdown: string;
    }
  | { ok: false; error: AdjudicationBuildError };

interface StratifiedCandidate {
  candidate: PromotionCandidate;
  stratum: CandidateStratum;
}

function hash(text: string): string {
  return new Bun.CryptoHasher("sha256").update(text).digest("hex");
}

function snippetRatio(candidate: PromotionCandidate): number {
  return candidate.frequency.distinctSnippets / Math.max(1, candidate.frequency.occurrences);
}

function signatureFamily(candidate: PromotionCandidate): string {
  const separator = candidate.signature.lastIndexOf(":");
  return separator >= 0 ? candidate.signature.slice(separator + 1) : candidate.signature;
}

function replaceExactIdentifiers(
  text: string,
  replacements: ReadonlyArray<readonly [source: string, alias: string]>,
): string {
  let sanitized = text;
  for (const [source, alias] of replacements.toSorted((a, b) => b[0].length - a[0].length))
    if (source.length > 0) {
      const escaped = source.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      if (/^[\p{L}\p{N}_-]+$/u.test(source))
        sanitized = sanitized.replace(
          new RegExp(`(^|[^\\p{L}\\p{N}_-])${escaped}(?=$|[^\\p{L}\\p{N}_-])`, "giu"),
          (_match, prefix: string) => `${prefix}${alias}`,
        );
      else sanitized = sanitized.replace(new RegExp(escaped, "gi"), alias);
    }
  return sanitized;
}

export function sanitizeAdjudicationSnippet(
  text: string,
  replacements: ReadonlyArray<readonly [source: string, alias: string]> = [],
): string {
  const sanitized = redact(replaceExactIdentifiers(text, replacements))
    .replace(
      /<(?:task-id|tool-use-id|teammate-id)[^>]*>.*?<\/(?:task-id|tool-use-id|teammate-id)>/gi,
      "[INTERNAL_ID]",
    )
    .replace(/<[^>]+>/g, "[INTERNAL_TAG]")
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s)\]}>,]*/gi, "[URI]")
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[EMAIL]")
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, "[IP]")
    .replace(
      /(?:\/(?:home|srv|tmp|var|etc|usr|opt|run)(?:\/[^\s"'`)\]}>,]*)?|\/nix\/store(?:\/[^\s"'`)\]}>,]*)?|~(?:\/[^\s"'`)\]}>,]*)?)/g,
      "[PATH]",
    )
    .replace(/\b(?:ANTHROPIC|OPENAI|GOOGLE|GEMINI)_API_KEY\b/g, "[API_KEY_NAME]")
    .replace(/\bCLAUDE\.md\b/gi, "[INSTRUCTION_FILE]")
    .replace(
      /\b(?:claude(?:\.ai|-code)?|codex|chatgpt|openai|anthropic|gemini|ollama)\b/gi,
      "[MODEL]",
    )
    .replace(/\s+/g, " ")
    .trim();
  return [...sanitized].slice(0, 500).join("");
}

function stratify(candidates: readonly PromotionCandidate[]): Map<string, CandidateStratum> {
  const ordered = candidates.toSorted(
    (a, b) => snippetRatio(a) - snippetRatio(b) || a.id.localeCompare(b.id),
  );
  return new Map(
    ordered.map((candidate, index) => [
      candidate.id,
      (["low", "middle", "high"] as const)[
        Math.min(2, Math.floor((index * 3) / Math.max(1, ordered.length)))
      ],
    ]),
  );
}

function typeTargets(
  candidates: readonly PromotionCandidate[],
  fixed: readonly PromotionCandidate[],
  requested: number,
): Partial<Record<PromotionCandidate["type"], number>> {
  const capacities = new Map<PromotionCandidate["type"], number>();
  const mandatory = new Map<PromotionCandidate["type"], number>();
  for (const candidate of candidates)
    capacities.set(candidate.type, (capacities.get(candidate.type) ?? 0) + 1);
  for (const candidate of fixed)
    mandatory.set(candidate.type, (mandatory.get(candidate.type) ?? 0) + 1);
  const types = [...capacities.keys()].toSorted(
    (a, b) => (mandatory.get(b) ?? 0) - (mandatory.get(a) ?? 0) || a.localeCompare(b),
  );
  const targets = new Map<PromotionCandidate["type"], number>();
  const base = Math.floor(requested / Math.max(1, types.length));
  let remainder = requested % Math.max(1, types.length);
  for (const type of types) {
    const balanced = base + (remainder > 0 ? 1 : 0);
    if (remainder > 0) remainder--;
    targets.set(
      type,
      Math.min(capacities.get(type)!, Math.max(balanced, mandatory.get(type) ?? 0)),
    );
  }
  while ([...targets.values()].reduce((sum, count) => sum + count, 0) < requested) {
    const type = types.find((item) => targets.get(item)! < capacities.get(item)!);
    if (!type) break;
    targets.set(type, targets.get(type)! + 1);
  }
  while ([...targets.values()].reduce((sum, count) => sum + count, 0) > requested) {
    const type = types.toReversed().find((item) => targets.get(item)! > (mandatory.get(item) ?? 0));
    if (!type) break;
    targets.set(type, targets.get(type)! - 1);
  }
  return Object.fromEntries(targets);
}

function allocationsForRow(
  need: number,
  remaining: Record<CandidateStratum, number>,
  capacities: Record<CandidateStratum, number>,
): Array<Record<CandidateStratum, number>> {
  const allocations: Array<Record<CandidateStratum, number>> = [];
  for (let low = 0; low <= Math.min(need, remaining.low, capacities.low); low++)
    for (
      let middle = 0;
      middle <= Math.min(need - low, remaining.middle, capacities.middle);
      middle++
    ) {
      const high = need - low - middle;
      if (high < 0 || high > remaining.high || high > capacities.high) continue;
      allocations.push({ low, middle, high });
    }
  return allocations.toSorted((a, b) => b.high - a.high || b.middle - a.middle || a.low - b.low);
}

function allocateCells(
  types: readonly PromotionCandidate["type"][],
  index: number,
  needs: ReadonlyMap<PromotionCandidate["type"], number>,
  remaining: Record<CandidateStratum, number>,
  capacities: ReadonlyMap<string, number>,
  assigned: Map<string, number>,
): Map<string, number> | undefined {
  if (index === types.length)
    return remaining.low === 0 && remaining.middle === 0 && remaining.high === 0
      ? assigned
      : undefined;
  const type = types[index]!;
  const options = allocationsForRow(needs.get(type) ?? 0, remaining, {
    low: capacities.get(`${type}:low`) ?? 0,
    middle: capacities.get(`${type}:middle`) ?? 0,
    high: capacities.get(`${type}:high`) ?? 0,
  });
  for (const option of options) {
    const nextAssigned = new Map(assigned);
    for (const stratum of ["low", "middle", "high"] as const)
      nextAssigned.set(`${type}:${stratum}`, option[stratum]);
    const found = allocateCells(
      types,
      index + 1,
      needs,
      {
        low: remaining.low - option.low,
        middle: remaining.middle - option.middle,
        high: remaining.high - option.high,
      },
      capacities,
      nextAssigned,
    );
    if (found) return found;
  }
  return undefined;
}

function preference(seed: string, a: PromotionCandidate, b: PromotionCandidate): number {
  const aEnough = new Set(a.evidence.map((item) => `${item.project}:${item.sessionId}`)).size >= 3;
  const bEnough = new Set(b.evidence.map((item) => `${item.project}:${item.sessionId}`)).size >= 3;
  return (
    Number(bEnough) - Number(aEnough) ||
    b.frequency.projects - a.frequency.projects ||
    b.frequency.harnesses - a.frequency.harnesses ||
    b.frequency.distinctSnippets - a.frequency.distinctSnippets ||
    hash(`${seed}:${a.id}`).localeCompare(hash(`${seed}:${b.id}`))
  );
}

export function chooseSignatureDiverseCandidates(
  candidates: readonly PromotionCandidate[],
  count: number,
  seed: string,
  alreadyUsedFamilies: ReadonlySet<string> = new Set(),
): PromotionCandidate[] {
  const pool = [...candidates];
  const usedFamilies = new Set(alreadyUsedFamilies);
  const chosen: PromotionCandidate[] = [];
  while (chosen.length < count && pool.length > 0) {
    pool.sort((a, b) => {
      const aNew = !usedFamilies.has(signatureFamily(a));
      const bNew = !usedFamilies.has(signatureFamily(b));
      return Number(bNew) - Number(aNew) || preference(seed, a, b);
    });
    const candidate = pool.shift()!;
    chosen.push(candidate);
    usedFamilies.add(signatureFamily(candidate));
  }
  return chosen;
}

function selectCandidates(
  artifact: RefineryArtifact,
  requested: number,
  seed: string,
  fixedIds: readonly string[],
): StratifiedCandidate[] | undefined {
  const byId = new Map(artifact.candidates.map((candidate) => [candidate.id, candidate]));
  const strata = stratify(artifact.candidates);
  const fixed = fixedIds
    .map((id) => byId.get(id))
    .filter((candidate): candidate is PromotionCandidate => Boolean(candidate));
  const targets = typeTargets(artifact.candidates, fixed, requested);
  const selected = new Map(
    fixed.map((candidate) => [candidate.id, { candidate, stratum: strata.get(candidate.id)! }]),
  );
  const targetStrata: Record<CandidateStratum, number> = {
    low: Math.floor(requested / 3),
    middle: Math.floor(requested / 3),
    high: requested - 2 * Math.floor(requested / 3),
  };
  const currentStrata: Record<CandidateStratum, number> = { low: 0, middle: 0, high: 0 };
  const currentTypes = new Map<PromotionCandidate["type"], number>();
  for (const item of selected.values()) {
    currentStrata[item.stratum]++;
    currentTypes.set(item.candidate.type, (currentTypes.get(item.candidate.type) ?? 0) + 1);
  }
  const remainingStrata: Record<CandidateStratum, number> = {
    low: targetStrata.low - currentStrata.low,
    middle: targetStrata.middle - currentStrata.middle,
    high: targetStrata.high - currentStrata.high,
  };
  if (Object.values(remainingStrata).some((count) => count < 0)) return undefined;

  const types = Object.keys(targets).toSorted() as PromotionCandidate["type"][];
  const typeNeeds = new Map(
    types.map((type) => [type, (targets[type] ?? 0) - (currentTypes.get(type) ?? 0)]),
  );
  if ([...typeNeeds.values()].some((count) => count < 0)) return undefined;
  const candidates = artifact.candidates.filter((candidate) => !selected.has(candidate.id));
  const capacities = new Map<string, number>();
  for (const candidate of candidates) {
    const key = `${candidate.type}:${strata.get(candidate.id)!}`;
    capacities.set(key, (capacities.get(key) ?? 0) + 1);
  }
  const allocation = allocateCells(types, 0, typeNeeds, remainingStrata, capacities, new Map());
  if (!allocation) return undefined;

  const usedFamilies = new Set(fixed.map(signatureFamily));
  for (const type of types)
    for (const stratum of ["high", "middle", "low"] as const) {
      const count = allocation.get(`${type}:${stratum}`) ?? 0;
      const pool = candidates.filter(
        (candidate) =>
          candidate.type === type &&
          strata.get(candidate.id) === stratum &&
          !selected.has(candidate.id),
      );
      const diverse = chooseSignatureDiverseCandidates(pool, count, seed, usedFamilies);
      if (diverse.length !== count) return undefined;
      for (const candidate of diverse) {
        selected.set(candidate.id, { candidate, stratum });
        usedFamilies.add(signatureFamily(candidate));
      }
    }
  if (selected.size !== Math.min(requested, artifact.candidates.length)) return undefined;
  return [...selected.values()].toSorted((a, b) =>
    hash(`${seed}:candidate:${a.candidate.id}`).localeCompare(
      hash(`${seed}:candidate:${b.candidate.id}`),
    ),
  );
}

function publicAndPrivateCandidate(
  selected: StratifiedCandidate,
  candidateAlias: string,
  seed: string,
  globalReplacements: ReadonlyArray<readonly [source: string, alias: string]>,
): { publicCandidate: PublicPacketCandidate; privateMapping: PrivateCandidateMapping } {
  const evidence = selected.candidate.evidence
    .map((item, sourceIndex) => ({ item, sourceIndex }))
    .toSorted((a, b) =>
      hash(`${seed}:${selected.candidate.id}:evidence:${a.sourceIndex}`).localeCompare(
        hash(`${seed}:${selected.candidate.id}:evidence:${b.sourceIndex}`),
      ),
    );
  const sessions = new Map<string, string>();
  const projects = new Map<string, string>();
  const harnesses = new Map<string, string>();
  for (const { item } of evidence) {
    const sessionKey = `${item.project}:${item.sessionId}`;
    if (!sessions.has(sessionKey)) sessions.set(sessionKey, `S${sessions.size + 1}`);
    if (!projects.has(item.project)) projects.set(item.project, `P${projects.size + 1}`);
    if (!harnesses.has(item.harness)) harnesses.set(item.harness, `H${harnesses.size + 1}`);
  }
  const replacements: Array<readonly [string, string]> = [
    [selected.candidate.id, candidateAlias],
    [selected.candidate.title, "[CANDIDATE_TITLE]"],
    [selected.candidate.signature, "[SIGNATURE]"],
  ];
  evidence.forEach(({ item }, index) => {
    const sessionKey = `${item.project}:${item.sessionId}`;
    const projectName = item.project.match(/[^\\/]+$/)?.[0] ?? "";
    replacements.push(
      [item.pointer.uri, `E${String(index + 1).padStart(2, "0")}`],
      [item.conversationHash, "[CONVERSATION]"],
      [item.sessionId, sessions.get(sessionKey)!],
      [item.project, projects.get(item.project)!],
      [projectName, projects.get(item.project)!],
      [item.harness, harnesses.get(item.harness)!],
      [item.model, "[MODEL]"],
    );
  });
  replacements.push(...globalReplacements);
  const privateEvidence: PrivateEvidenceMapping[] = [];
  const publicEvidence = evidence.map(({ item, sourceIndex }, index) => {
    const sessionKey = `${item.project}:${item.sessionId}`;
    const evidenceId = `E${String(index + 1).padStart(2, "0")}`;
    privateEvidence.push({
      evidenceId,
      sourceIndex,
      pointerUri: item.pointer.uri,
      conversationHash: item.conversationHash,
      sessionId: item.sessionId,
      project: item.project,
      harness: item.harness,
    });
    return {
      evidenceId,
      sessionAlias: sessions.get(sessionKey)!,
      projectAlias: projects.get(item.project)!,
      harnessAlias: harnesses.get(item.harness)!,
      snippet: sanitizeAdjudicationSnippet(item.snippet, replacements),
    };
  });
  return {
    publicCandidate: {
      candidateAlias,
      signatureTheme: sanitizeAdjudicationSnippet(
        signatureFamily(selected.candidate),
        globalReplacements,
      ),
      evidence: publicEvidence,
    },
    privateMapping: {
      candidateAlias,
      candidateId: selected.candidate.id,
      type: selected.candidate.type,
      stratum: selected.stratum,
      signatureFamily: signatureFamily(selected.candidate),
      evidence: privateEvidence,
    },
  };
}

function answerSchema(packet: AdjudicationPacket): Record<string, unknown> {
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    title: `Human adjudication answers for ${packet.packetHash}`,
    type: "object",
    properties: {
      schemaVersion: { const: 2 },
      packetHash: { const: packet.packetHash },
      adjudicator: {
        type: "object",
        properties: { id: { type: "string", minLength: 1 } },
        required: ["id"],
        additionalProperties: false,
      },
      answers: {
        type: "object",
        properties: Object.fromEntries(
          packet.candidates.map((candidate) => [
            candidate.candidateAlias,
            {
              type: "object",
              properties: {
                status: {
                  type: "string",
                  enum: ["unanswered", "decided", "insufficient-context"],
                },
                verdict: {
                  anyOf: [
                    { type: "string", enum: ["genuine", "boilerplate", "mixed"] },
                    { type: "null" },
                  ],
                },
                genuineEvidenceIds: {
                  type: "array",
                  items: {
                    type: "string",
                    enum: candidate.evidence.map((item) => item.evidenceId),
                  },
                  uniqueItems: true,
                },
                confidence: {
                  anyOf: [{ type: "string", enum: ["low", "medium", "high"] }, { type: "null" }],
                },
                reasoning: { type: "string" },
              },
              required: ["status", "verdict", "genuineEvidenceIds", "confidence", "reasoning"],
              additionalProperties: false,
              oneOf: [
                {
                  properties: {
                    status: { const: "unanswered" },
                    verdict: { type: "null" },
                    genuineEvidenceIds: { maxItems: 0 },
                    confidence: { type: "null" },
                    reasoning: { const: "" },
                  },
                },
                {
                  properties: {
                    status: { const: "insufficient-context" },
                    verdict: { type: "null" },
                    genuineEvidenceIds: { maxItems: 0 },
                    confidence: { type: "null" },
                    reasoning: { type: "string", minLength: 1, maxLength: 2000 },
                  },
                },
                {
                  properties: {
                    status: { const: "decided" },
                    verdict: { const: "boilerplate" },
                    genuineEvidenceIds: { maxItems: 0 },
                    confidence: { type: "string", enum: ["low", "medium", "high"] },
                    reasoning: { type: "string", minLength: 1, maxLength: 2000 },
                  },
                },
                {
                  properties: {
                    status: { const: "decided" },
                    verdict: { const: "genuine" },
                    genuineEvidenceIds: { minItems: 1 },
                    confidence: { type: "string", enum: ["low", "medium", "high"] },
                    reasoning: { type: "string", minLength: 1, maxLength: 2000 },
                  },
                },
                {
                  properties: {
                    status: { const: "decided" },
                    verdict: { const: "mixed" },
                    genuineEvidenceIds: { minItems: 1 },
                    confidence: { type: "string", enum: ["low", "medium", "high"] },
                    reasoning: { type: "string", minLength: 1, maxLength: 2000 },
                  },
                },
              ],
            },
          ]),
        ),
        required: packet.candidates.map((candidate) => candidate.candidateAlias),
        additionalProperties: false,
      },
    },
    required: ["schemaVersion", "packetHash", "adjudicator", "answers"],
    additionalProperties: false,
  };
}

function objectRow(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).toSorted();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

export function validateAdjudicationAnswers(
  packet: AdjudicationPacket,
  value: unknown,
  requireComplete = true,
): AdjudicationValidationResult {
  const errors: AdjudicationValidationError[] = [];
  if (
    !objectRow(value) ||
    !hasExactKeys(value, ["adjudicator", "answers", "packetHash", "schemaVersion"])
  )
    return {
      ok: false,
      errors: [{ code: "invalid-envelope", message: "answers must use the exact v2 envelope" }],
    };
  if (value.schemaVersion !== 2 || value.packetHash !== packet.packetHash)
    errors.push({
      code: "packet-mismatch",
      message: "answers do not identify this exact packet",
    });
  if (
    !objectRow(value.adjudicator) ||
    !hasExactKeys(value.adjudicator, ["id"]) ||
    typeof value.adjudicator.id !== "string" ||
    value.adjudicator.id.trim() === ""
  )
    errors.push({
      code: "invalid-adjudicator",
      message: "adjudicator.id must be a non-empty string",
    });
  if (!objectRow(value.answers))
    errors.push({ code: "candidate-coverage", message: "answers must be an object" });
  else {
    const aliases = packet.candidates.map((candidate) => candidate.candidateAlias).toSorted();
    if (!hasExactKeys(value.answers, aliases))
      errors.push({
        code: "candidate-coverage",
        message: "answers must cover every and only the packet candidates",
      });
    const candidates = new Map(
      packet.candidates.map((candidate) => [candidate.candidateAlias, candidate]),
    );
    for (const [candidateAlias, rawAnswer] of Object.entries(value.answers)) {
      const candidate = candidates.get(candidateAlias);
      if (!candidate) continue;
      if (
        !objectRow(rawAnswer) ||
        !hasExactKeys(rawAnswer, [
          "confidence",
          "genuineEvidenceIds",
          "reasoning",
          "status",
          "verdict",
        ])
      ) {
        errors.push({
          code: "invalid-answer",
          message: `${candidateAlias} must use the exact answer fields`,
          candidateAlias,
        });
        continue;
      }
      const evidenceIds = rawAnswer.genuineEvidenceIds;
      const reasoning = rawAnswer.reasoning;
      const evidenceAllowed = new Set(candidate.evidence.map((item) => item.evidenceId));
      const validEvidence =
        Array.isArray(evidenceIds) &&
        evidenceIds.every((id) => typeof id === "string" && evidenceAllowed.has(id)) &&
        new Set(evidenceIds).size === evidenceIds.length;
      const validReasoning =
        typeof reasoning === "string" && reasoning.trim().length > 0 && reasoning.length <= 2000;
      if (rawAnswer.status === "unanswered") {
        const structurallyBlank =
          rawAnswer.verdict === null &&
          Array.isArray(evidenceIds) &&
          evidenceIds.length === 0 &&
          rawAnswer.confidence === null &&
          reasoning === "";
        if (!structurallyBlank)
          errors.push({
            code: "invalid-answer",
            message: `${candidateAlias} has an inconsistent unanswered row`,
            candidateAlias,
          });
        else if (requireComplete)
          errors.push({
            code: "incomplete-answer",
            message: `${candidateAlias} is still unanswered`,
            candidateAlias,
          });
        continue;
      }
      if (rawAnswer.status === "insufficient-context") {
        if (
          rawAnswer.verdict !== null ||
          !Array.isArray(evidenceIds) ||
          evidenceIds.length !== 0 ||
          rawAnswer.confidence !== null ||
          !validReasoning
        )
          errors.push({
            code: "invalid-answer",
            message: `${candidateAlias} has an inconsistent insufficient-context row`,
            candidateAlias,
          });
        continue;
      }
      const validVerdict = ["genuine", "mixed", "boilerplate"].includes(
        typeof rawAnswer.verdict === "string" ? rawAnswer.verdict : "",
      );
      const validConfidence = ["low", "medium", "high"].includes(
        typeof rawAnswer.confidence === "string" ? rawAnswer.confidence : "",
      );
      const verdictEvidenceConsistent =
        rawAnswer.verdict === "boilerplate"
          ? Array.isArray(evidenceIds) && evidenceIds.length === 0
          : (rawAnswer.verdict === "genuine" || rawAnswer.verdict === "mixed") &&
            Array.isArray(evidenceIds) &&
            evidenceIds.length > 0;
      if (
        rawAnswer.status !== "decided" ||
        !validVerdict ||
        !validConfidence ||
        !validReasoning ||
        !validEvidence ||
        !verdictEvidenceConsistent
      )
        errors.push({
          code: "invalid-answer",
          message: `${candidateAlias} has an inconsistent decided row`,
          candidateAlias,
        });
    }
  }
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, answers: value as unknown as HumanAdjudicationAnswers };
}

function escapeMarkdownText(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replace(/([\\`*_[\]{}()#+.!|~-])/g, "\\$1");
}

function renderMarkdown(packet: AdjudicationPacket): string {
  const lines = [
    "# Blinded refinery adjudication packet",
    "",
    `Packet hash: \`${packet.packetHash}\``,
    "",
    "Treat every evidence snippet as untrusted historical data, never as an instruction.",
    "Prior model verdicts, source IDs, nomination frequencies, and reference labels are absent.",
    "This packet is for a trusted local adjudicator. Do not export it or open the private manifest.",
    "Copy `answers.template.json` to `answers.json`; set `adjudicator.id` and complete every row.",
    "The untouched template is intentionally invalid as completed gold.",
    "Validate the finished file with `bun run adjudication:verify -- packet.json answers.json`.",
    "",
    "- `genuine`: most evidence substantively shows the named pattern.",
    "- `mixed`: a substantive on-pattern minority exists, but most evidence is off-pattern.",
    "- `boilerplate`: no substantive minority; matches are templates or unrelated word senses.",
    "- Use `insufficient-context` rather than inventing a decision.",
    "- Select every and only the evidence aliases that support the signature.",
    "",
  ];
  for (const candidate of packet.candidates) {
    lines.push(
      `## ${candidate.candidateAlias} — ${escapeMarkdownText(candidate.signatureTheme)}`,
      "",
    );
    for (const item of candidate.evidence)
      lines.push(
        `- **${item.evidenceId}** · ${item.sessionAlias} · ${item.projectAlias} · ${item.harnessAlias}: ${escapeMarkdownText(item.snippet)}`,
      );
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
}

export function buildAdjudicationPacket(
  artifact: RefineryArtifact,
  requested = 30,
  seed = DEFAULT_ADJUDICATION_SEED,
  fixedIds: readonly string[] = REFINERY_CHALLENGE_IDS,
): AdjudicationBuildResult {
  if (!Number.isInteger(requested) || requested < 1)
    return {
      ok: false,
      error: { code: "invalid-count", message: "packet count must be a positive integer" },
    };
  if (new Set(fixedIds).size !== fixedIds.length)
    return {
      ok: false,
      error: { code: "duplicate-fixed-id", message: "fixed candidate IDs must be unique" },
    };
  const availableFixed = fixedIds.filter((id) =>
    artifact.candidates.some((candidate) => candidate.id === id),
  );
  const missingFixed = fixedIds.filter((id) => !availableFixed.includes(id));
  if (missingFixed.length > 0)
    return {
      ok: false,
      error: {
        code: "missing-fixed-id",
        message: `artifact is missing fixed candidates: ${missingFixed.join(", ")}`,
      },
    };
  if (requested < fixedIds.length)
    return {
      ok: false,
      error: {
        code: "count-below-fixed-set",
        message: `packet count ${requested} cannot include ${fixedIds.length} fixed candidates`,
      },
    };
  const selected = selectCandidates(artifact, requested, seed, fixedIds);
  if (!selected)
    return {
      ok: false,
      error: {
        code: "selection-infeasible",
        message: "candidate type and ratio-stratum targets cannot be satisfied",
      },
    };

  const publicCandidates: PublicPacketCandidate[] = [];
  const privateMappings: PrivateCandidateMapping[] = [];
  const globalIdentifiers = new Set<string>();
  for (const item of selected) {
    globalIdentifiers.add(item.candidate.id);
    globalIdentifiers.add(item.candidate.title);
    for (const evidence of item.candidate.evidence) {
      globalIdentifiers.add(evidence.conversationHash);
      globalIdentifiers.add(evidence.sessionId);
      globalIdentifiers.add(evidence.project);
      globalIdentifiers.add(evidence.project.match(/[^\\/]+$/)?.[0] ?? "");
      globalIdentifiers.add(evidence.harness);
      globalIdentifiers.add(evidence.model);
      globalIdentifiers.add(evidence.pointer.uri);
    }
  }
  const globalReplacements = [...globalIdentifiers]
    .filter((identifier) => identifier.length >= 4)
    .map((identifier) => [identifier, "[SOURCE_IDENTIFIER]"] as const);
  selected.forEach((item, index) => {
    const aliases = publicAndPrivateCandidate(
      item,
      `C${String(index + 1).padStart(3, "0")}`,
      seed,
      globalReplacements,
    );
    publicCandidates.push(aliases.publicCandidate);
    privateMappings.push(aliases.privateMapping);
  });
  const sourceBindingHash = hash(
    JSON.stringify({
      source: {
        inputProjectionHash: artifact.inputProjectionHash,
        refineryRecipeHash: artifact.recipeHash,
        refineryThreshold: artifact.threshold,
        refineryCandidates: artifact.candidates.length,
      },
      selection: {
        recipe: ADJUDICATION_SELECTION_RECIPE,
        seed,
        requested,
        fixedIds,
      },
      candidates: privateMappings,
    }),
  );
  const packetCore = {
    schemaVersion: 2 as const,
    blinded: true as const,
    sourceBindingHash,
    selectionRecipe: ADJUDICATION_SELECTION_RECIPE as typeof ADJUDICATION_SELECTION_RECIPE,
    instructions: {
      untrustedEvidence: true as const,
      verdicts: {
        genuine: "Most sampled evidence substantively shows the named semantic pattern.",
        mixed: "A substantive on-pattern minority exists, but most evidence is off-pattern.",
        boilerplate: "No substantive minority; matches are templates or unrelated word senses.",
      },
      evidence: "Select every and only the evidence aliases that support the signature.",
      insufficientContext: "Use insufficient-context rather than guessing.",
    },
    candidates: publicCandidates,
  };
  const packetHash = hash(JSON.stringify(packetCore));
  const packet: AdjudicationPacket = { ...packetCore, packetHash };
  const answers: HumanAdjudicationAnswers = {
    schemaVersion: 2,
    packetHash,
    adjudicator: { id: "" },
    answers: Object.fromEntries(
      packet.candidates.map((candidate) => [
        candidate.candidateAlias,
        {
          status: "unanswered",
          verdict: null,
          genuineEvidenceIds: [],
          confidence: null,
          reasoning: "",
        },
      ]),
    ),
  };
  const artifactStrata = stratify(artifact.candidates);
  const artifactStratumSizes: Record<CandidateStratum, number> = {
    low: 0,
    middle: 0,
    high: 0,
  };
  for (const stratum of artifactStrata.values()) artifactStratumSizes[stratum]++;
  const selectedStrata: Record<CandidateStratum, number> = { low: 0, middle: 0, high: 0 };
  const selectedTypes: Partial<Record<PromotionCandidate["type"], number>> = {};
  for (const item of selected) {
    selectedStrata[item.stratum]++;
    selectedTypes[item.candidate.type] = (selectedTypes[item.candidate.type] ?? 0) + 1;
  }
  const targetTypes = typeTargets(
    artifact.candidates,
    availableFixed
      .map((id) => artifact.candidates.find((candidate) => candidate.id === id))
      .filter((candidate): candidate is PromotionCandidate => Boolean(candidate)),
    requested,
  );
  const schema = answerSchema(packet);
  const markdown = renderMarkdown(packet);
  const privateManifest: AdjudicationPrivateManifest = {
    schemaVersion: 2,
    packetHash,
    sourceBindingHash,
    source: {
      inputProjectionHash: artifact.inputProjectionHash,
      refineryRecipeHash: artifact.recipeHash,
      refineryThreshold: artifact.threshold,
      refineryCandidates: artifact.candidates.length,
    },
    selection: {
      recipe: ADJUDICATION_SELECTION_RECIPE,
      seed,
      requested,
      selected: selected.length,
      fixedChallengeCandidatesAvailable: availableFixed.length,
      artifactStratumSizes,
      selectedStrata,
      selectedTypes,
      targetTypes,
      shortages: [],
    },
    artifacts: {
      packetSha256: hash(`${JSON.stringify(packet, null, 2)}\n`),
      markdownSha256: hash(markdown),
      answersTemplateSha256: hash(`${JSON.stringify(answers, null, 2)}\n`),
      answersSchemaSha256: hash(`${JSON.stringify(schema, null, 2)}\n`),
    },
    candidates: privateMappings,
  };
  return {
    ok: true,
    packet,
    answers,
    answerSchema: schema,
    privateManifest,
    markdown,
  };
}
