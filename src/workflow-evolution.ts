import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Conversation } from "./types";
import { redact } from "./redact";
import {
  assertDerivedProjection,
  DerivedProjectionDriftError,
  loadCurrentDerivedArtifact,
  loadProjectionBoundArtifact,
  type DerivedProjectionReceipt,
} from "./derived-authority";
import { durableAtomicWrite } from "./durable-fs";
import { parseEvidenceUri } from "./evidence-uri";
import {
  classifyOrchestrationTurn,
  isOperatorTurn,
  type SignalName,
} from "./orchestration-profile";
import { inferAgentRole, type AgentRole } from "./role-segmentation";

export type WorkflowEventKind =
  | "approval-gate-changed"
  | "autonomy-boundary"
  | "ownership-boundary";

export interface WorkflowEvidence {
  pointer: string;
  snippet: string;
}

export interface WorkflowEvent {
  id: string;
  kind: WorkflowEventKind;
  occurredAt: string;
  statementHash: string;
  statement: string;
  confidence: "explicit-instruction";
  lineage: {
    episodeId: string;
    conversations: number;
    duplicateCopiesCollapsed: number;
    projects: string[];
    harnesses: string[];
    roles: AgentRole[];
  };
  signals: SignalName[];
  evidence: WorkflowEvidence[];
  policyDelta?: {
    before: string;
    after: string;
    retained: string[];
  };
}

export interface WorkflowEvolutionArtifact {
  schemaVersion: 1;
  outputKind: "workflow-evolution";
  inputProjectionHash: string;
  methodology: {
    eventEligibility: string;
    lineage: string;
    grouping: string;
    crossSessionBoundary: string;
    causalBoundary: string;
  };
  summary: {
    conversationsScanned: number;
    operatorTurnsScanned: number;
    candidateEvents: number;
    uniqueEvents: number;
    duplicateCopiesCollapsed: number;
    episodes: number;
    byKind: Record<WorkflowEventKind, number>;
  };
  tracers: {
    approvalGate: WorkflowEvent | null;
  };
  events: WorkflowEvent[];
  egress: {
    performed: false;
    surface: "none";
    hostedCalls: 0;
    declaration: string;
  };
}

interface Candidate {
  kind: WorkflowEventKind;
  occurredAt: string;
  day: string;
  episodeId: string;
  conversationHash: string;
  project: string;
  harness: string;
  role: AgentRole;
  statementHash: string;
  statement: string;
  signals: SignalName[];
  evidence: WorkflowEvidence;
  policyDelta?: WorkflowEvent["policyDelta"];
}

const MAX_EVENTS = 20_000;
const MAX_EVIDENCE = 8;
const APPROVAL_CHANGE =
  /\b(?:prs?\s+(?:are|is)\s+now\s+allowed[\s\S]{0,180}\b(?:merge|integrat)|(?:no|without)\s+(?:a\s+)?(?:separate\s+)?operator[- ](?:review|approval)\s+gate|remove(?:d|s|ing)?\s+(?:the\s+)?(?:separate\s+)?operator[- ](?:review|approval)\s+gate)\b/i;
const AUTONOMOUS_INTEGRATION =
  /\bagents?\s+may\s+(?:now\s+)?(?:merge|integrate)[\s\S]{0,160}\bautonomously\b/i;
const APPROVAL_PROHIBITION =
  /\b(?:do\s+not|don['’]t|never|must\s+not|cannot|can['’]t|nothing)\b[\s\S]{0,140}\b(?:merge|integrate|remove|without)\b[\s\S]{0,140}\b(?:operator[- ](?:review|approval)\s+gate|operator\s+(?:review|approval))\b|\b(?:retain|keep|restore|reinstate)\b[\s\S]{0,100}\boperator[- ](?:review|approval)\s+gate\b|\boperator[- ](?:review|approval)(?:\s+gate)?\b[\s\S]{0,80}\b(?:still|remains?|stays?)\s+(?:required|mandatory|in\s+(?:force|place))\b/i;
const CONTROL_ENVELOPE =
  /<(?:teammate-message|task-notification|codex_internal_context|system-reminder|persisted-output)\b|The following is the Codex agent history|This session is being continued from a previous conversation/i;

const AUTONOMY_SIGNALS = new Set<SignalName>([
  "self-propel",
  "tracer-and-continue",
  "recommend-and-proceed",
  "dont-wait-for-approval",
]);
const OWNERSHIP_SIGNALS = new Set<SignalName>([
  "one-writer",
  "spec-freeze",
  "gate-before-act",
  "stop-and-report",
]);
const ROLE_ORDER: AgentRole[] = ["manager", "worker", "reviewer", "advisor", "unclassified"];
const KIND_ORDER: WorkflowEventKind[] = [
  "approval-gate-changed",
  "autonomy-boundary",
  "ownership-boundary",
];

function hash(text: string): string {
  return new Bun.CryptoHasher("sha256").update(text).digest("hex");
}

export function workflowEpisodeId(conversation: Pick<
  Conversation,
  "provider" | "harness" | "resumeId" | "id"
>): string {
  return hash(JSON.stringify({
    schema: "workflow-episode-v1",
    provider: conversation.provider,
    harness: conversation.harness,
    identifierKind: conversation.resumeId ? "resume" : "conversation",
    identifier: conversation.resumeId ?? conversation.id,
  }));
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function boundedStatement(text: string, limit = 320): string {
  const clean = redact(text).toWellFormed().replace(/\s+/g, " ").trim();
  return clean.length > limit ? clean.slice(0, limit - 1) + "…" : clean;
}

function normalizedStatement(text: string): string {
  return redact(text)
    .toWellFormed()
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replace(/\s+/g, " ")
    .trim();
}

function stableTimestamp(value: string | undefined, fallback: string): string {
  const selected = value && !Number.isNaN(Date.parse(value)) ? value : fallback;
  if (Number.isNaN(Date.parse(selected))) throw new Error("workflow event has no valid corpus timestamp");
  return new Date(selected).toISOString();
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort(compareText);
}

function sortedRoles(values: AgentRole[]): AgentRole[] {
  return [...new Set(values)].sort((a, b) => ROLE_ORDER.indexOf(a) - ROLE_ORDER.indexOf(b));
}

function approvalPolicyDelta(text: string): WorkflowEvent["policyDelta"] {
  const retained: string[] = [];
  if (/\b(?:checks?|gates?)\b[\s\S]{0,80}\b(?:green|required|pass|verified)|\b(?:confirm|verify|verified)\b[\s\S]{0,80}\b(?:checks?|gates?|before|first)\b/i.test(text))
    retained.push("required verification remains in force");
  if (/\b(?:destructive|irreversible|unsafe)\b[\s\S]{0,100}\b(?:operator|approval|owned)\b/i.test(text))
    retained.push("destructive or unsafe actions remain operator-owned");
  return {
    before: "integration required a separate operator review or approval gate",
    after: "verified agents may integrate without a separate operator review gate",
    retained,
  };
}

export function classifyWorkflowTurn(text: string): Array<{
  kind: WorkflowEventKind;
  signals: SignalName[];
  policyDelta?: WorkflowEvent["policyDelta"];
}> {
  const boundaryQuestion =
    /\?\s*$/.test(text.trim())
    && /\b(?:should|could|would|whether|what if|do we|can we)\b/i.test(text);
  if (
    APPROVAL_CHANGE.test(text)
    && !boundaryQuestion
    && !APPROVAL_PROHIBITION.test(text)
  ) {
    const signals = classifyOrchestrationTurn(text).map((item) => item.signal);
    return [{
      kind: "approval-gate-changed",
      signals: uniqueSorted(signals) as SignalName[],
      policyDelta: approvalPolicyDelta(text),
    }];
  }
  const classified = classifyOrchestrationTurn(text);
  const autonomy = uniqueSorted(
    classified.filter((item) => AUTONOMY_SIGNALS.has(item.signal)).map((item) => item.signal),
  ) as SignalName[];
  const ownership = uniqueSorted(
    classified.filter((item) => OWNERSHIP_SIGNALS.has(item.signal)).map((item) => item.signal),
  ) as SignalName[];
  return [
    ...(!boundaryQuestion && (autonomy.length || AUTONOMOUS_INTEGRATION.test(text))
      ? [{ kind: "autonomy-boundary" as const, signals: autonomy }]
      : []),
    ...(ownership.length ? [{ kind: "ownership-boundary" as const, signals: ownership }] : []),
  ];
}

function isWorkflowOperatorTurn(
  turn: Conversation["turns"][number],
  prior?: Conversation["turns"][number],
): boolean {
  return isOperatorTurn(turn, prior) && !CONTROL_ENVELOPE.test(turn.content);
}

async function loadConversation(root: string, conversationHash: string): Promise<Conversation> {
  const value = JSON.parse(await readFile(
    join(root, "corpus", "objects", conversationHash.slice(0, 2), `${conversationHash}.json`),
    "utf8",
  )) as Conversation;
  if (value.contentHash !== conversationHash)
    throw new Error(`canonical conversation hash mismatch: ${conversationHash}`);
  return value;
}

function candidateGroups(candidates: Candidate[]): WorkflowEvent[] {
  const groups = new Map<string, Candidate[]>();
  for (const candidate of candidates) {
    const key = [
      candidate.kind,
      candidate.statementHash,
      candidate.episodeId,
      candidate.day,
    ].join(":");
    const group = groups.get(key) ?? [];
    group.push(candidate);
    groups.set(key, group);
  }

  const events: WorkflowEvent[] = [];
  for (const [groupKey, group] of groups) {
    group.sort((a, b) =>
      compareText(a.occurredAt, b.occurredAt)
      || compareText(a.evidence.pointer, b.evidence.pointer)
    );
    const first = group[0];
    const conversationHashes = uniqueSorted(group.map((item) => item.conversationHash));
    const evidence = group
      .filter((item, index, rows) =>
        rows.findIndex((other) => other.conversationHash === item.conversationHash) === index
      )
      .slice(0, MAX_EVIDENCE)
      .map((item) => item.evidence);
    const signals = uniqueSorted(group.flatMap((item) => item.signals)) as SignalName[];
    events.push({
      id: hash(`workflow-event-v1:${groupKey}`),
      kind: first.kind,
      occurredAt: first.occurredAt,
      statementHash: first.statementHash,
      statement: first.statement,
      confidence: "explicit-instruction",
      lineage: {
        episodeId: first.episodeId,
        conversations: conversationHashes.length,
        duplicateCopiesCollapsed: Math.max(0, conversationHashes.length - 1),
        projects: uniqueSorted(group.map((item) => item.project).filter(Boolean)),
        harnesses: uniqueSorted(group.map((item) => item.harness).filter(Boolean)),
        roles: sortedRoles(group.map((item) => item.role)),
      },
      signals,
      evidence,
      ...(first.policyDelta ? { policyDelta: first.policyDelta } : {}),
    });
  }
  return events.sort((a, b) =>
    compareText(a.occurredAt, b.occurredAt)
    || KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind)
    || compareText(a.id, b.id)
  );
}

export async function buildWorkflowEvolution(
  root: string,
  projection?: DerivedProjectionReceipt,
): Promise<WorkflowEvolutionArtifact> {
  const currentProjection = projection ?? await assertDerivedProjection(root);
  const candidates: Candidate[] = [];
  const episodes = new Set<string>();
  let operatorTurnsScanned = 0;

  for (const conversationHash of currentProjection.conversationHashes) {
    const conversation = await loadConversation(root, conversationHash);
    const episodeId = workflowEpisodeId(conversation);
    episodes.add(episodeId);
    const role = inferAgentRole(conversation).role;
    conversation.turns.forEach((turn, turnIndex) => {
      if (!isWorkflowOperatorTurn(turn, conversation.turns[turnIndex - 1])) return;
      operatorTurnsScanned++;
      const statement = normalizedStatement(turn.content);
      if (!statement) return;
      const occurredAt = stableTimestamp(turn.at, conversation.startedAt);
      for (const classified of classifyWorkflowTurn(turn.content)) {
        candidates.push({
          ...classified,
          kind: classified.kind,
          occurredAt,
          day: occurredAt.slice(0, 10),
          episodeId,
          conversationHash,
          project: conversation.project,
          harness: conversation.harness,
          role,
          statementHash: hash(statement),
          statement: boundedStatement(turn.content),
          evidence: {
            pointer: `chatlog://conversation/${conversationHash}/turn/${turnIndex}`,
            snippet: boundedStatement(turn.content),
          },
        });
        if (candidates.length > MAX_EVENTS * 8)
          throw new Error("workflow event candidate bound exceeded");
      }
    });
  }

  const events = candidateGroups(candidates);
  if (events.length > MAX_EVENTS) throw new Error("workflow event bound exceeded");
  for (const event of events) {
    if (!event.evidence.length) throw new Error(`workflow event has no evidence: ${event.id}`);
    for (const evidence of event.evidence) {
      const pointer = parseEvidenceUri(evidence.pointer);
      if (!currentProjection.conversationHashes.includes(pointer.contentHash))
        throw new Error(`inactive workflow event evidence: ${evidence.pointer}`);
      const conversation = await loadConversation(root, pointer.contentHash);
      const turn = conversation.turns[pointer.turnIndex];
      if (
        !turn
        || !isWorkflowOperatorTurn(turn, conversation.turns[pointer.turnIndex - 1])
        || !classifyWorkflowTurn(turn.content).some((item) => item.kind === event.kind)
      )
        throw new Error(`unsupported workflow event evidence: ${evidence.pointer}`);
    }
  }

  const byKind = Object.fromEntries(
    KIND_ORDER.map((kind) => [kind, events.filter((event) => event.kind === kind).length]),
  ) as Record<WorkflowEventKind, number>;
  const approvalEvents = events.filter((event) => event.kind === "approval-gate-changed");
  return {
    schemaVersion: 1,
    outputKind: "workflow-evolution",
    inputProjectionHash: currentProjection.contentHash,
    methodology: {
      eventEligibility: "Only locally identified operator turns with explicit workflow-boundary language are eligible.",
      lineage: "Raw session or resume identifiers are replaced with deterministic opaque episode hashes.",
      grouping: "Exact normalized statements with the same event kind, episode lineage, and UTC date are one event; duplicate conversation copies are counted.",
      crossSessionBoundary: "Copies in unrelated sessions and paraphrases are not merged without a stable local lineage signal.",
      causalBoundary: "Events describe explicit operator policy and propagation; they do not claim that a change caused an outcome.",
    },
    summary: {
      conversationsScanned: currentProjection.conversations,
      operatorTurnsScanned,
      candidateEvents: candidates.length,
      uniqueEvents: events.length,
      duplicateCopiesCollapsed: events.reduce(
        (total, event) => total + event.lineage.duplicateCopiesCollapsed,
        0,
      ),
      episodes: episodes.size,
      byKind,
    },
    tracers: {
      approvalGate: approvalEvents.at(-1) ?? null,
    },
    events,
    egress: {
      performed: false,
      surface: "none",
      hostedCalls: 0,
      declaration: "Workflow-evolution derivation reads only the local redacted corpus and active derived projection.",
    },
  };
}

export async function deriveWorkflowEvolution(root: string): Promise<{
  processed: boolean;
  artifactPath: string;
  contentHash: string;
  inputProjectionHash: string;
}> {
  const projection = await assertDerivedProjection(root);
  const inputProjectionHash = projection.contentHash;
  const recipeHash = hash(
    await Bun.file(import.meta.path).text()
    + "\n"
    + await Bun.file(join(import.meta.dir, "orchestration-profile.ts")).text()
    + "\n"
    + await Bun.file(join(import.meta.dir, "role-segmentation.ts")).text()
    + "\n"
    + await Bun.file(join(import.meta.dir, "redact.ts")).text(),
  );
  const manifestPath = join(root, "derived", "workflow-evolution-manifest.json");
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
      const current = await loadCurrentDerivedArtifact(
        root,
        "workflow-evolution-manifest.json",
      );
      if (current?.inputProjectionHash === inputProjectionHash) {
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

  const artifact = await buildWorkflowEvolution(root, projection);
  const text = JSON.stringify(artifact, null, 2) + "\n";
  const contentHash = hash(text);
  const artifactRel =
    `workflow-evolution/${contentHash.slice(0, 2)}/${contentHash}.json`;
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

export async function loadWorkflowEvolution(root: string): Promise<WorkflowEvolutionArtifact> {
  const current = await loadProjectionBoundArtifact<WorkflowEvolutionArtifact>(
    root,
    "workflow-evolution-manifest.json",
    { optional: true },
  );
  if (!current) throw new Error("workflow evolution has not been derived");
  return current.artifact;
}
