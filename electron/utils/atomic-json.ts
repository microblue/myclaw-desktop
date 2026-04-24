/**
 * Atomic JSON file I/O helpers.
 *
 * The previous codebase spread `writeFile(path, JSON.stringify(...))`
 * across multiple files, which is NOT atomic — a crash mid-write
 * corrupts the target JSON.  For openclaw.json especially, a corrupt
 * file means the user's next openclaw start fails.
 *
 * This module is the one place that writes JSON safely:
 *   1. Serialize into a sibling temp file (same filesystem as target)
 *   2. Rename temp → target (atomic on both POSIX and NTFS / ReFS)
 *   3. Clean up the temp file on any error path
 *
 * Usage: replace any `writeFile(p, JSON.stringify(obj))` with
 *        `write_atomic_json(p, obj)`.
 */
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/** Read + parse a JSON file.  Returns null if missing or malformed. */
export async function read_json_file<T>(filePath: string): Promise<T | null> {
  try {
    const raw = await readFile(filePath, 'utf-8');
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/**
 * Atomically write `data` as pretty-printed JSON to `filePath`.
 *
 * The temp file name is scoped by pid + random suffix so concurrent
 * writers (which should be serialised by the config mutex anyway, but
 * belt-and-suspenders) cannot collide.
 */
export async function write_atomic_json(filePath: string, data: unknown): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
  try {
    await writeFile(tmpPath, JSON.stringify(data, null, 2), 'utf-8');
    await rename(tmpPath, filePath);
  } catch (err) {
    await unlink(tmpPath).catch(() => { /* temp already gone — fine */ });
    throw err;
  }
}
