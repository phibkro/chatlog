# Conversation-domain access policy

Redaction and authorization solve different problems. Redaction removes known
secret shapes; it does not make personal prose appropriate for every coding
agent.

Chatlog therefore records a provenance domain on each conversation and applies
an allow-list at agent retrieval boundaries.

## Default policy

| Surface | Default domains | Reason |
| --- | --- | --- |
| Workbench | all locally indexed domains | Human-controlled evidence viewer |
| Existing CLI | unchanged | Backward compatibility; operator invokes it directly |
| MCP | `coding` | Safe default for autonomous coding agents |
| Hosted reranking | existing explicit opt-in contract | Bounded redacted egress |

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

An MCP caller can ask for a narrower subset of its configured domains but
cannot request a wider one.

## Personal exports

Anthropic and ChatGPT exports should normally enter `personal`, `ideas`, or
`research`, not `coding`, unless the operator deliberately labels the source
otherwise.

Before a personal export is available to agents, the product should support:

- import preview;
- selective import and deletion by source;
- domain reassignment with re-indexing;
- an audit receipt describing what was indexed;
- local-first topic clustering.

Hosted agents should inspect real personal content only after an explicit
per-task decision. Synthetic fixtures are sufficient for implementation and
review of the importer and access policy.
