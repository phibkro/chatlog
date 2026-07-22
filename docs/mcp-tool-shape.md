# MCP tool shape: agent-facing chatlog memory

The CLI is the implemented contract. A future MCP server should expose the same
JSON shapes without adding provider or transport semantics. Web adapters remain
out of scope.

| Tool | Input | Default output |
|---|---|---|
| `chatlog_search` | `{query, limit?}` | Ranked turn snippets, session metadata, `chatlog://` turn pointers |
| `chatlog_get` | `{sessionIdOrHash, turnIndex?}` | Full canonical conversation, or one requested turn |
| `chatlog_grok` | `{topic, limit?}` | Problems, decisions, tool profile, attempts, gates and outcomes for matching sessions |
| `chatlog_project` | `{path}` | Timespan, session/token/model effort, outcomes, recurring problems and decision pointers |
| `chatlog_ask` | `{question, limit?}` | Prior attempts and resolutions grouped by successful/failed/mixed outcome |
| `chatlog_derive` | `{}` | Incremental derivation counts (`processed`, `skipped`, recipe drift) |

Discovery tools never return complete turn bodies. Their snippets are bounded
and secret-redacted, and every evidence item carries a stable URI:

```text
chatlog://conversation/<contentHash>/turn/<zero-based-index>
```

Only `chatlog_get` crosses the full-text boundary. Agents should search or grok
first, follow pointers second, and pull a whole conversation only when its
structure proves relevant. This treats the context window as RAM rather than
archive storage.

Derived artifacts are deterministic functions of canonical, already-redacted
conversation objects. The manifest keys them by conversation hash and records
the derivation recipe hash separately, so unchanged inputs skip cleanly while a
recipe change intentionally rebuilds all affected artifacts.

Search is backed by SQLite FTS5. Analytical fields in project and rollup tools
are computed by DuckDB directly over `derived/objects/*/*.json`, invoked through
the sanctioned Nix shell in offline mode rather than a project dependency.
