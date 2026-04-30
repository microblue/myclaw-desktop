/**
 * OpenClaw auth runner — dashboard-pure OAuth flow.
 *
 * Per ARCHITECTURE.md (MyClaw is a dashboard, not a fork) and the
 * product directive that MyClaw should not re-implement what openclaw
 * already does, all OAuth / API-key login flows are delegated to
 * `openclaw models auth login --provider <id>`.  MyClaw spawns the
 * subprocess via utilityProcess.fork (re-using Electron's bundled node
 * so we never need a global Node install on the user's machine),
 * streams stdout/stderr to a callback so the UI can show progress, and
 * surfaces the exit code as success/failure.
 *
 * What MyClaw does NOT do anymore:
 *   - hold an OAuth client_id / client_secret
 *   - run a local callback HTTP server
 *   - grep `oauth2.js` for credentials
 *   - write `auth-profiles.json`
 *
 * All of that lives in openclaw.  We just trigger it.
 */
import { app, utilityProcess, type UtilityProcess } from 'electron';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { getOpenClawDir, getOpenClawEntryPath, getResourcesDir } from './paths';
import { logger } from './logger';
import { getUvMirrorEnv } from './uv-env';

const AUTH_FLOW_TIMEOUT_MS = 10 * 60 * 1000; // 10 min: browser flows are user-paced
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;

export interface OpenClawAuthOptions {
  /** Openclaw provider id, e.g. "google-gemini-cli", "openai", "anthropic". */
  provider: string;
  /** Optional auth method id (passed via --method). */
  method?: string;
  /** Apply the provider's default model recommendation after login. */
  setDefault?: boolean;
  /** Stream callback: invoked once per stdout/stderr chunk for UI logs. */
  onLog?: (line: string, stream: 'stdout' | 'stderr') => void;
}

export interface OpenClawAuthResult {
  success: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  command: string;
  cwd: string;
  durationMs: number;
  timedOut?: boolean;
  error?: string;
}

interface RunningAuthFlow {
  child: UtilityProcess;
  abort: AbortController;
}

let activeFlow: RunningAuthFlow | null = null;

function getBundledBinPath(): string {
  const target = `${process.platform}-${process.arch}`;
  return app.isPackaged
    ? path.join(process.resourcesPath, 'bin')
    : path.join(process.cwd(), 'resources', 'bin', target);
}

function appendBounded(
  current: string,
  bytes: number,
  data: Buffer | string,
  truncated: boolean,
): { output: string; bytes: number; truncated: boolean } {
  if (truncated) return { output: current, bytes, truncated };
  const chunk = typeof data === 'string' ? Buffer.from(data) : data;
  if (bytes + chunk.length <= MAX_OUTPUT_BYTES) {
    return { output: current + chunk.toString(), bytes: bytes + chunk.length, truncated: false };
  }
  const remaining = Math.max(0, MAX_OUTPUT_BYTES - bytes);
  const tail = remaining > 0 ? chunk.subarray(0, remaining).toString() : '';
  return { output: current + tail, bytes: MAX_OUTPUT_BYTES, truncated: true };
}

/**
 * Run `openclaw models auth login --provider <id>`.  Returns when the
 * subprocess exits.  Concurrent calls cancel the previous flow first.
 */
export async function runOpenClawAuthLogin(
  options: OpenClawAuthOptions,
): Promise<OpenClawAuthResult> {
  if (activeFlow) {
    await cancelOpenClawAuth();
  }

  const args = ['models', 'auth', 'login', '--provider', options.provider];
  if (options.method) args.push('--method', options.method);
  if (options.setDefault) args.push('--set-default');

  return runOpenClawCli(args, options.onLog);
}

/**
 * Cancel the currently running auth flow, if any.  Resolves once the
 * subprocess has exited (or after 5s as a safety bound).
 */
export async function cancelOpenClawAuth(): Promise<void> {
  const flow = activeFlow;
  if (!flow) return;
  try {
    flow.abort.abort();
    flow.child.kill();
  } catch (err) {
    logger.warn('cancelOpenClawAuth: kill failed', err);
  }
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, 5000);
    flow.child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
  activeFlow = null;
}

/**
 * Internal: spawn openclaw via utilityProcess.fork with the bundled-bin
 * PATH augmentation so subprocess lookups (`gemini`, `npm`, `tar`) all
 * resolve.  Returns the structured result.
 */
async function runOpenClawCli(
  args: string[],
  onLog?: (line: string, stream: 'stdout' | 'stderr') => void,
): Promise<OpenClawAuthResult> {
  const openclawDir = getOpenClawDir();
  const entryScript = getOpenClawEntryPath();
  const command = `openclaw ${args.join(' ')}`;
  const startedAt = Date.now();

  if (!existsSync(entryScript)) {
    const error = `OpenClaw entry script not found at ${entryScript}`;
    logger.error(`Cannot run openclaw auth flow: ${error}`);
    return {
      success: false,
      exitCode: null,
      stdout: '',
      stderr: '',
      command,
      cwd: openclawDir,
      durationMs: Date.now() - startedAt,
      error,
    };
  }

  // openclaw 2026.4.x's `models auth login` rejects non-interactive
  // invocation with `Error: models auth login requires an interactive
  // TTY.`  We fork via utilityProcess with stdio:'pipe', so isTTY is
  // false and we always trip that guard before the OAuth flow runs.
  // The actual provider OAuth flow (openUrl callback + localhost
  // listener) does not need a real TTY — see resources/openclaw-tty-shim.mjs
  // header for the full reasoning.  Spawn the shim, which spoofs
  // isTTY=true on stdin/stdout/stderr and dynamic-imports openclaw.mjs.
  const ttyShim = path.join(getResourcesDir(), 'openclaw-tty-shim.mjs');
  const useShim = existsSync(ttyShim);
  if (!useShim) {
    logger.warn(
      `[auth-runner] tty shim not found at ${ttyShim} — spawning openclaw.mjs directly; ` +
      'auth login may fail with "requires an interactive TTY".',
    );
  }
  const forkTarget = useShim ? ttyShim : entryScript;

  const binPath = getBundledBinPath();
  const binPathExists = existsSync(binPath);
  const finalPath = binPathExists
    ? `${binPath}${path.delimiter}${process.env.PATH || ''}`
    : process.env.PATH || '';
  const uvEnv = await getUvMirrorEnv();

  logger.info(
    `[auth-runner] Spawning ${command} in ${openclawDir}` +
    (useShim ? ' (via tty shim)' : ''),
  );

  return await new Promise<OpenClawAuthResult>((resolve) => {
    const abort = new AbortController();
    const child = utilityProcess.fork(forkTarget, args, {
      cwd: openclawDir,
      stdio: 'pipe',
      env: {
        ...process.env,
        ...uvEnv,
        PATH: finalPath,
        OPENCLAW_NO_RESPAWN: '1',
        OPENCLAW_EMBEDDED_IN: 'MyClaw',
        // Pass the real openclaw entry to the shim via env so the shim
        // can dynamic-import it after spoofing TTY.  When the shim is
        // not present (older runtime layout) this is harmless.
        OPENCLAW_TTY_SHIM_TARGET: pathToFileURL(entryScript).href,
        // Disable interactive TTY prompts in subprocess: openclaw should
        // auto-fall through to its non-TTY OAuth path when launched here.
        FORCE_COLOR: '0',
      } as NodeJS.ProcessEnv,
    });

    activeFlow = { child, abort };

    let stdout = '';
    let stderr = '';
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let settled = false;

    const finish = (result: Omit<OpenClawAuthResult, 'durationMs'>) => {
      if (settled) return;
      settled = true;
      activeFlow = null;
      resolve({ ...result, durationMs: Date.now() - startedAt });
    };

    const timeout = setTimeout(() => {
      logger.error(`[auth-runner] timed out after ${AUTH_FLOW_TIMEOUT_MS}ms`);
      try { child.kill(); } catch { /* ignore */ }
      finish({
        success: false,
        exitCode: null,
        stdout,
        stderr,
        command,
        cwd: openclawDir,
        timedOut: true,
        error: `Auth flow timed out after ${AUTH_FLOW_TIMEOUT_MS / 1000}s`,
      });
    }, AUTH_FLOW_TIMEOUT_MS);

    child.stdout?.on('data', (data) => {
      const next = appendBounded(stdout, stdoutBytes, data, stdoutTruncated);
      stdout = next.output; stdoutBytes = next.bytes; stdoutTruncated = next.truncated;
      const text = data.toString();
      onLog?.(text, 'stdout');
    });

    child.stderr?.on('data', (data) => {
      const next = appendBounded(stderr, stderrBytes, data, stderrTruncated);
      stderr = next.output; stderrBytes = next.bytes; stderrTruncated = next.truncated;
      const text = data.toString();
      onLog?.(text, 'stderr');
    });

    child.on('error', (error) => {
      clearTimeout(timeout);
      const message = error instanceof Error ? error.message : String(error);
      logger.error('[auth-runner] subprocess error:', error);
      finish({
        success: false,
        exitCode: null,
        stdout,
        stderr,
        command,
        cwd: openclawDir,
        error: message,
      });
    });

    child.on('exit', (code) => {
      clearTimeout(timeout);
      const wasAborted = abort.signal.aborted;
      logger.info(`[auth-runner] exit code ${code ?? 'null'}${wasAborted ? ' (aborted)' : ''}`);
      finish({
        success: code === 0,
        exitCode: code,
        stdout,
        stderr,
        command,
        cwd: openclawDir,
        error: wasAborted ? 'Cancelled by user' : undefined,
      });
    });
  });
}
