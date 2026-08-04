#!/usr/bin/env bun
import { randomBytes, timingSafeEqual } from "node:crypto";
import { resolve } from "node:path";
import { redact } from "../redact";
import { WorkbenchData } from "./data";
import { resolveDataRoot } from "../data-root";
import { DerivedProjectionDriftError } from "../derived-authority";
import { ActiveProjectionDriftError } from "../source-authority";
import { MemoryLab, type MemoryLabResult } from "./memory-lab";
import { ContextManagement, type ContextManagementResult } from "./context-management";

const MEMORY_LAB_WRITE_HEADER = "X-Chatlog-Memory-Lab";
const MEMORY_LAB_MAX_BODY_BYTES = 16 * 1024;
const CONTEXT_WRITE_HEADER = "X-Chatlog-Context";
const CONTEXT_MAX_BODY_BYTES = MEMORY_LAB_MAX_BODY_BYTES;
const WORKBENCH_AUTH_COOKIE = "chatlog_workbench";
const WORKBENCH_BOOTSTRAP_PATH = "/auth/bootstrap";
const WORKBENCH_BOOTSTRAP_FRAGMENT = "chatlog-workbench";
const DEFAULT_WORKBENCH_ORIGIN = "http://127.0.0.1:4789";
const DEFAULT_WORKBENCH_OPERATOR_ID = "local-workbench-operator";
const WORKBENCH_OPERATOR_ID_MAX_BYTES = 80;

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

export interface WorkbenchAuthConfig {
  credential: string;
  operatorId: string;
  origin: string;
}

export interface WorkbenchHandlerOptions {
  auth?: Partial<WorkbenchAuthConfig>;
  credential?: string;
  operatorId?: string;
  origin?: string;
}

function listenerOrigin(host: string, port: number): string {
  const hostname = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  return `http://${hostname.includes(":") ? `[${hostname}]` : hostname}:${port}`;
}

function normalizeOrigin(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("Workbench listener origin must be a valid URL");
  }
  if (
    parsed.protocol !== "http:" ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash
  )
    throw new Error("Workbench listener origin must be an HTTP origin");
  return parsed.origin;
}

function normalizeCredential(value: string): string {
  if (!/^[A-Za-z0-9_-]+$/u.test(value))
    throw new Error("Workbench credential must contain only URL-safe token characters");
  return value;
}
function containsControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index++)
    if (value.charCodeAt(index) <= 0x1f || value.charCodeAt(index) === 0x7f) return true;
  return false;
}

function normalizeOperatorId(value: string | undefined): string {
  const operatorId = value?.trim() || DEFAULT_WORKBENCH_OPERATOR_ID;
  if (
    operatorId.length === 0 ||
    operatorId.length > WORKBENCH_OPERATOR_ID_MAX_BYTES ||
    containsControlCharacter(operatorId)
  )
    throw new Error(
      `CHATLOG_OPERATOR_ID must be 1–${WORKBENCH_OPERATOR_ID_MAX_BYTES} printable characters`,
    );
  return operatorId;
}

function resolveWorkbenchAuth(options: WorkbenchHandlerOptions = {}): WorkbenchAuthConfig {
  const supplied = options.auth ?? {};
  return {
    credential: normalizeCredential(
      supplied.credential ?? options.credential ?? randomBytes(32).toString("base64url"),
    ),
    operatorId: normalizeOperatorId(supplied.operatorId ?? options.operatorId),
    origin: normalizeOrigin(supplied.origin ?? options.origin ?? DEFAULT_WORKBENCH_ORIGIN),
  };
}

export function createWorkbenchAuth(
  host: string,
  port: number,
  operatorId?: string,
): WorkbenchAuthConfig {
  return resolveWorkbenchAuth({
    origin: listenerOrigin(host, port),
    operatorId,
  });
}

export function workbenchBootstrapUrl(origin: string, credential: string, path = "/"): string {
  const url = new URL(normalizeOrigin(origin));
  url.pathname = path;
  url.hash = `${WORKBENCH_BOOTSTRAP_FRAGMENT}=${normalizeCredential(credential)}`;
  return url.href;
}

function constantTimeCredentialMatch(actual: string, expected: string): boolean {
  const actualBytes = new TextEncoder().encode(actual);
  const expectedBytes = new TextEncoder().encode(expected);
  return (
    actualBytes.byteLength === expectedBytes.byteLength &&
    timingSafeEqual(actualBytes, expectedBytes)
  );
}

function requestCredential(request: Request): string | undefined {
  let cookieCredential: string | undefined;
  for (const part of request.headers.get("cookie")?.split(";") ?? []) {
    const separator = part.indexOf("=");
    if (separator < 0 || part.slice(0, separator).trim() !== WORKBENCH_AUTH_COOKIE) continue;
    if (cookieCredential !== undefined) return undefined;
    cookieCredential = part.slice(separator + 1).trim();
  }
  const authorization = request.headers.get("authorization");
  const bearerCredential =
    authorization?.startsWith("Bearer ") === true
      ? authorization.slice("Bearer ".length).trim()
      : undefined;
  if (
    cookieCredential !== undefined &&
    bearerCredential !== undefined &&
    !constantTimeCredentialMatch(cookieCredential, bearerCredential)
  )
    return undefined;
  return bearerCredential ?? cookieCredential;
}

function normalizeHost(value: string | null): string | undefined {
  if (value === null || value.length === 0 || value.includes(",") || /[/?#@]/u.test(value))
    return undefined;
  try {
    const parsed = new URL(`http://${value}`);
    if (
      parsed.username ||
      parsed.password ||
      parsed.pathname !== "/" ||
      parsed.search ||
      parsed.hash
    )
      return undefined;
    return parsed.host.toLowerCase();
  } catch {
    return undefined;
  }
}

function requestMatchesListener(request: Request, url: URL, origin: string): string | undefined {
  if (url.origin !== origin) return "invalid listener origin";
  const expectedHost = normalizeHost(new URL(origin).host);
  if (expectedHost === undefined || normalizeHost(request.headers.get("host")) !== expectedHost)
    return "invalid host";
  const requestOrigin = request.headers.get("origin");
  if (requestOrigin !== null && requestOrigin !== origin) return "invalid origin";
  return undefined;
}

function bootstrapResponse(credential: string): Response {
  return securityHeaders(
    new Response(null, {
      status: 204,
      headers: {
        "Cache-Control": "no-store",
        "Set-Cookie": `${WORKBENCH_AUTH_COOKIE}=${credential}; Path=/; HttpOnly; SameSite=Strict`,
        "X-Content-Type-Options": "nosniff",
      },
    }),
  );
}

function bindOperatorIdentity(
  value: unknown,
  field: "operatorId" | "reviewerId",
  id: string,
): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return value;
  return { ...(value as Record<string, unknown>), [field]: id };
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function errorStatus(message: string): number {
  if (message === "Evidence not found" || message === "Evidence turn not found") return 404;
  if (message === "knowledge candidate artifact not found") return 404;
  if (message.startsWith("knowledge candidate not found: ")) return 404;
  if (message.startsWith("project not found: ")) return 404;
  return 400;
}

function securityHeaders(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set(
    "Content-Security-Policy",
    "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  );
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("X-Frame-Options", "DENY");
  headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function memoryLabResponse<T>(result: MemoryLabResult<T>): Response {
  return result.ok ? json(result.value) : json({ error: result.error }, result.status);
}

async function memoryLabBody<T>(
  request: Request,
  memoryLabWrites: boolean,
): Promise<MemoryLabResult<T>> {
  if (!memoryLabWrites) return { ok: false, status: 403, error: "memory lab writes disabled" };
  if (request.headers.get(MEMORY_LAB_WRITE_HEADER) !== "1")
    return { ok: false, status: 403, error: "memory lab write header required" };
  if (request.headers.get("content-type")?.split(";")[0]?.trim() !== "application/json")
    return { ok: false, status: 415, error: "memory lab writes require application/json" };
  const declaredLength = Number(request.headers.get("content-length") ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > MEMORY_LAB_MAX_BODY_BYTES)
    return { ok: false, status: 413, error: "memory lab request is too large" };
  const reader = request.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (reader !== undefined)
    while (true) {
      // oxlint-disable-next-line no-await-in-loop -- the stream must be consumed sequentially
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > MEMORY_LAB_MAX_BODY_BYTES) {
        void reader.cancel().catch(() => undefined);
        return { ok: false, status: 413, error: "memory lab request is too large" };
      }
      chunks.push(next.value);
    }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const text = new TextDecoder().decode(bytes);
  try {
    return { ok: true, value: JSON.parse(text) as T };
  } catch {
    return { ok: false, status: 400, error: "memory lab request must be valid JSON" };
  }
}

function contextManagementResponse<T>(result: ContextManagementResult<T>): Response {
  return result.ok ? json(result.value) : json({ error: result.error }, result.status);
}

async function contextBody<T>(
  request: Request,
  contextWrites: boolean,
): Promise<ContextManagementResult<T>> {
  if (!contextWrites) return { ok: false, status: 403, error: "context writes disabled" };
  if (request.headers.get(CONTEXT_WRITE_HEADER) !== "1")
    return { ok: false, status: 403, error: "context write header required" };
  if (request.headers.get("content-type")?.split(";")[0]?.trim() !== "application/json")
    return { ok: false, status: 415, error: "context writes require application/json" };
  const declaredLength = Number(request.headers.get("content-length") ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > CONTEXT_MAX_BODY_BYTES)
    return { ok: false, status: 413, error: "context request is too large" };
  const reader = request.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (reader !== undefined)
    while (true) {
      // oxlint-disable-next-line no-await-in-loop -- the stream must be consumed sequentially
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > CONTEXT_MAX_BODY_BYTES) {
        void reader.cancel().catch(() => undefined);
        return { ok: false, status: 413, error: "context request is too large" };
      }
      chunks.push(next.value);
    }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const text = new TextDecoder().decode(bytes);
  try {
    return { ok: true, value: JSON.parse(text) as T };
  } catch {
    return { ok: false, status: 400, error: "context request must be valid JSON" };
  }
}

export function workbenchHandler(
  data: WorkbenchData,
  publicRoot = resolve(import.meta.dir, "public"),
  memoryLab: MemoryLab | null = null,
  memoryLabWrites = false,
  contextManagement?: ContextManagement | null,
  contextWrites = false,
  options: WorkbenchHandlerOptions = {},
) {
  const auth = resolveWorkbenchAuth(options);
  const context =
    contextManagement === undefined && typeof data.root === "string"
      ? new ContextManagement(data.root)
      : (contextManagement ?? null);
  let bootstrapConsumed = false;
  return async function fetch(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url);
      const boundaryError = requestMatchesListener(request, url, auth.origin);
      if (boundaryError !== undefined) return json({ error: boundaryError }, 403);
      if (url.pathname === WORKBENCH_BOOTSTRAP_PATH) {
        if (request.method !== "POST") return json({ error: "method not allowed" }, 405);
        if (bootstrapConsumed)
          return json({ error: "workbench bootstrap credential already used" }, 401);
        const authorization = request.headers.get("authorization");
        const credential =
          authorization?.startsWith("Bearer ") === true
            ? authorization.slice("Bearer ".length).trim()
            : undefined;
        if (credential === undefined || !constantTimeCredentialMatch(credential, auth.credential))
          return json({ error: "workbench bootstrap credential required" }, 401);
        bootstrapConsumed = true;
        return bootstrapResponse(auth.credential);
      }
      if (url.pathname.startsWith("/api/")) {
        const credential = requestCredential(request);
        if (credential === undefined || !constantTimeCredentialMatch(credential, auth.credential))
          return json({ error: "workbench credential required" }, 401);
      }
      if (url.pathname === "/api/memory-lab" && request.method === "GET") {
        if (!memoryLab) return json({ error: "memory lab unavailable" }, 404);
        return memoryLabResponse(await memoryLab.get());
      }
      if (url.pathname === "/api/memory-lab/draft" && request.method === "POST") {
        if (!memoryLab) return json({ error: "memory lab unavailable" }, 404);
        const body = await memoryLabBody<unknown>(request, memoryLabWrites);
        return body.ok
          ? memoryLabResponse(
              await memoryLab.save(bindOperatorIdentity(body.value, "reviewerId", auth.operatorId)),
            )
          : memoryLabResponse(body);
      }
      if (url.pathname === "/api/memory-lab/finalize" && request.method === "POST") {
        if (!memoryLab) return json({ error: "memory lab unavailable" }, 404);
        const body = await memoryLabBody<unknown>(request, memoryLabWrites);
        return body.ok
          ? memoryLabResponse(
              await memoryLab.finalize(
                bindOperatorIdentity(body.value, "reviewerId", auth.operatorId),
              ),
            )
          : memoryLabResponse(body);
      }
      if (url.pathname === "/api/memory-lab/insight-preview" && request.method === "POST") {
        if (!memoryLab) return json({ error: "memory lab unavailable" }, 404);
        const body = await memoryLabBody<unknown>(request, memoryLabWrites);
        return body.ok
          ? memoryLabResponse(
              await memoryLab.previewInsightTransition(
                bindOperatorIdentity(body.value, "reviewerId", auth.operatorId),
              ),
            )
          : memoryLabResponse(body);
      }
      if (url.pathname === "/api/memory-lab/insight-apply" && request.method === "POST") {
        if (!memoryLab) return json({ error: "memory lab unavailable" }, 404);
        const body = await memoryLabBody<unknown>(request, memoryLabWrites);
        return body.ok
          ? memoryLabResponse(
              await memoryLab.applyInsightTransition(
                bindOperatorIdentity(body.value, "reviewerId", auth.operatorId),
              ),
            )
          : memoryLabResponse(body);
      }
      if (url.pathname === "/api/context" && request.method === "GET") {
        if (!context) return json({ error: "context management unavailable" }, 404);
        return contextManagementResponse(await context.get());
      }
      if (url.pathname === "/api/context/feedback" && request.method === "POST") {
        if (!context) return json({ error: "context management unavailable" }, 404);
        const body = await contextBody<unknown>(request, contextWrites);
        return body.ok
          ? contextManagementResponse(
              await context.feedback(
                bindOperatorIdentity(body.value, "operatorId", auth.operatorId),
              ),
            )
          : contextManagementResponse(body);
      }
      if (url.pathname === "/api/context/outcome" && request.method === "POST") {
        if (!context) return json({ error: "context management unavailable" }, 404);
        const body = await contextBody<unknown>(request, contextWrites);
        return body.ok
          ? contextManagementResponse(
              await context.outcome(
                bindOperatorIdentity(body.value, "operatorId", auth.operatorId),
              ),
            )
          : contextManagementResponse(body);
      }
      if (request.method !== "GET" && request.method !== "HEAD")
        return json({ error: "read-only workbench" }, 405);
      if (url.pathname === "/api/health") {
        const health = data.health();
        return json(health, health.ready ? 200 : 503);
      }
      if (url.pathname === "/api/overview") return json(await data.overview());
      if (url.pathname === "/api/projects")
        return json(data.projects(url.searchParams.get("limit")));
      if (url.pathname === "/api/sessions") return json(data.sessions(url));
      if (url.pathname === "/api/search") return json(data.search(url));
      if (url.pathname === "/api/prior-attempts") return json(await data.priorAttempts(url));
      if (url.pathname === "/api/project-intelligence")
        return json(await data.projectIntelligence(url));
      if (url.pathname === "/api/knowledge-candidates")
        return json(await data.knowledgeCandidates(url));
      if (url.pathname === "/api/knowledge-candidate")
        return json(await data.knowledgeCandidate(url));
      if (url.pathname === "/api/themes") return json(await data.themes(url));
      if (url.pathname === "/api/insights") return json(await data.insights(url));
      if (url.pathname === "/api/sources") return json(await data.sources());
      if (url.pathname === "/api/receipts")
        return json(await data.receipts(url.searchParams.get("limit")));
      if (url.pathname === "/api/source-receipts")
        return json(await data.sourceReceipts(url.searchParams.get("limit")));
      if (url.pathname === "/api/nominations") return json(await data.nominations());
      if (url.pathname === "/api/evidence") {
        const uri = url.searchParams.get("uri");
        if (!uri) return json({ error: "missing evidence URI" }, 400);
        return json(await data.evidence(uri));
      }
      if (url.pathname.startsWith("/api/")) return json({ error: "not found" }, 404);

      const asset =
        url.pathname === "/"
          ? "index.html"
          : url.pathname === "/memory" || url.pathname === "/memory/"
            ? "memory/index.html"
            : url.pathname.replace(/^\/+/, "");
      if (asset.includes("..") || asset.includes("\\")) return json({ error: "not found" }, 404);
      const file = Bun.file(resolve(publicRoot, asset));
      if (!(await file.exists())) return json({ error: "not found" }, 404);
      const extension = asset.includes(".") ? `.${asset.split(".").at(-1)}` : "";
      return securityHeaders(
        new Response(request.method === "HEAD" ? null : file, {
          headers: {
            "Content-Type": MIME[extension] ?? "application/octet-stream",
            "Cache-Control": "no-cache",
          },
        }),
      );
    } catch (error: unknown) {
      const message = redact(error instanceof Error ? error.message : String(error));
      const status =
        error instanceof ActiveProjectionDriftError || error instanceof DerivedProjectionDriftError
          ? 503
          : errorStatus(message);
      return json({ error: message }, status);
    }
  };
}

export interface WorkbenchBindConfig {
  host: string;
  port: number;
  memoryLabWrites: boolean;
  contextWrites: boolean;
}

export function resolveBindConfig(
  env: Record<string, string | undefined> = process.env,
): WorkbenchBindConfig {
  const host = env.CHATLOG_HOST ?? "127.0.0.1";
  const loopback = ["127.0.0.1", "::1", "localhost"].includes(host);
  if (!loopback && env.CHATLOG_ALLOW_REMOTE !== "1") {
    throw new Error("Refusing non-loopback bind without CHATLOG_ALLOW_REMOTE=1");
  }
  const port = Number(env.CHATLOG_PORT ?? 4789);
  if (!Number.isInteger(port) || port < 1 || port > 65_535)
    throw new Error("CHATLOG_PORT must be an integer between 1 and 65535");
  return {
    host,
    port,
    memoryLabWrites: loopback || env.CHATLOG_MEMORY_LAB_WRITES === "1",
    contextWrites: loopback || env.CHATLOG_CONTEXT_WRITES === "1",
  };
}

if (import.meta.main) {
  const root = resolveDataRoot();
  const { host, port, memoryLabWrites, contextWrites } = resolveBindConfig();
  const auth = createWorkbenchAuth(host, port, process.env.CHATLOG_OPERATOR_ID);
  const data = new WorkbenchData(root);
  const server = Bun.serve({
    hostname: host,
    port,
    fetch: workbenchHandler(
      data,
      resolve(import.meta.dir, "public"),
      new MemoryLab(root),
      memoryLabWrites,
      new ContextManagement(root),
      contextWrites,
      { auth },
    ),
  });
  console.log(
    `Chatlog Workbench bootstrap URL: ${workbenchBootstrapUrl(
      new URL(server.url).origin,
      auth.credential,
    )}`,
  );
  console.log(`Data root: ${root}`);
}
