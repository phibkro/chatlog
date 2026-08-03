# Plan 002: Enforce provider conformance and semantic-loss accounting

> **Executor instructions**: Read Plan 001 and this plan fully. Run each verification command. Stop if a STOP condition occurs.
>
> **Drift check**: Run `git diff --stat 8ddee39..HEAD -- src/adapters src/events.ts src/event-store.ts test README.md`. Compare the live event contract with Plan 001 before implementation.

## Status

- **Priority**: P1
- **Effort**: L
- **Risk**: HIGH
- **Depends on**: `plans/001-canonical-agent-events.md`
- **Category**: direction, tests, migration
- **Planned at**: commit `8ddee39`, 2026-08-03

## Why this matters

A canonical type does not prove faithful normalization. Each adapter needs evidence that it preserves required meaning and declares every loss.

Today, recognized provider records can disappear. Unknown records can abort a whole file. No production adapter has a conformance fixture matrix.

## Current state

- `src/adapters/claude.ts:8-28,61-128` recognizes many record kinds but projects only messages, string system records, and results.
- `src/adapters/codex.ts:8-36,102-147` recognizes compaction, world state, reasoning, and tool variants but emits only selected items.
- `src/adapters/pi.ts:8-18,46-92` recognizes compaction and branch summaries but ignores them.
- `src/adapters/common.ts:28-92` fails unknown records or blocks with typed `AdaptError`.
- `src/jsonl.ts:24-54` makes an incomplete final line non-fatal but returns only `partialTail`.
- `test/anthropic-export.test.ts` covers the Web exporter.
- No tests import the production Claude Code, Codex, or Pi adapters.
- `design-specs/preserve-and-flag-unknown-items.md` contains relevant draft intent. It is not implemented authority.

Preserve fail-closed behavior for malformed JSON, malformed objects, redaction failure, and invalid event relations.

## Target contract

For every source item, exactly one result must occur:

1. Normalize it into one or more typed events.
2. Preserve it as a redacted opaque event.
3. Record an explicit omission with a policy reason.
4. Reject the whole source as malformed. Write no successful receipt for that source.

The adapter receipt must make this equation true:

```text
source items = normalized items + opaque items + policy omissions
```

This equation applies only to successfully ingested sources and events with `origin.kind === "observed"`. A malformed source fails before a receipt exists.

An unknown but well-formed item is not malformed. Preserve it as opaque and nominate its shape for adapter maintenance.

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| Conformance tests | `bun test test/adapter-conformance.test.ts` | Exit 0 |
| Loss tests | `bun test test/semantic-loss.test.ts test/jsonl.test.ts` | Exit 0 |
| Adapter regressions | `bun test test/anthropic-export.test.ts test/derive.test.ts` | Exit 0 |
| Type checks | `bun run typecheck` | Exit 0 |
| Full gate | `bun run check` | Exit 0 |

## Scope

**In scope**

- Create `src/adapter-conformance.ts` if shared validation logic is necessary.
- Change `src/events.ts` only to finalize receipt and loss types.
- Change `src/adapters/common.ts`, `claude.ts`, `codex.ts`, and `pi.ts`.
- Change `src/importers/anthropic-export.ts`.
- Change `src/ingest.ts` to persist and report loss receipts.
- Create synthetic provider fixtures under `test/fixtures/providers/`.
- Create `test/adapter-conformance.test.ts` and `test/semantic-loss.test.ts`.
- Update `README.md` with the conformance and semantic-loss contract.

**Out of scope**

- ChatGPT or generic JSONL import.
- Insight extraction from opaque events.
- Hosted model classification of unknown records.
- Automatic schema changes from nominations.
- Storing unredacted unknown payloads.

## Git workflow

- Use branch `advisor/002-adapter-conformance-loss` in an isolated worktree.
- Use conventional commit messages.
- Do not push or publish fixtures without operator review.

## Steps

### Step 1: Build a provider fixture matrix

Create small, synthetic native traces for each supported source.

Each fixture must cover every allowlisted top-level record and content-block kind. Include provider-native IDs, parent links, timestamps, tool calls, results, approvals when available, compaction, branch state, artifacts, and token events.

Do not use real transcript text. Use inert synthetic values and redaction canaries.

Create a table in the test data that maps each source item to its expected event IDs or loss codes.

**Verify**: `bun test test/adapter-conformance.test.ts` fails before production adapter changes.

### Step 2: Define semantic-loss reason codes

Use a closed reason union. Include at least:

- `capture-policy-omission`
- `provider-field-unsupported`
- `encrypted-content-unavailable`
- `attachment-body-excluded`
- `reasoning-excluded-from-projection`
- `unknown-well-formed-item`
- `partial-live-tail`
- `relation-target-missing`

Each loss entry must contain:

- provider and harness
- source item kind
- source locator
- count
- first and last observation times when available
- affected event IDs when available
- policy or adapter recipe
- whether replay after an adapter upgrade can recover the meaning

Do not put unknown payload text in aggregate reports.

**Verify**: focused loss-schema tests exit 0.

### Step 3: Preserve unknown well-formed records as opaque events

Change adapter behavior:

- A well-formed unknown record becomes a redacted opaque event.
- A well-formed unknown content block becomes a redacted opaque child event or explicit omission.
- Malformed JSON, malformed objects, invalid IDs, and redaction errors still fail.
- Opaque events do not enter FTS, ordinary message projections, insight extraction, handoffs, or startup context.

Create bounded nominations grouped by provider, harness, source kind, and native item kind. A nomination is maintenance evidence, not a new schema.

**Verify**: tests prove an unknown item does not stop later valid records and does not pollute search or derivation.

### Step 4: Account for recognized but unsupported semantics

Remove silent `return` paths for allowlisted records. Every recognized record must emit a typed event or loss entry.

Specific checks:

- Claude permission, mode, file-history, attachment, queue, and link records.
- Codex compacted, world-state, inter-agent, reasoning, web-search, local-shell, and computer records.
- Pi compaction, branch-summary, custom, and model-change records.
- Anthropic unknown blocks and excluded bodies.

Do not map provider policy records to portable provider policy. Preserve them as evidence only.

**Verify**: fixture accounting equals source-item count for every provider.

### Step 5: Add query-invariance fixtures

Create semantically equivalent sessions for Claude Code, Codex, Pi, and Anthropic Web.

They must answer these questions with equivalent normalized evidence:

- What decision was made?
- Which tool call was proposed?
- Which tool actually produced a result?
- Was the action approved, denied, or unknown?
- Which branch was active at the end?
- What remains unresolved?

The result need not be byte-identical. Required semantic fields and relations must match.

**Verify**: `bun test test/adapter-conformance.test.ts` exits 0 for every provider pair.

### Step 6: Persist per-source receipts

Ingestion must write a content-addressed receipt for each source batch. The receipt must include:

- source and event-batch hashes
- adapter and capture-policy recipes
- item counts by disposition
- partial-tail state
- loss counts by reason
- active-source authority version
- event and conversation projection hashes

Expose aggregate counts in CLI and Workbench without transcript text.

A later adapter recipe must replay the source and produce a new event batch. It must not mutate the old batch.

**Verify**: idempotent ingestion returns the same receipt hash. A recipe change produces a new receipt and projection.

### Step 7: Document the conformance rule

Update `README.md` and adapter guidance.

State that an adapter is complete only when:

- every fixture item is accounted for
- all semantic invariants pass
- loss reasons are explicit
- opaque data stays out of normal retrieval
- malformed data still fails closed

**Verify**: run `bun run check`.

## Test plan

Use table-driven Bun tests. Keep each fixture small enough to inspect by hand.

Required negative cases:

- duplicate native event ID
- dangling tool-result ID
- parent cycle
- branch cycle
- invalid timestamp
- unknown well-formed record
- malformed record aborts the source with path and position, then writes no receipt
- incomplete final JSONL line
- secret canary in opaque payload
- opaque event accidentally visible in FTS or derive output

## Done criteria

- [ ] Every current allowlisted provider item is normalized or declared as loss.
- [ ] Unknown well-formed items do not halt ingestion.
- [ ] Malformed inputs still fail closed with path and position.
- [ ] Production Claude, Codex, Pi, and Anthropic adapters have direct fixture tests.
- [ ] Provider-equivalent sessions pass semantic query invariance.
- [ ] Every successful source receipt is deterministic and content-addressed.
- [ ] Opaque and reasoning events stay out of normal retrieval and insight extraction.
- [ ] `bun run check` exits 0.
- [ ] `plans/README.md` marks Plan 002 `DONE`.

## STOP conditions

Stop and report if:

- Plan 001 did not produce one canonical event contract.
- A fixture came from private corpus data or contains real transcript text.
- Preserving an unknown record requires storing an unredacted secret-bearing payload.
- A provider item meaning is unclear and cannot be represented honestly as opaque.
- Query invariance requires inventing approval, execution, or outcome state.

## Maintenance notes

A provider schema change must first add a failing fixture. Then update one adapter and its loss accounting.

Do not let the nomination queue mutate event types. A reviewed code change owns schema evolution.
