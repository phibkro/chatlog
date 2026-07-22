import { chmod, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { DerivedConversation, Evidence, Pointer } from "./derive";

export type PromotionType = "skill" | "gotcha-skill" | "memory-or-adr" | "claude-md" | "wiki-page-later";
export interface PromotionEvidence extends Evidence {
  conversationHash: string; sessionId: string; project: string; harness: string; model: string;
}
export interface PromotionCandidate {
  id: string; type: PromotionType; signature: string; title: string;
  status: "curation-required" | "deferred-follow-up";
  frequency: { occurrences: number; conversations: number; sessions: number; projects: number; harnesses: number; threshold: number };
  evidence: PromotionEvidence[];
  curation: { principle: string; route: string; checks: string[] };
  evaluation: {
    contract: "agent-eval/promotion-v1"; status: "unmeasured"; minimumRunsPerArm: number;
    control: string; treatment: string; metrics: string[]; keepRule: string; cutRule: string;
  };
}
export interface RefineryArtifact {
  schemaVersion: 1; inputProjectionHash: string; recipeHash: string; threshold: number;
  policy: { autoPromotion: false; frequencyIsSignalNotDecision: true; referenceWikiDeferred: true };
  candidates: PromotionCandidate[];
}
interface RefineryManifest { version: 1; current?: { inputProjectionHash: string; recipeHash: string; threshold: number; artifactPath: string; contentHash: string; processedAt: string } }
export interface RefinerySummary { inputConversations: number; candidates: number; processed: boolean; artifactPath: string; contentHash: string }

const STOP = new Set("about after again also assistant because before being cannot could current does done each file first from have into issue just last more only other output project result same should some than that their them then there these they this through tool turn turns using want were what when where which while will with would your".split(" "));
const ACTION_TOOLS = /^(?:bash|exec|edit|write|apply_patch|computer|browser|nix)$/i;
const THEMES: Array<[string, RegExp]> = [
  ["nix-flake-source-visibility", /(?:nix|flake).{0,120}(?:untracked|invisible|can't see|cannot see|excluded|git add)|(?:untracked|invisible).{0,100}(?:nix|flake)/i],
  ["git-worktree-and-index-hygiene", /\b(?:git|worktree|index|rebase|merge).{0,120}(?:dirty|conflict|collision|corrupt|shared|untracked|staged)|(?:shared|dirty).{0,80}(?:tree|worktree|index)/i],
  ["test-build-gate-failure", /\b(?:test|build|check|gate|ci).{0,120}(?:fail|error|red|pass|green)|(?:fail|error).{0,100}(?:test|build|check|gate|ci)/i],
  ["lean-proof-or-design-wall", /\b(?:lean|proof|lemma|theorem|design).{0,120}(?:blocked|stuck|wall|counterexample|unsound|build)/i],
  ["schema-config-or-missing-input", /\b(?:schema|config|profile|manifest|input|hook).{0,120}(?:missing|drift|invalid|unknown|not found)|(?:missing|not found).{0,100}(?:schema|config|file|input)/i],
  ["permissions-sandbox-or-daemon", /\b(?:permission|denied|eperm|sandbox|daemon|read-only|socket).{0,120}(?:nix|write|connect|mount|access)|(?:nix|socket).{0,100}(?:permission|denied|eperm)/i],
  ["wait-monitor-and-timeout", /\b(?:wait|monitor|poll|timeout|timed out|notification|idle).{0,100}(?:process|agent|job|build|status|complete|stale)/i],
  ["reference-and-documentation-lookup", /\b(?:documentation|manual|reference|web search|search results|fetch|look up|lookup|docs).{0,120}(?:api|option|behavior|version|command|source)/i],
  ["release-deploy-and-publish-gate", /\b(?:release|deploy|publish|push).{0,120}(?:gate|verify|failed|success|remote|tag|branch)/i],
  ["database-query-and-migration", /\b(?:database|duckdb|sqlite|query|migration|schema).{0,120}(?:fail|error|load|scan|index|projection)/i],
];

function hash(text: string): string { return new Bun.CryptoHasher("sha256").update(text).digest("hex"); }
function themes(text: string): string[] { return THEMES.filter(([, pattern]) => pattern.test(text)).map(([name]) => name); }
function keywords(text: string): string[] {
  return [...new Set((text.toLowerCase().match(/[a-z][a-z0-9_-]{3,}/g) ?? []).filter((word) => !STOP.has(word)))].slice(0, 6);
}
function externalReferences(text: string): string[] {
  const refs = new Set<string>();
  for (const raw of text.match(/https?:\/\/[^\s)\]}>,]+/g) ?? []) try {
    const url = new URL(raw); const segment = url.pathname.split("/").filter(Boolean)[0]; refs.add(segment ? `${url.hostname}/${segment}` : url.hostname);
  } catch {}
  return [...refs];
}
function cleanProject(project: string): string { return project.replace(/\/\.claude\/worktrees\/.*$/, ""); }
async function atomicWrite(path: string, data: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 }); const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, data, { mode: 0o600 }); await rename(temp, path); await chmod(path, 0o600);
}
function route(type: PromotionType): PromotionCandidate["curation"] {
  if (type === "skill" || type === "gotcha-skill") return {
    principle: "Frequency nominates; a curator must prove this is reusable procedure, not repeated local circumstance.",
    route: "Run the existing write-a-skill gather/draft/fresh-agent-validation workflow; do not write a skill from this artifact directly.",
    checks: ["Name concrete USE-WHEN triggers and exclusions", "Deduplicate against existing skills", "Draft a concise SKILL.md only after evidence review", "Baseline and validate with a fresh agent before deployment"],
  };
  if (type === "memory-or-adr") return {
    principle: "Prefer the authoritative ADR/spec/test; memory is a retrieval pointer or non-obvious gotcha, never a second source of truth.",
    route: "Run writing-memory-entries; choose ADR when this is a durable project decision, otherwise a USE-WHEN memory pointer.",
    checks: ["Run the git/ADR/CHANGELOG smell test", "Deduplicate MEMORY.md", "Require a USE-WHEN description", "Assign honest importance and a sub-2s verify_by"],
  };
  if (type === "claude-md") return {
    principle: "Promote only stable context repeatedly required at task start; do not turn CLAUDE.md into a transcript or knowledge dump.",
    route: "Curate into the nearest authoritative CLAUDE.md using the existing writing-docs discipline.",
    checks: ["Confirm the context applies broadly in this scope", "Point to an authoritative source instead of duplicating it", "Keep the instruction short and test retrieval with a fresh session"],
  };
  return {
    principle: "Reference wiki is deferred and may contain only stable external material by reference, never a duplicate project truth or god-wiki.",
    route: "Hold for the later reference-wiki follow-up; no page is created by the refinery.",
    checks: ["Confirm the source is external and stable", "Link rather than copy", "Reject project-local facts and existing authoritative documentation"],
  };
}
function evaluation(type: PromotionType): PromotionCandidate["evaluation"] {
  return {
    contract: "agent-eval/promotion-v1", status: "unmeasured", minimumRunsPerArm: 3,
    control: "Replay the same historical task from the same clean start commit without the candidate.",
    treatment: `Replay with the curator-approved ${type} available only through its intended existing skill/memory/CLAUDE.md channel.`,
    metrics: ["gatePassRate", "tokensToGate", "wallClockMs", "interventions", "rederivationCount"],
    keepRule: "Keep only if gate pass does not regress and median re-derivation or tokens-to-gate improves across at least three paired runs.",
    cutRule: "Remove or revise if gate pass regresses, the item is ignored/misapplied, or no measured efficiency signal survives paired runs.",
  };
}
type Observation = PromotionEvidence & { type: PromotionType; signature: string; title: string };
function evidence(artifact: DerivedConversation, item: Evidence): PromotionEvidence {
  return { conversationHash: artifact.conversationHash, sessionId: artifact.sessionId, project: cleanProject(artifact.project), harness: artifact.harness, model: artifact.model, pointer: item.pointer, snippet: item.snippet };
}
function observe(artifact: DerivedConversation): Observation[] {
  const rows: Observation[] = [];
  for (const problem of artifact.problems) for (const category of problem.categories) rows.push({
    type: "gotcha-skill", signature: category, title: `Recurring landmine: ${category}`, ...evidence(artifact, problem),
  });
  for (const attempt of artifact.attempts) if (attempt.outcome === "success") for (const theme of themes(attempt.snippet)) {
    if (!attempt.tools.some((tool) => ACTION_TOOLS.test(tool))) continue;
    rows.push({ type: "skill", signature: theme, title: `Recurring procedure: ${theme}`, ...evidence(artifact, attempt) });
  }
  for (const decision of artifact.decisions) for (const theme of themes(decision.snippet)) {
    const project = cleanProject(artifact.project);
    rows.push({ type: "memory-or-adr", signature: `${project}:${theme}`, title: `Recurring decision/fact in ${project}: ${theme}`, ...evidence(artifact, decision) });
  }
  for (const problem of artifact.problems) for (const theme of themes(problem.snippet)) {
    const project = cleanProject(artifact.project);
    rows.push({ type: "claude-md", signature: `${project}:${theme}`, title: `Repeated task context in ${project}: ${theme}`, ...evidence(artifact, problem) });
  }
  for (const attempt of artifact.attempts) {
    const lookup = attempt.tools.some((tool) => /(?:websearch|web_search|fetch|search_query)/i.test(tool));
    if (!lookup) continue;
    for (const signature of externalReferences(attempt.snippet))
      rows.push({ type: "wiki-page-later", signature, title: `Recurring external reference lookup: ${signature}`, ...evidence(artifact, attempt) });
  }
  return rows;
}

function aggregate(observations: Observation[], threshold: number): PromotionCandidate[] {
  const groups = new Map<string, Observation[]>();
  for (const row of observations) { const key = `${row.type}:${row.signature}`; const items = groups.get(key) ?? []; items.push(row); groups.set(key, items); }
  const candidates: PromotionCandidate[] = [];
  for (const [key, rows] of groups) {
    const conversations = new Set(rows.map((row) => row.conversationHash)); const sessions = new Set(rows.map((row) => `${row.project}:${row.sessionId}`));
    if (sessions.size < threshold) continue;
    const first = rows[0]; const projects = new Set(rows.map((row) => row.project)); const harnesses = new Set(rows.map((row) => row.harness));
    const evidenceRows: PromotionEvidence[] = []; const evidenceSessions = new Set<string>();
    for (const row of rows) {
      const session = `${row.project}:${row.sessionId}`;
      if (evidenceSessions.has(session)) continue;
      evidenceSessions.add(session); evidenceRows.push({ conversationHash: row.conversationHash, sessionId: row.sessionId, project: row.project, harness: row.harness, model: row.model, pointer: row.pointer, snippet: row.snippet });
      if (evidenceRows.length === 6) break;
    }
    candidates.push({
      id: hash(key).slice(0, 20), type: first.type, signature: first.signature, title: first.title,
      status: first.type === "wiki-page-later" ? "deferred-follow-up" : "curation-required",
      frequency: { occurrences: rows.length, conversations: conversations.size, sessions: sessions.size, projects: projects.size, harnesses: harnesses.size, threshold },
      evidence: evidenceRows, curation: route(first.type), evaluation: evaluation(first.type),
    });
  }
  return candidates.sort((a, b) => b.frequency.sessions - a.frequency.sessions || b.frequency.projects - a.frequency.projects || b.frequency.occurrences - a.frequency.occurrences || a.id.localeCompare(b.id));
}

export async function refineCorpus(root: string, threshold = 3): Promise<RefinerySummary> {
  if (!Number.isInteger(threshold) || threshold < 3) throw new Error("refinery threshold must be an integer >= 3");
  const derivedDir = join(root, "derived"); const projectionPath = join(derivedDir, "current-hashes.jsonl");
  const derivedManifest = JSON.parse(await readFile(join(derivedDir, "manifest.json"), "utf8"));
  const inputProjectionHash = String(derivedManifest.currentProjection?.contentHash ?? "");
  if (!inputProjectionHash) throw new Error("derived manifest has no current projection");
  const recipeHash = hash(await Bun.file(import.meta.path).text()); const manifestPath = join(derivedDir, "refinery-manifest.json");
  let manifest: RefineryManifest = { version: 1 }; try { manifest = JSON.parse(await readFile(manifestPath, "utf8")); } catch (error: any) { if (error?.code !== "ENOENT") throw error; }
  const prior = manifest.current;
  if (prior?.inputProjectionHash === inputProjectionHash && prior.recipeHash === recipeHash && prior.threshold === threshold) {
    try { await stat(join(derivedDir, prior.artifactPath)); return { inputConversations: (await readFile(projectionPath, "utf8")).trim().split("\n").filter(Boolean).length, candidates: JSON.parse(await readFile(join(derivedDir, prior.artifactPath), "utf8")).candidates.length, processed: false, artifactPath: join(derivedDir, prior.artifactPath), contentHash: prior.contentHash }; } catch {}
  }
  const hashes = (await readFile(projectionPath, "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line).conversationHash as string);
  const observations: Observation[] = [];
  for (const conversationHash of hashes) {
    const artifact = JSON.parse(await readFile(join(derivedDir, "objects", conversationHash.slice(0, 2), `${conversationHash}.json`), "utf8")) as DerivedConversation;
    observations.push(...observe(artifact));
  }
  const artifact: RefineryArtifact = { schemaVersion: 1, inputProjectionHash, recipeHash, threshold, policy: { autoPromotion: false, frequencyIsSignalNotDecision: true, referenceWikiDeferred: true }, candidates: aggregate(observations, threshold) };
  const text = JSON.stringify(artifact, null, 2) + "\n"; const contentHash = hash(text); const artifactRel = `refinery/${contentHash.slice(0, 2)}/${contentHash}.json`;
  await atomicWrite(join(derivedDir, artifactRel), text);
  manifest.current = { inputProjectionHash, recipeHash, threshold, artifactPath: artifactRel, contentHash, processedAt: new Date().toISOString() };
  await atomicWrite(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  return { inputConversations: hashes.length, candidates: artifact.candidates.length, processed: true, artifactPath: join(derivedDir, artifactRel), contentHash };
}

export async function loadRefinery(root: string): Promise<RefineryArtifact> {
  const manifest = JSON.parse(await readFile(join(root, "derived", "refinery-manifest.json"), "utf8")) as RefineryManifest;
  if (!manifest.current) throw new Error("refinery has not been derived");
  return JSON.parse(await readFile(join(root, "derived", manifest.current.artifactPath), "utf8")) as RefineryArtifact;
}
