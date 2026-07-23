import { chmod, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Conversation, Turn } from "./types";
import { redact } from "./redact";

export type OrchestrationPole = "autonomy-grant" | "determinism-impose";
export type SignalName =
  | "self-propel" | "tracer-and-continue" | "recommend-and-proceed" | "dont-wait-for-approval"
  | "one-writer" | "spec-freeze" | "gate-before-act" | "stop-and-report" | "ab-with-recommendation";

export interface OrchestrationLabel {
  split: "calibration" | "held-out";
  conversationHash: string;
  turnIndex: number;
  expectedPole: OrchestrationPole;
  expectedSignal: SignalName;
}
interface Evidence { pointer: string; snippet: string }
interface Match extends Evidence { conversationHash: string; turnIndex: number; pole: OrchestrationPole; signal: SignalName }
interface SignalDefinition { name: SignalName; pole: OrchestrationPole; context: string; latitudeOrGuardrail: string; pattern: RegExp }

const SIGNALS: SignalDefinition[] = [
  { name: "self-propel", pole: "autonomy-grant", context: "the lane has an authored direction and no true operator decision is pending", latitudeOrGuardrail: "continue through ordinary engineering choices and the next bounded increment", pattern: /\b(?:self[- ]propel|continue autonomously|keep (?:projects? )?(?:moving|working) until (?:a )?(?:true )?operator decision|self-sustain(?:s|ing)? until)\b/i },
  { name: "tracer-and-continue", pole: "autonomy-grant", context: "a bounded end-to-end tracer makes the next claim observable", latitudeOrGuardrail: "execute the tracer and continue rather than returning after scaffolding", pattern: /\btracer(?:[ -]bullet)?\b[\s\S]{0,300}\b(?:execute|implement(?:ation)?|move on|next step|continue|self[- ]propel)\b|\b(?:execute|implement|move on)\b[\s\S]{0,200}\btracer(?:[ -]bullet)?\b/i },
  { name: "recommend-and-proceed", pole: "autonomy-grant", context: "research can eliminate routine alternatives or the operator selects the recommended bounded option", latitudeOrGuardrail: "recommend a path and execute it inside the lane", pattern: /\b(?:recommend-and-proceed|(?:your |the )?recommend(?:ation|ed))\b[\s\S]{0,240}\b(?:execute|proceed|resume|continue|implement)|\b(?:execute|proceed|resume)\b[\s\S]{0,180}\brecommend(?:ation|ed)?\b/i },
  { name: "dont-wait-for-approval", pole: "autonomy-grant", context: "local or explicitly authorized integration is verified", latitudeOrGuardrail: "remove operator-review latency and continue or merge", pattern: /\b(?:no need to wait for (?:the )?operator|do not wait for (?:operator )?(?:approval|review)|don['’]t wait for (?:operator )?(?:approval|review)|without waiting for approval)\b/i },
  { name: "one-writer", pole: "determinism-impose", context: "work can mutate a shared tree or ownership can overlap", latitudeOrGuardrail: "one named writer per mutable working directory; isolate parallel writers", pattern: /\b(?:one[- ]writer(?:[- ]per[- ]tree)?|sole writer|single writer|one named writer)\b/i },
  { name: "spec-freeze", pole: "determinism-impose", context: "a unit of intent is being built or context can be lost", latitudeOrGuardrail: "freeze and re-read the binding spec; revise it explicitly rather than drifting", pattern: /\b(?:(?:spec|contract) (?:is |stays? )?frozen|frozen (?:design[- ]?)?spec|binding contract|re-read (?:the )?(?:design[- ]?)?spec|revise (?:the )?spec explicitly|explicit non-goals?|\w+ (?:remain|stays?) (?:operator-)?deferred|deferred \(do not build)\b/i },
  { name: "gate-before-act", pole: "determinism-impose", context: "a claim is accepted, integrated, merged, or reported complete", latitudeOrGuardrail: "observe the real artifact and required checks before acting on the claim", pattern: /\b(?:once verified|only (?:when|after) [\s\S]{0,100}(?:gate|check|verified|green)|(?:checks?|gates?) (?:are |is )?green[\s\S]{0,100}(?:then|before|merge)|full gate suite|gate-before-act|verified[- ]merge gate)\b/i },
  { name: "stop-and-report", pole: "determinism-impose", context: "a true preference fork, explicit scope wall, external block, or unsafe boundary is reached", latitudeOrGuardrail: "bank evidence, stop mutation, and surface the bounded decision", pattern: /\b(?:stop[- +]and[- +](?:report|escalate|show)|stop\+escalate|stop and report|report (?:it )?and stop)\b/i },
  { name: "ab-with-recommendation", pole: "determinism-impose", context: "multiple valid outcomes encode taste or a workflow change needs measurement", latitudeOrGuardrail: "present bounded alternatives or control/treatment evidence with a recommendation", pattern: /\b(?:options?|frontier|A\/B|control\/treatment|control and treatment)\b[\s\S]{0,220}\brecommend(?:ation|ed)?\b|\brecommend(?:ation|ed)?\b[\s\S]{0,180}\b(?:options?|A\/B|control\/treatment)\b/i },
];

function hash(text: string): string { return new Bun.CryptoHasher("sha256").update(text).digest("hex"); }
function snippet(text: string): string {
  const clean = redact(text).replace(/\s+/g, " ").trim();
  return clean.length > 300 ? clean.slice(0, 299) + "…" : clean;
}
export function isOperatorTurn(turn: Turn, prior?: Turn): boolean {
  if (turn.role !== "user" || !turn.content.trim() || prior?.toolCalls?.length) return false;
  const text = turn.content.trim();
  return !/^(?:<teammate-message|<task-notification|<codex_internal_context|<system-reminder|<persisted-output|\{\s*"success"|\d+\s*[:\t]|\.\.\.\/|diff --git|Web search results|HEAD:|Script completed|Another Claude session|Base directory for this skill|Usage:|Task #\d+|Checkpoint report:|File (?:created|updated)|The file |The following is the Codex agent history|This session is being continued|#\s+(?:AGENTS|CLAUDE)\.md instructions)/i.test(text)
    && !/\b(?:idle_notification|external_agent_tool_result)\b/.test(text);
}
export function classifyOrchestrationTurn(text: string): Array<{ pole: OrchestrationPole; signal: SignalName }> {
  return SIGNALS.filter((signal) => signal.pattern.test(text)).map(({ pole, name: signal }) => ({ pole, signal }));
}
function predictedPole(matches: Array<{ pole: OrchestrationPole; signal: SignalName }>): OrchestrationPole | undefined {
  if (matches.some((item) => item.signal === "stop-and-report" || item.signal === "one-writer" || item.signal === "spec-freeze")) return "determinism-impose";
  if (matches.some((item) => item.pole === "autonomy-grant")) return "autonomy-grant";
  if (matches.some((item) => item.pole === "determinism-impose")) return "determinism-impose";
}
async function atomicWrite(path: string, data: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, data, { mode: 0o600 }); await rename(temp, path); await chmod(path, 0o600);
}
async function loadConversation(root: string, conversationHash: string): Promise<Conversation> {
  return JSON.parse(await readFile(join(root, "corpus", "objects", conversationHash.slice(0, 2), `${conversationHash}.json`), "utf8"));
}
export async function resolveOrchestrationPointer(root: string, pointer: string): Promise<Turn> {
  const match = /^chatlog:\/\/conversation\/([0-9a-f]{64})\/turn\/(\d+)$/.exec(pointer);
  if (!match) throw new Error(`invalid chatlog pointer: ${pointer}`);
  const conversation = await loadConversation(root, match[1]); const turn = conversation.turns[Number(match[2])];
  if (!turn) throw new Error(`unresolvable chatlog pointer: ${pointer}`);
  return turn;
}

function validation(labels: OrchestrationLabel[], byPointer: Map<string, Match[]>) {
  const rows = labels.map((label) => {
    const pointer = `chatlog://conversation/${label.conversationHash}/turn/${label.turnIndex}`;
    const found = byPointer.get(pointer) ?? [];
    const signalAgreement = found.some((item) => item.signal === label.expectedSignal && item.pole === label.expectedPole);
    const prediction = predictedPole(found);
    return { split: label.split, pointer, expectedPole: label.expectedPole, expectedSignal: label.expectedSignal, prediction: prediction ?? "no-signal", signalAgreement, correct: prediction === label.expectedPole };
  });
  const summarize = (split: OrchestrationLabel["split"]) => {
    const sample = rows.filter((row) => row.split === split); const correct = sample.filter((row) => row.correct).length;
    const signalCorrect = sample.filter((row) => row.signalAgreement).length;
    const counts = new Map<OrchestrationPole, number>(); sample.forEach((row) => counts.set(row.expectedPole, (counts.get(row.expectedPole) ?? 0) + 1));
    const baseRateCorrect = Math.max(0, ...counts.values());
    return { sampleSize: sample.length, signalAgreement: signalCorrect / sample.length, accuracy: correct / sample.length, baseRate: baseRateCorrect / sample.length };
  };
  return { agreedErrorBar: { minimumSignalAgreement: 0.85 }, calibration: summarize("calibration"), heldOut: summarize("held-out"), rows };
}

export async function buildOrchestrationProfile(root: string, labels: OrchestrationLabel[]): Promise<any> {
  const projectionText = await readFile(join(root, "derived", "current-hashes.jsonl"), "utf8");
  const hashes = projectionText.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line).conversationHash as string).sort();
  const matches: Match[] = []; const conversationSets = new Map<SignalName, Set<string>>();
  for (const conversationHash of hashes) {
    const conversation = await loadConversation(root, conversationHash);
    conversation.turns.forEach((turn, turnIndex) => {
      if (!isOperatorTurn(turn, conversation.turns[turnIndex - 1])) return;
      for (const classified of classifyOrchestrationTurn(turn.content)) {
        const pointer = `chatlog://conversation/${conversationHash}/turn/${turnIndex}`;
        matches.push({ ...classified, conversationHash, turnIndex, pointer, snippet: snippet(turn.content) });
        const set = conversationSets.get(classified.signal) ?? new Set<string>(); set.add(conversationHash); conversationSets.set(classified.signal, set);
      }
    });
  }
  matches.sort((a, b) => a.signal.localeCompare(b.signal) || a.conversationHash.localeCompare(b.conversationHash) || a.turnIndex - b.turnIndex);
  const byPointer = new Map<string, Match[]>();
  for (const item of matches) { const rows = byPointer.get(item.pointer) ?? []; rows.push(item); byPointer.set(item.pointer, rows); }
  for (const label of labels) {
    const pointer = `chatlog://conversation/${label.conversationHash}/turn/${label.turnIndex}`;
    await resolveOrchestrationPointer(root, pointer);
    if (!byPointer.has(pointer)) byPointer.set(pointer, []);
  }
  const labelledPointers = new Set(labels.map((label) => `chatlog://conversation/${label.conversationHash}/turn/${label.turnIndex}`));
  const inventories = SIGNALS.map((definition) => {
    const rows = matches.filter((item) => item.signal === definition.name);
    const evidenceEligible = (item: Match) => labelledPointers.has(item.pointer) || /^(?:Great\b|Operator\b|Build\b|Resume\b|Continue\b|New work\b|Assigned task\b|Manager coordination\b|O\d+[a-z]?\b|Implement\b|## (?:GOAL|Objective|Mission)\b)/i.test(item.snippet);
    const ranked = rows.filter(evidenceEligible).sort((a, b) => Number(labelledPointers.has(b.pointer)) - Number(labelledPointers.has(a.pointer)) || a.snippet.length - b.snippet.length || a.pointer.localeCompare(b.pointer));
    const diverse: Match[] = []; const seen = new Set<string>();
    for (const row of ranked) { if (seen.has(row.conversationHash)) continue; seen.add(row.conversationHash); diverse.push(row); if (diverse.length === 3) break; }
    return { pole: definition.pole, signal: definition.name, claim: definition.pole === "autonomy-grant" ? `Grants autonomy when ${definition.context}: ${definition.latitudeOrGuardrail}.` : `Imposes a guardrail when ${definition.context}: ${definition.latitudeOrGuardrail}.`, matchingTurns: rows.length, conversations: conversationSets.get(definition.name)?.size ?? 0, evidence: diverse.map(({ pointer, snippet }) => ({ pointer, snippet })) };
  });
  const unsupportedInventory = inventories.find((item) => item.evidence.length === 0);
  if (unsupportedInventory) throw new Error(`no supportable evidence for orchestration claim: ${unsupportedInventory.signal}`);
  const autonomyEvidence = inventories.filter((item) => item.pole === "autonomy-grant").flatMap((item) => item.evidence.slice(0, 1));
  const determinismEvidence = inventories.filter((item) => item.pole === "determinism-impose").flatMap((item) => item.evidence.slice(0, 1));
  const assessed = validation(labels, byPointer);
  if (assessed.calibration.signalAgreement < assessed.agreedErrorBar.minimumSignalAgreement) throw new Error("lean-signal validity falsifier failed");
  if (assessed.heldOut.accuracy <= assessed.heldOut.baseRate) throw new Error("decision-boundary held-out falsifier failed");
  for (const item of inventories.flatMap((inventory) => inventory.evidence)) {
    const turn = await resolveOrchestrationPointer(root, item.pointer);
    if (!classifyOrchestrationTurn(turn.content).length) throw new Error(`unsupported evidence pointer: ${item.pointer}`);
  }
  const inputProjectionHash = hash(projectionText);
  return {
    schemaVersion: 1, outputKind: "orchestration-lean", inputProjectionHash,
    finding: {
      claim: "The operator is autonomy-leaning inside a bounded lane, not autonomy-maximizing: agents may choose and execute ordinary means continuously, while deterministic ownership, frozen intent, evidence gates, and explicit stop conditions define the lane.",
      evidence: [...autonomyEvidence.slice(0, 3), ...determinismEvidence.slice(0, 3)],
      decisionBoundary: {
        grantsAutonomy: { claim: "Grant autonomy when direction and scope are authored, the next step is bounded, and verification can police the result; permit implementation non-determinism through local decisions, tracer execution, and authorized integration without approval waits.", evidence: autonomyEvidence },
        imposesGuardrail: { claim: "Impose determinism at contention, intent, acceptance, and authority boundaries: one writer, a frozen/re-readable spec, real gates before acceptance, and stop-and-report at preference, scope, external, or unsafe forks.", evidence: determinismEvidence },
      },
    },
    inventories, validation: assessed,
    policy: { autoPromotion: false, roleSegmentation: false, modelRouting: "not emitted in slice 1; no model name is fossilized" },
    egress: { performed: false, surface: "none", hostedCalls: 0, declaration: "Default orchestration-profile derivation reads only local redacted corpus and derived projection files." },
  };
}

export async function deriveOrchestrationProfile(root: string, labelsPath = join(import.meta.dir, "orchestration-labels.json")): Promise<{ processed: boolean; artifactPath: string; contentHash: string; inputProjectionHash: string }> {
  const labelsText = await readFile(labelsPath, "utf8"); const labels = JSON.parse(labelsText) as OrchestrationLabel[];
  const projectionText = await readFile(join(root, "derived", "current-hashes.jsonl"), "utf8"); const inputProjectionHash = hash(projectionText);
  const recipeHash = hash(await Bun.file(import.meta.path).text() + "\n" + labelsText);
  const manifestPath = join(root, "derived", "orchestration-lean-manifest.json");
  let manifest: any = { version: 1 }; try { manifest = JSON.parse(await readFile(manifestPath, "utf8")); } catch (error: any) { if (error?.code !== "ENOENT") throw error; }
  if (manifest.current?.inputProjectionHash === inputProjectionHash && manifest.current?.recipeHash === recipeHash) {
    const artifactPath = join(root, "derived", manifest.current.artifactPath); try { await stat(artifactPath); return { processed: false, artifactPath, contentHash: manifest.current.contentHash, inputProjectionHash }; } catch {}
  }
  const artifact = await buildOrchestrationProfile(root, labels); const text = JSON.stringify(artifact, null, 2) + "\n"; const contentHash = hash(text);
  const artifactRel = `orchestration-lean/${contentHash.slice(0, 2)}/${contentHash}.json`; await atomicWrite(join(root, "derived", artifactRel), text);
  manifest.current = { inputProjectionHash, recipeHash, artifactPath: artifactRel, contentHash }; await atomicWrite(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  return { processed: true, artifactPath: join(root, "derived", artifactRel), contentHash, inputProjectionHash };
}
export async function loadOrchestrationProfile(root: string): Promise<any> {
  const manifest = JSON.parse(await readFile(join(root, "derived", "orchestration-lean-manifest.json"), "utf8"));
  if (!manifest.current) throw new Error("orchestration profile has not been derived");
  return JSON.parse(await readFile(join(root, "derived", manifest.current.artifactPath), "utf8"));
}
