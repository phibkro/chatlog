export const DEFAULT_CONVERSATION_DOMAIN = "coding";

const DOMAIN_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export function normalizeConversationDomain(value: unknown): string {
  if (typeof value !== "string") throw new Error("conversation domain must be a string");
  const domain = value.trim().toLowerCase();
  if (!DOMAIN_PATTERN.test(domain)) throw new Error(`invalid conversation domain: ${value}`);
  return domain;
}

export function normalizeConversationDomains(
  values: string[],
  fallback = DEFAULT_CONVERSATION_DOMAIN,
): string[] {
  const domains = [...new Set(values
    .map((value) => value.trim())
    .filter(Boolean)
    .map(normalizeConversationDomain))]
    .sort();
  if (!domains.length) return [normalizeConversationDomain(fallback)];
  return domains;
}
