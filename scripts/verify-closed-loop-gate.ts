#!/usr/bin/env bun
import { readClosedLoopArtifactFile } from "../src/closed-loop-artifact-file";
import { verifyClosedLoopGate } from "../src/closed-loop-gate";
import { resolveContextReleaseEvidence } from "../src/context-release";
import { resolveDataRoot } from "../src/data-root";
function failure(code: "invalid-gate" | "missing-evidence", message: string): never {
  throw new Error(JSON.stringify({ code, message }));
}

async function readArtifact(path: string): Promise<unknown> {
  const decoded = await readClosedLoopArtifactFile(path);
  if (!decoded.ok)
    failure("invalid-gate", `could not decode closed-loop artifact: ${decoded.error}`);
  return decoded.value;
}

async function main(): Promise<void> {
  const artifactPath = Bun.argv.slice(2).filter((argument) => argument !== "--")[0];
  if (!artifactPath) {
    console.error(
      JSON.stringify({
        ok: false,
        error: { code: "invalid-gate", message: "usage: gate:verify -- <artifact>" },
      }),
    );
    process.exitCode = 1;
    return;
  }

  try {
    const artifact = await readArtifact(artifactPath);
    const verified = await verifyClosedLoopGate(artifact, (pointer) =>
      resolveContextReleaseEvidence(resolveDataRoot(), pointer),
    );
    if (!verified.ok) {
      console.error(JSON.stringify({ ok: false, error: verified.error }));
      process.exitCode = 1;
      return;
    }
    if (verified.value.verdict !== "keep") {
      console.error(
        JSON.stringify({
          ok: false,
          error: {
            code: "invalid-gate",
            message: `closed-loop gate verdict is ${verified.value.verdict}; only keep evidence can authorize release`,
          },
          verdict: verified.value.verdict,
          evaluationId: verified.value.artifact.evaluationId,
        }),
      );
      process.exitCode = 1;
      return;
    }
    console.log(
      JSON.stringify({
        ok: true,
        verdict: verified.value.verdict,
        evaluationId: verified.value.artifact.evaluationId,
        stage: verified.value.artifact.stage,
        sourceEvidence: verified.value.sourceEvidence,
        metrics: verified.value.metrics,
      }),
    );
  } catch (error) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(error instanceof Error ? error.message : String(error));
    } catch {
      parsed = {
        code: "invalid-gate",
        message: error instanceof Error ? error.message : String(error),
      };
    }
    console.error(JSON.stringify({ ok: false, error: parsed }));
    process.exitCode = 1;
  }
}

await main();
