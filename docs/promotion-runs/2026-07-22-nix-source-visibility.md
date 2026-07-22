# Promotion run: Nix flake source visibility

## Selection

Selected `55ca831116ba71fe2146` (recurring Nix flake source-visibility
procedure: 5 sessions, 3 projects, 2 harnesses) for curation. Candidate
`707c237feeef2547ca2f` supplied supporting dirty/untracked-input evidence but
was not forwarded independently because its sampled evidence was broader and
partly prompt-derived. Both signals were curated into one proposed skill.

The draft passed the `write-a-skill` shape review: concrete triggers and
exclusions, one self-contained SKILL.md under 120 lines, exact-path staging
rather than broad index mutation, and explicit separation from daemon/sandbox
and shared-index recovery. Its SHA-256 was
`470d0e67e55436ef4135b95ef72d76a6a5b805911ea12bb4efaec90c053427d3`.

High-frequency alternatives were not selected:

- worktree/index hygiene duplicates the installed `using-git-worktrees`
  skill, cross-project CLAUDE.md discipline, and existing corruption memories;
- lang-bang proof-wall candidates duplicate its ADR and proof discipline;
- generic build failure, timeout, missing-config, and stale-state clusters are
  themes, not sufficiently specific reusable knowledge;
- Nix daemon/sandbox evidence was dominated by permission-review transcripts;
- no stable external-reference cluster met the rule of three.

## Forwarded

Forwarded the exact artifact to `agent-eval/promotion-v1` on stacked branch
`chatlog-promotion-eval`, commit `4a65f25`. That commit contains the reusable
runner, synthetic fixture, exact treatment artifact, tests, and evaluation
report. It is stacked on the earlier promotion scorer commit `b6610a7` and does
not depend on merging unrelated live agent-eval work.

The experiment ran three alternated control/treatment pairs from one fixture
commit with Claude Sonnet 5. Only treatment received the artifact through the
project skill channel. Hosted egress contained the synthetic fixture/task and
candidate skill only—no chat corpus or real project content.

## Measurement and disposition

| Arm | Gate pass | Median non-cached tokens | Median wall time | Median re-derivations |
|---|---:|---:|---:|---:|
| Control | 3/3 | 637 | 15,413 ms | 0 |
| Treatment | 3/3 | 668 | 14,485 ms | 0 |

Treatment discovered the skill in all runs and explicitly invoked it in two of
three. Control already knew the Git-backed-flake visibility rule, so treatment
removed no re-derivation and cost 31 more median non-cached tokens. The scorer
returned `revise-or-cut`.

Disposition: **cut**. The homelab staging artifact was removed and nothing was
installed into skill, memory, ADR, or CLAUDE.md channels. The exact rejected
artifact remains only beside its synthetic agent-eval fixture so the result is
reproducible, not as an alternate knowledge store.
