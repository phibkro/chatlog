import { createHash } from "node:crypto";
import { chmod, link, mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { validateAdjudicationAnswers, type AdjudicationPacket } from "../refinery-adjudication";

const PACKET_GLOB = "*/public/packet.json";
const MAX_REVIEWER_ID = 80;
const MAX_GENERATOR_FIELD = 200;
const MAX_LESSON = 2_000;
const MAX_RATIONALE = 4_000;
const MAX_FEEDBACK = 1_500;

export type SuggestedValence = "positive" | "negative" | "neutral";
export type OperatorJudgment = "correct" | "incorrect" | "unsure";

export interface MemoryProposal {
  lesson: string;
  suggestedValence: SuggestedValence;
  rationale: string;
}

export interface MemoryProposalSet {
  schemaVersion: 1;
  packetHash: string;
  generator: {
    provider: string;
    model: string;
    effort: string;
    recipe: string;
  };
  proposals: Record<string, MemoryProposal>;
}

export type OperatorReview =
  | {
      status: "unanswered";
      judgment: null;
      valence: null;
      feedback: "";
    }
  | {
      status: "reviewed";
      judgment: OperatorJudgment;
      valence: SuggestedValence | null;
      feedback: string;
    };

export interface OperatorReviews {
  schemaVersion: 1;
  packetHash: string;
  proposalSetHash: string;
  reviewer: { id: string };
  reviews: Record<string, OperatorReview>;
}

export interface MemoryLabProgress {
  total: number;
  completed: number;
  correct: number;
  incorrect: number;
  unsure: number;
  unanswered: number;
}

export interface MemoryLabView {
  packet: AdjudicationPacket;
  proposalSet: MemoryProposalSet;
  proposalSetHash: string;
  reviews: OperatorReviews;
  progress: MemoryLabProgress;
  finalized: boolean;
}

export interface MemoryLabSaveInput {
  packetHash: string;
  proposalSetHash: string;
  candidateAlias: string;
  reviewerId: string;
  review: OperatorReview;
}

export interface MemoryLabFinalizeInput {
  packetHash: string;
  proposalSetHash: string;
  reviewerId: string;
}

export type MemoryLabResult<T> =
  | { ok: true; value: T }
  | { ok: false; status: number; error: string };

interface PacketFiles {
  directory: string;
  packet: AdjudicationPacket;
  proposalSet: MemoryProposalSet;
  proposalSetHash: string;
}

type JsonFileResult =
  | { status: "found"; value: unknown }
  | { status: "missing" }
  | { status: "invalid" };

type HashedJsonFileResult =
  | { status: "found"; value: unknown; hash: string }
  | { status: "missing" }
  | { status: "invalid" };

function objectRow(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: ReadonlyArray<string>): boolean {
  const actual = Object.keys(value).toSorted();
  const expected = keys.toSorted();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function boundedText(value: unknown, maximum: number, nonempty = false): value is string {
  return (
    typeof value === "string" && value.length <= maximum && (!nonempty || value.trim().length > 0)
  );
}

function suggestedValence(value: unknown): value is SuggestedValence {
  return (
    typeof value === "string" &&
    (value === "positive" || value === "negative" || value === "neutral")
  );
}

function operatorJudgment(value: unknown): value is OperatorJudgment {
  return (
    typeof value === "string" &&
    (value === "correct" || value === "incorrect" || value === "unsure")
  );
}

function aliases(packet: AdjudicationPacket): Array<string> {
  return packet.candidates.map((candidate) => candidate.candidateAlias);
}

function exactCoverage(value: Record<string, unknown>, candidateAliases: Array<string>): boolean {
  const unique = new Set(candidateAliases);
  return unique.size === candidateAliases.length && exactKeys(value, candidateAliases);
}

function publicPacket(value: unknown): value is AdjudicationPacket {
  if (
    !objectRow(value) ||
    !exactKeys(value, [
      "schemaVersion",
      "packetHash",
      "sourceBindingHash",
      "blinded",
      "selectionRecipe",
      "instructions",
      "candidates",
    ]) ||
    value.schemaVersion !== 2 ||
    value.blinded !== true ||
    typeof value.packetHash !== "string" ||
    typeof value.sourceBindingHash !== "string" ||
    value.selectionRecipe !== "refinery-human-adjudication-v3" ||
    !objectRow(value.instructions) ||
    !exactKeys(value.instructions, [
      "untrustedEvidence",
      "verdicts",
      "evidence",
      "insufficientContext",
    ]) ||
    value.instructions.untrustedEvidence !== true ||
    !objectRow(value.instructions.verdicts) ||
    !exactKeys(value.instructions.verdicts, ["genuine", "mixed", "boilerplate"]) ||
    typeof value.instructions.verdicts.genuine !== "string" ||
    typeof value.instructions.verdicts.mixed !== "string" ||
    typeof value.instructions.verdicts.boilerplate !== "string" ||
    typeof value.instructions.evidence !== "string" ||
    typeof value.instructions.insufficientContext !== "string" ||
    !Array.isArray(value.candidates) ||
    value.candidates.length === 0
  )
    return false;
  return value.candidates.every(
    (candidate) =>
      objectRow(candidate) &&
      exactKeys(candidate, ["candidateAlias", "signatureTheme", "evidence"]) &&
      typeof candidate.candidateAlias === "string" &&
      typeof candidate.signatureTheme === "string" &&
      Array.isArray(candidate.evidence) &&
      candidate.evidence.every(
        (evidence) =>
          objectRow(evidence) &&
          exactKeys(evidence, [
            "evidenceId",
            "sessionAlias",
            "projectAlias",
            "harnessAlias",
            "snippet",
          ]) &&
          typeof evidence.evidenceId === "string" &&
          typeof evidence.sessionAlias === "string" &&
          typeof evidence.projectAlias === "string" &&
          typeof evidence.harnessAlias === "string" &&
          typeof evidence.snippet === "string",
      ),
  );
}

function proposalSet(packet: AdjudicationPacket, value: unknown): MemoryProposalSet | undefined {
  if (
    !objectRow(value) ||
    !exactKeys(value, ["schemaVersion", "packetHash", "generator", "proposals"]) ||
    value.schemaVersion !== 1 ||
    value.packetHash !== packet.packetHash ||
    !objectRow(value.generator) ||
    !exactKeys(value.generator, ["provider", "model", "effort", "recipe"]) ||
    !boundedText(value.generator.provider, MAX_GENERATOR_FIELD, true) ||
    !boundedText(value.generator.model, MAX_GENERATOR_FIELD, true) ||
    !boundedText(value.generator.effort, MAX_GENERATOR_FIELD, true) ||
    !boundedText(value.generator.recipe, MAX_GENERATOR_FIELD, true) ||
    !objectRow(value.proposals) ||
    !exactCoverage(value.proposals, aliases(packet))
  )
    return undefined;
  for (const proposal of Object.values(value.proposals)) {
    if (
      !objectRow(proposal) ||
      !exactKeys(proposal, ["lesson", "suggestedValence", "rationale"]) ||
      !boundedText(proposal.lesson, MAX_LESSON, true) ||
      !suggestedValence(proposal.suggestedValence) ||
      !boundedText(proposal.rationale, MAX_RATIONALE, true)
    )
      return undefined;
  }
  return value as unknown as MemoryProposalSet;
}

function answerTemplate(packet: AdjudicationPacket, value: unknown): boolean {
  if (
    !objectRow(value) ||
    !exactKeys(value, ["schemaVersion", "packetHash", "adjudicator", "answers"]) ||
    !objectRow(value.adjudicator) ||
    !exactKeys(value.adjudicator, ["id"]) ||
    value.adjudicator.id !== "" ||
    !objectRow(value.answers)
  )
    return false;
  const checked = structuredClone(value);
  if (!objectRow(checked.adjudicator)) return false;
  checked.adjudicator.id = "template-check";
  const validation = validateAdjudicationAnswers(packet, checked, false);
  return (
    validation.ok &&
    Object.values(validation.answers.answers).every((answer) => answer.status === "unanswered")
  );
}

function operatorReview(value: unknown): value is OperatorReview {
  if (!objectRow(value) || !exactKeys(value, ["status", "judgment", "valence", "feedback"]))
    return false;
  if (value.status === "unanswered")
    return value.judgment === null && value.valence === null && value.feedback === "";
  if (
    value.status !== "reviewed" ||
    !operatorJudgment(value.judgment) ||
    !boundedText(value.feedback, MAX_FEEDBACK)
  )
    return false;
  if (value.judgment === "unsure") return value.valence === null;
  return suggestedValence(value.valence);
}

function operatorReviews(
  packet: AdjudicationPacket,
  proposalSetHash: string,
  value: unknown,
  requireComplete: boolean,
): OperatorReviews | undefined {
  if (
    !objectRow(value) ||
    !exactKeys(value, ["schemaVersion", "packetHash", "proposalSetHash", "reviewer", "reviews"]) ||
    value.schemaVersion !== 1 ||
    value.packetHash !== packet.packetHash ||
    value.proposalSetHash !== proposalSetHash ||
    !objectRow(value.reviewer) ||
    !exactKeys(value.reviewer, ["id"]) ||
    !boundedText(value.reviewer.id, MAX_REVIEWER_ID, requireComplete) ||
    !objectRow(value.reviews) ||
    !exactCoverage(value.reviews, aliases(packet)) ||
    !Object.values(value.reviews).every(operatorReview) ||
    (requireComplete &&
      Object.values(value.reviews).some(
        (review) => operatorReview(review) && review.status === "unanswered",
      ))
  )
    return undefined;
  return value as unknown as OperatorReviews;
}

function blankReviews(packet: AdjudicationPacket, proposalSetHash: string): OperatorReviews {
  return {
    schemaVersion: 1,
    packetHash: packet.packetHash,
    proposalSetHash,
    reviewer: { id: "" },
    reviews: Object.fromEntries(
      aliases(packet).map((candidateAlias) => [
        candidateAlias,
        { status: "unanswered", judgment: null, valence: null, feedback: "" },
      ]),
    ),
  };
}

function saveInput(value: unknown): MemoryLabResult<MemoryLabSaveInput> {
  if (
    !objectRow(value) ||
    !exactKeys(value, [
      "packetHash",
      "proposalSetHash",
      "candidateAlias",
      "reviewerId",
      "review",
    ]) ||
    typeof value.packetHash !== "string" ||
    typeof value.proposalSetHash !== "string" ||
    typeof value.candidateAlias !== "string" ||
    typeof value.reviewerId !== "string" ||
    !operatorReview(value.review)
  )
    return { ok: false, status: 400, error: "invalid memory lab draft request" };
  return { ok: true, value: value as unknown as MemoryLabSaveInput };
}

function finalizeInput(value: unknown): MemoryLabResult<MemoryLabFinalizeInput> {
  if (
    !objectRow(value) ||
    !exactKeys(value, ["packetHash", "proposalSetHash", "reviewerId"]) ||
    typeof value.packetHash !== "string" ||
    typeof value.proposalSetHash !== "string" ||
    typeof value.reviewerId !== "string"
  )
    return { ok: false, status: 400, error: "invalid memory lab finalize request" };
  return { ok: true, value: value as unknown as MemoryLabFinalizeInput };
}

function progress(reviews: OperatorReviews): MemoryLabProgress {
  const rows = Object.values(reviews.reviews);
  const correct = rows.filter(
    (review) => review.status === "reviewed" && review.judgment === "correct",
  ).length;
  const incorrect = rows.filter(
    (review) => review.status === "reviewed" && review.judgment === "incorrect",
  ).length;
  const unsure = rows.filter(
    (review) => review.status === "reviewed" && review.judgment === "unsure",
  ).length;
  const unanswered = rows.filter((review) => review.status === "unanswered").length;
  return {
    total: rows.length,
    completed: correct + incorrect + unsure,
    correct,
    incorrect,
    unsure,
    unanswered,
  };
}

function view(files: PacketFiles, reviews: OperatorReviews, finalized: boolean): MemoryLabView {
  return {
    packet: files.packet,
    proposalSet: files.proposalSet,
    proposalSetHash: files.proposalSetHash,
    reviews,
    progress: progress(reviews),
    finalized,
  };
}

async function jsonFile(path: string): Promise<JsonFileResult> {
  try {
    return { status: "found", value: JSON.parse(await readFile(path, "utf8")) };
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")
      return { status: "missing" };
    return { status: "invalid" };
  }
}

async function hashedJsonFile(path: string): Promise<HashedJsonFileResult> {
  try {
    const bytes = await readFile(path);
    return {
      status: "found",
      value: JSON.parse(bytes.toString("utf8")),
      hash: createHash("sha256").update(bytes).digest("hex"),
    };
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")
      return { status: "missing" };
    return { status: "invalid" };
  }
}

async function atomicPrivateJson(
  path: string,
  value: unknown,
  replaceExisting = true,
): Promise<boolean> {
  const temporary = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
      mode: 0o600,
      flag: "wx",
    });
    await chmod(temporary, 0o600);
    if (replaceExisting) await rename(temporary, path);
    else {
      await link(temporary, path);
      await unlink(temporary);
    }
    await chmod(path, 0o600);
    return true;
  } catch {
    await unlink(temporary).catch(() => undefined);
    return false;
  }
}

export class MemoryLab {
  private readonly root: string;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(root: string) {
    this.root = resolve(root);
  }

  private async packetFiles(): Promise<MemoryLabResult<PacketFiles>> {
    const base = join(this.root, "derived", "adjudication", "refinery");
    const candidates: Array<{ path: string; modified: number }> = [];
    try {
      for await (const path of new Bun.Glob(PACKET_GLOB).scan({
        cwd: base,
        absolute: true,
        onlyFiles: true,
      })) {
        const metadata = await stat(path);
        candidates.push({ path, modified: metadata.mtimeMs });
      }
    } catch {
      return { ok: false, status: 404, error: "memory lab packet not found" };
    }
    candidates.sort(
      (left, right) => right.modified - left.modified || right.path.localeCompare(left.path),
    );
    const inspected = await Promise.all(
      candidates.map(async (candidate) => {
        const directory = resolve(candidate.path, "..");
        const [packetResult, templateResult, proposalResult] = await Promise.all([
          jsonFile(candidate.path),
          jsonFile(join(directory, "answers.template.json")),
          hashedJsonFile(join(directory, "proposals.json")),
        ]);
        return { directory, packetResult, templateResult, proposalResult };
      }),
    );
    for (const { directory, packetResult, templateResult, proposalResult } of inspected) {
      if (
        packetResult.status !== "found" ||
        templateResult.status !== "found" ||
        proposalResult.status !== "found"
      )
        continue;
      if (!publicPacket(packetResult.value)) continue;
      const packet = packetResult.value;
      if (!answerTemplate(packet, templateResult.value)) continue;
      const proposals = proposalSet(packet, proposalResult.value);
      if (!proposals) continue;
      return {
        ok: true,
        value: {
          directory,
          packet,
          proposalSet: proposals,
          proposalSetHash: proposalResult.hash,
        },
      };
    }
    return { ok: false, status: 404, error: "memory lab packet not found" };
  }

  private async current(files: PacketFiles): Promise<MemoryLabResult<MemoryLabView>> {
    const finalizedValue = await jsonFile(join(files.directory, "operator-reviews.json"));
    if (finalizedValue.status === "invalid")
      return { ok: false, status: 409, error: "finalized memory lab reviews are invalid" };
    if (finalizedValue.status === "found") {
      const finalized = operatorReviews(
        files.packet,
        files.proposalSetHash,
        finalizedValue.value,
        true,
      );
      if (!finalized)
        return { ok: false, status: 409, error: "finalized memory lab reviews are invalid" };
      return { ok: true, value: view(files, finalized, true) };
    }
    const draftValue = await jsonFile(join(files.directory, "operator-reviews.draft.json"));
    if (draftValue.status === "missing")
      return {
        ok: true,
        value: view(files, blankReviews(files.packet, files.proposalSetHash), false),
      };
    if (draftValue.status === "invalid")
      return { ok: false, status: 409, error: "memory lab review draft is invalid" };
    const draft = operatorReviews(files.packet, files.proposalSetHash, draftValue.value, false);
    if (!draft) return { ok: false, status: 409, error: "memory lab review draft is invalid" };
    return { ok: true, value: view(files, draft, false) };
  }

  async get(): Promise<MemoryLabResult<MemoryLabView>> {
    const files = await this.packetFiles();
    if (!files.ok) return files;
    return this.current(files.value);
  }

  save(value: unknown): Promise<MemoryLabResult<MemoryLabView>> {
    const input = saveInput(value);
    if (!input.ok) return Promise.resolve(input);
    const operation = this.writeQueue.then(() => this.saveNow(input.value));
    this.writeQueue = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  private async saveNow(input: MemoryLabSaveInput): Promise<MemoryLabResult<MemoryLabView>> {
    const files = await this.packetFiles();
    if (!files.ok) return files;
    if (input.packetHash !== files.value.packet.packetHash)
      return { ok: false, status: 409, error: "memory lab packet changed; reload before saving" };
    if (input.proposalSetHash !== files.value.proposalSetHash)
      return {
        ok: false,
        status: 409,
        error: "memory lab proposals changed; reload before saving",
      };
    const current = await this.current(files.value);
    if (!current.ok) return current;
    if (current.value.finalized)
      return { ok: false, status: 409, error: "memory lab review is already finalized" };
    const id = input.reviewerId.trim();
    if (id.length === 0 || id.length > MAX_REVIEWER_ID)
      return {
        ok: false,
        status: 400,
        error: `reviewer ID must be 1–${MAX_REVIEWER_ID} characters`,
      };
    if (!Object.hasOwn(current.value.reviews.reviews, input.candidateAlias))
      return { ok: false, status: 404, error: "memory lab candidate not found" };
    const next = structuredClone(current.value.reviews);
    next.reviewer.id = id;
    next.reviews[input.candidateAlias] = input.review;
    const validated = operatorReviews(files.value.packet, files.value.proposalSetHash, next, false);
    if (!validated) return { ok: false, status: 400, error: "invalid memory lab review" };
    await mkdir(files.value.directory, { recursive: true, mode: 0o700 });
    const saved = await atomicPrivateJson(
      join(files.value.directory, "operator-reviews.draft.json"),
      validated,
    );
    if (!saved)
      return { ok: false, status: 500, error: "memory lab review draft could not be saved" };
    return { ok: true, value: view(files.value, validated, false) };
  }

  finalize(value: unknown): Promise<MemoryLabResult<MemoryLabView>> {
    const input = finalizeInput(value);
    if (!input.ok) return Promise.resolve(input);
    const operation = this.writeQueue.then(() => this.finalizeNow(input.value));
    this.writeQueue = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  private async finalizeNow(
    input: MemoryLabFinalizeInput,
  ): Promise<MemoryLabResult<MemoryLabView>> {
    const files = await this.packetFiles();
    if (!files.ok) return files;
    if (input.packetHash !== files.value.packet.packetHash)
      return {
        ok: false,
        status: 409,
        error: "memory lab packet changed; reload before finishing",
      };
    if (input.proposalSetHash !== files.value.proposalSetHash)
      return {
        ok: false,
        status: 409,
        error: "memory lab proposals changed; reload before finishing",
      };
    const current = await this.current(files.value);
    if (!current.ok) return current;
    if (current.value.finalized) return current;
    const id = input.reviewerId.trim();
    if (id.length === 0 || id.length > MAX_REVIEWER_ID)
      return {
        ok: false,
        status: 400,
        error: `reviewer ID must be 1–${MAX_REVIEWER_ID} characters`,
      };
    const reviews = structuredClone(current.value.reviews);
    reviews.reviewer.id = id;
    const validated = operatorReviews(
      files.value.packet,
      files.value.proposalSetHash,
      reviews,
      true,
    );
    if (!validated)
      return {
        ok: false,
        status: 400,
        error: "complete every memory lab review before finishing",
      };
    const saved = await atomicPrivateJson(
      join(files.value.directory, "operator-reviews.json"),
      validated,
      false,
    );
    if (!saved) {
      const winner = await this.current(files.value);
      if (winner.ok && winner.value.finalized) return winner;
      return { ok: false, status: 500, error: "memory lab reviews could not be finalized" };
    }
    return { ok: true, value: view(files.value, validated, true) };
  }
}
