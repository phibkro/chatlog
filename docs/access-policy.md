# Conversation-domain access policy

Redaction and authorization solve different problems. Redaction removes known
secret shapes; it does not make personal prose appropriate for every coding
agent.

Chatlog therefore records a provenance domain on each conversation and applies
an allow-list at agent retrieval boundaries.

## Default policy

| Surface          | Default domains                          | Reason                                                        |
| ---------------- | ---------------------------------------- | ------------------------------------------------------------- |
| Workbench        | all locally indexed domains              | Human-controlled evidence viewer                              |
| Existing CLI     | unchanged                                | Backward compatibility; operator invokes it directly          |
| MCP              | `coding`                                 | Safe default for autonomous coding agents                     |
| Hosted reranking | disabled unless `CHATLOG_ALLOW_EGRESS=1` | Bounded redacted egress requires per-invocation authorization |

The MCP server reads `CHATLOG_MCP_DOMAINS` as a comma-separated allow-list.
Unset or empty selects `coding`.

Examples:

```sh
CHATLOG_MCP_DOMAINS=coding chatlog-mcp
CHATLOG_MCP_DOMAINS=coding,research chatlog-mcp
```

`*` is intentionally invalid. Broad access must enumerate its domains so a new
domain cannot silently become visible after an import.

## Enforcement

- Apply allowed domains in the database query before ranking and limiting.
- Recheck the canonical conversation domain when resolving evidence.
- Treat legacy conversations without domain metadata as `coding`.
- Report the active policy in every tool result.
- Never treat project, provider, harness, or model as authorization.
- Never infer permission from the query text.
- Do not let a source configuration file widen a running MCP server's policy.
- Refuse current-data and evidence queries when the corpus manifest and active
  SQLite projection do not carry the same canonical source-map hash.

An MCP caller can ask for a narrower subset of its configured domains but
cannot request a wider one.

## Personal exports and new source adapters

Anthropic and ChatGPT exports normally enter `personal`, `ideas`, or
`research`, not `coding`, unless the operator deliberately labels the source
otherwise. The default MCP allow-list remains `coding`; importing a personal
export does not widen it. A source configuration cannot widen a running MCP
server's policy.

ChatGPT preview and generic event preview are non-destructive aggregate reads.
Explicit imports write only redacted, content-addressed canonical events and
active-source/source receipts. ChatGPT graph imports retain alternate branches
and declared parent relations without selecting a branch by order or time.
Attachment metadata may be retained, but attachment bodies, account memories,
custom instructions, projects, and provider files are outside this schema.

Generic JSONL is accepted only when its first record is the versioned
`chatlog/generic-events-v1` producer header and every following record is a
validated observed Chatlog event or bounded batch. Arbitrary provider JSONL,
Chatlog-derived origins, conflicting provenance, and unsupported versions fail
closed. Workbench exposes source metadata and receipt summaries read-only; it
does not expose a mutating HTTP import endpoint.

Import receipts describe what was indexed using aggregate counts, policy and
hashes only. They never grant a domain access permission or authorize hosted
egress.

## Lifecycle requirements

Before source lifecycle mutation is exposed, Chatlog must support:

- selective import and deletion by source;
- domain reassignment with re-indexing;
- local-first topic clustering.

Hosted agents should inspect real personal content only after an explicit
per-task decision. Synthetic fixtures are sufficient for implementation and
review of importers and access policy.
