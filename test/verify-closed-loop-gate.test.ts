import { expect, test } from "bun:test";
import { mkdtemp, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { sourceBoundKeepGate } from "./context-gate-fixture";
import { MAX_CLOSED_LOOP_ARTIFACT_BYTES } from "../src/closed-loop-gate";

async function runGate(root: string, artifactPath: string) {
  const child = Bun.spawn(
    [process.execPath, "run", "scripts/verify-closed-loop-gate.ts", "--", artifactPath],
    {
      cwd: join(import.meta.dir, ".."),
      env: { ...process.env, CHATLOG_DATA_ROOT: root },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, exitCode };
}

test("gate:verify keeps a valid artifact and bounds its output", async () => {
  const root = await mkdtemp(join(tmpdir(), "chatlog-gate-cli-keep-"));
  const artifactPath = join(root, "gate.json");
  await writeFile(artifactPath, JSON.stringify(await sourceBoundKeepGate(root)));
  const result = await runGate(root, artifactPath);
  expect(result.exitCode).toBe(0);
  expect(result.stderr).toBe("");
  const output = JSON.parse(result.stdout);
  expect(output).toMatchObject({ ok: true, verdict: "keep", sourceEvidence: 9 });
  expect(output.artifact).toBeUndefined();
});
test("gate:verify rejects oversized input before JSON parsing", async () => {
  const root = await mkdtemp(join(tmpdir(), "chatlog-gate-cli-oversized-"));
  const artifactPath = join(root, "oversized.json");
  await writeFile(artifactPath, "x".repeat(MAX_CLOSED_LOOP_ARTIFACT_BYTES + 1));
  const result = await runGate(root, artifactPath);
  expect(result.exitCode).not.toBe(0);
  expect(JSON.parse(result.stderr)).toMatchObject({
    ok: false,
    error: { code: "invalid-gate" },
  });
});
test("gate:verify rejects a symlink instead of reopening a checked path", async () => {
  const root = await mkdtemp(join(tmpdir(), "chatlog-gate-cli-symlink-"));
  const target = join(root, "target.json");
  const artifactPath = join(root, "gate.json");
  await writeFile(target, JSON.stringify(await sourceBoundKeepGate(root)));
  await symlink(target, artifactPath);

  const result = await runGate(root, artifactPath);
  expect(result.exitCode).not.toBe(0);
  expect(JSON.parse(result.stderr)).toMatchObject({
    ok: false,
    error: { code: "invalid-gate" },
  });
});

test("gate:verify rejects a non-keep recommendation and missing evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "chatlog-gate-cli-reject-"));
  const valid = await sourceBoundKeepGate(root);
  const recommendationPath = join(root, "recommendation.json");
  await writeFile(recommendationPath, JSON.stringify({ ...valid, recommendation: "revise" }));
  const recommendation = await runGate(root, recommendationPath);
  expect(recommendation.exitCode).not.toBe(0);
  expect(JSON.parse(recommendation.stderr)).toMatchObject({
    ok: false,
    error: { code: "invalid-gate" },
  });

  const missing = {
    ...valid,
    pairs: valid.pairs.map((pair, index) =>
      index === 0
        ? {
            ...pair,
            control: {
              ...pair.control,
              outcome: { ...pair.control.outcome, batchHash: "f".repeat(64) },
            },
          }
        : pair,
    ),
  };
  const missingPath = join(root, "missing.json");
  await writeFile(missingPath, JSON.stringify(missing));
  const missingResult = await runGate(root, missingPath);
  expect(missingResult.exitCode).not.toBe(0);
  expect(JSON.parse(missingResult.stderr)).toMatchObject({
    ok: false,
    error: { code: "missing-evidence" },
  });
});
