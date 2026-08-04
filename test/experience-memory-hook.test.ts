import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import packageMetadata from "../package.json" with { type: "json" };
import { PLUGIN_DATA_ROOT_MAX_AUTHORITY_DEPTH, resolvePluginDataRoot } from "../src/data-root";
import { contextPlaneFixture } from "./context-plane-fixture";
import { readContextSession } from "../src/context-session";

async function runHook(
  root: string,
  source: string,
  sessionId: string,
  script = "src/experience-memory-hook.ts",
  target: { provider: string; harness: string; model: string } = {
    provider: "openai",
    harness: "codex",
    model: "test-model",
  },
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const child = Bun.spawn([process.execPath, "run", script], {
    cwd: join(import.meta.dir, ".."),
    env: {
      ...process.env,
      CHATLOG_DATA_ROOT: root,
    },
    stdin: new Blob([
      JSON.stringify({
        session_id: sessionId,
        cwd: "/project",
        hook_event_name: "SessionStart",
        source,
        provider: target.provider,
        harness: target.harness,
        model: target.model,
        domain: "coding",
      }),
    ]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, exitCode };
}

test("SessionStart binds one context session to each native startup", async () => {
  const root = await mkdtemp(join(tmpdir(), "chatlog-context-hook-root-"));
  await contextPlaneFixture(root);

  const resume = await runHook(root, "resume", "session-1");
  expect(resume).toEqual({ stdout: "", stderr: "", exitCode: 0 });

  const first = await runHook(root, "startup", "session-1");
  expect(first.exitCode).toBe(0);
  expect(first.stderr).toBe("");
  const firstOutput = JSON.parse(first.stdout);
  const firstContext = firstOutput.hookSpecificOutput.additionalContext as string;
  expect(firstOutput.hookSpecificOutput.hookEventName).toBe("SessionStart");
  expect(firstContext).toContain("contextSessionId=");
  expect(firstContext).toContain("chatlog_context");
  expect(firstContext).toContain("chatlog_bounded_recall");
  const firstSessionId = firstContext.match(/contextSessionId=([a-f0-9]{64})/)?.[1];
  expect(firstSessionId).toBeTruthy();
  const persisted = await readContextSession(root, firstSessionId!);
  expect(persisted.ok).toBe(true);
  if (persisted.ok) expect(persisted.value.path).toBe("/project");

  const repeated = await runHook(root, "startup", "session-1");
  expect(repeated.stdout).toBe(first.stdout);

  const fresh = await runHook(root, "startup", "session-2");
  const freshContext = JSON.parse(fresh.stdout).hookSpecificOutput.additionalContext as string;
  const freshSessionId = freshContext.match(/contextSessionId=([a-f0-9]{64})/)?.[1];
  expect(freshSessionId).toBeTruthy();
  expect(freshSessionId).not.toBe(firstSessionId);
});

test("SessionStart rejects oversized hook input before JSON parsing", async () => {
  const child = Bun.spawn([process.execPath, "run", "src/experience-memory-hook.ts"], {
    cwd: join(import.meta.dir, ".."),
    stdin: new Blob(["x".repeat(128 * 1024)]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(exitCode).toBe(0);
  expect(stdout).toBe("");
  expect(stderr).toContain("Chatlog SessionStart input exceeds 65536 bytes");
});

test("generated plugin startup reopens Claude and Codex native sessions", async () => {
  const root = await mkdtemp(join(tmpdir(), "chatlog-generated-hook-root-"));
  await contextPlaneFixture(root);
  const generated = "plugins/chatlog-memory/scripts/session-start.js";
  const claude = { provider: "anthropic", harness: "claude-code", model: "claude-test" };
  const codex = { provider: "openai", harness: "codex", model: "codex-test" };
  const firstClaude = await runHook(root, "startup", "claude-native", generated, claude);
  const secondClaude = await runHook(root, "startup", "claude-native", generated, claude);
  const firstCodex = await runHook(root, "startup", "codex-native", generated, codex);
  const secondCodex = await runHook(root, "startup", "codex-native", generated, codex);
  expect(firstClaude.stderr).toBe("");
  expect(firstCodex.stderr).toBe("");
  expect(secondClaude.stdout).toBe(firstClaude.stdout);
  expect(secondCodex.stdout).toBe(firstCodex.stdout);
  expect(firstClaude.stdout).toContain("provider=anthropic");
  expect(firstCodex.stdout).toContain("provider=openai");
  const claudeContextId = firstClaude.stdout.match(/contextSessionId=([a-f0-9]{64})/)?.[1];
  const codexContextId = firstCodex.stdout.match(/contextSessionId=([a-f0-9]{64})/)?.[1];
  expect(claudeContextId).toBeTruthy();
  expect(codexContextId).toBeTruthy();
  expect(claudeContextId).not.toBe(codexContextId);
});

test("CLI locates the source plugin marketplace", async () => {
  const child = Bun.spawn([process.execPath, "run", "src/cli.ts", "plugin", "path"], {
    cwd: join(import.meta.dir, ".."),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
  const marketplace = stdout.trim();
  expect(marketplace).toBe(resolve(import.meta.dir, ".."));
  expect(await Bun.file(join(marketplace, ".claude-plugin", "marketplace.json")).exists()).toBe(
    true,
  );
});
test("generated plugin MCP bundle initializes and lists the bounded tools", async () => {
  const root = await mkdtemp(join(tmpdir(), "chatlog-generated-mcp-root-"));
  const transcript =
    [
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "plugin-smoke", version: "1" },
        },
      }),
      JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
      JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
    ].join("\n") + "\n";
  const child = Bun.spawn(
    [process.execPath, "--no-install", "plugins/chatlog-memory/scripts/chatlog-mcp.js"],
    {
      cwd: join(import.meta.dir, ".."),
      env: {
        ...process.env,
        CHATLOG_DATA_ROOT: root,
        CHATLOG_MCP_DOMAINS: "coding",
      },
      stdin: new Blob([transcript]),
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  const responses = stdout
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));

  expect(exitCode).toBe(0);
  expect(stderr).toBe("");
  expect(responses).toHaveLength(2);
  expect(responses[0]).toMatchObject({
    id: 1,
    result: { serverInfo: { name: "chatlog", version: packageMetadata.version } },
  });
  expect(responses[1].result.tools.map((tool: { name: string }) => tool.name)).toEqual([
    "chatlog_search",
    "chatlog_get_evidence",
    "chatlog_recent_work",
    "chatlog_project_brief",
    "chatlog_context",
    "chatlog_bounded_recall",
  ]);
});

test("packaged hook resolves either Claude or Codex plugin roots", async () => {
  const hooks = JSON.parse(
    await readFile(join(import.meta.dir, "../plugins/chatlog-memory/hooks/hooks.json"), "utf8"),
  );
  expect(hooks.hooks.SessionStart[0].hooks[0].command).toBe(
    'bun "${CLAUDE_PLUGIN_ROOT:-${PLUGIN_ROOT}}/scripts/session-start.js"',
  );
});

test("plugin root defaults to an operator-owned data directory", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "chatlog-plugin-workspace-"));
  await mkdir(join(workspace, ".git"));
  const dataHome = await mkdtemp(join(tmpdir(), "chatlog-plugin-data-home-"));
  const defaultRoot = join(dataHome, "chatlog");
  await mkdir(defaultRoot);
  const previousRoot = process.env.CHATLOG_DATA_ROOT;
  const previousDataHome = process.env.XDG_DATA_HOME;
  try {
    delete process.env.CHATLOG_DATA_ROOT;
    process.env.XDG_DATA_HOME = dataHome;
    const result = resolvePluginDataRoot(workspace);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe(defaultRoot);
  } finally {
    if (previousRoot === undefined) delete process.env.CHATLOG_DATA_ROOT;
    else process.env.CHATLOG_DATA_ROOT = previousRoot;
    if (previousDataHome === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = previousDataHome;
  }
});

test("plugin root rejects repository-contained roots and authority symlink escapes", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "chatlog-plugin-workspace-"));
  await mkdir(join(workspace, ".git"));
  const contained = join(workspace, "chatlog-data");
  await mkdir(contained);
  const containedResult = resolvePluginDataRoot(workspace, contained);
  expect(containedResult.ok).toBe(false);
  if (!containedResult.ok) {
    expect(containedResult.error.code).toBe("workspace-contained");
    expect(containedResult.error.message).toMatch(/inside the active workspace/);
  }

  const safeRoot = await mkdtemp(join(tmpdir(), "chatlog-plugin-safe-root-"));
  const outside = await mkdtemp(join(tmpdir(), "chatlog-plugin-outside-"));
  await symlink(outside, join(safeRoot, "corpus"));
  const escapeResult = resolvePluginDataRoot(workspace, safeRoot);
  expect(escapeResult.ok).toBe(false);
  if (!escapeResult.ok) {
    expect(escapeResult.error.code).toBe("symlink-escape");
    expect(escapeResult.error.message).toMatch(/symlink escape/);
  }

  const nestedRoot = await mkdtemp(join(tmpdir(), "chatlog-plugin-nested-root-"));
  const internalTarget = join(nestedRoot, "bridge");
  await mkdir(internalTarget);
  await symlink(internalTarget, join(nestedRoot, "memory"));
  await symlink(outside, join(internalTarget, "context-release"));
  const nestedEscape = resolvePluginDataRoot(workspace, nestedRoot);
  expect(nestedEscape.ok).toBe(false);
  if (!nestedEscape.ok) expect(nestedEscape.error.code).toBe("symlink-escape");
});

test("plugin root rejects configured roots containing the workspace or repository", async () => {
  const configuredRoot = await mkdtemp(join(tmpdir(), "chatlog-plugin-configured-root-"));
  const nestedWorkspace = join(configuredRoot, "workspace");
  await mkdir(join(nestedWorkspace, ".git"), { recursive: true });
  const workspaceContained = resolvePluginDataRoot(nestedWorkspace, configuredRoot);
  expect(workspaceContained.ok).toBe(false);
  if (!workspaceContained.ok) {
    expect(workspaceContained.error.code).toBe("workspace-contained");
    expect(workspaceContained.error.message).toMatch(/contains it/u);
  }

  const externalWorkspace = await mkdtemp(join(tmpdir(), "chatlog-plugin-external-workspace-"));
  const repository = join(configuredRoot, "repository");
  await mkdir(join(repository, ".git"), { recursive: true });
  await writeFile(join(externalWorkspace, ".git"), `gitdir: ${join(repository, ".git")}\n`);
  const repositoryContained = resolvePluginDataRoot(externalWorkspace, configuredRoot);
  expect(repositoryContained.ok).toBe(false);
  if (!repositoryContained.ok) {
    expect(repositoryContained.error.code).toBe("repository-contained");
    expect(repositoryContained.error.message).toMatch(/contains the active repository/u);
  }
});

test("plugin root rejects overdeep authority traversal", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "chatlog-plugin-workspace-depth-"));
  await mkdir(join(workspace, ".git"));
  const root = await mkdtemp(join(tmpdir(), "chatlog-plugin-root-depth-"));
  let nested = join(root, "analysis");
  await mkdir(nested);
  for (let depth = 0; depth <= PLUGIN_DATA_ROOT_MAX_AUTHORITY_DEPTH; depth += 1) {
    nested = join(nested, `nested-${depth}`);
    await mkdir(nested);
  }
  const result = resolvePluginDataRoot(workspace, root);
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.error.code).toBe("authority-unreadable");
    expect(result.error.message).toMatch(/depth limit/u);
  }
});
test("plugin root canonicalizes explicit operator-owned roots", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "chatlog-plugin-workspace-"));
  await mkdir(join(workspace, ".git"));
  const safeRoot = await mkdtemp(join(tmpdir(), "chatlog-plugin-safe-root-"));
  const result = resolvePluginDataRoot(workspace, safeRoot);
  expect(result.ok).toBe(true);
  if (result.ok) expect(result.value).toBe(safeRoot);
});
