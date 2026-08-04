# Workflow outcomes: descriptive context around explicit policy events

Status: completed
Base: `993a810` (`product-workbench`)
Owner: GPT-5/Codex integration lead
Review model: Fable 5, read-only

## Outcome

Attach bounded, auditable pre/post outcome context to Workflow Evolution events
so the operator can see what changed around a workflow revision without
mistaking temporal association for causation.

The July 22 approval-gate event remains the first tracer. This slice should
answer:

> In the same observed project scope, what completion, friction, rework, and
> session-cost indicators were present immediately before and after the
> explicit workflow instruction?

## Frozen comparison contract

1. Comparisons are local-only derived data and perform no egress.
2. The artifact is bound to both the active structural projection and the
   exact Workflow Evolution artifact.
3. One provider/harness/session/project lineage contributes at most one
   representative conversation. The newest completed active snapshot wins.
4. The workflow event's own opaque episode is excluded. Sessions spanning the
   event anchor are excluded because their treatment status is ambiguous.
5. Scope is limited to projects observed on the workflow event. The artifact
   does not infer that a project-local instruction was global policy.
6. The window is symmetric and corpus-relative: at most 14 days on each side,
   reduced to the shorter observable side and rounded down to a full hour.
   Episodes must be fully contained on their assigned side. Wall-clock
   derivation time is not semantic input.
7. A comparison is `observed` only with at least 24 hours and five deduplicated
   episodes per side. Sparse windows remain visible as
   `insufficient-coverage`; they are not silently discarded.
8. Completion is the derived success outcome among non-unknown outcomes.
   Friction is the fraction of episodes with at least one derived problem.
   Rework is failed attempts among attempts with known outcomes. These are
   explicit proxies, not ground truth.
9. Provider-reported tokens are shown only as per-harness medians with at least
   three samples per side. They are not compared across providers.
10. Every result states that the comparison is descriptive and cannot
    establish that the workflow event caused the observed delta.

## Artifact

`chatlog/workflow-outcomes-v1` contains:

- the exact Workflow Evolution and structural projection hashes;
- deterministic corpus observation bounds;
- one comparison per workflow event;
- pre/post episode counts and proxy metrics;
- bounded rate/median deltas only when their declared sample floor is met;
- deduplicated event, spanning, and outside-window exclusion counts;
- a direct approval-tracer comparison reference;
- zero-egress and no-causality declarations.

No raw session/resume ID, model name, source path, cwd, transcript snippet, or
tool argument is emitted. Projects and harnesses remain intentional provenance.

## Interfaces

- `chatlog query workflow-outcomes` explicitly derives the artifact.
- `/api/insights` exposes the approval comparison plus at most 30 newest event
  comparisons.
- Workbench Patterns adds a descriptive outcome panel beneath the workflow
  event ledger.
- Workbench exposes project counts rather than outcome project paths and omits
  internal outcome event IDs.

Workbench remains GET/HEAD-only and cannot change workflow policy.

## Validation

Synthetic fixtures must prove:

- session snapshots are deduplicated before window assignment;
- the event episode and anchor-spanning sessions are excluded;
- project scope ignores unrelated sessions;
- symmetric windows use corpus time rather than current time and require full
  containment on both sides;
- completion, friction, rework, and per-harness token medians have the declared
  denominators;
- sparse windows produce no misleading delta;
- rebuilding from the same inputs is byte-stable;
- serialized output contains no raw session or model identifier;
- UI/API language says descriptive, not causal.

## Non-goals

- causal inference, significance testing, or automatic policy recommendations;
- comparing raw token values across providers;
- declaring success from sentiment or transcript summaries;
- mutating harness, repository, or agent authority;
- merging paraphrased events across unrelated lineages;
- importing additional personal data for the sake of sample size.

## Slice results

Completed locally on 2026-07-24; publication and workstation package rollout
remain operator-gated.

- Added a content-addressed `workflow-outcomes` artifact bound to both the
  active structure projection and exact Workflow Evolution content hash.
- Each event now gets a project-scoped, corpus-relative comparison with
  deduplicated episode snapshots, symmetric fully-contained windows, explicit
  event/spanning/outside exclusions, and fail-closed coverage floors.
- Completion, friction, rework, session shape, and same-provider/harness token
  proxies are visible only under their declared denominators. Sparse events
  retain context but emit no deltas or causal claim.
- `chatlog query workflow-outcomes`, `/api/insights`, and the Workbench Outcome
  context panel expose the result. The API caps comparisons at 30 and strips
  outcome project paths and internal event IDs.
- Structural object bytes are verified against the active derived receipt
  before metrics are used; tamper and deterministic-rebuild tests cover the
  integrity boundary.
- The local production derivation classified 202 events: 72 have sufficient
  comparison coverage and 130 are explicitly sparse. The July 22 approval
  tracer is correctly sparse at the corpus boundary: a nine-hour symmetric
  window, zero pre/post episodes, and no emitted deltas.
- Fable 5 found five actionable issues covering window symmetry, snapshot
  test falsifiability, exclusion accounting, duration sample floors, and
  structural byte validation. All were corrected; closure reported no
  regressions or remaining blocking findings.
- The final gate passes 62 tests with 416 assertions, every
  CLI/MCP/Workbench/browser bundle, and `nix flake check --offline`.
- A source-tree Workbench smoke returned HTTP 200, bounded the comparison list
  to 30, reconciled every coverage bucket, retained `causal: false`, and
  exposed neither local project paths nor internal outcome IDs.
