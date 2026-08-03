#!/usr/bin/env bun
import { chmod } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
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

const results = await Promise.all(
  builds.map(({ entrypoint, outfile }) =>
    Bun.build({
      entrypoints: [entrypoint],
      outdir: dirname(outfile),
      naming: basename(outfile),
      target: "bun",
      minify: false,
      sourcemap: "none",
    }),
  ),
);

let failed = false;
for (const [index, result] of results.entries()) {
  if (result.success) {
    await chmod(builds[index]!.outfile, 0o755);
    continue;
  }
  failed = true;
  for (const log of result.logs) console.error(log);
}
if (failed) process.exitCode = 1;
