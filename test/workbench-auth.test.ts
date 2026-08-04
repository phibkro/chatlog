import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createWorkbenchAuth,
  resolveAnnotationConfig,
  workbenchBootstrapUrl,
  workbenchHandler,
  type WorkbenchAuthConfig,
} from "../src/workbench/server";
import { WorkbenchData } from "../src/workbench/data";
import { MemoryLab, type MemoryLabResult, type MemoryLabView } from "../src/workbench/memory-lab";
import {
  ContextManagement,
  type ContextManagementResult,
  type ContextManagementView,
} from "../src/workbench/context-management";

const ORIGIN = "http://127.0.0.1:4789";
const HOST = "127.0.0.1:4789";
const TOKEN = "test-workbench-credential";

function request(
  path: string,
  init: RequestInit = {},
  extraHeaders: Record<string, string> = {},
): Request {
  return new Request(`${ORIGIN}${path}`, {
    ...init,
    headers: {
      Host: HOST,
      Origin: ORIGIN,
      ...(init.headers && !(init.headers instanceof Headers) ? init.headers : {}),
      ...extraHeaders,
    },
  });
}

function authenticatedRequest(
  path: string,
  init: RequestInit = {},
  extraHeaders: Record<string, string> = {},
): Request {
  return request(path, init, { Authorization: `Bearer ${TOKEN}`, ...extraHeaders });
}

function authOptions(overrides: Partial<WorkbenchAuthConfig> = {}) {
  return {
    credential: TOKEN,
    origin: ORIGIN,
    operatorId: "server-bound-operator",
    ...overrides,
  };
}

class RecordingMemoryLab extends MemoryLab {
  captured: unknown = undefined;

  override save(value: unknown): Promise<MemoryLabResult<MemoryLabView>> {
    this.captured = value;
    return Promise.resolve({ ok: false, status: 422, error: "captured" });
  }
}

class RecordingContextManagement extends ContextManagement {
  captured: unknown = undefined;

  override feedback(value: unknown): Promise<ContextManagementResult<ContextManagementView>> {
    this.captured = value;
    return Promise.resolve({ ok: false, status: 422, error: "captured" });
  }
}

test("Workbench API requires credentials and exact listener boundaries", async () => {
  const root = await mkdtemp(join(tmpdir(), "chatlog-workbench-auth-"));
  const data = new WorkbenchData(root);
  const handler = workbenchHandler(data, undefined, null, false, null, false, authOptions());
  try {
    expect((await handler(request("/api/overview"))).status).toBe(401);
    expect(
      (
        await handler(
          request(
            "/api/overview",
            {},
            { Host: "localhost:4789", Authorization: `Bearer ${TOKEN}` },
          ),
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await handler(
          request(
            "/api/overview",
            {},
            { Origin: "http://localhost:4789", Authorization: `Bearer ${TOKEN}` },
          ),
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await handler(
          request("/api/context/feedback", {
            method: "POST",
            body: "{}",
          }),
        )
      ).status,
    ).toBe(401);
    expect((await handler(request("/"))).status).toBe(200);
  } finally {
    data.close();
  }
});
test("Workbench accepts only exact configured reverse-proxy origins", async () => {
  const root = await mkdtemp(join(tmpdir(), "chatlog-workbench-proxy-auth-"));
  const data = new WorkbenchData(root);
  const externalOrigin = "https://chatlog.example.net";
  const handler = workbenchHandler(
    data,
    undefined,
    null,
    false,
    null,
    false,
    authOptions({ allowedOrigins: new Set([ORIGIN, externalOrigin]) }),
  );
  const externalRequest = (
    origin: string,
    host = "chatlog.example.net",
    requestOrigin = origin,
  ): Request =>
    new Request(`${origin}/api/overview`, {
      headers: {
        Host: host,
        Origin: requestOrigin,
        Authorization: `Bearer ${TOKEN}`,
      },
    });
  try {
    expect((await handler(externalRequest(externalOrigin))).status).toBe(200);
    expect((await handler(externalRequest("https://attacker.example.net"))).status).toBe(403);
    expect((await handler(externalRequest(externalOrigin, "attacker.example.net"))).status).toBe(
      403,
    );
    expect(
      (await handler(externalRequest(externalOrigin, "chatlog.example.net", ORIGIN))).status,
    ).toBe(403);
    expect(workbenchBootstrapUrl(externalOrigin, TOKEN)).toBe(
      `${externalOrigin}/#chatlog-workbench=${TOKEN}`,
    );
  } finally {
    data.close();
  }
});

test("Workbench rejects cleartext origins outside the loopback boundary", () => {
  expect(() =>
    createWorkbenchAuth("127.0.0.1", 4789, undefined, ["http://chatlog.example.net"]),
  ).toThrow("HTTPS");
  expect(() =>
    resolveAnnotationConfig(
      { host: "127.0.0.1", port: 4789 },
      {
        CHATLOG_ALLOW_ANNOTATIONS: "1",
        CHATLOG_ANNOTATION_ORIGINS: "http://chatlog.example.net",
      },
    ),
  ).toThrow("HTTPS");
});

test("Workbench dev-proxy bootstrap and API requests use exact listener headers", async () => {
  const root = await mkdtemp(join(tmpdir(), "chatlog-workbench-bootstrap-"));
  const data = new WorkbenchData(root);
  const auth = authOptions();
  const handler = workbenchHandler(data, undefined, null, false, null, false, auth);
  try {
    const bootstrap = await handler(
      request("/auth/bootstrap", { method: "POST" }, { Authorization: `Bearer ${TOKEN}` }),
    );
    expect(bootstrap.status).toBe(204);
    expect(bootstrap.headers.get("set-cookie")).toContain("HttpOnly");
    expect(bootstrap.headers.get("set-cookie")).toContain("SameSite=Strict");
    expect(await bootstrap.text()).toBe("");
    expect(
      (
        await handler(
          request("/auth/bootstrap", { method: "POST" }, { Authorization: `Bearer ${TOKEN}` }),
        )
      ).status,
    ).toBe(401);

    const cookie = bootstrap.headers.get("set-cookie")?.split(";", 1)[0];
    expect(cookie).toBe(`chatlog_workbench=${TOKEN}`);
    expect((await handler(request("/api/overview", {}, { Cookie: cookie ?? "" }))).status).toBe(
      200,
    );
    expect(workbenchBootstrapUrl(ORIGIN, TOKEN)).toBe(`${ORIGIN}/#chatlog-workbench=${TOKEN}`);
  } finally {
    data.close();
  }
});
test("Workbench credential cookies are Secure for HTTPS but not loopback HTTP", async () => {
  const httpsRoot = await mkdtemp(join(tmpdir(), "chatlog-workbench-https-cookie-"));
  const httpsData = new WorkbenchData(httpsRoot);
  const externalOrigin = "https://chatlog.example.net";
  const httpsHandler = workbenchHandler(
    httpsData,
    undefined,
    null,
    false,
    null,
    false,
    authOptions({ allowedOrigins: new Set([ORIGIN, externalOrigin]) }),
  );
  try {
    const response = await httpsHandler(
      new Request(`${externalOrigin}/auth/bootstrap`, {
        method: "POST",
        headers: {
          Host: "chatlog.example.net",
          Origin: externalOrigin,
          Authorization: `Bearer ${TOKEN}`,
        },
      }),
    );
    expect(response.status).toBe(204);
    expect(response.headers.get("set-cookie")).toContain("Secure");
  } finally {
    httpsData.close();
  }

  const httpRoot = await mkdtemp(join(tmpdir(), "chatlog-workbench-http-cookie-"));
  const httpData = new WorkbenchData(httpRoot);
  const httpHandler = workbenchHandler(
    httpData,
    undefined,
    null,
    false,
    null,
    false,
    authOptions(),
  );
  try {
    const response = await httpHandler(
      request("/auth/bootstrap", { method: "POST" }, { Authorization: `Bearer ${TOKEN}` }),
    );
    expect(response.status).toBe(204);
    expect(response.headers.get("set-cookie")).not.toContain("Secure");
  } finally {
    httpData.close();
  }
});

test("Workbench binds write authority to the server operator", async () => {
  const root = await mkdtemp(join(tmpdir(), "chatlog-workbench-write-auth-"));
  const data = new WorkbenchData(root);
  const memoryLab = new RecordingMemoryLab(root);
  const context = new RecordingContextManagement(root);
  const handler = workbenchHandler(data, undefined, memoryLab, true, context, true, authOptions());
  try {
    const memoryResponse = await handler(
      authenticatedRequest(
        "/api/memory-lab/draft",
        {
          method: "POST",
          body: JSON.stringify({
            packetHash: "packet",
            proposalSetHash: "proposals",
            candidateAlias: "C001",
            reviewerId: "attacker-controlled-reviewer",
            review: {
              status: "reviewed",
              judgment: "correct",
              valence: "positive",
              feedback: "",
            },
          }),
        },
        {
          "Content-Type": "application/json",
          "X-Chatlog-Memory-Lab": "1",
        },
      ),
    );
    expect(memoryResponse.status).toBe(422);
    expect(memoryLab.captured).toMatchObject({ reviewerId: "server-bound-operator" });

    const contextResponse = await handler(
      authenticatedRequest(
        "/api/context/feedback",
        {
          method: "POST",
          body: JSON.stringify({
            contextSessionId: "attacker-session",
            interventionEventId: "attacker-event",
            signal: "accepted",
            operatorId: "attacker-controlled-operator",
          }),
        },
        {
          "Content-Type": "application/json",
          "X-Chatlog-Context": "1",
        },
      ),
    );
    expect(contextResponse.status).toBe(422);
    expect(context.captured).toMatchObject({ operatorId: "server-bound-operator" });
  } finally {
    data.close();
  }
});

test("Workbench launch credentials are random per launch", () => {
  const first = createWorkbenchAuth("127.0.0.1", 4789);
  const second = createWorkbenchAuth("127.0.0.1", 4789);
  expect(first.credential).not.toBe(second.credential);
  expect(first.credential).toMatch(/^[A-Za-z0-9_-]{43}$/u);
});
