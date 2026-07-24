# Product direction

Chatlog is a local-first, self-hosted product for people who build with coding
agents and want their own session history to become useful project memory.
Its primary deployment keeps raw transcripts, canonical objects, indexes, and
derived insights on the operator's machine. The public repository should make
that deployment understandable and repeatable for other technical users.

## Near-term product

- Make workflow evolution the primary insight loop: identify repeated operator
  patterns, deduplicate instructions propagated through agent fan-out, show
  when boundaries are revised, and only then compare outcome indicators. Keep
  every claim evidence-backed and distinguish association from causation.
- Treat repeated-pattern synthesis as the bridge from individual events to an
  operator profile: require distinct multi-day episodes, avoid presenting
  session lineages as statistical independence, separate wording revision from
  policy effect, and expose outcome direction only above declared coverage
  floors.
- Connect local harness logs and explicit provider exports through reviewable
  adapters.
- Turn them into project recall, bounded evidence, source health, and measured
  reusable findings for both humans and agents.
- Ship a straightforward self-host path with reproducible packaging, setup
  guidance, backups, upgrades, privacy documentation, and a safe demo corpus.
- Keep Workbench read-only over HTTP. Authority-changing source lifecycle
  operations remain explicit local commands until their durable intent,
  invalidation, receipt, and recovery contracts are complete.
- Treat private-network ingress as deployment policy. The canonical operator
  deployment is `https://chatlog.home.phibkro.org`, restricted to the
  LAN/tailnet; Chatlog itself remains loopback-only.

## Deferred hosted companion

A hosted service is not the default data plane and is not required for the
self-hosted product. If real demand appears, a companion may later provide
identity, remote rendezvous, encrypted synchronization, team policy, or fleet
management while leaving raw transcripts local by default.

Before any public Workbench exposure, Chatlog needs application authentication,
authorization across provenance domains, browser-session and CSRF protection,
rate limiting, and an explicit hosted privacy/threat model. A conventional SaaS
that centrally harvests agent transcripts is out of scope unless users
deliberately choose that trust boundary.

## Decision trigger

Revisit a hosted companion only after the self-hosted product has multiple
independent users and they identify recurring problems that cannot be solved
cleanly by local packaging, private overlays, or client-side synchronization.
