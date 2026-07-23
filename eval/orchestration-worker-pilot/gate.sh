#!/usr/bin/env bash
set -euo pipefail
[[ -f result.json ]] || { echo 'result.json is missing' >&2; exit 1; }
bun - <<'EOF'
const actual = await Bun.file("result.json").json().catch(() => null);
if (!actual) { console.error("result.json is invalid"); process.exit(1); }
const expected = { enabled: [{ id: "alpha", value: 7 }, { id: "gamma", value: 13 }], total: 20 };
if (JSON.stringify(actual) !== JSON.stringify(expected)) {
  console.error(`projection mismatch: ${JSON.stringify(actual)}`);
  process.exit(1);
}
EOF
