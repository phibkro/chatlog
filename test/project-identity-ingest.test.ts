import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdir, mkdtemp, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ingest } from "../src/ingest";
import { PROJECT_IDENTITY_RECIPE, projectOf } from "../src/project-identity";
import type { AdaptResult, SourceAdapter, SourceFile } from "../src/types";

class FixtureAdapter implements SourceAdapter {
  readonly harness = "fixture";
  adaptations = 0;
  canonicalIdentity = false;

  constructor(
    private readonly sourcePath: string,
    private readonly recordedCwd: string,
  ) {}

  async discover(): Promise<SourceFile[]> {
    const source = await stat(this.sourcePath);
    return [{ path: this.sourcePath, size: source.size, mtimeMs: source.mtimeMs }];
  }

  async adapt(source: SourceFile): Promise<AdaptResult> {
    this.adaptations++;
    return {
      partialTail: false,
      conversation: {
        id: "fixture-session",
        provider: "fixture",
        harness: this.harness,
        project: this.canonicalIdentity ? projectOf(this.recordedCwd) : this.recordedCwd,
        cwd: this.recordedCwd,
        model: "fixture",
        startedAt: "2026-07-27T12:00:00.000Z",
        endedAt: "2026-07-27T12:01:00.000Z",
        turns: [
          { role: "user", content: "Check the repository identity recipe." },
          { role: "assistant", content: "The fixture completed successfully." },
        ],
        sourcePath: source.path,
      },
    };
  }
}

test("project identity recipe changes invalidate unchanged-source ingestion skips", async () => {
  const root = await mkdtemp(join(tmpdir(), "chatlog-project-recipe-"));
  const sourcePath = join(root, "source.jsonl");
  const main = join(root, "project");
  const linked = join(root, "linked-worktree");
  const commonGitDir = join(main, ".git");
  const linkedGitDir = join(commonGitDir, "worktrees", "linked-worktree");
  await mkdir(linked, { recursive: true });
  await mkdir(linkedGitDir, { recursive: true });
  await writeFile(join(linked, ".git"), `gitdir: ${linkedGitDir}\n`);
  await writeFile(join(linkedGitDir, "commondir"), "../..\n");
  await writeFile(sourcePath, '{"fixture":true}\n');
  const adapter = new FixtureAdapter(sourcePath, linked);

  const first = await ingest([adapter], root);
  expect(first.ingested.fixture).toBe(1);
  expect(adapter.adaptations).toBe(1);

  const manifestPath = join(root, "corpus", "manifest.json");
  const currentManifest = JSON.parse(await readFile(manifestPath, "utf8"));
  expect(currentManifest.projectIdentityRecipe).toBe(PROJECT_IDENTITY_RECIPE);
  const legacyHash = currentManifest.sources[sourcePath].contentHash;

  delete currentManifest.projectIdentityRecipe;
  await writeFile(manifestPath, `${JSON.stringify(currentManifest, null, 2)}\n`);
  adapter.canonicalIdentity = true;

  const second = await ingest([adapter], root);
  expect(second.ingested.fixture).toBe(1);
  expect(second.skipped.fixture).toBe(0);
  expect(adapter.adaptations).toBe(2);

  const refreshedManifest = JSON.parse(await readFile(manifestPath, "utf8"));
  expect(refreshedManifest.projectIdentityRecipe).toBe(PROJECT_IDENTITY_RECIPE);
  expect(refreshedManifest.sources[sourcePath].contentHash).not.toBe(legacyHash);

  const db = new Database(join(root, "analysis", "chatlog.sqlite"), {
    readonly: true,
    create: false,
  });
  expect(
    db.query("SELECT project FROM current_conversations WHERE source_path = ?").get(sourcePath),
  ).toEqual({ project: await realpath(main) });
  db.close();
});
