export const EVIDENCE_URI_PATTERN =
  "^chatlog://conversation/([a-fA-F0-9]{64})/turn/([0-9]+)$";

const evidenceUriRegex = new RegExp(EVIDENCE_URI_PATTERN);

export interface EvidencePointer {
  uri: string;
  contentHash: string;
  turnIndex: number;
}

export function parseEvidenceUri(value: unknown): EvidencePointer {
  if (typeof value !== "string") throw new Error("uri must be a chatlog evidence URI");
  const match = evidenceUriRegex.exec(value);
  if (!match) throw new Error("invalid chatlog evidence URI");
  const contentHash = match[1]!.toLowerCase();
  const turnIndex = Number(match[2]);
  return {
    uri: `chatlog://conversation/${contentHash}/turn/${turnIndex}`,
    contentHash,
    turnIndex,
  };
}
