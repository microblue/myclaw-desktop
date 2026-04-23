import { existsSync, rmSync } from 'fs';
import { logger } from './logger';
import { getOpenClawConfigDir } from './paths';

export interface ResetResult {
  ok: boolean;
  path: string;
  error?: string;
}

export function resetOpenClawData(): ResetResult {
  const dir = getOpenClawConfigDir();
  if (!existsSync(dir)) {
    logger.info(`[reset-openclaw] ${dir} does not exist — nothing to do`);
    return { ok: true, path: dir };
  }
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
    logger.info(`[reset-openclaw] removed ${dir}`);
    return { ok: true, path: dir };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(`[reset-openclaw] failed to remove ${dir}: ${msg}`);
    return { ok: false, path: dir, error: msg };
  }
}

export function hasResetOpenClawFlag(argv: string[] = process.argv): boolean {
  return argv.includes('--reset-openclaw');
}
