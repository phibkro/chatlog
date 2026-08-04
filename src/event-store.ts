import { chmod, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import {
  canonicalEventBatch,
  sha256,
  stableStringify,
  type EventBatch,
  validateEventBatch,
} from "./events";

export const EVENT_OBJECT_DIRECTORY = "events";

export class EventStoreError extends Error {
  override readonly name = "EventStoreError";
}

function invalidEventStore(message: string, cause?: unknown): never {
  throw new EventStoreError(message, cause === undefined ? undefined : { cause });
}

function nodeErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object" || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

export function serializeEventBatch(batch: EventBatch): string {
  const canonical = canonicalEventBatch(batch);
  return `${stableStringify(canonical)}\n`;
}

export function eventBatchHash(batch: EventBatch): string {
  return sha256(serializeEventBatch(batch));
}

export function eventBatchRelativePath(hash: string): string {
  if (!/^[a-f0-9]{64}$/i.test(hash)) invalidEventStore("event batch hash must be SHA-256");
  const normalized = hash.toLowerCase();
  return `${EVENT_OBJECT_DIRECTORY}/${normalized.slice(0, 2)}/${normalized}.json`;
}

export function eventBatchPath(root: string, hash: string): string {
  return join(root, "corpus", eventBatchRelativePath(hash));
}

async function atomicWrite(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, text, { mode: 0o600 });
  await rename(temporary, path);
  await chmod(path, 0o600);
}

export async function persistEventBatch(root: string, batch: EventBatch): Promise<string> {
  const canonical = canonicalEventBatch(batch);
  const hash = eventBatchHash(canonical);
  const path = eventBatchPath(root, hash);
  try {
    const info = await stat(path);
    if (!info.isFile()) invalidEventStore(`${path}: event batch path is not a file`);
    const existing = validateEventBatch(JSON.parse(await readFile(path, "utf8")));
    if (eventBatchHash(existing) !== hash) invalidEventStore(`${path}: event batch hash mismatch`);
    return hash;
  } catch (error: unknown) {
    if (nodeErrorCode(error) !== "ENOENT")
      invalidEventStore(`${path}: event batch persistence failed`, error);
  }
  await atomicWrite(path, serializeEventBatch(canonical));
  return hash;
}

export async function readEventBatch(root: string, hash: string): Promise<EventBatch> {
  const path = eventBatchPath(root, hash);
  const batch = canonicalEventBatch(JSON.parse(await readFile(path, "utf8")));
  if (eventBatchHash(batch) !== hash.toLowerCase())
    invalidEventStore(`${path}: event batch hash mismatch`);
  return batch;
}
