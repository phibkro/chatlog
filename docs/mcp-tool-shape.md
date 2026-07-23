# MCP tool shape: agent-facing chatlog memory

Wave 1 implementation is governed by
[`docs/exec-plans/active/0001-product-foundation.md`](exec-plans/active/0001-product-foundation.md)
and [`docs/access-policy.md`](access-policy.md). The MCP boundary defaults to
the `coding` conversation domain and local lexical retrieval.

The Wave 1 MCP server is implemented over newline-delimited JSON-RPC 2.0 stdio.
It opens no socket, performs no hosted calls, and writes only protocol messages
to stdout. Run it with `bun run mcp`.

## Implemented tools

| Tool | Input | Default output |
|---|---|---|
| `chatlog_search` | `{query, limit?, domains?}` | Up to 8 ranked turn snippets, session metadata, policy receipt, `chatlog://` turn pointers |
| `chatlog_get_evidence` | `{uri, domains?}` | One canonical redacted turn, policy receipt, bounded to 12,000 text characters |
| `chatlog_recent_work` | `{project, limit?, domains?}` | Up to 8 recent policy-visible sessions for an exact project path |
| `chatlog_project_brief` | `{project, domains?}` | Bounded project activity, outcomes, problems, and decision evidence |

The process configuration is suitable for any MCP client that accepts a command,
arguments, and environment:

```json
{
  "command": "bun",
  "args": ["run", "/absolute/path/to/chatlog/src/mcp/server.ts"],
  "env": {
    "CHATLOG_DATA_ROOT": "/absolute/path/to/chatlog",
    "CHATLOG_MCP_DOMAINS": "coding"
  }
}
```

## Deferred CLI parity

The local CLI already provides the following larger query surface. These tools
remain deferred until their authorization and bounding behavior is specified
as tightly as the Wave 1 tools.

| Candidate tool | Input | Existing CLI behavior |
|---|---|---|
| `chatlog_semantic_search` | `{query, limit?, candidateLimit?}` | Local FTS candidates reranked by meaning, with scores, pointers and egress receipt |
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

Only `chatlog_get_evidence` crosses the snippet boundary in Wave 1, and it
resolves one turn rather than a complete conversation. Agents should search
first and follow pointers second. This treats the context window as RAM rather
than archive storage.

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

MCP search and session rollups are backed by SQLite FTS5 and policy-filtered
SQL. The implemented MCP server invokes no external process. Larger CLI
analytical fields are computed by DuckDB directly over
`derived/objects/*/*.json`, invoked through the sanctioned Nix shell in offline
mode rather than a project dependency.

Refinery tools are read-only. They deliberately expose no acceptance or
promotion operation: accepted knowledge must pass through the existing
skill/memory/ADR/`CLAUDE.md` discipline, where its authoritative home and scope
can be reviewed. The reference-wiki tool is intentionally absent and deferred.
