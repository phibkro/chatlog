# C008 revision proposal

Status: proposal only; not accepted and not published.

## Trigger

An error says something is missing, but the failing storage, repository, store,
or configuration layer is unclear.

## Proposed action

Classify the missing layer before mutation. Preserve the affected shared state,
verify any recovery material against that layer's canonical identity, repair
only the proven layer, and rerun the layer-specific integrity checks.

## Why revise

The accepted card reliably encouraged exact layer localization, but frontier
controls already did that without memory. Treatment's measurable advantage came
from a better recovery sequence. Two of three treatment runs nevertheless
omitted one safety boundary:

- one restored and verified the exact object but did not first preserve state;
- one preserved and verified the candidate bytes but did not include the
  restoration and post-repair checks in its first two actions.

The revision makes the complete safety sequence succinct and general rather
than adding a Git-specific repair recipe to always-on memory.
