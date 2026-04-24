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
import { spawn } from 'child_process';
import { mkdirSync, readFileSync } from 'fs';
import { join } from 'path';

export interface TestedCompatibleRange {
  /** Lowest openclaw version MyClaw has been exercised against. */
  min?: string;
  /** Highest openclaw version tested.  Absent = no upper bound. */
  max?: string;
}

interface BackendSpec {
  version?: string;
  tested_compatible?: TestedCompatibleRange;
  preinstalled_plugins?: Record<string, string>;
}

interface PartialPackageJson {
  version?: string;
  default_backend?: string;
  available_backends?: Record<string, BackendSpec>;
}

/**
 * Read a backend's entry from package.json's `available_backends` map.
 * Throws if the backend isn't declared — callers should know which
 * backends they are asking about (no silent fallback).
 *
 * The package.json shape:
 *   {
 *     "default_backend": "openclaw",
 *     "available_backends": {
 *       "openclaw": { "version": "...", "preinstalled_plugins": {...} },
 *       "hermes":   { "version": "...", "preinstalled_plugins": {...} },
 *     }
 *   }
 *
 * This anticipates the multi-backend / multi-instance architecture laid
 * out in ARCHITECTURE.md — today only "openclaw" is declared, but the
 * schema does not lock us in.
 */
function read_backend_spec(app_path: string, backend_name: string): BackendSpec {
  const pkg_path = join(app_path, 'package.json');
  const pkg: PartialPackageJson = JSON.parse(readFileSync(pkg_path, 'utf8'));
  const spec = pkg.available_backends?.[backend_name];
  if (!spec) {
    throw new Error(
      `package.json at ${pkg_path} does not declare backend "${backend_name}" under available_backends`,
    );
  }
  return spec;
}

/**
 * Read the `openclaw_version` field from MyClaw's package.json.
 *
 * Throws if the field is missing — a MyClaw build without a pinned openclaw
 * version is a packaging bug, not a runtime condition we should paper over
 * with a fallback (which would silently skew installs across users).
 */
export function read_configured_openclaw_version(app_path: string): string {
  const spec = read_backend_spec(app_path, 'openclaw');
  if (!spec.version || typeof spec.version !== 'string') {
    throw new Error(
      `package.json is missing required field "available_backends.openclaw.version"`,
    );
  }
  return spec.version;
}

/**
 * Read the `preinstalled_plugins` map for the openclaw backend from
 * package.json's `available_backends.openclaw.preinstalled_plugins`.
 *
 * Shape: { "<npm-package-name>": "<version-spec>", ... }
 *
 * Returns an empty object when the field is absent.  These are fetched
 * alongside openclaw during `npm install` so the "official" install
 * location (~/.myclaw/runtime/node_modules/<npm-name>/) carries them —
 * per user directive: "官方装在哪里你就去哪里读，以后没有 bundled
 * plugin 了，有预装 plugin".
 */
export function read_preinstalled_plugins(app_path: string): Record<string, string> {
  try {
    const spec = read_backend_spec(app_path, 'openclaw');
    return spec.preinstalled_plugins ?? {};
  } catch {
    return {};
  }
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
 * Parse an openclaw calendar-style version string into a comparable
 * numeric tuple.  Returns null if the input isn't well-formed.
 *
 * "2026.4.22" -> [2026, 4, 22]
 */
export function parse_calver(version: string): number[] | null {
  const parts = version.split('.').map((s) => {
    const n = Number(s);
    return Number.isFinite(n) ? n : NaN;
  });
  if (parts.some((n) => Number.isNaN(n))) return null;
  return parts;
}

/**
 * Compare two calendar-version strings.  Returns negative if a<b, zero
 * if equal, positive if a>b.  Non-parseable versions fall back to
 * string comparison as a last resort.
 */
export function compare_calver(a: string, b: string): number {
  const pa = parse_calver(a);
  const pb = parse_calver(b);
  if (!pa || !pb) return a < b ? -1 : a > b ? 1 : 0;
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x - y;
  }
  return 0;
}

/**
 * Decide whether MyClaw should (re)install openclaw.
 *
 * - null installed → yes, fresh install
 * - installed < configured → yes, user somehow downgraded / stale dir, reinstall the pin
 * - installed >= configured → NO, leave it alone (user may have manually
 *   upgraded via UI / CLI to a newer openclaw — MyClaw does not silently
 *   roll that back)
 *
 * The old "exact match" semantics from v1.5 was incorrect: it forced any
 * newer openclaw back down to the pinned version on every launch,
 * making user-controlled upgrades impossible.  Per ARCHITECTURE.md §12
 * MyClaw's job is to provide a default install and warn about out-of-
 * range versions, not to pin users.
 */
export function needs_reinstall(
  configured_version: string,
  installed_version: string | null,
): boolean {
  if (installed_version === null) return true;
  return compare_calver(installed_version, configured_version) < 0;
}

/**
 * Read the backend's tested-compatible version range from package.json.
 * Returns an empty object (no bounds) if the field is missing — callers
 * treat that as "no compatibility check configured".
 */
export function read_openclaw_tested_range(app_path: string): TestedCompatibleRange {
  try {
    const spec = read_backend_spec(app_path, 'openclaw');
    return spec.tested_compatible ?? {};
  } catch {
    return {};
  }
}

export type VersionCompatStatus =
  | { kind: 'ok' }
  | { kind: 'below_min'; installed: string; min: string }
  | { kind: 'above_max'; installed: string; max: string };

/**
 * Check an installed openclaw version against the declared tested range.
 * Returns 'ok' when the range is absent or the version falls inside.
 * Out-of-range is reported for the caller to surface as a non-blocking
 * warning (dialog / log) — we never block the app from starting.
 */
export function check_version_compat(
  installed_version: string,
  range: TestedCompatibleRange,
): VersionCompatStatus {
  if (range.min && compare_calver(installed_version, range.min) < 0) {
    return { kind: 'below_min', installed: installed_version, min: range.min };
  }
  if (range.max && compare_calver(installed_version, range.max) > 0) {
    return { kind: 'above_max', installed: installed_version, max: range.max };
  }
  return { kind: 'ok' };
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

/**
 * Ensure the MyClaw runtime (openclaw pinned to package.json's
 * openclaw_version) is installed under ~/.myclaw/runtime/.
 *
 * If nothing needs doing (already installed at the right version) it
 * returns immediately with was_installed=false.  Otherwise it spawns the
 * bundled Node + bundled npm to `npm install openclaw@<pin> --prefix
 * <runtime_dir>` and pipes stdout/stderr to `on_log` for UI consumption.
 *
 * User-facing logs should use "MyClaw runtime" phrasing (see
 * feedback_runtime_naming memory).
 */
export interface RuntimeInitOptions {
  app_path: string;
  home_dir: string;
  resources_path: string;
  platform?: NodeJS.Platform;
  on_log?: (line: string) => void;
  /** Extra npm flags for tests / special scenarios (e.g. --registry=...). */
  extra_npm_args?: string[];
}

export interface RuntimeInitResult {
  version: string;
  was_installed: boolean;
}

export async function ensure_myclaw_runtime_installed(
  options: RuntimeInitOptions,
): Promise<RuntimeInitResult> {
  const {
    app_path,
    home_dir,
    resources_path,
    platform = process.platform,
    on_log,
    extra_npm_args = [],
  } = options;

  const state = get_openclaw_install_state(app_path, home_dir);
  if (!state.needs_install) {
    return { version: state.installed_version ?? state.configured_version, was_installed: false };
  }

  const node_binary = get_bundled_node_path(resources_path, platform);
  const npm_cli = get_bundled_npm_cli_path(resources_path, platform);

  mkdirSync(state.runtime_dir, { recursive: true });

  // Install openclaw + each preinstalled plugin in a SINGLE `npm install`
  // invocation.  npm resolves them together so shared transitive deps
  // dedupe into one flat node_modules tree under <runtime>/node_modules/.
  const plugins = read_preinstalled_plugins(app_path);
  const package_specs = [
    `openclaw@${state.configured_version}`,
    ...Object.entries(plugins).map(([name, version]) => `${name}@${version}`),
  ];

  await run_npm_install({
    node_binary,
    npm_cli,
    package_specs,
    prefix: state.runtime_dir,
    on_log,
    extra_args: extra_npm_args,
  });

  // `npm install openclaw` only places the package files on disk — it does
  // NOT generate ~/.openclaw/openclaw.json.  Openclaw's own `setup`
  // subcommand is what creates the default config; without it the
  // subsequent gateway start fails with "Missing config".
  //
  // Spawn `openclaw setup --non-interactive --mode local` once per
  // install so the bootstrap step is part of our "runtime is ready"
  // contract.  Idempotent on repeat calls.
  const openclaw_entry = join(state.runtime_dir, 'node_modules', 'openclaw', 'openclaw.mjs');
  await run_openclaw_setup({
    node_binary,
    openclaw_entry,
    on_log,
  });

  return { version: state.configured_version, was_installed: true };
}

interface OpenClawSetupSpec {
  node_binary: string;
  openclaw_entry: string;
  /** Optional override for openclaw's state dir (OPENCLAW_STATE_DIR). */
  state_dir?: string;
  on_log?: (line: string) => void;
}

function run_openclaw_setup(spec: OpenClawSetupSpec): Promise<void> {
  return new Promise((resolve, reject) => {
    // openclaw's `setup --non-interactive` refuses to run without
    // explicit `--accept-risk`.  MyClaw is a dashboard; accepting the
    // non-interactive-setup risk on the user's behalf is exactly what
    // we're here for.
    const args = [
      spec.openclaw_entry,
      'setup',
      '--non-interactive',
      '--accept-risk',
      '--mode', 'local',
    ];
    const env: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: 'production' };
    if (spec.state_dir) env.OPENCLAW_STATE_DIR = spec.state_dir;

    const child = spawn(spec.node_binary, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
    });

    const pipe_lines = (chunk: Buffer) => {
      if (!spec.on_log) return;
      for (const line of chunk.toString().split(/\r?\n/)) {
        if (line.trim()) spec.on_log(`[setup] ${line}`);
      }
    };

    child.stdout?.on('data', pipe_lines);
    child.stderr?.on('data', pipe_lines);
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`openclaw setup exited with code ${code}`));
    });
  });
}

interface NpmInstallSpec {
  node_binary: string;
  npm_cli: string;
  package_specs: string[];
  prefix: string;
  on_log?: (line: string) => void;
  extra_args?: string[];
}

function run_npm_install(spec: NpmInstallSpec): Promise<void> {
  return new Promise((resolve, reject) => {
    // Flag choices:
    //   --no-save + --package-lock=false : no lockfile churn at runtime
    //   --legacy-peer-deps               : tolerate openclaw's plugin peer
    //                                      constraints (upstream doctor --fix
    //                                      uses the same)
    //   --omit=dev                       : no dev deps at runtime
    //
    // We INTENTIONALLY do NOT pass --ignore-scripts: openclaw ships a
    // postinstall that reads dist/extensions/*/package.json and installs
    // each preinstalled plugin's runtime deps (@aws-sdk for tlon,
    // @opentelemetry for diagnostics-otel, etc.).  Skipping scripts was
    // what left prior installers with 46 missing deps after
    // `openclaw doctor`.
    const args = [
      spec.npm_cli,
      'install',
      ...spec.package_specs,
      '--prefix', spec.prefix,
      '--no-save',
      '--package-lock=false',
      '--legacy-peer-deps',
      '--omit=dev',
      ...(spec.extra_args ?? []),
    ];

    const child = spawn(spec.node_binary, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, NODE_ENV: 'production' },
    });

    const pipe_lines = (chunk: Buffer) => {
      if (!spec.on_log) return;
      for (const line of chunk.toString().split(/\r?\n/)) {
        if (line.trim()) spec.on_log(line);
      }
    };

    child.stdout?.on('data', pipe_lines);
    child.stderr?.on('data', pipe_lines);
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`MyClaw runtime init exited with code ${code}`));
    });
  });
}
