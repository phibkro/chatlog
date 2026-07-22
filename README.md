# Local chatlog corpus

Local-only, secret-redacted ingestion for Claude Code, Codex, and pi session logs.
Each source file is adapted into the canonical `Conversation` type in
`src/types.ts`, hashed after normalization/redaction, and written once beneath
`corpus/objects/<hash-prefix>/<sha256>.json`. Changed live sessions create a new
immutable object; the manifest makes unchanged reruns incremental and idempotent.

The source directories are only opened for discovery, stat, and streaming reads.
The tool never writes beneath `~/.claude`, `~/.codex`, or `~/.pi`. Corpus and
analysis files are mode 0600 inside mode 0700 directories and are gitignored.

```sh
bun run ingest
bun run query stats
bun run query search 'phrase AND another'
bun run query models
```

The analysis database is SQLite via Bun's built-in driver, including an FTS5
index over every canonical turn. This uses the SQLite option allowed by the
brief because a DuckDB runtime was not present locally and dependencies must not
be fetched over the network.

## Adapter seam

New sources implement `SourceAdapter.discover()` and `SourceAdapter.adapt()` and
return the canonical schema. Adapters explicitly enumerate accepted record and
content-block kinds; an unknown shape aborts ingestion with its source path and
line number. Deferred web providers can be added here without changing corpus or
analysis code. No web adapter is implemented.
