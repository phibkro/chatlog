import { closeSync, constants, fstatSync, openSync, readSync, realpathSync } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { resolve, sep } from "node:path";

/** Hard ceilings shared by provider export readers. These are intentionally finite. */
export const EXPORT_MAX_ARCHIVE_BYTES = 256 * 1024 * 1024;
export const EXPORT_MAX_FILE_BYTES = 128 * 1024 * 1024;
export const EXPORT_MAX_MEMBER_BYTES = 64 * 1024 * 1024;
export const EXPORT_MAX_TOTAL_BYTES = 128 * 1024 * 1024;
export const EXPORT_MAX_MEMBERS = 2_048;
export const EXPORT_MAX_LISTING_BYTES = 4 * 1024 * 1024;
export const EXPORT_MAX_STDERR_BYTES = 64 * 1024;
export const EXPORT_MAX_MANIFEST_BYTES = 16 * 1024 * 1024;
export const EXPORT_MAX_CORPUS_OBJECT_BYTES = 64 * 1024 * 1024;

export type ExportLimitKind = "archive" | "file" | "member" | "total" | "listing" | "stderr";

export class ExportLimitError extends Error {
  readonly code = "export-limit-exceeded" as const;
  readonly kind: ExportLimitKind;
  readonly limit: number;
  readonly observed: number;

  constructor(kind: ExportLimitKind, limit: number, observed: number, label: string) {
    super(`${label} exceeds the ${kind} limit of ${limit} bytes`);
    this.name = "ExportLimitError";
    this.kind = kind;
    this.limit = limit;
    this.observed = observed;
  }
}

export class ExportFileTypeError extends Error {
  readonly code = "export-file-type-invalid" as const;

  constructor(readonly label: string) {
    super(`${label} is not a regular file`);
    this.name = "ExportFileTypeError";
  }
}

export class ExportReadError extends Error {
  readonly code = "export-read-failed" as const;

  constructor(
    readonly label: string,
    cause: unknown,
  ) {
    super(`${label} could not be read`, { cause });
    this.name = "ExportReadError";
  }
}

export type ExportLimitFailure = ExportLimitError | ExportFileTypeError | ExportReadError;

export type ExportLimitResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: ExportLimitFailure };

export interface BoundedText {
  readonly text: string;
  readonly bytes: number;
}

export async function readBoundedTextStream(
  stream: ReadableStream<Uint8Array>,
  limit: number,
  kind: ExportLimitKind,
  label: string,
  onLimit?: (error: ExportLimitError) => void,
): Promise<ExportLimitResult<BoundedText>> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunkBytes = value.byteLength;
      if (chunkBytes > limit - bytes) {
        const error = new ExportLimitError(kind, limit, bytes + chunkBytes, label);
        onLimit?.(error);
        await reader.cancel(error).catch(() => undefined);
        return { ok: false, error };
      }
      if (chunkBytes > 0) chunks.push(value);
      bytes += chunkBytes;
    }
  } finally {
    reader.releaseLock();
  }
  const encoded = Buffer.concat(
    chunks.map((chunk) => Buffer.from(chunk)),
    bytes,
  );
  return { ok: true, value: { text: encoded.toString("utf8"), bytes } };
}

export async function readBoundedFile(
  path: string,
  limit: number,
  label: string,
  containmentRoot?: string,
): Promise<ExportLimitResult<BoundedText & { readonly size: number; readonly mtimeMs: number }>> {
  const resolvedPath = resolve(path);
  if (containmentRoot !== undefined) {
    try {
      const root = await realpath(resolve(containmentRoot));
      const candidate = await realpath(resolvedPath);
      if (candidate !== root && !candidate.startsWith(`${root}${sep}`))
        return { ok: false, error: new ExportFileTypeError(label) };
    } catch (error) {
      return { ok: false, error: new ExportReadError(label, error) };
    }
  }
  let handle;
  try {
    handle = await open(resolvedPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error.code === "ELOOP" || error.code === "EMLINK")
    )
      return { ok: false, error: new ExportFileTypeError(label) };
    return { ok: false, error: new ExportReadError(label, error) };
  }
  try {
    const info = await handle.stat();
    if (!info.isFile()) return { ok: false, error: new ExportFileTypeError(label) };
    if (info.size > limit)
      return {
        ok: false,
        error: new ExportLimitError("file", limit, info.size, label),
      };
    const content = await readBoundedTextStream(handle.readableWebStream(), limit, "file", label);
    if (!content.ok) return content;
    return {
      ok: true,
      value: { ...content.value, size: content.value.bytes, mtimeMs: info.mtimeMs },
    };
  } finally {
    await handle.close();
  }
}

export function readBoundedFileSync(
  path: string,
  limit: number,
  label: string,
  containmentRoot?: string,
): ExportLimitResult<BoundedText & { readonly size: number; readonly mtimeMs: number }> {
  const resolvedPath = resolve(path);
  if (containmentRoot !== undefined) {
    try {
      const root = realpathSync(resolve(containmentRoot));
      const candidate = realpathSync(resolvedPath);
      if (candidate !== root && !candidate.startsWith(`${root}${sep}`))
        return { ok: false, error: new ExportFileTypeError(label) };
    } catch (error) {
      return { ok: false, error: new ExportReadError(label, error) };
    }
  }
  let descriptor: number;
  try {
    descriptor = openSync(resolvedPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error.code === "ELOOP" || error.code === "EMLINK")
    )
      return { ok: false, error: new ExportFileTypeError(label) };
    return { ok: false, error: new ExportReadError(label, error) };
  }
  try {
    const info = fstatSync(descriptor);
    if (!info.isFile()) return { ok: false, error: new ExportFileTypeError(label) };
    if (info.size > limit)
      return {
        ok: false,
        error: new ExportLimitError("file", limit, info.size, label),
      };
    let encoded = Buffer.allocUnsafe(Math.min(limit + 1, Math.max(info.size + 1, 4096)));
    let bytes = 0;
    for (;;) {
      if (bytes === encoded.byteLength) {
        if (bytes > limit)
          return {
            ok: false,
            error: new ExportLimitError("file", limit, bytes, label),
          };
        const expanded = Buffer.allocUnsafe(
          Math.min(limit + 1, Math.max(encoded.byteLength * 2, bytes + 1)),
        );
        encoded.copy(expanded, 0, 0, bytes);
        encoded = expanded;
      }
      const count = readSync(descriptor, encoded, bytes, encoded.byteLength - bytes, null);
      if (count === 0) break;
      bytes += count;
    }
    return {
      ok: true,
      value: {
        text: encoded.subarray(0, bytes).toString("utf8"),
        bytes,
        size: bytes,
        mtimeMs: info.mtimeMs,
      },
    };
  } catch (error) {
    return { ok: false, error: new ExportReadError(label, error) };
  } finally {
    closeSync(descriptor);
  }
}
