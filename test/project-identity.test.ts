import { expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { join, normalize } from "node:path";
import { tmpdir } from "node:os";
import { PROJECT_IDENTITY_RECIPE, projectOf } from "../src/project-identity";

async function gitFixture(): Promise<{
  main: string;
  nested: string;
  linked: string;
  linkedNested: string;
}> {
  const base = await mkdtemp(join(tmpdir(), "chatlog-project-identity-"));
  const main = join(base, "project");
  const commonGitDir = join(main, ".git");
  const linked = join(base, "linked-worktree");
  const linkedGitDir = join(commonGitDir, "worktrees", "linked-worktree");
  const nested = join(main, "src", "nested");
  const linkedNested = join(linked, "packages", "app");

  await mkdir(nested, { recursive: true });
  await mkdir(linkedNested, { recursive: true });
  await mkdir(linkedGitDir, { recursive: true });
  await writeFile(join(linked, ".git"), `gitdir: ${linkedGitDir}\n`);
  await writeFile(join(linkedGitDir, "commondir"), "../..\n");

  return { main, nested, linked, linkedNested };
}

test("exports a stable, versioned project identity recipe", () => {
  expect(PROJECT_IDENTITY_RECIPE).toBe("git-common-dir-v1");
});

test("groups a checkout, nested path, and linked worktree under the main checkout", async () => {
  const { main, nested, linked, linkedNested } = await gitFixture();
  const canonicalMain = await realpath(main);

  expect(projectOf(main)).toBe(canonicalMain);
  expect(projectOf(nested)).toBe(canonicalMain);
  expect(projectOf(linked)).toBe(canonicalMain);
  expect(projectOf(linkedNested)).toBe(canonicalMain);
});

test("resolves relative gitdir metadata through the common Git directory", async () => {
  const { main, linked } = await gitFixture();
  const relative = join(linked, "..", "relative-worktree");
  const linkedGitDir = join(main, ".git", "worktrees", "relative-worktree");
  await mkdir(relative, { recursive: true });
  await mkdir(linkedGitDir, { recursive: true });
  await writeFile(join(relative, ".git"), "gitdir: ../project/.git/worktrees/relative-worktree\n");
  await writeFile(join(linkedGitDir, "commondir"), "../..\n");

  expect(projectOf(relative)).toBe(await realpath(main));
});

test("retains normalized paths for non-Git, missing, and malformed metadata", async () => {
  const base = await mkdtemp(join(tmpdir(), "chatlog-project-fallback-"));
  const malformed = join(base, "malformed");
  const missing = join(base, "missing", "..", "deleted");
  await mkdir(malformed, { recursive: true });
  await writeFile(join(malformed, ".git"), "not a gitdir\n");

  expect(projectOf("/")).toBe(normalize("/"));
  expect(projectOf(missing)).toBe(normalize(missing));
  expect(projectOf(malformed)).toBe(normalize(malformed));
  expect(projectOf("")).toBe("(unknown)");
});

test("does not group a worktree with malformed common-directory metadata", async () => {
  const { main, linked } = await gitFixture();
  await writeFile(join(main, ".git", "worktrees", "linked-worktree", "commondir"), "\n");

  expect(projectOf(linked)).toBe(normalize(linked));
});

test("canonicalizes a checkout reached through a symlink", async () => {
  const { main, nested } = await gitFixture();
  const alias = join(main, "..", "project-alias");
  await symlink(main, alias, "dir");

  expect(projectOf(join(alias, "src", "nested"))).toBe(await realpath(main));
  expect(projectOf(nested)).toBe(await realpath(main));
});

test("returns a stable result for a repeated recorded working directory", async () => {
  const { main, linkedNested } = await gitFixture();
  const first = projectOf(linkedNested);

  expect(projectOf(linkedNested)).toBe(first);
  expect(first).toBe(await realpath(main));
});

test("invalidates a cached project when its recorded working directory is deleted", async () => {
  const { main, linked } = await gitFixture();
  expect(projectOf(linked)).toBe(await realpath(main));

  await rm(linked, { recursive: true });

  expect(projectOf(linked)).toBe(normalize(linked));
});
