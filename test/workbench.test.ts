import { expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { indexConversation, openAnalysis } from "../src/analysis";
import { WorkbenchData } from "../src/workbench/data";
import { workbenchHandler } from "../src/workbench/server";
import type { Conversation } from "../src/types";

test("serves overview, local search, and canonical evidence from one corpus", async () => {
  const root = await mkdtemp(join(tmpdir(), "chatlog-workbench-"));
  const conversation: Conversation = {
    id: "session",
    title: "Nix source visibility",
    provider: "openai",
    harness: "codex",
    domain: "coding",
    sourceKind: "session-log",
    project: "/project",
    cwd: "/project",
    model: "model",
    startedAt: "2026-01-01T10:00:00Z",
    endedAt: "2026-01-01T10:01:00Z",
    sourcePath: "/source",
    contentHash: "a".repeat(64),
    turns: [
      { role: "user", content: "Why is the Nix flake source invisible?" },
      { role: "assistant", content: "Track the file before evaluating the flake." },
    ],
  };
  const db = openAnalysis(join(root, "analysis", "chatlog.sqlite"));
  indexConversation(db, conversation, 1, 1);
  db.close();
  await mkdir(join(root, "corpus", "objects", "aa"), { recursive: true });
  await writeFile(join(root, "corpus", "objects", "aa", `${conversation.contentHash}.json`), JSON.stringify(conversation));

  const data = new WorkbenchData(root);
  expect(await data.overview()).toMatchObject({ ready: true, corpus: { sessions: 1, projects: 1, turns: 2 } });
  const result = data.search(new URL("http://localhost/api/search?q=nix+flake")) as any;
  expect(result.hits).toHaveLength(1);
  expect(result.hits[0]).toMatchObject({ title: "Nix source visibility", domain: "coding" });
  expect(await data.evidence(result.hits[0].evidenceUri)).toMatchObject({
    title: "Nix source visibility",
    turnIndex: 0,
    turn: { role: "user" },
  });

  const handler = workbenchHandler(data);
  const overviewResponse = await handler(new Request("http://localhost/api/overview"));
  expect(overviewResponse.status).toBe(200);
  expect(await overviewResponse.json()).toMatchObject({ ready: true, corpus: { sessions: 1 } });
  const readOnlyResponse = await handler(new Request("http://localhost/api/overview", { method: "POST" }));
  expect(readOnlyResponse.status).toBe(405);
  expect(await readOnlyResponse.json()).toEqual({ error: "read-only workbench" });
  const staticResponse = await handler(new Request("http://localhost/"));
  expect(staticResponse.status).toBe(200);
  expect(staticResponse.headers.get("Content-Security-Policy")).toContain("frame-ancestors 'none'");
  expect(await staticResponse.text()).toContain("Chatlog Workbench");
  data.close();
});
