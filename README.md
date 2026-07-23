# Local chatlog corpus

Local-only, secret-redacted ingestion for Claude Code, Codex, and pi session logs.
Each source file is adapted into the canonical `Conversation` type in
`src/types.ts`, hashed after normalization/redaction, and written once beneath
`corpus/objects/<hash-prefix>/<sha256>.json`. Changed live sessions create a new
immutable object; the manifest makes unchanged reruns incremental and idempotent.

The source directories are only opened for discovery, stat, and streaming reads.
The tool never writes beneath `~/.claude`, `~/.codex`, or `~/.pi`. Corpus and
analysis files are mode 0600 inside mode 0700 directories and are gitignored.

## Workbench

Chatlog Workbench turns the corpus into a local product for both the operator
and coding agents. It provides a project and session browser, full-text recall
with resolvable evidence, measured orchestration patterns, refinery candidates,
and a source-connection screen.

```sh
bun run ingest
bun run workbench
# open http://127.0.0.1:4789
```

The server binds to loopback, reads the existing corpus without mutating it, and
does not use hosted analytics. Set `CHATLOG_DATA_ROOT` when the data lives
outside this checkout. See [docs/workbench.md](docs/workbench.md) for source
configuration, the API, and privacy boundaries.

## Agent MCP

The local stdio MCP server gives coding agents bounded recall without exposing
the entire archive:

```sh
CHATLOG_DATA_ROOT=/path/to/chatlog \
CHATLOG_MCP_DOMAINS=coding \
bun run mcp
```

It implements local lexical search, one-turn evidence resolution, recent
project work, and bounded project briefs. It opens no network listener and makes
no hosted calls. The default domain policy is `coding`; `personal` and other
domains require explicit enumeration. See [docs/mcp-tool-shape.md](docs/mcp-tool-shape.md)
and [docs/access-policy.md](docs/access-policy.md).

## Deploy

```sh
nix build .#chatlog
nix run .#workbench   # or: nix run .#mcp
```

`nix flake check` evaluates the package and Home Manager module offline once
inputs are fetched. An opt-in, loopback-default `services.chatlog-workbench`
Home Manager module is available for running Workbench as a persistent user
service. See [docs/workbench.md](docs/workbench.md#package-and-deploy) for the
module options, systemd hardening, and the Tailscale Serve handoff for remote
access.

An Anthropic data export can be connected as an explicit, one-time import:

```sh
bun run import:anthropic -- /path/to/data-export.zip personal
```

The importer currently ingests `conversations.json`, including visible text and
tool activity. It intentionally excludes model thinking, token-budget metadata,
and extracted attachment bodies; attachment and file names are retained as
context. The source archive is never modified. Claude Projects, memories, and
design artifacts are left for separately reviewable adapters rather than folded
into conversations implicitly.

```sh
bun run ingest
bun run derive
bun run refine
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
retrieval and bounded snippets. DuckDB, invoked ad hoc through
`nix shell --offline nixpkgs#duckdb`, scans the content-addressed derived JSON
objects directly for columnar token, time-series, model, project, and tool rollups. No
DuckDB project dependency or duplicate analytics load table is required.

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
GPT or Claude model to rerank those snippets by meaning. `ask-lexical` preserves
the zero-egress form. Reranking sends only a redacted query plus opaque candidate
IDs and at most 600 redacted characters per user/assistant snippet, with 50
candidates maximum. It excludes session/conversation IDs, project paths,
timestamps, full turns, tool-role output, tool arguments/results, and token
usage. Every JSON result reports the exact egress surface and whether a hosted
call occurred.

Select `CHATLOG_RERANK_PROVIDER=openrouter|openai|anthropic` and optionally
`CHATLOG_RERANK_MODEL`. OpenAI and Anthropic use their standard API-key
environment variables. OpenRouter uses `OPENROUTER_API_KEY`, falling back to the
machine's existing pi OpenRouter credential. Responses are cached under a hash
of the redacted query, exact candidates, provider, model, and rerank recipe;
identical calls perform no further egress.
The OpenRouter fallback defaults to its zero-priced hosted GPT OSS 20B route;
set `CHATLOG_RERANK_MODEL` to pin another GPT or Claude model.

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
return the canonical schema. Adapters explicitly enumerate accepted record and
content-block kinds; an unknown shape aborts ingestion with its source path and
line number. The Anthropic export importer uses the same canonical corpus and
analysis boundary. A ChatGPT export adapter and a documented generic JSONL
contract are the next source types; neither is claimed as connected yet.
