import { homedir } from "node:os";
import { join, resolve } from "node:path";

export function resolveDataRoot(explicit = process.env.CHATLOG_DATA_ROOT): string {
  const dataHome = process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share");
  return resolve(explicit ?? join(dataHome, "chatlog"));
}
