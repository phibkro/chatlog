import { expect, test } from "bun:test";
import { ExportLimitError, readBoundedTextStream } from "../src/importers/export-limits";

test("bounded stream overflow cancels its producer and signals termination", async () => {
  let cancelReason: unknown;
  let signaledError: ExportLimitError | undefined;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("oversized"));
    },
    cancel(reason) {
      cancelReason = reason;
    },
  });

  const result = await readBoundedTextStream(
    stream,
    4,
    "member",
    "synthetic archive member",
    (error) => {
      signaledError = error;
    },
  );

  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.error).toBeInstanceOf(ExportLimitError);
  if (!(result.error instanceof ExportLimitError)) return;
  expect(result.error.kind).toBe("member");
  expect(result.error.limit).toBe(4);
  expect(result.error.observed).toBe(9);
  expect(signaledError).toBe(result.error);
  expect(cancelReason).toBe(result.error);
});
