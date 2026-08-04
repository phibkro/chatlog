import { lstatSync, opendirSync, realpathSync, statSync, type Dir, type Dirent } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { projectOf } from "./project-identity";

export type PluginDataRootErrorCode =
  | "workspace-unavailable"
  | "root-unavailable"
  | "authority-unreadable"
  | "broken-symlink"
  | "symlink-escape"
  | "workspace-contained"
  | "repository-contained";

export interface PluginDataRootError {
  readonly code: PluginDataRootErrorCode;
  readonly message: string;
}

export type PluginDataRootResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: PluginDataRootError };
export const PLUGIN_DATA_ROOT_MAX_AUTHORITY_DEPTH = 32;
export const PLUGIN_DATA_ROOT_MAX_AUTHORITY_ENTRIES = 100_000;

function fail<T>(code: PluginDataRootErrorCode, message: string): PluginDataRootResult<T> {
  return { ok: false, error: { code, message } };
}

function defaultDataRoot(): string {
  const dataHome = process.env.XDG_DATA_HOME?.trim() || join(homedir(), ".local", "share");
  return join(dataHome, "chatlog");
}

export function resolveDataRoot(explicit = process.env.CHATLOG_DATA_ROOT): string {
  const configured = explicit?.trim();
  return resolve(configured || defaultDataRoot());
}

function pathWithin(path: string, parent: string): boolean {
  const child = relative(parent, path);
  return child === "" || (!child.startsWith(`..${sep}`) && child !== ".." && !isAbsolute(child));
}

function canonicalOrAbsolute(path: string): string {
  const absolute = resolve(path);
  try {
    return realpathSync(absolute);
  } catch {
    return absolute;
  }
}

function existingCanonicalDirectory(path: string, label: string): PluginDataRootResult<string> {
  const absolute = resolve(path);
  try {
    const canonical = realpathSync(absolute);
    if (!statSync(canonical).isDirectory())
      return fail(
        "root-unavailable",
        `${label} "${absolute}" is not an existing directory (not a directory). Set CHATLOG_DATA_ROOT to an operator-owned Chatlog data root outside the active repository.`,
      );
    return { ok: true, value: canonical };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return fail(
      "root-unavailable",
      `${label} "${absolute}" is not an existing directory (${detail}). Set CHATLOG_DATA_ROOT to an operator-owned Chatlog data root outside the active repository.`,
    );
  }
}

function assertContainedSymlinkPaths(root: string): PluginDataRootResult<void> {
  const pending = ["analysis", "corpus", "derived", "memory", "receipts"].map((name) => ({
    path: join(root, name),
    depth: 0,
  }));
  const visitedDirectories = new Set<string>();
  let visitedEntries = 0;
  while (pending.length > 0) {
    const current = pending.pop()!;
    const path = current.path;
    try {
      lstatSync(path);
    } catch (error) {
      const code =
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        typeof error.code === "string"
          ? error.code
          : undefined;
      if (code === "ENOENT") continue;
      return fail(
        "authority-unreadable",
        `Cannot inspect Chatlog authority path "${path}". Set CHATLOG_DATA_ROOT to an operator-owned root with readable authority and corpus paths.`,
      );
    }

    let canonical: string;
    let isDirectory: boolean;
    try {
      canonical = realpathSync(path);
      isDirectory = statSync(canonical).isDirectory();
    } catch {
      return fail(
        "broken-symlink",
        `Chatlog authority path "${path}" is a broken or unresolved symlink. Repair it or set CHATLOG_DATA_ROOT to an operator-owned root with local authority and corpus data.`,
      );
    }
    if (!pathWithin(canonical, root)) {
      return fail(
        "symlink-escape",
        `Chatlog authority path "${path}" resolves outside the selected data root. Refusing symlink escape; set CHATLOG_DATA_ROOT to an operator-owned root with local authority and corpus data.`,
      );
    }
    if (!isDirectory) continue;
    if (current.depth > PLUGIN_DATA_ROOT_MAX_AUTHORITY_DEPTH)
      return fail(
        "authority-unreadable",
        `Chatlog authority path "${path}" exceeds the ${PLUGIN_DATA_ROOT_MAX_AUTHORITY_DEPTH}-directory depth limit. Set CHATLOG_DATA_ROOT to an operator-owned root with bounded authority and corpus paths.`,
      );
    if (visitedDirectories.has(canonical)) continue;
    visitedDirectories.add(canonical);

    let directory: Dir;
    try {
      directory = opendirSync(canonical);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return fail(
        "authority-unreadable",
        `Cannot inspect Chatlog authority path "${path}" (${detail}). Set CHATLOG_DATA_ROOT to an operator-owned root with readable authority and corpus paths.`,
      );
    }
    try {
      let entry: Dirent | null;
      while ((entry = directory.readSync()) !== null) {
        visitedEntries += 1;
        if (visitedEntries > PLUGIN_DATA_ROOT_MAX_AUTHORITY_ENTRIES)
          return fail(
            "authority-unreadable",
            `Chatlog authority path "${path}" exceeds the ${PLUGIN_DATA_ROOT_MAX_AUTHORITY_ENTRIES}-entry limit. Set CHATLOG_DATA_ROOT to an operator-owned root with bounded authority and corpus paths.`,
          );
        pending.push({ path: join(canonical, entry.name), depth: current.depth + 1 });
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return fail(
        "authority-unreadable",
        `Cannot inspect Chatlog authority path "${path}" (${detail}). Set CHATLOG_DATA_ROOT to an operator-owned root with readable authority and corpus paths.`,
      );
    } finally {
      try {
        directory.closeSync();
      } catch {
        // The runtime may already close the directory after readSync() reaches EOF.
      }
    }
  }
  return { ok: true, value: undefined };
}

export function resolvePluginDataRoot(
  activeWorkspace: string,
  explicit = process.env.CHATLOG_DATA_ROOT,
): PluginDataRootResult<string> {
  if (!activeWorkspace.trim())
    return fail(
      "workspace-unavailable",
      "The active workspace is unavailable, so Chatlog cannot establish a safe plugin data root. Set CHATLOG_DATA_ROOT to an existing operator-owned root outside repositories.",
    );

  const selected = explicit?.trim() ? resolve(explicit.trim()) : resolveDataRoot();
  const lexicalRoot = resolve(selected);
  const existingRoot = existingCanonicalDirectory(lexicalRoot, "Chatlog data root");
  if (!existingRoot.ok) return existingRoot;
  const root = existingRoot.value;
  const workspace = canonicalOrAbsolute(activeWorkspace);
  const projectIdentity = projectOf(activeWorkspace);
  const project = canonicalOrAbsolute(projectIdentity);
  const workspacePaths = [resolve(activeWorkspace), workspace];
  const rootPaths = [lexicalRoot, root];
  const overlaps = (left: readonly string[], right: readonly string[]): boolean =>
    left.some((path) =>
      right.some((candidate) => pathWithin(path, candidate) || pathWithin(candidate, path)),
    );
  if (overlaps(workspacePaths, rootPaths)) {
    return fail(
      "workspace-contained",
      `Chatlog data root "${lexicalRoot}" is inside the active workspace "${workspace}" or contains it. Refusing repository-controlled plugin memory; set CHATLOG_DATA_ROOT to an operator-owned root outside the repository.`,
    );
  }
  if (isAbsolute(projectIdentity)) {
    const repositoryPaths = [resolve(projectIdentity), project];
    if (overlaps(repositoryPaths, rootPaths)) {
      return fail(
        "repository-contained",
        `Chatlog data root "${lexicalRoot}" is repository-contained, contains the active repository, or is symlinked through an untrusted path. Set CHATLOG_DATA_ROOT to an operator-owned root outside the active repository.`,
      );
    }
  }

  const containedPaths = assertContainedSymlinkPaths(root);
  if (!containedPaths.ok) return containedPaths;
  return { ok: true, value: root };
}
