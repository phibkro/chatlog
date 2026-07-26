# Design-spec: preserve-and-flag unknown items

Status: **DRAFT — awaiting operator freeze.** Author lane: chatlog.
Depends on: `effect-v4-migration.md` slice 1 (LANDED — `AdaptError` already
carries `itemType`, which is the hook this spec needs).

---

## The one felt outcome

An upstream harness adds a record type chatlog has never seen, and the cost is
**one flagged file and a queue entry** — not a stopped pipeline. The operator
learns about it from a bounded nomination list that says *"`tool_search_call`
seen 47 times across 12 sessions, unhandled"*, and teaches the adapter when
convenient.

## Why

On 2026-07-23 Codex shipped `tool_search_call`. `src/adapters/codex.ts` threw
on the unknown type, ingestion halted, and the refinery produced nothing for
**five days** — until 2026-07-27, when it was found by accident. Nobody was
told, because the pipeline was operator-invoked and a failing run looked
identical to an un-run one.

Two fixes already landed and neither closes this:

- The hourly timer (`cc8fa6e`) means a failure now *happens* and can alert.
- Typed errors (slice 1) mean the failure is a value, not an exception.

But the behaviour is still **all-or-nothing per file**: one unrecognised record
still costs the entire conversation. The durable fix is that an unknown item
stops being fatal without becoming invisible.

## The policy — three cases, not two

The instinct "unknown should pass, with a notification" is right about *fatal*
and incomplete about *loss*. Precisely:

| Case | Policy | Why |
|---|---|---|
| Unknown **key** on a known item | ignore silently | Schema evolution adds fields constantly and nothing is at stake. Flagging these is noise that would bury the signal. |
| Unknown **item type** | **preserve as an opaque turn, and flag** | A whole turn is at stake. Skipping loses it silently; failing loses the file. |
| Malformed / unparseable / redaction failure | fail loud | Not forward-compatibility — a violated assumption. Keep the current behaviour. |

**Why preserve rather than skip.** The corpus stores *normalised* conversations,
not raw source. If ingest skips an unknown item and the upstream session later
rotates or is cleaned up, that turn is gone permanently — a corpus that silently
lacks turns, unrecoverable and undetectable. That is a worse failure than a
halted pipeline, because a halt is at least loud.

Preserving the redacted payload as an opaque turn makes the loss
unrepresentable, and re-derivation upgrades it for free: when the adapter later
learns the type, a re-ingest reinterprets it, because derivation is already a
pure function of source plus recipe hash.

## The queue — a second nomination surface

This deliberately mirrors machinery that already exists:

```
refinery nominates  →  knowledge candidates  →  operator curates
ingest   nominates  →  schema candidates     →  operator teaches the adapter
```

Same shape, same review discipline, same refusal to act unilaterally. An entry
is `{ harness, itemType, occurrences, distinctSessions, firstSeen, lastSeen,
evidence: chatlog:// pointers }` — enough to judge whether it is worth handling
without opening a single raw file.

## Goal / Constraints / Values

**Goal.** No unknown item type can stop ingestion, and none can be lost
silently.

**Constraints (hard):**

1. **Redaction applies to opaque payloads too.** An unhandled item is exactly
   where an unanticipated secret shape could hide. `redact()` runs on the
   retained payload, not just on recognised content.
2. **Opaque turns are distinguishable.** A consumer must be able to tell an
   opaque turn from an interpreted one — derive, refinery and the workbench
   must not silently treat unparsed payload as conversational text and let it
   pollute candidates.
3. **Malformed input still fails.** This spec widens tolerance for *unknown*,
   never for *invalid*.
4. **This CHANGES corpus contents.** Previously-fatal files now produce
   conversations. Corpus hashes will move, once, deliberately — which is why
   this could not ride along inside the migration, whose falsifier is
   behavioural identity. Sequence it as its own change with its own re-derive.

**Values (soft):**

- Bias toward reporting. An unknown item that turns out to be noise costs one
  queue row; one silently dropped costs a corpus you cannot trust.
- Keep the queue bounded and aggregated. 47 occurrences of one type is one row,
  not 47 — the five-day stall was a *reporting* failure, and a queue nobody
  reads repeats it in a new form.

## The hardest risk, attacked first (the tracer bullet)

**The risk is that opaque turns pollute downstream analysis.** If a retained
`tool_search_output` payload flows into the refinery as if it were prose, it
inflates keyword frequency and manufactures candidates from JSON. That would
corrupt the very knowledge queue this project exists to produce — a worse
outcome than the stall.

So the tracer bullet is: **Codex only, one known type, with the downstream
check as the falsifier.** Take `tool_search_call` (the original offender, and
already in the corpus), stop special-casing it in the allowlist, let it come
through the opaque path, and prove that refinery candidate counts and
signatures are unchanged versus the interpreted path.

If opacity leaks into candidates on one type, it leaks on all of them, and
that is cheap to discover now.

## Falsifiers / DoD

1. A synthetic source file containing an invented record type ingests
   successfully, produces a conversation, and yields exactly one queue entry
   naming that type.
2. **No downstream pollution.** With `tool_search_call` removed from the
   allowlist and flowing through the opaque path, `refine` produces the same
   candidate count and the same signatures as with it handled. A difference
   means opaque payload is reaching the miners.
3. **Nothing is lost.** For that same file, every source record is accounted
   for: interpreted turns plus opaque turns equals the record count.
4. Redaction verified on the opaque path: a payload containing a known secret
   shape is redacted in the stored object.
5. Malformed JSON still fails the file — tolerance widened for unknown, not
   for invalid.
6. `bun run check` passes; the no-throw ratchet does not rise.
7. A one-time corpus re-derive is performed and its hash change is recorded in
   the commit message as expected, not silently absorbed.

## Explicit non-goals

- **Not auto-teaching the adapter.** The queue nominates; a human writes the
  mapping. Same rule as the refinery: repetition is not truth, and an inferred
  field mapping is a guess about someone else's schema.
- **Not retroactive re-interpretation** in this change. Once the adapter learns
  a type, re-ingest handles it; an automatic upgrade pass is separate.
- **Not a general plugin system** for harness schemas.
