export class InputLimitError extends Error {
  readonly code = "input-limit-exceeded" as const;

  constructor(
    readonly limit: number,
    readonly observed: number,
    readonly label: string,
  ) {
    super(`${label} exceeds ${limit} bytes`);
    this.name = "InputLimitError";
  }
}

export type BoundedInputResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: InputLimitError };

function decodeChunks(chunks: readonly Uint8Array[], bytes: number): string {
  if (chunks.length === 0) return "";
  if (chunks.length === 1) return new TextDecoder().decode(chunks[0]);
  const joined = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(joined);
}

export async function readBoundedInputText(
  stream: ReadableStream<Uint8Array>,
  limit: number,
  label: string,
): Promise<BoundedInputResult<string>> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return { ok: true, value: decodeChunks(chunks, bytes) };
      if (value.byteLength > limit - bytes) {
        const error = new InputLimitError(limit, bytes + value.byteLength, label);
        await reader.cancel(error).catch(() => undefined);
        return { ok: false, error };
      }
      if (value.byteLength > 0) chunks.push(value);
      bytes += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
}

export async function* readBoundedInputLines(
  stream: AsyncIterable<Uint8Array>,
  limit: number,
  label: string,
): AsyncGenerator<BoundedInputResult<string>> {
  let pending: Uint8Array[] = [];
  let pendingBytes = 0;
  for await (const chunk of stream) {
    let segmentStart = 0;
    for (let index = 0; index < chunk.byteLength; index += 1) {
      if (chunk[index] !== 0x0a) continue;
      const segment = chunk.subarray(segmentStart, index);
      if (segment.byteLength > limit - pendingBytes) {
        yield {
          ok: false,
          error: new InputLimitError(limit, pendingBytes + segment.byteLength, label),
        };
        return;
      }
      if (segment.byteLength > 0) pending.push(segment);
      pendingBytes += segment.byteLength;
      const decoded = decodeChunks(pending, pendingBytes);
      yield { ok: true, value: decoded.endsWith("\r") ? decoded.slice(0, -1) : decoded };
      pending = [];
      pendingBytes = 0;
      segmentStart = index + 1;
    }
    const tail = chunk.subarray(segmentStart);
    if (tail.byteLength > limit - pendingBytes) {
      yield {
        ok: false,
        error: new InputLimitError(limit, pendingBytes + tail.byteLength, label),
      };
      return;
    }
    if (tail.byteLength > 0) pending.push(tail);
    pendingBytes += tail.byteLength;
  }
  if (pendingBytes > 0) yield { ok: true, value: decodeChunks(pending, pendingBytes) };
}

export interface BoundedRecordLimits {
  readonly maxDepth: number;
  readonly maxKeys: number;
  readonly maxArrayItems: number;
  readonly maxStringLength: number;
  readonly maxBytes: number;
}

export type BoundedRecordValidation =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: string };

/**
 * Walk a JSON-shaped record without recursion or unbounded serialization.
 * The walk rejects cycles and unsupported values before callers spread, hash,
 * redact, or persist the record.
 */
export function validateBoundedRecord(
  value: unknown,
  label: string,
  limits: BoundedRecordLimits,
): BoundedRecordValidation {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return { ok: false, error: `${label} must be an object` };

  const active = new WeakSet<object>();
  const stack: Array<
    { readonly value: unknown; readonly depth: number } | { readonly exit: object }
  > = [{ value, depth: 0 }];
  const encoder = new TextEncoder();
  let keyCount = 0;
  let serializedBytes = 0;
  const fail = (reason: string): BoundedRecordValidation => ({
    ok: false,
    error: `${label} ${reason}`,
  });
  const addByteCount = (count: number): BoundedRecordValidation | undefined => {
    serializedBytes += count;
    return serializedBytes > limits.maxBytes
      ? fail(`serialized form exceeds ${limits.maxBytes} bytes`)
      : undefined;
  };

  try {
    while (stack.length > 0) {
      const frame = stack.pop()!;
      if ("exit" in frame) {
        active.delete(frame.exit);
        continue;
      }
      const current = frame.value;
      if (frame.depth > limits.maxDepth) return fail(`nested depth exceeds ${limits.maxDepth}`);
      if (typeof current === "string") {
        if (current.length > limits.maxStringLength)
          return fail(`contains text longer than ${limits.maxStringLength} characters`);
        const serialized = JSON.stringify(current);
        if (serialized === undefined) return fail("contains an unserializable string");
        const byteFailure = addByteCount(encoder.encode(serialized).byteLength);
        if (byteFailure) return byteFailure;
        continue;
      }
      if (current === undefined) {
        const byteFailure = addByteCount(4);
        if (byteFailure) return byteFailure;
        continue;
      }
      if (current === null) {
        const byteFailure = addByteCount(4);
        if (byteFailure) return byteFailure;
        continue;
      }
      if (typeof current === "boolean") {
        const byteFailure = addByteCount(current ? 4 : 5);
        if (byteFailure) return byteFailure;
        continue;
      }
      if (typeof current === "number") {
        if (!Number.isFinite(current)) return fail("contains a non-finite number");
        const serialized = JSON.stringify(current);
        if (serialized === undefined) return fail("contains an unserializable number");
        const byteFailure = addByteCount(encoder.encode(serialized).byteLength);
        if (byteFailure) return byteFailure;
        continue;
      }
      if (typeof current !== "object") return fail("contains an unsupported value");
      if (active.has(current)) return fail("contains a cyclic record");
      active.add(current);
      stack.push({ exit: current });
      if (Array.isArray(current)) {
        if (current.length > limits.maxArrayItems)
          return fail(`contains an array longer than ${limits.maxArrayItems} items`);
        const byteFailure = addByteCount(2 + Math.max(0, current.length - 1));
        if (byteFailure) return byteFailure;
        for (let index = current.length - 1; index >= 0; index -= 1)
          stack.push({ value: current[index], depth: frame.depth + 1 });
        continue;
      }
      const record = current as Record<string, unknown>;
      let objectKeyCount = 0;
      let keyBytes = 2;
      for (const key in record) {
        if (!Object.prototype.hasOwnProperty.call(record, key)) continue;
        keyCount += 1;
        objectKeyCount += 1;
        if (keyCount > limits.maxKeys)
          return fail(`contains more than ${limits.maxKeys} object keys`);
        if (key.length > limits.maxStringLength)
          return fail(`contains a key longer than ${limits.maxStringLength} characters`);
        const serializedKey = JSON.stringify(key);
        if (serializedKey === undefined) return fail("contains an unserializable object key");
        keyBytes += (objectKeyCount === 1 ? 0 : 1) + encoder.encode(serializedKey).byteLength + 1;
        stack.push({ value: record[key], depth: frame.depth + 1 });
      }
      const byteFailure = addByteCount(keyBytes);
      if (byteFailure) return byteFailure;
    }
  } catch (error) {
    return fail(
      `could not be inspected safely: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return { ok: true };
}
