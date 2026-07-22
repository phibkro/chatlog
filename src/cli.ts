#!/usr/bin/env bun
import { homedir } from "node:os";
import { resolve } from "node:path";
import { ClaudeAdapter } from "./adapters/claude";
import { CodexAdapter } from "./adapters/codex";
import { PiAdapter } from "./adapters/pi";
import { ingest } from "./ingest";
import { openAnalysis, queryModels, querySearch, querySessionLengths, queryStats, queryTokenUsage, queryToolFrequency, queryUsageOverTime } from "./analysis";

const [command, subcommand, ...args] = process.argv.slice(2);
const root = resolve(import.meta.dir, "..");
if (command === "ingest") {
  const home = homedir();
  const adapters = [
    new ClaudeAdapter(`${home}/.claude/projects`),
    new CodexAdapter(`${home}/.codex/sessions`),
    new PiAdapter(`${home}/.pi/agent/sessions`),
  ];
  console.log(JSON.stringify(await ingest(adapters, root), null, 2));
} else if (command === "query") {
  const db = openAnalysis(`${root}/analysis/chatlog.sqlite`);
  try {
    if (subcommand === "stats") console.log(JSON.stringify(queryStats(db), null, 2));
    else if (subcommand === "search") {
      if (!args[0]) throw new Error("usage: bun run query search <fts-expression> [limit]");
      console.log(JSON.stringify(querySearch(db, args[0], Number(args[1] ?? 10)), null, 2));
    } else if (subcommand === "models") console.log(JSON.stringify(queryModels(db), null, 2));
    else if (subcommand === "tokens") console.log(JSON.stringify(queryTokenUsage(db), null, 2));
    else if (subcommand === "usage-time") {
      const bucket = (args[0] ?? "month") as "day" | "month";
      if (bucket !== "day" && bucket !== "month") throw new Error("usage: bun run query usage-time [day|month] [limit]");
      console.log(JSON.stringify(queryUsageOverTime(db, bucket, Number(args[1] ?? 60)), null, 2));
    } else if (subcommand === "tools") console.log(JSON.stringify(queryToolFrequency(db, Number(args[0] ?? 30)), null, 2));
    else if (subcommand === "lengths") console.log(JSON.stringify(querySessionLengths(db), null, 2));
    else throw new Error("usage: bun run query <stats|search|models|tokens|usage-time|tools|lengths>");
  } finally { db.close(); }
} else {
  throw new Error("usage: bun run src/cli.ts <ingest|query>");
}
