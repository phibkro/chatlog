# Workflow Pattern Synthesis: repeated operator instructions

Status: implemented; awaiting publish approval
Base: `aec7c87` (`product-workbench`)
Owner: GPT-5/Codex integration lead
Review model: Fable 5, read-only

## Outcome

Turn the Workflow Evolution ledger into a small set of repeated,
evidence-backed operator patterns. The product should show which operating
instructions recur across distinct agent episodes, how their wording
changes over time, and what descriptive outcome directions are available.

This slice should answer:

> Which agent-workflow boundaries does the operator repeatedly introduce,
> reinforce, reformulate, or return to, and what non-causal outcome context is
> available for those repetitions?

## Frozen synthesis contract

1. Derivation is local-only, deterministic, read-only, and performs no egress.
2. The artifact binds to the exact Workflow Evolution and Workflow Outcomes
   artifacts plus the active structural projection.
3. Pattern identity is workflow event kind, one explicit orchestration signal,
   and one inferred agent role. Multi-signal or multi-role events may
   contribute to multiple disclosed pattern memberships.
4. Signal-less events use a kind-specific general signal. No embeddings,
   paraphrase clustering, or hosted semantic model are used in v1.
5. One opaque workflow episode contributes at most one representative event to
   one pattern. The newest event wins; earlier same-episode copies remain
   counted as collapsed memberships.
6. A repeated pattern requires at least three distinct opaque episodes across
   two UTC days. Episode lineages are not statistical independence.
   Below-floor signatures remain counted in the summary but are not emitted
   as operator patterns.
7. Episode-level wording relations are conservative:
   - first occurrence: `introduced`;
   - same statement hash as the previous occurrence: `reinforced`;
   - a new statement hash: `reformulated`;
   - return to an earlier non-adjacent statement hash: `returned-to-prior`.
   These describe observed formulations, not policy rescission.
8. Boundary effect is separate from wording relation:
   autonomy signals expand operating latitude, ownership signals impose a
   guardrail, and the structured approval-gate delta relaxes a review gate.
   Absence of an instruction never implies relaxation or reversion.
9. Outcome synthesis uses only representative events whose event-level
   Workflow Outcomes comparison is already `observed`. A pattern needs three
   observed distinct-episode comparisons before its outcome association is
   `observed`.
10. Completion treats higher deltas as favorable; friction and rework treat
    lower deltas as favorable. Each metric needs three non-null samples before
    emitting counts or a median delta.
11. Outcome directions are descriptive. Episode lineages and overlapping
    windows are not treated as independent experiments, no significance test
    is emitted, and no pattern is declared causally effective.
12. Workbench remains GET/HEAD-only and cannot annotate, promote, or mutate an
    agent policy in this slice.

## Artifact

`chatlog/workflow-patterns-v1` contains:

- exact Workflow Evolution, Workflow Outcomes, and structure hashes;
- declared pattern identity, repetition floor, relation semantics, and
  non-causality boundary;
- counts of candidate signatures and repeated patterns;
- deterministic pattern titles and claims;
- distinct episode, shared event-membership, project, harness, formulation, and
  date coverage;
- wording-relation counts and a bounded newest timeline;
- bounded canonical examples;
- coverage-gated completion, friction, and rework association summaries;
- an explicit zero-egress declaration.

Internal artifacts may retain opaque event IDs, evidence pointers, and project
provenance. They emit no raw session/resume ID, model, source path, cwd, tool
argument, or unbounded transcript.

## Interfaces

- `chatlog query workflow-patterns` explicitly derives Workflow Evolution,
  Workflow Outcomes, and Workflow Pattern Synthesis in dependency order.
- `/api/insights` exposes summary data plus at most 30 repeated patterns.
- Workbench Patterns adds a repeated-pattern panel above individual workflow
  events and outcome windows.

The Workbench projection omits internal pattern/event IDs and project paths,
exposing project counts instead. Example evidence remains bounded and
resolvable through the existing read-only evidence endpoint.

## Validation

Synthetic fixtures must prove:

- three distinct episodes across two days are required and same-episode or
  one-day fan-out does not inflate the floor;
- multi-signal membership is explicit rather than silently merged;
- newest episode representatives win deterministically;
- introduced, reinforced, reformulated, and returned-to-prior relations are
  distinguishable;
- outcome aggregation ignores sparse comparisons and requires three observed
  episode comparisons plus three metric samples;
- favorable direction is oriented correctly for completion versus
  friction/rework;
- rebuilding identical inputs is byte-stable;
- stale or modified dependencies fail closed;
- API output contains no project path or internal pattern/event ID;
- all product language remains descriptive and non-causal.

## Non-goals

- semantic clustering of paraphrases;
- inferring policy reversal from silence or changed project context;
- causal inference, significance testing, or automated workflow prescriptions;
- operator annotations or correction storage;
- MCP Agent Brief generation;
- importing personal-domain conversations to increase coverage;
- harness or repository mutation.

## Results

- The live local corpus contains 202 workflow events and 40 candidate
  signatures. Eighteen signatures meet the three-episode/two-day floor; 22
  remain below it.
- The emitted set contains eight autonomy-boundary patterns and ten
  ownership-boundary patterns. Six have enough observed episode windows for
  descriptive outcome association.
- Across emitted histories the ledger records 18 introductions, 15 exact
  reinforcements, 64 reformulations, and no detected returns to a prior exact
  formulation. Every emitted pattern spans at least two UTC days.
- The live Workbench source smoke returned HTTP 200 for the page and insights
  endpoint, exposed all 18 patterns, and exposed neither structured project
  paths nor internal event, episode, or statement identifiers.
- The authoritative gate passes 66 tests and 440 assertions plus CLI, MCP,
  Workbench server, and browser bundles. The path-based Nix flake/package and
  Home Manager module checks also pass.
- A read-only Fable 5 closure review verified the approval/guardrail split,
  strict Workbench allowlists, shared-membership disclosure, deterministic
  integrity checks, and evidence-floor tests. Its one Low UI wording finding
  was fixed, and a narrow follow-up reported no remaining defect.
