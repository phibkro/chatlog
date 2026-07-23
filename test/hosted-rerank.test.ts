import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rerankHosted, resolveRerankConfig, type RerankConfig } from "../src/hosted-rerank";

test("hosted rerank requires explicit egress authorization and environment credentials", async () => {
  const keys = [
    "CHATLOG_ALLOW_EGRESS",
    "CHATLOG_RERANK_PROVIDER",
    "CHATLOG_RERANK_MODEL",
    "OPENROUTER_API_KEY",
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
  ] as const;
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  try {
    for (const key of keys) delete process.env[key];
    process.env.OPENROUTER_API_KEY = "test-key";
    await expect(resolveRerankConfig()).rejects.toThrow("CHATLOG_ALLOW_EGRESS=1");

    process.env.CHATLOG_ALLOW_EGRESS = "1";
    const config = await resolveRerankConfig();
    expect(config).toMatchObject({
      provider: "openrouter",
      model: "openai/gpt-4.1-mini",
      credentialSource: "environment",
    });
    expect(config.model).not.toContain(":free");
  } finally {
    for (const key of keys) {
      const value = previous[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("hosted rerank redacts and bounds egress, then serves a content-addressed cache hit", async () => {
  const root = await mkdtemp(join(tmpdir(), "chatlog-rerank-"));
  const config: RerankConfig = { provider: "openrouter", model: "test-model", apiKey: "not-sent-in-body", endpoint: "https://example.invalid", credentialSource: "test" };
  let calls = 0; let sent = "";
  const mockFetch = (async (_url: any, init: any) => {
    calls++; sent = String(init.body);
    return new Response(JSON.stringify({ model: "resolved-model", choices: [{ message: { content: JSON.stringify({ rankings: [
      { id: "c1", score: 91, reason: "same underlying failure" }, { id: "c0", score: 12, reason: "word overlap only" },
    ] }) } }] }), { status: 200 });
  }) as typeof fetch;
  const secret = "sk-ant-abcdefghijklmnopqrstuvwxyz";
  const candidates = [{ id: "c0", text: `irrelevant ${secret}` }, { id: "c1", text: "Nix ignored a file absent from the git index" }];
  const first = await rerankHosted(root, "why was my flake input invisible?", candidates, config, mockFetch);
  expect(first.rankings[0].id).toBe("c1");
  expect(first.egress.performed).toBe(true);
  expect(sent).not.toContain(secret);
  expect(sent).toContain("[REDACTED_API_KEY]");
  expect(sent).not.toContain("conversationHash");
  const second = await rerankHosted(root, "why was my flake input invisible?", candidates, config, mockFetch);
  expect(second.cached).toBe(true);
  expect(second.egress.performed).toBe(false);
  expect(calls).toBe(1);
});

test("hosted rerank supports the Anthropic messages shape", async () => {
  const root = await mkdtemp(join(tmpdir(), "chatlog-rerank-anthropic-"));
  const config: RerankConfig = { provider: "anthropic", model: "claude-test", apiKey: "secret", endpoint: "https://example.invalid", credentialSource: "test" };
  let sent: any;
  const mockFetch = (async (_url: any, init: any) => {
    sent = { headers: init.headers, body: JSON.parse(init.body) };
    return new Response(JSON.stringify({ model: "claude-test", content: [{ type: "text", text: '{"rankings":[{"id":"c0","score":88,"reason":"equivalent"}]}' }] }), { status: 200 });
  }) as typeof fetch;
  const result = await rerankHosted(root, "same issue", [{ id: "c0", text: "same underlying problem" }], config, mockFetch);
  expect(sent.headers["x-api-key"]).toBe("secret");
  expect(sent.body.messages[0].content).toContain("same underlying problem");
  expect(result.rankings[0].score).toBe(88);
});
