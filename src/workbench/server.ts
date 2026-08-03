#!/usr/bin/env bun
import { resolve } from "node:path";
import { redact } from "../redact";
import { WorkbenchData } from "./data";
import { resolveDataRoot } from "../data-root";
import { DerivedProjectionDriftError } from "../derived-authority";
import { ActiveProjectionDriftError } from "../source-authority";
import { MemoryLab, type MemoryLabResult } from "./memory-lab";

const MEMORY_LAB_WRITE_HEADER = "X-Chatlog-Memory-Lab";
const MEMORY_LAB_MAX_BODY_BYTES = 16 * 1024;

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

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

async function memoryLabBody<T>(request: Request): Promise<MemoryLabResult<T>> {
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

export function workbenchHandler(
  data: WorkbenchData,
  publicRoot = resolve(import.meta.dir, "public"),
  memoryLab: MemoryLab | null = null,
) {
  return async function fetch(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url);
      if (url.pathname === "/api/memory-lab" && request.method === "GET") {
        if (!memoryLab) return json({ error: "memory lab unavailable" }, 404);
        return memoryLabResponse(await memoryLab.get());
      }
      if (url.pathname === "/api/memory-lab/draft" && request.method === "POST") {
        if (!memoryLab) return json({ error: "memory lab unavailable" }, 404);
        const body = await memoryLabBody<unknown>(request);
        return body.ok
          ? memoryLabResponse(await memoryLab.save(body.value))
          : memoryLabResponse(body);
      }
      if (url.pathname === "/api/memory-lab/finalize" && request.method === "POST") {
        if (!memoryLab) return json({ error: "memory lab unavailable" }, 404);
        const body = await memoryLabBody<unknown>(request);
        return body.ok
          ? memoryLabResponse(await memoryLab.finalize(body.value))
          : memoryLabResponse(body);
      }
      if (request.method !== "GET" && request.method !== "HEAD")
        return json({ error: "read-only workbench" }, 405);
      const url = new URL(request.url);
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
      if (url.pathname === "/api/receipts") return json(await data.receipts(url.searchParams.get("limit")));
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
    } catch (error: any) {
      const message = redact(String(error?.message ?? error));
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
}

export function resolveBindConfig(
  env: Record<string, string | undefined> = process.env,
): WorkbenchBindConfig {
  const host = env.CHATLOG_HOST ?? "127.0.0.1";
  if (!["127.0.0.1", "::1", "localhost"].includes(host) && env.CHATLOG_ALLOW_REMOTE !== "1") {
    throw new Error("Refusing non-loopback bind without CHATLOG_ALLOW_REMOTE=1");
  }
  const port = Number(env.CHATLOG_PORT ?? 4789);
  if (!Number.isInteger(port) || port < 1 || port > 65_535)
    throw new Error("CHATLOG_PORT must be an integer between 1 and 65535");
  return { host, port };
}

if (import.meta.main) {
  const root = resolveDataRoot();
  const { host, port } = resolveBindConfig();
  const data = new WorkbenchData(root);
  const server = Bun.serve({
    hostname: host,
    port,
    fetch: workbenchHandler(data, resolve(import.meta.dir, "public"), new MemoryLab(root)),
  });
  console.log(`Chatlog Workbench: ${server.url}`);
  console.log(`Data root: ${root}`);
}
