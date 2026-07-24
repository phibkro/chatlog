import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import {
  chmod,
  open,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  durableAtomicWrite,
  ensurePrivateDirectory,
  readBoundedText,
} from "./durable-fs";
import type { AgentRole } from "./role-segmentation";
import type {
  WorkflowPattern,
  WorkflowPatternSignal,
  WorkflowPatternsArtifact,
} from "./workflow-patterns";
import type { WorkflowEventKind } from "./workflow-evolution";

export const PATTERN_ANNOTATION_SCHEMA =
  "chatlog/workflow-pattern-annotation-v1" as const;
export const PATTERN_ANNOTATION_MANIFEST_SCHEMA =
  "chatlog/workflow-pattern-annotation-manifest-v1" as const;

const MAX_RECORD_BYTES = 16 * 1024;
const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_HISTORY = 10_000;
const MAX_LABEL = 120;
const MAX_NOTE = 1_000;
const HANDLE_LENGTH = 24;
const LOCK_WAIT_ATTEMPTS = 400;
const LOCK_WAIT_MS = 5;

const KINDS = new Set<WorkflowEventKind>([
  "approval-gate-changed",
  "autonomy-boundary",
  "ownership-boundary",
]);
const SIGNALS = new Set<WorkflowPatternSignal>([
  "self-propel",
  "tracer-and-continue",
  "recommend-and-proceed",
  "dont-wait-for-approval",
  "one-writer",
  "spec-freeze",
  "gate-before-act",
  "stop-and-report",
  "ab-with-recommendation",
  "approval-policy",
  "autonomy-general",
  "ownership-general",
]);
const ROLES = new Set<AgentRole>([
  "manager",
  "worker",
  "reviewer",
  "advisor",
  "unclassified",
]);

export type PatternAnnotationDisposition =
  | "unreviewed"
  | "confirmed"
  | "contextual"
  | "dismissed";

export interface PatternIdentity {
  kind: WorkflowEventKind;
  signal: WorkflowPatternSignal;
  role: AgentRole;
}

interface PatternAnnotationBody {
  schema: typeof PATTERN_ANNOTATION_SCHEMA;
  handle: string;
  pattern: PatternIdentity;
  previousContentHash: string | null;
  revision: number;
  patternArtifactContentHash: string;
  createdAt: string;
  disposition: PatternAnnotationDisposition;
  label: string | null;
  note: string | null;
}

interface PersistedPatternAnnotation extends PatternAnnotationBody {
  contentHash: string;
}

interface PatternAnnotationManifestBody {
  schema: typeof PATTERN_ANNOTATION_MANIFEST_SCHEMA;
  revision: number;
  updatedAt: string;
  current: Record<string, string>;
}

interface PersistedPatternAnnotationManifest
  extends PatternAnnotationManifestBody {
  integrityHash: string;
}

export interface PublicPatternAnnotation {
  disposition: PatternAnnotationDisposition;
  label: string | null;
  note: string | null;
  revision: number;
  updatedAt: string;
}

export interface PatternAnnotationWriteInput {
  handle: string;
  expectedRevision: number;
  observedSnapshot: string;
  disposition: PatternAnnotationDisposition;
  label?: unknown;
  note?: unknown;
}

export interface PatternAnnotationView {
  enabled: boolean;
  snapshot: string;
  summary: {
    activeAnnotated: number;
    unreviewed: number;
    confirmed: number;
    contextual: number;
    dismissed: number;
    inactivePatternAnnotations: number;
  };
  annotations: Record<string, PublicPatternAnnotation>;
}

export class PatternAnnotationConflictError extends Error {
  constructor(
    readonly current: PublicPatternAnnotation | null,
    readonly snapshot: string,
  ) {
    super("pattern annotation changed or the pattern artifact was refreshed");
    this.name = "PatternAnnotationConflictError";
  }
}

export class PatternAnnotationIntegrityError extends Error {
  constructor(message: string, options: ErrorOptions = {}) {
    super(message, options);
    this.name = "PatternAnnotationIntegrityError";
  }
}

export class PatternAnnotationBusyError extends Error {
  constructor() {
    super("pattern annotation store is busy; retry");
    this.name = "PatternAnnotationBusyError";
  }
}

function sha256(value: string): string {
  return new Bun.CryptoHasher("sha256").update(value).digest("hex");
}

function canonicalIdentity(identity: PatternIdentity): string {
  return JSON.stringify({
    kind: identity.kind,
    signal: identity.signal,
    role: identity.role,
  });
}

export function patternHandle(
  pattern: Pick<WorkflowPattern, "kind" | "signal" | "role">,
): string {
  return sha256(
    `chatlog/workbench-pattern-handle-v1:${canonicalIdentity(pattern)}`,
  ).slice(0, HANDLE_LENGTH);
}

export function patternArtifactSnapshot(contentHash: string): string {
  validateHash(contentHash, "pattern artifact content hash");
  return sha256(
    `chatlog/workbench-pattern-snapshot-v1:${contentHash}`,
  ).slice(0, HANDLE_LENGTH);
}

function validateHash(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value))
    throw new PatternAnnotationIntegrityError(`${label} is not a SHA-256 hash`);
  return value;
}

function validateHandle(value: unknown, label = "pattern handle"): string {
  if (
    typeof value !== "string"
    || !new RegExp(`^[a-f0-9]{${HANDLE_LENGTH}}$`).test(value)
  ) throw new Error(`${label} is invalid`);
  return value;
}

function validateTimestamp(value: unknown, label: string): string {
  if (typeof value !== "string")
    throw new PatternAnnotationIntegrityError(`${label} is invalid`);
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.valueOf()) || parsed.toISOString() !== value)
    throw new PatternAnnotationIntegrityError(
      `${label} is not a canonical ISO-8601 timestamp`,
    );
  return value;
}

function validateIdentity(value: unknown): PatternIdentity {
  const identity = value as PatternIdentity;
  if (
    !identity
    || typeof identity !== "object"
    || !KINDS.has(identity.kind)
    || !SIGNALS.has(identity.signal)
    || !ROLES.has(identity.role)
  ) throw new PatternAnnotationIntegrityError("pattern identity is invalid");
  return {
    kind: identity.kind,
    signal: identity.signal,
    role: identity.role,
  };
}

function validateRevision(value: unknown, label: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum)
    throw new PatternAnnotationIntegrityError(`${label} is invalid`);
  return Number(value);
}

function validateInputRevision(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0)
    throw new Error("expected annotation revision is invalid");
  return Number(value);
}

function normalizeText(
  value: unknown,
  label: string,
  maximum: number,
  singleLine = false,
): string | null {
  if (value == null) return null;
  if (typeof value !== "string") throw new Error(`${label} must be text`);
  const normalized = value.trim();
  if (!normalized) return null;
  if (normalized.length > maximum)
    throw new Error(`${label} exceeds ${maximum} characters`);
  if (
    /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u061C\u200B\u200E\u200F\u2028\u2029\u202A-\u202E\u2060-\u206F\uFEFF]/u
      .test(normalized)
  )
    throw new Error(`${label} contains unsupported control characters`);
  if (singleLine && /[\t\r\n]/u.test(normalized))
    throw new Error(`${label} must be a single line`);
  return normalized;
}

function annotationPath(root: string, contentHash: string): string {
  validateHash(contentHash, "annotation content hash");
  return join(
    root,
    "annotations",
    "objects",
    contentHash.slice(0, 2),
    `${contentHash}.json`,
  );
}

function manifestPath(root: string): string {
  return join(root, "annotations", "workflow-patterns-manifest.json");
}

function lockPath(root: string): string {
  return join(root, "annotations", "workflow-patterns-lock.sqlite");
}

function sealManifest(
  body: PatternAnnotationManifestBody,
): PersistedPatternAnnotationManifest {
  return { ...body, integrityHash: sha256(JSON.stringify(body)) };
}

function emptyManifest(now: string): PatternAnnotationManifestBody {
  return {
    schema: PATTERN_ANNOTATION_MANIFEST_SCHEMA,
    revision: 0,
    updatedAt: now,
    current: {},
  };
}

function publicAnnotation(
  record: PersistedPatternAnnotation,
): PublicPatternAnnotation {
  return {
    disposition: record.disposition,
    label: record.label,
    note: record.note,
    revision: record.revision,
    updatedAt: record.createdAt,
  };
}

function validateRecord(
  value: unknown,
  expectedContentHash: string,
): PersistedPatternAnnotation {
  const persisted = value as PersistedPatternAnnotation;
  if (persisted?.schema !== PATTERN_ANNOTATION_SCHEMA)
    throw new PatternAnnotationIntegrityError("unsupported annotation record");
  const contentHash = validateHash(
    persisted.contentHash,
    "annotation record content hash",
  );
  if (contentHash !== expectedContentHash)
    throw new PatternAnnotationIntegrityError(
      "annotation filename/content hash mismatch",
    );
  const pattern = validateIdentity(persisted.pattern);
  const handle = validateHandle(persisted.handle);
  if (handle !== patternHandle(pattern))
    throw new PatternAnnotationIntegrityError(
      "annotation handle does not match pattern identity",
    );
  const revision = validateRevision(
    persisted.revision,
    "annotation revision",
    1,
  );
  const previousContentHash = persisted.previousContentHash == null
    ? null
    : validateHash(
      persisted.previousContentHash,
      "previous annotation content hash",
    );
  if (
    (revision === 1 && previousContentHash !== null)
    || (revision > 1 && previousContentHash === null)
  ) throw new PatternAnnotationIntegrityError(
    "annotation predecessor does not match revision",
  );
  validateHash(
    persisted.patternArtifactContentHash,
    "annotation pattern artifact hash",
  );
  const disposition = persisted.disposition;
  if (
    !["unreviewed", "confirmed", "contextual", "dismissed"]
      .includes(disposition)
  ) throw new PatternAnnotationIntegrityError(
    "annotation disposition is invalid",
  );
  const label = normalizeText(
    persisted.label,
    "annotation label",
    MAX_LABEL,
    true,
  );
  const note = normalizeText(persisted.note, "annotation note", MAX_NOTE);
  const body: PatternAnnotationBody = {
    schema: PATTERN_ANNOTATION_SCHEMA,
    handle,
    pattern,
    previousContentHash,
    revision,
    patternArtifactContentHash: persisted.patternArtifactContentHash,
    createdAt: validateTimestamp(
      persisted.createdAt,
      "annotation creation time",
    ),
    disposition,
    label,
    note,
  };
  if (sha256(JSON.stringify(body)) !== contentHash)
    throw new PatternAnnotationIntegrityError(
      "annotation record integrity check failed",
    );
  return { ...body, contentHash };
}

async function loadRecord(
  root: string,
  contentHash: string,
): Promise<PersistedPatternAnnotation> {
  const path = annotationPath(root, contentHash);
  let text: string;
  try {
    text = await readBoundedText(
      path,
      MAX_RECORD_BYTES,
      "annotation record",
    );
  } catch (error) {
    throw new PatternAnnotationIntegrityError(
      "annotation record is unavailable",
      { cause: error },
    );
  }
  try {
    return validateRecord(JSON.parse(text), contentHash);
  } catch (error) {
    if (error instanceof PatternAnnotationIntegrityError) throw error;
    throw new PatternAnnotationIntegrityError(
      "annotation record is malformed",
      { cause: error },
    );
  }
}

async function assertHistory(
  root: string,
  current: PersistedPatternAnnotation,
): Promise<PersistedPatternAnnotation[]> {
  const history = [current];
  let cursor = current;
  const seen = new Set([current.contentHash]);
  while (cursor.previousContentHash) {
    if (history.length >= MAX_HISTORY)
      throw new PatternAnnotationIntegrityError(
        "annotation history exceeds bound",
      );
    if (seen.has(cursor.previousContentHash))
      throw new PatternAnnotationIntegrityError(
        "annotation history contains a cycle",
      );
    const previous = await loadRecord(root, cursor.previousContentHash);
    if (
      previous.handle !== current.handle
      || canonicalIdentity(previous.pattern)
        !== canonicalIdentity(current.pattern)
      || previous.revision !== cursor.revision - 1
    ) throw new PatternAnnotationIntegrityError(
      "annotation predecessor link is invalid",
    );
    seen.add(previous.contentHash);
    history.push(previous);
    cursor = previous;
  }
  if (cursor.revision !== 1)
    throw new PatternAnnotationIntegrityError(
      "annotation history does not terminate at revision one",
    );
  return history;
}

function annotationObjectsExist(root: string): boolean {
  const directory = join(root, "annotations", "objects");
  if (!existsSync(directory)) return false;
  return [...new Bun.Glob("**/*").scanSync({
    cwd: directory,
    onlyFiles: true,
  })].length > 0;
}

async function loadManifest(
  root: string,
): Promise<PatternAnnotationManifestBody | null> {
  const path = manifestPath(root);
  let text: string;
  try {
    text = await readBoundedText(
      path,
      MAX_MANIFEST_BYTES,
      "annotation manifest",
    );
  } catch (error: any) {
    if (error?.code === "ENOENT" || error?.cause?.code === "ENOENT") {
      if (annotationObjectsExist(root))
        throw new PatternAnnotationIntegrityError(
          "annotation manifest is missing while annotation objects remain",
        );
      return null;
    }
    throw new PatternAnnotationIntegrityError(
      "annotation manifest is unavailable",
      { cause: error },
    );
  }
  let persisted: PersistedPatternAnnotationManifest;
  try {
    persisted = JSON.parse(text) as PersistedPatternAnnotationManifest;
  } catch (error) {
    throw new PatternAnnotationIntegrityError(
      "annotation manifest is malformed",
      { cause: error },
    );
  }
  if (persisted?.schema !== PATTERN_ANNOTATION_MANIFEST_SCHEMA)
    throw new PatternAnnotationIntegrityError(
      "unsupported annotation manifest",
    );
  const { integrityHash, ...body } = persisted;
  validateHash(integrityHash, "annotation manifest integrity hash");
  if (sha256(JSON.stringify(body)) !== integrityHash)
    throw new PatternAnnotationIntegrityError(
      "annotation manifest integrity check failed",
    );
  const revision = validateRevision(body.revision, "manifest revision");
  const updatedAt = validateTimestamp(
    body.updatedAt,
    "manifest update time",
  );
  if (!body.current || typeof body.current !== "object")
    throw new PatternAnnotationIntegrityError(
      "annotation manifest current map is invalid",
    );
  const current: Record<string, string> = {};
  for (const [handle, contentHash] of Object.entries(body.current).sort()) {
    current[validateHandle(handle)] = validateHash(
      contentHash,
      "manifest current content hash",
    );
  }
  return {
    schema: PATTERN_ANNOTATION_MANIFEST_SCHEMA,
    revision,
    updatedAt,
    current,
  };
}

async function writeManifest(
  root: string,
  body: PatternAnnotationManifestBody,
): Promise<void> {
  await durableAtomicWrite(
    manifestPath(root),
    JSON.stringify(sealManifest(body), null, 2) + "\n",
    { maxBytes: MAX_MANIFEST_BYTES },
  );
}

interface LoadedAnnotationState {
  manifest: PatternAnnotationManifestBody | null;
  current: Map<string, PersistedPatternAnnotation>;
}

async function loadState(root: string): Promise<LoadedAnnotationState> {
  const manifest = await loadManifest(root);
  const current = new Map<string, PersistedPatternAnnotation>();
  if (!manifest) return { manifest, current };
  for (const [handle, contentHash] of Object.entries(manifest.current)) {
    const record = await loadRecord(root, contentHash);
    if (record.handle !== handle)
      throw new PatternAnnotationIntegrityError(
        "manifest handle does not match annotation record",
      );
    await assertHistory(root, record);
    current.set(handle, record);
  }
  return { manifest, current };
}

async function acquireLock(root: string): Promise<Database> {
  const directory = join(root, "annotations");
  await ensurePrivateDirectory(directory);
  const path = lockPath(root);
  const file = await open(path, "a", 0o600);
  await file.close();
  await chmod(path, 0o600);
  const database = new Database(path, { create: true });
  database.exec("PRAGMA busy_timeout = 0");
  for (let attempt = 0; attempt < LOCK_WAIT_ATTEMPTS; attempt++) {
    try {
      database.exec("BEGIN IMMEDIATE");
      return database;
    } catch (error: any) {
      if (
        error?.code !== "SQLITE_BUSY"
        && !String(error?.message ?? "").includes("database is locked")
      ) {
        database.close();
        throw error;
      }
      await Bun.sleep(LOCK_WAIT_MS);
    }
  }
  database.close();
  throw new PatternAnnotationBusyError();
}

function releaseLock(database: Database): void {
  try {
    database.exec("ROLLBACK");
  } finally {
    database.close();
  }
}

async function withAnnotationLock<T>(
  root: string,
  work: () => Promise<T>,
): Promise<T> {
  const lock = await acquireLock(root);
  try {
    return await work();
  } finally {
    releaseLock(lock);
  }
}

function activePatterns(
  artifact: WorkflowPatternsArtifact,
): Map<string, WorkflowPattern> {
  const patterns = new Map<string, WorkflowPattern>();
  for (const pattern of artifact.patterns) {
    const handle = patternHandle(pattern);
    if (patterns.has(handle))
      throw new PatternAnnotationIntegrityError(
        "workflow pattern handle collision",
      );
    patterns.set(handle, pattern);
  }
  return patterns;
}

export async function loadPatternAnnotationView(
  root: string,
  artifact: WorkflowPatternsArtifact,
  artifactContentHash: string,
  enabled: boolean,
): Promise<PatternAnnotationView> {
  const state = await loadState(resolve(root));
  const patterns = activePatterns(artifact);
  const annotations: Record<string, PublicPatternAnnotation> = {};
  const summary = {
    activeAnnotated: 0,
    unreviewed: 0,
    confirmed: 0,
    contextual: 0,
    dismissed: 0,
    inactivePatternAnnotations: 0,
  };
  for (const [handle, record] of state.current) {
    if (!patterns.has(handle)) {
      summary.inactivePatternAnnotations++;
      continue;
    }
    annotations[handle] = publicAnnotation(record);
    summary.activeAnnotated++;
    summary[record.disposition]++;
  }
  return {
    enabled,
    snapshot: patternArtifactSnapshot(artifactContentHash),
    summary,
    annotations,
  };
}

export async function writePatternAnnotation(
  root: string,
  input: PatternAnnotationWriteInput,
  context: {
    artifact: WorkflowPatternsArtifact;
    artifactContentHash: string;
    now?: string;
    afterObjectWrite?: (
      record: PersistedPatternAnnotation,
    ) => Promise<void> | void;
  },
): Promise<PublicPatternAnnotation> {
  const resolvedRoot = resolve(root);
  const snapshot = patternArtifactSnapshot(context.artifactContentHash);
  const handle = validateHandle(input.handle);
  const expectedRevision = validateInputRevision(input.expectedRevision);
  const patterns = activePatterns(context.artifact);
  const pattern = patterns.get(handle);
  if (!pattern) throw new Error("workflow pattern is not currently active");
  if (
    !["unreviewed", "confirmed", "contextual", "dismissed"]
      .includes(input.disposition)
  ) throw new Error("annotation disposition is invalid");
  const label = normalizeText(
    input.label,
    "annotation label",
    MAX_LABEL,
    true,
  );
  const note = normalizeText(input.note, "annotation note", MAX_NOTE);
  const now = context.now ?? new Date().toISOString();
  validateTimestamp(now, "annotation creation time");

  return withAnnotationLock(resolvedRoot, async () => {
    let state = await loadState(resolvedRoot);
    const current = state.current.get(handle) ?? null;
    if (input.observedSnapshot !== snapshot)
      throw new PatternAnnotationConflictError(
        current ? publicAnnotation(current) : null,
        snapshot,
      );
    if (!state.manifest) {
      const genesis = emptyManifest(now);
      await writeManifest(resolvedRoot, genesis);
      state = { manifest: genesis, current: new Map() };
    }
    if ((current?.revision ?? 0) !== expectedRevision)
      throw new PatternAnnotationConflictError(
        current ? publicAnnotation(current) : null,
        snapshot,
      );
    const body: PatternAnnotationBody = {
      schema: PATTERN_ANNOTATION_SCHEMA,
      handle,
      pattern: {
        kind: pattern.kind,
        signal: pattern.signal,
        role: pattern.role,
      },
      previousContentHash: current?.contentHash ?? null,
      revision: expectedRevision + 1,
      patternArtifactContentHash: context.artifactContentHash,
      createdAt: now,
      disposition: input.disposition,
      label,
      note,
    };
    const contentHash = sha256(JSON.stringify(body));
    const record = { ...body, contentHash };
    await durableAtomicWrite(
      annotationPath(resolvedRoot, contentHash),
      JSON.stringify(record, null, 2) + "\n",
      { maxBytes: MAX_RECORD_BYTES },
    );
    await context.afterObjectWrite?.(record);
    const currentMap = Object.fromEntries(
      Object.entries({
        ...state.manifest.current,
        [handle]: contentHash,
      }).sort(([left], [right]) => left.localeCompare(right)),
    );
    await writeManifest(resolvedRoot, {
      schema: PATTERN_ANNOTATION_MANIFEST_SCHEMA,
      revision: state.manifest.revision + 1,
      updatedAt: now,
      current: currentMap,
    });
    return publicAnnotation(record);
  });
}

export async function loadPatternAnnotationHistory(
  root: string,
  handleValue: string,
): Promise<PublicPatternAnnotation[]> {
  const handle = validateHandle(handleValue);
  const state = await loadState(resolve(root));
  const current = state.current.get(handle);
  if (!current) return [];
  return (await assertHistory(resolve(root), current))
    .map(publicAnnotation);
}
