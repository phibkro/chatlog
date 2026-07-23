import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { DeriveSummary } from "./derive";
import type { RefinerySummary } from "./refinery";

export const IMPORT_RECEIPT_SCHEMA = "chatlog/import-receipt-v1" as const;

export interface ImportReceipt {
  schema: typeof IMPORT_RECEIPT_SCHEMA;
  receiptId: string;
  operationId: string;
  operation: "import";
  connector: "anthropic-export";
  status: "completed";
  completedAt: string;
  source: {
    path: string;
    contentHash: string;
    bytes: number;
    modifiedAt: string;
  };
  policy: {
    domain: string;
    redaction: "canonical";
    exclusions: {
      modelThinking: true;
      attachmentBodies: true;
      claudeProjects: true;
      memories: true;
    };
  };
  counts: {
    discovered: number;
    imported: number;
    skipped: number;
    turns: number;
    attachments: number;
    files: number;
  };
  manifest: {
    beforeHash: string;
    afterHash: string;
    beforeSources: number;
    afterSources: number;
    added: number;
    replaced: number;
    unchanged: number;
  };
  derivation: {
    enabled: boolean;
    status: "not-requested" | "completed" | "failed";
    derived?: Pick<DeriveSummary, "discovered" | "processed" | "skipped" | "recipeChanged">;
    refinery?: Pick<RefinerySummary, "inputConversations" | "candidates" | "processed">;
  };
}

export interface ImportReceiptInput {
  source: ImportReceipt["source"];
  domain: string;
  counts: ImportReceipt["counts"];
  manifest: ImportReceipt["manifest"];
  deriveEnabled: boolean;
  derivationStatus?: ImportReceipt["derivation"]["status"];
  derived?: DeriveSummary;
  refinery?: RefinerySummary;
  completedAt?: string;
  operationId?: string;
}

function sha256(value: string): string {
  return new Bun.CryptoHasher("sha256").update(value).digest("hex");
}

function boundedText(value: string, label: string, maximum: number): string {
  if (!value || value.length > maximum) throw new Error(`${label} exceeds receipt bounds`);
  return value;
}

function boundedCount(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} is not a bounded count`);
  return value;
}

function validateHash(value: string, label: string): string {
  if (!/^[a-f0-9]{64}$/.test(value)) throw new Error(`${label} is not a SHA-256 hash`);
  return value;
}

function validateTimestamp(value: string, label: string): string {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.valueOf()) || parsed.toISOString() !== value)
    throw new Error(`${label} is not a canonical ISO-8601 timestamp`);
  return value;
}

export function manifestSourcesHash(
  sources: Record<string, { contentHash: string }>,
): string {
  const canonical = Object.entries(sources)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([sourcePath, entry]) => [sourcePath, entry.contentHash]);
  return sha256(JSON.stringify(canonical));
}

async function atomicWrite(path: string, text: string): Promise<void> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, text, { mode: 0o600 });
  await rename(temporary, path);
  await chmod(path, 0o600);
}

export async function writeImportReceipt(
  root: string,
  input: ImportReceiptInput,
): Promise<ImportReceipt> {
  const completedAt = input.completedAt ?? new Date().toISOString();
  const operationId = input.operationId ?? randomUUID();
  const derivationStatus = input.derivationStatus
    ?? (input.deriveEnabled ? "completed" : "not-requested");
  if ((!input.deriveEnabled && derivationStatus !== "not-requested")
    || (input.deriveEnabled && derivationStatus === "not-requested"))
    throw new Error("derivation status is inconsistent with receipt policy");
  const body = {
    schema: IMPORT_RECEIPT_SCHEMA,
    operationId: boundedText(operationId, "operation ID", 128),
    operation: "import" as const,
    connector: "anthropic-export" as const,
    status: "completed" as const,
    completedAt: validateTimestamp(
      boundedText(completedAt, "completion time", 64),
      "completion time",
    ),
    source: {
      path: boundedText(input.source.path, "source path", 4096),
      contentHash: validateHash(input.source.contentHash, "source content hash"),
      bytes: boundedCount(input.source.bytes, "source bytes"),
      modifiedAt: validateTimestamp(
        boundedText(input.source.modifiedAt, "source modification time", 64),
        "source modification time",
      ),
    },
    policy: {
      domain: boundedText(input.domain, "domain", 128),
      redaction: "canonical" as const,
      exclusions: {
        modelThinking: true as const,
        attachmentBodies: true as const,
        claudeProjects: true as const,
        memories: true as const,
      },
    },
    counts: Object.fromEntries(
      Object.entries(input.counts).map(([key, value]) => [key, boundedCount(value, `count ${key}`)]),
    ) as ImportReceipt["counts"],
    manifest: {
      beforeHash: validateHash(input.manifest.beforeHash, "manifest before hash"),
      afterHash: validateHash(input.manifest.afterHash, "manifest after hash"),
      beforeSources: boundedCount(input.manifest.beforeSources, "manifest before sources"),
      afterSources: boundedCount(input.manifest.afterSources, "manifest after sources"),
      added: boundedCount(input.manifest.added, "manifest added sources"),
      replaced: boundedCount(input.manifest.replaced, "manifest replaced sources"),
      unchanged: boundedCount(input.manifest.unchanged, "manifest unchanged sources"),
    },
    derivation: {
      enabled: input.deriveEnabled,
      status: derivationStatus,
      ...(input.derived ? {
        derived: {
          discovered: boundedCount(input.derived.discovered, "derived discovered"),
          processed: boundedCount(input.derived.processed, "derived processed"),
          skipped: boundedCount(input.derived.skipped, "derived skipped"),
          recipeChanged: input.derived.recipeChanged,
        },
      } : {}),
      ...(input.refinery ? {
        refinery: {
          inputConversations: boundedCount(input.refinery.inputConversations, "refinery input conversations"),
          candidates: boundedCount(input.refinery.candidates, "refinery candidates"),
          processed: input.refinery.processed,
        },
      } : {}),
    },
  };
  const receiptId = sha256(JSON.stringify(body));
  const receipt: ImportReceipt = { ...body, receiptId };
  const timestamp = completedAt.replaceAll(/[^0-9A-Za-z]/g, "");
  await atomicWrite(
    join(root, "receipts", "imports", `${timestamp}-${receiptId}.json`),
    JSON.stringify(receipt, null, 2) + "\n",
  );
  return receipt;
}

export async function listImportReceipts(root: string, limit = 20): Promise<ImportReceipt[]> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200)
    throw new Error("receipt limit must be an integer between 1 and 200");
  const directory = join(root, "receipts", "imports");
  let names: string[];
  try {
    names = [...new Bun.Glob("*.json").scanSync({ cwd: directory, onlyFiles: true })]
      .sort()
      .reverse()
      .slice(0, limit);
  } catch (error: any) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  const receipts: ImportReceipt[] = [];
  for (const name of names) {
    const path = join(directory, name);
    const text = await readFile(path, "utf8");
    if (text.length > 65_536) throw new Error(`${path}: import receipt exceeds size bound`);
    const receipt = JSON.parse(text) as ImportReceipt;
    if (receipt.schema !== IMPORT_RECEIPT_SCHEMA || !/^[a-f0-9]{64}$/.test(receipt.receiptId)) {
      throw new Error(`${path}: unsupported import receipt`);
    }
    const { receiptId, ...body } = receipt;
    if (sha256(JSON.stringify(body)) !== receiptId || !name.endsWith(`-${receiptId}.json`))
      throw new Error(`${path}: import receipt integrity check failed`);
    receipts.push(receipt);
  }
  return receipts;
}
