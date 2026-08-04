# Chatlog Memory

This tracer plugin binds a context session on fresh sessions only. The
startup hook emits the session ID and inert routing instructions; it does not
load memory cards or evidence into provider history.

Use `chatlog_context` for one operator-authorized task delivery, then use
`chatlog_bounded_recall` with the returned `contextSessionId` for finite
follow-up recall. Both operations remain bound to the startup session and its
source and policy pins.

The plugin does not promote candidates, load evidence text at startup, or
change an active session when the accepted ledger is republished.

Private ledgers and Tier 2 snapshots live under the ignored `memory/`
directory. Publication verifies the exact proposal bytes, finalized operator
review bytes, and blinded alias-to-candidate mapping before compiling.

## Data root

The plugin never uses the active repository as its data root. When
`CHATLOG_DATA_ROOT` is unset, it uses the operator-owned
`${XDG_DATA_HOME:-~/.local/share}/chatlog` directory. Set `CHATLOG_DATA_ROOT`
to an existing operator-owned Chatlog root when the data lives elsewhere.
The root must be outside the active repository; repository-contained roots and
authority or corpus paths that escape through symlinks are rejected before
session or MCP reads.
