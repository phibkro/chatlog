# Chatlog Memory

This tracer plugin injects a deterministic Tier 1 routing index on fresh
sessions only. When a trigger applies, the harness can call
`chatlog_recall_memory` with the snapshot hash emitted at startup and an exact
memory ID to load one accepted Tier 2 card. Recall is content-addressed; the
tool does not independently authenticate which session supplied the hash.

The plugin does not promote candidates, load evidence text at startup, or
change an active session when the accepted ledger is republished.

Private ledgers and Tier 2 snapshots live under the ignored `memory/`
directory. Publication verifies the exact proposal bytes, finalized operator
review bytes, and blinded alias-to-candidate mapping before compiling.
