# MCP tool shape: agent-facing chatlog memory

The CLI is the implemented contract. A future MCP server should expose the same
JSON shapes without adding provider or transport semantics. Web adapters remain
out of scope.

| Tool | Input | Default output |
|---|---|---|
| `chatlog_search` | `{query, limit?}` | Ranked turn snippets, session metadata, `chatlog://` turn pointers |
| `chatlog_semantic_search` | `{query, limit?, candidateLimit?}` | Local FTS candidates reranked by meaning, with scores, pointers and egress receipt |
| `chatlog_get` | `{sessionIdOrHash, turnIndex?}` | Full canonical conversation, or one requested turn |
| `chatlog_grok` | `{topic, limit?}` | Problems, decisions, tool profile, attempts, gates and outcomes for matching sessions |
| `chatlog_project` | `{path}` | Timespan, session/token/model effort, outcomes, recurring problems and decision pointers |
| `chatlog_ask` | `{question, limit?}` | Hosted semantic rerank followed by chronological prior attempts and resolutions |
| `chatlog_ask_lexical` | `{question, limit?}` | Zero-egress lexical prior-attempt query |
| `chatlog_derive` | `{}` | Incremental derivation counts (`processed`, `skipped`, recipe drift) |
| `chatlog_refinery` | `{type?, limit?}` | Typed rule-of-three nominations, frequency, routes, and evidence pointers |
| `chatlog_candidate` | `{id}` | One candidate's bounded evidence, curation checks, and evaluation contract |
| `chatlog_eval_plan` | `{id}` | Ineligible-until-curated paired evaluation shape for `agent-eval` |

Discovery tools never return complete turn bodies. Their snippets are bounded
and secret-redacted, and every evidence item carries a stable URI:

```text
chatlog://conversation/<contentHash>/turn/<zero-based-index>
```

Only `chatlog_get` crosses the full-text boundary. Agents should search or grok
first, follow pointers second, and pull a whole conversation only when its
structure proves relevant. This treats the context window as RAM rather than
archive storage.

Semantic tools have a narrow hosted egress boundary: the redacted query and up
to 50 opaque-ID candidate snippets, each redacted and capped at 600 characters.
Candidates are restricted to user/assistant turns. Conversation/session hashes,
project paths, timestamps, full turns, tool-role output, tool arguments/results,
and token metrics stay local. Results include provider/model, a content-addressed
request hash, cache status, character counts, and explicit sent/excluded field
lists. Candidate text is marked as untrusted data in the rerank prompt.

Derived artifacts are deterministic functions of canonical, already-redacted
conversation objects. The manifest keys them by conversation hash and records
the derivation recipe hash separately, so unchanged inputs skip cleanly while a
recipe change intentionally rebuilds all affected artifacts.

Search is backed by SQLite FTS5. Analytical fields in project and rollup tools
are computed by DuckDB directly over `derived/objects/*/*.json`, invoked through
the sanctioned Nix shell in offline mode rather than a project dependency.

Refinery tools are read-only. They deliberately expose no acceptance or
promotion operation: accepted knowledge must pass through the existing
skill/memory/ADR/`CLAUDE.md` discipline, where its authoritative home and scope
can be reviewed. The reference-wiki tool is intentionally absent and deferred.
