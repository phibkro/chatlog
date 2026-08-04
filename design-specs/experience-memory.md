# Experience memory

Status: accepted for implementation on 2026-07-27.

## The one felt outcome

Install Chatlog in an agent harness and begin a new session. The agent starts
with a small, relevant index of lessons learned from prior work, recalls the
supporting memory only when its trigger applies, and avoids repeating measured
mistakes without carrying the operator's history in every prompt.

## Product thesis

The always-loaded prompt is an index, not an archive.

Recurring incidents make an on-demand memory eligible for an always-on trigger.
They do not make the incident, evidence, or full lesson eligible for permanent
prompt residency. Progressive disclosure keeps startup context small while
making detailed experience discoverable at the moment it matters.

Persistent preferences are rarer than remembered experiences. They enter
always-on context only when explicitly operator-confirmed, broadly scoped, and
stable. Project facts, procedures, decisions, and incidents remain scoped
on-demand memories unless a short trigger is required for reliable discovery.

## Memory tiers

### Tier 0 — enforcement, outside memory

Sandbox policy, permissions, required gates, and other invariants remain in
enforced configuration, hooks, tests, or authoritative repository guidance.
Memory must not masquerade as enforcement.

### Tier 1 — always-on routing index

A deterministic, bounded startup block contains only:

- a memory ID;
- a short `USE WHEN` trigger;
- scope: global, repository, path, tool, model, or harness;
- polarity: `prefer`, `avoid`, or `check`;
- the smallest useful action or recall instruction.

It contains no evidence snippets, timestamps, transcript summaries, occurrence
counts, model reasoning, or duplicated authoritative documentation.

Recurring genuine incidents may promote their trigger to this index after
curation. Exceptional one-off incidents require explicit operator approval.
Persistent preferences require explicit operator confirmation and a higher
bar than project-scoped routing entries.

### Tier 2 — on-demand memory cards

The indexed trigger resolves to a compact card containing:

- the situation and observed outcome;
- the lesson;
- a concrete verification or avoidance action;
- scope, confidence, freshness, and status;
- pointers to authoritative documentation and canonical Chatlog evidence.

Cards are returned through bounded local tools or MCP resources. They are not
loaded merely because the session belongs to the same project.

### Tier 3 — canonical evidence

Full supporting turns remain behind explicit `chatlog://` evidence resolution.
They are never part of startup memory and never returned by discovery tools.

## Candidate and curation model

Discovery has two lanes:

1. **Recurring experience** — the existing distinct-session refinery lane.
2. **Exceptional incident** — an unusual failure, recovery, correction,
   reversal, or surprising success whose cost or explicit operator feedback
   justifies review without recurrence.

Semantic analysis proposes structured labels:

- kind: correction, failure, recovery, success, surprise, decision, preference;
- valence: positive, negative, mixed;
- lesson: prefer, avoid, check;
- trigger and scope;
- genuine evidence indices;
- confidence and freshness suggestion.

The model does not promote memories. A curator can accept, correct, reject, or
retire a proposal in a separate memory ledger. The refinery remains nomination
provenance and does not become an authoritative memory store.

The operator review surface must not require semantic-analysis expertise. A
versioned sidecar binds a real model-authored proposal and its generator
provenance to every alias in the blinded packet. The surface presents the
historical scenario and that proposed lesson, then asks:

- was the judgment `correct`, `incorrect`, or `unsure`;
- was the lesson `positive`, `negative`, or `neutral`;
- optionally, what should the judgment have been or what context is missing.

The structured choices are authoritative feedback. Free text is supporting
detail, never a completion requirement. Proposal reviews live in their own
ledger and must not be lossily compiled into the expert human-adjudication
answer schema.

### Semantic routing and escalation

Use model capability as an escalation ladder, not as a reason to send every
candidate to the strongest model or the operator:

1. Batch ordinary candidates through the selected efficient semantic model.
2. Escalate only explicitly uncertain, internally inconsistent, or
   policy-gated rows to the strongest available model.
3. Ask the operator only when the strongest model still returns uncertainty or
   when an operator-only product decision is required.

Each request is deterministically partitioned at no more than 250,000 input
tokens, with whole candidates kept together. Batch manifests bind the recipe,
model, effort, ordered candidate aliases, input hash, and output hash. An
upgraded result supersedes only the exact rows named in its manifest; it does
not rewrite unrelated proposals. Operator review remains useful for calibrating
the system and measuring model error even when production routing would not
have escalated that row.

## Compilation and cache contract

- Compile the accepted ledger into a content-addressed, deterministically
  ordered Tier 1 snapshot.
- Keep the initial target at 1,500 tokens and fail closed above 2,000 tokens.
- Put stable harness instructions and tool definitions before the snapshot.
- Inject the snapshot once through a `SessionStart` hook matching `startup`
  only, immediately before the first user prompt.
- Pin the snapshot version to the session. Resume, clear, compact, tool, and
  user-prompt hooks must not inject a newer version.
- Append new conversation turns; never rewrite earlier transcript content.
- Publish memory revisions in batches after curation rather than interpolating
  volatile values at launch.
- Feedback from an active session affects only a future compiled snapshot.

This preserves the stable prompt prefix within a session. A newly published
memory version may change cross-session cache reuse, so revisions must be
deliberate, bounded, and free of timestamps or other incidental churn.

## Harness boundary

The distributable unit is a Chatlog plugin with:

- a startup-only hook that resolves Git repository identity and emits the
  current compiled snapshot;
- bounded tools to recall a memory card and resolve one evidence pointer;
- a feedback tool for `helpful`, `harmful`, `stale`, or `mis-scoped`;
- a local compiler and ledger shared across supported harness adapters.

Claude Code and Codex receive the same compiled content through their native
plugin and hook mechanisms. Harness-specific wrappers must not fork the memory
semantics.

## Reinforcement contract

Positive and negative feedback change ranking only after review or a measured
evaluation. A model saying it used a memory is weak evidence. Prefer observable
outcomes:

- gate pass or regression;
- repeated error avoided or reproduced;
- tokens and time to gate;
- re-derivation count;
- operator intervention;
- explicit operator feedback.

Use the existing `agent-eval/promotion-v1` paired-session contract. Keep a
memory only when gate performance does not regress and re-derivation or
tokens-to-gate improves. Revise or retire memories that are ignored,
misapplied, stale, or harmful.

## Tracer bullet

1. Human-label the existing blinded refinery packet in the Foldkit Memory Lab
   at `/memory/` before selecting a semantic judge.
2. Curate five genuine candidates spanning `prefer`, `avoid`, and `check`.
3. Store them in a minimal accepted-memory ledger.
4. Compile one project snapshot and inject it into fresh Codex and Claude Code
   sessions through startup-only hooks.
5. Demonstrate that a trigger causes on-demand recall of one card while an
   unrelated task does not load it.
6. Run paired fresh-session tasks with and without the snapshot.

Do not expand to automatic promotion or corpus-wide memory until the tracer
bullet demonstrates correct labels, reliable triggering, bounded startup cost,
and a measurable reduction in re-derivation without a gate regression.

## Acceptance gates

- The same ledger and project identity produce byte-identical startup memory.
- The startup snapshot stays below 2,000 tokens and contains no evidence text.
- Active sessions never receive a changed memory snapshot.
- Every Tier 1 entry resolves to a current Tier 2 card or is omitted.
- Every Tier 2 factual claim has an authoritative pointer or canonical evidence
  pointer.
- Rejected, mixed, stale, and unjudged refinery candidates cannot compile.
- Explicit global preferences are distinguishable from inferred project
  experience.
- Fresh-session tests prove relevant recall and irrelevant non-recall in both
  supported harnesses.
- Paired evaluation shows no gate regression before a memory is retained.

## Governed insight ledger (v2)

The accepted-memory ledger is a read-only rollback source after migration. The
publication authority is the immutable v2 insight ledger under
`memory/insight-ledgers/<sha256>.json`, addressed by
`memory/insight-current.json`. SQLite tables are rebuildable read projections.

An insight revision has a semantic kind, all scope axes, support and
counterevidence URIs, observed and valid times, system record time, lifecycle
status, relation fields, origin, human authority, derivation recipe/input
hashes, assessor-specific confidence, and authoritative document references.
Model proposals remain candidates. Only an explicit human/operator transition
can activate, dispute, supersede, expire, or retire a revision.

Every transition records its actor, authority, reason, source hashes, and prior
ledger hash. Writes are serialized by `memory/insight-ledgers/.lock`, use
content-addressed snapshots, and are atomic mode `0600` writes. Repeating the
same idempotency key is a no-op; a stale prior ledger hash is rejected.

The current pointer binds project identity, input event projection, source
authority, recipe hashes, ledger hash, compiled state hash, and startup output
hash. A read rejects altered ledger bytes, stale compiled output, or a binding
mismatch. Tier 1 remains an evidence-free bounded routing index; Tier 2 and
Tier 3 retain the complete revision and canonical evidence pointers.

Use explicit `chatlog insight migrate` (dry-run), `chatlog insight preview`,
`chatlog insight apply`, `chatlog insight current`, and
`chatlog insight recompile` commands. Migration preserves v1 IDs, hashes, and
legacy evidence URIs. A migration preview does not change private memory.
`chatlog insight migrate --apply` is the only migration write.
The v1 publication path is disabled.

If active evidence or source authority changes, normal reads and transitions
fail closed. `chatlog insight recompile` explicitly verifies the active evidence,
rebuilds the compiled snapshot and SQLite projection, and advances the pointer.
It does not change the lifecycle history.
