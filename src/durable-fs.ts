import { randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  open,
  readFile,
  rename,
  stat,
  unlink,
} from "node:fs/promises";
import { dirname } from "node:path";

export async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function createDirectoryDurably(path: string): Promise<void> {
  try {
    await mkdir(path, { mode: 0o700 });
    await syncDirectory(dirname(path));
  } catch (error: any) {
    if (error?.code === "EEXIST") {
      if ((await stat(path)).isDirectory()) return;
      throw new Error(`${path}: expected a directory`, { cause: error });
    }
    if (error?.code !== "ENOENT") throw error;
    await createDirectoryDurably(dirname(path));
    await createDirectoryDurably(path);
  }
}

export async function ensurePrivateDirectory(path: string): Promise<void> {
  await createDirectoryDurably(path);
  await chmod(path, 0o700);
}

export async function durableAtomicWrite(
  path: string,
  data: string,
  options: { mode?: number; maxBytes?: number } = {},
): Promise<void> {
  const bytes = Buffer.byteLength(data);
  if (options.maxBytes != null && bytes > options.maxBytes)
    throw new Error(`${path}: content exceeds ${options.maxBytes} bytes`);
  const directory = dirname(path);
  await ensurePrivateDirectory(directory);
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", options.mode ?? 0o600);
  let renamed = false;
  try {
    await handle.writeFile(data);
    await handle.sync();
    await handle.close();
    await rename(temporary, path);
    renamed = true;
    await syncDirectory(directory);
  } finally {
    try {
      await handle.close();
    } catch {}
    if (!renamed) {
      try {
        await unlink(temporary);
      } catch {}
    }
  }
}

export async function durableUnlink(path: string): Promise<void> {
  try {
    await unlink(path);
    await syncDirectory(dirname(path));
  } catch (error: any) {
    if (error?.code !== "ENOENT") throw error;
  }
}

export async function readBoundedText(
  path: string,
  maximumBytes: number,
  label: string,
): Promise<string> {
  const info = await stat(path);
  if (info.size > maximumBytes)
    throw new Error(`${path}: ${label} exceeds size bound`);
  return readFile(path, "utf8");
}
