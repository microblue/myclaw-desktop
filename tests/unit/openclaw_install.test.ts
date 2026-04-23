import { mkdir, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const { test_root } = vi.hoisted(() => ({
  test_root: `/tmp/myclaw-openclaw-install-${Math.random().toString(36).slice(2)}`,
}));

// Helper to write a minimal package.json matching the backend-aware schema
// (available_backends.<name>.version / preinstalled_plugins) that the
// production code now expects.
async function write_pkg_json(
  dir: string,
  openclaw: { version?: unknown; preinstalled_plugins?: unknown } | undefined,
  extra: Record<string, unknown> = {},
): Promise<void> {
  const pkg: Record<string, unknown> = { name: 'myclaw-desktop', version: '1.0.0', ...extra };
  if (openclaw !== undefined) {
    pkg.default_backend = 'openclaw';
    pkg.available_backends = { openclaw };
  }
  await writeFile(join(dir, 'package.json'), JSON.stringify(pkg));
}

describe('read_configured_openclaw_version', () => {
  beforeEach(async () => {
    vi.resetModules();
    await rm(test_root, { recursive: true, force: true });
    await mkdir(test_root, { recursive: true });
  });

  afterAll(async () => {
    await rm(test_root, { recursive: true, force: true });
  });

  it('returns the version from available_backends.openclaw.version', async () => {
    await write_pkg_json(test_root, { version: '2026.4.22' });
    const { read_configured_openclaw_version } = await import('@electron/utils/openclaw_install');
    expect(read_configured_openclaw_version(test_root)).toBe('2026.4.22');
  });

  it('throws when available_backends.openclaw is absent', async () => {
    await write_pkg_json(test_root, undefined); // no available_backends at all
    const { read_configured_openclaw_version } = await import('@electron/utils/openclaw_install');
    expect(() => read_configured_openclaw_version(test_root)).toThrow(/openclaw/);
  });

  it('throws when openclaw.version is missing', async () => {
    await write_pkg_json(test_root, { preinstalled_plugins: {} });
    const { read_configured_openclaw_version } = await import('@electron/utils/openclaw_install');
    expect(() => read_configured_openclaw_version(test_root)).toThrow(/version/);
  });

  it('throws when openclaw.version is not a string', async () => {
    await write_pkg_json(test_root, { version: 123 });
    const { read_configured_openclaw_version } = await import('@electron/utils/openclaw_install');
    expect(() => read_configured_openclaw_version(test_root)).toThrow();
  });

  it('throws when package.json is absent', async () => {
    const { read_configured_openclaw_version } = await import('@electron/utils/openclaw_install');
    expect(() => read_configured_openclaw_version(test_root)).toThrow();
  });
});

describe('read_preinstalled_plugins', () => {
  beforeEach(async () => {
    vi.resetModules();
    await rm(test_root, { recursive: true, force: true });
    await mkdir(test_root, { recursive: true });
  });

  it('returns the preinstalled_plugins map scoped to openclaw backend', async () => {
    await write_pkg_json(test_root, {
      version: '2026.4.22',
      preinstalled_plugins: {
        '@wecom/wecom-openclaw-plugin': '^2026.4.3',
        '@larksuite/openclaw-lark': '2026.4.1',
      },
    });
    const { read_preinstalled_plugins } = await import('@electron/utils/openclaw_install');
    expect(read_preinstalled_plugins(test_root)).toEqual({
      '@wecom/wecom-openclaw-plugin': '^2026.4.3',
      '@larksuite/openclaw-lark': '2026.4.1',
    });
  });

  it('returns an empty object when preinstalled_plugins is absent', async () => {
    await write_pkg_json(test_root, { version: '2026.4.22' });
    const { read_preinstalled_plugins } = await import('@electron/utils/openclaw_install');
    expect(read_preinstalled_plugins(test_root)).toEqual({});
  });

  it('returns an empty object when the openclaw backend is not declared', async () => {
    await write_pkg_json(test_root, undefined);
    const { read_preinstalled_plugins } = await import('@electron/utils/openclaw_install');
    expect(read_preinstalled_plugins(test_root)).toEqual({});
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
    expect(needs_reinstall('2026.4.22', '2026.4.23')).toBe(true);
  });
});

describe('get_bundled_node_path', () => {
  it('Windows: resources/bin/node.exe', async () => {
    const { get_bundled_node_path } = await import('@electron/utils/openclaw_install');
    expect(get_bundled_node_path('/res', 'win32')).toBe('/res/bin/node.exe');
  });

  it('Linux: resources/bin/bin/node (Unix layout)', async () => {
    const { get_bundled_node_path } = await import('@electron/utils/openclaw_install');
    expect(get_bundled_node_path('/res', 'linux')).toBe('/res/bin/bin/node');
  });

  it('macOS: resources/bin/bin/node (Unix layout)', async () => {
    const { get_bundled_node_path } = await import('@electron/utils/openclaw_install');
    expect(get_bundled_node_path('/res', 'darwin')).toBe('/res/bin/bin/node');
  });
});

describe('get_bundled_npm_cli_path', () => {
  it('Windows: node_modules/npm/bin/npm-cli.js at top of bin', async () => {
    const { get_bundled_npm_cli_path } = await import('@electron/utils/openclaw_install');
    expect(get_bundled_npm_cli_path('/res', 'win32')).toBe(
      '/res/bin/node_modules/npm/bin/npm-cli.js',
    );
  });

  it('Linux: lib/node_modules/npm/bin/npm-cli.js', async () => {
    const { get_bundled_npm_cli_path } = await import('@electron/utils/openclaw_install');
    expect(get_bundled_npm_cli_path('/res', 'linux')).toBe(
      '/res/bin/lib/node_modules/npm/bin/npm-cli.js',
    );
  });

  it('macOS: lib/node_modules/npm/bin/npm-cli.js', async () => {
    const { get_bundled_npm_cli_path } = await import('@electron/utils/openclaw_install');
    expect(get_bundled_npm_cli_path('/res', 'darwin')).toBe(
      '/res/bin/lib/node_modules/npm/bin/npm-cli.js',
    );
  });
});

describe('get_openclaw_install_state', () => {
  beforeEach(async () => {
    vi.resetModules();
    await rm(test_root, { recursive: true, force: true });
    await mkdir(test_root, { recursive: true });
  });

  it('reports needs_install=true when nothing is installed', async () => {
    const app_dir = join(test_root, 'app');
    const home_dir = join(test_root, 'home');
    await mkdir(app_dir, { recursive: true });
    await mkdir(home_dir, { recursive: true });
    await write_pkg_json(app_dir, { version: '2026.4.22' });

    const { get_openclaw_install_state } = await import('@electron/utils/openclaw_install');
    const state = get_openclaw_install_state(app_dir, home_dir);

    expect(state.configured_version).toBe('2026.4.22');
    expect(state.installed_version).toBeNull();
    expect(state.runtime_dir).toBe(join(home_dir, '.myclaw', 'runtime'));
    expect(state.needs_install).toBe(true);
  });

  it('reports needs_install=false when versions match', async () => {
    const app_dir = join(test_root, 'app');
    const home_dir = join(test_root, 'home');
    await mkdir(app_dir, { recursive: true });
    await write_pkg_json(app_dir, { version: '2026.4.22' });
    const pkg_dir = join(home_dir, '.myclaw', 'runtime', 'node_modules', 'openclaw');
    await mkdir(pkg_dir, { recursive: true });
    await writeFile(join(pkg_dir, 'package.json'), JSON.stringify({ version: '2026.4.22' }));

    const { get_openclaw_install_state } = await import('@electron/utils/openclaw_install');
    const state = get_openclaw_install_state(app_dir, home_dir);

    expect(state.installed_version).toBe('2026.4.22');
    expect(state.needs_install).toBe(false);
  });
});
