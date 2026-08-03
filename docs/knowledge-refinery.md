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

## Semantic disposition

`bun run judge:refinery` is an optional, resource-gated local Ollama pass over
the refinery artifact. It is not a promotion command. Run it only after the
required RAM, swap, PSI, GPU, Ollama, and competing-process preflight, and never
concurrently with another GPU job.

The judge protocol requires exactly one valid verdict per requested candidate,
unique in-range integer evidence indices, and no genuine evidence on a
`boilerplate` verdict. A malformed batch aborts instead of silently emitting a
partial result. Valid output is separated into:

- `promotionReview`: `genuine`, with selected evidence spanning at least the
  refinery's distinct-session threshold;
- `manualReview`: every `mixed` verdict, insufficiently supported `genuine`
  verdict, and deferred reference-wiki item;
- `rejected`: `boilerplate`;
- `unjudged`: no valid verdict.

Every support count and pointer is recomputed from explicitly selected evidence.
The result never copies the lexical nomination frequency and never falls back
to all sampled pointers when selection is empty. `promotionReview` still means
human curation, not promotion or eligibility for `agent-eval`.

## Blinded human labels

`bun run adjudication:packet` deterministically selects 30 candidates from the
current refinery artifact. It includes the fixed semantic challenge set, then
balances empirical low/middle/high distinct-wording-ratio strata and available
promotion types using metadata only. It does not read model-bakeoff output.

The content-addressed `public/` directory beneath
`derived/adjudication/refinery/<packet-hash>/` contains:

- `packet.json` and `packet.md`: the public review surface, with shuffled
  `Cxxx`/`Exx` aliases, neutral signature themes, aliased provenance, and
  re-redacted snippets;
- `answers.template.json` and `answers.schema.json`: a packet-hash-bound answer
  form using evidence aliases and an explicit `insufficient-context` state;
  The mode-0600 source mapping, output checksums, and reproducibility metadata
  live separately at
  `derived/adjudication/refinery-private/<packet-hash>/manifest.json`.

This is a trusted-local-only workflow; do not export the packet. Give only the
public bundle to the adjudicator and do not open the private manifest during
review. Copy the template to `answers.json`, fill the adjudicator ID and every
row, then run
`bun run adjudication:verify -- <packet.json> <answers.json>`. The verifier
rejects unanswered or inconsistent rows before labels can be treated as gold.
The answer does not ask for promotion eligibility: that value is derived later
from a genuine verdict and the distinct sessions behind selected evidence, so a
human-entered boolean cannot disagree with the evidence.

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

Measured selection and disposition records live under `docs/promotion-runs/`.
They are audit provenance, not promoted knowledge; rejected treatment artifacts
remain evaluation fixtures only when needed to reproduce the measurement.
