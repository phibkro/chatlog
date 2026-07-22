const RULES: Array<[RegExp, string]> = [
  [/-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/gi, "[REDACTED_PRIVATE_KEY]"],
  [/\bsk-(?:ant-)?[A-Za-z0-9_-]{16,}\b/g, "[REDACTED_API_KEY]"],
  [/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g, "[REDACTED_GITHUB_TOKEN]"],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, "[REDACTED_GITHUB_TOKEN]"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "[REDACTED_AWS_ACCESS_KEY]"],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, "[REDACTED_SLACK_TOKEN]"],
  [/(\b(?:authorization)\s*[:=]\s*bearer\s+)[A-Za-z0-9._~+\/-]{12,}/gi, "$1[REDACTED_TOKEN]"],
  [/(\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|secret[_-]?key|password)\b\s*["']?\s*[:=]\s*["']?)[^\s,"'}]{8,}/gi, "$1[REDACTED_SECRET]"],
];

// Bump when redaction semantics change. Ingest persists this value so existing
// source files are re-adapted even when their size and mtime are unchanged.
export const REDACTION_RECIPE = "canonical-conversation-v2";

export function redact(text: string): string {
  return RULES.reduce((value, [pattern, replacement]) => value.replace(pattern, replacement), text);
}
