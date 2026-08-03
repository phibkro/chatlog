# C008 promotion scenario: locate the missing layer

You are the incident responder. Use only the evidence below. Do not inspect
files, call tools, or ask for more data.

A build wrapper exits with:

```text
fatal: required configuration services/payments/config.toml is missing
```

The operator already collected:

```text
$ test -f services/payments/config.toml
exit 0

$ git ls-files --error-unmatch services/payments/config.toml
services/payments/config.toml
exit 0

$ git diff --exit-code -- services/payments/config.toml
exit 0

$ git rev-parse HEAD:services/payments/config.toml
b7a1b7a1b7a1b7a1b7a1b7a1b7a1b7a1b7a1b7a1

$ git cat-file -e b7a1b7a1b7a1b7a1b7a1b7a1b7a1b7a1b7a1b7a1^{blob}
fatal: Not a valid object name
exit 128

$ git fsck --full
missing blob b7a1b7a1b7a1b7a1b7a1b7a1b7a1b7a1b7a1b7a1
exit 2

$ cat .git
gitdir: /workspace/main/.git/worktrees/payments-fix

$ git rev-parse --git-common-dir
/workspace/main/.git
```

A second linked worktree using the same common Git directory resolves the same
path from `HEAD` to the same blob ID and also fails `git cat-file -e`. Network
access to the remote is unavailable during the incident window.

Return a concise incident decision containing:

1. the exact failing storage/repository layer;
2. why the wrapper's “configuration is missing” message is misleading;
3. the first two safe actions, in order;
4. the tempting but incorrect layers or fixes the evidence rules out.

Do not recommend deleting or recreating the configuration, resetting either
worktree, garbage collection, recloning over the current checkout, or copying
an unverified object into the repository.

