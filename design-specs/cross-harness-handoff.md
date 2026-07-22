# Cross-harness handoff bundle

Status: proposed after a verified spike. The Pi emitter is an experimental PoC;
the broader launch surface is not yet approved as production behavior.

## Objective

Continue useful work across Codex, Claude Code, and pi without pretending their
private runtime sessions are interchangeable. Convert a content-addressed
canonical conversation into a minimal, secret-redacted handoff and start a
fresh target-native session through supported entry points. Preserve pointers
so an agent can pull exact turns only when needed.

## Non-goals

- byte- or state-equivalent native resume;
- reasoning trace, provider response ID, token/cache, sandbox, approval, or file
  snapshot migration;
- writing into `~/.codex`, `~/.claude`, or `~/.pi` behind a harness's back;
- replaying historical tool calls;
- web provider adapters.

## Interfaces

Separate target emission from the existing read-only `SourceAdapter`:

```ts
type HandoffMode = "summary" | "history";

interface TargetAdapter {
  readonly harness: Harness;
  emit(input: {
    conversationHash: string;
    mode: HandoffMode;
    destination?: string;
  }): Promise<HandoffReceipt>;
  launch?(receipt: HandoffReceipt): Promise<LaunchReceipt>;
}
```

`summary` is required for every target. It returns bounded structure: objective,
decisions, attempts/resolutions, outcome, open-thread candidates, and
`chatlog://` pointers. `history` is optional and target-specific. The current
CLI PoC is:

```text
chatlog bridge emit-pi <64-char-conversation-hash> [summary|history] [output]
```

The output JSON receipt includes the immutable source hash, deterministic target
artifact hash/session ID, message count, redaction flag, dropped-role counts,
flattened-tool count, and lossiness notes.

## Content addressing and recipes

An emitted artifact is a pure function of:

```text
(canonical conversation hash, derived artifact hash, target, mode,
 bridge schema version, bridge recipe hash)
```

Production artifacts belong under
`bridge/objects/<target>/<mode>/<prefix>/<artifact-hash>` with a manifest from
that tuple to artifact/receipt and `processedAt`. Unchanged tuples are skipped;
a recipe change generates a new artifact rather than mutating an old one. The
PoC already emits deterministic bytes but has not yet added this manifest.

## Safety invariants

- Re-run secret redaction immediately before serialization.
- Never serialize source paths, credentials, source system/developer messages,
  or source permission/sandbox instructions.
- Mark the bundle as untrusted historical context, not policy.
- Represent old tools as inert text/structure; never create executable or
  pending native tool calls unless exact target-valid pairing is proved.
- Write mode `0600` beneath a mode-`0700` directory.
- A launch adapter may pass a supported file/prompt to a harness, but may not
  edit its live session database/tree directly.
- A fresh target owns its model, system prompt, tools, permissions, cwd trust,
  and current-state validation.

## Target strategy

| Target | Default | Optional | Launch shape |
| --- | --- | --- | --- |
| pi | One user handoff message | Reconstructed v3 linear history | `pi --session <emitted-file>` for experimental import; fresh prompt preferred for production |
| Codex | Fresh-session prompt | None until a supported import API exists | `codex <handoff-prompt>` / supported exec surface |
| Claude Code | Fresh-session prompt | None until a supported import API exists | dispatched Claude fresh session with the handoff prompt; never forge `.jsonl` |

## Acceptance gates

1. Deterministic unit tests cover redaction, policy omission, inert tools,
   parent-chain validity, and bounded summaries.
2. Target-native loader accepts emitted artifacts where history mode exists.
3. A raw foreign-session negative control is rejected or yields no context.
4. Real-task paired evaluation compares fresh-without-handoff versus handoff:
   recovered decision/open-thread recall, duplicated exploration, gate pass,
   interventions, and tokens/time to gate.
5. Any target whose format/loader version changes must fail closed until its
   emitter contract is reverified.

## Next increment

Add a content-addressed bridge manifest and a target-neutral `handoff render`
command that returns JSON plus a bounded prompt. Then add fresh-session launch
wrappers one harness at a time, beginning with pi, with dry-run as the default.
Do not add Codex/Claude native-file emitters without a documented supported
import contract.
