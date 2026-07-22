import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { SourceFile, TokenUsage, Turn } from "../types";
import { redact } from "../redact";

export async function discoverJsonl(root: string, accept: (path: string) => boolean = () => true): Promise<SourceFile[]> {
  const found: SourceFile[] = [];
  async function walk(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile() && entry.name.endsWith(".jsonl") && accept(path)) {
        const s = await stat(path);
        found.push({ path, size: s.size, mtimeMs: s.mtimeMs });
      }
    }
  }
  await walk(root);
  return found.sort((a, b) => a.path.localeCompare(b.path));
}

export function assertObject(record: any, path: string, line: number): void {
  if (!record || typeof record !== "object" || Array.isArray(record) || typeof record.type !== "string") {
    throw new Error(`${path}:${line}: unknown record shape (object with string type required)`);
  }
}

export function contentText(content: unknown, path: string, line: number, allowed: Set<string>): string {
  if (typeof content === "string") return redact(content);
  if (content == null) return "";
  if (!Array.isArray(content)) throw new Error(`${path}:${line}: unknown content shape`);
  const parts: string[] = [];
  for (const block of content) {
    if (typeof block === "string") { parts.push(redact(block)); continue; }
    if (!block || typeof block !== "object" || typeof block.type !== "string" || !allowed.has(block.type)) {
      throw new Error(`${path}:${line}: unknown content block type ${JSON.stringify(block?.type)}`);
    }
    if (typeof block.text === "string") parts.push(redact(block.text));
    else if (typeof block.thinking === "string") parts.push(redact(block.thinking));
    else if (typeof block.content === "string") parts.push(redact(block.content));
    else if (Array.isArray(block.content)) parts.push(contentText(block.content, path, line, allowed));
  }
  return parts.filter(Boolean).join("\n");
}

export function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  const result: TokenUsage = { ...a };
  for (const key of ["input", "output", "cachedInput", "cacheWrite", "reasoning", "total"] as const) {
    if (b[key] != null) result[key] = (result[key] ?? 0) + b[key]!;
  }
  return result;
}

export function finishTimes(turns: Turn[], fallback: string): [string, string] {
  const times = turns.map((t) => t.at).filter((x): x is string => Boolean(x)).sort();
  return [times[0] ?? fallback, times.at(-1) ?? fallback];
}

export function projectOf(cwd: string): string {
  return cwd || "(unknown)";
}
