import { expect, test } from "bun:test";
import { InputLimitError, readBoundedInputLines, readBoundedInputText } from "../src/bounded-input";

async function* validChunks(): AsyncGenerator<Uint8Array> {
  yield new TextEncoder().encode("first\r");
  yield new TextEncoder().encode("\nsecond\n");
}

async function* oversizedChunks(): AsyncGenerator<Uint8Array> {
  yield new TextEncoder().encode("1234");
  yield new TextEncoder().encode("5");
}

test("bounded control input cancels a producer before whole-input buffering", async () => {
  let cancelReason: unknown;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("oversized"));
    },
    cancel(reason) {
      cancelReason = reason;
    },
  });

  const result = await readBoundedInputText(stream, 4, "synthetic input");
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.error).toBeInstanceOf(InputLimitError);
  expect(result.error.observed).toBe(9);
  expect(cancelReason).toBe(result.error);
});

test("bounded control lines preserve framing and return a typed oversize error", async () => {
  const lines: string[] = [];
  for await (const result of readBoundedInputLines(validChunks(), 16, "synthetic line")) {
    if (!result.ok) throw result.error;
    lines.push(result.value);
  }
  expect(lines).toEqual(["first", "second"]);

  let failure: InputLimitError | undefined;
  for await (const result of readBoundedInputLines(oversizedChunks(), 4, "synthetic line")) {
    if (!result.ok) failure = result.error;
  }
  expect(failure).toBeInstanceOf(InputLimitError);
  expect(failure?.message).toBe("synthetic line exceeds 4 bytes");
});
