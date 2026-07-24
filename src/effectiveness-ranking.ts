import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { resolveOrchestrationPointer } from "./orchestration-profile";
import {
  DerivedProjectionDriftError,
  loadCurrentDerivedArtifact,
  loadProjectionBoundArtifact,
} from "./derived-authority";

interface PilotConfig {
  schema: "chatlog/orchestration-effectiveness-pilot-v1";
  role: string;
  candidatePattern: string;
  alternative: string;
  experimentPath: string;
  agentEvalRoot: string;
  realTaskReferencePath: string;
  minimumPairs: number;
  pilotEgress: { performed: true; hostedCalls: number; surface: string; authorization: string; maxBudgetUsdPerCall: number };
}
interface PromotionRun {
  pairId: string; arm: "control" | "treatment"; gatePassed: boolean; tokensToGate: number | null;
  wallClockMs: number; interventions: number; rederivationCount: number;
}
interface PromotionExperiment {
  schema: "agent-eval/promotion-v1";
  candidate: { id: string; contentHash: string; channel: string };
  curation: { accepted: true; installedArtifact: string; installedContentHash: string };
  runs: PromotionRun[];
}

function hash(text: string): string { return new Bun.CryptoHasher("sha256").update(text).digest("hex"); }
async function atomicWrite(path: string, data: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 }); const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, data, { mode: 0o600 }); await rename(temp, path); await chmod(path, 0o600);
}
function finiteNonnegative(value: unknown): value is number { return typeof value === "number" && Number.isFinite(value) && value >= 0; }
function validateExperiment(value: unknown, minimumPairs: number): PromotionExperiment {
  if (!value || typeof value !== "object") throw new Error("promotion experiment must be an object"); const experiment = value as any;
  if (experiment.schema !== "agent-eval/promotion-v1" || !Array.isArray(experiment.runs)) throw new Error("expected agent-eval/promotion-v1 runs");
  if (!/^[0-9a-f]{64}$/.test(experiment.candidate?.contentHash ?? "")) throw new Error("promotion candidate contentHash is required");
  const pairs = new Map<string, Set<string>>();
  for (const [index, run] of experiment.runs.entries()) {
    if (!run || typeof run.pairId !== "string" || !["control", "treatment"].includes(run.arm) || typeof run.gatePassed !== "boolean" || (run.tokensToGate !== null && !finiteNonnegative(run.tokensToGate)) || !finiteNonnegative(run.wallClockMs) || !finiteNonnegative(run.interventions) || !finiteNonnegative(run.rederivationCount)) throw new Error(`invalid promotion run ${index}`);
    const arms = pairs.get(run.pairId) ?? new Set<string>(); if (arms.has(run.arm)) throw new Error(`duplicate ${run.arm} in pair ${run.pairId}`); arms.add(run.arm); pairs.set(run.pairId, arms);
  }
  if (pairs.size < minimumPairs) throw new Error(`pilot requires at least ${minimumPairs} pairs`);
  for (const [pairId, arms] of pairs) if (!arms.has("control") || !arms.has("treatment")) throw new Error(`incomplete pair ${pairId}`);
  return experiment as PromotionExperiment;
}
async function runExistingScorer(root: string, experimentPath: string): Promise<any> {
  const scorer = join(root, "src", "promotion-score.ts");
  const process = Bun.spawn(["bun", scorer, experimentPath], { cwd: root, stdout: "pipe", stderr: "pipe", env: { ...processEnv(), NO_COLOR: "1" } });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(process.stdout).text(), new Response(process.stderr).text(), process.exited]);
  if (exitCode !== 0) throw new Error(`agent-eval scorer failed: ${stderr.trim() || exitCode}`);
  return JSON.parse(stdout);
}
function processEnv(): Record<string, string | undefined> { return { ...process.env }; }
function executableAvailable(name: string): boolean { return Boolean(Bun.which(name)); }
function sum(values: number[]): number { return values.reduce((total, value) => total + value, 0); }
async function treatmentConsumption(experimentPath: string, experiment: PromotionExperiment) {
  const artifactText = await readFile(experiment.curation.installedArtifact, "utf8");
  if (hash(artifactText) !== experiment.curation.installedContentHash) throw new Error("installed treatment content hash mismatch");
  const skillName = /^name:\s*(\S+)\s*$/m.exec(artifactText)?.[1]; if (!skillName) throw new Error("treatment skill name is missing");
  const traceRows = [] as Array<{ pairId: string; traceContentHash: string; invoked: boolean }>;
  for (const run of experiment.runs.filter((item) => item.arm === "treatment")) {
    const path = join(dirname(experimentPath), "traces", `pair-${run.pairId}-treatment.jsonl`); const text = await readFile(path, "utf8");
    const invoked = text.includes('"name":"Skill"') && text.includes(`"skill":"${skillName}"`); traceRows.push({ pairId: run.pairId, traceContentHash: hash(text), invoked });
  }
  if (traceRows.some((row) => !row.invoked)) throw new Error("pilot treatment was available but not consumed in every treatment arm");
  return { skillName, invocations: traceRows.length, traces: traceRows, projectionHash: hash(JSON.stringify(traceRows)) };
}

export async function buildEffectivenessRanking(root: string, config: PilotConfig, scorer: (root: string, path: string) => Promise<any> = runExistingScorer): Promise<any> {
  if (config.schema !== "chatlog/orchestration-effectiveness-pilot-v1" || config.minimumPairs < 3) throw new Error("invalid effectiveness pilot config");
  const roleCurrent = await loadProjectionBoundArtifact(root, "orchestration-roles-manifest.json", { optional: true });
  if (!roleCurrent) throw new Error("role segmentation has not been derived");
  const roleReport = roleCurrent.artifact;
  const profile = roleReport.profiles.find((item: any) => item.role === config.role); if (!profile) throw new Error(`role profile not found: ${config.role}`);
  const evidence = profile.evidence.map((item: any) => ({ pointer: item.pointer, snippet: item.snippet }));
  if (!evidence.length) throw new Error(`role profile has no evidence: ${config.role}`);
  for (const item of evidence) await resolveOrchestrationPointer(root, item.pointer);

  const experimentPath = resolve(root, config.experimentPath); const experimentText = await readFile(experimentPath, "utf8");
  const experiment = validateExperiment(JSON.parse(experimentText), config.minimumPairs); const consumption = await treatmentConsumption(experimentPath, experiment);
  if (experiment.candidate.contentHash !== roleCurrent.contentHash) throw new Error("pilot candidate is not bound to the current role-profile content hash");
  const score = await scorer(config.agentEvalRoot, experimentPath);
  if (score.schema !== experiment.schema || score.candidate?.contentHash !== experiment.candidate.contentHash) throw new Error("agent-eval score is not bound to the pilot experiment");
  const candidateWins = score.recommendation === "keep";
  const winner = candidateWins ? config.candidatePattern : config.alternative; const loser = candidateWins ? config.alternative : config.candidatePattern;
  const controlWinsGate = score.control.gatePassRate > score.treatment.gatePassRate;
  const controlWinsCorrections = score.control.medianInterventions < score.treatment.medianInterventions;
  const controlWinsTokens = score.control.medianTokensToGate !== null && score.treatment.medianTokensToGate !== null && score.control.medianTokensToGate < score.treatment.medianTokensToGate;
  const controlWinsRederivation = score.control.medianRederivationCount < score.treatment.medianRederivationCount;
  const betterMetric = candidateWins
    ? score.comparison?.tokensImproved ? "lower median tokens-to-gate" : score.comparison?.rederivationImproved ? "lower median re-derivation" : "higher gate-pass rate"
    : controlWinsGate ? "higher gate-pass rate" : controlWinsCorrections ? "fewer intervention/correction proxies" : controlWinsTokens ? "lower median tokens-to-gate" : controlWinsRederivation ? "lower median re-derivation" : "no measured improvement";
  if (betterMetric === "no measured improvement") throw new Error("effectiveness falsifier failed: scorer found no winning alternative");
  const runs = experiment.runs; const observedTokens = sum(runs.flatMap((run) => run.tokensToGate == null ? [] : [run.tokensToGate])); const observedWallMs = sum(runs.map((run) => run.wallClockMs));
  const realTaskText = await readFile(config.realTaskReferencePath, "utf8"); const realTask = validateExperiment(JSON.parse(realTaskText), config.minimumPairs); const realTaskTokens = sum(realTask.runs.flatMap((run) => run.tokensToGate == null ? [] : [run.tokensToGate])); const realTaskWallMs = sum(realTask.runs.map((run) => run.wallClockMs));
  const runnerSource = await readFile(join(config.agentEvalRoot, "src", "promotion-runner.ts"), "utf8"); const scorerSource = await readFile(join(config.agentEvalRoot, "src", "promotion-score.ts"), "utf8");
  const perCandidateRuns = config.minimumPairs * 2; const roleCount = roleReport.profiles.length;
  const observedPatternCandidates = roleReport.profiles.reduce((count: number, item: any) => count + new Set(item.evidence.map((row: any) => row.signal)).size, 0);
  const scale = (candidates: number) => ({ candidates, hostedCalls: candidates * perCandidateRuns, maximumBudgetUsd: candidates * perCandidateRuns * config.pilotEgress.maxBudgetUsdPerCall, linearWallClockMs: Math.round(observedWallMs / runs.length * candidates * perCandidateRuns), linearTokens: Math.round(observedTokens / runs.length * candidates * perCandidateRuns), linearOutputBytes: Math.round(1_000_000 / runs.length * candidates * perCandidateRuns) });
  return {
    schemaVersion: 1, outputKind: "orchestration-effectiveness-ranking", roleProfileContentHash: roleCurrent.contentHash,
    ranking: {
      claim: `For the bounded ${config.role} pilot, ${winner} ranks above ${loser}: both arms passed the gate with equal intervention/correction-proxy and re-derivation medians, while the winner had ${betterMetric}.`,
      winner, loser, role: config.role, evidence,
      metrics: { control: score.control, treatment: score.treatment, comparison: score.comparison, recommendation: score.recommendation, semantics: { corrections: "agent-eval interventions/blocked transitions are the available correction proxy", tokensToGate: "provider usage at gate; null is censored, never zero", rederivation: "predeclared matching failure/result markers" } },
    },
    pilot: { pairs: new Set(runs.map((run) => run.pairId)).size, runs: runs.length, totalObservedTokens: observedTokens, totalObservedWallClockMs: observedWallMs, experimentContentHash: hash(experimentText), treatmentContentHash: experiment.curation.installedContentHash, treatmentConsumption: consumption, contract: experiment.schema },
    feasibility: {
      agentEvalRoot: config.agentEvalRoot, runnerPresent: runnerSource.length > 0, scorerPresent: scorerSource.length > 0,
      requiredExecutables: { bun: executableAvailable("bun"), git: executableAvailable("git"), agentDispatch: executableAvailable("agent-dispatch") },
      runnerSourceHash: hash(runnerSource), scorerSourceHash: hash(scorerSource), minimumRunsPerArm: config.minimumPairs,
      defaultQuerySpawnsAgents: false, fullReplayAuthorized: false,
    },
    scaleUp: {
      oneCandidatePerRole: scale(roleCount), allObservedRolePatternCandidates: scale(observedPatternCandidates),
      realTaskReference: { experimentContentHash: hash(realTaskText), observedOneCandidate: { hostedCalls: realTask.runs.length, retainedWorktreesAndTabs: realTask.runs.length, tokens: realTaskTokens, wallClockMs: realTaskWallMs }, oneCandidatePerRole: { hostedCalls: realTask.runs.length * roleCount, retainedWorktreesAndTabs: realTask.runs.length * roleCount, linearTokens: realTaskTokens * roleCount, linearWallClockMs: realTaskWallMs * roleCount } },
      basis: { pilotRuns: runs.length, pilotWallClockMs: observedWallMs, pilotTokens: observedTokens, pilotOutputBytesApprox: 1_000_000 }, caveat: "Hosted-call count and maximum budget are exact for the synthetic harness contract. Real-task call/worktree counts are exact at three pairs; time and tokens are linear estimates from the cited completed replay and may increase with task difficulty. No larger replay is authorized.",
    },
    policy: { autoPromotion: false, evaluationWorkspaceInstallOnly: true, frequencyIsNotEffectiveness: true, slice4ProfileGeneration: "not started" },
    egress: { defaultDerivation: { performed: false, surface: "none", hostedCalls: 0 }, pilotMeasurement: config.pilotEgress },
  };
}

export async function deriveEffectivenessRanking(root: string, configPath = join(root, "eval", "effectiveness-pilot.json")): Promise<{ processed: boolean; artifactPath: string; contentHash: string; inputProjectionHash: string }> {
  const configText = await readFile(configPath, "utf8"); const config = JSON.parse(configText) as PilotConfig;
  const experimentPath = resolve(root, config.experimentPath); const experimentText = await readFile(experimentPath, "utf8"); const experiment = validateExperiment(JSON.parse(experimentText), config.minimumPairs); const consumption = await treatmentConsumption(experimentPath, experiment); const realTaskText = await readFile(config.realTaskReferencePath, "utf8");
  const roleCurrent = await loadProjectionBoundArtifact(root, "orchestration-roles-manifest.json", { optional: true });
  if (!roleCurrent) throw new Error("role segmentation has not been derived");
  const runnerText = await readFile(join(config.agentEvalRoot, "src", "promotion-runner.ts"), "utf8"); const scorerText = await readFile(join(config.agentEvalRoot, "src", "promotion-score.ts"), "utf8");
  const inputProjectionHash = hash(JSON.stringify({ roleContentHash: roleCurrent.contentHash, experimentContentHash: hash(experimentText), treatmentConsumptionHash: consumption.projectionHash, realTaskReferenceHash: hash(realTaskText), runnerHash: hash(runnerText), scorerHash: hash(scorerText) }));
  const recipeHash = hash(await Bun.file(import.meta.path).text() + "\n" + configText); const manifestPath = join(root, "derived", "orchestration-effectiveness-manifest.json"); let manifest: any = { version: 1 };
  try { manifest = JSON.parse(await readFile(manifestPath, "utf8")); } catch (error: any) { if (error?.code !== "ENOENT") throw error; }
  if (manifest.current?.inputProjectionHash === inputProjectionHash && manifest.current?.recipeHash === recipeHash) {
    try {
      const current = await loadCurrentDerivedArtifact(root, "orchestration-effectiveness-manifest.json");
      if (
        current?.inputProjectionHash === inputProjectionHash
        && current.artifact?.roleProfileContentHash === roleCurrent.contentHash
      ) {
        return { processed: false, artifactPath: join(root, "derived", manifest.current.artifactPath), contentHash: manifest.current.contentHash, inputProjectionHash };
      }
    } catch (error) {
      if (!(error instanceof DerivedProjectionDriftError)) throw error;
    }
  }
  const artifact = await buildEffectivenessRanking(root, config); const text = JSON.stringify(artifact, null, 2) + "\n"; const contentHash = hash(text);
  const artifactRel = `orchestration-effectiveness/${contentHash.slice(0, 2)}/${contentHash}.json`; await atomicWrite(join(root, "derived", artifactRel), text);
  manifest.current = { inputProjectionHash, recipeHash, artifactPath: artifactRel, contentHash }; await atomicWrite(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  return { processed: true, artifactPath: join(root, "derived", artifactRel), contentHash, inputProjectionHash };
}
export async function loadEffectivenessRanking(root: string): Promise<any> {
  const roleCurrent = await loadProjectionBoundArtifact(root, "orchestration-roles-manifest.json", { optional: true });
  const current = await loadCurrentDerivedArtifact(root, "orchestration-effectiveness-manifest.json", { optional: true });
  if (!roleCurrent || !current) throw new Error("effectiveness ranking has not been derived");
  if (current.artifact?.roleProfileContentHash !== roleCurrent.contentHash)
    throw new DerivedProjectionDriftError("effectiveness ranking does not match the active role projection");
  return current.artifact;
}
