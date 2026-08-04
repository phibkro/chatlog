#!/usr/bin/env bun
import { chmod, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const checkOnly = process.argv.includes("--check");
const temporaryOutdir = checkOnly
  ? await mkdtemp(join(tmpdir(), "chatlog-memory-plugin-"))
  : undefined;
const builds = [
  {
    entrypoint: resolve(root, "src", "experience-memory-hook.ts"),
    outfile: resolve(root, "plugins", "chatlog-memory", "scripts", "session-start.js"),
  },
  {
    entrypoint: resolve(root, "src", "experience-memory-mcp.ts"),
    outfile: resolve(root, "plugins", "chatlog-memory", "scripts", "chatlog-mcp.js"),
  },
];

try {
  const results = await Promise.all(
    builds.map(({ entrypoint, outfile }) => {
      const generated = checkOnly ? resolve(temporaryOutdir!, basename(outfile)) : outfile;
      return Bun.build({
        entrypoints: [entrypoint],
        outdir: dirname(generated),
        naming: basename(generated),
        target: "bun",
        minify: false,
        sourcemap: "none",
      });
    }),
  );

  let failed = false;
  for (const [index, result] of results.entries()) {
    const build = builds[index]!;
    const generated = checkOnly
      ? resolve(temporaryOutdir!, basename(build.outfile))
      : build.outfile;
    if (!result.success) {
      failed = true;
      for (const log of result.logs) console.error(log);
      continue;
    }

    if (checkOnly) {
      let expected: Buffer;
      try {
        expected = await readFile(build.outfile);
      } catch {
        console.error(`Missing tracked plugin bundle: ${build.outfile}`);
        failed = true;
        continue;
      }
      const actual = await readFile(generated);
      if (!expected.equals(actual)) {
        console.error(
          `Stale plugin bundle: ${build.outfile}. Run bun run memory:plugin:build to refresh it.`,
        );
        failed = true;
      }
      continue;
    }

    await chmod(generated, 0o755);
  }
  process.exitCode = failed ? 1 : 0;
} finally {
  if (temporaryOutdir) await rm(temporaryOutdir, { recursive: true, force: true });
}
