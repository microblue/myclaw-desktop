import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { acquireProcessInstanceFileLock } from '@electron/main/process-instance-lock';

const tempDirs: string[] = [];

function createTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'clawx-instance-lock-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (!dir) continue;
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('process instance file lock', () => {
  it('acquires lock and writes owner pid', () => {
    const userDataDir = createTempDir();
    const lock = acquireProcessInstanceFileLock({
      userDataDir,
      lockName: 'clawx',
      pid: 12345,
    });

    const lockPath = join(userDataDir, 'clawx.instance.lock');
    expect(lock.acquired).toBe(true);
    expect(existsSync(lockPath)).toBe(true);
    expect(readFileSync(lockPath, 'utf8')).toBe('12345');

    lock.release();
    expect(existsSync(lockPath)).toBe(false);
  });

  it('rejects a second lock when owner pid is alive', () => {
    const userDataDir = createTempDir();
    const first = acquireProcessInstanceFileLock({
      userDataDir,
      lockName: 'clawx',
      pid: 2222,
      isPidAlive: () => true,
    });

    const second = acquireProcessInstanceFileLock({
      userDataDir,
      lockName: 'clawx',
      pid: 3333,
      isPidAlive: () => true,
    });

    expect(first.acquired).toBe(true);
    expect(second.acquired).toBe(false);
    expect(second.ownerPid).toBe(2222);

    first.release();
  });

  it('replaces stale lock file when owner pid is not alive', () => {
    const userDataDir = createTempDir();
    const lockPath = join(userDataDir, 'clawx.instance.lock');
    writeFileSync(lockPath, '4444', 'utf8');

    const lock = acquireProcessInstanceFileLock({
      userDataDir,
      lockName: 'clawx',
      pid: 5555,
      isPidAlive: () => false,
    });

    expect(lock.acquired).toBe(true);
    expect(readFileSync(lockPath, 'utf8')).toBe('5555');
    lock.release();
  });
});
