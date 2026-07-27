import { readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, normalize, resolve } from "node:path";

export const PROJECT_IDENTITY_RECIPE = "git-common-dir-v1";

const CACHE_LIMIT = 512;
const commonDirectoryCache = new Map<string, string>();
const cwdResolutionCache = new Map<
  string,
  { readonly canonicalCwd: string; readonly project: string }
>();

function normalizedFallback(cwd: string): string {
  return cwd ? normalize(cwd) : "(unknown)";
}

function existingDirectory(path: string): string | undefined {
  try {
    const canonical = realpathSync(path);
    return statSync(canonical).isDirectory() ? canonical : undefined;
  } catch {
    return undefined;
  }
}

function isMissing(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT"
  );
}

function cachedProject(cacheKey: string, cwd: string): string | undefined {
  const cached = cwdResolutionCache.get(cacheKey);
  if (!cached) return undefined;
  if (existingDirectory(cwd) !== cached.canonicalCwd) {
    cwdResolutionCache.delete(cacheKey);
    return undefined;
  }
  cwdResolutionCache.delete(cacheKey);
  cwdResolutionCache.set(cacheKey, cached);
  return cached.project;
}

function cacheProject(cacheKey: string, canonicalCwd: string, project: string): string {
  cwdResolutionCache.set(cacheKey, { canonicalCwd, project });
  if (cwdResolutionCache.size > CACHE_LIMIT) {
    const oldest = cwdResolutionCache.keys().next().value;
    if (oldest) cwdResolutionCache.delete(oldest);
  }
  return project;
}

function metadataLine(path: string): string | undefined {
  try {
    if (statSync(path).size > 4096) return undefined;
    const value = readFileSync(path, "utf8").trim();
    if (!value || value.includes("\n") || value.includes("\0")) return undefined;
    return value;
  } catch {
    return undefined;
  }
}

type GitMarker =
  | { readonly kind: "absent" }
  | { readonly kind: "invalid" }
  | { readonly kind: "valid"; readonly gitDir: string };

function gitDirectory(marker: string, checkoutRoot: string): GitMarker {
  try {
    const markerStat = statSync(marker);
    if (markerStat.isDirectory()) {
      const gitDir = existingDirectory(marker);
      return gitDir ? { kind: "valid", gitDir } : { kind: "invalid" };
    }
    if (!markerStat.isFile()) return { kind: "invalid" };
  } catch (error) {
    return isMissing(error) ? { kind: "absent" } : { kind: "invalid" };
  }

  const line = metadataLine(marker);
  const match = line?.match(/^gitdir:\s*(.+)$/);
  if (!match) return { kind: "invalid" };
  const path = match[1]!;
  const gitDir = existingDirectory(isAbsolute(path) ? path : resolve(checkoutRoot, path));
  return gitDir ? { kind: "valid", gitDir } : { kind: "invalid" };
}

function commonDirectory(gitDir: string): string | undefined {
  const marker = join(gitDir, "commondir");
  let markerStat: ReturnType<typeof statSync>;
  try {
    markerStat = statSync(marker);
  } catch (error) {
    return isMissing(error) ? gitDir : undefined;
  }
  if (!markerStat.isFile()) return undefined;

  const path = metadataLine(marker);
  if (!path) return undefined;
  return existingDirectory(isAbsolute(path) ? path : resolve(gitDir, path));
}

function cacheCommonDirectory(commonGitDir: string): string | undefined {
  const cached = commonDirectoryCache.get(commonGitDir);
  if (cached) {
    commonDirectoryCache.delete(commonGitDir);
    commonDirectoryCache.set(commonGitDir, cached);
    return cached;
  }

  if (basename(commonGitDir) !== ".git") return undefined;
  const mainRoot = existingDirectory(dirname(commonGitDir));
  if (!mainRoot) return undefined;

  commonDirectoryCache.set(commonGitDir, mainRoot);
  if (commonDirectoryCache.size > CACHE_LIMIT) {
    const oldest = commonDirectoryCache.keys().next().value;
    if (oldest) commonDirectoryCache.delete(oldest);
  }
  return mainRoot;
}

export function projectOf(cwd: string): string {
  const fallback = normalizedFallback(cwd);
  if (!cwd) return fallback;

  const cached = cachedProject(fallback, cwd);
  if (cached) return cached;

  const start = existingDirectory(cwd);
  if (!start) return fallback;

  for (let directory = start; ; directory = dirname(directory)) {
    const marker = gitDirectory(join(directory, ".git"), directory);
    if (marker.kind === "invalid") return cacheProject(fallback, start, fallback);
    if (marker.kind === "valid") {
      const commonGitDir = commonDirectory(marker.gitDir);
      if (!commonGitDir) return cacheProject(fallback, start, fallback);
      const project = cacheCommonDirectory(commonGitDir) ?? fallback;
      return cacheProject(fallback, start, project);
    }
    const parent = dirname(directory);
    if (parent === directory) return cacheProject(fallback, start, fallback);
  }
}
