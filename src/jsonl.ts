import { Data, Effect } from "effect";

// Malformed JSON on a non-tail line is a file-format failure, distinct from
// AdaptError (adapters/common.ts), which is a record-shape failure a caller
// validates after successful parse. Kept separate because readJsonLines is
// shared by every harness adapter and knows nothing about record shapes.
export class JsonlParseError extends Data.TaggedError("JsonlParseError")<{
  readonly path: string;
  readonly line: number;
  readonly cause: unknown;
}> {
  override get message(): string {
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
  const decoder = new TextDecoder();
  let pending = "";
  let lineNo = 0;
  let records = 0;
  for (;;) {
    const { done, value } = yield* Effect.promise(() => reader.read());
    if (done) break;
    pending += decoder.decode(value, { stream: true });
    const lines = pending.split("\n");
    pending = lines.pop() ?? "";
    for (const line of lines) {
      lineNo++;
      if (!line.trim()) continue;
      let record: unknown;
      try {
        record = JSON.parse(line);
      } catch (error) {
        return yield* Effect.fail(new JsonlParseError({ path, line: lineNo, cause: error }));
      }
      records++;
      yield* visit(record, lineNo);
    }
  }
  pending += decoder.decode();
  if (!pending.trim()) return { partialTail: false, lines: lineNo, records };
  lineNo++;
  let record: unknown;
  try {
    record = JSON.parse(pending);
  } catch {
    return { partialTail: true, lines: lineNo, records: records + 1 };
  }
  records++;
  yield* visit(record, lineNo);
  return { partialTail: false, lines: lineNo, records };
});
