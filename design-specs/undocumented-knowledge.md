# Design-spec: undocumented knowledge

Status: **DRAFT — awaiting operator freeze.** Author lane: chatlog.
Companion: `operator-orchestration-profile.md` (that spec answers *how* the
operator orchestrates; this one answers *what they know and never wrote down*).

---

## The one felt outcome

Run one command and get back a ranked, evidence-cited list of **things the
operator demonstrably knows but has never written down** — topics that recur
across their sessions and appear nowhere in that project's `CLAUDE.md`,
`skills/`, ADRs, or `docs/`.

The operator reads it and says "huh, I do keep doing that" — about something
they had never articulated. Then each row converts to a concrete doc delta.

## User journey

1. Operator runs `bun run query undocumented [--project <path>]`.
2. Gets a bounded, ranked report. Each row:
   - **What** — the candidate's title and signature.
   - **How much** — occurrences / conversations / sessions / projects /
     harnesses, straight from the existing frequency block.
   - **Where it lives already** — the documentation files searched, and what
     matched (nothing, for a true gap).
   - **Proof** — 2–3 `chatlog://` turn pointers from *distinct* sessions, so
     the operator can read the actual moments rather than trust a score.
3. Operator picks a row and runs the existing `write-a-skill` or
   `writing-memory-entries` workflow against it. They never author from a
   blank page; the evidence is the draft's raw material.
4. Next run, that row is gone — because the doc now covers it. **The list
   shrinking is the progress metric.**

## Why this is worth building

The operator's stated want is a memory system that "teaches me things about
myself which I did not know." The gap between *what you do* and *what you have
written down* is exactly that, and it is computable today because both sides
are already on disk:

- the corpus (3,550 conversations, 67 refinery candidates as of 2026-07-27)
- the docs (`CLAUDE.md` tiers, `skills/`, `docs/decisions/`, `design-specs/`)

Nothing here needs embeddings, a graph renderer, or a new labelling layer.
A `claude-md` candidate already carries `signature`, `title`, `frequency`, and
turn-level `evidence` pointers. The missing predicate is one question — *is
this already documented?* — and that is the whole feature.

Concrete instance from the first real run: `lang-bang:test-build-gate-failure`,
**609 occurrences across 372 conversations, 18 sessions, 3 harnesses.** If
lang-bang's `CLAUDE.md` does not mention it, that is 609 re-derivations of
something never written once.

## Goal / Constraints / Values

**Goal.** Every refinery candidate is classified as documented or not, against
the real documentation set, with the undocumented ones ranked by how much
re-derivation they represent.

**Constraints (hard):**

1. **Read-only on documentation.** The tool reads `CLAUDE.md`, `skills/`,
   `docs/`; it never writes them. Authoring stays with `write-a-skill` /
   `writing-memory-entries`, which have their own review discipline.
2. **No new promotion path.** This ranks and cites. It does not accept, install,
   or auto-write knowledge. The refinery contract's rule holds unchanged:
   *it does not turn repetition into truth.*
3. **Local-only, no network.** Same posture as the rest of chatlog. No hosted
   embedding call sneaks in as "just for matching."
4. **Evidence from distinct sessions.** A row backed by three turns of one
   session is one anecdote wearing a crowd's clothes. Enforce distinctness, as
   the refinery already does for nomination.
5. **Zero new runtime dependencies** beyond whatever the Effect migration
   settles on.

**Values (soft):**

- **Prefer a dumb matcher that is auditable** over a clever one that is not.
  Start with literal/keyword matching over doc text; the operator must be able
  to see *why* a row was called undocumented. A false "already documented"
  silently hides a real gap — bias toward reporting the gap.
- Rank by re-derivation cost (occurrences × distinct sessions), not raw count.
  Something hit 600 times in one session is a loop; 600 times across 18
  sessions is a habit.
- Reuse the existing candidate types. `claude-md` and `gotcha-skill` are the
  natural inputs; `memory-or-adr` likely too. Do not invent a parallel taxonomy.

## The hardest risk, attacked first (the tracer bullet)

**The risk is precision, not plumbing.** If the matcher calls things
undocumented that plainly are documented, the list is noise and gets ignored on
first read — the same death Obsidian's graph view dies.

So the tracer bullet is: **one project, one candidate type, end to end, and the
operator judges the output by hand.** Take `claude-md` candidates for a single
project with rich existing docs (homelab is the adversarial choice — 16 KB of
`CLAUDE.md`, a `skills/` tree, 9 ADRs). Classify them. The operator reads every
row and marks it right or wrong.

If precision is poor on the project with the *most* documentation, the feature
does not work and no amount of UI saves it. Learn that on one project in an
evening, not after building a graph on top.

## Falsifiers / definition of done

Each is a command or an operator judgement, not a claim.

1. `bun run query undocumented --project /srv/share/projects/homelab` returns a
   ranked list where every row carries frequency and ≥2 `chatlog://` pointers
   from distinct sessions.
2. **Operator-judged precision ≥ 70% on the adversarial project.** The operator
   reviews every returned row and marks documented / undocumented. Rows wrongly
   called undocumented are false positives. Below 70%, the matcher is wrong and
   the spec is not met — revise rather than ship.
3. **Known-positive control.** Insert a deliberately undocumented topic (a
   candidate whose signature appears in no doc) and confirm it ranks. A filter
   that returns nothing passes a naive precision test trivially; this catches
   that.
4. **Known-negative control.** A topic that IS documented — e.g. homelab's push
   gate, which `CLAUDE.md` covers explicitly — must NOT appear. If it does, the
   matcher cannot see the docs it claims to read.
5. `bun run check` passes: lint clean, no-throw ratchet not raised, tests green.
6. The report is reproducible: same corpus + same docs → identical output.
   Derived-artifact discipline, as everywhere else in this repo.

## Explicit non-goals / deferrals

- **Not the graph.** Rendering topics as a navigable graph is a separate spec
  and should come after this one proves the *insight* is real. A graph over a
  low-precision list is a prettier way to be wrong. This spec's output is
  deliberately a ranked list.
- **Not sub-turn spans.** Turn-level `chatlog://` pointers already exist and
  are enough to read the moment. Char-range spans are a graph-era refinement.
- **Not auto-authoring.** No generated CLAUDE.md text. The operator's existing
  authoring skills own that, and they have review steps this must not bypass.
- **Not embeddings.** If literal matching proves insufficient, that is a
  finding to report, not a licence to add a model mid-spec.
- **Not cross-project inference.** One project at a time; "you do this in three
  projects and documented it in one" is a later, richer question.

## Why this is the right first move

It is the smallest thing that delivers the operator's actual stated want, it
runs entirely on machinery that already produced 67 candidates on its first
real run, and its output is immediately actionable — every row is a doc delta
with its evidence pre-gathered.

It also produces the data the graph would need (topic, weight, evidence,
documented-or-not), so building it first is not a detour from the graph. It is
the graph's first layer, shipped in a form that is useful before any pixels
exist.
