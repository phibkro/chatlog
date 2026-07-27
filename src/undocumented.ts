import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { loadRefinery, type PromotionCandidate, type PromotionType } from "./refinery";

// The undocumented-knowledge query (design-specs/undocumented-knowledge.md).
// The refinery already answers "what does the operator demonstrably keep
// re-deriving" (a PromotionCandidate's signature/title/frequency/evidence).
// The one missing predicate is "did they already write it down?" — this
// module answers only that, against the real doc set on disk, with a dumb
// literal matcher an operator can audit by eye (which file, which words).

export interface KeywordGroup {
  readonly terms: readonly string[];
}
const group = (...terms: string[]): KeywordGroup => ({ terms });

// One keyword-group list per underlying CONCEPT, not per source vocabulary.
// refinery.ts's THEMES (claude-md/memory-or-adr/skill signatures) and
// derive.ts's PROBLEM_CATEGORIES (gotcha-skill signatures) are two separate
// fixed enums that both name several of the same concepts (a stuck Lean
// proof, a dirty/untracked Nix input, a worktree conflict). TOPIC_KEYWORDS
// maps every slug from both enums onto one shared list per concept below,
// so the same concept is never described by two keyword lists that could
// drift apart.
//
// Every multi-term group was checked against the real homelab corpus while
// building this (docs/reports/*, docs/decisions/*, .claude/skills/*) and
// tuned to drop terms that fired on an unrelated sense of the same word:
// - "sandbox" alone hit agent-quarantine ADRs, not Nix build-sandbox EPERMs.
// - bare "timeout" hit an HTTP-client timeout skill, not the OOM/process
//   resource-limit gotcha.
// - "invisible" + "nix" anywhere in the same (large) file hit an unrelated
//   flake *input pin* going stale, not a locally untracked *source file*.
// Single ambiguous English words ("stale", "drift", "sandbox") stay as their
// own group only where the codebase found no confusable homelab hit; this
// is a known residual precision risk on other projects (see report).
const NIX_SOURCE_VISIBILITY = [group("untracked", "flake"), group("invisible", "nix")];
const WORKTREE_HYGIENE = [group("worktree"), group("merge conflict"), group("rebase conflict")];
const BUILD_GATE = [group("flake check"), group("quality gate"), group("pre-commit hook")];
const DESIGN_WALL = [group("design wall"), group("proof", "blocked"), group("lemma")];
const SCHEMA_CONFIG = [group("missing config"), group("missing schema"), group("schema drift")];
const SANDBOX_PERMISSIONS = [
  group("nix", "sandbox"),
  group("nix", "permission"),
  group("eperm"),
  group("permission denied"),
];
const WAIT_MONITOR = [
  group("run_in_background"),
  group("background", "never block"),
  group("monitor tool"),
];
const DOC_LOOKUP = [group("docs map"), group("documentation map"), group("reference doc")];
const RELEASE_GATE = [group("push gate"), group("deploy gate"), group("release gate")];
const DB_MIGRATION = [
  group("database migration"),
  group("schema migration"),
  group("query migration"),
];
const STALE_STATE = [group("stale"), group("drift")];
const TIMEOUT_RESOURCE = [group("out of memory"), group("oom")];

export const TOPIC_KEYWORDS: Record<string, KeywordGroup[]> = {
  "nix-flake-source-visibility": NIX_SOURCE_VISIBILITY,
  "nix-dirty-or-untracked-input": NIX_SOURCE_VISIBILITY,
  "git-worktree-and-index-hygiene": WORKTREE_HYGIENE,
  "merge-rebase-or-worktree-conflict": WORKTREE_HYGIENE,
  "test-build-gate-failure": BUILD_GATE,
  "ci-test-or-build-failure": BUILD_GATE,
  "lean-proof-or-design-wall": DESIGN_WALL,
  "proof-or-design-wall": DESIGN_WALL,
  "schema-config-or-missing-input": SCHEMA_CONFIG,
  "missing-config-schema-or-file": SCHEMA_CONFIG,
  "permissions-sandbox-or-daemon": SANDBOX_PERMISSIONS,
  "nix-daemon-or-sandbox-permission": SANDBOX_PERMISSIONS,
  "wait-monitor-and-timeout": WAIT_MONITOR,
  "reference-and-documentation-lookup": DOC_LOOKUP,
  "release-deploy-and-publish-gate": RELEASE_GATE,
  "database-query-and-migration": DB_MIGRATION,
  "stale-or-drifted-state": STALE_STATE,
  "timeout-memory-or-resource-limit": TIMEOUT_RESOURCE,
};

// claude-md/memory-or-adr/skill signatures are `${project}:${theme}`;
// gotcha-skill/plain-theme signatures have no project prefix. Either way the
// topic is whatever follows the last ':'.
export function topicSlug(signature: string): string {
  const index = signature.lastIndexOf(":");
  return index === -1 ? signature : signature.slice(index + 1);
}

export interface DocFile {
  readonly path: string;
  readonly text: string;
}

async function walkMarkdown(dir: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const found: string[] = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await walkMarkdown(path)));
    else if (entry.isFile() && entry.name.endsWith(".md")) found.push(path);
  }
  return found;
}

// The project's own doc set: CLAUDE.md/AGENTS.md tiers, skills/, docs/
// (which covers docs/decisions/ ADRs and every drill-down under docs/).
export async function loadProjectDocs(project: string): Promise<DocFile[]> {
  const paths = new Set<string>([join(project, "CLAUDE.md"), join(project, "AGENTS.md")]);
  for (const dir of [join(project, ".claude", "skills"), join(project, "docs")])
    for (const path of await walkMarkdown(dir)) paths.add(path);
  const docs: DocFile[] = [];
  const seenContent = new Set<string>();
  for (const path of paths) {
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch {
      continue;
    }
    // Dedupe symlink twins (AGENTS.md -> CLAUDE.md, and similar cross-harness
    // mirrors elsewhere in docs/) by content rather than by inode, so one
    // doc isn't double-counted as two independent sources confirming a match.
    const contentKey = new Bun.CryptoHasher("sha256").update(text).digest("hex");
    if (seenContent.has(contentKey)) continue;
    seenContent.add(contentKey);
    docs.push({ path: relative(project, path), text });
  }
  return docs.toSorted((a, b) => a.path.localeCompare(b.path));
}

export interface DocMatch {
  readonly file: string;
  readonly terms: readonly string[];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
// \b-wrap each term so a short term can't fire inside an unrelated word
// (bare "oom" would otherwise match "room"/"headroom"/"boom" — caught while
// tuning this against the real homelab corpus, see the TOPIC_KEYWORDS note).
function boundedTerm(term: string): string {
  const escaped = escapeRegExp(term);
  const leading = /^\w/.test(term) ? "\\b" : "";
  const trailing = /\w$/.test(term) ? "\\b" : "";
  return `${leading}${escaped}${trailing}`;
}
function permutations<T>(items: readonly T[]): T[][] {
  if (items.length <= 1) return [items.slice()];
  return items.flatMap((item, index) =>
    permutations([...items.slice(0, index), ...items.slice(index + 1)]).map((rest) => [
      item,
      ...rest,
    ]),
  );
}
const PROXIMITY_WINDOW = 80;
// All terms in a group must appear within PROXIMITY_WINDOW characters of
// each other, in any order — a co-occurrence window, not "anywhere in the
// same (possibly 16 KB) file". Order-insensitive because real prose says
// both "the flake can't see the untracked file" and "the untracked file is
// invisible to the flake"; a single fixed order missed real matches.
function groupPattern(termGroup: KeywordGroup): RegExp {
  const branches = permutations(termGroup.terms).map((order) =>
    order.map(boundedTerm).join(`.{0,${PROXIMITY_WINDOW}}`),
  );
  return new RegExp(branches.join("|"), "is");
}

// Dumb by design: literal, case-insensitive, proximity-windowed regex, no
// stemming, no fuzzy matching. A group matches a doc when every one of its
// terms co-occurs within the window; the first matching (doc, group) pair
// wins, so every "documented" verdict cites exactly the file and the words
// that earned it.
export function matchTopic(slug: string, docs: readonly DocFile[]): DocMatch | undefined {
  const groups = TOPIC_KEYWORDS[slug];
  if (!groups) return undefined;
  for (const doc of docs)
    for (const candidateGroup of groups)
      if (groupPattern(candidateGroup).test(doc.text))
        return { file: doc.path, terms: candidateGroup.terms };
  return undefined;
}

export interface UndocumentedRow {
  readonly id: string;
  readonly type: PromotionType;
  readonly title: string;
  readonly signature: string;
  readonly topic: string;
  readonly frequency: PromotionCandidate["frequency"];
  readonly rederivationCost: number;
  readonly evidence: ReadonlyArray<{
    readonly project: string;
    readonly sessionId: string;
    readonly harness: string;
    readonly pointer: PromotionCandidate["evidence"][number]["pointer"];
  }>;
}
export interface DocumentedRow extends UndocumentedRow {
  readonly matchedIn: string;
  readonly matchedOn: readonly string[];
}
export interface UndocumentedReport {
  readonly project: string;
  readonly docsSearched: readonly string[];
  readonly typesConsidered: readonly PromotionType[];
  readonly candidatesConsidered: number;
  readonly undocumented: readonly UndocumentedRow[];
  readonly documented: readonly DocumentedRow[];
}

// claude-md / gotcha-skill / memory-or-adr are the candidate types the spec
// names as "operator knowledge never written down" (a stable context, a
// landmine, a decision/fact). `skill` is a reusable-procedure signal already
// routed through write-a-skill on frequency alone, and `wiki-page-later` is
// deliberately deferred external-reference material — neither is "knowledge
// the operator has but never documented" in this spec's sense, so both are
// left out of the default scope. `--type` can still opt them back in.
const DEFAULT_TYPES: PromotionType[] = ["claude-md", "gotcha-skill", "memory-or-adr"];

export async function queryUndocumented(
  root: string,
  project: string,
  options: { types?: PromotionType[] } = {},
): Promise<UndocumentedReport> {
  const types = options.types ?? DEFAULT_TYPES;
  const normalizedProject = project.replace(/\/+$/, "");
  const artifact = await loadRefinery(root);
  const docs = await loadProjectDocs(normalizedProject);
  const undocumented: UndocumentedRow[] = [];
  const documented: DocumentedRow[] = [];
  let candidatesConsidered = 0;
  for (const candidate of artifact.candidates) {
    if (!types.includes(candidate.type)) continue;
    const evidence = candidate.evidence.filter((item) => item.project === normalizedProject);
    // Distinct sessions, not just distinct evidence rows: distinctness is
    // the refinery's own signal that this isn't one session's anecdote.
    const sessions = new Set(evidence.map((item) => item.sessionId));
    if (sessions.size < 2) continue;
    candidatesConsidered += 1;
    const topic = topicSlug(candidate.signature);
    const match = matchTopic(topic, docs);
    const row: UndocumentedRow = {
      id: candidate.id,
      type: candidate.type,
      title: candidate.title,
      signature: candidate.signature,
      topic,
      frequency: candidate.frequency,
      rederivationCost: candidate.frequency.occurrences * candidate.frequency.sessions,
      evidence: evidence
        .slice(0, 3)
        .map((item) => ({
          project: item.project,
          sessionId: item.sessionId,
          harness: item.harness,
          pointer: item.pointer,
        })),
    };
    if (match) documented.push({ ...row, matchedIn: match.file, matchedOn: match.terms });
    else undocumented.push(row);
  }
  const byCost = (a: UndocumentedRow, b: UndocumentedRow) => b.rederivationCost - a.rederivationCost;
  return {
    project: normalizedProject,
    docsSearched: docs.map((doc) => doc.path),
    typesConsidered: types,
    candidatesConsidered,
    undocumented: undocumented.toSorted(byCost),
    documented: documented.toSorted(byCost),
  };
}
