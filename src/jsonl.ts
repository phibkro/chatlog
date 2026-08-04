import { Data, Effect } from "effect";

export const JSONL_MAX_LINE_BYTES = 256 * 1024;
export const JSONL_MAX_FILE_BYTES = 64 * 1024 * 1024;
export const JSONL_MAX_RECORDS = 100_000;

export type JsonlParseErrorCode =
  | "invalid-json"
  | "line-too-large"
  | "file-too-large"
  | "record-limit";

// Malformed JSON on a non-tail line is a file-format failure, distinct from
// AdaptError (adapters/common.ts), which is a record-shape failure a caller
// validates after successful parse. Kept separate because readJsonLines is
// shared by every harness adapter and knows nothing about record shapes.
export class JsonlParseError extends Data.TaggedError("JsonlParseError")<{
  readonly path: string;
  readonly line: number;
  readonly code: JsonlParseErrorCode;
  readonly cause: unknown;
}> {
  override get message(): string {
    if (this.code === "line-too-large")
      return `${this.path}:${this.line}: JSONL line exceeds ${JSONL_MAX_LINE_BYTES} bytes`;
    if (this.code === "file-too-large")
      return `${this.path}: JSONL file exceeds ${JSONL_MAX_FILE_BYTES} bytes`;
    if (this.code === "record-limit")
      return `${this.path}:${this.line}: JSONL record count exceeds ${JSONL_MAX_RECORDS}`;
    return `${this.path}:${this.line}: invalid JSON before final line: ${String(this.cause)}`;
  }
}

// visit runs once per parsed record, in file order. Its failure propagates
// immediately (yield* short-circuits the read loop) rather than being
// collected — callers no longer need to run visit to an Exit themselves.
export const readJsonLines = Effect.fnUntraced(function* <E = never>(
  path: string,
  visit: (record: unknown, line: number) => Effect.Effect<void, E>,
): Effect.fn.Return<{ partialTail: boolean; lines: number; records: number }, JsonlParseError | E> {
  const reader = Bun.file(path).stream().getReader();
  let normalEof = false;
  try {
    const decoder = new TextDecoder();
    let pendingChunks: Uint8Array[] = [];
    let pendingBytes = 0;
    let lineNo = 0;
    let fileBytes = 0;
    let records = 0;

    const decodePending = (): string => {
      if (pendingChunks.length === 0) return "";
      if (pendingChunks.length === 1) return decoder.decode(pendingChunks[0]);
      const bytes = new Uint8Array(pendingBytes);
      let offset = 0;
      for (const chunk of pendingChunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return decoder.decode(bytes);
    };

    for (;;) {
      const { done, value } = yield* Effect.promise(() => reader.read());
      if (done) {
        normalEof = true;
        break;
      }
      if (value.byteLength > JSONL_MAX_FILE_BYTES - fileBytes)
        return yield* Effect.fail(
          new JsonlParseError({
            path,
            line: lineNo + 1,
            code: "file-too-large",
            cause: undefined,
          }),
        );
      fileBytes += value.byteLength;
      let segmentStart = 0;
      for (let index = 0; index < value.byteLength; index++) {
        if (value[index] !== 0x0a) continue;
        const segment = value.subarray(segmentStart, index);
        if (pendingBytes > JSONL_MAX_LINE_BYTES - segment.byteLength)
          return yield* Effect.fail(
            new JsonlParseError({
              path,
              line: lineNo + 1,
              code: "line-too-large",
              cause: undefined,
            }),
          );
        if (segment.byteLength > 0) pendingChunks.push(segment);
        pendingBytes += segment.byteLength;
        const line = decodePending();
        pendingChunks = [];
        pendingBytes = 0;
        lineNo++;
        segmentStart = index + 1;
        if (!line.trim()) continue;
        let record: unknown;
        try {
          record = JSON.parse(line);
        } catch (error) {
          return yield* Effect.fail(
            new JsonlParseError({ path, line: lineNo, code: "invalid-json", cause: error }),
          );
        }
        if (records >= JSONL_MAX_RECORDS)
          return yield* Effect.fail(
            new JsonlParseError({
              path,
              line: lineNo,
              code: "record-limit",
              cause: undefined,
            }),
          );
        records++;
        yield* visit(record, lineNo);
      }
      const tail = value.subarray(segmentStart);
      if (pendingBytes > JSONL_MAX_LINE_BYTES - tail.byteLength)
        return yield* Effect.fail(
          new JsonlParseError({
            path,
            line: lineNo + 1,
            code: "line-too-large",
            cause: undefined,
          }),
        );
      if (tail.byteLength > 0) pendingChunks.push(tail);
      pendingBytes += tail.byteLength;
    }

    const pending = decodePending();
    if (!pending.trim()) return { partialTail: false, lines: lineNo, records };
    lineNo++;
    let record: unknown;
    try {
      record = JSON.parse(pending);
    } catch {
      return { partialTail: true, lines: lineNo, records: records + 1 };
    }
    if (records >= JSONL_MAX_RECORDS)
      return yield* Effect.fail(
        new JsonlParseError({
          path,
          line: lineNo,
          code: "record-limit",
          cause: undefined,
        }),
      );
    records++;
    yield* visit(record, lineNo);
    return { partialTail: false, lines: lineNo, records };
  } finally {
    if (!normalEof)
      yield* Effect.promise(() => {
        try {
          return Promise.resolve(reader.cancel()).catch(() => undefined);
        } catch {
          return Promise.resolve();
        }
      });
    try {
      reader.releaseLock();
    } catch {
      // The reader may already have released its lock after a stream failure.
    }
  }
});
