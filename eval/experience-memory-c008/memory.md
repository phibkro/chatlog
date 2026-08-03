# Accepted experience memory

ID: `localize-missing-layer-before-fix`

Use when an error says something is missing but the failing storage or
configuration layer is unclear.

Situation: A missing-input error did not identify whether the absent object
belonged to the filesystem, Git, a package store, or configuration.

Outcome: Layer-by-layer inspection found the actual failure boundary; errors
that looked like missing configuration or commits were missing store paths or
object-store corruption.

Lesson: When something reports “missing,” pin down which layer is actually
missing before acting: disk vs Git index vs HEAD tree vs object store vs store
path vs configuration.

Action: Localize the missing layer—disk, Git index, HEAD tree, object store,
store path, or configuration—before applying a fix.

