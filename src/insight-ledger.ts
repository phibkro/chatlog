import { createHash, randomUUID } from "node:crypto";
import { Database } from "bun:sqlite";
import { chmod, mkdir, open, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  INSIGHT_LEDGER_SCHEMA_VERSION,
  activeInsightRevisions,
  projectInsightState,
  validateInsightCurrentPointer,
  validateInsightLedger,
  validateInsightTransition,
  type InsightAuthorityRecord,
  type InsightCurrentPointer,
  type InsightLedgerSnapshot,
  type InsightProjection,
  type InsightRevision,
  type InsightStatus,
  type InsightTransition,
  type InsightTransitionCommand,
} from "./insights";
import {
  compileInsightProjection,
  makeInsightCurrentPointer,
  SUPPORTED_INSIGHT_RISK_CLASSES,
  type CompiledInsightSnapshot,
} from "./insight-compiler";
import { rebuildInsightProjection } from "./insight-projection";
import { eventEvidenceUri } from "./evidence-uri";
import { stableStringify } from "./events";

const HASH = /^[a-f0-9]{64}$/u;

export interface InsightCommandInput {
  command: InsightTransitionCommand;
  insightId: string;
  revision: InsightRevision;
  priorRevisionId: string | null;
  relatedInsightId?: string | null;
  relatedRevisionId?: string | null;
  actor: { id: string; kind: "human" | "operator" | "system" };
  authority: InsightAuthorityRecord;
  recordedAt: string;
  reason: string;
  sourceHashes: string[];
  priorLedgerHash: string | null;
  idempotencyKey?: string;
}

export interface InsightLedgerError {
  code:
    | "invalid-ledger"
    | "invalid-command"
    | "invalid-transition"
    | "stale-ledger"
    | "unauthorized-transition"
    | "invalid-status"
    | "storage-error"
    | "lock-conflict";
  message: string;
  issues?: string[];
}

export type InsightLedgerResult<T> =
  | { ok: true; value: T; idempotent?: boolean }
  | { ok: false; error: InsightLedgerError };

function hashBytes(bytes: string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function jsonBytes(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function insightLedgerHash(
  ledger: Omit<InsightLedgerSnapshot, "ledgerHash"> | InsightLedgerSnapshot,
): string {
  const { ledgerHash: _ledgerHash, ...payload } = ledger as InsightLedgerSnapshot;
  return hashBytes(stableStringify(payload));
}

function commandHash(input: Omit<InsightCommandInput, "idempotencyKey">): string {
  return hashBytes(stableStringify(input));
}

function transitionId(input: InsightCommandInput, commandDigest: string): string {
  const requested = input.idempotencyKey?.trim();
  if (requested) return requested.toLowerCase();
  return `tr-${commandDigest.slice(0, 40)}`;
}
function storageFailure(error: unknown): InsightLedgerResult<never> {
  return {
    ok: false,
    error: {
      code: "storage-error",
      message: error instanceof Error ? error.message : String(error),
    },
  };
}

function invalid<T>(
  code: InsightLedgerError["code"],
  message: string,
  issues?: string[],
): InsightLedgerResult<T> {
  return { ok: false, error: { code, message, ...(issues ? { issues } : {}) } };
}

function revisionStatus(command: InsightTransitionCommand): InsightStatus {
  switch (command) {
    case "accept":
    case "accept-with-correction":
    case "resolve-dispute":
    case "supersede":
      return "active";
    case "reject":
      return "rejected";
    case "dispute":
      return "disputed";
    case "expire":
      return "expired";
    case "retire":
      return "retired";
  }
}

function humanAuthority(authority: InsightAuthorityRecord): boolean {
  return authority.kind === "human-review" || authority.kind === "human-assertion";
}

function commandAllowed(
  command: InsightTransitionCommand,
  prior: InsightRevision | undefined,
  revision: InsightRevision,
  actor: InsightCommandInput["actor"],
  authority: InsightAuthorityRecord,
): string | undefined {
  if (actor.kind !== "human" && actor.kind !== "operator")
    return "only a human or operator can apply an insight transition";
  if (!humanAuthority(authority))
    return "transition authority must be human-review or human-assertion";
  if (revision.status !== revisionStatus(command))
    return `${command} requires revision status ${revisionStatus(command)}`;
  switch (command) {
    case "accept":
      if (prior && prior.status !== "candidate")
        return "accept requires a current candidate revision";
      if (
        prior &&
        (revision.proposition !== prior.proposition || revision.procedure !== prior.procedure)
      )
        return "accept cannot change proposition text; use accept-with-correction";
      break;
    case "accept-with-correction":
      if (prior && prior.status !== "candidate" && prior.status !== "disputed")
        return "accept-with-correction requires a candidate or disputed revision";
      break;
    case "reject":
      if (prior && prior.status !== "candidate") return "reject requires a candidate revision";
      break;
    case "dispute":
      if (!prior || prior.status !== "active") return "dispute requires a current active revision";
      if (revision.counterEvidence.length === 0) return "dispute requires counterevidence";
      break;
    case "resolve-dispute":
      if (!prior || prior.status !== "disputed")
        return "resolve-dispute requires a current disputed revision";
      if (revision.supportEvidence.length === 0) return "resolve-dispute requires support evidence";
      break;
    case "supersede":
      if (!prior || (prior.status !== "active" && prior.status !== "disputed"))
        return "supersede requires an active or disputed revision";
      if (revision.insightId === prior.insightId)
        return "supersede requires a replacement insight ID";
      break;
    case "expire":
      if (prior && prior.status !== "active" && prior.status !== "candidate")
        return "expire requires an active or candidate revision";
      break;
    case "retire":
      if (
        !prior ||
        (prior.status !== "active" && prior.status !== "disputed" && prior.status !== "expired")
      )
        return "retire requires an active, disputed, or expired revision";
      break;
  }
  if (revision.status === "active" && !revision.authority.some((record) => humanAuthority(record)))
    return "active revisions require a human authority record";
  return undefined;
}

function transitionValue(input: InsightCommandInput, digest: string): InsightTransition {
  return {
    schemaVersion: INSIGHT_LEDGER_SCHEMA_VERSION,
    transitionId: transitionId(input, digest),
    command: input.command,
    insightId: input.command === "supersede" ? input.revision.insightId : input.insightId,
    revision: input.revision,
    priorRevisionId: input.priorRevisionId,
    relatedInsightId: input.relatedInsightId ?? null,
    relatedRevisionId: input.relatedRevisionId ?? null,
    actor: input.actor,
    authority: input.authority,
    recordedAt: input.recordedAt,
    reason: input.reason,
    sourceHashes: [...input.sourceHashes],
    priorLedgerHash: input.priorLedgerHash,
    commandHash: digest,
  };
}

export function createEmptyInsightLedger(
  projectIdentity: string,
  ledgerId = "insight-ledger",
): InsightLedgerSnapshot {
  const base: Omit<InsightLedgerSnapshot, "ledgerHash"> = {
    schemaVersion: INSIGHT_LEDGER_SCHEMA_VERSION,
    ledgerId,
    projectIdentity,
    previousLedgerHash: null,
    transitions: [],
  };
  return { ...base, ledgerHash: insightLedgerHash(base) };
}

export function appendInsightTransition(
  ledger: InsightLedgerSnapshot,
  input: InsightCommandInput,
): InsightLedgerResult<InsightLedgerSnapshot> {
  const validatedLedger = validateInsightLedger(ledger);
  if (!validatedLedger.ok)
    return invalid(
      "invalid-ledger",
      "insight ledger failed validation",
      validatedLedger.errors.map((error) => `${error.path}: ${error.message}`),
    );
  const priorProjection = projectInsightState(ledger);
  const prior = priorProjection.current[input.insightId];
  const priorHashMatches =
    input.priorLedgerHash === ledger.ledgerHash ||
    (input.priorLedgerHash === null && ledger.transitions.length === 0);
  if (!priorHashMatches) {
    const existing = input.idempotencyKey
      ? ledger.transitions.find((item) => item.transitionId === input.idempotencyKey)
      : undefined;
    if (existing) {
      const digest = commandHash(input);
      if (existing.commandHash === digest) return { ok: true, value: ledger, idempotent: true };
    }
    return invalid("stale-ledger", "transition prior ledger hash is stale");
  }
  const digest = commandHash(input);
  const id = transitionId(input, digest);
  const existing = ledger.transitions.find((item) => item.transitionId === id);
  if (existing) {
    if (existing.commandHash === digest) return { ok: true, value: ledger, idempotent: true };
    return invalid("invalid-command", "idempotency key already names a different command");
  }
  if (input.command !== "supersede" && input.revision.insightId !== input.insightId)
    return invalid("invalid-command", "revision insightId must match command insightId");
  if ((prior?.revisionId ?? null) !== input.priorRevisionId)
    return invalid("stale-ledger", "prior revision does not match the current insight revision");
  const allowed = commandAllowed(
    input.command,
    prior,
    input.revision,
    input.actor,
    input.authority,
  );
  if (allowed)
    return invalid(
      input.actor.kind === "system" ? "unauthorized-transition" : "invalid-transition",
      allowed,
    );
  if (input.command === "supersede") {
    if (!input.relatedInsightId || input.relatedInsightId !== input.insightId)
      return invalid(
        "invalid-transition",
        "supersede relatedInsightId must identify the old insight",
      );
    if (input.relatedRevisionId !== prior?.revisionId)
      return invalid("stale-ledger", "supersede relatedRevisionId must match the old revision");
  }
  const transition = transitionValue(input, digest);
  const validatedTransition = validateInsightTransition(transition);
  if (!validatedTransition.ok)
    return invalid(
      "invalid-command",
      "transition failed validation",
      validatedTransition.errors.map((error) => `${error.path}: ${error.message}`),
    );
  const base: Omit<InsightLedgerSnapshot, "ledgerHash"> = {
    schemaVersion: ledger.schemaVersion,
    ledgerId: ledger.ledgerId,
    projectIdentity: ledger.projectIdentity,
    previousLedgerHash: ledger.ledgerHash,
    transitions: [...ledger.transitions, transition],
  };

  return { ok: true, value: { ...base, ledgerHash: insightLedgerHash(base) } };
}
export interface InsightPublicationContext {
  inputProjectionHash: string;
  sourceAuthorityHash: string;
  activeEvidence: ReadonlySet<string>;
}

function hashRows(value: unknown): string {
  return hashBytes(stableStringify(value));
}

export async function readInsightPublicationContext(
  root: string,
): Promise<InsightLedgerResult<InsightPublicationContext> | null> {
  const path = join(resolve(root), "analysis", "chatlog.sqlite");
  try {
    await stat(path);
    const db = new Database(path, { readonly: true, create: false });
    try {
      db.run("PRAGMA busy_timeout=5000");
      const sources = db
        .query(`SELECT source_path sourcePath, content_hash contentHash, event_batch_hash eventBatchHash,
        projection_hash projectionHash, receipt_hash receiptHash FROM active_sources ORDER BY source_path`)
        .all();
      const turns = db
        .query(
          `SELECT content_hash contentHash, turn_index turnIndex FROM current_turns ORDER BY content_hash, turn_index`,
        )
        .all() as Array<{ contentHash: string; turnIndex: number }>;
      const events = db
        .query(`SELECT e.batch_hash batchHash, e.event_id eventId FROM event_metadata e
        JOIN active_sources a ON a.event_batch_hash = e.batch_hash ORDER BY e.batch_hash, e.event_id`)
        .all() as Array<{ batchHash: string; eventId: string }>;
      const meta = db
        .query(
          "SELECT manifest_sources_hash manifestSourcesHash FROM active_projection_meta WHERE singleton = 1",
        )
        .get() as { manifestSourcesHash?: string } | null;
      const activeEvidence = new Set<string>();
      for (const row of turns)
        activeEvidence.add(`chatlog://conversation/${row.contentHash}/turn/${row.turnIndex}`);
      for (const row of events) activeEvidence.add(eventEvidenceUri(row.batchHash, row.eventId));
      return {
        ok: true,
        value: {
          inputProjectionHash: hashRows({ sources, turns, events }),
          sourceAuthorityHash:
            meta?.manifestSourcesHash && HASH.test(meta.manifestSourcesHash)
              ? meta.manifestSourcesHash
              : hashRows(sources),
          activeEvidence,
        },
      };
    } finally {
      db.close();
    }
  } catch (error: unknown) {
    const code =
      typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
    if (code === "ENOENT") return null;
    return storageFailure(error);
  }
}

export interface InsightPublication {
  pointer: InsightCurrentPointer;
  compiled: CompiledInsightSnapshot;
}

interface LockRecord {
  pid: number;
  runId: string;
  startedAt: string;
}

export async function withLedgerLock<T>(
  root: string,
  work: () => Promise<T>,
): Promise<T | undefined> {
  const path = join(resolve(root), "memory", "insight-ledgers", ".lock");
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const record: LockRecord = {
    pid: process.pid,
    runId: randomUUID(),
    startedAt: new Date().toISOString(),
  };
  for (let attempt = 0; ; attempt++) {
    try {
      const handle = await open(path, "wx", 0o600);
      await handle.writeFile(`${JSON.stringify(record)}\n`);
      await handle.close();
      await chmod(path, 0o600);
      break;
    } catch (error: unknown) {
      const code =
        typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
      if (code !== "EEXIST" || attempt > 0) throw error;
      let stale = false;
      try {
        const current = JSON.parse(await readFile(path, "utf8")) as Partial<LockRecord>;
        if (typeof current.pid === "number") {
          try {
            process.kill(current.pid, 0);
          } catch (probe: unknown) {
            stale =
              typeof probe === "object" &&
              probe !== null &&
              "code" in probe &&
              probe.code === "ESRCH";
          }
        }
      } catch {
        try {
          stale = Date.now() - (await stat(path)).mtimeMs > 6 * 60 * 60 * 1000;
        } catch {
          stale = true;
        }
      }
      if (!stale) return undefined;
      await unlink(path);
    }
  }
  try {
    return await work();
  } finally {
    try {
      const current = JSON.parse(await readFile(path, "utf8")) as Partial<LockRecord>;
      if (current.runId === record.runId) await unlink(path);
    } catch {
      /* lock cleanup must not replace the transition result */
    }
  }
}

async function atomicPrivateWrite(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
  await chmod(temporary, 0o600);
  await rename(temporary, path);
  await chmod(path, 0o600);
}

export function insightLedgerPath(root: string, ledgerHash: string): string {
  if (!HASH.test(ledgerHash)) throw new Error("ledger hash must be a SHA-256");
  return join(resolve(root), "memory", "insight-ledgers", `${ledgerHash}.json`);
}

export async function loadInsightLedger(
  root: string,
  ledgerHash: string,
): Promise<InsightLedgerResult<InsightLedgerSnapshot>> {
  try {
    const value: unknown = JSON.parse(await readFile(insightLedgerPath(root, ledgerHash), "utf8"));
    const validated = validateInsightLedger(value);
    if (!validated.ok)
      return invalid(
        "invalid-ledger",
        "insight ledger failed validation",
        validated.errors.map((error) => `${error.path}: ${error.message}`),
      );
    if (
      validated.value.ledgerHash !== ledgerHash ||
      insightLedgerHash(validated.value) !== ledgerHash
    )
      return invalid("invalid-ledger", "insight ledger content hash does not match its path");
    return { ok: true, value: validated.value };
  } catch (error) {
    return storageFailure(error);
  }
}

export async function saveInsightLedger(
  root: string,
  ledger: InsightLedgerSnapshot,
): Promise<InsightLedgerResult<InsightLedgerSnapshot>> {
  const validated = validateInsightLedger(ledger);
  if (!validated.ok)
    return invalid(
      "invalid-ledger",
      "insight ledger failed validation",
      validated.errors.map((error) => `${error.path}: ${error.message}`),
    );
  if (insightLedgerHash(ledger) !== ledger.ledgerHash)
    return invalid("invalid-ledger", "insight ledger hash is incorrect");
  try {
    await atomicPrivateWrite(insightLedgerPath(root, ledger.ledgerHash), jsonBytes(ledger));
    return { ok: true, value: ledger };
  } catch (error) {
    return storageFailure(error);
  }
}

export async function readInsightCurrentPointer(
  root: string,
): Promise<InsightLedgerResult<InsightCurrentPointer>> {
  try {
    const input: unknown = JSON.parse(
      await readFile(join(resolve(root), "memory", "insight-current.json"), "utf8"),
    );
    const validated = validateInsightCurrentPointer(input);
    if (!validated.ok)
      return invalid(
        "invalid-ledger",
        "current insight pointer failed validation",
        validated.errors.map((error) => `${error.path}: ${error.message}`),
      );
    return { ok: true, value: validated.value };
  } catch (error) {
    return storageFailure(error);
  }
}

function compiledAtOf(value: unknown): string | undefined {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    !("compiledAt" in value)
  )
    return undefined;
  return typeof value.compiledAt === "string" ? value.compiledAt : undefined;
}

export async function readCurrentInsightLedger(root: string): Promise<
  InsightLedgerResult<{
    pointer: InsightCurrentPointer;
    ledger: InsightLedgerSnapshot;
    projection: InsightProjection;
  }>
> {
  const pointer = await readInsightCurrentPointer(root);
  if (!pointer.ok) return pointer;
  const ledger = await loadInsightLedger(root, pointer.value.ledgerHash);
  if (!ledger.ok) return ledger;
  if (ledger.value.projectIdentity !== pointer.value.projectIdentity)
    return invalid("invalid-ledger", "current pointer project identity does not match ledger");
  const context = await readInsightPublicationContext(root);
  if (context && !context.ok)
    return context as InsightLedgerResult<{
      pointer: InsightCurrentPointer;
      ledger: InsightLedgerSnapshot;
      projection: InsightProjection;
    }>;
  if (
    context &&
    (context.value.inputProjectionHash !== pointer.value.inputProjectionHash ||
      context.value.sourceAuthorityHash !== pointer.value.sourceAuthorityHash)
  )
    return invalid(
      "stale-ledger",
      "current pointer is stale for the active event projection or source authority",
    );
  let projection: InsightProjection;
  try {
    projection = projectInsightState(ledger.value);
    const compiledInput: unknown = JSON.parse(
      await readFile(
        join(resolve(root), "memory", "insight-compiled", `${pointer.value.outputHash}.json`),
        "utf8",
      ),
    );
    if (compiledAtOf(compiledInput) !== pointer.value.compiledAt)
      return invalid(
        "invalid-ledger",
        "current pointer compiled artifact is missing or time-unbound",
      );
    const compiled = compileInsightProjection(projection, {
      projectIdentity: pointer.value.projectIdentity,
      now: new Date(pointer.value.compiledAt),
      supportedRiskClasses: SUPPORTED_INSIGHT_RISK_CLASSES,
      ...(context ? { activeEvidence: context.value.activeEvidence } : {}),
    });
    if (
      !compiled.ok ||
      compiled.value.compiledStateHash !== pointer.value.compiledStateHash ||
      compiled.value.outputHash !== pointer.value.outputHash ||
      stableStringify(compiled.value) !== stableStringify(compiledInput)
    )
      return invalid(
        "invalid-ledger",
        "current pointer compiled artifact does not match the ledger",
      );
  } catch (error) {
    return storageFailure(error);
  }
  return { ok: true, value: { pointer: pointer.value, ledger: ledger.value, projection } };
}

async function writeInsightPublication(
  root: string,
  ledger: InsightLedgerSnapshot,
  priorPointer: InsightCurrentPointer | undefined,
  allowContextRebind = false,
): Promise<InsightLedgerResult<InsightPublication>> {
  const contextResult = await readInsightPublicationContext(root);
  if (contextResult && !contextResult.ok)
    return contextResult as InsightLedgerResult<InsightPublication>;
  const context = contextResult?.value;
  if (
    !allowContextRebind &&
    priorPointer &&
    context &&
    (priorPointer.inputProjectionHash !== context.inputProjectionHash ||
      priorPointer.sourceAuthorityHash !== context.sourceAuthorityHash)
  )
    return invalid(
      "stale-ledger",
      "active event projection or source authority changed since the current insight pointer",
    );
  const projection = projectInsightState(ledger);
  const compiledAt = new Date().toISOString();
  const compiledResult = compileInsightProjection(projection, {
    projectIdentity: ledger.projectIdentity,
    now: new Date(compiledAt),
    supportedRiskClasses: SUPPORTED_INSIGHT_RISK_CLASSES,
    ...(context ? { activeEvidence: context.activeEvidence } : {}),
  });
  if (!compiledResult.ok) return invalid("invalid-ledger", compiledResult.error);
  const compiled = compiledResult.value;
  const digest = (value: string): string => hashBytes(value);
  const pointer = makeInsightCurrentPointer({
    projectIdentity: priorPointer?.projectIdentity ?? ledger.projectIdentity,
    inputProjectionHash:
      context?.inputProjectionHash ??
      priorPointer?.inputProjectionHash ??
      digest("insight-input-projection-v2"),
    sourceAuthorityHash:
      context?.sourceAuthorityHash ??
      priorPointer?.sourceAuthorityHash ??
      digest("insight-source-authority-v2"),
    recipeHashes: priorPointer?.recipeHashes ?? { ledger: digest("insight-ledger-recipe-v2") },
    ledgerHash: ledger.ledgerHash,
    compiledAt,
    compiledStateHash: compiled.compiledStateHash,
    outputHash: compiled.outputHash,
  });
  try {
    await atomicPrivateWrite(
      join(resolve(root), "memory", "insight-compiled", `${compiled.outputHash}.json`),
      jsonBytes(compiled),
    );
    const dbPath = join(resolve(root), "analysis", "chatlog.sqlite");
    try {
      await stat(dbPath);
      const db = new Database(dbPath);
      try {
        rebuildInsightProjection(db, projection, pointer, ledger.transitions, compiledAt);
      } finally {
        db.close();
      }
    } catch (error: unknown) {
      const code =
        typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
      if (code !== "ENOENT") throw error;
    }
    await atomicPrivateWrite(
      join(resolve(root), "memory", "insight-current.json"),
      jsonBytes(pointer),
    );
    return { ok: true, value: { pointer, compiled } };
  } catch (error) {
    return storageFailure(error);
  }
}

export async function applyInsightCommand(
  root: string,
  input: InsightCommandInput,
): Promise<InsightLedgerResult<{ ledger: InsightLedgerSnapshot; transition: InsightTransition }>> {
  const result = await withLedgerLock<
    InsightLedgerResult<{ ledger: InsightLedgerSnapshot; transition: InsightTransition }>
  >(root, async () => {
    let prior: InsightLedgerSnapshot;
    let priorPointer: InsightCurrentPointer | undefined;
    try {
      const pointer = await readInsightCurrentPointer(root);
      if (!pointer.ok) {
        if (pointer.error.message.includes("ENOENT"))
          prior = createEmptyInsightLedger(
            input.revision.scope.project ?? input.revision.scope.repository ?? "unknown-project",
          );
        else
          return pointer as InsightLedgerResult<{
            ledger: InsightLedgerSnapshot;
            transition: InsightTransition;
          }>;
      } else {
        priorPointer = pointer.value;
        const loaded = await loadInsightLedger(root, pointer.value.ledgerHash);
        if (!loaded.ok)
          return loaded as InsightLedgerResult<{
            ledger: InsightLedgerSnapshot;
            transition: InsightTransition;
          }>;
        prior = loaded.value;
      }
    } catch (error) {
      return storageFailure(error);
    }
    const contextResult = await readInsightPublicationContext(root);
    if (contextResult && !contextResult.ok)
      return contextResult as InsightLedgerResult<{
        ledger: InsightLedgerSnapshot;
        transition: InsightTransition;
      }>;
    const context = contextResult?.value;
    if (
      priorPointer &&
      context &&
      (priorPointer.inputProjectionHash !== context.inputProjectionHash ||
        priorPointer.sourceAuthorityHash !== context.sourceAuthorityHash)
    )
      return invalid(
        "stale-ledger",
        "active event projection or source authority changed; run `chatlog insight recompile` after verifying the evidence",
      );
    const appended = appendInsightTransition(prior, input);
    if (!appended.ok)
      return appended as InsightLedgerResult<{
        ledger: InsightLedgerSnapshot;
        transition: InsightTransition;
      }>;
    const saved = await saveInsightLedger(root, appended.value);
    if (!saved.ok)
      return saved as InsightLedgerResult<{
        ledger: InsightLedgerSnapshot;
        transition: InsightTransition;
      }>;
    const publication = await writeInsightPublication(root, appended.value, priorPointer);
    if (!publication.ok)
      return publication as InsightLedgerResult<{
        ledger: InsightLedgerSnapshot;
        transition: InsightTransition;
      }>;
    const transition = appended.value.transitions.at(-1)!;
    return {
      ok: true,
      value: { ledger: appended.value, transition },
      idempotent: appended.idempotent,
    };
  });
  return result ?? invalid("lock-conflict", "insight ledger is locked");
}

export async function recompileCurrentInsightLedger(
  root: string,
): Promise<InsightLedgerResult<InsightPublication>> {
  const result = await withLedgerLock<InsightLedgerResult<InsightPublication>>(root, async () => {
    const pointer = await readInsightCurrentPointer(root);
    if (!pointer.ok) return pointer as InsightLedgerResult<InsightPublication>;
    const ledger = await loadInsightLedger(root, pointer.value.ledgerHash);
    if (!ledger.ok) return ledger as InsightLedgerResult<InsightPublication>;
    const contextResult = await readInsightPublicationContext(root);
    if (contextResult && !contextResult.ok)
      return contextResult as InsightLedgerResult<InsightPublication>;
    const context = contextResult?.value;
    if (context) {
      let projection: InsightProjection;
      try {
        projection = projectInsightState(ledger.value);
      } catch (error) {
        return invalid("invalid-ledger", error instanceof Error ? error.message : String(error));
      }
      const missingEvidence = activeInsightRevisions(projection)
        .flatMap((revision) => [...revision.supportEvidence, ...revision.counterEvidence])
        .filter((uri) => !context.activeEvidence.has(uri));
      if (missingEvidence.length > 0)
        return invalid(
          "stale-ledger",
          `cannot recompile while active insight evidence is unavailable: ${missingEvidence[0]}`,
        );
    }
    return writeInsightPublication(root, ledger.value, pointer.value, true);
  });
  return result ?? invalid("lock-conflict", "insight ledger is locked");
}

export function currentActiveInsights(
  projection: InsightProjection,
  now = new Date(),
): InsightRevision[] {
  return activeInsightRevisions(projection, now);
}
