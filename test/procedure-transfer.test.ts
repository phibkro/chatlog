import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  recordProcedureRecall,
  selectProcedureReferences,
  type ProcedureEntry,
  type ProcedureRecallRequest,
} from "../src/procedure-memory";
import { readContextEvents } from "../src/context-events";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

function entry(overrides: Partial<ProcedureEntry> = {}): ProcedureEntry {
  return {
    schemaVersion: 1,
    procedureId: "router-lock",
    version: "rev-1",
    sourceUri: "repo://runbooks/router-lock.md",
    contentHash: HASH_A,
    authoredBy: { provider: "anthropic", harness: "claude-code" },
    trigger: "router mutation under contention",
    preconditions: ["router process is running", "operator owns the mutation"],
    scope: { repository: "/repo", domain: "coding", harnesses: ["claude-code", "codex"] },
    environment: { platform: "linux" },
    actions: ["Acquire the router lock.", "Apply the mutation.", "Release the router lock."],
    successObservations: ["The mutation completes under lock custody."],
    failureObservations: ["The lock acquisition times out."],
    requiredAuthority: ["operator"],
    evidenceHashes: [HASH_A],
    evaluationHashes: [HASH_B],
    validTime: { start: "2026-08-01T00:00:00.000Z", end: null },
    status: "active",
    ...overrides,
  };
}

function request(overrides: Partial<ProcedureRecallRequest> = {}): ProcedureRecallRequest {
  return {
    task: "Fix router mutation under contention",
    repository: "/repo",
    domain: "coding",
    harness: "codex",
    environment: { platform: "linux" },
    authorities: ["operator"],
    currentVersions: { "router-lock": "rev-1" },
    priorOutcomes: { "router-lock@rev-1": "success" },
    now: "2026-08-03T12:00:00.000Z",
    maxResults: 4,
    ...overrides,
  };
}

test("recalls a reviewed procedure for an equivalent task on another harness", () => {
  const result = selectProcedureReferences([entry()], request());
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.value.references).toHaveLength(1);
  expect(result.value.references[0]).toMatchObject({
    id: "router-lock",
    procedureId: "router-lock",
    version: "rev-1",
    sourceUri: "repo://runbooks/router-lock.md",
    authoredBy: { provider: "anthropic", harness: "claude-code" },
    trigger: entry().trigger,
    scope: entry().scope,
    environment: entry().environment,
    validTime: entry().validTime,
    requiredAuthority: ["operator"],
    evidenceHashes: [HASH_A],
    evaluationHashes: [HASH_B],
  });
  expect(result.value.references[0]?.preconditions).toEqual(entry().preconditions);
  expect(result.value.references[0]?.actions).toEqual(entry().actions);
  expect(result.value.references[0]?.successObservations).toEqual(entry().successObservations);
  expect(result.value.references[0]?.failureObservations).toEqual(entry().failureObservations);
  expect(result.value.rejections).toEqual([]);
});

test("fails closed when the authoritative procedure pointer cannot be verified", () => {
  const result = selectProcedureReferences([entry()], request({ sourceResolver: () => false }));
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.error.code).toBe("invalid-procedure");
});

test.each([
  ["wrong repository", { repository: "/other" }, "repository-mismatch"],
  ["wrong harness", { harness: "omp" }, "harness-mismatch"],
  ["stale version", { currentVersions: { "router-lock": "rev-2" } }, "stale-version"],
  ["missing authority", { authorities: [] }, "missing-authority"],
  [
    "failed prior outcome",
    { priorOutcomes: { "router-lock@rev-1": "failure" } },
    "failed-prior-outcome",
  ],
] as const)("rejects %s", (_label, overrides, reason) => {
  const result = selectProcedureReferences([entry()], request(overrides));
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.value.references).toEqual([]);
  expect(result.value.rejections).toEqual([
    expect.objectContaining({ procedureId: "router-lock", version: "rev-1", reason }),
  ]);
});

test("fails closed for malformed procedure provenance", () => {
  const result = selectProcedureReferences([entry({ evidenceHashes: ["not-a-hash"] })], request());
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.error.code).toBe("invalid-procedure");
});

test("records selected procedures as source-bound advisory context", async () => {
  const root = await mkdtemp(join(tmpdir(), "chatlog-procedure-"));
  const result = await recordProcedureRecall(root, {
    contextSessionId: HASH_A,
    idempotencyKey: "procedure-recall-1",
    procedures: [entry()],
    request: request(),
  });
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.value.event.event.kind).toBe("context.procedure.returned");
  const events = await readContextEvents(root, { contextSessionId: HASH_A });
  expect(events.ok).toBe(true);
  if (!events.ok) return;
  expect(events.value[0]).toMatchObject({
    kind: "context.procedure.returned",
    state: "procedure-returned",
    actorAuthority: "system",
  });
  expect(events.value[0]?.payload.provenance).toMatchObject({
    procedures: [
      {
        id: "router-lock",
        procedureId: "router-lock",
        version: "rev-1",
        sourceUri: "repo://runbooks/router-lock.md",
        scope: entry().scope,
        environment: entry().environment,
        preconditions: entry().preconditions,
        actions: entry().actions,
        successObservations: entry().successObservations,
        failureObservations: entry().failureObservations,
        requiredAuthority: ["operator"],
        evidenceHashes: [HASH_A],
        evaluationHashes: [HASH_B],
      },
    ],
  });
});
