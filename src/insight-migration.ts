import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  compileInsightProjection,
  makeInsightCurrentPointer,
  SUPPORTED_INSIGHT_RISK_CLASSES,
  type CompiledInsightSnapshot,
} from "./insight-compiler";
import {
  createEmptyInsightLedger,
  insightLedgerHash,
  readInsightPublicationContext,
  saveInsightLedger,
} from "./insight-ledger";
import {
  insightScope,
  projectInsightState,
  type InsightAuthorityRecord,
  type InsightCurrentPointer,
  type InsightLedgerSnapshot,
  type InsightProjection,
  type InsightRevision,
  type InsightTransition,
} from "./insights";
import {
  loadAcceptedMemoryLedger,
  verifyAcceptedLedgerProvenance,
} from "./experience-memory-store";
import type {
  AcceptedMemoryEntry,
  AcceptedMemoryLedger,
  ExperienceMemoryResult,
} from "./experience-memory";
import { stableStringify } from "./events";

const MIGRATION_RECIPE = "experience-memory-v1-to-insight-v2";
const MIGRATION_TIME = "1970-01-01T00:00:00.000Z";

export interface InsightMigrationResult {
  dryRun: boolean;
  sourceLedgerHash: string;
  sourceLedgerPath: string;
  ledger: InsightLedgerSnapshot;
  projection: InsightProjection;
  compiled: CompiledInsightSnapshot;
  pointer: InsightCurrentPointer;
  wrote: boolean;
}

export interface InsightMigrationOptions {
  ledgerPath?: string;
  projectIdentity?: string;
  dryRun?: boolean;
}

export interface InsightMigrationError {
  code:
    | "missing-ledger"
    | "invalid-ledger"
    | "invalid-provenance"
    | "compile-failed"
    | "storage-error";
  message: string;
  issues?: string[];
}

export type InsightMigrationResponse =
  | { ok: true; value: InsightMigrationResult }
  | { ok: false; error: InsightMigrationError };

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function bytes(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function migrationKind(entry: AcceptedMemoryEntry): InsightRevision["kind"] {
  if (entry.polarity === "prefer") return "preference";
  if (entry.polarity === "avoid" || entry.polarity === "check") return "procedure";
  return "fact";
}

function migrationScope(entry: AcceptedMemoryEntry): ReturnType<typeof insightScope> {
  const axis = entry.scope.kind;
  const value = entry.scope.value;
  if (axis === "global") return insightScope({ domain: "coding" });
  if (axis === "repository") return insightScope({ repository: value, domain: "coding" });
  if (axis === "path") return insightScope({ path: value, domain: "coding" });
  if (axis === "tool") return insightScope({ tool: value, domain: "coding" });
  if (axis === "model") return insightScope({ model: value, domain: "coding" });
  if (axis === "harness") return insightScope({ harness: value, domain: "coding" });
  return insightScope({ domain: "coding" });
}

function documentReferences(entry: AcceptedMemoryEntry): InsightRevision["authoritativeDocs"] {
  return entry.canonicalDocs.map((uri) => ({ uri, observedHash: null }));
}

function authority(entry: AcceptedMemoryEntry, sourceLedgerHash: string): InsightAuthorityRecord {
  return {
    kind: "human-review",
    actor: "v1-operator-review",
    authority: "verified v1 accepted-memory provenance migrated without changing evidence",
    assertedAt: MIGRATION_TIME,
    sourceHashes: [
      sourceLedgerHash,
      entry.provenance.packetHash,
      entry.provenance.proposalSetHash,
      entry.provenance.operatorReviewHash,
    ],
  };
}

function migrateEntry(entry: AcceptedMemoryEntry, sourceLedgerHash: string): InsightRevision {
  const sourceHashes = [
    sourceLedgerHash,
    entry.provenance.packetHash,
    entry.provenance.proposalSetHash,
    entry.provenance.operatorReviewHash,
  ];
  const proposition = entry.lesson;
  const revisionSeed = stableStringify({
    id: entry.id,
    sourceHashes,
    proposition,
    procedure: entry.action,
  });
  return {
    schemaVersion: 2,
    insightId: entry.id,
    revisionId: `rev-${hash(revisionSeed).slice(0, 40)}`,
    kind: migrationKind(entry),
    proposition,
    procedure: entry.action,
    scope: migrationScope(entry),
    supportEvidence: [...entry.evidencePointers],
    counterEvidence: [],
    observedAt: MIGRATION_TIME,
    validTime: { start: MIGRATION_TIME, end: null },
    recordedAt: MIGRATION_TIME,
    status: "active",
    supersedes: null,
    conflictsWith: [],
    duplicateOf: null,
    riskClass: "low",
    valence: entry.valence === "negative" ? "negative" : "positive",
    origin: {
      kind: "human-review",
      actor: "v1-operator-review",
      sourceHashes,
      proposalId: entry.provenance.candidateId,
    },
    authority: [authority(entry, sourceLedgerHash)],
    derivation: {
      activity: "v1-accepted-memory-migration",
      recipe: MIGRATION_RECIPE,
      model: null,
      inputHashes: sourceHashes,
    },
    confidence: [
      {
        assessor: "v1-operator-review",
        role: "human",
        value: entry.confidence,
        evidence: [...entry.evidencePointers],
        assessedAt: MIGRATION_TIME,
      },
    ],
    authoritativeDocs: documentReferences(entry),
  };
}

function appendMigrationRevision(
  ledger: InsightLedgerSnapshot,
  revision: InsightRevision,
  sourceLedgerHash: string,
): InsightLedgerSnapshot {
  const transitionBase = {
    schemaVersion: 2 as const,
    transitionId: `migration-${hash(`${sourceLedgerHash}:${revision.revisionId}`).slice(0, 40)}`,
    command: "accept" as const,
    insightId: revision.insightId,
    revision,
    priorRevisionId: null,
    relatedInsightId: null,
    relatedRevisionId: null,
    actor: { id: "v1-migration", kind: "operator" as const },
    authority: revision.authority[0]!,
    recordedAt: MIGRATION_TIME,
    reason: "deterministic migration of verified v1 accepted memory",
    sourceHashes: [...revision.origin.sourceHashes],
    priorLedgerHash: ledger.ledgerHash,
  };
  const commandHash = hash(stableStringify(transitionBase));
  const transition: InsightTransition = { ...transitionBase, commandHash };
  const base: Omit<InsightLedgerSnapshot, "ledgerHash"> = {
    schemaVersion: 2,
    ledgerId: ledger.ledgerId,
    projectIdentity: ledger.projectIdentity,
    previousLedgerHash: ledger.ledgerHash,
    transitions: [...ledger.transitions, transition],
  };
  return { ...base, ledgerHash: insightLedgerHash(base) };
}

async function writePrivate(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, content, { mode: 0o600, flag: "wx" });
  await chmod(temporary, 0o600);
  await rename(temporary, path);
  await chmod(path, 0o600);
}

async function sourceLedger(
  root: string,
  path: string,
): Promise<ExperienceMemoryResult<{ ledger: AcceptedMemoryLedger; hash: string }>> {
  const loaded = await loadAcceptedMemoryLedger(path);
  if (!loaded.ok) return loaded;
  const verified = await verifyAcceptedLedgerProvenance(root, loaded.value);
  if (!verified.ok) return verified;
  const content = await Bun.file(path).text();
  return { ok: true, value: { ledger: verified.value, hash: hash(content) } };
}

export async function previewInsightMigration(
  root: string,
  options: Omit<InsightMigrationOptions, "dryRun"> = {},
): Promise<InsightMigrationResponse> {
  return migrateInsightLedger(root, { ...options, dryRun: true });
}

export async function migrateInsightLedger(
  root: string,
  options: InsightMigrationOptions = {},
): Promise<InsightMigrationResponse> {
  const sourceLedgerPath = resolve(
    options.ledgerPath ?? join(root, "memory", "accepted-ledger.json"),
  );
  let loaded: Awaited<ReturnType<typeof sourceLedger>>;
  try {
    loaded = await sourceLedger(root, sourceLedgerPath);
  } catch (error) {
    return {
      ok: false,
      error: {
        code: "storage-error",
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
  if (!loaded.ok)
    return {
      ok: false,
      error: {
        code: loaded.error.code === "storage-error" ? "storage-error" : "invalid-provenance",
        message: loaded.error.message,
        issues: loaded.error.issues,
      },
    };
  const sourceLedgerHash = loaded.value.hash;
  const projectIdentity = options.projectIdentity ?? loaded.value.ledger.projectIdentity;
  let ledger = createEmptyInsightLedger(
    projectIdentity,
    `insight-ledger-v2-${sourceLedgerHash.slice(0, 16)}`,
  );
  for (const entry of loaded.value.ledger.entries.toSorted((left, right) =>
    left.id.localeCompare(right.id),
  ))
    ledger = appendMigrationRevision(
      ledger,
      migrateEntry(entry, sourceLedgerHash),
      sourceLedgerHash,
    );
  let projection: InsightProjection;
  try {
    projection = projectInsightState(ledger);
  } catch (error) {
    return {
      ok: false,
      error: {
        code: "invalid-ledger",
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
  const contextResult = await readInsightPublicationContext(root);
  if (contextResult && !contextResult.ok)
    return { ok: false, error: { code: "storage-error", message: contextResult.error.message } };
  const context = contextResult?.value;
  const compiledResult = compileInsightProjection(projection, {
    projectIdentity,
    supportedRiskClasses: SUPPORTED_INSIGHT_RISK_CLASSES,
    ...(context ? { activeEvidence: context.activeEvidence } : {}),
  });
  if (!compiledResult.ok)
    return { ok: false, error: { code: "compile-failed", message: compiledResult.error } };
  const compiled = compiledResult.value;
  const inputProjectionHash =
    context?.inputProjectionHash ?? hash(`${MIGRATION_RECIPE}:${sourceLedgerHash}`);
  const sourceAuthorityHash =
    context?.sourceAuthorityHash ??
    hash(`v1-source-authority:${loaded.value.ledger.projectIdentity}`);
  const recipeHashes = { migration: hash(MIGRATION_RECIPE) };
  const pointer = makeInsightCurrentPointer({
    projectIdentity,
    inputProjectionHash,
    sourceAuthorityHash,
    recipeHashes,
    ledgerHash: ledger.ledgerHash,
    compiledAt: compiled.compiledAt,
    compiledStateHash: compiled.compiledStateHash,
    outputHash: compiled.outputHash,
  });
  const result: InsightMigrationResult = {
    dryRun: options.dryRun !== false,
    sourceLedgerHash,
    sourceLedgerPath,
    ledger,
    projection,
    compiled,
    pointer,
    wrote: false,
  };
  if (options.dryRun !== false) return { ok: true, value: result };
  const saved = await saveInsightLedger(root, ledger);
  if (!saved.ok)
    return { ok: false, error: { code: "storage-error", message: saved.error.message } };
  try {
    await writePrivate(join(resolve(root), "memory", "insight-current.json"), bytes(pointer));
    await writePrivate(
      join(resolve(root), "memory", "insight-compiled", `${compiled.outputHash}.json`),
      bytes(compiled),
    );
  } catch (error) {
    return {
      ok: false,
      error: {
        code: "storage-error",
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
  return { ok: true, value: { ...result, dryRun: false, wrote: true } };
}

export async function applyInsightMigration(
  root: string,
  options: Omit<InsightMigrationOptions, "dryRun"> = {},
): Promise<InsightMigrationResponse> {
  return migrateInsightLedger(root, { ...options, dryRun: false });
}
