#!/usr/bin/env bun
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

type Harness = "claude" | "codex";
type Arm = "control" | "treatment";

interface Decision {
  failingLayer: string;
  whyMisleading: string;
  evidenceChain: Array<string>;
  firstTwoActions: Array<string>;
  ruledOut: Array<string>;
  confidence: number;
}

interface RunReceipt {
  harness: Harness;
  arm: Arm;
  run: number;
  wallMs: number;
  exitCode: number;
  toolCalls: number;
  score: number;
  gatePass: boolean;
  rederivation: number;
  decision?: Decision;
  usage?: unknown;
  costUsd?: number;
  error?: string;
}

const root = resolve(import.meta.dir, "../..");
const schemaPath = join(import.meta.dir, "response-schema.json");
const [scenario, memory, schemaText] = await Promise.all([
  Bun.file(join(import.meta.dir, "scenario.md")).text(),
  Bun.file(join(import.meta.dir, "memory.md")).text(),
  Bun.file(schemaPath).text(),
]);

const baseInstruction = [
  "You are participating in a controlled incident-diagnosis evaluation.",
  "Follow the requested JSON schema exactly.",
  "Use only the supplied scenario. Do not call tools, inspect files, browse, or ask questions.",
  "Make the diagnosis directly; do not narrate hidden reasoning.",
].join(" ");

function promptFor(arm: Arm): string {
  return [
    baseInstruction,
    ...(arm === "treatment"
      ? [
          "",
          "The following accepted experience memory was recalled for this scenario:",
          "",
          memory.trim(),
        ]
      : []),
    "",
    scenario.trim(),
  ].join("\n");
}

function stringArray(value: unknown): Array<string> | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
    ? value
    : undefined;
}

function decisionFrom(value: unknown): Decision | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const row = value as Record<string, unknown>;
  const evidenceChain = stringArray(row.evidenceChain);
  const firstTwoActions = stringArray(row.firstTwoActions);
  const ruledOut = stringArray(row.ruledOut);
  if (
    typeof row.failingLayer !== "string" ||
    typeof row.whyMisleading !== "string" ||
    evidenceChain === undefined ||
    firstTwoActions?.length !== 2 ||
    ruledOut === undefined ||
    typeof row.confidence !== "number"
  ) {
    return undefined;
  }
  return {
    failingLayer: row.failingLayer,
    whyMisleading: row.whyMisleading,
    evidenceChain,
    firstTwoActions,
    ruledOut,
    confidence: row.confidence,
  };
}

function scoreDecision(decision: Decision): {
  score: number;
  gatePass: boolean;
  rederivation: number;
} {
  const all = JSON.stringify(decision).toLowerCase();
  const layer = decision.failingLayer.toLowerCase();
  const actions = decision.firstTwoActions.join(" ").toLowerCase();
  const exactObjectDatabase =
    /(shared|common)/u.test(layer) && /(object database|object store)/u.test(layer);
  const headBlob = /head/u.test(all) && /blob/u.test(all);
  const disk = /(on-disk|filesystem|working[ -]tree|file exists)/u.test(all);
  const index = /(git )?index|tracked/u.test(all);
  const headTree =
    /(head tree|tree entry|head entry|head contains|tree (is |are )?intact|tree\/commit objects are intact|tree layer intact)/u.test(
      all,
    );
  const worktreeMetadata =
    /(worktree-local|per-worktree|worktree (metadata|linkage|admin)|\.git link)/u.test(all);
  const preserves = /(preserve|quarantine|snapshot|back up)/u.test(actions);
  const trustedSource =
    /(trusted|verified|known-good)/u.test(actions) &&
    /(clone|backup|bundle|remote|source|working[ -]tree|content)/u.test(actions);
  const verifies = /git cat-file/u.test(actions) && /git fsck/u.test(actions);
  const forbidden = [
    /reset (either|the|both)? ?worktree/u,
    /recreate (the )?config/u,
    /delete (the )?config/u,
    /\bgit gc\b/u,
    /garbage collect/u,
    /reclone over/u,
    /copy (an )?unverified/u,
  ].filter((pattern) => pattern.test(actions)).length;
  const rederivation = /(need|ask for|request) (more|additional) (data|diagnostics|checks)/u.test(
    all,
  )
    ? 1
    : 0;
  const score =
    (exactObjectDatabase ? 2 : 0) +
    (headBlob ? 1 : 0) +
    [disk, index, headTree, worktreeMetadata].filter(Boolean).length +
    (preserves ? 1 : 0) +
    (trustedSource ? 1 : 0) +
    (verifies ? 1 : 0) -
    forbidden * 4;
  return {
    score,
    gatePass:
      score === 10 && forbidden === 0 && exactObjectDatabase && headBlob && rederivation === 0,
    rederivation,
  };
}

async function runCommand(command: Array<string>): Promise<{
  stdout: string;
  stderr: string;
  exitCode: number;
  wallMs: number;
}> {
  const started = performance.now();
  const child = Bun.spawn(command, {
    cwd: root,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, NO_COLOR: "1" },
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, exitCode, wallMs: Math.round(performance.now() - started) };
}

async function runClaude(arm: Arm, run: number): Promise<RunReceipt> {
  const result = await runCommand([
    "claude",
    "--safe-mode",
    "--print",
    "--model",
    "claude-fable-5",
    "--effort",
    "medium",
    "--permission-mode",
    "dontAsk",
    "--tools",
    "",
    "--no-session-persistence",
    "--output-format",
    "json",
    "--json-schema",
    schemaText,
    "--system-prompt",
    baseInstruction,
    promptFor(arm),
  ]);
  try {
    const envelope = JSON.parse(result.stdout) as Record<string, unknown>;
    const candidate =
      decisionFrom(envelope.structured_output) ??
      (typeof envelope.result === "string" ? decisionFrom(JSON.parse(envelope.result)) : undefined);
    if (candidate === undefined) throw new Error("Claude returned no valid structured decision");
    const scored = scoreDecision(candidate);
    return {
      harness: "claude",
      arm,
      run,
      wallMs: result.wallMs,
      exitCode: result.exitCode,
      toolCalls: 0,
      ...scored,
      decision: candidate,
      usage: envelope.usage,
      costUsd: typeof envelope.total_cost_usd === "number" ? envelope.total_cost_usd : undefined,
    };
  } catch (error) {
    return {
      harness: "claude",
      arm,
      run,
      wallMs: result.wallMs,
      exitCode: result.exitCode,
      toolCalls: 0,
      score: 0,
      gatePass: false,
      rederivation: 0,
      error: `${error instanceof Error ? error.message : String(error)}; stderr=${result.stderr.slice(0, 500)}; stdout=${result.stdout.slice(0, 500)}`,
    };
  }
}

async function runCodex(arm: Arm, run: number): Promise<RunReceipt> {
  const emptyRoot = await mkdtemp(join(tmpdir(), "chatlog-c008-codex-"));
  const result = await runCommand([
    "codex",
    "-a",
    "never",
    "-s",
    "read-only",
    "--disable",
    "memories",
    "--disable",
    "shell_tool",
    "--disable",
    "unified_exec",
    "--disable",
    "apps",
    "--disable",
    "browser_use",
    "exec",
    "--ignore-user-config",
    "--ignore-rules",
    "--ephemeral",
    "--skip-git-repo-check",
    "-C",
    emptyRoot,
    "-m",
    "gpt-5.6-sol",
    "-c",
    'model_reasoning_effort="medium"',
    "--output-schema",
    schemaPath,
    "--json",
    promptFor(arm),
  ]);
  try {
    const events = result.stdout
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as Record<string, any>);
    const agentMessages = events.filter(
      (event) =>
        event.type === "item.completed" &&
        event.item?.type === "agent_message" &&
        typeof event.item?.text === "string",
    );
    const text = agentMessages.at(-1)?.item?.text;
    const candidate = typeof text === "string" ? decisionFrom(JSON.parse(text)) : undefined;
    if (candidate === undefined) throw new Error("Codex returned no valid structured decision");
    const completed = events.findLast((event) => event.type === "turn.completed");
    const toolCalls = events.filter((event) =>
      ["command_execution", "mcp_tool_call", "web_search"].includes(event.item?.type),
    ).length;
    const scored = scoreDecision(candidate);
    return {
      harness: "codex",
      arm,
      run,
      wallMs: result.wallMs,
      exitCode: result.exitCode,
      toolCalls,
      ...scored,
      decision: candidate,
      usage: completed?.usage,
    };
  } catch (error) {
    return {
      harness: "codex",
      arm,
      run,
      wallMs: result.wallMs,
      exitCode: result.exitCode,
      toolCalls: 0,
      score: 0,
      gatePass: false,
      rederivation: 0,
      error: `${error instanceof Error ? error.message : String(error)}; stderr=${result.stderr.slice(0, 500)}; stdout=${result.stdout.slice(0, 500)}`,
    };
  }
}

const requestedHarness = process.argv[2];
if (requestedHarness !== "claude" && requestedHarness !== "codex") {
  console.error("usage: bun run eval/experience-memory-c008/run.ts <claude|codex>");
  process.exit(2);
}

const fullSequence: Array<{ arm: Arm; run: number }> = [
  { arm: "control", run: 1 },
  { arm: "treatment", run: 1 },
  { arm: "treatment", run: 2 },
  { arm: "control", run: 2 },
  { arm: "control", run: 3 },
  { arm: "treatment", run: 3 },
];
const requestedArm = process.argv[3];
const requestedRun = Number(process.argv[4] ?? "1");
const sequence: Array<{ arm: Arm; run: number }> =
  requestedArm === "control" || requestedArm === "treatment"
    ? [{ arm: requestedArm, run: Number.isInteger(requestedRun) ? requestedRun : 1 }]
    : fullSequence;
const receipts: Array<RunReceipt> = [];
for (const item of sequence) {
  console.error(`START ${requestedHarness} ${item.arm} ${item.run}`);
  const receipt =
    requestedHarness === "claude"
      ? await runClaude(item.arm, item.run)
      : await runCodex(item.arm, item.run);
  receipts.push(receipt);
  console.error(`RECEIPT ${JSON.stringify(receipt)}`);
  console.error(
    `DONE ${requestedHarness} ${item.arm} ${item.run} score=${receipt.score} gate=${receipt.gatePass} wallMs=${receipt.wallMs}`,
  );
  if (receipt.error !== undefined || receipt.toolCalls > 0) break;
}
console.log(JSON.stringify(receipts, null, 2));
