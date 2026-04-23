import { mkdir, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const { testRoot } = vi.hoisted(() => ({
  testRoot: `/tmp/myclaw-openclaw-install-${Math.random().toString(36).slice(2)}`,
}));

describe('readConfiguredOpenClawVersion', () => {
  beforeEach(async () => {
    vi.resetModules();
    await rm(testRoot, { recursive: true, force: true });
    await mkdir(testRoot, { recursive: true });
  });

  afterAll(async () => {
    await rm(testRoot, { recursive: true, force: true });
  });

  it('returns the openclawVersion field from package.json', async () => {
    await writeFile(
      join(testRoot, 'package.json'),
      JSON.stringify({ name: 'myclaw-desktop', version: '1.0.0', openclawVersion: '2026.4.12' }),
    );
    const { readConfiguredOpenClawVersion } = await import('@electron/utils/openclaw-install');
    expect(readConfiguredOpenClawVersion(testRoot)).toBe('2026.4.12');
  });

  it('throws a helpful error when openclawVersion is missing', async () => {
    await writeFile(
      join(testRoot, 'package.json'),
      JSON.stringify({ name: 'myclaw-desktop', version: '1.0.0' }),
    );
    const { readConfiguredOpenClawVersion } = await import('@electron/utils/openclaw-install');
    expect(() => readConfiguredOpenClawVersion(testRoot)).toThrow(/openclawVersion/);
  });

  it('throws when openclawVersion is not a string', async () => {
    await writeFile(
      join(testRoot, 'package.json'),
      JSON.stringify({ openclawVersion: 123 }),
    );
    const { readConfiguredOpenClawVersion } = await import('@electron/utils/openclaw-install');
    expect(() => readConfiguredOpenClawVersion(testRoot)).toThrow();
  });

  it('throws when package.json is absent', async () => {
    const { readConfiguredOpenClawVersion } = await import('@electron/utils/openclaw-install');
    expect(() => readConfiguredOpenClawVersion(testRoot)).toThrow();
  });
});

describe('readInstalledOpenClawVersion', () => {
  beforeEach(async () => {
    vi.resetModules();
    await rm(testRoot, { recursive: true, force: true });
    await mkdir(testRoot, { recursive: true });
  });

  it('returns the installed version when present', async () => {
    const pkgDir = join(testRoot, 'node_modules', 'openclaw');
    await mkdir(pkgDir, { recursive: true });
    await writeFile(join(pkgDir, 'package.json'), JSON.stringify({ version: '2026.4.8' }));
    const { readInstalledOpenClawVersion } = await import('@electron/utils/openclaw-install');
    expect(readInstalledOpenClawVersion(testRoot)).toBe('2026.4.8');
  });

  it('returns null when node_modules/openclaw is missing', async () => {
    const { readInstalledOpenClawVersion } = await import('@electron/utils/openclaw-install');
    expect(readInstalledOpenClawVersion(testRoot)).toBeNull();
  });

  it('returns null when package.json is malformed', async () => {
    const pkgDir = join(testRoot, 'node_modules', 'openclaw');
    await mkdir(pkgDir, { recursive: true });
    await writeFile(join(pkgDir, 'package.json'), 'not-json');
    const { readInstalledOpenClawVersion } = await import('@electron/utils/openclaw-install');
    expect(readInstalledOpenClawVersion(testRoot)).toBeNull();
  });

  it('returns null when version field is absent', async () => {
    const pkgDir = join(testRoot, 'node_modules', 'openclaw');
    await mkdir(pkgDir, { recursive: true });
    await writeFile(join(pkgDir, 'package.json'), JSON.stringify({ name: 'openclaw' }));
    const { readInstalledOpenClawVersion } = await import('@electron/utils/openclaw-install');
    expect(readInstalledOpenClawVersion(testRoot)).toBeNull();
  });
});

describe('getOpenClawRuntimeDir / getOpenClawRuntimePackageDir', () => {
  it('places runtime under <home>/.myclaw/runtime/', async () => {
    const { getOpenClawRuntimeDir } = await import('@electron/utils/openclaw-install');
    expect(getOpenClawRuntimeDir('/home/user')).toBe('/home/user/.myclaw/runtime');
  });

  it('package dir is node_modules/openclaw inside the runtime dir', async () => {
    const { getOpenClawRuntimePackageDir } = await import('@electron/utils/openclaw-install');
    expect(getOpenClawRuntimePackageDir('/home/user')).toBe(
      '/home/user/.myclaw/runtime/node_modules/openclaw',
    );
  });
});

describe('needsReinstall', () => {
  it('true when not installed', async () => {
    const { needsReinstall } = await import('@electron/utils/openclaw-install');
    expect(needsReinstall('2026.4.12', null)).toBe(true);
  });

  it('true when installed version differs from configured', async () => {
    const { needsReinstall } = await import('@electron/utils/openclaw-install');
    expect(needsReinstall('2026.4.12', '2026.4.5')).toBe(true);
  });

  it('false when versions match exactly', async () => {
    const { needsReinstall } = await import('@electron/utils/openclaw-install');
    expect(needsReinstall('2026.4.12', '2026.4.12')).toBe(false);
  });

  it('exact match — no semver range logic (openclaw uses calendar versioning)', async () => {
    const { needsReinstall } = await import('@electron/utils/openclaw-install');
    // 2026.4.13 is "newer" but we still want to reinstall down to 2026.4.12
    // because MyClaw has only been tested against exactly the pinned version.
    expect(needsReinstall('2026.4.12', '2026.4.13')).toBe(true);
  });
});
