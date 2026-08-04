import { isAbsolute, normalize, relative } from "node:path";
import { Effect } from "effect";
import { sha256, stableStringify } from "./events";

/**
 * The fields that are consumed by a recall session. Counts are integral; time
 * and cost may be fractional, but every field is finite and non-negative.
 */
export const RECALL_BUDGET_FIELDS = [
  "maxDepth",
  "maxBranches",
  "maxQueries",
  "maxResults",
  "maxTokens",
  "maxLatencyMs",
  "maxCostUsd",
] as const;

export type RecallBudgetField = (typeof RECALL_BUDGET_FIELDS)[number];

export interface RecallBudget {
  readonly maxDepth: number;
  readonly maxBranches: number;
  readonly maxQueries: number;
  readonly maxResults: number;
  readonly maxTokens: number;
  readonly maxLatencyMs: number;
  readonly maxCostUsd: number;
}

export type RecallBudgetInput = RecallBudget;
export type RecallChildBudgetInput = Partial<RecallBudget> & Pick<RecallBudget, "maxDepth">;
export type RecallBudgetUsage = Partial<RecallBudget>;

export type RecallBudgetErrorCode =
  | "invalid-budget"
  | "depth-not-decreased"
  | "scope-widened"
  | "usage-exceeds-remaining";

export class RecallBudgetError extends Error {
  readonly _tag = "RecallBudgetError" as const;
  readonly code: RecallBudgetErrorCode;
  readonly field?: RecallBudgetField;

  constructor(code: RecallBudgetErrorCode, message: string, field?: RecallBudgetField) {
    super(message);
    this.name = "RecallBudgetError";
    this.code = code;
    this.field = field;
  }
}

export interface BudgetValidationSuccess {
  readonly ok: true;
  readonly value: RecallBudget;
}

export interface BudgetValidationFailure {
  readonly ok: false;
  readonly error: RecallBudgetError;
}

export type BudgetValidation = BudgetValidationSuccess | BudgetValidationFailure;

export interface RecallScope {
  readonly domain?: string | null;
  readonly project?: string | null;
  readonly provider?: string | null;
  readonly repository?: string | null;
  readonly path?: string | null;
  readonly harness?: string | null;
  readonly model?: string | null;
  readonly itemPermissions?: readonly string[];
  readonly [key: string]: unknown;
}

export interface ScopeValidationSuccess {
  readonly ok: true;
  readonly value: RecallScope;
}

export interface ScopeValidationFailure {
  readonly ok: false;
  readonly error: RecallBudgetError;
}

export type ScopeValidation = ScopeValidationSuccess | ScopeValidationFailure;

function requiredNumber(value: unknown, field: RecallBudgetField): number | RecallBudgetError {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0)
    return new RecallBudgetError(
      "invalid-budget",
      `${field} must be finite and non-negative`,
      field,
    );
  if (
    (field === "maxDepth" ||
      field === "maxBranches" ||
      field === "maxQueries" ||
      field === "maxResults" ||
      field === "maxTokens") &&
    !Number.isInteger(value)
  )
    return new RecallBudgetError("invalid-budget", `${field} must be an integer`, field);
  return value;
}

/** Validate an untrusted budget without throwing. */
export function validateRecallBudget(input: unknown): BudgetValidation {
  if (input === null || typeof input !== "object" || Array.isArray(input))
    return {
      ok: false,
      error: new RecallBudgetError("invalid-budget", "recall budget must be an object"),
    };
  const record = input as Record<string, unknown>;

  const values: Partial<Record<RecallBudgetField, number>> = {};
  for (const field of RECALL_BUDGET_FIELDS) {
    const value = requiredNumber(record[field], field);
    if (value instanceof RecallBudgetError) return { ok: false, error: value };
    values[field] = value;
  }

  return {
    ok: true,
    value: Object.freeze({
      maxDepth: values.maxDepth as number,
      maxBranches: values.maxBranches as number,
      maxQueries: values.maxQueries as number,
      maxResults: values.maxResults as number,
      maxTokens: values.maxTokens as number,
      maxLatencyMs: values.maxLatencyMs as number,
      maxCostUsd: values.maxCostUsd as number,
    }),
  };
}

/** Create an immutable validated budget. */
export function createRecallBudget(input: RecallBudgetInput): RecallBudget {
  const result = validateRecallBudget(input);
  if (!result.ok) return Effect.runSync(Effect.fail(result.error));
  return result.value;
}

export const makeRecallBudget = createRecallBudget;

export function emptyRecallBudget(): RecallBudget {
  return createRecallBudget({
    maxDepth: 0,
    maxBranches: 0,
    maxQueries: 0,
    maxResults: 0,
    maxTokens: 0,
    maxLatencyMs: 0,
    maxCostUsd: 0,
  });
}

function compareBudgetFields(
  parent: RecallBudget,
  child: RecallBudget,
): RecallBudgetError | undefined {
  if (child.maxDepth >= parent.maxDepth)
    return new RecallBudgetError(
      "depth-not-decreased",
      `child maxDepth ${child.maxDepth} must be strictly less than parent maxDepth ${parent.maxDepth}`,
      "maxDepth",
    );
  for (const field of RECALL_BUDGET_FIELDS) {
    if (field === "maxDepth") continue;
    if (child[field] > parent[field])
      return new RecallBudgetError(
        "invalid-budget",
        `child ${field} ${child[field]} exceeds parent ${field} ${parent[field]}`,
        field,
      );
  }
  return undefined;
}

/**
 * Validate and freeze a child budget. Depth is the well-founded dimension and
 * must strictly decrease; every other total can only tighten.
 */
export function deriveChildBudget(
  parent: RecallBudget,
  child: RecallChildBudgetInput,
): BudgetValidation {
  const parentResult = validateRecallBudget(parent);
  if (!parentResult.ok) return parentResult;
  const childResult = validateRecallBudget({ ...parentResult.value, ...child });
  if (!childResult.ok) return childResult;
  const error = compareBudgetFields(parentResult.value, childResult.value);
  return error ? { ok: false, error } : childResult;
}
export const createChildBudget = deriveChildBudget;

/** A conservative default child: one less depth and the same hard totals. */
export function defaultChildBudget(parent: RecallBudget): BudgetValidation {
  if (parent.maxDepth <= 0)
    return {
      ok: false,
      error: new RecallBudgetError(
        "depth-not-decreased",
        "a child cannot be created when parent maxDepth is zero",
        "maxDepth",
      ),
    };
  return deriveChildBudget(parent, { ...parent, maxDepth: parent.maxDepth - 1 });
}

export interface BudgetSnapshot {
  readonly total: RecallBudget;
  readonly consumed: RecallBudget;
  readonly remaining: RecallBudget;
}

export interface BudgetConsumeSuccess {
  readonly ok: true;
  readonly snapshot: BudgetSnapshot;
}

export interface BudgetConsumeFailure {
  readonly ok: false;
  readonly error: RecallBudgetError;
  readonly snapshot: BudgetSnapshot;
}

export type BudgetConsumeResult = BudgetConsumeSuccess | BudgetConsumeFailure;

function add(left: RecallBudget, right: RecallBudget): RecallBudget {
  return {
    maxDepth: left.maxDepth + right.maxDepth,
    maxBranches: left.maxBranches + right.maxBranches,
    maxQueries: left.maxQueries + right.maxQueries,
    maxResults: left.maxResults + right.maxResults,
    maxTokens: left.maxTokens + right.maxTokens,
    maxLatencyMs: left.maxLatencyMs + right.maxLatencyMs,
    maxCostUsd: left.maxCostUsd + right.maxCostUsd,
  };
}

function subtract(left: RecallBudget, right: RecallBudget): RecallBudget {
  return {
    maxDepth: left.maxDepth - right.maxDepth,
    maxBranches: left.maxBranches - right.maxBranches,
    maxQueries: left.maxQueries - right.maxQueries,
    maxResults: left.maxResults - right.maxResults,
    maxTokens: left.maxTokens - right.maxTokens,
    maxLatencyMs: left.maxLatencyMs - right.maxLatencyMs,
    maxCostUsd: left.maxCostUsd - right.maxCostUsd,
  };
}

function zeroUsage(): RecallBudget {
  return {
    maxDepth: 0,
    maxBranches: 0,
    maxQueries: 0,
    maxResults: 0,
    maxTokens: 0,
    maxLatencyMs: 0,
    maxCostUsd: 0,
  };
}

/**
 * A session-owned atomic budget ledger. Mutation is synchronous and occurs only
 * after every field has been checked, so a failed reservation consumes nothing.
 */
export class RecallBudgetLedger {
  readonly total: RecallBudget;
  private consumedValue: RecallBudget;

  constructor(total: RecallBudget) {
    const validated = createRecallBudget(total);
    this.total = validated;
    this.consumedValue = zeroUsage();
  }

  snapshot(): BudgetSnapshot {
    const consumed = Object.freeze({ ...this.consumedValue });
    const remaining = Object.freeze(subtract(this.total, consumed));
    return Object.freeze({ total: this.total, consumed, remaining });
  }

  consume(usage: RecallBudgetUsage): BudgetConsumeResult {
    const validated = validateRecallBudget({ ...zeroUsage(), ...usage });
    if (!validated.ok) return { ok: false, error: validated.error, snapshot: this.snapshot() };
    const candidate = add(this.consumedValue, validated.value);
    for (const field of RECALL_BUDGET_FIELDS) {
      if (candidate[field] > this.total[field]) {
        return {
          ok: false,
          error: new RecallBudgetError(
            "usage-exceeds-remaining",
            `usage for ${field} exceeds the remaining recall budget`,
            field,
          ),
          snapshot: this.snapshot(),
        };
      }
    }
    this.consumedValue = candidate;
    return { ok: true, snapshot: this.snapshot() };
  }
  reserve(usage: RecallBudgetUsage): BudgetConsumeResult {
    return this.consume(usage);
  }

  remaining(): RecallBudget {
    return this.snapshot().remaining;
  }

  consumed(): RecallBudget {
    return this.snapshot().consumed;
  }
}

export function consumeRecallBudget(
  ledger: RecallBudgetLedger,
  usage: RecallBudgetUsage,
): BudgetConsumeResult {
  return ledger.consume(usage);
}

export function budgetHash(budget: RecallBudget): string {
  return sha256(stableStringify(budget));
}
function scopeValueEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) && Array.isArray(right)) {
    return (
      left.length === right.length &&
      left.every((value) => right.some((candidate) => scopeValueEqual(value, candidate)))
    );
  }
  if (
    left !== null &&
    right !== null &&
    typeof left === "object" &&
    typeof right === "object" &&
    !Array.isArray(left) &&
    !Array.isArray(right)
  ) {
    const leftEntries = Object.entries(left as Record<string, unknown>);
    const rightRecord = right as Record<string, unknown>;
    return (
      leftEntries.length === Object.keys(rightRecord).length &&
      leftEntries.every(
        ([key, value]) => key in rightRecord && scopeValueEqual(value, rightRecord[key]),
      )
    );
  }
  return false;
}
/**
 * Recall paths are metadata boundaries, not filesystem capabilities. The
 * policy is lexical and does not follow symlinks; callers must never use a
 * scope path as an authority to open a file.
 */
export const RECALL_PATH_SYMLINK_POLICY = "lexical-no-follow" as const;

/** Return one canonical absolute path, or undefined for an untrusted path. */
export function canonicalRecallPath(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) return undefined;
  if (!isAbsolute(value)) return undefined;
  const components = value.split("/");
  if (components.some((component) => component === "." || component === "..")) return undefined;
  const normalized = normalize(value);
  if (!isAbsolute(normalized)) return undefined;
  return normalized.length > 1 && normalized.endsWith("/") ? normalized.slice(0, -1) : normalized;
}
/**
 * Return the canonical item path that actually satisfies a scoped query.
 *
 * A query may match either the conversation working directory or its source
 * path. The returned value is the matching stored path, not the requested
 * parent path. Neutral scopes only match rows with no path metadata.
 */
export function matchingRecallPath(
  scopePath: unknown,
  cwd: unknown,
  sourcePath: unknown,
): string | null | undefined {
  if (scopePath === null || scopePath === undefined) {
    return cwd === null || cwd === undefined || cwd === ""
      ? sourcePath === null || sourcePath === undefined || sourcePath === ""
        ? null
        : undefined
      : undefined;
  }
  const canonicalScope = canonicalRecallPath(scopePath);
  if (canonicalScope === undefined) return undefined;
  for (const candidate of [cwd, sourcePath]) {
    if (candidate === null || candidate === undefined || candidate === "") continue;
    const canonicalCandidate = canonicalRecallPath(candidate);
    if (canonicalCandidate !== undefined && recallPathWithin(canonicalScope, canonicalCandidate))
      return canonicalCandidate;
  }
  return undefined;
}

/** Compare canonical path components without following symlinks. */
export function recallPathWithin(parent: unknown, child: unknown): boolean {
  const canonicalParent = canonicalRecallPath(parent);
  const canonicalChild = canonicalRecallPath(child);
  if (canonicalParent === undefined || canonicalChild === undefined) return false;
  const distance = relative(canonicalParent, canonicalChild);
  return !isAbsolute(distance) && distance !== ".." && !distance.startsWith("../");
}

function scopeValueNarrower(parent: unknown, child: unknown, key: string): boolean {
  if (parent === undefined || parent === null) {
    // An omitted session dimension is not an invitation to introduce an
    // identity in a child scope. Only the same neutral value remains valid.
    if (child === undefined || child === null) return true;
    return key === "itemPermissions" && Array.isArray(child) && child.length === 0;
  }
  if (child === undefined || child === null) return false;
  if (key === "path" && typeof parent === "string" && typeof child === "string")
    return recallPathWithin(parent, child);
  if (Array.isArray(parent) && Array.isArray(child))
    return child.every((value) => parent.some((candidate) => scopeValueEqual(candidate, value)));
  if (
    typeof parent === "object" &&
    typeof child === "object" &&
    !Array.isArray(parent) &&
    !Array.isArray(child)
  ) {
    const parentRecord = parent as Record<string, unknown>;
    const childRecord = child as Record<string, unknown>;
    return Object.entries(childRecord).every(([childKey, childValue]) =>
      scopeValueNarrower(parentRecord[childKey], childValue, childKey),
    );
  }
  return scopeValueEqual(parent, child);
}

export function validateRecallScope(input: unknown): ScopeValidation {
  if (input === null || typeof input !== "object" || Array.isArray(input))
    return {
      ok: false,
      error: new RecallBudgetError("scope-widened", "recall scope must be an object"),
    };
  const inputScope = input as Record<string, unknown>;
  if (
    inputScope.itemPermissions !== undefined &&
    (!Array.isArray(inputScope.itemPermissions) ||
      inputScope.itemPermissions.some((item) => typeof item !== "string"))
  )
    return {
      ok: false,
      error: new RecallBudgetError(
        "invalid-budget",
        "scope itemPermissions must be an array of strings",
      ),
    };
  const scope = { ...inputScope };
  if (scope.path !== undefined && scope.path !== null) {
    const canonicalPath = canonicalRecallPath(scope.path);
    if (canonicalPath === undefined)
      return {
        ok: false,
        error: new RecallBudgetError(
          "scope-widened",
          "scope path must be an absolute path without dot segments",
        ),
      };
    scope.path = canonicalPath;
  }
  return { ok: true, value: Object.freeze(scope) };
}

export function inheritRecallScope(parent: RecallScope, child: RecallScope = {}): ScopeValidation {
  const parentResult = validateRecallScope(parent);
  if (!parentResult.ok) return parentResult;
  const childResult = validateRecallScope(child);
  if (!childResult.ok) return childResult;
  for (const [key, childValue] of Object.entries(childResult.value)) {
    if (!scopeValueNarrower(parentResult.value[key], childValue, key))
      return {
        ok: false,
        error: new RecallBudgetError("scope-widened", `child scope widens parent field ${key}`),
      };
  }
  return {
    ok: true,
    value: Object.freeze({ ...parentResult.value, ...childResult.value }),
  };
}

export function scopeHash(scope: RecallScope): string {
  return sha256(stableStringify(scope));
}
