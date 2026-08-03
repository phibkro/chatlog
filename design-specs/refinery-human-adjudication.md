# Refinery human adjudication

Status: accepted for implementation on 2026-07-27.

## Problem

The refinery nominates recurring-pattern candidates with lexical rules. Its
semantic judge currently treats both `genuine` and `mixed` verdicts as
survivors, preserves the candidate's original mined frequency, and falls back
to every sampled pointer when the judge selects no evidence.

That makes a bad durable-memory state representable: a small genuine minority
inside mostly boilerplate evidence can inherit a large recurrence count and
look ready for promotion. The measured `nix-dirty-or-untracked-input` candidate
demonstrates this failure: one genuine Nix warning sat inside dispatch-template
matches reported as 117 occurrences.

The model bakeoffs do not provide ground truth. Even the best observed
mid-tier configuration produced two false promotion recommendations for one
true recommendation on the fixed challenge set.

## User journey

1. Run the existing semantic judge against a refinery artifact.
2. Receive four fail-closed buckets:
   - `promotionReview`: `genuine` verdicts whose selected evidence spans the
     refinery threshold of distinct sessions;
   - `manualReview`: `mixed` verdicts and `genuine` verdicts with insufficient
     selected support;
   - `rejected`: `boilerplate`;
   - `unjudged`: candidates without a valid semantic verdict.
3. Inspect support counts and pointers derived only from evidence explicitly
   selected by the judge. No bucket inherits the lexical miner's frequency.
4. Generate a deterministic, blinded packet of approximately 30 candidates for
   human labelling. The packet includes the known challenge cases and a
   metadata-stratified sample, but contains no model verdict, reasoning, or
   eligibility answer.
5. Record human verdicts and supporting evidence aliases in a separate answer template
   linked to the exact packet hash.

No step automatically writes a skill, memory, ADR, CLAUDE.md entry, or wiki
page.

## Binding decisions

- Frequency mining nominates; it never decides.
- `mixed` is manual-review only.
- `boilerplate` is rejected.
- A `genuine` verdict reaches `promotionReview` only when its selected evidence
  spans at least `candidate.frequency.threshold` distinct
  `project + sessionId` pairs.
- Support counts and pointers are pure derivations of selected evidence.
  Original mined frequency is not copied into judged rows.
- Empty selected evidence never falls back to all sampled evidence.
- Malformed judge output fails closed before disposition.
- The adjudication packet is deterministic for a refinery artifact, requested
  count, selection recipe, and mandatory fixed challenge-ID set.
- Blinding means the packet contains candidate metadata and redacted evidence,
  but no source candidate IDs, source evidence indices, nomination frequency,
  promotion type, prior model output, or reference label. Public candidates and
  evidence use independently shuffled `Cxxx` and `Exx` aliases.
- A private mode-`0600` manifest in a separate operator-only tree is the only
  source of the reversible alias-to-refinery mapping. Its source-binding hash
  is part of the public packet hash.
- Review artifacts are mode `0600` beneath a mode-`0700` directory.

## Selection contract

The default packet target is 30 candidates:

- fail closed unless every requested fixed challenge candidate exists, then
  include all of them;
- fill the remaining capacity from candidates not already selected;
- rank the frozen artifact by
  `distinctSnippets / max(occurrences, 1)` and assign deterministic empirical
  low/middle/high terciles;
- target 10 candidates per ratio stratum and seven or eight per available
  promotion type for a 30-candidate packet;
- fill type-by-stratum cells with a deterministic capacity-respecting
  allocation;
- within a cell, favor candidates whose sampled evidence spans at least three
  sessions and has broader project/harness/wording support, while maximizing
  distinct signature families;
- break remaining ties by SHA-256 of a fixed selection seed and candidate ID.

Aggregate selection counts and all source mappings live only in the private
manifest. The public packet does not identify fixed-challenge or enrichment
rows. Evidence is independently permuted per candidate so previously reported
source indices cannot reveal a label.

## Acceptance gates

1. Pure tests prove every disposition and the three-session boundary.
2. Tests prove mixed and empty-evidence judgments cannot inherit mined
   frequency or unselected pointers.
3. Tests prove malformed, duplicate, missing, out-of-range, and internally
   inconsistent judge rows fail closed.
4. The Nix, wait-monitor dispatch, and documentation lookup/authoring
   confusions are named regression fixtures.
5. Packet tests prove deterministic 10/10/10 ratio selection, balanced
   available types, fixed challenge inclusion, redaction, candidate/evidence/
   session/project/harness aliasing, absence of source identifiers and semantic
   answers, reversible private mapping, and exact packet-hash linkage.
6. A real packet can be generated from the existing refinery artifact without
   scanning canonical conversations or invoking a model.
7. Completed-answer validation rejects unanswered rows and every inconsistent
   status/verdict/evidence/confidence combination.
8. Focused tests, scripts-inclusive typecheck, lint, no-throw ratchet, and the
   repository check pass.
9. The committed diff is independently reviewed against this contract.

## Non-goals

- selecting a production model from silver-label agreement;
- automatic promotion;
- corpus-wide semantic inference;
- changing vault generation;
- changing the lexical nomination recipe;
- sending adjudication evidence to a hosted provider.
