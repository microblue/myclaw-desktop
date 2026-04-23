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
 * the exact openclaw version via the `openclawVersion` field in
 * package.json — one MyClaw release == one openclaw version.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

interface PartialPackageJson {
  openclawVersion?: string;
  version?: string;
}

/**
 * Read the openclawVersion field from MyClaw's package.json.
 *
 * Throws if the field is missing — a MyClaw build without a pinned openclaw
 * version is a packaging bug, not a runtime condition we should paper over
 * with a fallback (which would silently skew installs across users).
 */
export function readConfiguredOpenClawVersion(appPath: string): string {
  const pkgPath = join(appPath, 'package.json');
  const pkg: PartialPackageJson = JSON.parse(readFileSync(pkgPath, 'utf8'));
  if (!pkg.openclawVersion || typeof pkg.openclawVersion !== 'string') {
    throw new Error(
      `package.json at ${pkgPath} is missing required field "openclawVersion"`,
    );
  }
  return pkg.openclawVersion;
}

/**
 * Read the installed openclaw version from a runtime directory layout:
 *   <runtimeDir>/node_modules/openclaw/package.json
 *
 * Returns null if the file is missing or can't be parsed — callers treat
 * that as "not installed" and should kick off an install.
 */
export function readInstalledOpenClawVersion(runtimeDir: string): string | null {
  const pkgPath = join(runtimeDir, 'node_modules', 'openclaw', 'package.json');
  try {
    const pkg: PartialPackageJson = JSON.parse(readFileSync(pkgPath, 'utf8'));
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
export function getOpenClawRuntimeDir(homeDir: string): string {
  return join(homeDir, '.myclaw', 'runtime');
}

/**
 * Resolve the path where the openclaw package itself lives inside the
 * runtime dir — the consumer-facing "openclaw installed at" location.
 */
export function getOpenClawRuntimePackageDir(homeDir: string): string {
  return join(getOpenClawRuntimeDir(homeDir), 'node_modules', 'openclaw');
}

/**
 * Decide whether we need to (re)install openclaw.
 *
 * True when: not installed at all, or installed version differs from the
 * pinned version.  We deliberately DON'T do semver "range" comparisons —
 * exact match only, because openclaw doesn't follow semver.
 */
export function needsReinstall(
  configuredVersion: string,
  installedVersion: string | null,
): boolean {
  return installedVersion !== configuredVersion;
}
