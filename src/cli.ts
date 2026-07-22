#!/usr/bin/env bun
import { homedir } from "node:os";
import { resolve } from "node:path";
import { ClaudeAdapter } from "./adapters/claude";
import { CodexAdapter } from "./adapters/codex";
import { PiAdapter } from "./adapters/pi";
import { ingest } from "./ingest";
import { openAnalysis, queryModels, querySearch, queryStats } from "./analysis";
import { deriveCorpus } from "./derive";
import { agentAsk, agentAskLexical, agentGet, agentGrok, agentProject, agentSearch, agentSemanticSearch } from "./agent-query";
import { duckSessionLengths, duckTokenUsage, duckToolFrequency, duckUsageOverTime } from "./duckdb";
import { redact } from "./redact";

const [command, subcommand, ...args] = process.argv.slice(2);
const root = resolve(import.meta.dir, "..");
const localAdapters = () => {
  const home = homedir();
  return [
    new ClaudeAdapter(`${home}/.claude/projects`),
    new CodexAdapter(`${home}/.codex/sessions`),
    new PiAdapter(`${home}/.pi/agent/sessions`),
  ];
};
if (command === "ingest") {
  console.log(JSON.stringify(await ingest(localAdapters(), root), null, 2));
} else if (command === "derive") {
  console.log(JSON.stringify(await deriveCorpus(root), null, 2));
} else if (command === "query") {
  const db = openAnalysis(`${root}/analysis/chatlog.sqlite`);
  try {
    if (subcommand === "search") {
      if (!args[0]) throw new Error("usage: bun run query search <fts-expression> [limit]");
      console.log(JSON.stringify(agentSearch(db, args[0], Number(args[1] ?? 20)), null, 2));
    } else if (subcommand === "semantic") {
      if (!args[0]) throw new Error("usage: bun run query semantic <topic> [limit] [candidate-limit]");
      console.log(JSON.stringify(await agentSemanticSearch(db, root, args[0], Number(args[1] ?? 10), Number(args[2] ?? 40)), null, 2));
    } else if (subcommand === "get") {
      if (!args[0]) throw new Error("usage: bun run query get <session-id-or-hash> [turn-index]");
      console.log(JSON.stringify(await agentGet(db, root, args[0], args[1] == null ? undefined : Number(args[1])), null, 2));
    } else if (subcommand === "grok") {
      if (!args[0]) throw new Error("usage: bun run query grok <topic> [limit]");
      console.log(JSON.stringify(await agentGrok(db, root, args[0], Number(args[1] ?? 10)), null, 2));
    } else if (subcommand === "ask") {
      if (!args[0]) throw new Error('usage: bun run query ask "what did I try last time for X" [limit]');
      console.log(JSON.stringify(await agentAsk(db, root, args[0], Number(args[1] ?? 10)), null, 2));
    } else if (subcommand === "ask-lexical") {
      if (!args[0]) throw new Error('usage: bun run query ask-lexical "what did I try last time for X" [limit]');
      console.log(JSON.stringify(await agentAskLexical(db, root, args[0], Number(args[1] ?? 10)), null, 2));
    } else if (subcommand === "project") {
      if (!args[0]) throw new Error("usage: bun run query project <exact-project-path>");
      console.log(JSON.stringify(await agentProject(db, root, args[0]), null, 2));
    } else if (subcommand === "stats") console.log(JSON.stringify(queryStats(db), null, 2));
    else if (subcommand === "legacy-search") {
      if (!args[0]) throw new Error("usage: bun run query legacy-search <fts-expression> [limit]");
      console.log(JSON.stringify(querySearch(db, args[0], Number(args[1] ?? 10)), null, 2));
    } else if (subcommand === "models") console.log(JSON.stringify(queryModels(db), null, 2));
    else if (subcommand === "tokens") console.log(JSON.stringify(await duckTokenUsage(root), null, 2));
    else if (subcommand === "usage-time") {
      const bucket = (args[0] ?? "month") as "day" | "month";
      if (bucket !== "day" && bucket !== "month") throw new Error("usage: bun run query usage-time [day|month] [limit]");
      console.log(JSON.stringify(await duckUsageOverTime(root, bucket, Number(args[1] ?? 60)), null, 2));
    } else if (subcommand === "tools") console.log(JSON.stringify(await duckToolFrequency(root, Number(args[0] ?? 30)), null, 2));
    else if (subcommand === "lengths") console.log(JSON.stringify(await duckSessionLengths(root), null, 2));
    else throw new Error("usage: bun run query <search|semantic|get|grok|ask|ask-lexical|project|stats|models|tokens|usage-time|tools|lengths>");
  } catch (error: any) {
    console.log(JSON.stringify({ error: { message: redact(String(error?.message ?? error)), command: subcommand ?? null } }, null, 2));
    process.exitCode = 1;
  } finally { db.close(); }
} else {
  throw new Error("usage: bun run src/cli.ts <ingest|derive|query>");
}
