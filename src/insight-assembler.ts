import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Database } from "bun:sqlite";
import { parseEvidenceUri } from "./evidence-uri";
import type { PromotionCandidate, RefineryArtifact } from "./refinery";
import type { RefineryDisposition } from "./refinery-judge";
import type {
  AdjudicationPacket,
  AdjudicationPrivateManifest,
  HumanAdjudicationAnswers,
  PrivateCandidateMapping,
} from "./refinery-adjudication";
import { validateAdjudicationAnswers } from "./refinery-adjudication";
import type { MemoryProposalSet, OperatorReviews } from "./workbench/memory-lab";
import {
  insightScope,
  validateInsightRevision,
  type InsightAuthorityRecord,
  type InsightDocumentReference,
  type InsightKind,
  type InsightScopeInput,
} from "./insights";
import type { InsightCommandInput } from "./insight-ledger";

const HASH = /^[a-f0-9]{64}$/u;
export interface InsightAssemblerInput {
  projectIdentity: string;
  candidate: PromotionCandidate;
  refinery: RefineryArtifact;
  disposition?: RefineryDisposition;
  packet: AdjudicationPacket;
  privateManifest: AdjudicationPrivateManifest;
  proposalSet: MemoryProposalSet;
  operatorReviews: OperatorReviews;
  adjudicationAnswers: HumanAdjudicationAnswers;
  proposalSetHash: string;
  operatorReviewHash: string;
  actor: { id: string; kind: "human" | "operator" };
  recordedAt?: string;
  observedAt?: string;
  validTime?: { start: string; end: string | null };
  correctedProposition?: string;
  correctedProcedure?: string | null;
  authoritativeDocs?: InsightDocumentReference[];
  activeEvidence?: ReadonlySet<string>;
  priorLedgerHash?: string | null;
  priorRevisionId?: string | null;
  inputProjectionHash?: string;
  adjudicationAnswersHash?: string;
  scope?: InsightScopeInput;
  transitionCommand?: import("./insights").InsightTransitionCommand;
  counterEvidence?: string[];
  sourceAuthorityHash?: string;
}

export interface InsightAssemblerError {
  code:
    | "candidate-not-found"
    | "proposal-mismatch"
    | "review-mismatch"
    | "packet-mismatch"
    | "mapping-mismatch"
    | "judge-mismatch"
    | "evidence-invalid"
    | "evidence-inactive"
    | "semantic-mismatch"
    | "missing-authority";
  message: string;
}

export type InsightAssemblerResult =
  | { ok: true; value: InsightCommandInput }
  | { ok: false; error: InsightAssemblerError };

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function adjudicationConfidence(value: "low" | "medium" | "high"): number {
  return value === "low" ? 1 / 3 : value === "medium" ? 2 / 3 : 1;
}
function fail(code: InsightAssemblerError["code"], message: string): InsightAssemblerResult {
  return { ok: false, error: { code, message } };
}

function kindForCandidate(candidate: PromotionCandidate): InsightKind {
  switch (candidate.type) {
    case "skill":
    case "gotcha-skill":
      return "procedure";
    case "memory-or-adr":
      return "decision";
    case "claude-md":
      return "fact";
    case "wiki-page-later":
      return "fact";
  }
}

function verifyEvidenceShape(uris: readonly string[]): InsightAssemblerError | undefined {
  if (uris.length === 0)
    return {
      code: "evidence-invalid",
      message: "source-bound proposal selected no genuine evidence",
    };
  for (const uri of uris) {
    try {
      parseEvidenceUri(uri);
    } catch {
      return { code: "evidence-invalid", message: `invalid evidence URI ${uri}` };
    }
  }
}
function selectedEvidence(
  candidate: PromotionCandidate,
  mapping: PrivateCandidateMapping,
  packet: AdjudicationPacket,
  answers: HumanAdjudicationAnswers,
  disposition?: RefineryDisposition,
): string[] {
  const answer = answers.answers[mapping.candidateAlias];
  if (
    !answer ||
    answer.status !== "decided" ||
    answer.verdict !== "genuine" ||
    answer.genuineEvidenceIds.length === 0
  )
    return [];
  const allowed = new Map(mapping.evidence.map((item) => [item.evidenceId, item.pointerUri]));
  if (answer.genuineEvidenceIds.some((id) => !allowed.has(id))) return [];
  const packetCandidate = packet.candidates.find(
    (row) => row.candidateAlias === mapping.candidateAlias,
  );
  const packetIds = new Set(packetCandidate?.evidence.map((item) => item.evidenceId) ?? []);
  if (answer.genuineEvidenceIds.some((id) => !packetIds.has(id))) return [];
  const judged =
    disposition?.promotionReview.find((row) => row.id === candidate.id) ??
    disposition?.manualReview.find((row) => row.id === candidate.id);
  const judgedUris = judged?.evidencePointers ?? [];
  if (judgedUris.some((uri) => ![...allowed.values()].includes(uri))) return [];
  return [...new Set(answer.genuineEvidenceIds.map((id) => allowed.get(id)!))];
}

function sourceAuthority(
  actor: { id: string; kind: "human" | "operator" },
  sourceHashes: string[],
  recordedAt: string,
): InsightAuthorityRecord {
  return {
    kind: "human-review",
    actor: actor.id,
    authority: "finalized operator review bound to exact packet and proposal bytes",
    assertedAt: recordedAt,
    sourceHashes,
  };
}

export function assembleInsightCommand(input: InsightAssemblerInput): InsightAssemblerResult {
  const {
    candidate,
    refinery,
    packet,
    privateManifest,
    proposalSet,
    operatorReviews,
    adjudicationAnswers,
  } = input;
  if (!refinery.candidates.some((row) => row.id === candidate.id))
    return fail("candidate-not-found", "candidate is not present in the refinery artifact");
  if (
    privateManifest.packetHash !== packet.packetHash ||
    privateManifest.sourceBindingHash !== packet.sourceBindingHash ||
    !privateManifest.source ||
    !privateManifest.artifacts ||
    privateManifest.source.inputProjectionHash !== refinery.inputProjectionHash ||
    privateManifest.source.refineryRecipeHash !== refinery.recipeHash ||
    privateManifest.source.refineryThreshold !== refinery.threshold ||
    privateManifest.source.refineryCandidates !== refinery.candidates.length ||
    privateManifest.artifacts.packetSha256 !== hash(`${JSON.stringify(packet, null, 2)}\n`)
  )
    return fail(
      "packet-mismatch",
      "private mapping is not bound to the exact packet and refinery artifact",
    );
  if (proposalSet.packetHash !== packet.packetHash)
    return fail("proposal-mismatch", "proposal set is bound to a different packet");
  if (hash(JSON.stringify(proposalSet, null, 2) + "\n") !== input.proposalSetHash)
    return fail("proposal-mismatch", "proposal set bytes do not match declared hash");
  if (
    operatorReviews.packetHash !== packet.packetHash ||
    operatorReviews.proposalSetHash !== input.proposalSetHash
  )
    return fail(
      "review-mismatch",
      "operator review is bound to different packet or proposal bytes",
    );
  if (!adjudicationAnswers)
    return fail("missing-authority", "a finalized adjudication answer set is required");
  const answers = validateAdjudicationAnswers(packet, adjudicationAnswers, true);
  if (!answers.ok)
    return fail("missing-authority", answers.errors.map((error) => error.message).join("; "));
  const mapping = privateManifest.candidates.find((row) => row.candidateId === candidate.id);
  if (!mapping)
    return fail("mapping-mismatch", "private blinded mapping does not identify the candidate");
  const packetCandidate = packet.candidates.find(
    (row) => row.candidateAlias === mapping.candidateAlias,
  );
  if (!packetCandidate)
    return fail("mapping-mismatch", "private mapping alias is absent from the packet");
  const review = operatorReviews.reviews[mapping.candidateAlias];
  if (!review || review.status !== "reviewed" || review.judgment !== "correct")
    return fail("missing-authority", "a finalized correct operator review is required");
  if (review.valence === null)
    return fail("missing-authority", "a reviewed candidate must carry a valence");
  const adjudication = adjudicationAnswers.answers[mapping.candidateAlias];
  if (!adjudication || adjudication.status !== "decided")
    return fail("missing-authority", "a decided adjudication answer is required");
  if (adjudication.verdict !== "genuine")
    return fail("judge-mismatch", "only a genuine adjudication verdict can activate an insight");
  if (
    input.disposition &&
    !input.disposition.promotionReview.some((row) => row.id === candidate.id) &&
    !input.disposition.manualReview.some((row) => row.id === candidate.id)
  )
    return fail("judge-mismatch", "candidate is not eligible for a reviewed judge disposition");
  const allowedUris = new Set(mapping.evidence.map((item) => item.pointerUri));
  const judged =
    input.disposition?.promotionReview.find((row) => row.id === candidate.id) ??
    input.disposition?.manualReview.find((row) => row.id === candidate.id);
  if (judged?.evidencePointers.some((uri) => !allowedUris.has(uri)))
    return fail(
      "mapping-mismatch",
      "judge evidence pointer is outside the private candidate mapping",
    );
  const support = selectedEvidence(
    candidate,
    mapping,
    packet,
    adjudicationAnswers,
    input.disposition,
  );
  const evidenceError = verifyEvidenceShape(support);
  if (evidenceError) return fail(evidenceError.code, evidenceError.message);
  const activeEvidence = input.activeEvidence;
  if (activeEvidence && support.some((uri) => !activeEvidence.has(uri)))
    return fail(
      "evidence-inactive",
      "selected evidence is not active in the canonical source projection",
    );
  const sourceHashes = [
    packet.packetHash,
    input.proposalSetHash,
    input.operatorReviewHash,
    input.adjudicationAnswersHash,
    refinery.inputProjectionHash,
    refinery.recipeHash,
    input.inputProjectionHash,
    input.sourceAuthorityHash,
  ].filter((value): value is string => typeof value === "string" && HASH.test(value));
  const recordedAt = input.recordedAt ?? new Date().toISOString();
  const observedAt = input.observedAt ?? recordedAt;
  const validTime = input.validTime ?? { start: observedAt, end: null };
  const proposal = proposalSet.proposals[mapping.candidateAlias];
  if (!proposal) return fail("proposal-mismatch", "candidate alias has no semantic proposal");
  if (candidate.type === "skill" || candidate.type === "gotcha-skill") {
    if (candidate.curation.route.trim() === "")
      return fail("semantic-mismatch", "procedure candidate has no authoritative route");
  }
  const proposition = input.correctedProposition ?? proposal.lesson;
  const procedure =
    input.correctedProcedure !== undefined
      ? input.correctedProcedure
      : candidate.type === "skill" || candidate.type === "gotcha-skill"
        ? proposal.lesson
        : null;
  const command =
    input.transitionCommand ??
    (input.correctedProposition === undefined && input.correctedProcedure === undefined
      ? "accept"
      : "accept-with-correction");
  const transitionSeed = JSON.stringify([
    candidate.id,
    input.proposalSetHash,
    input.operatorReviewHash,
    command,
    input.priorRevisionId ?? null,
    proposition,
    procedure,
  ]);
  const authority = sourceAuthority(input.actor, sourceHashes, recordedAt);
  const revision = {
    schemaVersion: 2 as const,
    insightId: candidate.id,
    revisionId: `rev-${hash(transitionSeed).slice(0, 40)}`,
    kind: kindForCandidate(candidate),
    proposition,
    procedure,
    scope: insightScope(
      input.scope ?? {
        project: input.projectIdentity,
        domain: "coding",
        harness: candidate.evidence[0]?.harness ?? null,
        model: candidate.evidence[0]?.model ?? null,
      },
    ),
    supportEvidence: [...new Set(support)],
    counterEvidence: [...new Set(input.counterEvidence ?? [])],
    observedAt,
    validTime,
    recordedAt,
    status:
      input.transitionCommand === "reject"
        ? "rejected"
        : input.transitionCommand === "dispute"
          ? "disputed"
          : input.transitionCommand === "expire"
            ? "expired"
            : input.transitionCommand === "retire"
              ? "retired"
              : ("active" as const),
    supersedes: null,
    conflictsWith: [],
    duplicateOf: null,
    riskClass: "low" as const,
    valence: review.valence,
    origin: {
      kind: "model-proposal" as const,
      actor: proposalSet.generator.model,
      sourceHashes,
      proposalId: `proposal-${mapping.candidateAlias.toLowerCase()}`,
    },
    authority: [authority],
    derivation: {
      activity: "refinery-to-insight-assembly",
      recipe: refinery.recipeHash,
      model: proposalSet.generator.model,
      inputHashes: sourceHashes,
    },
    confidence: [
      {
        assessor: adjudicationAnswers.adjudicator.id,
        role: "human" as const,
        value: adjudicationConfidence(adjudication.confidence),
        evidence: [...new Set(support)],
        assessedAt: recordedAt,
      },
    ],
    authoritativeDocs: input.authoritativeDocs ?? [],
  };
  const validated = validateInsightRevision(revision);
  if (!validated.ok)
    return fail(
      "semantic-mismatch",
      validated.errors.map((error) => `${error.path}: ${error.message}`).join("; "),
    );
  return {
    ok: true,
    value: {
      command,
      insightId: candidate.id,
      revision: validated.value,
      priorRevisionId: input.priorRevisionId ?? null,
      actor: input.actor,
      authority,
      recordedAt,
      reason:
        command === "retire"
          ? "operator removed source-bound insight from agent context"
          : input.correctedProposition !== undefined || input.correctedProcedure !== undefined
            ? "operator correction bound to finalized review"
            : `operator authorized source-bound ${command} transition`,
      sourceHashes,
      priorLedgerHash: input.priorLedgerHash ?? null,
      idempotencyKey: `assemble-${hash(transitionSeed).slice(0, 40)}`,
    },
  };
}

export async function assembleInsightCommandFromFiles(
  root: string,
  input: Omit<
    InsightAssemblerInput,
    | "packet"
    | "privateManifest"
    | "proposalSet"
    | "operatorReviews"
    | "adjudicationAnswers"
    | "proposalSetHash"
    | "operatorReviewHash"
    | "adjudicationAnswersHash"
  > & { packetHash: string },
): Promise<InsightAssemblerResult> {
  const base = join(resolve(root), "derived", "adjudication", "refinery", input.packetHash);
  try {
    const [packet, proposalSet, operatorReviews, adjudicationAnswers, privateManifest] =
      await Promise.all([
        readFile(join(base, "public", "packet.json"), "utf8").then(
          (value) => JSON.parse(value) as AdjudicationPacket,
        ),
        readFile(join(base, "public", "proposals.json"), "utf8").then(
          (value) => JSON.parse(value) as MemoryProposalSet,
        ),
        readFile(join(base, "public", "operator-reviews.json"), "utf8").then(
          (value) => JSON.parse(value) as OperatorReviews,
        ),
        readFile(join(base, "public", "answers.json"), "utf8").then(
          (value) => JSON.parse(value) as HumanAdjudicationAnswers,
        ),
        readFile(
          join(
            resolve(root),
            "derived",
            "adjudication",
            "refinery-private",
            input.packetHash,
            "manifest.json",
          ),
          "utf8",
        ).then((value) => JSON.parse(value) as AdjudicationPrivateManifest),
      ]);
    const proposalBytes = await readFile(join(base, "public", "proposals.json"));
    const reviewBytes = await readFile(join(base, "public", "operator-reviews.json"));
    const answersBytes = await readFile(join(base, "public", "answers.json"));
    return assembleInsightCommand({
      ...input,
      packet,
      proposalSet,
      operatorReviews,
      adjudicationAnswers,
      privateManifest,
      proposalSetHash: createHash("sha256").update(proposalBytes).digest("hex"),
      operatorReviewHash: createHash("sha256").update(reviewBytes).digest("hex"),
      adjudicationAnswersHash: createHash("sha256").update(answersBytes).digest("hex"),
    });
  } catch (error) {
    return fail(
      "packet-mismatch",
      `could not load source-bound adjudication files: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export function assertCanonicalEvidenceActive(
  root: string,
  uris: readonly string[],
): { ok: true } | { ok: false; error: string } {
  let db: Database;
  try {
    db = new Database(join(resolve(root), "analysis", "chatlog.sqlite"), {
      readonly: true,
      create: false,
    });
  } catch (error) {
    return {
      ok: false,
      error: `analysis projection unavailable: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  try {
    for (const uri of uris) {
      const pointer = parseEvidenceUri(uri);
      const found =
        "eventId" in pointer
          ? db
              .query(
                "SELECT 1 FROM event_metadata e JOIN active_sources a ON a.event_batch_hash = e.batch_hash WHERE e.event_id = ? LIMIT 1",
              )
              .get(pointer.eventId)
          : db
              .query(
                "SELECT 1 FROM conversations c JOIN active_sources a ON a.source_path = c.source_path AND a.content_hash = c.content_hash WHERE c.content_hash = ? LIMIT 1",
              )
              .get(pointer.contentHash);
      if (!found) return { ok: false, error: `evidence is not active: ${uri}` };
    }
    return { ok: true };
  } finally {
    db.close();
  }
}
