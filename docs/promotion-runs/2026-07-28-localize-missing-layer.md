# Promotion run: localize the missing layer

## Selection and hypothesis

This run evaluated accepted candidate `C008`,
`localize-missing-layer-before-fix`, after the broader delivery tracer showed
that startup routing and exact recall worked.

Hypothesis: recalling the card would improve diagnosis or safe recovery when a
wrapper incorrectly reported an existing configuration file as missing.

The synthetic incident fixed the actual failure at a shared Git object
database: the file existed on disk, was tracked and clean, and its `HEAD` tree
entry resolved, but the referenced blob was missing from the common object
store used by two linked worktrees.

## Isolation

- Model: Claude Fable 5.
- Effort: medium.
- Three alternated control/treatment pairs.
- No repository, shell, browser, MCP, or other tools.
- Same response schema and incident evidence in both arms.
- Treatment differed only by the exact accepted C008 Tier 2 card.
- No real corpus or private evidence was sent.
- Re-derivation was zero in every retained run.

An initial instrumentation batch was retired before scoring because the runner
did not emit full per-run receipts before interruption and its mechanical
scorer penalized forbidden actions even when the model explicitly ruled them
out. The scenario and rubric were not changed. The retained three pairs emitted
full decisions and were manually checked against the frozen rubric.

## Frozen gate

A 10/10 response had to:

- identify the shared/common Git object database and exact missing
  `HEAD`-referenced blob;
- rule out disk, index, `HEAD` tree-entry, and worktree-local layers;
- preserve the current checkout/common repository state;
- use only hash-verified recovery material;
- verify repair with both `git cat-file` and `git fsck`;
- recommend no destructive or unverified action.

Retention required every treatment to pass without regression and improve at
least one outcome or efficiency measure.

## Results

| Pair   | Control score | Treatment score | Control wall | Treatment wall | Control output | Treatment output |
| ------ | ------------: | --------------: | -----------: | -------------: | -------------: | ---------------: |
| 1      |             8 |               9 |    28,206 ms |      40,738 ms |          2,016 |            2,178 |
| 2      |             8 |              10 |    30,427 ms |      25,411 ms |          2,235 |            1,885 |
| 3      |             9 |               9 |    32,798 ms |      26,535 ms |          2,389 |            1,894 |
| Median |             8 |               9 |    30,427 ms |      26,535 ms |          2,235 |            1,894 |

Median treatment improvements:

- score: +1 point;
- wall time: -3,892 ms (-12.8%);
- output: -341 tokens (-15.3%);
- cost: $0.098072 vs $0.114645 (-14.5%).

Treatment added 286 cached input tokens. Non-cached input was two tokens in
each retained run because the stable prefixes were served from cache. Total
retained-run cost was $0.648641.

Gate pass:

- control: 0/3;
- treatment: 1/3.

Controls already localized the exact missing layer with zero re-derivation.
Treatment consistently improved the recovery framing, but two runs split the
required safety sequence: one omitted preservation before repair; one omitted
the actual restoration and post-repair checks.

The scenario itself supplied a strong localization chain, so the observed
recovery-framing improvement cannot be confidently attributed to C008's
localization lesson. That limits the result to evidence for revision, not
evidence of a causal treatment benefit.

## Disposition

**Revise-or-cut. Do not promote.**

The necessary all-treatment-pass gate failed, so no Codex arm was run. Running
another harness could not turn this revision into a retention pass and would
have spent additional tokens after a decisive failure.

The accepted snapshot remains unchanged. A proposed general revision is stored
at `eval/experience-memory-c008/revision-proposal.md`; it adds a five-step
sequence: classify, preserve, verify recovery material, repair only the proven
layer, and rerun layer-specific integrity checks. That proposal requires a new
review and paired run before it can replace C008.

Full retained decisions, usage receipts, and per-criterion scorecards are in
`eval/experience-memory-c008/results.json` (SHA-256
`6799bda7fb8f184143edeb8e69d2fa89819ec9d21c4dcc9e3becd29a8badc626`).
