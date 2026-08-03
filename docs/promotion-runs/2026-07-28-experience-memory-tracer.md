# Promotion run: cross-harness experience-memory tracer

## Purpose

This run tested the delivery mechanism separately from the value of any one
memory. A five-card, provenance-bound snapshot was compiled into a succinct
startup index. Fresh Claude Code and Codex sessions received that index only at
startup and could recall a full card by exact snapshot hash and memory ID.

The run did not install the plugin globally or promote any card into a
persistent harness configuration.

## Published candidate snapshot

- snapshot:
  `9f065e2477944d0e832ba4793b17f4ce65a4947fd0e24e8eb93cbf086dc4df1f`
- accepted-ledger hash:
  `b039dfeabe21757f5f305269c895a6625051041ec55cec31b3d826213b5d561a`
- source packet:
  `470d83843ed9a2ce52f64e8bc9af5ad715b8405000a07f77dd70d081deab22af`
- proposal set:
  `46f57ae5500d5338a320b551f7dc806b9578aa7da70a3b1ea4e1a66d2df0b1c5`
- finalized operator review:
  `1a182e6579e772c91437aac7b2fed5ddfe04f6d892da17dcb65d41e0106dbd96`
- Tier 1 size: 1,588 bytes, conservatively estimated at 530 tokens
- target: at most 1,500 tokens; hard limit: 2,000 tokens

The accepted aliases were `C008`, `C009`, `C018`, `C023`, and `C030`.
Only their IDs, trigger summaries, scope, polarity, and actions appear in
Tier 1. Evidence text remains out of the startup prompt.

`C004` was deliberately excluded even though its semantic judgment was
correct. Its equivalent Nix source-visibility memory had already failed a
paired promotion run: control knew the rule, treatment removed no
re-derivation, and treatment added 31 median non-cached tokens.

## Semantic curation actually run

Two serialized hosted Fable 5, medium-effort batches reviewed the candidate
evidence. They were proposal generators, not an acceptance authority:

| Batch | Aliases | Session | API time | Cost | Result |
| --- | --- | --- | ---: | ---: | --- |
| 1 | C004, C009, C015, C017, C028 | `159a6ee4-0ae7-46f1-b4f3-ab0ab47163f9` | 70.805 s | $2.980731 | all determinate |
| 2 | C008, C018, C023, C030 | `db1f3356-b901-42f6-91de-c89dfb9ed148` | 60.639 s | $2.056846 | all determinate |

No strongest-model escalation ran because no row met the configured
uncertainty or inconsistency trigger. Acceptance additionally required the
finalized operator review, genuine evidence pointers, exact source hashes, and
prior promotion evidence.

## Fresh-session tracer

The relevant task asked for the next diagnostic step when a deployed web app
renders white despite passing local tests. It exercised
`deployed-bundle-differs-from-dev-tests`. The unrelated task asked for the
difference between SHA-256 and a UUID.

| Harness / arm | Session | Recall | Outcome | Usage evidence |
| --- | --- | --- | --- | --- |
| Claude treatment, relevant | `f7141782-005e-4072-bbac-bc487b81b100` | exact snapshot + ID | correct, applied card | cache create 35,187; cache read 105,934; output 1,132 |
| Claude treatment, unrelated | `e700d853-2093-4097-b3b3-311b17ffd297` | none | correct non-recall | cache create 27,352; cache read 17,930; output 163 |
| Claude control, relevant | `2b33b8fe-8173-4d05-9c35-f3a4eb9278a5` | unavailable | correct without memory | cache create 3,623; output 863 |
| Codex treatment, relevant | `019fa5cd-0c40-7961-8615-68706c9c3157` | exact snapshot + ID | correct, applied card | input 61,714; cached 38,400; output 312; reasoning 56 |
| Codex treatment, unrelated | `019fa5cd-9f6e-7c60-af57-da0711acbacd` | none | correct non-recall | input 17,732; output 36 |
| Codex control, relevant | control process receipt | unavailable | correct after repository re-derivation | input 278,941; cached 225,024; output 2,046; reasoning 458 |

Two Claude attempts were retired and are not counted:

- plan mode blocked recall and caused Claude's normal plan-file side effect;
- an over-narrow tool configuration made the recall tool unavailable.

## Interpretation

The delivery mechanism passes its structural tracer:

- startup context arrived in both harnesses;
- a relevant session recalled the exact startup-emitted snapshot and card;
- an unrelated session did not recall a card;
- Codex could recall the historical startup-emitted snapshot through MCP;
- the startup bundle stayed under its token target;
- no live transcript mutation was required.

The startup hook pins the index bytes for the session, while MCP recall is
content-addressed rather than session-authenticated: the model supplies the
startup-emitted hash and exact ID. The shared hook command supports Claude's
`${CLAUDE_PLUGIN_ROOT}` and Codex's `${PLUGIN_ROOT}` without forking memory
semantics.

The card's promotion case is not established. Codex control spent substantial
work rediscovering the production-bundle boundary, while Codex treatment used
the memory directly. Claude control, however, produced the same useful answer
without memory and at lower context cost. The cross-harness value result is
therefore mixed rather than a retention pass.

Disposition: **tracer pass; promotion not established**. Keep the snapshot as
a reproducible development artifact, do not install it globally, and test a
harder, less frontier-model-obvious card before promoting an always-on index.

## Verification

- full repository gate: 133 tests passed, 0 failed, 2,000 assertions;
- TypeScript checks passed for the repository and Foldkit workbench app;
- oxfmt, oxlint, the no-throw ratchet, production web build, and all configured
  Bun bundle checks passed;
- Claude's native plugin validator passed;
- the official Codex plugin validator passed in a PyYAML-enabled Nix shell;
- `git diff --check` passed;
- publication reverified exact proposal and finalized-review bytes plus the
  private alias-to-candidate mapping before compiling;
- the accepted ledger, current pointer, and content-addressed snapshot are
  private mode-0600 files under the ignored `memory/` store.
