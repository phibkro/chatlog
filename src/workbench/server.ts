#!/usr/bin/env bun
import { resolve } from "node:path";
import { redact } from "../redact";
import { WorkbenchData } from "./data";
import { resolveDataRoot } from "../data-root";
import { ActiveProjectionDriftError } from "../source-authority";

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

function securityHeaders(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("Content-Security-Policy", "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("X-Frame-Options", "DENY");
  headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export function workbenchHandler(data: WorkbenchData, publicRoot = resolve(import.meta.dir, "public")) {
  return async function fetch(request: Request): Promise<Response> {
    try {
      if (request.method !== "GET" && request.method !== "HEAD") return json({ error: "read-only workbench" }, 405);
      const url = new URL(request.url);
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
      const status = error instanceof ActiveProjectionDriftError
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
  const server = Bun.serve({ hostname: host, port, fetch: workbenchHandler(data) });
  console.log(`Chatlog Workbench: ${server.url}`);
  console.log(`Data root: ${root}`);
}
