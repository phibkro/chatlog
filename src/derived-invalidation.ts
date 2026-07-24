import { join } from "node:path";
import {
  durableAtomicWrite,
  durableUnlink,
  readBoundedText,
} from "./durable-fs";

const SCHEMA = "chatlog/derived-invalidation-v1" as const;

export type DerivedInvalidationReason =
  | "authority-transition"
  | "derivation-failed"
  | "derivation-not-requested";

interface DerivedInvalidation {
  schema: typeof SCHEMA;
  operationId: string;
  manifestSourcesHash: string;
  reason: DerivedInvalidationReason;
  invalidatedAt: string;
  integrityHash: string;
}

export class ExplicitDerivedInvalidationError extends Error {
  constructor(readonly marker: Omit<DerivedInvalidation, "integrityHash">) {
    super(
      `derived projection was explicitly invalidated by operation ${marker.operationId}; run \`chatlog derive\``,
    );
    this.name = "ExplicitDerivedInvalidationError";
  }
}

function sha256(value: string): string {
  return new Bun.CryptoHasher("sha256").update(value).digest("hex");
}

function markerPath(root: string): string {
  return join(root, "derived", "invalidation.json");
}

export async function writeDerivedInvalidation(
  root: string,
  input: {
    operationId: string;
    manifestSourcesHash: string;
    reason: DerivedInvalidationReason;
    invalidatedAt?: string;
  },
): Promise<void> {
  if (!/^[0-9A-Za-z-]{1,128}$/.test(input.operationId))
    throw new Error("invalid derived invalidation operation ID");
  if (!/^[a-f0-9]{64}$/.test(input.manifestSourcesHash))
    throw new Error("invalid derived invalidation manifest hash");
  const body = {
    schema: SCHEMA,
    operationId: input.operationId,
    manifestSourcesHash: input.manifestSourcesHash,
    reason: input.reason,
    invalidatedAt: input.invalidatedAt ?? new Date().toISOString(),
  };
  const marker: DerivedInvalidation = {
    ...body,
    integrityHash: sha256(JSON.stringify(body)),
  };
  await durableAtomicWrite(
    markerPath(root),
    JSON.stringify(marker, null, 2) + "\n",
    { maxBytes: 16_384 },
  );
}

export async function clearDerivedInvalidation(root: string): Promise<void> {
  await durableUnlink(markerPath(root));
}

export async function assertDerivedNotInvalidated(
  root: string,
  manifestSourcesHash: string,
): Promise<void> {
  const path = markerPath(root);
  let text: string;
  try {
    text = await readBoundedText(path, 16_384, "invalidation marker");
  } catch (error: any) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  const marker = JSON.parse(text) as DerivedInvalidation;
  const { integrityHash, ...body } = marker;
  if (
    marker.schema !== SCHEMA
    || !/^[0-9A-Za-z-]{1,128}$/.test(marker.operationId)
    || !/^[a-f0-9]{64}$/.test(marker.manifestSourcesHash)
    || !["authority-transition", "derivation-failed", "derivation-not-requested"]
      .includes(marker.reason)
    || !/^[a-f0-9]{64}$/.test(integrityHash)
    || sha256(JSON.stringify(body)) !== integrityHash
  ) {
    throw new Error(`${path}: invalidation marker failed integrity validation`);
  }
  if (marker.manifestSourcesHash === manifestSourcesHash)
    throw new ExplicitDerivedInvalidationError(body);
}
