import { mkdir, rm, writeFile, stat } from 'fs/promises';
import { join } from 'path';
import { beforeEach, afterAll, describe, expect, it, vi } from 'vitest';

const { testHome } = vi.hoisted(() => ({
  testHome: `/tmp/myclaw-reset-openclaw-${Math.random().toString(36).slice(2)}`,
}));

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os');
  const mocked = { ...actual, homedir: () => testHome };
  return { ...mocked, default: mocked };
});

vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => testHome, getVersion: () => '0.0.0-test' },
}));

vi.mock('@electron/utils/logger', () => ({
  logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
}));

describe('resetOpenClawData', () => {
  beforeEach(async () => {
    vi.resetModules();
    await rm(testHome, { recursive: true, force: true });
  });

  afterAll(async () => {
    await rm(testHome, { recursive: true, force: true });
  });

  it('returns ok when .openclaw does not exist (no-op)', async () => {
    const { resetOpenClawData } = await import('@electron/utils/reset-openclaw');
    const result = resetOpenClawData();
    expect(result.ok).toBe(true);
    expect(result.path).toBe(join(testHome, '.openclaw'));
  });

  it('removes .openclaw and all its contents', async () => {
    const dir = join(testHome, '.openclaw');
    await mkdir(join(dir, 'skills', 'nested'), { recursive: true });
    await writeFile(join(dir, 'openclaw.json'), '{"secret":"should-be-wiped"}');
    await writeFile(join(dir, 'skills', 'nested', 'data.txt'), 'payload');

    const { resetOpenClawData } = await import('@electron/utils/reset-openclaw');
    const result = resetOpenClawData();

    expect(result.ok).toBe(true);
    await expect(stat(dir)).rejects.toThrow(/ENOENT/);
  });

  it('leaves sibling directories under HOME untouched', async () => {
    await mkdir(join(testHome, '.myclaw'), { recursive: true });
    await writeFile(join(testHome, '.myclaw', 'preserved.txt'), 'keep me');
    await mkdir(join(testHome, '.openclaw'), { recursive: true });
    await writeFile(join(testHome, '.openclaw', 'canary.txt'), 'wipe me');

    const { resetOpenClawData } = await import('@electron/utils/reset-openclaw');
    const result = resetOpenClawData();

    expect(result.ok).toBe(true);
    await expect(stat(join(testHome, '.openclaw'))).rejects.toThrow(/ENOENT/);
    // Sibling survives
    const siblingStat = await stat(join(testHome, '.myclaw', 'preserved.txt'));
    expect(siblingStat.isFile()).toBe(true);
  });
});

describe('hasResetOpenClawFlag', () => {
  it('returns true when --reset-openclaw is present', async () => {
    const { hasResetOpenClawFlag } = await import('@electron/utils/reset-openclaw');
    expect(hasResetOpenClawFlag(['node', 'main.js', '--reset-openclaw'])).toBe(true);
    expect(hasResetOpenClawFlag(['node', 'main.js', '--other', '--reset-openclaw', '--x'])).toBe(true);
  });

  it('returns false when the flag is absent', async () => {
    const { hasResetOpenClawFlag } = await import('@electron/utils/reset-openclaw');
    expect(hasResetOpenClawFlag(['node', 'main.js'])).toBe(false);
    expect(hasResetOpenClawFlag(['node', 'main.js', '--reset'])).toBe(false);
  });
});
