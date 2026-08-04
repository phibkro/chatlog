export const EVIDENCE_URI_PATTERN =
  "^(?:chatlog://conversation/([a-fA-F0-9]{64})/turn/([0-9]+)|chatlog://event/([a-fA-F0-9]{64})/([a-fA-F0-9]{64}))$";

const evidenceUriRegex = new RegExp(EVIDENCE_URI_PATTERN);

export class EvidenceUriError extends Error {
  override readonly name = "EvidenceUriError";
}

function invalidEvidenceUri(message: string): never {
  throw new EvidenceUriError(message);
}

export interface ConversationEvidencePointer {
  uri: string;
  contentHash: string;
  turnIndex: number;
}

export interface EventEvidencePointer {
  uri: string;
  contentHash: string;
  batchHash: string;
  eventId: string;
  turnIndex?: undefined;
}

export type EvidencePointer = ConversationEvidencePointer | EventEvidencePointer;

export function eventEvidenceUri(batchHash: string, eventId: string): string {
  if (!/^[a-f0-9]{64}$/i.test(batchHash) || !/^[a-f0-9]{64}$/i.test(eventId))
    invalidEvidenceUri("event evidence pointers require SHA-256 hashes");
  return `chatlog://event/${batchHash.toLowerCase()}/${eventId.toLowerCase()}`;
}

export function parseEvidenceUri(value: unknown): EvidencePointer {
  if (typeof value !== "string") invalidEvidenceUri("uri must be a chatlog evidence URI");
  const match = evidenceUriRegex.exec(value);
  if (!match) invalidEvidenceUri("invalid chatlog evidence URI");
  if (match[1] && match[2]) {
    const contentHash = match[1].toLowerCase();
    const turnIndex = Number(match[2]);
    if (!Number.isSafeInteger(turnIndex)) invalidEvidenceUri("invalid chatlog turn index");
    return {
      uri: `chatlog://conversation/${contentHash}/turn/${turnIndex}`,
      contentHash,
      turnIndex,
    };
  }
  const batchHash = match[3]!.toLowerCase();
  const eventId = match[4]!.toLowerCase();
  return {
    uri: eventEvidenceUri(batchHash, eventId),
    contentHash: batchHash,
    batchHash,
    eventId,
  };
}
