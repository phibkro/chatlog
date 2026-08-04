import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rerank, rerankHosted, resolveRerankConfig, type RerankConfig } from "../src/hosted-rerank";

async function withEnv<T>(
  overrides: Record<string, string | undefined>,
  run: () => Promise<T> | T,
): Promise<T> {
  const prior = Object.fromEntries(Object.keys(overrides).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await run();
  } finally {
    for (const [key, value] of Object.entries(prior)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("hosted rerank requires explicit egress authorization and environment credentials", async () => {
  await withEnv(
    {
      CHATLOG_ALLOW_EGRESS: undefined,
      CHATLOG_RERANK_PROVIDER: "openrouter",
      CHATLOG_RERANK_MODEL: undefined,
      OPENROUTER_API_KEY: "test-key",
      OPENAI_API_KEY: undefined,
      ANTHROPIC_API_KEY: undefined,
    },
    async () => {
      await expect(resolveRerankConfig()).rejects.toThrow("CHATLOG_ALLOW_EGRESS=1");

      process.env.CHATLOG_ALLOW_EGRESS = "1";
      const config = await resolveRerankConfig();
      expect(config).toMatchObject({
        provider: "openrouter",
        model: "openai/gpt-4.1-mini",
        credentialSource: "environment",
      });
      expect(config.model).not.toContain(":free");
    },
  );
});

test("hosted rerank redacts and bounds egress, then serves a content-addressed cache hit", async () => {
  const root = await mkdtemp(join(tmpdir(), "chatlog-rerank-"));
  const config: RerankConfig = {
    provider: "openrouter",
    model: "test-model",
    apiKey: "not-sent-in-body",
    endpoint: "https://example.invalid",
    credentialSource: "test",
  };
  let calls = 0;
  let sent = "";
  const mockFetch = (async (_url: any, init: any) => {
    calls++;
    sent = String(init.body);
    return new Response(
      JSON.stringify({
        model: "resolved-model",
        choices: [
          {
            message: {
              content: JSON.stringify({
                rankings: [
                  { id: "c1", score: 91, reason: "same underlying failure" },
                  { id: "c0", score: 12, reason: "word overlap only" },
                ],
              }),
            },
          },
        ],
      }),
      { status: 200 },
    );
  }) as typeof fetch;
  const secret = "sk-ant-abcdefghijklmnopqrstuvwxyz";
  const candidates = [
    { id: "c0", text: `irrelevant ${secret}` },
    { id: "c1", text: "Nix ignored a file absent from the git index" },
  ];
  const first = await rerankHosted(
    root,
    "why was my flake input invisible?",
    candidates,
    config,
    mockFetch,
  );
  expect(first.rankings[0].id).toBe("c1");
  expect(first.egress.performed).toBe(true);
  expect(sent).not.toContain(secret);
  expect(sent).toContain("[REDACTED_API_KEY]");
  expect(sent).not.toContain("conversationHash");
  const second = await rerank(
    root,
    "why was my flake input invisible?",
    candidates,
    config,
    mockFetch,
  );
  expect(second.cached).toBe(true);
  expect(second.egress.performed).toBe(false);
  expect(calls).toBe(1);
});

test("hosted rerank supports the Anthropic messages shape", async () => {
  const root = await mkdtemp(join(tmpdir(), "chatlog-rerank-anthropic-"));
  const config: RerankConfig = {
    provider: "anthropic",
    model: "claude-test",
    apiKey: "secret",
    endpoint: "https://example.invalid",
    credentialSource: "test",
  };
  let sent: any;
  const mockFetch = (async (_url: any, init: any) => {
    sent = { headers: init.headers, body: JSON.parse(init.body) };
    return new Response(
      JSON.stringify({
        model: "claude-test",
        content: [
          { type: "text", text: '{"rankings":[{"id":"c0","score":88,"reason":"equivalent"}]}' },
        ],
      }),
      { status: 200 },
    );
  }) as typeof fetch;
  const result = await rerankHosted(
    root,
    "same issue",
    [{ id: "c0", text: "same underlying problem" }],
    config,
    mockFetch,
  );
  expect(sent.headers["x-api-key"]).toBe("secret");
  expect(sent.body.messages[0].content).toContain("same underlying problem");
  expect(result.rankings[0].score).toBe(88);
});

test("resolveRerankConfig defaults to local ollama and ignores ambient hosted credentials", async () => {
  await withEnv(
    {
      CHATLOG_RERANK_PROVIDER: undefined,
      CHATLOG_RERANK_MODEL: undefined,
      CHATLOG_RERANK_ENDPOINT: undefined,
      ANTHROPIC_API_KEY: "ambient-anthropic-key",
      OPENAI_API_KEY: "ambient-openai-key",
      OPENROUTER_API_KEY: "ambient-openrouter-key",
    },
    async () => {
      const config = await resolveRerankConfig();
      expect(config.provider).toBe("ollama");
      expect(config.model).toBe("gemma4:12b");
      expect(config.endpoint).toBe("http://127.0.0.1:11434/api/chat");
      expect(config.apiKey).toBe("");
      expect(config.credentialSource).toBe("local-ollama");
    },
  );
});

test("resolveRerankConfig only activates a hosted provider when named explicitly", async () => {
  await withEnv(
    { CHATLOG_RERANK_PROVIDER: "anthropic", ANTHROPIC_API_KEY: undefined },
    async () => {
      await expect(resolveRerankConfig()).rejects.toThrow(
        "CHATLOG_RERANK_PROVIDER=anthropic requires ANTHROPIC_API_KEY",
      );
    },
  );
});

test("ollama rerank uses native /api/chat with a JSON schema and honors CHATLOG_RERANK_MODEL/ENDPOINT overrides", async () => {
  const root = await mkdtemp(join(tmpdir(), "chatlog-rerank-ollama-"));
  await withEnv(
    { CHATLOG_RERANK_PROVIDER: "ollama", CHATLOG_RERANK_MODEL: "gemma4:26b" },
    async () => {
      const config = await resolveRerankConfig();
      expect(config.model).toBe("gemma4:26b");
      let sent: any;
      const mockFetch = (async (_url: any, init: any) => {
        sent = { headers: init.headers, body: JSON.parse(init.body) };
        return new Response(
          JSON.stringify({
            model: "gemma4:26b",
            message: { content: '{"rankings":[{"id":"c0","score":70,"reason":"related"}]}' },
          }),
          { status: 200 },
        );
      }) as typeof fetch;
      const result = await rerank(
        root,
        "local rerank",
        [{ id: "c0", text: "same underlying task" }],
        config,
        mockFetch,
      );
      expect(sent.headers.authorization).toBeUndefined();
      expect(sent.body.format).toMatchObject({ type: "object" });
      expect(sent.body.stream).toBe(false);
      expect(result.provider).toBe("ollama");
      expect(result.rankings[0].score).toBe(70);
    },
  );
});
