#!/usr/bin/env bun
import { Database } from "bun:sqlite";
import { homedir } from "node:os";
import packageMetadata from "../package.json" with { type: "json" };
import { readClosedLoopArtifactFile } from "./closed-loop-artifact-file";
import { readBoundedFile } from "./importers/export-limits";
import { join, resolve } from "node:path";
import { ClaudeAdapter } from "./adapters/claude";
import { CodexAdapter } from "./adapters/codex";
import { OmpAdapter, PiAdapter } from "./adapters/pi";
import { DEFAULT_INGEST_MAX_SOURCES_PER_ADAPTER, ingest } from "./ingest";
import { openAnalysis, queryModels, querySearch, queryStats } from "./analysis";
import { deriveCorpus } from "./derive";
import {
  agentAsk,
  agentAskLexical,
  agentGet,
  agentGrok,
  agentProject,
  agentSearch,
  agentSemanticSearch,
} from "./agent-query";
import { duckSessionLengths, duckTokenUsage, duckToolFrequency, duckUsageOverTime } from "./duckdb";
import { clearDerivedInvalidation } from "./derived-invalidation";
import { redact } from "./redact";
import { refineCorpus } from "./refinery";
import { agentRefinery, agentRefineryCandidate, agentRefineryEvalPlan } from "./refinery-query";
import { queryUndocumented } from "./undocumented";
import type { PromotionType } from "./refinery";
import { emitPiBridge, type PiBridgeMode } from "./bridge";
import { deriveOrchestrationProfile, loadOrchestrationProfile } from "./orchestration-profile";
import { deriveRoleSegmentation, loadRoleSegmentation } from "./role-segmentation";
import { deriveEffectivenessRanking, loadEffectivenessRanking } from "./effectiveness-ranking";
import { deriveWorkflowEvolution, loadWorkflowEvolution } from "./workflow-evolution";
import { deriveWorkflowOutcomes, loadWorkflowOutcomes } from "./workflow-outcomes";
import { deriveWorkflowPatterns, loadWorkflowPatterns } from "./workflow-patterns";
import { importAnthropicExport, previewAnthropicExport } from "./importers/anthropic-export";
import { importChatGPTExport, previewChatGPTExport } from "./importers/chatgpt-export";
import { importGenericEvents, previewGenericEvents } from "./importers/generic-events";
import { normalizeConversationDomain } from "./domain";
import { resolveDataRoot } from "./data-root";
import { listImportReceipts } from "./import-receipts";
import { listSourceReceipts, readUnknownShapeNominations } from "./source-receipts";
import { recoverPendingOperations } from "./operation-intents";
import {
  ActiveProjectionDriftError,
  ActiveProjectionGuard,
  loadCorpusManifest,
  reconcileSourceAuthority,
} from "./source-authority";
import { withIngestLock } from "./lock";
import { emitVault } from "./vault";
import {
  publishAcceptedMemory,
  readPublishedMemory,
  recallPublishedMemory,
} from "./experience-memory-store";
import { applyInsightMigration, previewInsightMigration } from "./insight-migration";
import {
  applyInsightCommand,
  readCurrentInsightLedger,
  recompileCurrentInsightLedger,
} from "./insight-ledger";
import { proposeInsightConsolidations } from "./insight-compiler";
import type { InsightCommandInput } from "./insight-ledger";
import { ContextPlane } from "./context-plane";
import type {
  ConfirmContextEmissionInput,
  DeliverContextInput,
  PrepareContextInput,
  PreparedContext,
  StartContextPlaneSessionInput,
} from "./context-plane";
import { readContextEvents } from "./context-events";
import type { ContextFeedbackInput, ContextOutcomeInput } from "./context-events";
import { authorizeContextRelease } from "./context-release";
import type { ContextReceiptEvidence } from "./context-types";
import { isMcpDataFailure, McpData } from "./mcp/data";

const [command, subcommand, ...args] = process.argv.slice(2);
const importPreviewPin = (): {
  source: string;
  sourceContentHash: string;
  proposalId: string;
} => {
  const value = (name: string): string | null => {
    const index = args.indexOf(name);
    if (index === -1) return null;
    const candidate = args[index + 1];
    if (!candidate || candidate.startsWith("--"))
      throw new Error(`${name} requires a 64-character SHA-256 value`);
    return candidate;
  };
  const sourceContentHash = value("--source-content-hash");
  const proposalId = value("--proposal-id");
  if ((sourceContentHash === null) !== (proposalId === null))
    throw new Error("--source-content-hash and --proposal-id must be supplied together");
  if (!sourceContentHash || !proposalId)
    throw new Error(
      "import requires --source-content-hash and --proposal-id copied from chatlog preview",
    );
  if (!/^[a-f0-9]{64}$/u.test(sourceContentHash) || !/^[a-f0-9]{64}$/u.test(proposalId))
    throw new Error("preview pins must be lowercase 64-character SHA-256 values");
  return { source: resolve(args[0]!), sourceContentHash, proposalId };
};
function ingestEnvironmentInteger(name: string, fallback: number, minimum: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum)
    throw new Error(`${name} must be a safe integer greater than or equal to ${minimum}`);
  return value;
}

const help = `Chatlog ${packageMetadata.version}

Usage: chatlog <command> [arguments]

Commands:
  ingest                 Ingest configured local provider histories
  preview|import         Inspect or import ChatGPT, Anthropic, or generic exports
  derive|refine          Rebuild evidence and refinery projections
  query                  Search and inspect the active corpus
  memory|insight         Manage governed memory and insight ledgers
  context                Start, deliver, recall, and evaluate context
  bridge                 Emit an inert cross-harness handoff artifact
  plugin                 Locate the Claude Code and Codex plugin marketplace
  receipts|source|vault  Inspect provenance or export a local vault

Run "chatlog <command>" without required arguments for command-specific usage.`;
const root = resolveDataRoot();
const localAdapters = () => {
  const home = homedir();
  return [
    new ClaudeAdapter(`${home}/.claude/projects`),
    new CodexAdapter(`${home}/.codex/sessions`),
    new PiAdapter(`${home}/.pi/agent/sessions`),
    new OmpAdapter(`${home}/.omp/agent/sessions`),
  ];
};

function cliContextAssertion<T extends ContextFeedbackInput | ContextOutcomeInput>(input: T): T {
  return {
    ...input,
    actor: { kind: "tool", name: "chatlog-cli" },
    actorAuthority: "tool",
  } as T;
}
const CLI_JSON_INPUT_MAX_BYTES = 1_048_576;
type CliJsonResult =
  | { ok: true; value: unknown }
  | { ok: false; error: { code: "invalid-input"; message: string } };

async function readCliJson(path: string, label: string): Promise<CliJsonResult> {
  try {
    const content = await readBoundedFile(resolve(path), CLI_JSON_INPUT_MAX_BYTES, `${label} JSON`);
    if (!content.ok)
      return {
        ok: false,
        error: {
          code: "invalid-input",
          message: `could not read ${label}: ${content.error.message}`,
        },
      };
    return { ok: true, value: JSON.parse(content.value.text) };
  } catch (error) {
    return {
      ok: false,
      error: {
        code: "invalid-input",
        message: `${label} must be valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      },
    };
  }
}

async function readContextGateJson(
  path: string,
): Promise<
  { ok: true; value: unknown } | { ok: false; error: { code: "invalid-input"; message: string } }
> {
  const decoded = await readClosedLoopArtifactFile(path);
  return decoded.ok
    ? decoded
    : {
        ok: false,
        error: {
          code: "invalid-input",
          message: `could not decode context gate: ${decoded.error}`,
        },
      };
}

if (!command || command === "--help" || command === "-h" || command === "help") {
  console.log(help);
} else if (command === "--version" || command === "-v") {
  console.log(packageMetadata.version);
} else if (command === "ingest") {
  console.log(
    JSON.stringify(
      await ingest(localAdapters(), root, {
        maxSourcesPerAdapter: ingestEnvironmentInteger(
          "CHATLOG_INGEST_MAX_SOURCES_PER_ADAPTER",
          DEFAULT_INGEST_MAX_SOURCES_PER_ADAPTER,
          1,
        ),
        minimumSourceAgeMs: ingestEnvironmentInteger("CHATLOG_INGEST_MIN_SOURCE_AGE_MS", 5_000, 0),
      }),
      null,
      2,
    ),
  );
} else if (command === "preview") {
  if (!subcommand || !args[0])
    throw new Error("usage: chatlog preview <anthropic|chatgpt|generic> <export-path> [domain]");
  const domain = normalizeConversationDomain(
    args[1] && !args[1].startsWith("--")
      ? args[1]
      : subcommand === "chatgpt"
        ? "personal"
        : "general",
  );
  const result =
    subcommand === "anthropic"
      ? await previewAnthropicExport(args[0], root, { domain })
      : subcommand === "chatgpt"
        ? await previewChatGPTExport(args[0], root, { domain })
        : subcommand === "generic"
          ? await previewGenericEvents(args[0], root, { domain })
          : (() => {
              throw new Error(
                "usage: chatlog preview <anthropic|chatgpt|generic> <export-path> [domain]",
              );
            })();
  console.log(JSON.stringify(result, null, 2));
} else if (command === "import") {
  if (!subcommand || !args[0])
    throw new Error(
      "usage: chatlog import <anthropic|chatgpt|generic> <source-path> [domain] [--no-derive] --source-content-hash <sha256> --proposal-id <sha256>",
    );
  const domain = normalizeConversationDomain(
    args[1] && !args[1].startsWith("--")
      ? args[1]
      : subcommand === "chatgpt"
        ? "personal"
        : "general",
  );
  const preview = importPreviewPin();
  const options = {
    domain,
    derive: !args.includes("--no-derive"),
    preview,
  };
  const result =
    subcommand === "anthropic"
      ? await importAnthropicExport(args[0], root, options)
      : subcommand === "chatgpt"
        ? await importChatGPTExport(args[0], root, options)
        : subcommand === "generic"
          ? await importGenericEvents(args[0], root, options)
          : (() => {
              throw new Error(
                "usage: chatlog import <anthropic|chatgpt|generic> <source-path> [domain] [--no-derive] --source-content-hash <sha256> --proposal-id <sha256>",
              );
            })();
  console.log(JSON.stringify(result, null, 2));
} else if (command === "receipts") {
  if (
    subcommand &&
    subcommand !== "imports" &&
    subcommand !== "sources" &&
    subcommand !== "nominations" &&
    !/^\d+$/.test(subcommand)
  )
    throw new Error("usage: chatlog receipts [imports|sources|nominations] [limit]");
  const limitText =
    subcommand === "imports" || subcommand === "sources" || subcommand === "nominations"
      ? args[0]
      : subcommand;
  if (limitText && !/^[1-9]\d*$/.test(limitText))
    throw new Error("receipt limit must be a positive integer");
  const limit = Number(limitText ?? 20);
  if (!Number.isSafeInteger(limit) || limit > 200)
    throw new Error("receipt limit must be at most 200");
  const output =
    subcommand === "sources"
      ? await listSourceReceipts(root, limit)
      : subcommand === "nominations"
        ? await readUnknownShapeNominations(root)
        : await listImportReceipts(root, limit);
  console.log(JSON.stringify(output, null, 2));
} else if (command === "source") {
  if (args.length || (subcommand !== "reconcile" && subcommand !== "recover"))
    throw new Error("usage: chatlog source <reconcile|recover>");
  console.log(
    JSON.stringify(
      await withIngestLock(root, async () => {
        const recovery = await recoverPendingOperations(root);
        if (subcommand === "recover") return recovery;
        const manifest = await loadCorpusManifest(root);
        const db = openAnalysis(join(root, "analysis", "chatlog.sqlite"));
        try {
          return {
            ...(await reconcileSourceAuthority(root, db, manifest.sources)),
            recovery,
          };
        } finally {
          db.close();
        }
      }),
      null,
      2,
    ),
  );
} else if (command === "derive") {
  console.log(
    JSON.stringify(
      await withIngestLock(root, async () => {
        await recoverPendingOperations(root);
        const derived = await deriveCorpus(root);
        const refinery = await refineCorpus(root, 3, { allowExplicitInvalidation: true });
        await clearDerivedInvalidation(root);
        return { derived, refinery };
      }),
      null,
      2,
    ),
  );
} else if (command === "refine") {
  console.log(
    JSON.stringify(
      await withIngestLock(root, async () => {
        await recoverPendingOperations(root);
        return refineCorpus(root, Number(subcommand ?? 3));
      }),
      null,
      2,
    ),
  );
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
      if (!args[0])
        throw new Error("usage: bun run query semantic <topic> [limit] [candidate-limit]");
      output = await agentSemanticSearch(
        db,
        root,
        args[0],
        Number(args[1] ?? 10),
        Number(args[2] ?? 40),
      );
    } else if (subcommand === "get") {
      if (!args[0]) throw new Error("usage: bun run query get <session-id-or-hash> [turn-index]");
      output = await agentGet(db, root, args[0], args[1] == null ? undefined : Number(args[1]));
    } else if (subcommand === "grok") {
      if (!args[0]) throw new Error("usage: bun run query grok <topic> [limit]");
      output = await agentGrok(db, root, args[0], Number(args[1] ?? 10));
    } else if (subcommand === "ask") {
      if (!args[0])
        throw new Error('usage: bun run query ask "what did I try last time for X" [limit]');
      output = await agentAsk(db, root, args[0], Number(args[1] ?? 10));
    } else if (subcommand === "ask-lexical") {
      if (!args[0])
        throw new Error(
          'usage: bun run query ask-lexical "what did I try last time for X" [limit]',
        );
      output = await agentAskLexical(db, root, args[0], Number(args[1] ?? 10));
    } else if (subcommand === "project") {
      if (!args[0]) throw new Error("usage: bun run query project <exact-project-path>");
      output = await agentProject(db, root, args[0]);
    } else if (subcommand === "orchestration-profile") {
      const derivation = await deriveOrchestrationProfile(root);
      const roleDerivation = await deriveRoleSegmentation(root);
      const effectivenessDerivation = await deriveEffectivenessRanking(root);
      output = {
        derivation,
        report: await loadOrchestrationProfile(root),
        roleSegmentation: { derivation: roleDerivation, report: await loadRoleSegmentation(root) },
        effectiveness: {
          derivation: effectivenessDerivation,
          report: await loadEffectivenessRanking(root),
        },
      };
    } else if (subcommand === "workflow-evolution") {
      const derivation = await deriveWorkflowEvolution(root);
      output = { derivation, report: await loadWorkflowEvolution(root) };
    } else if (subcommand === "workflow-outcomes") {
      const workflowDerivation = await deriveWorkflowEvolution(root);
      const derivation = await deriveWorkflowOutcomes(root);
      output = {
        workflowDerivation,
        derivation,
        report: await loadWorkflowOutcomes(root),
      };
    } else if (subcommand === "workflow-patterns") {
      const workflowDerivation = await deriveWorkflowEvolution(root);
      const outcomesDerivation = await deriveWorkflowOutcomes(root);
      const derivation = await deriveWorkflowPatterns(root);
      output = {
        workflowDerivation,
        outcomesDerivation,
        derivation,
        report: await loadWorkflowPatterns(root),
      };
    } else if (subcommand === "refinery") {
      output = await agentRefinery(root, args[0], Number(args[1] ?? 30));
    } else if (subcommand === "undocumented") {
      const projectIdx = args.indexOf("--project");
      if (projectIdx === -1 || !args[projectIdx + 1])
        throw new Error(
          "usage: bun run query undocumented --project <path> [--type claude-md,gotcha-skill,memory-or-adr]",
        );
      const project = resolve(args[projectIdx + 1]!);
      const typeIdx = args.indexOf("--type");
      const types =
        typeIdx === -1 || !args[typeIdx + 1]
          ? undefined
          : (args[typeIdx + 1]!.split(",") as PromotionType[]);
      output = await queryUndocumented(root, project, { types });
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
      if (bucket !== "day" && bucket !== "month")
        throw new Error("usage: bun run query usage-time [day|month] [limit]");
      output = await duckUsageOverTime(root, bucket, Number(args[1] ?? 60));
    } else if (subcommand === "tools")
      output = await duckToolFrequency(root, Number(args[0] ?? 30));
    else if (subcommand === "lengths") output = await duckSessionLengths(root);
    else
      throw new Error(
        "usage: bun run query <search|semantic|get|grok|ask|ask-lexical|project|orchestration-profile|workflow-evolution|workflow-outcomes|workflow-patterns|refinery|undocumented|candidate|eval-plan|stats|models|tokens|usage-time|tools|lengths>",
      );
    const currentProjection = projectionGuard.assert(db);
    if (
      currentProjection.manifestSourcesHash !== projection.manifestSourcesHash ||
      currentProjection.reconciledAt !== projection.reconciledAt ||
      currentProjection.activeSources !== projection.activeSources
    ) {
      throw new ActiveProjectionDriftError(
        "active source projection changed while serving the query; retry",
      );
    }
    console.log(JSON.stringify(output, null, 2));
  } catch (error: any) {
    console.log(
      JSON.stringify(
        {
          error: { message: redact(String(error?.message ?? error)), command: subcommand ?? null },
        },
        null,
        2,
      ),
    );
    process.exitCode = 1;
  } finally {
    db.close();
  }
} else if (command === "bridge") {
  if (subcommand !== "emit-pi" || !args[0])
    throw new Error(
      "usage: bun run src/cli.ts bridge emit-pi <conversation-hash> [history|summary] [output-path]",
    );
  const mode = (args[1] ?? "summary") as PiBridgeMode;
  if (mode !== "history" && mode !== "summary")
    throw new Error("bridge mode must be history or summary");
  console.log(JSON.stringify(await emitPiBridge(root, args[0], mode, args[2]), null, 2));
} else if (command === "memory") {
  let result: unknown;
  if (subcommand === "publish") {
    result = await publishAcceptedMemory(root, args[0]);
  } else if (subcommand === "current") {
    result = await readPublishedMemory(root, args[0]);
  } else if (subcommand === "recall" && args[0] && args[1]) {
    result = await recallPublishedMemory(root, args[0], args[1]);
  } else {
    result = {
      ok: false,
      error: {
        code: "invalid-memory-command",
        message:
          "usage: chatlog memory <publish [ledger-path]|current [snapshot-hash]|recall <snapshot-hash> <memory-id>>",
      },
    };
  }
  console.log(JSON.stringify(result, null, 2));
  if (typeof result === "object" && result !== null && "ok" in result && result.ok === false) {
    process.exitCode = 1;
  }
} else if (command === "insight") {
  let result: unknown;
  if (subcommand === "migrate") {
    const ledgerPath = args.find((argument) => !argument.startsWith("--"));
    result = args.includes("--apply")
      ? await applyInsightMigration(root, ledgerPath ? { ledgerPath: resolve(ledgerPath) } : {})
      : await previewInsightMigration(root, ledgerPath ? { ledgerPath: resolve(ledgerPath) } : {});
  } else if (subcommand === "preview") {
    const current = await readCurrentInsightLedger(root);
    result = current.ok
      ? {
          ok: true,
          value: {
            current: current.value,
            consolidations: proposeInsightConsolidations(current.value.projection),
          },
        }
      : current;
  } else if (subcommand === "current") {
    const current = await readCurrentInsightLedger(root);
    result = current.ok
      ? args.includes("--history")
        ? {
            ok: true,
            value: { pointer: current.value.pointer, history: current.value.ledger.transitions },
          }
        : {
            ok: true,
            value: { pointer: current.value.pointer, current: current.value.projection.current },
          }
      : current;
  } else if (subcommand === "recompile") {
    result = await recompileCurrentInsightLedger(root);
  } else if (subcommand === "apply") {
    if (!args[0]) {
      result = {
        ok: false,
        error: {
          code: "invalid-insight-command",
          message: "usage: chatlog insight apply <command.json>|migrate",
        },
      };
    } else if (args[0] === "migrate") {
      result = await applyInsightMigration(root);
    } else {
      const commandInput = await readCliJson(args[0], "insight command");
      result = commandInput.ok
        ? await applyInsightCommand(root, commandInput.value as InsightCommandInput)
        : commandInput;
    }
  } else {
    result = {
      ok: false,
      error: {
        code: "invalid-insight-command",
        message: "usage: chatlog insight <migrate|preview|apply|current|recompile>",
      },
    };
  }
  console.log(JSON.stringify(result, null, 2));
  if (typeof result === "object" && result !== null && "ok" in result && result.ok === false)
    process.exitCode = 1;
} else if (command === "context") {
  const plane = new ContextPlane(root);
  let result: unknown;
  if (subcommand === "start" && args[0]) {
    const decoded = await readCliJson(args[0], "context start input");
    result = decoded.ok
      ? await plane.startSession(decoded.value as StartContextPlaneSessionInput)
      : decoded;
  } else if (subcommand === "list" && args.length === 0) {
    result = await plane.listSessions();
  } else if (subcommand === "events" && args[0]) {
    result = await readContextEvents(root, { contextSessionId: args[0] });
  } else if (subcommand === "prepare" && args[0]) {
    const decoded = await readCliJson(args[0], "context prepare input");
    result = decoded.ok ? await plane.prepare(decoded.value as PrepareContextInput) : decoded;
  } else if (subcommand === "authorize" && args[0]) {
    const gate = await readContextGateJson(resolve(args[0]));
    result = gate.ok ? await authorizeContextRelease(root, gate.value) : gate;
  } else if (subcommand === "deliver" && args[0]) {
    const decoded = await readCliJson(args[0], "context deliver input");
    result = decoded.ok ? await plane.deliver(decoded.value as DeliverContextInput) : decoded;
  } else if (subcommand === "recall" && args[0]) {
    const decoded = await readCliJson(args[0], "context recall input");
    if (!decoded.ok) {
      result = decoded;
    } else {
      const data = new McpData(root);
      try {
        const recalled = await data.boundedRecall(decoded.value as Record<string, unknown>);
        result = isMcpDataFailure(recalled)
          ? {
              ok: false,
              error: { code: "recall-failed", message: recalled.error.message },
            }
          : { ok: true, value: recalled };
      } catch (error) {
        result = {
          ok: false,
          error: {
            code: "recall-failed",
            message: error instanceof Error ? error.message : String(error),
          },
        };
      } finally {
        data.close();
      }
    }
  } else if (subcommand === "confirm" && args[0] && args[1] && args[2]) {
    const receiptEvidence = args[2] as ContextReceiptEvidence;
    if (
      !["hook-output", "tool-result", "prompt-artifact", "provider-acknowledgment"].includes(
        receiptEvidence,
      )
    )
      throw new Error("context receipt evidence is not recognized");
    const preparedInput = await readCliJson(args[0], "context prepared input");
    const receiptInput = args[3]
      ? await readCliJson(args[3], "context receipt input")
      : ({ ok: true, value: {} } as const);
    if (!preparedInput.ok || !receiptInput.ok) {
      result = !preparedInput.ok ? preparedInput : receiptInput;
    } else {
      const prepared = preparedInput.value as PreparedContext;
      const releaseGateHash = args[1];
      const receipt = receiptInput.value as Record<string, unknown>;
      const input: ConfirmContextEmissionInput = {
        prepared,
        releaseGateHash,
        receiptEvidence,
        receipt,
      };
      result = await plane.confirmEmission(input);
    }
  } else if (subcommand === "feedback" && args[0]) {
    const decoded = await readCliJson(args[0], "context feedback input");
    result = decoded.ok
      ? await plane.feedback(cliContextAssertion(decoded.value as ContextFeedbackInput))
      : decoded;
  } else if (subcommand === "outcome" && args[0]) {
    const decoded = await readCliJson(args[0], "context outcome input");
    result = decoded.ok
      ? await plane.outcome(cliContextAssertion(decoded.value as ContextOutcomeInput))
      : decoded;
  } else {
    result = {
      ok: false,
      error: {
        code: "invalid-context-command",
        message:
          "usage: chatlog context <start <session.json>|list|events <session-id>|prepare <request.json>|authorize <gate.json>|deliver <request.json>|recall <request.json>|confirm <prepared.json> <gate-hash> <receipt-evidence> [receipt.json]|feedback <feedback.json>|outcome <outcome.json>>",
      },
    };
  }
  console.log(JSON.stringify(result, null, 2));
  if (typeof result === "object" && result !== null && "ok" in result && result.ok === false)
    process.exitCode = 1;
} else if (command === "plugin") {
  if (subcommand !== "path" || args.length) throw new Error("usage: chatlog plugin path");
  const installedMarketplace = resolve(import.meta.dir, "../marketplace");
  const sourceMarketplace = resolve(import.meta.dir, "..");
  const marketplace = (await Bun.file(
    join(installedMarketplace, ".claude-plugin", "marketplace.json"),
  ).exists())
    ? installedMarketplace
    : sourceMarketplace;
  if (!(await Bun.file(join(marketplace, ".claude-plugin", "marketplace.json")).exists()))
    throw new Error("Chatlog plugin marketplace is missing from this installation");
  console.log(marketplace);
} else if (command === "vault") {
  const outputDir = resolve(
    subcommand && !subcommand.startsWith("--")
      ? subcommand
      : join(homedir(), "obsidian-vaults", "chatlog"),
  );
  const limitIdx = args.indexOf("--limit");
  const limit = limitIdx === -1 ? undefined : Number(args[limitIdx + 1]);
  const sinceIdx = args.indexOf("--since");
  const since = sinceIdx === -1 ? undefined : args[sinceIdx + 1];
  console.log(JSON.stringify(await emitVault(root, outputDir, { limit, since }), null, 2));
} else {
  throw new Error(
    "usage: bun run src/cli.ts <ingest|preview|import|receipts|source|derive|refine|query|bridge|memory|insight|context|vault>",
  );
}
