# Cross-harness continuity spike: findings

Date: 2026-07-22. Scope: the installed Codex, Claude Code, and pi harnesses and
real local, secret-redacted corpus data. No network or hosted model call was
used. Source session directories were read only; the negative-control source
was copied to `/tmp` before another harness opened it.

## Result

There is no meaningful native cross-harness resume among Codex, Claude Code,
and pi. “Resume” is not a portable transcript operation: each harness restores
its own event/state model from its own storage namespace. A shared canonical IR
can reconstruct a useful target history where the target format is sufficiently
open (proved for pi), but that is lossy import, not native resume. A distilled
handoff injected into a fresh target session is the dependable all-pair fallback
and should be the product default.

## Tier 1: native resume

| Target | Resume entry point | Native state it expects | Foreign session result |
| --- | --- | --- | --- |
| Codex | `codex resume [SESSION_ID] [PROMPT]`, `--last`, `--all` | A rollout event stream beginning with Codex session metadata, then turn context, response items, event messages, world state, encrypted reasoning, function/custom calls and outputs, sandbox/approval state, and token events | No path import; ID/name resolution is against Codex's own rollout store. Claude/pi IDs and records do not provide the required state. |
| Claude Code | `claude --resume [id]`, `--continue`, optionally `--fork-session` | A UUID-linked record tree (`uuid`, `parentUuid`, `sessionId`) with Claude message blocks, request/prompt IDs, tool-use/result linkage, mode/permission data, file-history snapshots, attachments, and side metadata | Resume resolves Claude's project/session store. Codex/pi records lack the graph and Claude-specific message and snapshot state. |
| pi | `pi --continue`, `--resume`, `--session <path|id>`, `--fork` | A documented version-3 header followed by an `id`/`parentId` entry tree with typed messages, model changes, compactions, branch summaries, and custom state | Path import makes the incompatibility testable. Pi rejected a copied real Claude JSONL: `Session file is not a valid pi session`. |

All six cross-harness directions fail for the same structural reason, not just a
filename mismatch. The source harness's model-specific context is part of the
session semantics: tool calls/results have different encodings, branches and
compaction differ, reasoning may be opaque and replayable only by the originating
model/API, and the active sandbox/tool registry/policy is target-owned state.
Renaming a file or transplanting a UUID cannot reconstruct those invariants.

## Tier 2: canonical IR as bridge

### What maps

- source identity, harness, project/cwd, model label, timestamps;
- linear user and assistant text;
- redacted tool names and historical arguments/results where the adapter retained
  them;
- canonical conversation and turn pointers;
- enough provenance to label the content as imported historical data.

### What is lossy or must be discarded

| State | Treatment | Why |
| --- | --- | --- |
| Branch topology and abandoned branches | Canonical linearization | Current `Conversation` is linear. |
| Source system/developer instructions, approvals, sandbox, tool registry | Drop | They are stale target policy and can be unsafe if replayed as authority. |
| Reasoning/thinking | Drop | Codex may store encrypted reasoning; signatures and provider replay rules are model-specific. |
| Native tool-call continuation | Encode as inert historical text | A dangling or imperfectly paired call can trigger target tool protocol errors or accidental execution. Claude IR currently loses some exact result pairing. |
| Provider response/request IDs | Drop | Meaningful only to the source API/harness. |
| Tokens, cache, cost, context windows | Zero/non-authoritative in emitted Pi assistant records | Historical accounting is analysis data, not valid target runtime state. |
| Compaction/file snapshots/attachments/world state | Drop, point back to canonical data | Not represented portably by the current IR. |

Pi is the viable first emitter because its v3 format and loader are locally
documented and it accepts an explicit path. Codex and Claude target emitters are
not recommended: their stores are private/richer, their resume entry points do
not expose a supported import path, and verification would require writing into
live harness storage. Do not forge those stores.

### Real proof of concept

Source was a real 18-turn Claude Code session from the canonical corpus:

`chatlog://conversation/a79ae959468168ab29ff482f5dfda005ba2a90fc20b4ac1c1462f0b197bb10b8`

The history emitter produced:

- deterministic Pi session ID `45371c35-8fe0-555b-9ad7-f3d83b669630`;
- 6 coalesced user/assistant messages, 19,483 bytes;
- 5 historical tool calls flattened as inert text;
- output mode `0600`, SHA-256
  `85816602c36408095567478c283ff1fdda32b41aafc0cc545776ae04f354ceab`.

Pi was launched with `--mode rpc --offline --session <artifact>` and project
context/extensions/skills disabled. Its real `get_state` response returned the
same session ID and `messageCount: 6`; `get_messages` returned the reconstructed
alternating history through the source session's final assistant answer. The raw
Claude negative-control copy was rejected. This proves native target parsing and
context loading. It does not prove that a next hosted-model turn will behave
identically to the original harness, and no such equivalence should be claimed.

## Tier 3: summarize and inject

The same source emitted a fresh Pi v3 session containing one extractive handoff
message: original objective, classified outcome, decision/attempt/outcome
evidence, tool profile, latest user thread, and canonical turn pointers. It was
4,371 bytes, mode `0600`, with deterministic session ID
`b8bcdce6-1791-5e3a-962b-673f08bd99fa` and SHA-256
`585285bb6571e721ce27d7529f0af011111a24fa028e55bee9f63b7ff470b679`.
Pi's offline RPC loader returned that ID and `messageCount: 1`.

This loses verbatim conversational texture, exact ordering between intermediate
attempts, and unmined details. It gains a smaller context footprint, avoids
cross-provider message/tool protocol hazards, and explicitly tells the target to
validate current repository/runtime state. Because any harness can accept a new
user prompt, this approach generalizes to all source/target pairings without
touching private session stores.

## Recommendation

Build a first-class **handoff bundle**, not a universal “resume converter”:

1. default to a redacted, pointer-rich distilled handoff injected as the first
   user message of a fresh target session;
2. keep Pi history reconstruction experimental for cases where transcript
   fidelity matters and context budget permits;
3. add target launch adapters that use supported fresh-session CLI/API entry
   points, never write directly into live session directories;
4. require a receipt that names the source hash, derivation recipe, egress (none
   here), omissions, target, and verification level;
5. evaluate continuity quality on real tasks: recovered decisions/open threads,
   repeated work, gate pass, interventions, and tokens/time to gate.

The trust boundary is part of the feature: re-redact at emission, label imported
content as data rather than policy, keep tool history inert, and make full
content available only through canonical pointers on demand.
