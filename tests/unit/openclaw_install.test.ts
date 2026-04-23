import { mkdir, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const { test_root } = vi.hoisted(() => ({
  test_root: `/tmp/myclaw-openclaw-install-${Math.random().toString(36).slice(2)}`,
}));

describe('read_configured_openclaw_version', () => {
  beforeEach(async () => {
    vi.resetModules();
    await rm(test_root, { recursive: true, force: true });
    await mkdir(test_root, { recursive: true });
  });

  afterAll(async () => {
    await rm(test_root, { recursive: true, force: true });
  });

  it('returns the openclaw_version field from package.json', async () => {
    await writeFile(
      join(test_root, 'package.json'),
      JSON.stringify({ name: 'myclaw-desktop', version: '1.0.0', openclaw_version: '2026.4.22' }),
    );
    const { read_configured_openclaw_version } = await import('@electron/utils/openclaw_install');
    expect(read_configured_openclaw_version(test_root)).toBe('2026.4.22');
  });

  it('throws a helpful error when openclaw_version is missing', async () => {
    await writeFile(
      join(test_root, 'package.json'),
      JSON.stringify({ name: 'myclaw-desktop', version: '1.0.0' }),
    );
    const { read_configured_openclaw_version } = await import('@electron/utils/openclaw_install');
    expect(() => read_configured_openclaw_version(test_root)).toThrow(/openclaw_version/);
  });

  it('throws when openclaw_version is not a string', async () => {
    await writeFile(
      join(test_root, 'package.json'),
      JSON.stringify({ openclaw_version: 123 }),
    );
    const { read_configured_openclaw_version } = await import('@electron/utils/openclaw_install');
    expect(() => read_configured_openclaw_version(test_root)).toThrow();
  });

  it('throws when package.json is absent', async () => {
    const { read_configured_openclaw_version } = await import('@electron/utils/openclaw_install');
    expect(() => read_configured_openclaw_version(test_root)).toThrow();
  });
});

describe('read_installed_openclaw_version', () => {
  beforeEach(async () => {
    vi.resetModules();
    await rm(test_root, { recursive: true, force: true });
    await mkdir(test_root, { recursive: true });
  });

  it('returns the installed version when present', async () => {
    const pkg_dir = join(test_root, 'node_modules', 'openclaw');
    await mkdir(pkg_dir, { recursive: true });
    await writeFile(join(pkg_dir, 'package.json'), JSON.stringify({ version: '2026.4.22' }));
    const { read_installed_openclaw_version } = await import('@electron/utils/openclaw_install');
    expect(read_installed_openclaw_version(test_root)).toBe('2026.4.22');
  });

  it('returns null when node_modules/openclaw is missing', async () => {
    const { read_installed_openclaw_version } = await import('@electron/utils/openclaw_install');
    expect(read_installed_openclaw_version(test_root)).toBeNull();
  });

  it('returns null when package.json is malformed', async () => {
    const pkg_dir = join(test_root, 'node_modules', 'openclaw');
    await mkdir(pkg_dir, { recursive: true });
    await writeFile(join(pkg_dir, 'package.json'), 'not-json');
    const { read_installed_openclaw_version } = await import('@electron/utils/openclaw_install');
    expect(read_installed_openclaw_version(test_root)).toBeNull();
  });

  it('returns null when version field is absent', async () => {
    const pkg_dir = join(test_root, 'node_modules', 'openclaw');
    await mkdir(pkg_dir, { recursive: true });
    await writeFile(join(pkg_dir, 'package.json'), JSON.stringify({ name: 'openclaw' }));
    const { read_installed_openclaw_version } = await import('@electron/utils/openclaw_install');
    expect(read_installed_openclaw_version(test_root)).toBeNull();
  });
});

describe('get_openclaw_runtime_dir / get_openclaw_runtime_package_dir', () => {
  it('places runtime under <home>/.myclaw/runtime/', async () => {
    const { get_openclaw_runtime_dir } = await import('@electron/utils/openclaw_install');
    expect(get_openclaw_runtime_dir('/home/user')).toBe('/home/user/.myclaw/runtime');
  });

  it('package dir is node_modules/openclaw inside the runtime dir', async () => {
    const { get_openclaw_runtime_package_dir } = await import('@electron/utils/openclaw_install');
    expect(get_openclaw_runtime_package_dir('/home/user')).toBe(
      '/home/user/.myclaw/runtime/node_modules/openclaw',
    );
  });
});

describe('needs_reinstall', () => {
  it('true when not installed', async () => {
    const { needs_reinstall } = await import('@electron/utils/openclaw_install');
    expect(needs_reinstall('2026.4.22', null)).toBe(true);
  });

  it('true when installed version differs from configured', async () => {
    const { needs_reinstall } = await import('@electron/utils/openclaw_install');
    expect(needs_reinstall('2026.4.22', '2026.4.5')).toBe(true);
  });

  it('false when versions match exactly', async () => {
    const { needs_reinstall } = await import('@electron/utils/openclaw_install');
    expect(needs_reinstall('2026.4.22', '2026.4.22')).toBe(false);
  });

  it('exact match — no semver range logic (openclaw uses calendar versioning)', async () => {
    const { needs_reinstall } = await import('@electron/utils/openclaw_install');
    // 2026.4.23 is "newer" but we still want to reinstall down to 2026.4.22
    // because MyClaw has only been tested against exactly the pinned version.
    expect(needs_reinstall('2026.4.22', '2026.4.23')).toBe(true);
  });
});
