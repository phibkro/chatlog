# Knowledge refinery contract

The refinery turns repeated chat-log structure into a review queue. It does not
turn repetition into truth. Three distinct logical sessions are the minimum
nomination threshold; immutable snapshots of one live session count once.

## Candidate lifecycle

1. Run `bun run refine`. The aggregate artifact is a pure function of the
   current redacted derived projection, the recipe hash, and the threshold.
   An identical run returns `processed: false`.
2. List a bounded type with `bun run query refinery <type> <limit>` and inspect
   one item with `bun run query candidate <id>`. Evidence is sampled across
   distinct sessions and points back to canonical turns.
3. Curate, including the option to reject. Broad co-occurrence, repeated local
   repair, stale history, and duplicated authoritative documentation are all
   reasons to reject despite high frequency.
4. For accepted procedures and landmines, use the existing `write-a-skill`
   gather/draft/fresh-agent-validation workflow. For facts and decisions, run
   `writing-memory-entries` and prefer an ADR/spec/test as authority. Put only
   stable, broadly applicable startup context in the nearest `CLAUDE.md`.
5. After the approved item is installed in that real channel, obtain
   `bun run query eval-plan <id>` and create paired `agent-eval` tasks.

There is intentionally no refinery-side disposition database or promotion
command. The accepted artifact lives in its existing authoritative system;
the candidate remains provenance for why it was considered.

## `agent-eval/promotion-v1`

The control and treatment use the same repository, clean start commit, task,
gate, model/harness selection, timeout, and intervention policy. The only arm
difference is availability of the curator-approved item through its intended
channel. Run at least three paired repetitions per arm.

Record the metrics already native to `agent-eval`: gate pass, wall-clock time,
tokens or tokens-to-gate, timeout, and interventions. Add task-specific,
predeclared re-derivation markers—for example repeated discovery commands,
reopening the same authoritative file, or restating the promoted decision—and
count them as `rederivationCount`. Markers must be fixed before viewing results.

Keep the item only when gate pass does not regress and median re-derivation or
tokens-to-gate improves. Revise or remove it if the gate regresses, agents
ignore or misapply it, or paired runs show no efficiency signal. No uncurated
candidate is eligible for an experiment; `query eval-plan` reports this block
explicitly rather than fabricating a treatment.

## Deferred reference wiki

Wiki candidates are held for a later operator-approved increment. That future
surface may point to stable external reference material only. It must link, not
copy; must not restate project-local truth; and must not become a god-wiki or a
second documentation hierarchy.
