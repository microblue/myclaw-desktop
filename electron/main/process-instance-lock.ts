import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface ProcessInstanceFileLock {
  acquired: boolean;
  lockPath: string;
  ownerPid?: number;
  release: () => void;
}

export interface ProcessInstanceFileLockOptions {
  userDataDir: string;
  lockName: string;
  pid?: number;
  isPidAlive?: (pid: number) => boolean;
}

function defaultPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const errno = (error as NodeJS.ErrnoException).code;
    return errno !== 'ESRCH';
  }
}

function readLockOwnerPid(lockPath: string): number | undefined {
  try {
    const raw = readFileSync(lockPath, 'utf8').trim();
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export function acquireProcessInstanceFileLock(
  options: ProcessInstanceFileLockOptions,
): ProcessInstanceFileLock {
  const pid = options.pid ?? process.pid;
  const isPidAlive = options.isPidAlive ?? defaultPidAlive;

  mkdirSync(options.userDataDir, { recursive: true });
  const lockPath = join(options.userDataDir, `${options.lockName}.instance.lock`);

  let ownerPid: number | undefined;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = openSync(lockPath, 'wx');
      try {
        writeFileSync(fd, String(pid), 'utf8');
      } finally {
        closeSync(fd);
      }

      let released = false;
      return {
        acquired: true,
        lockPath,
        release: () => {
          if (released) return;
          released = true;
          try {
            rmSync(lockPath, { force: true });
          } catch {
            // best-effort
          }
        },
      };
    } catch (error) {
      const errno = (error as NodeJS.ErrnoException).code;
      if (errno !== 'EEXIST') {
        break;
      }

      ownerPid = readLockOwnerPid(lockPath);
      const shouldTreatAsStale =
        ownerPid === undefined || !isPidAlive(ownerPid);
      if (shouldTreatAsStale && existsSync(lockPath)) {
        try {
          rmSync(lockPath, { force: true });
          continue;
        } catch {
          // If deletion fails, treat as held lock.
        }
      }

      break;
    }
  }

  return {
    acquired: false,
    lockPath,
    ownerPid,
    release: () => {
      // no-op when lock wasn't acquired
    },
  };
}
