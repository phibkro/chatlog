#!/usr/bin/env bun
import { resolve } from "node:path";
import { redact } from "../redact";
import { WorkbenchData } from "./data";
import { resolveDataRoot } from "../data-root";
import { ActiveProjectionDriftError } from "../source-authority";
import { DerivedProjectionDriftError } from "../derived-authority";
import {
  PatternAnnotationBusyError,
  PatternAnnotationConflictError,
  PatternAnnotationIntegrityError,
} from "../pattern-annotations";

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

class WorkbenchHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "WorkbenchHttpError";
  }
}

async function boundedJsonBody(
  request: Request,
  maximumBytes = 8 * 1024,
): Promise<unknown> {
  const contentType = request.headers.get("Content-Type")?.split(";", 1)[0]
    ?.trim().toLowerCase();
  if (contentType !== "application/json")
    throw new WorkbenchHttpError("content type must be application/json", 415);
  if (!request.body) throw new WorkbenchHttpError("missing JSON body", 400);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > maximumBytes) {
      await reader.cancel();
      throw new WorkbenchHttpError(
        `request body exceeds ${maximumBytes} bytes`,
        413,
      );
    }
    chunks.push(value);
  }
  const body = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
  } catch {
    throw new WorkbenchHttpError("request body is not valid JSON", 400);
  }
}

function securityHeaders(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("Content-Security-Policy", "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("X-Frame-Options", "DENY");
  headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export interface WorkbenchAnnotationHttpConfig {
  enabled: boolean;
  allowedOrigins: ReadonlySet<string>;
  maximumWritesPerMinute?: number;
}

export function workbenchHandler(
  data: WorkbenchData,
  publicRoot = resolve(import.meta.dir, "public"),
  annotationConfig: WorkbenchAnnotationHttpConfig = {
    enabled: false,
    allowedOrigins: new Set(),
  },
) {
  const writeTimes: number[] = [];
  return async function fetch(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url);
      if (
        request.method === "POST"
        && url.pathname === "/api/pattern-annotations"
      ) {
        if (!annotationConfig.enabled)
          return json({ error: "pattern annotations are disabled" }, 405);
        const origin = request.headers.get("Origin");
        if (!origin || !annotationConfig.allowedOrigins.has(origin))
          throw new WorkbenchHttpError(
            "annotation origin is not allowed",
            403,
          );
        if (request.headers.get("Sec-Fetch-Site") !== "same-origin")
          throw new WorkbenchHttpError(
            "annotation writes require same-origin browser fetch metadata",
            403,
          );
        const now = Date.now();
        const cutoff = now - 60_000;
        while (writeTimes.length && writeTimes[0] < cutoff) writeTimes.shift();
        const maximumWrites = annotationConfig.maximumWritesPerMinute ?? 30;
        if (writeTimes.length >= maximumWrites)
          throw new WorkbenchHttpError(
            "annotation write rate exceeded; retry later",
            429,
          );
        // Reserve capacity before parsing or awaiting storage. Failed attempts
        // and concurrent bursts consume the same global mutation budget.
        writeTimes.push(now);
        const input = await boundedJsonBody(request);
        const annotation = await data.annotatePattern(input as any);
        return json({ annotation });
      }
      if (request.method !== "GET" && request.method !== "HEAD")
        return json({ error: "read-only workbench" }, 405);
      if (url.pathname === "/api/health") {
        const health = data.health();
        return json(health, health.ready ? 200 : 503);
      }
      if (url.pathname === "/api/overview") return json(await data.overview());
      if (url.pathname === "/api/projects") return json(data.projects(url.searchParams.get("limit")));
      if (url.pathname === "/api/sessions") return json(data.sessions(url));
      if (url.pathname === "/api/search") return json(data.search(url));
      if (url.pathname === "/api/insights") return json(await data.insights());
      if (url.pathname === "/api/sources") return json(await data.sources());
      if (url.pathname === "/api/receipts") return json(await data.receipts(url.searchParams.get("limit")));
      if (url.pathname === "/api/evidence") {
        const uri = url.searchParams.get("uri");
        if (!uri) return json({ error: "missing evidence URI" }, 400);
        return json(await data.evidence(uri));
      }
      if (url.pathname.startsWith("/api/")) return json({ error: "not found" }, 404);

      const asset = url.pathname === "/" ? "index.html" : url.pathname.replace(/^\/+/, "");
      if (asset.includes("..") || asset.includes("\\")) return json({ error: "not found" }, 404);
      const file = Bun.file(resolve(publicRoot, asset));
      if (!(await file.exists())) return json({ error: "not found" }, 404);
      const extension = asset.includes(".") ? `.${asset.split(".").at(-1)}` : "";
      return securityHeaders(new Response(request.method === "HEAD" ? null : file, {
        headers: {
          "Content-Type": MIME[extension] ?? "application/octet-stream",
          "Cache-Control": asset === "index.html" ? "no-cache" : "public, max-age=3600",
        },
      }));
    } catch (error: any) {
      const message = redact(String(error?.message ?? error));
      if (error instanceof PatternAnnotationConflictError) {
        return json({
          error: message,
          current: error.current,
          snapshot: error.snapshot,
        }, 409);
      }
      const status = error instanceof WorkbenchHttpError
        ? error.status
        : error instanceof ActiveProjectionDriftError
        || error instanceof DerivedProjectionDriftError
        || error instanceof PatternAnnotationIntegrityError
        || error instanceof PatternAnnotationBusyError
        ? 503
        : message.includes("not found") ? 404 : 400;
      return json({ error: message }, status);
    }
  };
}

export interface WorkbenchBindConfig {
  host: string;
  port: number;
}

export interface WorkbenchAnnotationConfig {
  enabled: boolean;
  allowedOrigins: Set<string>;
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

export function resolveAnnotationConfig(
  bind: WorkbenchBindConfig,
  env: Record<string, string | undefined> = process.env,
): WorkbenchAnnotationConfig {
  const enabled = env.CHATLOG_ALLOW_ANNOTATIONS === "1";
  if (
    enabled
    && !["127.0.0.1", "::1", "localhost"].includes(bind.host)
    && env.CHATLOG_ACK_REMOTE_ANNOTATIONS !== "1"
  ) throw new Error(
    "Refusing annotations on a non-loopback bind without CHATLOG_ACK_REMOTE_ANNOTATIONS=1",
  );
  const allowedOrigins = new Set<string>([
    `http://127.0.0.1:${bind.port}`,
    `http://localhost:${bind.port}`,
    `http://[::1]:${bind.port}`,
  ].map((candidate) => new URL(candidate).origin));
  for (
    const candidate of (env.CHATLOG_ANNOTATION_ORIGINS ?? "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean)
  ) {
    let url: URL;
    try {
      url = new URL(candidate);
    } catch {
      throw new Error(`Invalid annotation origin: ${candidate}`);
    }
    if (
      !["http:", "https:"].includes(url.protocol)
      ||
      url.username
      || url.password
      || url.pathname !== "/"
      || url.search
      || url.hash
    ) throw new Error(
      `Annotation origin must be a bare HTTP(S) origin: ${candidate}`,
    );
    allowedOrigins.add(url.origin);
  }
  return { enabled, allowedOrigins };
}

if (import.meta.main) {
  const root = resolveDataRoot();
  const bind = resolveBindConfig();
  const annotationConfig = resolveAnnotationConfig(bind);
  const data = new WorkbenchData(root, {
    annotationsEnabled: annotationConfig.enabled,
  });
  const server = Bun.serve({
    hostname: bind.host,
    port: bind.port,
    fetch: workbenchHandler(data, undefined, annotationConfig),
  });
  console.log(`Chatlog Workbench: ${server.url}`);
  console.log(`Data root: ${root}`);
  console.log(
    `Pattern annotations: ${annotationConfig.enabled ? "enabled" : "disabled"}`,
  );
}
