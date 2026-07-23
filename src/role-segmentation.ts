import { chmod, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Conversation, Turn } from "./types";
import { classifyOrchestrationTurn, isOperatorTurn, resolveOrchestrationPointer, type OrchestrationPole, type SignalName } from "./orchestration-profile";
import { redact } from "./redact";

export type AgentRole = "manager" | "worker" | "reviewer" | "advisor" | "unclassified";
export interface RoleLabel { conversationHash: string; evidenceTurnIndex: number; expectedRole: Exclude<AgentRole, "unclassified"> }
interface RoleScore { role: Exclude<AgentRole, "unclassified">; score: number; reasons: string[]; evidenceTurnIndex?: number }
interface RoleInference {
  role: AgentRole; confidence: "high" | "medium" | "low"; score: number; margin: number; reasons: string[];
  evidence?: { pointer: string; snippet: string }; interaction: { delegationCalls: number; mutationCalls: number; researchCalls: number; harness: string; projectPresent: boolean };
}
interface SignalEvidence { pointer: string; snippet: string; signal: SignalName; pole: OrchestrationPole }

const ROLE_ORDER: Array<Exclude<AgentRole, "unclassified">> = ["reviewer", "advisor", "manager", "worker"];
const ROLE_DEFINITIONS: Record<Exclude<AgentRole, "unclassified">, string> = {
  manager: "coordinates flow or a team, delegates work, and retains sequencing or acceptance judgment",
  worker: "owns bounded implementation or mutation in an assigned tree or task",
  reviewer: "independently audits or falsifies an artifact and returns a verdict without owning implementation",
  advisor: "researches or consults read-only, mapping facts and options without implementation authority",
};
const SIGNAL_LABEL: Record<SignalName, string> = {
  "self-propel": "self-propel", "tracer-and-continue": "tracer-and-continue", "recommend-and-proceed": "recommend-and-proceed",
  "dont-wait-for-approval": "do-not-wait", "one-writer": "one-writer", "spec-freeze": "frozen-intent",
  "gate-before-act": "gate-before-act", "stop-and-report": "stop-and-report", "ab-with-recommendation": "bounded-options-with-recommendation",
};

function hash(text: string): string { return new Bun.CryptoHasher("sha256").update(text).digest("hex"); }
function short(text: string, limit = 300): string {
  const clean = redact(text).replace(/\s+/g, " ").trim(); return clean.length > limit ? clean.slice(0, limit - 1) + "…" : clean;
}
function pointer(hashValue: string, turnIndex: number): string { return `chatlog://conversation/${hashValue}/turn/${turnIndex}`; }
function launchEligible(turn: Turn): boolean {
  if (turn.role !== "user" || !turn.content.trim()) return false;
  return !/^(?:# (?:AGENTS|CLAUDE)\.md instructions|<codex_internal_context|<system-reminder|The following is the Codex agent history|This session is being continued)/i.test(turn.content.trim());
}
function add(score: RoleScore, points: number, reason: string, turnIndex: number): void {
  score.score += points; if (!score.reasons.includes(reason)) score.reasons.push(reason); score.evidenceTurnIndex ??= turnIndex;
}

export function inferAgentRole(conversation: Conversation): RoleInference {
  const scores = new Map(ROLE_ORDER.map((role) => [role, { role, score: 0, reasons: [] } as RoleScore]));
  const launch = conversation.turns.slice(0, 40).map((turn, turnIndex) => ({ turn, turnIndex })).filter(({ turn }) => launchEligible(turn));
  let explicitAnchor: Exclude<AgentRole, "unclassified"> | undefined;
  for (const { turn, turnIndex } of launch) {
    const text = turn.content.slice(0, 12_000);
    const reviewer = scores.get("reviewer")!; const advisor = scores.get("advisor")!; const manager = scores.get("manager")!; const worker = scores.get("worker")!;
    if (/@agent-manager-orchestrator|\bmanager[- /]orchestrator\b|\btake on the role as (?:agent )?manager\b/i.test(text)) explicitAnchor = "manager";
    else if (/Launching skill:\s*(?:code-)?review\b/i.test(text)) explicitAnchor = "reviewer";
    else if (/\b(?:act as|you are)\b[\s\S]{0,80}\b(?:advisor|consultant)\b|\bweb research only\b|\bresearch only\b|\b(?:strategic |architectural )?consultation only\b|\bread-only (?:strategic |architectural )?consultation\b/i.test(text)) explicitAnchor = "advisor";
    else if (/^(?:##?\s*)?(?:GOAL:\s*)?(?:Implement|Build|Repair|Close)\b/i.test(text) || /\bsole writer\b|\byou are (?:the )?(?:only |sole )?writer\b/i.test(text)) explicitAnchor = "worker";
    else if (/\bread-only (?:independent )?(?:review|audit)\b|\bindependent (?:review|audit)\b|\b(?:reviewer|review-only)\b|\btry to falsify\b|\bverdict (?:ship|accept|block)\b/i.test(text)) explicitAnchor = "reviewer";
    if (explicitAnchor) { add(scores.get(explicitAnchor)!, 30, "earliest explicit launch-role anchor", turnIndex); break; }
    if (/Launching skill:\s*(?:code-)?review\b/i.test(text)) add(reviewer, 20, "explicit review skill label", turnIndex);
    if (/\bread-only (?:independent )?(?:review|audit)\b|\bindependent (?:review|audit)\b/i.test(text)) add(reviewer, 8, "read-only independent review launch", turnIndex);
    if (/\b(?:reviewer|review-only)\b|\btry to falsify\b|\bverdict (?:ship|accept|block)\b/i.test(text)) add(reviewer, 6, "verdict/falsification mandate", turnIndex);

    if (/\bweb research only\b|\bresearch only\b/i.test(text)) add(advisor, 9, "explicit research-only launch", turnIndex);
    if (/\b(?:strategic |architectural )?consultation only\b|\bread-only (?:strategic |architectural )?consultation\b/i.test(text)) add(advisor, 15, "explicit consultation-only launch", turnIndex);
    if (/\b(?:senior |strategic |research )?advisor\b|\bdo not implement\b[\s\S]{0,100}\brecommend/i.test(text)) add(advisor, 6, "advisory recommendation mandate", turnIndex);

    if (/@agent-manager-orchestrator|\bmanager[- /]orchestrator\b/i.test(text)) add(manager, 10, "explicit manager-orchestrator label", turnIndex);
    if (/\b(?:agent|fleet|project|product) manager\b|\bproduct[- ]lead\b/i.test(text)) add(manager, 7, "explicit manager/product-lead role", turnIndex);
    if (/\bmanagerial overview\b|\borchestrat(?:e|ing) (?:subagents|agents|the fleet)\b|\bdispatch (?:work|agents|subagents)\b/i.test(text)) add(manager, 5, "delegation and sequencing mandate", turnIndex);

    if (/\bsole writer\b|\byou are (?:the )?(?:only |sole )?writer\b/i.test(text)) add(worker, 9, "explicit writer ownership", turnIndex);
    if (/^(?:##?\s*)?(?:GOAL:\s*)?(?:Implement|Build|Repair|Close)\b/i.test(text)) add(worker, 15, "implementation launch", turnIndex);
    if (/\bImplement Task \d+\b|\bAssigned task\b[\s\S]{0,120}\bexecute\b|\bwork only in (?:the )?(?:assigned |isolated )?(?:tree|worktree|clone)\b/i.test(text)) add(worker, 6, "bounded execution assignment", turnIndex);
  }
  let delegationCalls = 0; let mutationCalls = 0; let researchCalls = 0;
  for (const turn of conversation.turns) for (const call of turn.toolCalls ?? []) {
    if (/^(?:Agent|Task|SendMessage|TeamCreate|agent-dispatch|herdr)$/i.test(call.name)) delegationCalls++;
    if (/^(?:Edit|Write|apply_patch|MultiEdit)$/i.test(call.name)) mutationCalls++;
    if (/^(?:WebSearch|WebFetch|web_search|search_query)$/i.test(call.name)) researchCalls++;
  }
  if (delegationCalls >= 3) add(scores.get("manager")!, 3, "delegation interaction shape", launch[0]?.turnIndex ?? 0);
  if (mutationCalls >= 3) add(scores.get("worker")!, 2, "mutation interaction shape", launch[0]?.turnIndex ?? 0);
  if (researchCalls >= 3 && mutationCalls === 0) add(scores.get("advisor")!, 2, "read-only research interaction shape", launch[0]?.turnIndex ?? 0);
  const ranked = [...scores.values()].sort((a, b) => b.score - a.score || ROLE_ORDER.indexOf(a.role) - ROLE_ORDER.indexOf(b.role));
  const winner = ranked[0]; const margin = winner.score - ranked[1].score;
  const interaction = { delegationCalls, mutationCalls, researchCalls, harness: conversation.harness, projectPresent: Boolean(conversation.project) };
  if (winner.score < 3) return { role: "unclassified", confidence: "low", score: winner.score, margin, reasons: [], interaction };
  const evidenceTurnIndex = winner.evidenceTurnIndex ?? launch[0]?.turnIndex;
  return {
    role: winner.role, confidence: winner.score >= 7 && margin >= 3 ? "high" : "medium", score: winner.score, margin, reasons: winner.reasons, interaction,
    ...(evidenceTurnIndex == null ? {} : { evidence: { pointer: pointer(conversation.contentHash, evidenceTurnIndex), snippet: short(conversation.turns[evidenceTurnIndex].content) } }),
  };
}

function roleEvidenceEligible(role: Exclude<AgentRole, "unclassified">, text: string): boolean {
  const clean = text.trim();
  if (role === "manager") return /^(?:Great\b|Operator\b|Resume\b|Continue\b|Manager coordination\b|@agent-manager)/i.test(clean) && !/^You are [\s\S]{0,80}\b(?:engineer|worker|reviewer|advisor)\b/i.test(clean);
  if (role === "worker") return /^(?:Build\b|Implement\b|Assigned task\b|You are (?:the )?(?:executor|sole writer|worker)|## (?:GOAL|Objective|Mission)\b)/i.test(clean);
  if (role === "reviewer") return /^(?:Great\b|Read-only\b|Independent (?:review|audit)\b|You are [\s\S]{0,80}\breviewer\b|Launching skill: (?:code-)?review)/i.test(clean);
  return /^(?:Great\b|Act as [\s\S]{0,80}\b(?:advisor|consultant)\b|Read-only [\s\S]{0,80}\b(?:advisor|consultation|research)\b|Web research only\b|Research only\b|O\d+[a-z]?\b)/i.test(clean);
}
function dominantPole(matches: Array<{ pole: OrchestrationPole; signal: SignalName }>): OrchestrationPole {
  if (matches.some((item) => item.signal === "stop-and-report" || item.signal === "one-writer" || item.signal === "spec-freeze")) return "determinism-impose";
  return matches.some((item) => item.pole === "autonomy-grant") ? "autonomy-grant" : "determinism-impose";
}
function wilson(successes: number, total: number): [number, number] {
  if (!total) return [0, 0]; const z = 1.96; const p = successes / total; const d = 1 + z * z / total;
  const center = (p + z * z / (2 * total)) / d; const spread = z * Math.sqrt(p * (1 - p) / total + z * z / (4 * total * total)) / d;
  return [Math.max(0, center - spread), Math.min(1, center + spread)];
}
function intervalsSeparate(a: [number, number], b: [number, number]): boolean { return a[1] < b[0] || b[1] < a[0]; }
async function loadConversation(root: string, conversationHash: string): Promise<Conversation> {
  return JSON.parse(await readFile(join(root, "corpus", "objects", conversationHash.slice(0, 2), `${conversationHash}.json`), "utf8"));
}
async function atomicWrite(path: string, data: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 }); const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, data, { mode: 0o600 }); await rename(temp, path); await chmod(path, 0o600);
}

export async function buildRoleSegmentation(root: string, labels: RoleLabel[]): Promise<any> {
  const projectionText = await readFile(join(root, "derived", "current-hashes.jsonl"), "utf8");
  const hashes = projectionText.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line).conversationHash as string).sort();
  const roles = new Map<string, RoleInference>(); const conversations = new Map<string, Conversation>();
  for (const conversationHash of hashes) { const conversation = await loadConversation(root, conversationHash); conversations.set(conversationHash, conversation); roles.set(conversationHash, inferAgentRole(conversation)); }

  const validationRows = [] as any[];
  for (const label of labels) {
    const conversation = conversations.get(label.conversationHash) ?? await loadConversation(root, label.conversationHash);
    const evidencePointer = pointer(label.conversationHash, label.evidenceTurnIndex); await resolveOrchestrationPointer(root, evidencePointer);
    const inferred = inferAgentRole(conversation);
    validationRows.push({ pointer: evidencePointer, expectedRole: label.expectedRole, inferredRole: inferred.role, correct: inferred.role === label.expectedRole, reasons: inferred.reasons });
  }
  const correct = validationRows.filter((row) => row.correct).length; const accuracy = correct / validationRows.length;
  const byExpectedRole = ROLE_ORDER.map((role) => { const rows = validationRows.filter((row) => row.expectedRole === role); return { role, sampleSize: rows.length, accuracy: rows.filter((row) => row.correct).length / rows.length }; });
  const roleValidity = { agreedErrorBar: { maximumContradictionRate: 0.1 }, sampleSize: validationRows.length, accuracy, contradictionRate: 1 - accuracy, byExpectedRole, rows: validationRows };
  if (accuracy < 0.9 || byExpectedRole.some((row) => row.sampleSize < 2 || row.accuracy < 0.8)) throw new Error("role-inference validity falsifier failed");

  const roleData = new Map(ROLE_ORDER.map((role) => [role, { sessions: 0, choices: [] as OrchestrationPole[], signals: new Map<SignalName, number>(), evidence: [] as SignalEvidence[] }]));
  for (const conversationHash of hashes) {
    const inference = roles.get(conversationHash)!; if (inference.role === "unclassified" || inference.confidence !== "high") continue;
    const data = roleData.get(inference.role)!; data.sessions++; const conversation = conversations.get(conversationHash)!;
    conversation.turns.forEach((turn, turnIndex) => {
      if (!isOperatorTurn(turn, conversation.turns[turnIndex - 1])) return;
      const matches = classifyOrchestrationTurn(turn.content); if (!matches.length) return;
      data.choices.push(dominantPole(matches));
      for (const match of matches) {
        data.signals.set(match.signal, (data.signals.get(match.signal) ?? 0) + 1);
        if (data.evidence.length < 200 && roleEvidenceEligible(inference.role, turn.content)) data.evidence.push({ pointer: pointer(conversationHash, turnIndex), snippet: short(turn.content), signal: match.signal, pole: match.pole });
      }
    });
  }
  const labelledByRole = new Map(ROLE_ORDER.map((role) => [role, labels.filter((label) => label.expectedRole === role)]));
  const taxonomy = ROLE_ORDER.map((role) => {
    const data = roleData.get(role)!; const evidence = labelledByRole.get(role)!.slice(0, 3).map((label) => { const turn = conversations.get(label.conversationHash)!.turns[label.evidenceTurnIndex]; return { pointer: pointer(label.conversationHash, label.evidenceTurnIndex), snippet: short(turn.content) }; });
    return { role, claim: `${role} is corpus-anchored as a session that ${ROLE_DEFINITIONS[role]}.`, inferredSessions: data.sessions, evidence };
  });
  const profiles = ROLE_ORDER.map((role) => {
    const data = roleData.get(role)!; const autonomyChoices = data.choices.filter((choice) => choice === "autonomy-grant").length; const totalChoices = data.choices.length;
    const autonomyRate = totalChoices ? autonomyChoices / totalChoices : 0; const interval = wilson(autonomyChoices, totalChoices);
    const top = (pole: OrchestrationPole) => [...data.signals].filter(([signal]) => {
      const sample = data.evidence.find((item) => item.signal === signal); return sample?.pole === pole;
    }).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    const topAutonomy = top("autonomy-grant").slice(0, 2); const topGuardrail = top("determinism-impose").slice(0, 2);
    const selected: SignalEvidence[] = []; const used = new Set<string>();
    for (const [signal] of [...topAutonomy, ...topGuardrail]) for (const item of data.evidence) {
      if (item.signal !== signal || used.has(item.pointer)) continue; used.add(item.pointer); selected.push(item); break;
    }
    if (!selected.some((item) => item.pole === "autonomy-grant")) { const item = data.evidence.find((row) => row.pole === "autonomy-grant"); if (item) selected.push(item); }
    if (!selected.some((item) => item.pole === "determinism-impose")) { const item = data.evidence.find((row) => row.pole === "determinism-impose"); if (item) selected.push(item); }
    if (!selected.length) throw new Error(`no evidence for role boundary: ${role}`);
    const autonomyNames = topAutonomy.map(([signal]) => SIGNAL_LABEL[signal]).join(" and ") || "no recurring autonomy signal";
    const guardrailNames = topGuardrail.map(([signal]) => SIGNAL_LABEL[signal]).join(" and ") || "no recurring guardrail signal";
    return {
      role, inferredSessions: data.sessions, classifiedChoices: totalChoices, autonomyChoices, determinismChoices: totalChoices - autonomyChoices,
      autonomyChoiceRate: autonomyRate, autonomyChoiceWilson95: interval,
      claim: `For inferred ${role} sessions, observed autonomy latitude appears through ${autonomyNames}; observed constraints appear through ${guardrailNames}. The measured autonomy-choice rate is ${autonomyChoices}/${totalChoices}; this is a boundary description, not a role quality score.`,
      signalCounts: [...data.signals].map(([signal, count]) => ({ signal, count })).sort((a, b) => b.count - a.count || a.signal.localeCompare(b.signal)),
      evidence: selected.map(({ pointer: evidencePointer, snippet, signal, pole }) => ({ pointer: evidencePointer, snippet, signal, pole })),
    };
  });
  const pairs = [] as any[];
  for (let left = 0; left < profiles.length; left++) for (let right = left + 1; right < profiles.length; right++) {
    const a = profiles[left]; const b = profiles[right]; const effect = Math.abs(a.autonomyChoiceRate - b.autonomyChoiceRate);
    pairs.push({ roles: [a.role, b.role], sampleSizes: [a.classifiedChoices, b.classifiedChoices], autonomyRateDifference: effect, wilsonIntervalsSeparate: intervalsSeparate(a.autonomyChoiceWilson95 as [number, number], b.autonomyChoiceWilson95 as [number, number]), distinguishable: a.classifiedChoices >= 15 && b.classifiedChoices >= 15 && effect >= 0.1 && intervalsSeparate(a.autonomyChoiceWilson95 as [number, number], b.autonomyChoiceWilson95 as [number, number]) });
  }
  const distinguishablePairs = pairs.filter((pair) => pair.distinguishable);
  if (!distinguishablePairs.length) throw new Error("per-role boundaries are not distinguishable beyond noise");
  for (const item of [...taxonomy.flatMap((entry) => entry.evidence), ...profiles.flatMap((entry) => entry.evidence)]) await resolveOrchestrationPointer(root, item.pointer);
  const inferredCounts = Object.fromEntries([...ROLE_ORDER, "unclassified" as const].map((role) => [role, [...roles.values()].filter((item) => item.role === role).length]));
  return {
    schemaVersion: 1, outputKind: "orchestration-role-boundaries", inputProjectionHash: hash(projectionText),
    taxonomy, inferenceMethod: { claim: "Roles are inferred from corpus-observed launch labels and mandates, then supported by delegation, mutation, or research interaction shape. Project and harness are retained as provenance but never mapped to a role by a hardcoded project or model name.", evidence: taxonomy.flatMap((entry) => entry.evidence.slice(0, 1)), signals: ["launch-prompt content", "embedded Herdr/skill label", "delegation/mutation/research tool shape", "project/harness provenance"] },
    inferredCounts, profiles,
    validation: { roleInference: roleValidity, distinguishability: { method: "absolute autonomy-choice-rate difference >= 0.10 with non-overlapping Wilson 95% intervals and >=15 classified choices per role", pairs, distinguishablePairs } },
    policy: { autoPromotion: false, modelRouting: "not emitted; no model name is fossilized", slice3EffectivenessRanking: "not started" },
    egress: { performed: false, surface: "none", hostedCalls: 0, declaration: "Default role segmentation reads only local redacted corpus and derived projection files." },
  };
}

export async function deriveRoleSegmentation(root: string, labelsPath = join(import.meta.dir, "orchestration-role-labels.json")): Promise<{ processed: boolean; artifactPath: string; contentHash: string; inputProjectionHash: string }> {
  const labelsText = await readFile(labelsPath, "utf8"); const labels = JSON.parse(labelsText) as RoleLabel[];
  const projectionText = await readFile(join(root, "derived", "current-hashes.jsonl"), "utf8"); const inputProjectionHash = hash(projectionText);
  const recipeHash = hash(await Bun.file(import.meta.path).text() + "\n" + await Bun.file(join(import.meta.dir, "orchestration-profile.ts")).text() + "\n" + labelsText);
  const manifestPath = join(root, "derived", "orchestration-roles-manifest.json"); let manifest: any = { version: 1 };
  try { manifest = JSON.parse(await readFile(manifestPath, "utf8")); } catch (error: any) { if (error?.code !== "ENOENT") throw error; }
  if (manifest.current?.inputProjectionHash === inputProjectionHash && manifest.current?.recipeHash === recipeHash) {
    const artifactPath = join(root, "derived", manifest.current.artifactPath); try { await stat(artifactPath); return { processed: false, artifactPath, contentHash: manifest.current.contentHash, inputProjectionHash }; } catch {}
  }
  const artifact = await buildRoleSegmentation(root, labels); const text = JSON.stringify(artifact, null, 2) + "\n"; const contentHash = hash(text);
  const artifactRel = `orchestration-roles/${contentHash.slice(0, 2)}/${contentHash}.json`; await atomicWrite(join(root, "derived", artifactRel), text);
  manifest.current = { inputProjectionHash, recipeHash, artifactPath: artifactRel, contentHash }; await atomicWrite(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  return { processed: true, artifactPath: join(root, "derived", artifactRel), contentHash, inputProjectionHash };
}
export async function loadRoleSegmentation(root: string): Promise<any> {
  const manifest = JSON.parse(await readFile(join(root, "derived", "orchestration-roles-manifest.json"), "utf8"));
  if (!manifest.current) throw new Error("role segmentation has not been derived"); return JSON.parse(await readFile(join(root, "derived", manifest.current.artifactPath), "utf8"));
}
