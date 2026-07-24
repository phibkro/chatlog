#!/usr/bin/env bun
import { Database } from "bun:sqlite";
import { homedir } from "node:os";
import { join } from "node:path";
import { ClaudeAdapter } from "./adapters/claude";
import { CodexAdapter } from "./adapters/codex";
import { PiAdapter } from "./adapters/pi";
import { ingest } from "./ingest";
import { openAnalysis, queryModels, querySearch, queryStats } from "./analysis";
import { deriveCorpus } from "./derive";
import { agentAsk, agentAskLexical, agentGet, agentGrok, agentProject, agentSearch, agentSemanticSearch } from "./agent-query";
import { duckSessionLengths, duckTokenUsage, duckToolFrequency, duckUsageOverTime } from "./duckdb";
import { clearDerivedInvalidation } from "./derived-invalidation";
import { redact } from "./redact";
import { refineCorpus } from "./refinery";
import { agentRefinery, agentRefineryCandidate, agentRefineryEvalPlan } from "./refinery-query";
import { emitPiBridge, type PiBridgeMode } from "./bridge";
import { deriveOrchestrationProfile, loadOrchestrationProfile } from "./orchestration-profile";
import { deriveRoleSegmentation, loadRoleSegmentation } from "./role-segmentation";
import { deriveEffectivenessRanking, loadEffectivenessRanking } from "./effectiveness-ranking";
import { deriveWorkflowEvolution, loadWorkflowEvolution } from "./workflow-evolution";
import { importAnthropicExport, previewAnthropicExport } from "./importers/anthropic-export";
import { normalizeConversationDomain } from "./domain";
import { resolveDataRoot } from "./data-root";
import { listImportReceipts } from "./import-receipts";
import { withIngestLock } from "./lock";
import { recoverPendingOperations } from "./operation-intents";
import {
  ActiveProjectionDriftError,
  ActiveProjectionGuard,
  loadCorpusManifest,
  reconcileSourceAuthority,
} from "./source-authority";

const [command, subcommand, ...args] = process.argv.slice(2);
const root = resolveDataRoot();
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
} else if (command === "preview") {
  if (subcommand !== "anthropic" || !args[0])
    throw new Error("usage: chatlog preview anthropic <export.zip|directory> [domain]");
  const domain = normalizeConversationDomain(
    args[1] && !args[1].startsWith("--") ? args[1] : "general",
  );
  console.log(JSON.stringify(await previewAnthropicExport(args[0], root, { domain }), null, 2));
} else if (command === "import") {
  if (subcommand !== "anthropic" || !args[0])
    throw new Error("usage: chatlog import anthropic <export.zip|directory> [domain] [--no-derive]");
  const domain = normalizeConversationDomain(
    args[1] && !args[1].startsWith("--") ? args[1] : "general",
  );
  console.log(JSON.stringify(await importAnthropicExport(args[0], root, {
    domain,
    derive: !args.includes("--no-derive"),
  }), null, 2));
} else if (command === "receipts") {
  if (subcommand && subcommand !== "imports" && !/^\d+$/.test(subcommand))
    throw new Error("usage: chatlog receipts [imports] [limit]");
  const limitText = subcommand === "imports" ? args[0] : subcommand;
  if (limitText && !/^[1-9]\d*$/.test(limitText))
    throw new Error("receipt limit must be a positive integer");
  const limit = Number(limitText ?? 20);
  if (!Number.isSafeInteger(limit) || limit > 200)
    throw new Error("receipt limit must be at most 200");
  console.log(JSON.stringify(await listImportReceipts(root, limit), null, 2));
} else if (command === "source") {
  if (args.length || (subcommand !== "reconcile" && subcommand !== "recover"))
    throw new Error("usage: chatlog source <reconcile|recover>");
  console.log(JSON.stringify(await withIngestLock(root, async () => {
    const recovery = await recoverPendingOperations(root);
    if (subcommand === "recover") return recovery;
    const manifest = await loadCorpusManifest(root);
    const db = openAnalysis(join(root, "analysis", "chatlog.sqlite"));
    try {
      return {
        ...await reconcileSourceAuthority(root, db, manifest.sources),
        recovery,
      };
    } finally {
      db.close();
    }
  }), null, 2));
} else if (command === "derive") {
  console.log(JSON.stringify(await withIngestLock(root, async () => {
    await recoverPendingOperations(root);
    const derived = await deriveCorpus(root);
    const refinery = await refineCorpus(root, 3, { allowExplicitInvalidation: true });
    await clearDerivedInvalidation(root);
    return { derived, refinery };
  }), null, 2));
} else if (command === "refine") {
  console.log(JSON.stringify(await withIngestLock(root, async () => {
    await recoverPendingOperations(root);
    return refineCorpus(root, Number(subcommand ?? 3));
  }), null, 2));
} else if (command === "query") {
  const db = new Database(join(root, "analysis", "chatlog.sqlite"), {
    readonly: true,
    create: false,
  });
  try {
    const projectionGuard = new ActiveProjectionGuard(root);
    const projection = projectionGuard.assert(db);
    let output: unknown;
    if (subcommand === "search") {
      if (!args[0]) throw new Error("usage: bun run query search <fts-expression> [limit]");
      output = agentSearch(db, args[0], Number(args[1] ?? 20));
    } else if (subcommand === "semantic") {
      if (!args[0]) throw new Error("usage: bun run query semantic <topic> [limit] [candidate-limit]");
      output = await agentSemanticSearch(db, root, args[0], Number(args[1] ?? 10), Number(args[2] ?? 40));
    } else if (subcommand === "get") {
      if (!args[0]) throw new Error("usage: bun run query get <session-id-or-hash> [turn-index]");
      output = await agentGet(db, root, args[0], args[1] == null ? undefined : Number(args[1]));
    } else if (subcommand === "grok") {
      if (!args[0]) throw new Error("usage: bun run query grok <topic> [limit]");
      output = await agentGrok(db, root, args[0], Number(args[1] ?? 10));
    } else if (subcommand === "ask") {
      if (!args[0]) throw new Error('usage: bun run query ask "what did I try last time for X" [limit]');
      output = await agentAsk(db, root, args[0], Number(args[1] ?? 10));
    } else if (subcommand === "ask-lexical") {
      if (!args[0]) throw new Error('usage: bun run query ask-lexical "what did I try last time for X" [limit]');
      output = await agentAskLexical(db, root, args[0], Number(args[1] ?? 10));
    } else if (subcommand === "project") {
      if (!args[0]) throw new Error("usage: bun run query project <exact-project-path>");
      output = await agentProject(db, root, args[0]);
    } else if (subcommand === "orchestration-profile") {
      const derivation = await deriveOrchestrationProfile(root);
      const roleDerivation = await deriveRoleSegmentation(root);
      const effectivenessDerivation = await deriveEffectivenessRanking(root);
      output = { derivation, report: await loadOrchestrationProfile(root), roleSegmentation: { derivation: roleDerivation, report: await loadRoleSegmentation(root) }, effectiveness: { derivation: effectivenessDerivation, report: await loadEffectivenessRanking(root) } };
    } else if (subcommand === "workflow-evolution") {
      const derivation = await deriveWorkflowEvolution(root);
      output = { derivation, report: await loadWorkflowEvolution(root) };
    } else if (subcommand === "refinery") {
      output = await agentRefinery(root, args[0], Number(args[1] ?? 30));
    } else if (subcommand === "candidate") {
      if (!args[0]) throw new Error("usage: bun run query candidate <candidate-id>");
      output = await agentRefineryCandidate(root, args[0]);
    } else if (subcommand === "eval-plan") {
      if (!args[0]) throw new Error("usage: bun run query eval-plan <candidate-id>");
      output = await agentRefineryEvalPlan(root, args[0]);
    } else if (subcommand === "stats") output = queryStats(db);
    else if (subcommand === "legacy-search") {
      if (!args[0]) throw new Error("usage: bun run query legacy-search <fts-expression> [limit]");
      output = querySearch(db, args[0], Number(args[1] ?? 10));
    } else if (subcommand === "models") output = queryModels(db);
    else if (subcommand === "tokens") output = await duckTokenUsage(root);
    else if (subcommand === "usage-time") {
      const bucket = (args[0] ?? "month") as "day" | "month";
      if (bucket !== "day" && bucket !== "month") throw new Error("usage: bun run query usage-time [day|month] [limit]");
      output = await duckUsageOverTime(root, bucket, Number(args[1] ?? 60));
    } else if (subcommand === "tools") output = await duckToolFrequency(root, Number(args[0] ?? 30));
    else if (subcommand === "lengths") output = await duckSessionLengths(root);
    else throw new Error("usage: bun run query <search|semantic|get|grok|ask|ask-lexical|project|orchestration-profile|workflow-evolution|refinery|candidate|eval-plan|stats|models|tokens|usage-time|tools|lengths>");
    const currentProjection = projectionGuard.assert(db);
    if (
      currentProjection.manifestSourcesHash !== projection.manifestSourcesHash
      || currentProjection.reconciledAt !== projection.reconciledAt
      || currentProjection.activeSources !== projection.activeSources
    ) {
      throw new ActiveProjectionDriftError(
        "active source projection changed while serving the query; retry",
      );
    }
    console.log(JSON.stringify(output, null, 2));
  } catch (error: any) {
    console.log(JSON.stringify({ error: { message: redact(String(error?.message ?? error)), command: subcommand ?? null } }, null, 2));
    process.exitCode = 1;
  } finally { db.close(); }
} else if (command === "bridge") {
  if (subcommand !== "emit-pi" || !args[0]) throw new Error("usage: bun run src/cli.ts bridge emit-pi <conversation-hash> [history|summary] [output-path]");
  const mode = (args[1] ?? "summary") as PiBridgeMode;
  if (mode !== "history" && mode !== "summary") throw new Error("bridge mode must be history or summary");
  console.log(JSON.stringify(await emitPiBridge(root, args[0], mode, args[2]), null, 2));
} else {
  throw new Error("usage: bun run src/cli.ts <ingest|preview|import|receipts|source|derive|refine|query|bridge>");
}
