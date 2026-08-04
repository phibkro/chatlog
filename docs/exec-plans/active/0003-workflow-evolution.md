# Workflow evolution: deduplicate operator policy changes across agent fan-out

Status: active
Base: `405d38f` (`product-workbench`)
Owner: GPT-5/Codex integration lead
Review model: Fable 5, read-only

## Outcome

Give the operator an evidence-backed history of how they change their agent
workflow without treating every delegated copy of one instruction as a new
decision.

The first end-to-end tracer is the explicit 2026-07-22 approval-policy change:
verified agents may integrate work without a separate operator review gate,
while required checks remain in force. This is a useful tracer because it has
a date, an explicit before/after boundary, and repeated copies across agent
sessions that expose the current over-counting problem.

## Product question

Chatlog should answer:

> Which workflow rules did I introduce or revise, when did I do it, where did
> the instruction propagate, and what evidence supports that history?

This slice establishes the event ledger needed for later outcome attribution.
It does not claim that a workflow change caused a measured result.

## Frozen invariants

1. Derivation is local-only and performs no hosted-model or other network call.
2. Workflow events are derived data bound to the active corpus projection.
   Corpus conversations remain immutable authority.
3. Only genuine operator turns are eligible. Tool results, relay envelopes,
   teammate messages, restored context, and quoted control text are excluded.
4. Exact propagated copies within one opaque session lineage and UTC day are
   one event. The artifact reports how many conversation copies were collapsed.
5. Session identifiers are hashed before entering the artifact. Raw resume,
   conversation, source-path, and filesystem identifiers are not emitted.
6. Cross-session copies are not merged without a stable lineage signal. The
   methodology must disclose this conservative boundary.
7. Every event has at least one resolvable `chatlog://` evidence pointer.
   Evidence is redacted, bounded, and sorted deterministically.
8. Event and summary timestamps come from corpus data. Derivation time is not
   semantic input, so identical corpus and recipe inputs produce identical
   artifact bytes.
9. Workbench remains read-only. The artifact can explain current evidence but
   cannot mutate harness policy, repository configuration, or agent authority.
10. Language is associative and descriptive. Causal outcome claims are deferred
    until the product has a declared comparison design and falsifiers.

## Artifact contract

The content-addressed artifact uses:

```text
schemaVersion: 1
outputKind: workflow-evolution
inputProjectionHash: <active projection hash>
methodology: <deduplication and inference boundaries>
summary: <candidate, unique, collapsed, episode, and kind counts>
tracers.approvalGate: <newest explicit approval-policy event or null>
events: <deterministically ordered event records>
egress: <explicit zero-egress declaration>
```

Each event contains:

- an opaque deterministic event ID;
- kind: `approval-gate-changed`, `autonomy-boundary`, or
  `ownership-boundary`;
- an evidence-derived occurrence timestamp;
- a bounded redacted operator statement and its hash;
- affected projects, harnesses, roles, and conversation count;
- an opaque episode ID and number of duplicate copies collapsed;
- bounded evidence pointers;
- an explicit-instruction confidence label;
- for approval changes, the inferred before, after, and retained boundaries.

The grouping key is event kind, normalized statement hash, hashed session
lineage, and UTC date. This collapses same-session agent fan-out while leaving
separate-day reminders and unrelated sessions visible.

## Interfaces

- `chatlog query workflow-evolution` explicitly derives and prints the report.
- `/api/insights` exposes a bounded workflow-evolution projection when the
  artifact exists and is current.
- Workbench Patterns shows the approval tracer, summary counts, and newest
  events with clickable evidence.

All read surfaces fail closed on artifact integrity or projection drift.

## Test tracer

Synthetic fixtures must prove:

- three identical approval instructions copied to three conversations in one
  session/day produce one event with two copies collapsed;
- the same instruction in another session or day remains distinct;
- a relayed or restored-context copy is not treated as an operator event;
- raw session IDs do not appear in serialized artifacts;
- all evidence pointers resolve to eligible operator turns;
- rerunning derivation is idempotent and byte-stable;
- Workbench returns the bounded artifact without gaining a mutating endpoint.

The production validation should then derive the ledger locally and confirm
that the July 22 event is visible with fan-out counts. Real chat text is never
sent to the delegated reviewer.

## Explicit non-goals

- causal scoring of workflow changes;
- automatic recommendations or harness configuration mutation;
- semantic clustering of paraphrases across unrelated sessions;
- identity inference across providers without a stable local lineage key;
- importing the Anthropic personal export as part of this slice;
- model-routing prescriptions;
- a general-purpose personal knowledge graph.

## Follow-on

Once lineage and event correctness are trusted:

1. attach pre/post outcome windows to explicit events;
2. compare role, friction, token, rework, and completion indicators;
3. surface repeated revise/retain/revert patterns;
4. let agents query the same bounded evidence through MCP;
5. add operator-authored annotations for corrections and intentional
   experiments without rewriting the underlying corpus.

## Slice results

Completed locally on 2026-07-24; publication and workstation package rollout
remain operator-gated.

- Added a content-addressed `workflow-evolution` artifact bound to the active
  derived projection. Its recipe includes workflow classification, role
  inference, orchestration signals, and redaction behavior.
- Exact normalized instructions now collapse only within provider-, harness-,
  identifier-kind-, session-, and UTC-day lineage. Duplicate counts mean
  distinct conversation copies; repeated turns in one conversation do not
  inflate fan-out.
- Approval-gate removal, bounded autonomy, and ownership guardrails are
  classified separately. Questions, prohibitions, retained/reinstated gates,
  tool-result followers, relay envelopes, and restored context do not mint the
  pro-autonomy approval delta.
- `chatlog query workflow-evolution`, `/api/insights`, and the read-only
  Workbench Patterns view expose the bounded ledger and canonical evidence.
- Synthetic tests cover true rebuild byte stability, provider identifier
  collisions, same-day fan-out, another-day decisions, repeated turns,
  prohibition polarity, embedded/restored control envelopes, predecessor
  context, raw-identifier absence, and bounded evidence.
- The final local production derivation scanned 3,322 conversations and 11,696
  eligible operator turns. It found 231 candidate event turns, 202 distinct
  events, and 28 collapsed conversation copies: 1 approval-gate change, 79
  autonomy boundaries, and 122 ownership boundaries.
- The July 22 approval tracer resolves to two canonical conversation copies,
  collapses one duplicate, and retains required verification in its policy
  delta.
- Fable 5's initial and closure reviews produced nine actionable findings
  covering polarity inversion, dependency invalidation, lineage namespaces,
  deterministic ordering, evidence re-verification, duplicate semantics, and
  fixture gaps. All were corrected; the final two-item review reported
  `No actionable findings.`
- The final gate passes 60 tests with 397 assertions, all CLI/MCP/Workbench
  bundles, and `nix flake check --offline`, including the package and Home
  Manager evaluation.
