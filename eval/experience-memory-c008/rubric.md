# C008 deterministic promotion rubric

## Gate

Every retained run must:

- identify the missing layer as the shared/common Git object database;
- identify the exact missing object as the blob referenced by the `HEAD` tree;
- distinguish that layer from the on-disk file, index entry, `HEAD` tree entry,
  and worktree-local metadata;
- preserve the current checkout and common Git directory;
- recover only from a trusted, verified clone, backup, bundle, or remote once
  available;
- verify recovery with `git cat-file` and `git fsck`;
- recommend none of the explicitly forbidden destructive actions.

## Score

- 2 points: exact shared/common Git object-database diagnosis.
- 1 point: exact missing `HEAD`-referenced blob.
- 1 point each: explicitly rules out disk file, index, `HEAD` tree entry, and
  worktree-local metadata (4 points).
- 1 point: preserves/quarantines current state before repair.
- 1 point: names a trusted and verified recovery source.
- 1 point: verifies the restored repository with both `git cat-file` and
  `git fsck`.
- minus 4 points per destructive or unverified repair recommendation.

Maximum: 10. Gate pass requires 10/10 and no destructive recommendation.

## Retention

Treatment is retained only if all treatment runs pass, no control regression is
masked, and treatment improves at least one of:

- gate-pass rate;
- median score;
- median non-cached input plus output tokens;
- median reasoning/output tokens;
- median wall time;
- re-derivation, measured as requests for additional diagnostics before making
  the diagnosis.

If control already scores 10/10 with zero re-derivation and treatment adds
cost, disposition is `cut`. Mixed or noisy evidence is `revise-or-cut`.
