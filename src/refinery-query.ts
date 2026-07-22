import { loadRefinery, type PromotionType } from "./refinery";

const TYPES = new Set<PromotionType>(["skill", "gotcha-skill", "memory-or-adr", "claude-md", "wiki-page-later"]);
const contentHash = (value: unknown) => new Bun.CryptoHasher("sha256").update(JSON.stringify(value)).digest("hex");

export async function agentRefinery(root: string, type?: string, limit = 30): Promise<unknown> {
  if (type && !TYPES.has(type as PromotionType)) throw new Error(`unknown promotion type: ${type}`);
  const artifact = await loadRefinery(root);
  const selected = artifact.candidates.filter((candidate) => !type || candidate.type === type).slice(0, Math.max(1, Math.min(100, limit)));
  const byType = Object.fromEntries([...TYPES].map((kind) => [kind, artifact.candidates.filter((candidate) => candidate.type === kind).length]));
  return {
    policy: artifact.policy, threshold: artifact.threshold, inputProjectionHash: artifact.inputProjectionHash,
    totalCandidates: artifact.candidates.length, byType,
    candidates: selected.map((candidate) => ({
      id: candidate.id, type: candidate.type, title: candidate.title, signature: candidate.signature, status: candidate.status,
      frequency: candidate.frequency, evidencePointers: candidate.evidence.slice(0, 3).map((item) => ({ project: item.project, pointer: item.pointer })),
      route: candidate.curation.route, evaluationStatus: candidate.evaluation.status,
    })),
  };
}

export async function agentRefineryCandidate(root: string, id: string): Promise<unknown> {
  const artifact = await loadRefinery(root); const candidate = artifact.candidates.find((item) => item.id === id);
  if (!candidate) throw new Error(`refinery candidate not found: ${id}`);
  return { policy: artifact.policy, candidate };
}

export async function agentRefineryEvalPlan(root: string, id: string): Promise<unknown> {
  const artifact = await loadRefinery(root); const candidate = artifact.candidates.find((item) => item.id === id);
  if (!candidate) throw new Error(`refinery candidate not found: ${id}`);
  return {
    candidate: { id: candidate.id, contentHash: contentHash(candidate), type: candidate.type, title: candidate.title, signature: candidate.signature, frequency: candidate.frequency },
    evidencePointers: candidate.evidence.map((item) => ({ project: item.project, pointer: item.pointer })),
    evaluation: candidate.evaluation,
    eligibility: { eligible: false, blockedOn: "curator acceptance plus installation through the candidate's intended skill/memory/CLAUDE.md channel" },
    agentEvalTaskRequirements: ["same repo and clean start commit per arm", "objective gate that fails before and can pass after", "at least three paired control/treatment runs", "treatment exposed only through the intended promoted channel", "record explicit rederivation markers in addition to existing agent-eval metrics"],
  };
}
