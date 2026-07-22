import { expect, test } from "bun:test";
import { redact } from "../src/redact";
import { canonicalizeConversation } from "../src/ingest";

test("redacts common pasted credentials", () => {
  const input = "api_key=abcdefghijklmnop sk-ant-abcdefghijklmnop github_pat_abcdefghijklmnopqrstuv";
  const output = redact(input);
  expect(output).not.toContain("abcdefghijklmnop");
  expect(output.match(/REDACTED/g)?.length).toBe(3);
});

test("does not redact ordinary prose", () => {
  expect(redact("the secret is conceptual and the password policy is long"))
    .toBe("the secret is conceptual and the password policy is long");
});

test("canonical boundary redacts secrets in nested fields before hashing", () => {
  const secret = "sk-ant-abcdefghijklmnopqrstuvwxyz";
  const conversation = canonicalizeConversation({
    id: "id", provider: "anthropic", harness: "claude-code", project: "/p", cwd: "/p",
    model: "model", startedAt: "2026-01-01T00:00:00Z", endedAt: "2026-01-01T00:00:00Z",
    sourcePath: "/source", turns: [{ role: "assistant", content: `password=\"${secret}\"`, toolCalls: [{ name: "x", output: secret }] }],
  });
  expect(JSON.stringify(conversation)).not.toContain(secret);
  expect(conversation.turns[0].toolCalls?.[0].output).toBe("[REDACTED_API_KEY]");
  expect(conversation.turns[0].content).toContain("[REDACTED_SECRET]");
});
