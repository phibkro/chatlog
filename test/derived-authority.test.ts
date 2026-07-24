import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  assertDerivedProjection,
  DerivedProjectionDriftError,
  loadCurrentDerivedArtifact,
} from "../src/derived-authority";
import { deriveCorpus } from "../src/derive";
import { loadRefinery, refineCorpus } from "../src/refinery";
import { indexConversation, openAnalysis } from "../src/analysis";
import { reconcileActiveSources } from "../src/source-authority";
import { WorkbenchData } from "../src/workbench/data";
import { workbenchHandler } from "../src/workbench/server";
import { duckTokenUsage } from "../src/duckdb";
import type { Conversation } from "../src/types";

function fixture(contentHash: string): Conversation {
  return {
    id: "derived-authority",
    provider: "openai",
    harness: "codex",
    project: "/project",
    cwd: "/project",
    model: "model",
    startedAt: "2026-07-24T00:00:00Z",
    endedAt: "2026-07-24T00:01:00Z",
    sourcePath: "/source",
    contentHash,
    turns: [
      { role: "user", content: "The build failed because the Nix source was untracked." },
      { role: "assistant", content: "I decided to track it and rerun the gate." },
    ],
  };
}

test("derived projection and aggregate readers reject stale or modified state", async () => {
  const root = await mkdtemp(join(tmpdir(), "chatlog-derived-authority-"));
  const hash = "a".repeat(64);
  const conversation = fixture(hash);
  await mkdir(join(root, "corpus", "objects", "aa"), { recursive: true });
  await writeFile(
    join(root, "corpus", "objects", "aa", `${hash}.json`),
    JSON.stringify(conversation),
  );
  const inactiveHash = "b".repeat(64);
  await mkdir(join(root, "corpus", "objects", "bb"), { recursive: true });
  await writeFile(
    join(root, "corpus", "objects", "bb", `${inactiveHash}.json`),
    JSON.stringify({
      ...conversation,
      id: "inactive-history",
      sourcePath: "/inactive",
      contentHash: inactiveHash,
    }),
  );
  const manifestPath = join(root, "corpus", "manifest.json");
  await writeFile(manifestPath, JSON.stringify({
    version: 1,
    sources: { [conversation.sourcePath]: { contentHash: hash } },
  }));

  await deriveCorpus(root);
  await refineCorpus(root, 3);
  expect(await assertDerivedProjection(root)).toMatchObject({ conversations: 1 });
  expect((await loadRefinery(root)).inputProjectionHash).toHaveLength(64);
  const db = openAnalysis(join(root, "analysis", "chatlog.sqlite"));
  indexConversation(db, conversation, 0, 0);
  reconcileActiveSources(db, {
    [conversation.sourcePath]: { contentHash: conversation.contentHash },
  });
  db.close();
  const readyData = new WorkbenchData(root);
  const readyInsights = await workbenchHandler(readyData)(
    new Request("http://localhost/api/insights"),
  );
  expect(readyInsights.status).toBe(200);
  expect(await readyInsights.json()).toMatchObject({
    orchestration: null,
    roles: null,
    effectiveness: null,
    refinery: { candidates: [] },
  });
  readyData.close();

  await unlink(join(root, "derived", "refinery-manifest.json"));
  const noAggregatesData = new WorkbenchData(root);
  const noAggregatesResponse = await workbenchHandler(noAggregatesData)(
    new Request("http://localhost/api/insights"),
  );
  expect(noAggregatesResponse.status).toBe(200);
  expect(await noAggregatesResponse.json()).toMatchObject({ refinery: null });
  noAggregatesData.close();
  expect(await refineCorpus(root, 3)).toMatchObject({ processed: true });

  await unlink(join(root, "derived", "objects", "aa", `${hash}.json`));
  await expect(duckTokenUsage(root)).rejects.toThrow("derived object coverage");
  await deriveCorpus(root);

  const derivedManifestPath = join(root, "derived", "manifest.json");
  const derivedManifest = JSON.parse(await readFile(derivedManifestPath, "utf8"));
  derivedManifest.recipeHash = "changed-derive-recipe";
  await writeFile(derivedManifestPath, JSON.stringify(derivedManifest));
  await expect(loadRefinery(root)).rejects.toThrow("active derived projection");
  expect(await refineCorpus(root, 3)).toMatchObject({ processed: true });

  await writeFile(manifestPath, JSON.stringify({ version: 1, sources: {} }));
  await expect(assertDerivedProjection(root)).rejects.toBeInstanceOf(DerivedProjectionDriftError);
  await expect(loadRefinery(root)).rejects.toThrow("derived projection");
  await expect(duckTokenUsage(root)).rejects.toThrow("derived projection");
  const driftDb = openAnalysis(join(root, "analysis", "chatlog.sqlite"));
  reconcileActiveSources(driftDb, {});
  driftDb.close();
  const data = new WorkbenchData(root);
  const response = await workbenchHandler(data)(
    new Request("http://localhost/api/insights"),
  );
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({
    error: "derived projection is unavailable or stale; run `chatlog derive` and `chatlog refine`",
  });
  data.close();

  await deriveCorpus(root);
  await refineCorpus(root, 3);
  const refineryManifest = JSON.parse(
    await readFile(join(root, "derived", "refinery-manifest.json"), "utf8"),
  );
  const artifactPath = join(root, "derived", refineryManifest.current.artifactPath);
  await unlink(artifactPath);
  await expect(
    loadCurrentDerivedArtifact(root, "refinery-manifest.json", { optional: true }),
  ).rejects.toThrow("current artifact is unavailable");

  await refineCorpus(root, 3);
  const restoredManifestText = await readFile(
    join(root, "derived", "refinery-manifest.json"),
    "utf8",
  );
  const restoredManifest = JSON.parse(restoredManifestText);
  restoredManifest.current.artifactPath = "../corpus/manifest.json";
  await writeFile(
    join(root, "derived", "refinery-manifest.json"),
    JSON.stringify(restoredManifest),
  );
  await expect(
    loadCurrentDerivedArtifact(root, "refinery-manifest.json"),
  ).rejects.toThrow("invalid artifact path");
  await writeFile(join(root, "derived", "refinery-manifest.json"), restoredManifestText);

  await writeFile(artifactPath, `${await readFile(artifactPath, "utf8")} `);
  await expect(
    loadCurrentDerivedArtifact(root, "refinery-manifest.json"),
  ).rejects.toThrow("integrity validation");
  expect(await refineCorpus(root, 3)).toMatchObject({ processed: true });
  expect((await loadRefinery(root)).inputProjectionHash).toHaveLength(64);
});
