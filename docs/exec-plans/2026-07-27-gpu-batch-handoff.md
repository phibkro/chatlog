# Handoff: run the semantic batch jobs

Written 2026-07-27. Two jobs, both **pure execution** — the code is written,
tested and gate-passing. Neither has ever run against the real corpus. They were
stopped because they are GPU-bound and the workstation has one RTX 5060 Ti,
which cannot serve both at once.

You are not being asked to design anything. You are being asked to run two jobs
and report honestly on whether their output is any good.

---

## The point of the exercise

The operator wants **an insight about themselves they did not already know** —
from their own agent conversations. Everything below serves that and should be
judged against it. An output that is technically correct and tells them nothing
is a failed run; say so plainly rather than reporting green.

## Prior art you are improving on

A retired tool (Hermes) produced `~/obsidian-vaults/claude-export`: 681 markdown
notes, one per claude.ai conversation, with topics as `[[wikilinks]]` so
Obsidian's graph view renders a navigable graph. **Read 2–3 of those files
first.** The format is right and is already reproduced in `src/vault.ts`.

What Hermes got wrong was the signal, and avoiding that repeat is the job:

```
fixed 11-topic vocabulary, 290 of 681 notes tagged
health 104 · AI 93 · career 83 · compilers 77 · TypeScript 58 · HMS 37
personal 24 · homelab 24 · NixOS 12 · Lean4 12 · bang-lang 6
```

Eleven pre-chosen buckets cannot surprise anyone. The operator knows they think
about health and career. You need **emergent, specific** topics.

## The corpus

`CHATLOG_DATA_ROOT=/srv/share/projects/chatlog` — 4,246 conversations,
2024-10-31 → 2026-07-27:

| harness | count | carries |
|---|---|---|
| claude-code | 3172 | technical work |
| claude-web | 694 | **personal thinking** — health, career, an HMS sensor platform |
| codex | 452 | technical work |
| pi | 32 | technical work |

The 694 web conversations were imported 2026-07-27 and had never been in the
same corpus as the code harnesses before. **A topic that bridges the personal
and technical halves is the single most valuable thing you could surface** — it
is only findable now, and it is precisely what the operator asked for.

---

## Job 1 — emit the Obsidian vault

```sh
cd /srv/share/projects/chatlog
CHATLOG_DATA_ROOT=/srv/share/projects/chatlog bun run vault ~/obsidian-vaults/chatlog --limit 150
```

**Prove it on the sample before the full run.** 150 conversations spanning both
`claude-web` and `claude-code`. Inspect the emergent vocabulary and stop if it
is bad — see the quality bar below. Only then run without `--limit`.

Output must not overwrite `~/obsidian-vaults/claude-export` (the Hermes vault);
`~/obsidian-vaults/chatlog` sits beside it.

## Job 2 — judge the refinery candidates

```sh
CHATLOG_DATA_ROOT=/srv/share/projects/chatlog bun run scripts/judge-refinery-candidates.ts
```

73 candidates in the newest artifact under `derived/refinery/`. For each, decide:
**genuine recurring operator behaviour, or an artifact of repeated agent-prompt
boilerplate?** Write the verdict to `derived/insights/`.

### The specific test this exists to settle

Candidate `nix-dirty-or-untracked-input` reports ~117 occurrences across 19
sessions. Its evidence is dominated by a subagent system prompt:

> *"You are implementing part of hypr-session… The worktree is DIRTY with
> unrelated changes — NEVER run git add/commit/push…"*

That is a different sense of "dirty" and "git add" than the Nix flake gotcha the
signature names. **It is a false positive.** Two approaches already failed to
catch it:

- a keyword matcher — word-sense blind
- a hash-based verbatim-template gate — defeated by interpolated paths and
  branch names; 38 "distinct" snippets, one template

An LLM reading for *meaning* is the first approach that can. **Quote the judge's
reasoning on this candidate specifically.** If it also passes it as genuine,
that is the important negative result and must be reported, not buried.

---

## The privacy decision — read before choosing a provider

This corpus is every word the operator has said to an agent, across 21 months,
including personal conversations about health and career. It is redacted at
ingest, not anonymised.

`CHATLOG_RERANK_PROVIDER` selects the backend:

| value | where the text goes |
|---|---|
| unset (default) | **local ollama** — never leaves the box |
| `openai` / `anthropic` / `openrouter` | a hosted API |

Local is the default *by design* and hosted is now explicit opt-in. If you run
this on other hardware or against a hosted model, **the corpus leaves the
machine.** That is a legitimate trade for speed and judge quality, but it is the
operator's call, not an implementation detail. State clearly in your report
which provider you used.

Local model options on the workstation: `gemma4:26b` (16GB), `gemma4:12b`,
`gemma4:12b-32k`, `gemma3:12b`, `qwen3.5:9b`.

**Known constraint:** one GPU, serial. Do not run Job 1 and Job 2 concurrently
on the same machine — measured 2026-07-27, they saturate the GPU at 95% and each
roughly halves the other. A "warm" 12B call measured 53s under contention and is
not representative. Get an uncontended baseline before estimating the full run.

---

## Quality bar — how to know the output is bad

Stop and report rather than pressing on if:

- **The vocabulary collapses to ~4,000 singletons.** Every conversation gets a
  unique topic, the graph has no edges, and it is unbrowsable. Means topic
  normalisation is too weak.
- **The vocabulary collapses to ~10 generic buckets.** "infrastructure",
  "coding", "AI". Means the extraction prompt is too abstract — this is Hermes's
  failure repeated, and it teaches nothing.
- **Nothing bridges personal and technical.** Possible and worth reporting as a
  finding, but check the prompt first: if topics are phrased in project terms
  ("homelab", "bang-lang") they cannot bridge by construction.
- **The judge passes `nix-dirty-or-untracked-input` as genuine.** Then reading
  for meaning did not beat keyword matching, and the whole filtering approach
  needs rethinking.

Good output looks like: a few hundred topics, a long tail, a recognisable core,
and at least one topic the operator would not have named themselves.

## Constraints

- No new dependencies. `effect@4.0.0-beta.98` and `bun-types` are present.
- No `throw` in new code — typed errors; see `src/adapters/common.ts`
  (`AdaptError`). The ratchet is at **101** and must not rise.
- `nix shell nixpkgs#oxlint nixpkgs#typescript-go -c bun run check` must pass.
- `redact()` must apply to anything written into the vault.
- Commit by pathspec. Do not push — chatlog has no remote.

## Report back with

1. Which provider and model you used, and whether the corpus left the machine.
2. Uncontended latency per conversation, and total wall-clock for the full run.
3. **The emergent topic vocabulary**: distinct count, top 20 by frequency, how
   many notes got tagged.
4. **Any topic bridging personal and technical conversations** — name it, cite
   the conversations. This is the deliverable.
5. The judge's verdict on the 73 candidates, and its reasoning on
   `nix-dirty-or-untracked-input` verbatim.
6. Your honest assessment: would browsing this teach the operator something, or
   is it Hermes's 11 buckets with extra steps? Say so plainly.
