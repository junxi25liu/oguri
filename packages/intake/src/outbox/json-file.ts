/**
 * Small JSON state files in intake's state directory, written atomically.
 *
 * Intake can be killed at any moment, and a half-written cursor or queue entry
 * would be read back as missing: a cursor that resets resends nothing (the
 * outbox dedupes) but rescans everything, and a lost queue entry loses a reply.
 * Every write goes to a unique temporary file and is renamed into place.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

let writes = 0;

export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  writes += 1;
  const temp = `${path}.${String(process.pid)}-${String(writes)}.tmp`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temp, path);
}

/** The parsed file, or null when it is missing or unreadable. */
export async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch {
    return null;
  }
}
