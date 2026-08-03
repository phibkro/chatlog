#!/usr/bin/env bun
import { join, resolve } from "node:path";
import { prepareStartupMemory } from "./experience-memory";
import { readPublishedMemory } from "./experience-memory-store";
import { projectOf } from "./project-identity";

interface SessionStartInput {
  session_id?: unknown;
  cwd?: unknown;
  hook_event_name?: unknown;
  source?: unknown;
}

async function readInput(): Promise<SessionStartInput | undefined> {
  try {
    const text = await Bun.stdin.text();
    const input: unknown = JSON.parse(text);
    return typeof input === "object" && input !== null && !Array.isArray(input)
      ? (input as SessionStartInput)
      : undefined;
  } catch {
    return undefined;
  }
}

async function main(): Promise<void> {
  const input = await readInput();
  if (
    input?.hook_event_name !== "SessionStart" ||
    input.source !== "startup" ||
    typeof input.session_id !== "string" ||
    typeof input.cwd !== "string"
  ) {
    return;
  }

  const projectIdentity = projectOf(input.cwd);
  const root = resolve(process.env.CHATLOG_DATA_ROOT ?? projectIdentity);
  const published = await readPublishedMemory(root);
  if (!published.ok || published.value.pointer.projectIdentity !== projectIdentity) {
    return;
  }

  const pluginData =
    process.env.PLUGIN_DATA ?? process.env.CLAUDE_PLUGIN_DATA ?? join(root, "memory");
  const startup = await prepareStartupMemory({
    source: input.source,
    sessionId: input.session_id,
    snapshot: published.value.published.snapshot,
    pinDirectory: join(pluginData, "session-pins"),
  });
  if (!startup.ok || !startup.value.emitted) return;

  const context = [
    "Chatlog experience-memory routing index.",
    `Snapshot: ${startup.value.snapshotHash}`,
    "When a USE WHEN trigger applies, call chatlog_recall_memory with this snapshotHash and the exact memoryId. Do not recall unrelated cards.",
    "",
    startup.value.content.trimEnd(),
  ].join("\n");
  process.stdout.write(
    `${JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext: context,
      },
    })}\n`,
  );
}

await main();
