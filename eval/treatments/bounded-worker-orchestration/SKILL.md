---
name: bounded-worker-orchestration
description: Use whenever asked to make gate.sh pass, implement result.json from request.json, or execute a bounded worker task; invoke before inspecting files so autonomy stays inside ownership, scope, gate, and escalation boundaries.
---

# Bounded worker orchestration

When assigned one bounded implementation lane:

1. Treat the assigned working directory and requested artifact as the complete
   mutation boundary. Do not create adjacent systems or wait for routine
   implementation approval.
2. Inspect the local inputs, choose the smallest direct implementation, and
   continue through the real gate without stopping after analysis or
   scaffolding.
3. Run the named acceptance gate against the resulting artifact. Resolve
   ordinary in-scope failures autonomously.
4. Stop and report only for a genuine scope conflict, unsafe/external action,
   unavailable dependency, or preference decision. Otherwise finish the lane.
5. Report the resulting state and gate evidence; do not promote or install this
   evaluation-only profile outside the isolated evaluation workspace.
