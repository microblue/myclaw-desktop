/**
 * OpenClaw runtime install: detection + path resolution.
 *
 * MyClaw ships WITHOUT a bundled openclaw package — instead, on first launch
 * the main process runs `npm install openclaw@<configured>` into a per-user
 * runtime directory (~/.myclaw/runtime/).  This file contains the pure
 * functions used to decide whether an install is needed; the actual spawn
 * logic lives in a later commit.
 *
 * Pinning rationale: openclaw does not promise SemVer (calendar versioning:
 * 2026.4.x).  Letting users auto-upgrade would silently break the MyClaw UI
 * whenever openclaw changes its HTTP/config/CLI contract.  So MyClaw pins
 * the exact openclaw version via the `openclaw_version` field in
 * package.json — one MyClaw release == one openclaw version.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

interface PartialPackageJson {
  openclaw_version?: string;
  version?: string;
}

/**
 * Read the `openclaw_version` field from MyClaw's package.json.
 *
 * Throws if the field is missing — a MyClaw build without a pinned openclaw
 * version is a packaging bug, not a runtime condition we should paper over
 * with a fallback (which would silently skew installs across users).
 */
export function read_configured_openclaw_version(app_path: string): string {
  const pkg_path = join(app_path, 'package.json');
  const pkg: PartialPackageJson = JSON.parse(readFileSync(pkg_path, 'utf8'));
  if (!pkg.openclaw_version || typeof pkg.openclaw_version !== 'string') {
    throw new Error(
      `package.json at ${pkg_path} is missing required field "openclaw_version"`,
    );
  }
  return pkg.openclaw_version;
}

/**
 * Read the installed openclaw version from a runtime directory layout:
 *   <runtime_dir>/node_modules/openclaw/package.json
 *
 * Returns null if the file is missing or can't be parsed — callers treat
 * that as "not installed" and should kick off an install.
 */
export function read_installed_openclaw_version(runtime_dir: string): string | null {
  const pkg_path = join(runtime_dir, 'node_modules', 'openclaw', 'package.json');
  try {
    const pkg: PartialPackageJson = JSON.parse(readFileSync(pkg_path, 'utf8'));
    return typeof pkg.version === 'string' ? pkg.version : null;
  } catch {
    return null;
  }
}

/**
 * Resolve the per-user runtime directory: <home>/.myclaw/runtime/
 *
 * npm installs here via `--prefix`, producing standard node_modules layout.
 */
export function get_openclaw_runtime_dir(home_dir: string): string {
  return join(home_dir, '.myclaw', 'runtime');
}

/**
 * Resolve the path where the openclaw package itself lives inside the
 * runtime dir — the consumer-facing "openclaw installed at" location.
 */
export function get_openclaw_runtime_package_dir(home_dir: string): string {
  return join(get_openclaw_runtime_dir(home_dir), 'node_modules', 'openclaw');
}

/**
 * Decide whether we need to (re)install openclaw.
 *
 * True when: not installed at all, or installed version differs from the
 * pinned version.  We deliberately DON'T do semver "range" comparisons —
 * exact match only, because openclaw doesn't follow semver.
 */
export function needs_reinstall(
  configured_version: string,
  installed_version: string | null,
): boolean {
  return installed_version !== configured_version;
}

/**
 * Observational snapshot of the runtime-install situation at process start.
 * Callers log this for diagnostics and (in a later commit) branch on
 * needs_install to kick off the actual npm install.
 */
export interface OpenClawInstallState {
  configured_version: string;
  installed_version: string | null;
  runtime_dir: string;
  needs_install: boolean;
}

export function get_openclaw_install_state(
  app_path: string,
  home_dir: string,
): OpenClawInstallState {
  const configured_version = read_configured_openclaw_version(app_path);
  const runtime_dir = get_openclaw_runtime_dir(home_dir);
  const installed_version = read_installed_openclaw_version(runtime_dir);
  return {
    configured_version,
    installed_version,
    runtime_dir,
    needs_install: needs_reinstall(configured_version, installed_version),
  };
}

/**
 * Absolute path to the bundled Node binary shipped in the packaged
 * app's resources/bin/ directory.
 *
 * electron-builder flattens `resources/bin/<plat>-<arch>/` to
 * `resources/bin/` at package time (see electron-builder.yml), so at
 * runtime the layout matches the top level of a Node distribution zip.
 * Windows keeps node.exe at the root; Linux/macOS follow the Unix
 * convention of bin/node.
 */
export function get_bundled_node_path(
  resources_path: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const bin_dir = join(resources_path, 'bin');
  if (platform === 'win32') {
    return join(bin_dir, 'node.exe');
  }
  return join(bin_dir, 'bin', 'node');
}

/**
 * Absolute path to the bundled npm-cli.js, which we spawn as
 *   <bundled_node> <bundled_npm_cli> install openclaw@<pin> ...
 *
 * Windows Node zips place npm under `node_modules/npm/` at the top
 * level; Linux/macOS tarballs place it under `lib/node_modules/npm/`.
 */
export function get_bundled_npm_cli_path(
  resources_path: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const bin_dir = join(resources_path, 'bin');
  if (platform === 'win32') {
    return join(bin_dir, 'node_modules', 'npm', 'bin', 'npm-cli.js');
  }
  return join(bin_dir, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js');
}
