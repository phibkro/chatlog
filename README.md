# Local chatlog corpus

Local-only, secret-redacted ingestion for Claude Code, Codex, and pi session logs.
Each source file is adapted into the canonical `Conversation` type in
`src/types.ts`, hashed after normalization/redaction, and written once beneath
`corpus/objects/<hash-prefix>/<sha256>.json`. Changed live sessions create a new
immutable object; the manifest makes unchanged reruns incremental and idempotent.

The source directories are only opened for discovery, stat, and streaming reads.
The tool never writes beneath `~/.claude`, `~/.codex`, or `~/.pi`. Corpus and
analysis files are mode 0600 inside mode 0700 directories and are gitignored.

```sh
bun run ingest
bun run derive
bun run query search 'phrase AND another' 20
bun run query semantic 'meaning of the problem' 10 40
bun run query get <session-id-or-hash> [turn-index]
bun run query grok 'topic' 10
bun run query ask 'what did I try last time for X' 10
bun run query ask-lexical 'what did I try last time for X' 10
bun run query project /exact/project/path
bun run query stats
bun run query models
bun run query tokens
bun run query usage-time month 30
bun run query tools 30
bun run query lengths
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
on-demand boundary for a full conversation or a single turn. See
`docs/mcp-tool-shape.md` for the matching future MCP contract.

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


## Adapter seam

New sources implement `SourceAdapter.discover()` and `SourceAdapter.adapt()` and
return the canonical schema. Adapters explicitly enumerate accepted record and
content-block kinds; an unknown shape aborts ingestion with its source path and
line number. Deferred web providers can be added here without changing corpus or
analysis code. No web adapter is implemented.
