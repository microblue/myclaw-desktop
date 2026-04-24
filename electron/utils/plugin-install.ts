/**
 * OpenClaw plugin install — dashboard mode.
 *
 * Per ARCHITECTURE.md §11 (MyClaw is a dashboard, not a fork) MyClaw
 * does NOT place plugin files itself.  When a plugin install is
 * required (e.g. a user clicks "Configure WeCom" in the UI), we shell
 * out to openclaw's own CLI — `openclaw plugins install <npm-spec>` —
 * and let openclaw own everything downstream: file placement, manifest
 * handling, its own node_modules tree, everything.
 *
 * This file used to contain ~550 lines of:
 *   - pnpm virtual-store BFS to replicate npm resolution
 *   - copyPluginFromNodeModules / buildCandidateSources
 *   - MANIFEST_ID_FIXES + compiled-JS patching to work around a known
 *     wecom-openclaw-plugin upstream bug
 *   - ensurePluginInstalled with retry + cross-platform copy paths
 *   - ensureAllPreinstalledPluginsInstalled bulk startup installer
 *
 * All of that was explicit fork behaviour and got deleted.  What
 * remains: the generic cp helpers (used by skill-config.ts too) and
 * four thin façades over openclaw's own plugins-install CLI.
 */
import { spawn } from 'node:child_process';
import { cpSync, copyFileSync, statSync, mkdirSync, readdirSync } from 'node:fs';
import { readdir, stat, copyFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { join } from 'node:path';
import { getOpenClawEntryPath } from './paths';
import { logger } from './logger';

function normalizeFsPathForWindows(filePath: string): string {
  if (process.platform !== 'win32') return filePath;
  if (!filePath) return filePath;
  if (filePath.startsWith('\\\\?\\')) return filePath;

  const windowsPath = filePath.replace(/\//g, '\\');
  if (!path.win32.isAbsolute(windowsPath)) return windowsPath;
  if (windowsPath.startsWith('\\\\')) {
    return `\\\\?\\UNC\\${windowsPath.slice(2)}`;
  }
  return `\\\\?\\${windowsPath}`;
}

function fsPath(filePath: string): string {
  return normalizeFsPathForWindows(filePath);
}

/**
 * Unicode-safe recursive directory copy.
 *
 * Node.js `cpSync` / `cp` crash on Windows when paths contain non-ASCII
 * characters such as Chinese (nodejs/node#54476).  On Windows we fall
 * back to a manual recursive walk using `copyFileSync` which is
 * unaffected.  Kept here because skill-config.ts reuses it.
 */
export function cpSyncSafe(src: string, dest: string): void {
  if (process.platform !== 'win32') {
    cpSync(fsPath(src), fsPath(dest), { recursive: true, dereference: true });
    return;
  }
  _copyDirSyncRecursive(fsPath(src), fsPath(dest));
}

function _copyDirSyncRecursive(src: string, dest: string): void {
  mkdirSync(dest, { recursive: true });
  const entries = readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcChild = join(src, entry.name);
    const destChild = join(dest, entry.name);
    const info = statSync(srcChild);
    if (info.isDirectory()) {
      _copyDirSyncRecursive(srcChild, destChild);
    } else {
      copyFileSync(srcChild, destChild);
    }
  }
}

/** Async variant of `cpSyncSafe`. */
export async function cpAsyncSafe(src: string, dest: string): Promise<void> {
  if (process.platform !== 'win32') {
    const { cp } = await import('node:fs/promises');
    await cp(fsPath(src), fsPath(dest), { recursive: true, dereference: true });
    return;
  }
  await _copyDirAsyncRecursive(fsPath(src), fsPath(dest));
}

async function _copyDirAsyncRecursive(src: string, dest: string): Promise<void> {
  await mkdir(dest, { recursive: true });
  const entries = await readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcChild = join(src, entry.name);
    const destChild = join(dest, entry.name);
    const info = await stat(srcChild);
    if (info.isDirectory()) {
      await _copyDirAsyncRecursive(srcChild, destChild);
    } else {
      await copyFile(srcChild, destChild);
    }
  }
}

// ── Plugin install via openclaw CLI delegation ──────────────────────────────

export interface PluginInstallResult {
  installed: boolean;
  warning?: string;
}

/**
 * Spawn `openclaw plugins install <npm-spec>` and resolve with the
 * exit result.  We run openclaw via Electron-as-Node (the same
 * process.execPath the Gateway uses) so the CLI executes in the same
 * runtime environment MyClaw already talks to.
 *
 * openclaw owns the install outcome: where the plugin files land, any
 * manifest normalisation, dependency resolution.  MyClaw just logs the
 * stdout/stderr for diagnostics.
 */
function invokeOpenClawPluginsInstall(
  npmSpec: string,
  label: string,
): Promise<PluginInstallResult> {
  const entry = getOpenClawEntryPath();
  return new Promise((resolve) => {
    let stderr = '';
    const child = spawn(
      process.execPath,
      [entry, 'plugins', 'install', npmSpec],
      {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    child.stdout?.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString().split(/\r?\n/)) {
        if (line.trim()) logger.info(`[plugin:${label}] ${line}`);
      }
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      stderr += text;
      for (const line of text.split(/\r?\n/)) {
        if (line.trim()) logger.warn(`[plugin:${label}] ${line}`);
      }
    });
    child.on('error', (err) => {
      resolve({
        installed: false,
        warning: `Failed to spawn \`openclaw plugins install\`: ${err.message}`,
      });
    });
    child.on('exit', (code) => {
      if (code === 0) {
        resolve({ installed: true });
        return;
      }
      const tail = stderr.trim().slice(-400);
      resolve({
        installed: false,
        warning: `\`openclaw plugins install ${npmSpec}\` exited with code ${code ?? '?'}${tail ? `. ${tail}` : ''}`,
      });
    });
  });
}

export function ensureWeComPluginInstalled(): Promise<PluginInstallResult> {
  return invokeOpenClawPluginsInstall('@wecom/wecom-openclaw-plugin', 'WeCom');
}

export function ensureFeishuPluginInstalled(): Promise<PluginInstallResult> {
  return invokeOpenClawPluginsInstall('@larksuite/openclaw-lark', 'Feishu');
}

export function ensureQQBotPluginInstalled(): Promise<PluginInstallResult> {
  return invokeOpenClawPluginsInstall('@tencent-connect/openclaw-qqbot', 'QQ Bot');
}

export function ensureWeChatPluginInstalled(): Promise<PluginInstallResult> {
  return invokeOpenClawPluginsInstall('@tencent-weixin/openclaw-weixin', 'WeChat');
}
