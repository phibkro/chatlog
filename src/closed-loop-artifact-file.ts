import { MAX_CLOSED_LOOP_ARTIFACT_BYTES } from "./closed-loop-gate";
import { readBoundedFile } from "./importers/export-limits";

export type ClosedLoopArtifactFileResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly error: string };

function invalid(error: unknown): ClosedLoopArtifactFileResult {
  return { ok: false, error: error instanceof Error ? error.message : String(error) };
}

export async function readClosedLoopArtifactFile(
  path: string,
): Promise<ClosedLoopArtifactFileResult> {
  try {
    const content = await readBoundedFile(
      path,
      MAX_CLOSED_LOOP_ARTIFACT_BYTES,
      "closed-loop artifact",
    );
    if (!content.ok) return invalid(content.error);
    return { ok: true, value: JSON.parse(content.value.text) };
  } catch (error) {
    return invalid(error);
  }
}
