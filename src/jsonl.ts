export async function readJsonLines(
  path: string,
  visit: (record: any, line: number) => void,
): Promise<{ partialTail: boolean; lines: number }> {
  const reader = Bun.file(path).stream().getReader();
  const decoder = new TextDecoder();
  let pending = "";
  let lineNo = 0;
  for (;;) {
    const { done, value } = await reader.read();
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
        throw new Error(`${path}:${lineNo}: invalid JSON before final line: ${String(error)}`);
      }
      visit(record, lineNo);
    }
  }
  pending += decoder.decode();
  if (!pending.trim()) return { partialTail: false, lines: lineNo };
  lineNo++;
  let record: unknown;
  try {
    record = JSON.parse(pending);
  } catch {
    return { partialTail: true, lines: lineNo };
  }
  visit(record, lineNo);
  return { partialTail: false, lines: lineNo };
}
