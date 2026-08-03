import { normalizeConversationDomain } from "./domain";
export class GenericEventSchemaError extends Error {
  readonly code = "generic-event-schema-invalid";
}

function failClosed(message: string, cause?: unknown): never {
  throw new GenericEventSchemaError(message, cause === undefined ? undefined : { cause });
}

export const GENERIC_EVENT_SCHEMA = "chatlog/generic-events-v1" as const;
export const GENERIC_EVENT_SCHEMA_VERSION = 1 as const;
export const GENERIC_EVENT_MAX_LINE_BYTES = 256 * 1024;
export const GENERIC_EVENT_MAX_BATCH_EVENTS = 256;
export const GENERIC_EVENT_MAX_BATCH_BYTES = 2 * 1024 * 1024;
export const GENERIC_EVENT_MAX_FILE_BYTES = 64 * 1024 * 1024;
export const GENERIC_EVENT_MAX_PRODUCER_NAME = 128;
export const GENERIC_EVENT_MAX_PRODUCER_VERSION = 64;
export const GENERIC_EVENT_MAX_RECIPE = 256;

export interface GenericEventHeader {
  schema: typeof GENERIC_EVENT_SCHEMA;
  schemaVersion: typeof GENERIC_EVENT_SCHEMA_VERSION;
  type: "header";
  producer: {
    name: string;
    version: string;
  };
  provider: string;
  harness: string;
  sourceKind: string;
  domain: string;
  capturePolicyVersion: string;
  ordering: {
    key: "sequence";
    contiguous: boolean;
    relations: "prior-only";
  };
  identity: {
    key: "eventId";
    algorithm: "sha256";
  };
  adapterRecipe?: string;
}

export const GENERIC_EVENT_JSON_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: GENERIC_EVENT_SCHEMA,
  title: "Chatlog generic observed event stream",
  type: "object",
  required: [
    "schema",
    "schemaVersion",
    "type",
    "producer",
    "provider",
    "harness",
    "sourceKind",
    "domain",
    "capturePolicyVersion",
    "ordering",
    "identity",
  ],
  properties: {
    schema: { const: GENERIC_EVENT_SCHEMA },
    schemaVersion: { const: GENERIC_EVENT_SCHEMA_VERSION },
    type: { const: "header" },
    producer: {
      type: "object",
      required: ["name", "version"],
      additionalProperties: false,
      properties: {
        name: { type: "string", minLength: 1, maxLength: GENERIC_EVENT_MAX_PRODUCER_NAME },
        version: { type: "string", minLength: 1, maxLength: GENERIC_EVENT_MAX_PRODUCER_VERSION },
      },
    },
    provider: { type: "string", minLength: 1, maxLength: 128 },
    harness: { type: "string", minLength: 1, maxLength: 128 },
    sourceKind: { type: "string", minLength: 1, maxLength: 128 },
    domain: { type: "string", pattern: "^[a-z0-9][a-z0-9_-]{0,63}$" },
    capturePolicyVersion: { type: "string", minLength: 1, maxLength: 256 },
    ordering: {
      type: "object",
      required: ["key", "contiguous", "relations"],
      additionalProperties: false,
      properties: {
        key: { const: "sequence" },
        contiguous: { const: true },
        relations: { const: "prior-only" },
      },
    },
    identity: {
      type: "object",
      required: ["key", "algorithm"],
      additionalProperties: false,
      properties: {
        key: { const: "eventId" },
        algorithm: { const: "sha256" },
      },
    },
    adapterRecipe: { type: "string", minLength: 1, maxLength: GENERIC_EVENT_MAX_RECIPE },
  },
  additionalProperties: false,
} as const;

function bounded(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum)
    failClosed(`${label} must be bounded non-empty text`);
  return value;
}

function producer(value: unknown): GenericEventHeader["producer"] {
  if (!value || typeof value !== "object" || Array.isArray(value))
    failClosed("generic event header producer must be an object");
  const record = value as Record<string, unknown>;
  return {
    name: bounded(record.name, "producer.name", GENERIC_EVENT_MAX_PRODUCER_NAME),
    version: bounded(record.version, "producer.version", GENERIC_EVENT_MAX_PRODUCER_VERSION),
  };
}

export function validateGenericEventHeader(value: unknown): GenericEventHeader {
  if (!value || typeof value !== "object" || Array.isArray(value))
    failClosed("generic event header must be an object");
  const record = value as Record<string, unknown>;
  if (record.schema !== GENERIC_EVENT_SCHEMA) failClosed("unsupported generic event schema");
  if (record.schemaVersion !== GENERIC_EVENT_SCHEMA_VERSION)
    failClosed("unsupported generic event schema version");
  if (record.type !== "header") failClosed("generic event header type must be header");
  const ordering = record.ordering;
  if (!ordering || typeof ordering !== "object" || Array.isArray(ordering))
    failClosed("generic event header ordering must be an object");
  const orderingRecord = ordering as Record<string, unknown>;
  if (
    orderingRecord.key !== "sequence" ||
    orderingRecord.contiguous !== true ||
    orderingRecord.relations !== "prior-only"
  )
    failClosed("generic event ordering must require contiguous prior-only sequence");
  const identity = record.identity;
  if (!identity || typeof identity !== "object" || Array.isArray(identity))
    failClosed("generic event header identity must be an object");
  const identityRecord = identity as Record<string, unknown>;
  if (identityRecord.key !== "eventId" || identityRecord.algorithm !== "sha256")
    failClosed("generic event identity must be SHA-256 eventId");
  const domain = normalizeConversationDomain(record.domain);
  const header: GenericEventHeader = {
    schema: GENERIC_EVENT_SCHEMA,
    schemaVersion: GENERIC_EVENT_SCHEMA_VERSION,
    type: "header",
    producer: producer(record.producer),
    provider: bounded(record.provider, "provider", 128),
    harness: bounded(record.harness, "harness", 128),
    sourceKind: bounded(record.sourceKind, "sourceKind", 128),
    domain,
    capturePolicyVersion: bounded(record.capturePolicyVersion, "capturePolicyVersion", 256),
    ordering: { key: "sequence", contiguous: true, relations: "prior-only" },
    identity: { key: "eventId", algorithm: "sha256" },
    ...(record.adapterRecipe !== undefined
      ? { adapterRecipe: bounded(record.adapterRecipe, "adapterRecipe", GENERIC_EVENT_MAX_RECIPE) }
      : {}),
  };
  return header;
}
