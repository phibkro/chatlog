import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AcceptedMemoryEntry, AcceptedMemoryLedger } from "../src/experience-memory";
import { publishAcceptedMemory } from "../src/experience-memory-store";
import { projectOf } from "../src/project-identity";

function ledger(root: string, id: string, alias: string): AcceptedMemoryLedger {
  const entry: AcceptedMemoryEntry = {
    id,
    status: "accepted",
    judgment: "correct",
    valence: "positive",
    provenance: {
      packetHash: "a".repeat(64),
      proposalSetHash: "b".repeat(64),
      operatorReviewHash: "c".repeat(64),
      candidateAlias: alias,
      candidateId: "d".repeat(20),
    },
    trigger: `trigger ${id}`,
    scope: { kind: "global", value: null },
    polarity: "check",
    action: `recall ${id}`,
    situation: `situation ${id}`,
    outcome: `outcome ${id}`,
    lesson: `lesson ${id}`,
    confidence: 0.9,
    freshness: "current",
    canonicalDocs: ["design-specs/experience-memory.md"],
    evidencePointers: [`chatlog://conversation/${"e".repeat(64)}/turn/1`],
  };
  return {
    schemaVersion: 1,
    ledgerId: "hook-test",
    projectIdentity: projectOf(root),
    entries: [entry],
  };
}

async function publish(root: string, id: string, alias: string): Promise<string> {
  const value = ledger(root, id, alias);
  const memory = value.entries[0]!;
  const packetHash = memory.provenance.packetHash;
  const proposals = {
    schemaVersion: 1,
    packetHash,
    generator: { provider: "test" },
    proposals: {
      [alias]: { lesson: memory.lesson, suggestedValence: memory.valence, rationale: "test" },
    },
  };
  const proposalBytes = `${JSON.stringify(proposals, null, 2)}\n`;
  memory.provenance.proposalSetHash = createHash("sha256").update(proposalBytes).digest("hex");
  const reviews = {
    schemaVersion: 1,
    packetHash,
    proposalSetHash: memory.provenance.proposalSetHash,
    reviewer: { id: "test" },
    reviews: {
      [alias]: {
        status: "reviewed",
        judgment: "correct",
        valence: memory.valence,
        feedback: "",
      },
    },
  };
  const reviewBytes = `${JSON.stringify(reviews, null, 2)}\n`;
  memory.provenance.operatorReviewHash = createHash("sha256").update(reviewBytes).digest("hex");
  const publicDirectory = join(root, "derived", "adjudication", "refinery", packetHash, "public");
  const privateDirectory = join(root, "derived", "adjudication", "refinery-private", packetHash);
  await Promise.all([
    mkdir(publicDirectory, { recursive: true }),
    mkdir(privateDirectory, { recursive: true }),
  ]);
  await Promise.all([
    writeFile(join(publicDirectory, "proposals.json"), proposalBytes),
    writeFile(join(publicDirectory, "operator-reviews.json"), reviewBytes),
    writeFile(
      join(privateDirectory, "manifest.json"),
      `${JSON.stringify({
        schemaVersion: 1,
        packetHash,
        candidates: [{ candidateAlias: alias, candidateId: memory.provenance.candidateId }],
      })}\n`,
    ),
  ]);
  await mkdir(join(root, "memory"), { recursive: true });
  await writeFile(
    join(root, "memory", "accepted-ledger.json"),
    `${JSON.stringify(value, null, 2)}\n`,
    { mode: 0o600 },
  );
  const result = await publishAcceptedMemory(root);
  expect(result.ok).toBe(true);
  return result.ok ? result.value.pointer.snapshotHash : "";
}

async function runHook(
  root: string,
  pluginData: string,
  source: string,
  sessionId: string,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const child = Bun.spawn([process.execPath, "run", "src/experience-memory-hook.ts"], {
    cwd: join(import.meta.dir, ".."),
    env: {
      ...process.env,
      CHATLOG_DATA_ROOT: root,
      CLAUDE_PLUGIN_DATA: pluginData,
    },
    stdin: new Blob([
      JSON.stringify({
        session_id: sessionId,
        cwd: root,
        hook_event_name: "SessionStart",
        source,
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

test("SessionStart injects only on startup and pins the first snapshot per session", async () => {
  const root = await mkdtemp(join(tmpdir(), "chatlog-memory-hook-root-"));
  const pluginData = await mkdtemp(join(tmpdir(), "chatlog-memory-hook-data-"));
  const firstHash = await publish(root, "memory-a", "C001");

  const resume = await runHook(root, pluginData, "resume", "session-1");
  expect(resume).toEqual({ stdout: "", stderr: "", exitCode: 0 });

  const first = await runHook(root, pluginData, "startup", "session-1");
  expect(first.exitCode).toBe(0);
  expect(first.stderr).toBe("");
  const firstOutput = JSON.parse(first.stdout);
  expect(firstOutput.hookSpecificOutput.hookEventName).toBe("SessionStart");
  expect(firstOutput.hookSpecificOutput.additionalContext).toContain(`Snapshot: ${firstHash}`);
  expect(firstOutput.hookSpecificOutput.additionalContext).toContain("## memory-a");

  await publish(root, "memory-b", "C002");
  const pinned = await runHook(root, pluginData, "startup", "session-1");
  expect(pinned.stdout).toBe(first.stdout);

  const fresh = await runHook(root, pluginData, "startup", "session-2");
  expect(fresh.stdout).toContain("## memory-b");
  expect(fresh.stdout).not.toContain("## memory-a");
});

test("packaged hook resolves either Claude or Codex plugin roots", async () => {
  const hooks = JSON.parse(
    await readFile(join(import.meta.dir, "../plugins/chatlog-memory/hooks/hooks.json"), "utf8"),
  );
  expect(hooks.hooks.SessionStart[0].hooks[0].command).toBe(
    'bun "${CLAUDE_PLUGIN_ROOT:-${PLUGIN_ROOT}}/scripts/session-start.js"',
  );
});
