# Workbench insight surfaces

Status: **FROZEN — operator approved 2026-07-27.**

## Felt outcome

Workbench should answer useful questions from analysis Chatlog has already paid
to compute:

- Is this insight current and what evidence supports it?
- What did we try last time, and what happened?
- What keeps happening in this project?
- What do I repeatedly relearn without documenting?
- What themes appear in the available semantic sample?

The product must not turn stale artifacts, lexical recurrence, or partial model
coverage into authoritative claims.

## Binding decisions

1. **Freshness precedes presentation.** Every derived aggregate shown in
   Workbench reports the input projection or dependency it was built from and
   whether it matches the current corpus projection. A stale claim is visibly
   stale and is never labelled latest, current, winning, or recommended.
2. **Evidence is progressive disclosure.** Summary surfaces return bounded,
   redacted snippets and `chatlog://` pointers. Full canonical turn text remains
   behind the existing explicit evidence action and current-object check.
3. **Reuse existing local computations.** Prior Attempts reuses the lexical
   `agentAskLexical` path. Project Intelligence reuses bounded current-session
   rollups and derived problems, decisions, and outcomes. Neither requires a
   hosted call.
4. **Candidates remain candidates.** Knowledge Gaps and refinery views do not
   accept, promote, install, or auto-author anything. Frequency is a ranking
   signal, not truth.
5. **Precision gates the Knowledge Gaps label.** The existing undocumented
   matcher must reach at least 70% operator-judged precision on one
   documentation-rich project before Workbench describes its rows as
   undocumented. Before that, the surface says `possible documentation gap`.
6. **Themes disclose coverage.** The Themes explorer is experimental and shows
   cached extraction coverage, model, recipe, clustering recipe, and long-tail
   statistics. It does not imply whole-corpus coverage, and it does not trigger
   extraction from Workbench.
7. **Workbench stays local and read-only.** No mutating HTTP route, model call,
   network egress, source import, or background corpus job is introduced.

## Delivery order

### Slice 1 — insight freshness and provenance

- Compute the current projection hash from `derived/current-hashes.jsonl`.
- Load aggregate manifest metadata with each artifact.
- Mark orchestration and role artifacts fresh only when their input projection
  equals the current projection.
- Mark effectiveness stale when its referenced role-profile artifact is stale,
  even when the direct role content hash still matches.
- Apply the same direct freshness check to refinery output.
- Show freshness visibly in Today and Patterns.
- Return only a small fixed number of derived evidence snippets and pointers,
  and resolve full turns only through `/api/evidence`.

### Slice 2 — Prior Attempts and Project Intelligence

- Add a zero-egress Prior Attempts mode backed by `agentAskLexical`.
- Present sessions chronologically with problems, attempts, decisions, outcome,
  and resolution pointers.
- Replace the session-only project drawer with a bounded current-project brief:
  outcome mix, recurring problem categories, recent decisions, model/tool mix,
  and then sessions.
- Superseded or inactive conversations contribute nothing.

### Slice 3 — Knowledge Gaps review

- Make all refinery candidates searchable and pageable.
- Provide a read-only detail drawer with curation route, checks, evaluation
  status, bounded evidence, and explicit non-acceptance language.
- Add project-scoped possible documentation gaps after the precision gate.
- Integrate human semantic dispositions only after completed answer validation;
  do not infer them from the lexical artifact.

### Slice 4 — partial Themes explorer

- Read completed local topic-cache entries without starting extraction.
- Cluster with the existing deterministic topic normalizer.
- Show sample size, corpus denominator, model/recipe, shared-topic counts, and
  the singleton/long-tail distribution.
- Do not call the view a knowledge graph and do not claim a personal↔technical
  bridge without evidence from both domains.

## Acceptance gates

1. A mismatched synthetic projection marks orchestration, roles, and dependent
   effectiveness stale; matching refinery output remains fresh.
2. No stale card uses `latest`, `current`, `winner`, or `recommendation` as an
   unqualified product claim.
3. Every surfaced evidence pointer is bounded and resolves through the existing
   current-object/domain checks.
4. Prior Attempts makes zero network calls and excludes tool-role discovery.
5. Project Intelligence counts only current sessions.
6. Knowledge Gaps cannot render authoritative `undocumented` language until its
   recorded precision gate passes.
7. Themes shows exact cache coverage and never creates a cache entry.
8. Focused tests, TypeScript, lint, no-throw ratchet, browser/server bundles, and
   the full repository gate pass.
9. Each slice receives an independent read-only review before checkpointing.

## Non-goals

- Workbench mutation or authentication.
- Automatic knowledge promotion or documentation writing.
- Starting Ollama, hosted reranking, vault emission, or semantic extraction
  from a page load.
- A universal cross-harness resume converter.
- Treating the current worker-prompt pilot as a general model-policy result.
