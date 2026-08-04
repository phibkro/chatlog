# MCP tool shape: agent-facing chatlog memory

The MCP server uses newline-delimited JSON-RPC 2.0 over stdio. It opens no
socket, performs no hosted calls, and writes only protocol messages to stdout.
Run it with `bun run mcp`.

The boundary defaults to the `coding` domain. Access to another domain requires
an explicit `CHATLOG_MCP_DOMAINS` value.

The server enforces these input limits:

| Input                                                        |            Limit |
| ------------------------------------------------------------ | ---------------: |
| JSON-RPC request line                                        |          256 KiB |
| Query                                                        | 1,000 characters |
| Task                                                         | 4,000 characters |
| Project, working directory, or scope path                    | 4,096 characters |
| Provider, harness, model, role, session ID, or invocation ID |   256 characters |
| Evidence URI                                                 |   512 characters |
| Domain                                                       |   128 characters |
| Domain list                                                  |         32 items |

`MCP_MAX_LINE_BYTES` and `MCP_TEXT_MAXIMUMS` enforce these limits.
`test/mcp.test.ts` covers the runtime limits.

## Implemented tools

| Tool                     | Input                               | Default output                                                                  |
| ------------------------ | ----------------------------------- | ------------------------------------------------------------------------------- |
| `chatlog_search`         | `{query, limit?, domains?}`         | Up to 8 ranked snippets with metadata and `chatlog://` pointers                 |
| `chatlog_get_evidence`   | `{uri, domains?}`                   | One canonical redacted turn, bounded to 12,000 characters                       |
| `chatlog_recent_work`    | `{project, limit?, domains?}`       | Up to 8 recent policy-visible sessions for one exact project                    |
| `chatlog_project_brief`  | `{project, domains?}`               | Bounded project activity, outcomes, problems, and decision evidence             |
| `chatlog_context`        | `{contextSessionId, task, query}`   | One governed context delivery with a context session and delivery receipt       |
| `chatlog_bounded_recall` | `{contextSessionId, query, budget}` | One consolidated result with evidence references, budget trace, and stop reason |

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

## Context sessions and bounded recall

### Authority and lifecycle

Canonical redacted events are the evidence source. The governed insight ledger
is the publication source. A context bundle is only a delivery view.

`chatlog_context` requires a current, verified release gate for one candidate.
It then performs these steps:

1. Load the hook-opened session and verify its pinned evidence and insight projections.
2. Select the authorized candidate for the exact task and scope.
3. Render it with the matching provider adapter.
4. Return it as an MCP tool result.
5. Record the intervention event and spend the session budget.

A session pins its provider, harness, model, role, project, domain policy,
canonical working directory, path, projection versions, and total budget at
startup. `chatlog_context` accepts only the hook-issued `contextSessionId`. It
loads all identity, scope, policy, and budget fields from that stored session.
The caller supplies only the current task and query.

An explicitly constructed core session may retain `path: null`. This is a
neutral path dimension. It admits only path-neutral evidence, never all paths.
When a scoped query matches either `cwd` or `source_path`, the returned item
scope records the canonical stored path that matched.

The MCP tool cannot create a session, replace startup pins, or mint a new
budget. Session files are private JSON addressed by session ID under
`memory/context-sessions/`.

Example MCP input:

```json
{
  "contextSessionId": "<hook-issued 64-character lowercase hash>",
  "task": "Repair router lock contention",
  "query": "router lock custody"
}
```

The result includes `content`, `contextSessionId`, `bundleHash`, `gateHash`,
`itemId`, and the canonical delivery event. Use the event's `itemId` for later
attribution.

### Provider delivery adapters

| Adapter       | Supported modes                                  | Accepted receipt evidence                 |
| ------------- | ------------------------------------------------ | ----------------------------------------- |
| Claude Code   | startup hook, tool recall, fresh-session prompt  | hook output, tool result, prompt artifact |
| Codex         | startup hook, tool recall, fresh-session prompt  | hook output, tool result, prompt artifact |
| OMP           | fresh-session prompt                             | prompt artifact                           |
| Pi            | fresh-session prompt                             | prompt artifact                           |
| Prompt bundle | prompt bundle for any named provider and harness | prompt artifact                           |

`chatlog_context` uses `tool-recall` mode with `tool-result` evidence. Therefore,
its current live targets are Claude Code and Codex. Use the CLI delivery path
for OMP, Pi, and generic prompt artifacts.

A receipt proves that Chatlog exposed the encoded context through that surface.
It does not prove that the provider read, retained, or acted on the content.
No current adapter accepts `provider-acknowledgment`.

Planning uses candidate token estimates. Confirmed delivery charges the
adapter's rendered token estimate. This includes wrapper text and evidence
references. A rendered payload that exceeds the remaining session budget fails.

### Bounded recall contract

`chatlog_bounded_recall` accepts only a live parent `contextSessionId`. The
requested scope comes from that session. A caller cannot widen it.
A context session stores at most 256 distinct recall invocations. An exact
retry keeps the first semantic result and does not spend the budget again. A
retry also recovers a result that became durable before its session debit; it
does not rerun recall adapters.

Each child receives a smaller `maxDepth`. All children share the other parent
totals. A branch cannot return more results, tokens, latency, or cost than its
reservation. All branch fibers finish or cancel before the parent returns.

The request budget requires these fields:

| Field          | MCP maximum |
| -------------- | ----------: |
| `maxDepth`     |           4 |
| `maxBranches`  |           5 |
| `maxQueries`   |          10 |
| `maxResults`   |          20 |
| `maxTokens`    |      12,000 |
| `maxLatencyMs` |       5,000 |
| `maxCostUsd`   |           0 |

Example recall input:

```json
{
  "contextSessionId": "<64-character lowercase hash>",
  "query": "router lock custody",
  "budget": {
    "maxDepth": 2,
    "maxBranches": 3,
    "maxQueries": 4,
    "maxResults": 8,
    "maxTokens": 2000,
    "maxLatencyMs": 500,
    "maxCostUsd": 0
  }
}
```

The result separates evidence, insights, procedures, contradictions, and
unresolved claims. Evidence items contain immutable references. They do not
contain complete transcripts or executable tool results.

The trace records:

- consumed and remaining budget;
- branch failures and cancellations;
- query lineage and cycle detection;
- novelty and stability hashes;
- disagreements and omissions;
- one explicit termination reason.

| Termination reason         | Meaning                                                                         |
| -------------------------- | ------------------------------------------------------------------------------- |
| `sufficient-evidence`      | The minimum evidence contract is met with novel evidence.                       |
| `stable-result`            | Another round would repeat the same result.                                     |
| `no-novelty`               | No branch added usable new information.                                         |
| `budget-exhausted`         | A hard depth, branch, query, result, token, time, or cost limit stopped recall. |
| `timeout`                  | The recall deadline expired.                                                    |
| `unresolved-contradiction` | Supported claims still conflict.                                                |
| `cancelled-parent`         | The caller cancelled the parent operation.                                      |
| `scope-closed`             | The caller closed the permitted scope.                                          |

Chatlog records branch start, completion, failure, cancellation, termination,
and return events. `context.recall.returned` is written last. It is not
published when the session budget is stale. Identical concurrent results spend
their result hash once.

The current MCP recall adapter uses local SQLite FTS5. It performs no provider
call. Future provider branches must obey the same scope and budget contract.

### Feedback, outcomes, procedures, and advice

Use `context.feedback.asserted` for direct reactions. Allowed signals are
`helpful`, `harmful`, `stale`, `mis-scoped`, `irrelevant`, and `incorrect`.
Link feedback to the delivery or recall intervention event.

Use `context.outcome.observed` for later task evidence. Evidence grades are
`gate-observed`, `provider-observed`, `human-asserted`, `heuristic`, and
`agent-self-report`. Treatment arms distinguish no memory, raw evidence, active
insight, insight plus procedure, and reflective model.

Outcome rows preserve intervention lineage and mark the association as
observational. They do not make a causal claim. A gate-observed success cannot
use only agent self-report.

Procedure references include triggers, preconditions, actions, success and
failure observations, required authority, and evidence hashes. The transfer
evaluator compares no-memory, evidence-only, and procedure arms across at least
two tasks and a provider or harness boundary. It returns `keep`, `adapt`, or
`reject`; it does not promote a procedure.

Advisor evaluation is an internal shadow-only interface. It can annotate,
recommend reconsideration, or request escalation. It cannot block, mutate,
invoke tools, supervise another advisor, deploy, commit, or change policy.

### CLI equivalents

The one-step delivery path requires the same current release gate:

```sh
bun run src/cli.ts context deliver /path/to/context-delivery.json
bun run src/cli.ts context recall /path/to/recall-request.json
bun run src/cli.ts context events <context-session-id>
bun run src/cli.ts context list
```

Advanced operators can use the explicit lifecycle:

```sh
bun run src/cli.ts context start /path/to/session.json
bun run src/cli.ts context prepare /path/to/request.json
bun run src/cli.ts context authorize /path/to/gate.json
bun run src/cli.ts context confirm /path/to/prepared.json <gate-hash> tool-result /path/to/receipt.json
bun run src/cli.ts context feedback /path/to/feedback.json
bun run src/cli.ts context outcome /path/to/outcome.json
```

`prepare` and `authorize` do not prove live delivery. `confirm` requires receipt
evidence supported by the selected adapter. `context events` is the audit view
for the complete session lineage.

## Deferred CLI parity

The local CLI already provides the following larger query surface. These tools
remain deferred until their authorization and bounding behavior is specified
as tightly as the Wave 1 tools.

| Candidate tool            | Input                              | Existing CLI behavior                                                                    |
| ------------------------- | ---------------------------------- | ---------------------------------------------------------------------------------------- |
| `chatlog_semantic_search` | `{query, limit?, candidateLimit?}` | Local FTS candidates reranked by meaning, with scores, pointers and egress receipt       |
| `chatlog_grok`            | `{topic, limit?}`                  | Problems, decisions, tool profile, attempts, gates and outcomes for matching sessions    |
| `chatlog_project`         | `{path}`                           | Timespan, session/token/model effort, outcomes, recurring problems and decision pointers |
| `chatlog_ask`             | `{question, limit?}`               | Hosted semantic rerank followed by chronological prior attempts and resolutions          |
| `chatlog_ask_lexical`     | `{question, limit?}`               | Zero-egress lexical prior-attempt query                                                  |
| `chatlog_derive`          | `{}`                               | Incremental derivation counts (`processed`, `skipped`, recipe drift)                     |
| `chatlog_refinery`        | `{type?, limit?}`                  | Typed rule-of-three nominations, frequency, routes, and evidence pointers                |
| `chatlog_candidate`       | `{id}`                             | One candidate's bounded evidence, curation checks, and evaluation contract               |
| `chatlog_eval_plan`       | `{id}`                             | Ineligible-until-curated paired evaluation shape for `agent-eval`                        |

Discovery tools never return complete turn bodies. Their snippets are bounded
and secret-redacted, and search considers only user and assistant turns. Tool
role output and tool-call arguments/results are excluded. Every evidence item
carries a stable URI:

```text
chatlog://conversation/<contentHash>/turn/<zero-based-index>
```

Only `chatlog_get_evidence` crosses the snippet boundary in Wave 1, and it
resolves one current, policy-visible user or assistant turn rather than a
complete conversation. Superseded objects, domain mismatches, and tool-turn
pointers are denied uniformly. Agents should search first and follow pointers
second. This treats the context window as RAM rather than archive storage.

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
