# Chatlog

Chatlog is a local, provider-agnostic context layer for coding agents. It turns
Claude Code, Codex, Pi, OMP, ChatGPT, and Anthropic activity into portable
evidence, governed insights, and bounded context for later sessions.

> **Pre-release:** `v0.1.0-rc.1` is ready for local evaluation. Storage formats
> and operator workflows can still change before `v0.1.0`.

## The feedback loop

```text
work -> events -> evidence -> insights -> context -> better work
```

Chatlog:

- reads provider histories without modifying them;
- normalizes supported records into immutable, redacted agent events;
- keeps exact provenance and reports semantic loss at adapter boundaries;
- provides local search, project state, evidence lookup, and bounded recall;
- requires explicit human authority before a derived claim becomes active;
- records context delivery, feedback, and observed outcomes separately.

It does not merge private provider session stores or silently rewrite an
agent's native memory. Context is delivered through supported startup hooks,
MCP tools, or inert prompt artifacts.

## Install and first launch

The pre-release Nix package supports `x86_64-linux` and `aarch64-linux`.
[Install Nix with flakes enabled](https://nixos.org/download/) first.

```sh
nix profile install --refresh \
  github:phibkro/chatlog/v0.1.0-rc.1#chatlog

chatlog --version
chatlog ingest
chatlog-workbench
```

`chatlog ingest` discovers local histories under `~/.claude/projects`,
`~/.codex/sessions`, `~/.pi/agent/sessions`, and `~/.omp/agent/sessions`.
It writes the redacted corpus and derived views to
`${XDG_DATA_HOME:-~/.local/share}/chatlog`. The command does not run as a
watcher. Run it again after new agent work.

`chatlog-workbench` prints a one-time loopback URL. Open that URL to browse
projects and sessions, search prior attempts, inspect evidence, review
patterns, and manage released context. The server sends no hosted analytics.

Set one persistent custom data root before ingestion and agent startup if
required:

```sh
export CHATLOG_DATA_ROOT=/path/to/operator-owned/chatlog
```

The data root must exist for agent plugins and must be outside the active
repository.

### Connect Claude Code and Codex

The installed package contains one local marketplace for both plugin systems:

```sh
CHATLOG_MARKETPLACE="$(chatlog plugin path)"

claude plugin marketplace add "$CHATLOG_MARKETPLACE"
claude plugin install chatlog-memory@chatlog --scope user

codex plugin marketplace add "$CHATLOG_MARKETPLACE"
codex plugin add chatlog-memory@chatlog
```

Open a new Claude Code or Codex session after installation. The plugin exposes
bounded local MCP tools for search, evidence, recent work, project state,
governed context, and recursive recall. A startup hook binds governed delivery
only when the data root contains a current insight projection for that
project. It never injects complete transcripts or promotes a candidate.

OMP and Pi histories are ingested. Their current context-delivery adapters
produce operator-authorized fresh-session prompt artifacts; no automatic
plugin installation is provided for those harnesses in this pre-release.

### Import provider exports

Preview an export before it changes local state:

```sh
chatlog preview chatgpt /path/to/chatgpt-export.zip personal
chatlog import chatgpt /path/to/chatgpt-export.zip personal

chatlog preview anthropic /path/to/anthropic-export.zip personal
chatlog import anthropic /path/to/anthropic-export.zip personal
```

The generic `chatlog/generic-events-v1` importer supports versioned external
adapters. See
[docs/workbench.md](docs/workbench.md#generic-chatlog-event-jsonl).

## What works in this pre-release

| Capability                                                                    | Status                              |
| ----------------------------------------------------------------------------- | ----------------------------------- |
| Native Claude Code, Codex, Pi, and OMP ingestion                              | Available                           |
| ChatGPT, Anthropic, and versioned generic export import                       | Available with preview and receipts |
| Immutable redacted events, provenance, and semantic-loss accounting           | Available                           |
| Local Workbench search, evidence, project, pattern, memory, and context views | Available                           |
| Local stdio MCP search and bounded evidence tools                             | Available                           |
| Claude Code and Codex marketplace plugins                                     | Available for fresh sessions        |
| Governed insight ledger and intervention/outcome records                      | Available; human-authorized         |
| Pi and OMP automatic startup integration                                      | Not yet; prompt artifacts only      |
| Automatic insight promotion                                                   | Intentionally unavailable           |
| Hosted sync, team accounts, and remote raw-transcript storage                 | Not implemented                     |

Memory Lab reviews only complete, prepared adjudication bundles. It does not
run a model or infer approval. The advanced refinery and insight lifecycle is
documented below and in
[docs/knowledge-refinery.md](docs/knowledge-refinery.md).

## Data model and safety

Each source file is adapted into an immutable redacted `EventBatch` at the
`SourceAdapter` seam. The event batch is canonical evidence: it preserves
ordered provider observations, typed tool lifecycle events, branches,
compaction, artifacts, reasoning, opaque items, semantic loss, and source
provenance. It is content-addressed beneath
`corpus/events/<prefix>/<sha256>.json`. Changed live sessions create a new
immutable batch.

`Conversation` remains a deterministic compatibility projection generated by
`src/conversation-projection.ts`. Existing
`chatlog://conversation/<hash>/turn/<index>` pointers continue to resolve to
projection turns. New evidence can point to
`chatlog://event/<batch-hash>/<event-id>`; both grammars are parsed by
`src/evidence-uri.ts`.

The source directories are only opened for discovery, stat, and streaming
reads. Chatlog never writes beneath `~/.claude`, `~/.codex`, `~/.pi`, or
`~/.omp`. Corpus and analysis files are mode 0600 inside mode 0700
directories.

## Workbench

Chatlog Workbench turns the corpus into a local product for both the operator
and coding agents. It provides a project and session browser, full-text recall
with resolvable evidence, measured orchestration patterns, refinery candidates,
and a source-connection screen.

```sh
chatlog ingest
chatlog-workbench
# Open the one-time bootstrap URL that the server prints.
```

The server binds to loopback and creates a random credential for each launch.
It requires this credential on all API routes. It reads the existing corpus
and does not use hosted analytics. Set `CHATLOG_DATA_ROOT` when the data lives
outside this checkout. See [docs/workbench.md](docs/workbench.md) for source
configuration, the API, and the privacy boundaries. The durable local-first product
and deferred hosted-companion direction is recorded in
[docs/product-direction.md](docs/product-direction.md).

## Agent MCP

The local stdio MCP server gives coding agents bounded recall without exposing
the entire archive:

```sh
CHATLOG_DATA_ROOT=/path/to/chatlog \
CHATLOG_MCP_DOMAINS=coding \
chatlog-mcp
```

It implements local lexical search, one-turn evidence resolution, project state,
accepted-memory recall, governed context delivery, and finite cooperative
recall. The server opens no network listener and makes no hosted calls.
The default domain is `coding`. Other domains require explicit enumeration.
See [docs/mcp-tool-shape.md](docs/mcp-tool-shape.md) and
[docs/access-policy.md](docs/access-policy.md).

`chatlog_bounded_recall` requires a live context session from
`chatlog_context`. Each branch inherits the session scope and a reduced budget.
The runtime records branch lifecycle, returned evidence references, budget use,
and the termination reason as immutable context events. The same path is
available with `bun run src/cli.ts context recall <request.json>`.

The synthetic transfer pilot at
`eval/procedure-transfer-pilot/eval.json` compares no-memory, evidence-only, and
procedure arms. It covers `keep`, `adapt`, and `reject` decisions without
hosted calls. The evaluator is `src/procedure-transfer-evaluation.ts`.

## Build from source and deploy

```sh
nix build .#chatlog
nix run .#cli -- preview anthropic /path/to/data-export.zip personal
nix run .#workbench   # or: nix run .#mcp
```

`nix flake check` evaluates the package and Home Manager module offline once
inputs are fetched. An opt-in, loopback-default `services.chatlog-workbench`
Home Manager module is available for running Workbench as a persistent user
service. See [docs/workbench.md](docs/workbench.md#package-and-deploy) for the
module options, systemd hardening, and the Tailscale Serve handoff for remote
access.

An Anthropic data export can be previewed without writing any Chatlog state,
then connected as an explicit import:

```sh
bun run preview:anthropic -- /path/to/data-export.zip personal
bun run import:anthropic -- /path/to/data-export.zip personal
bun run src/cli.ts receipts imports 20
bun run src/cli.ts source reconcile
```

The importer currently ingests `conversations.json`, including visible text and
tool activity. It intentionally excludes model thinking, token-budget metadata,
and extracted attachment bodies; attachment and file names are retained as
context. The source archive is never modified. Claude Projects, memories, and
design artifacts are left for separately reviewable adapters rather than folded
into conversations implicitly.

`corpus/manifest.json` is the durable authority for active source mappings. Each
mapping carries the canonical event-batch hash and conversation projection hash;
the legacy `contentHash` field remains the projection hash so existing evidence
pointers stay resolvable. SQLite keeps rebuildable event metadata, typed
relations, source-to-event provenance, and conversation/FTS projections.
Ingestion reconciles all of them under the ingest lock, and active guards fail
closed when the manifest receipt or event batch is unavailable.

Reasoning and opaque provider events are preserved as evidence but never enter
ordinary message FTS, derived insight mining, handoffs, or context delivery.
Adapter recipe or capture-policy changes rebuild affected batches and their
projections. No raw unredacted provider payload is written to the corpus.

## Adapter conformance and semantic loss

An adapter must account for every well-formed source item exactly once:

```text
sourceItems = normalizedItems + opaqueItems + redactedItems + omittedItems + lossOnlyItems
policyOmissions = omittedItems + lossOnlyItems
unaccountedItems = sourceItems - eventBackedItems - lossOnlyItems = 0
```

`eventBackedItems` counts unique native source positions, not emitted events.
An item may produce several canonical events. `redactedItems` records provider
redaction while `opaqueItems` records an unrecognized item retained as evidence;
`policyOmissions` are recognized items omitted by capture policy. Malformed JSON,
malformed objects, invalid identifiers, invalid timestamps, redaction failures,
and invalid event relations fail closed and do not create a successful receipt.

The closed semantic-loss codes are:
`capture-policy-omission`, `provider-field-unsupported`,
`encrypted-content-unavailable`, `attachment-body-excluded`,
`reasoning-excluded-from-projection`, `unknown-well-formed-item`,
`partial-live-tail`, and `relation-target-missing`. Every loss records provider,
harness, source item kind and locator, count, observation interval when
available, affected event IDs when available, adapter and capture recipes, and
whether a later adapter replay can recover the meaning. Unknown but well-formed
records become redacted `provider.opaque` evidence and are grouped into bounded
maintenance nominations. Nomination rows contain only provider, harness,
source kind, native item kind, counts, and timestamps; they are not schema
authority and are never used for normal retrieval.
Each successful source batch has an immutable content-addressed source receipt
under `receipts/sources/`. It binds the redacted source hash, event-batch hash,
recipes, normalized/opaque/redacted/omitted/loss-only disposition counts,
semantic-loss counts, partial-tail state, active-source authority version, and
event/conversation projection hashes.
Receipt hashes are deterministic: identical source bytes and recipes return the
same hash; a recipe change writes a new batch, receipt, and projection without
mutating the old objects. Inspect aggregate evidence without transcript text:

```sh
bun run src/cli.ts receipts sources 20
bun run src/cli.ts receipts nominations
```

```sh
bun run ingest
bun run derive
bun run refine
bun run adjudication:packet
bun run adjudication:verify -- <packet.json> <completed-answers.json>
# Resource-gated local Ollama job; do not run concurrently with other GPU work:
bun run judge:refinery
bun run query search 'phrase AND another' 20
bun run query semantic 'meaning of the problem' 10 40
bun run query get <session-id-or-hash> [turn-index]
bun run query grok 'topic' 10
bun run query ask 'what did I try last time for X' 10
bun run query ask-lexical 'what did I try last time for X' 10
bun run query project /exact/project/path
bun run query orchestration-profile
bun run query refinery [skill|gotcha-skill|memory-or-adr|claude-md|wiki-page-later] [limit]
bun run query candidate <candidate-id>
bun run query eval-plan <candidate-id>
bun run query stats
bun run query models
bun run query tokens
bun run query usage-time month 30
bun run query tools 30
bun run query lengths
bun run src/cli.ts bridge emit-pi <conversation-hash> summary
bun run src/cli.ts bridge emit-pi <conversation-hash> history
```

The query surface is deliberately hybrid. SQLite FTS5 owns ranked full-text
retrieval and bounded snippets. The packaged DuckDB binary scans the
content-addressed derived JSON objects directly for columnar token,
time-series, model, project, and tool rollups. No duplicate analytics load
table is required.

`current_token_usage` keeps provider-reported totals intact while exposing
`non_cached_tokens`, `cache_read_tokens`, and `cache_write_tokens` separately.
For Codex, cached input is a subset of input and is subtracted for the
non-cached measure; Claude Code and pi report their cache fields separately.

Agent-facing discovery commands return bounded snippets, derived structure, and
`chatlog://conversation/<hash>/turn/<index>` pointers. `get` is the explicit
on-demand CLI boundary for a full conversation or a single turn. MCP applies a
stricter one-turn, 12,000-character evidence boundary. See
`docs/mcp-tool-shape.md` for its implemented contract.

`semantic` and `ask` retrieve candidates locally with FTS5, then ask a hosted
GPT or Claude model to rerank those snippets by meaning. Hosted reranking is
disabled unless `CHATLOG_ALLOW_EGRESS=1` is set for that invocation;
`ask-lexical` preserves the zero-egress form. Reranking sends only a redacted
query plus opaque candidate IDs and at most 600 redacted characters per
user/assistant snippet, with 50 candidates maximum. It excludes
session/conversation IDs, project paths, timestamps, full turns, tool-role
output, tool arguments/results, and token usage. Every JSON result reports the
exact egress surface and whether a hosted call occurred.

Set `CHATLOG_ALLOW_EGRESS=1`, select
`CHATLOG_RERANK_PROVIDER=openrouter|openai|anthropic`, and optionally set
`CHATLOG_RERANK_MODEL`. Providers use only their standard API-key environment
variables; Chatlog does not search other harness credential stores. Responses
are cached under a hash of the redacted query, exact candidates, provider,
model, and rerank recipe; identical calls perform no further egress.
OpenRouter defaults to the paid `openai/gpt-4.1-mini` route; set
`CHATLOG_RERANK_MODEL` to pin another GPT or Claude model.

`derive` writes deterministic structural artifacts beneath `derived/objects`
and a mode-0600 manifest keyed by conversation hash. A second run skips every
unchanged hash. The derivation recipe itself is hashed, so implementation drift
causes an intentional rebuild rather than stale mixed-version artifacts.
Ingest likewise records a redaction-recipe version and re-adapts unchanged
source files when that security boundary changes.

## Orchestration lean

`query orchestration-profile` mines operator-authored turns for autonomy grants
and deterministic guardrails, then emits one content-addressed decision-boundary
artifact beneath `derived/orchestration-lean/`. The report is not a scalar: it
states when bounded autonomy is granted and when ownership, frozen intent,
acceptance gates, or escalation conditions impose determinism. Every inventory
claim carries resolvable `chatlog://` evidence.

The default command is entirely local and declares `egress.surface: "none"`.
It also reports calibration agreement against the checked-in hand labels and
held-out accuracy versus base rate. Slice 2 adds a separately content-addressed
per-role projection to the same command. Roles are inferred from explicit launch
prompts and embedded skill/Herdr labels, with delegation, mutation, and research
tool shape as supporting signals; project and harness remain provenance rather
than hardcoded role mappings. The report publishes the labelled-sample confusion
rows, per-role decision boundaries, and a distinguishability test using Wilson
95% intervals.

Slice 3 consumes the role artifact plus an `agent-eval/promotion-v1` result and
runs the existing external scorer to rank a concrete role pattern against its
control. The default query only replays local metrics and performs no hosted
call. The checked-in synthetic worker fixture and evaluation-only treatment are
under `eval/`; measured traces/results remain in ignored `analysis/`.

The valid bounded pilot used exactly three control/treatment pairs (six
sequential hosted calls), with no corpus text or source-project data in its
egress. One earlier six-call preflight was discarded because treatment
consumption was not observed, so Slice 3 declares twelve hosted calls in total.
A larger replay is deliberately not wired to the query and remains
operator-gated. No
artifact promotes configuration or emits model-routing names. Re-running on an
unchanged role projection, experiment, external scorer, and recipe returns
identical content hashes.

## Knowledge refinery

`refine` mines the redacted structural artifacts for patterns repeated in at
least three distinct logical sessions. It emits typed, content-addressed
**curation candidates**, never promoted knowledge:

- successful recurring procedure -> existing `write-a-skill` workflow;
- recurring landmine -> the same workflow, as a gotcha-oriented skill;
- recurring fact or decision -> existing `writing-memory-entries` workflow,
  with an ADR preferred when the decision itself is authoritative;
- repeatedly re-supplied task context -> nearest authoritative `CLAUDE.md`;
- stable external reference lookup -> a deferred reference-wiki follow-up.

Frequency is only a nomination signal. Each candidate includes diverse session
evidence, stable turn pointers, rejection checks, and an unmeasured paired
`agent-eval/promotion-v1` plan. Evaluation remains explicitly ineligible until
a curator accepts and installs the item through its intended existing channel.
Then compare at least three control/treatment runs from the same clean commit,
measuring gate pass, tokens/time to gate, interventions, and explicit
re-derivation. Keep what measurably helps; revise or remove what does not.

The refinery has no accept, install, or promote command. It does not write
skills, memory, ADRs, `CLAUDE.md`, or wiki pages. See
`docs/knowledge-refinery.md` for the curation and measurement contract.

The optional semantic judge fails closed on malformed output and emits separate
`promotionReview`, `manualReview`, `rejected`, and `unjudged` buckets. `mixed`
always requires a human; `genuine` reaches promotion review only when the
selected evidence itself spans the refinery session threshold. Judged rows
contain support derived from selected evidence only—never the lexical miner's
frequency and never a fallback to unselected pointers.

`bun run adjudication:packet` builds a deterministic, local-only 30-candidate
human review packet beneath ignored `derived/adjudication/refinery/`. The
trusted-local-only public bundle uses shuffled
candidate/evidence/session/project/harness aliases and contains no model
answers or structural source IDs. The reversible mode-0600 manifest lives in
the separate `derived/adjudication/refinery-private/` tree; do not open or copy
it into the adjudicator's bundle. Validate completed labels with
`bun run adjudication:verify -- <packet.json> <answers.json>` before treating
them as gold.

## Provider-agnostic context plane

Chatlog keeps provider history, derived memory, and agent delivery behind
separate authority boundaries:

```mermaid
flowchart LR
  P[Provider records] --> A[Source adapters]
  A --> E[Canonical redacted events]
  E --> V[Evidence projections]
  V --> L[Governed insight ledger]
  L --> C[Context candidates]
  C --> R[Release gate]
  R --> D[Provider delivery adapter]
  D --> O[Feedback and outcomes]
  O --> E
```

Canonical events and immutable insight ledgers remain authoritative. Context
bundles, startup text, MCP results, and prompt artifacts are replaceable views.
Delivery adapters only encode a selected bundle. They cannot accept evidence,
promote an insight, widen scope, or increase a budget.

A context session pins the provider, harness, model, role, project, domains,
working directory, path, source projections, policy versions, and total budget.
Reusing a native session ID reuses those pins and the remaining budget. A later
open with the same native ID must match its provider, harness, model, role,
project, working directory, domains, and path; a mismatch is rejected rather
than creating a fresh budget or pin set. Omitting that ID creates a new
anonymous session, even when all other inputs match.
The `chatlog_context` MCP tool requires the `contextSessionId` issued by the
startup hook; it cannot open or rebind a session. Durable storage accepts at
most 1,024 context sessions.
At that cap, Chatlog reclaims only sessions with no durable activity, context
events, or recall-result artifacts. It fails closed when every session has
durable state.

The delivery lifecycle is:

1. `context start` pins a session to current evidence and insight projections.
2. `context prepare` selects, budgets, and renders candidates without live delivery.
3. `context authorize` stores a verified release gate.
4. `context confirm` records the receipt and charges the rendered token count.
5. `context feedback` and `context outcome` link observations to intervention events.

`context deliver` combines start, prepare, and confirm for one candidate under
the current authorized gate. It fails closed when the gate, scope, source
projection, policy, or budget changed. An emission receipt proves only that
Chatlog returned an artifact through the named surface. It does not prove that
a model used it.

Claude Code and Codex support startup hooks, tool recall, and fresh-session
prompts. OMP and Pi support fresh-session prompt artifacts. The generic
prompt-bundle adapter supports any named provider and harness. No current
adapter claims provider acknowledgment.

Bounded recall runs inside one context session. Every branch receives a smaller
child budget and all branches share the parent totals. The result records
evidence references, contradictions, omissions, branch failures, query lineage,
novelty, stability, consumed budget, and one stop reason. Concurrent finalization
spends a deterministic recall result once and publishes success only after the
session budget commit succeeds.
A context session accepts at most 256 distinct recall invocations. An exact
retry does not spend the budget again. If a result becomes durable before its
session debit, the retry recovers that result instead of rerunning adapters.

Use `chatlog_context` for a governed MCP delivery. Pass its
`contextSessionId` to `chatlog_bounded_recall`. See
[`docs/mcp-tool-shape.md`](docs/mcp-tool-shape.md#context-sessions-and-bounded-recall)
for input limits, adapter modes, receipt meaning, and CLI examples.

## Governed insight lifecycle

The v2 insight ledger is the only publication authority after migration.
Immutable snapshots live under `memory/insight-ledgers/`.
`memory/insight-current.json` binds the current snapshot to active source evidence.
SQLite insight tables are rebuildable projections, not authority.

Use these explicit commands:

```sh
chatlog insight migrate              # Preview the v1-to-v2 migration.
chatlog insight migrate --apply      # Write the v2 migration.
chatlog insight preview              # Propose deterministic lifecycle changes.
chatlog insight apply <command.json> # Apply one authorized transition.
chatlog insight current              # Read the current active projection.
chatlog insight current --history    # Include immutable transition history.
chatlog insight recompile            # Rebind after a verified source-authority change.
```

Reads fail closed after source authority or event evidence changes.
Run `chatlog insight recompile` only after you verify the new active evidence.
The command rebuilds compiled context and SQLite projections.
It does not add a lifecycle transition.

## Cross-harness handoff spike

`bridge emit-pi` is an experimental, content-addressed target emitter. `summary`
creates the recommended one-message, pointer-rich handoff; `history` reconstructs
a lossy Pi v3 message history. Both re-redact output, exclude source
system/developer policy, and keep historical tool activity inert. They write
only beneath this repository's ignored `bridge/` tree unless an explicit output
path is given; they never register or modify a live harness session.

This is reconstruction, not native cross-harness resume. See
`docs/cross-harness-continuity-findings.md` and the corresponding design spec.

## Adapter seam

New sources implement `SourceAdapter.discover()` and `SourceAdapter.adapt()` and
return an `EventBatch`. Adapters explicitly enumerate accepted record and
content-block kinds; an unknown shape becomes redacted opaque evidence or an
explicit semantic-loss entry, while malformed input fails closed with its
source path and position. Provider and harness strings stay open, while event
kinds and relation names are closed and runtime validated.

ChatGPT exports and generic JSONL are connected, explicit local sources:

```sh
chatlog preview chatgpt /path/to/chatgpt-export.zip personal
chatlog import chatgpt /path/to/chatgpt-export.zip personal
chatlog preview generic /path/to/chatlog-events.jsonl coding
chatlog import generic /path/to/chatlog-events.jsonl coding
```

The ChatGPT adapter preserves the declared parent graph and alternate
branches; the generic adapter accepts only the versioned
`chatlog/generic-events-v1` header plus validated observed event envelopes.
See [docs/workbench.md](docs/workbench.md#chatgpt-export-graph) for source
configuration, aggregate preview, receipts, and privacy boundaries.
