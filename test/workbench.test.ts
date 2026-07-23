import { expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { indexConversation, openAnalysis } from "../src/analysis";
import { WorkbenchData } from "../src/workbench/data";
import { resolveBindConfig, workbenchHandler } from "../src/workbench/server";
import { writeImportReceipt } from "../src/import-receipts";
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
  const staleHash = "b".repeat(64);
  const superseded = {
    ...conversation,
    contentHash: staleHash,
    turns: [{ role: "user", content: "An older version of this source." }],
  };
  const db = openAnalysis(join(root, "analysis", "chatlog.sqlite"));
  indexConversation(db, superseded, 0, 1);
  indexConversation(db, conversation, 1, 1);
  db.close();
  await mkdir(join(root, "corpus", "objects", "aa"), { recursive: true });
  await writeFile(join(root, "corpus", "objects", "aa", `${conversation.contentHash}.json`), JSON.stringify(conversation));
  await mkdir(join(root, "corpus", "objects", "bb"), { recursive: true });
  await writeFile(
    join(root, "corpus", "objects", "bb", `${staleHash}.json`),
    JSON.stringify(superseded),
  );
  const receiptInput = {
    source: {
      path: "/private/anthropic.zip",
      contentHash: "c".repeat(64),
      bytes: 100,
      modifiedAt: "2026-01-01T10:00:00.000Z",
    },
    domain: "personal",
    counts: {
      discovered: 1,
      imported: 1,
      skipped: 0,
      turns: 2,
      attachments: 0,
      files: 0,
    },
    manifest: {
      beforeHash: "d".repeat(64),
      afterHash: "e".repeat(64),
      beforeSources: 0,
      afterSources: 1,
      added: 1,
      replaced: 0,
      unchanged: 0,
    },
    deriveEnabled: false,
    operationId: "workbench-test",
    completedAt: "2026-01-01T10:02:00.000Z",
  } as const;
  await writeImportReceipt(root, receiptInput);
  await writeImportReceipt(root, {
    ...receiptInput,
    operationId: "workbench-test-2",
    completedAt: "2026-01-01T10:03:00.000Z",
  });

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
  await expect(data.evidence(`chatlog://conversation/${staleHash}/turn/0`))
    .rejects.toThrow("Evidence not found");

  const handler = workbenchHandler(data);
  const overviewResponse = await handler(new Request("http://localhost/api/overview"));
  expect(overviewResponse.status).toBe(200);
  expect(await overviewResponse.json()).toMatchObject({ ready: true, corpus: { sessions: 1 } });
  const receiptsResponse = await handler(new Request("http://localhost/api/receipts?limit=1"));
  expect(receiptsResponse.status).toBe(200);
  expect(await receiptsResponse.json()).toMatchObject([{
    schema: "chatlog/import-receipt-v1",
    connector: "anthropic-export",
    policy: { domain: "personal" },
    counts: { imported: 1 },
  }]);
  expect(await data.receipts(null)).toHaveLength(2);
  const readOnlyResponse = await handler(new Request("http://localhost/api/overview", { method: "POST" }));
  expect(readOnlyResponse.status).toBe(405);
  expect(await readOnlyResponse.json()).toEqual({ error: "read-only workbench" });
  const staticResponse = await handler(new Request("http://localhost/"));
  expect(staticResponse.status).toBe(200);
  expect(staticResponse.headers.get("Content-Security-Policy")).toContain("frame-ancestors 'none'");
  expect(await staticResponse.text()).toContain("Chatlog Workbench");
  data.close();
});

test("Workbench bind policy defaults to loopback and requires an explicit remote override", () => {
  expect(resolveBindConfig({})).toEqual({ host: "127.0.0.1", port: 4789 });
  expect(resolveBindConfig({ CHATLOG_HOST: "::1", CHATLOG_PORT: "4790" }))
    .toEqual({ host: "::1", port: 4790 });
  expect(() => resolveBindConfig({ CHATLOG_HOST: "100.64.0.7" }))
    .toThrow("Refusing non-loopback bind");
  expect(resolveBindConfig({
    CHATLOG_HOST: "100.64.0.7",
    CHATLOG_ALLOW_REMOTE: "1",
  })).toEqual({ host: "100.64.0.7", port: 4789 });
});
