import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  CONTEXT_SCHEMA_VERSION,
  type ContextBudget,
  type ContextBundle,
  type ContextSession,
  type ContextSessionInput,
} from "./context-types";
import { sha256, stableStringify } from "./events";
import { withIngestLock } from "./lock";

const HASH = /^[a-f0-9]{64}$/u;

export type ContextSessionStoreResult<T> =
  | { ok: true; value: T }
  | {
      ok: false;
      error: {
        code: "invalid-session" | "session-conflict" | "storage-error";
        message: string;
      };
    };

function invalid(message: string): ContextSessionStoreResult<never> {
  return { ok: false, error: { code: "invalid-session", message } };
}

function storageError(error: unknown): ContextSessionStoreResult<never> {
  return {
    ok: false,
    error: {
      code: "storage-error",
      message: error instanceof Error ? error.message : String(error),
    },
  };
}

function validTimestamp(value: string): boolean {
  return Number.isFinite(Date.parse(value));
}

function normalizeBudget(
  value: ContextBudget,
  label: string,
): ContextSessionStoreResult<ContextBudget> {
  for (const [key, amount] of Object.entries(value)) {
    if (!Number.isFinite(amount) || amount < 0)
      return invalid(`${label}.${key} must be a non-negative finite number`);
    if (key !== "costUsd" && !Number.isSafeInteger(amount))
      return invalid(`${label}.${key} must be a non-negative integer`);
  }
  return { ok: true, value: { ...value } };
}

export function contextSessionIdentity(
  input: Omit<ContextSessionInput, "totalBudget" | "createdAt">,
): string {
  return sha256(
    stableStringify({
      recipe: "chatlog-context-session-v1",
      nativeSessionId: input.nativeSessionId,
      provider: input.provider,
      harness: input.harness,
      model: input.model,
      role: input.role,
      projectIdentity: input.projectIdentity,
      cwd: input.cwd,
      domainPolicy: [
        ...new Set(input.domainPolicy.map((domain) => domain.trim().toLowerCase())),
      ].toSorted(),
      path: input.path,
      binding: "pins-and-budgets-are-session-state",
    }),
  );
}

export function createContextSession(
  input: ContextSessionInput,
): ContextSessionStoreResult<ContextSession> {
  for (const [label, value] of [
    ["provider", input.provider],
    ["harness", input.harness],
    ["role", input.role],
    ["projectIdentity", input.projectIdentity],
    ["cwd", input.cwd],
    ["selectionPolicyVersion", input.selectionPolicyVersion],
    ["deliveryPolicyVersion", input.deliveryPolicyVersion],
  ] as const)
    if (!value.trim()) return invalid(`${label} must be non-empty`);
  if (input.model !== null && !input.model.trim()) return invalid("model must be non-empty");
  if (input.nativeSessionId !== null && !input.nativeSessionId.trim())
    return invalid("nativeSessionId must be non-empty");
  if (input.path !== null && !input.path.trim()) return invalid("path must be non-empty");
  if (!input.domainPolicy.length || input.domainPolicy.some((domain) => !domain.trim()))
    return invalid("domainPolicy must contain at least one explicit domain");
  if (!HASH.test(input.pinnedInsightProjectionHash))
    return invalid("pinnedInsightProjectionHash must be a lowercase SHA-256 hash");
  if (!HASH.test(input.pinnedEvidenceProjectionHash))
    return invalid("pinnedEvidenceProjectionHash must be a lowercase SHA-256 hash");
  if (!validTimestamp(input.createdAt)) return invalid("createdAt must be an ISO timestamp");
  const total = normalizeBudget(input.totalBudget, "totalBudget");
  if (!total.ok) return total;
  const domains = [
    ...new Set(input.domainPolicy.map((domain) => domain.trim().toLowerCase())),
  ].toSorted();
  const contextSessionId = contextSessionIdentity({ ...input, domainPolicy: domains });
  return {
    ok: true,
    value: {
      schemaVersion: CONTEXT_SCHEMA_VERSION,
      contextSessionId,
      nativeSessionId: input.nativeSessionId,
      target: {
        provider: input.provider,
        harness: input.harness,
        model: input.model,
        role: input.role,
      },
      projectIdentity: input.projectIdentity,
      cwd: input.cwd,
      domainPolicy: domains,
      path: input.path,
      pinnedInsightProjectionHash: input.pinnedInsightProjectionHash,
      pinnedEvidenceProjectionHash: input.pinnedEvidenceProjectionHash,
      selectionPolicyVersion: input.selectionPolicyVersion,
      deliveryPolicyVersion: input.deliveryPolicyVersion,
      budget: { total: { ...total.value }, remaining: { ...total.value } },
      consumedBundleHashes: [],
      createdAt: input.createdAt,
      updatedAt: input.createdAt,
    },
  };
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseStoredSession(value: unknown): ContextSessionStoreResult<ContextSession> {
  if (!record(value) || !record(value.target) || !record(value.budget))
    return invalid("context session must be an object");
  if (!record(value.budget.total) || !record(value.budget.remaining))
    return invalid("context session budget must contain total and remaining");
  if (!Array.isArray(value.consumedBundleHashes))
    return invalid("consumedBundleHashes must be an array");
  const consumedBundleHashes: string[] = [];
  for (const [index, consumed] of value.consumedBundleHashes.entries()) {
    if (typeof consumed !== "string" || !HASH.test(consumed))
      return invalid(`consumedBundleHashes[${index}] must be a SHA-256`);
    consumedBundleHashes.push(consumed);
  }
  if (new Set(consumedBundleHashes).size !== consumedBundleHashes.length)
    return invalid("consumedBundleHashes must not contain duplicates");
  const target = value.target;
  const created = createContextSession({
    nativeSessionId: typeof value.nativeSessionId === "string" ? value.nativeSessionId : null,
    provider: typeof target.provider === "string" ? target.provider : "",
    harness: typeof target.harness === "string" ? target.harness : "",
    model: typeof target.model === "string" ? target.model : null,
    role: typeof target.role === "string" ? target.role : "",
    projectIdentity: typeof value.projectIdentity === "string" ? value.projectIdentity : "",
    cwd: typeof value.cwd === "string" ? value.cwd : "",
    domainPolicy: Array.isArray(value.domainPolicy)
      ? value.domainPolicy.filter((domain): domain is string => typeof domain === "string")
      : [],
    path: typeof value.path === "string" ? value.path : null,
    pinnedInsightProjectionHash:
      typeof value.pinnedInsightProjectionHash === "string"
        ? value.pinnedInsightProjectionHash
        : "",
    pinnedEvidenceProjectionHash:
      typeof value.pinnedEvidenceProjectionHash === "string"
        ? value.pinnedEvidenceProjectionHash
        : "",
    selectionPolicyVersion:
      typeof value.selectionPolicyVersion === "string" ? value.selectionPolicyVersion : "",
    deliveryPolicyVersion:
      typeof value.deliveryPolicyVersion === "string" ? value.deliveryPolicyVersion : "",
    totalBudget: value.budget.total as unknown as ContextBudget,
    createdAt: typeof value.createdAt === "string" ? value.createdAt : "",
  });
  if (!created.ok) return created;
  if (value.schemaVersion !== CONTEXT_SCHEMA_VERSION)
    return invalid("context session schema version is unsupported");
  if (value.contextSessionId !== created.value.contextSessionId)
    return invalid("context session identity does not match its binding");
  if (typeof value.updatedAt !== "string" || !validTimestamp(value.updatedAt))
    return invalid("updatedAt must be an ISO timestamp");
  const remaining = normalizeBudget(
    value.budget.remaining as unknown as ContextBudget,
    "remainingBudget",
  );
  if (!remaining.ok) return remaining;
  for (const key of Object.keys(remaining.value) as Array<keyof ContextBudget>)
    if (remaining.value[key] > created.value.budget.total[key])
      return invalid(`remainingBudget.${key} exceeds the total budget`);
  return {
    ok: true,
    value: {
      ...created.value,
      budget: { total: created.value.budget.total, remaining: remaining.value },
      consumedBundleHashes,
      updatedAt: value.updatedAt,
    },
  };
}

function sessionPath(root: string, contextSessionId: string): string {
  return join(resolve(root), "memory", "context-sessions", `${contextSessionId}.json`);
}

async function atomicPrivateJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await chmod(dirname(path), 0o700);
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
  await rename(temporary, path);
  await chmod(path, 0o600);
}

export async function readContextSession(
  root: string,
  contextSessionId: string,
): Promise<ContextSessionStoreResult<ContextSession>> {
  if (!HASH.test(contextSessionId)) return invalid("contextSessionId must be a lowercase SHA-256");
  try {
    return parseStoredSession(
      JSON.parse(await readFile(sessionPath(root, contextSessionId), "utf8")),
    );
  } catch (error) {
    return storageError(error);
  }
}

export async function openContextSession(
  root: string,
  input: ContextSessionInput,
): Promise<ContextSessionStoreResult<ContextSession>> {
  const candidate = createContextSession(input);
  if (!candidate.ok) return candidate;
  return withIngestLock(root, async () => {
    try {
      const current = parseStoredSession(
        JSON.parse(await readFile(sessionPath(root, candidate.value.contextSessionId), "utf8")),
      );
      if (!current.ok) return current;
      return { ok: true, value: current.value };
    } catch (error) {
      if (
        typeof error !== "object" ||
        error === null ||
        !("code" in error) ||
        error.code !== "ENOENT"
      )
        return storageError(error);
    }
    try {
      await atomicPrivateJson(sessionPath(root, candidate.value.contextSessionId), candidate.value);
      return candidate;
    } catch (error) {
      return storageError(error);
    }
  });
}

export async function commitContextBundleBudget(
  root: string,
  bundle: ContextBundle,
  committedAt: string,
): Promise<ContextSessionStoreResult<ContextSession>> {
  if (!HASH.test(bundle.bundleHash)) return invalid("bundleHash must be a lowercase SHA-256");
  if (!validTimestamp(committedAt)) return invalid("committedAt must be an ISO timestamp");
  return withIngestLock(root, async () => {
    let current: ContextSessionStoreResult<ContextSession>;
    try {
      current = parseStoredSession(
        JSON.parse(await readFile(sessionPath(root, bundle.contextSessionId), "utf8")),
      );
    } catch (error) {
      return storageError(error);
    }
    if (!current.ok) return current;
    const session = current.value;
    if (session.consumedBundleHashes.includes(bundle.bundleHash)) return current;
    if (
      bundle.pinnedInsightProjectionHash !== session.pinnedInsightProjectionHash ||
      bundle.pinnedEvidenceProjectionHash !== session.pinnedEvidenceProjectionHash
    )
      return {
        ok: false,
        error: { code: "session-conflict", message: "bundle projection pins do not match session" },
      };
    const before = bundle.budget;
    if (
      before.beforeTokens !== session.budget.remaining.tokens ||
      before.beforeResults !== session.budget.remaining.results ||
      before.beforeLatencyMs !== session.budget.remaining.latencyMs ||
      before.beforeCostUsd !== session.budget.remaining.costUsd
    )
      return {
        ok: false,
        error: { code: "session-conflict", message: "bundle was planned against stale budget" },
      };
    const remaining = normalizeBudget(
      {
        tokens: before.afterTokens,
        results: before.afterResults,
        latencyMs: before.afterLatencyMs,
        costUsd: before.afterCostUsd,
      },
      "remainingBudget",
    );
    if (!remaining.ok) return remaining;
    const updated: ContextSession = {
      ...session,
      budget: { total: { ...session.budget.total }, remaining: remaining.value },
      consumedBundleHashes: [...session.consumedBundleHashes, bundle.bundleHash],
      updatedAt: committedAt,
    };
    try {
      await atomicPrivateJson(sessionPath(root, session.contextSessionId), updated);
      return { ok: true, value: updated };
    } catch (error) {
      return storageError(error);
    }
  });
}

export async function listContextSessions(
  root: string,
): Promise<ContextSessionStoreResult<ContextSession[]>> {
  const directory = join(resolve(root), "memory", "context-sessions");
  let names: string[];
  try {
    names = await readdir(directory);
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")
      return { ok: true, value: [] };
    return storageError(error);
  }
  const sessions: ContextSession[] = [];
  for (const name of names.toSorted()) {
    if (!name.endsWith(".json")) continue;
    try {
      const parsed = parseStoredSession(JSON.parse(await readFile(join(directory, name), "utf8")));
      if (!parsed.ok) return parsed;
      sessions.push(parsed.value);
    } catch (error) {
      return storageError(error);
    }
  }
  return {
    ok: true,
    value: sessions.toSorted(
      (left, right) =>
        Date.parse(right.createdAt) - Date.parse(left.createdAt) ||
        left.contextSessionId.localeCompare(right.contextSessionId),
    ),
  };
}
