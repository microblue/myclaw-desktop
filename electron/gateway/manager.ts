/**
 * Gateway Process Manager
 * Manages the OpenClaw Gateway process lifecycle
 */
import { app, utilityProcess } from 'electron';
import path from 'path';
import { EventEmitter } from 'events';
import { existsSync, writeFileSync } from 'fs';
import WebSocket from 'ws';
import { PORTS } from '../utils/config';
import {
  appendNodeRequireToNodeOptions,
} from '../utils/paths';
import { getSetting } from '../utils/store';
import { JsonRpcNotification, isNotification, isResponse } from './protocol';
import { logger } from '../utils/logger';
import {
  loadOrCreateDeviceIdentity,
  type DeviceIdentity,
} from '../utils/device-identity';
import { shouldAttemptConfigAutoRepair } from './startup-recovery';
import {
  DEFAULT_RECONNECT_CONFIG,
  type ReconnectConfig,
  type GatewayLifecycleState,
  getDeferredRestartAction,
  getReconnectScheduleDecision,
  getReconnectSkipReason,
  isLifecycleSuperseded,
  nextLifecycleEpoch,
  shouldDeferRestart,
} from './process-policy';
import {
  clearPendingGatewayRequests,
  rejectPendingGatewayRequest,
  resolvePendingGatewayRequest,
  type PendingGatewayRequest,
} from './request-store';
import { dispatchJsonRpcNotification, dispatchProtocolEvent } from './event-dispatch';
import { GatewayStateController } from './state';
import { prepareGatewayLaunchContext } from './config-sync';
import { buildGatewayConnectFrame, probeGatewayReady } from './ws-client';
import {
  findExistingGatewayProcess,
  isTransientGatewayStartError,
  runOpenClawDoctorRepair,
  terminateOwnedGatewayProcess,
  unloadLaunchctlGatewayService,
  waitForPortFree,
  warmupManagedPythonReadiness,
} from './supervisor';
import { classifyGatewayStderrMessage, recordGatewayStartupStderrLine } from './startup-stderr';

/**
 * Gateway connection status
 */
export interface GatewayStatus {
  state: GatewayLifecycleState;
  port: number;
  pid?: number;
  uptime?: number;
  error?: string;
  connectedAt?: number;
  version?: string;
  reconnectAttempts?: number;
}

/**
 * Gateway Manager Events
 */
export interface GatewayManagerEvents {
  status: (status: GatewayStatus) => void;
  message: (message: unknown) => void;
  notification: (notification: JsonRpcNotification) => void;
  exit: (code: number | null) => void;
  error: (error: Error) => void;
  'channel:status': (data: { channelId: string; status: string }) => void;
  'chat:message': (data: { message: unknown }) => void;
}

// getNodeExecutablePath() removed: utilityProcess.fork() handles process isolation
// natively on all platforms (no dock icon on macOS, no console on Windows).

/**
 * Ensure the gateway fetch-preload script exists in userData and return
 * its absolute path.  The script patches globalThis.fetch to inject
 * ClawX app-attribution headers (HTTP-Referer, X-Title) for OpenRouter
 * API requests, overriding the OpenClaw runner's hardcoded defaults.
 *
 * Inlined here so it works in dev, packaged, and asar modes without
 * extra build config.  Loaded by the Gateway child process via
 * NODE_OPTIONS --require.
 */
const GATEWAY_FETCH_PRELOAD_SOURCE = `'use strict';
(function () {
  var _f = globalThis.fetch;
  if (typeof _f !== 'function') return;
  if (globalThis.__clawxFetchPatched) return;
  globalThis.__clawxFetchPatched = true;

  globalThis.fetch = function clawxFetch(input, init) {
    var url =
      typeof input === 'string' ? input
        : input && typeof input === 'object' && typeof input.url === 'string'
          ? input.url : '';

    if (url.indexOf('openrouter.ai') !== -1) {
      init = init ? Object.assign({}, init) : {};
      var prev = init.headers;
      var flat = {};
      if (prev && typeof prev.forEach === 'function') {
        prev.forEach(function (v, k) { flat[k] = v; });
      } else if (prev && typeof prev === 'object') {
        Object.assign(flat, prev);
      }
      delete flat['http-referer'];
      delete flat['HTTP-Referer'];
      delete flat['x-title'];
      delete flat['X-Title'];
      flat['HTTP-Referer'] = 'https://claw-x.com';
      flat['X-Title'] = 'ClawX';
      init.headers = flat;
    }
    return _f.call(globalThis, input, init);
  };

  // Global monkey-patch for child_process to enforce windowsHide: true on Windows.
  // This prevents OpenClaw's tools (e.g. Terminal, Python) from flashing black
  // command boxes during AI conversations, without triggering AVs.
  //
  // Node child_process signatures vary:
  //   spawn(cmd[, args][, options])
  //   exec(cmd[, options][, callback])
  //   execFile(file[, args][, options][, callback])
  //   *Sync variants omit the callback
  //
  // Strategy: scan arguments for the first plain-object (the options param).
  // If found, set windowsHide on it. If absent, insert a new options object
  // before any trailing callback so the signature stays valid.
  if (process.platform === 'win32') {
    try {
      var cp = require('child_process');
      if (!cp.__clawxPatched) {
        cp.__clawxPatched = true;
        ['spawn', 'exec', 'execFile', 'fork', 'spawnSync', 'execSync', 'execFileSync'].forEach(function(method) {
          var original = cp[method];
          if (typeof original !== 'function') return;
          cp[method] = function() {
            var args = Array.prototype.slice.call(arguments);
            var optIdx = -1;
            for (var i = 1; i < args.length; i++) {
              var a = args[i];
              if (a && typeof a === 'object' && !Array.isArray(a)) {
                optIdx = i;
                break;
              }
            }
            if (optIdx >= 0) {
              args[optIdx].windowsHide = true;
            } else {
              var opts = { windowsHide: true };
              if (typeof args[args.length - 1] === 'function') {
                args.splice(args.length - 1, 0, opts);
              } else {
                args.push(opts);
              }
            }
            return original.apply(this, args);
          };
        });
      }
    } catch (e) {
      // ignore
    }
  }
})();
`;

function ensureGatewayFetchPreload(): string {
  const dest = path.join(app.getPath('userData'), 'gateway-fetch-preload.cjs');
  try { writeFileSync(dest, GATEWAY_FETCH_PRELOAD_SOURCE, 'utf-8'); } catch { /* best-effort */ }
  return dest;
}

class LifecycleSupersededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LifecycleSupersededError';
  }
}

/**
 * Gateway Manager
 * Handles starting, stopping, and communicating with the OpenClaw Gateway
 */
export class GatewayManager extends EventEmitter {
  private process: Electron.UtilityProcess | null = null;
  private processExitCode: number | null = null; // set by exit event, replaces exitCode/signalCode
  private ownsProcess = false;
  private ws: WebSocket | null = null;
  private status: GatewayStatus = { state: 'stopped', port: PORTS.OPENCLAW_GATEWAY };
  private readonly stateController: GatewayStateController;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private pingInterval: NodeJS.Timeout | null = null;
  private healthCheckInterval: NodeJS.Timeout | null = null;
  private reconnectAttempts = 0;
  private reconnectConfig: ReconnectConfig;
  private shouldReconnect = true;
  private startLock = false;
  private lastSpawnSummary: string | null = null;
  private recentStartupStderrLines: string[] = [];
  private pendingRequests: Map<string, PendingGatewayRequest> = new Map();
  private deviceIdentity: DeviceIdentity | null = null;
  private restartDebounceTimer: NodeJS.Timeout | null = null;
  private lifecycleEpoch = 0;
  private deferredRestartPending = false;
  private restartInFlight: Promise<void> | null = null;

  constructor(config?: Partial<ReconnectConfig>) {
    super();
    this.stateController = new GatewayStateController({
      emitStatus: (status) => {
        this.status = status;
        this.emit('status', status);
      },
      onTransition: (previousState, nextState) => {
        this.flushDeferredRestart(`status:${previousState}->${nextState}`);
      },
    });
    this.reconnectConfig = { ...DEFAULT_RECONNECT_CONFIG, ...config };
    // Device identity is loaded lazily in start() — not in the constructor —
    // so that async file I/O and key generation don't block module loading.
  }

  private async initDeviceIdentity(): Promise<void> {
    if (this.deviceIdentity) return; // already loaded
    try {
      const identityPath = path.join(app.getPath('userData'), 'clawx-device-identity.json');
      this.deviceIdentity = await loadOrCreateDeviceIdentity(identityPath);
      logger.debug(`Device identity loaded (deviceId=${this.deviceIdentity.deviceId})`);
    } catch (err) {
      logger.warn('Failed to load device identity, scopes will be limited:', err);
    }
  }

  private sanitizeSpawnArgs(args: string[]): string[] {
    const sanitized = [...args];
    const tokenIdx = sanitized.indexOf('--token');
    if (tokenIdx !== -1 && tokenIdx + 1 < sanitized.length) {
      sanitized[tokenIdx + 1] = '[redacted]';
    }
    return sanitized;
  }

  private bumpLifecycleEpoch(reason: string): number {
    this.lifecycleEpoch = nextLifecycleEpoch(this.lifecycleEpoch);
    logger.debug(`Gateway lifecycle epoch advanced to ${this.lifecycleEpoch} (${reason})`);
    return this.lifecycleEpoch;
  }

  private assertLifecycleEpoch(expectedEpoch: number, phase: string): void {
    if (isLifecycleSuperseded(expectedEpoch, this.lifecycleEpoch)) {
      throw new LifecycleSupersededError(
        `Gateway ${phase} superseded (expectedEpoch=${expectedEpoch}, currentEpoch=${this.lifecycleEpoch})`
      );
    }
  }

  private isRestartDeferred(): boolean {
    return shouldDeferRestart({
      state: this.status.state,
      startLock: this.startLock,
    });
  }

  private markDeferredRestart(reason: string): void {
    if (!this.deferredRestartPending) {
      logger.info(
        `Deferring Gateway restart (${reason}) until startup/reconnect settles (state=${this.status.state}, startLock=${this.startLock})`
      );
    } else {
      logger.debug(
        `Gateway restart already deferred; keeping pending request (${reason}, state=${this.status.state}, startLock=${this.startLock})`
      );
    }
    this.deferredRestartPending = true;
  }

  private flushDeferredRestart(trigger: string): void {
    const action = getDeferredRestartAction({
      hasPendingRestart: this.deferredRestartPending,
      state: this.status.state,
      startLock: this.startLock,
      shouldReconnect: this.shouldReconnect,
    });

    if (action === 'none') return;
    if (action === 'wait') {
      logger.debug(
        `Deferred Gateway restart still waiting (${trigger}, state=${this.status.state}, startLock=${this.startLock})`
      );
      return;
    }

    this.deferredRestartPending = false;
    if (action === 'drop') {
      logger.info(
        `Dropping deferred Gateway restart (${trigger}) because lifecycle already recovered (state=${this.status.state}, shouldReconnect=${this.shouldReconnect})`
      );
      return;
    }

    logger.info(`Executing deferred Gateway restart now (${trigger})`);
    void this.restart().catch((error) => {
      logger.warn('Deferred Gateway restart failed:', error);
    });
  }

  /**
   * Get current Gateway status
   */
  getStatus(): GatewayStatus {
    return this.stateController.getStatus();
  }

  /**
   * Check if Gateway is connected and ready
   */
  isConnected(): boolean {
    return this.stateController.isConnected(this.ws?.readyState === WebSocket.OPEN);
  }

  /**
   * Start Gateway process
   */
  async start(): Promise<void> {
    if (this.startLock) {
      logger.debug('Gateway start ignored because a start flow is already in progress');
      return;
    }

    if (this.status.state === 'running') {
      logger.debug('Gateway already running, skipping start');
      return;
    }

    this.startLock = true;
    const startEpoch = this.bumpLifecycleEpoch('start');
    logger.info(`Gateway start requested (port=${this.status.port})`);
    this.lastSpawnSummary = null;
    this.shouldReconnect = true;

    // Lazily load device identity (async file I/O + key generation).
    // Must happen before connect() which uses the identity for the handshake.
    await this.initDeviceIdentity();

    // Manual start should override and cancel any pending reconnect timer.
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
      logger.debug('Cleared pending reconnect timer because start was requested manually');
    }

    this.reconnectAttempts = 0;
    this.setStatus({ state: 'starting', reconnectAttempts: 0 });
    let configRepairAttempted = false;

    // Check if Python environment is ready (self-healing) asynchronously.
    // Fire-and-forget: only needs to run once, not on every retry.
    warmupManagedPythonReadiness();

    try {
      let startAttempts = 0;
      const MAX_START_ATTEMPTS = 3;

      while (true) {
        startAttempts++;
        this.assertLifecycleEpoch(startEpoch, 'start');
        this.recentStartupStderrLines = [];
        try {
          // Check if Gateway is already running
          logger.debug('Checking for existing Gateway...');
          const existing = await findExistingGatewayProcess({
            port: this.status.port,
            ownedPid: this.process?.pid,
          });
          this.assertLifecycleEpoch(startEpoch, 'start/find-existing');
          if (existing) {
            logger.debug(`Found existing Gateway on port ${existing.port}`);
            await this.connect(existing.port, existing.externalToken);
            this.assertLifecycleEpoch(startEpoch, 'start/connect-existing');
            this.ownsProcess = false;
            this.setStatus({ pid: undefined });
            this.startHealthCheck();
            return;
          }

          logger.debug('No existing Gateway found, starting new process...');

          // On Windows, TCP TIME_WAIT can hold the port for up to 2 minutes
          // after the previous Gateway process exits, preventing the new one
          // from binding. Wait for the port to be free before proceeding.
          if (process.platform === 'win32') {
            await waitForPortFree(this.status.port);
            this.assertLifecycleEpoch(startEpoch, 'start/wait-port');
          }

          // Start new Gateway process
          await this.startProcess();
          this.assertLifecycleEpoch(startEpoch, 'start/start-process');

          // Wait for Gateway to be ready
          await this.waitForReady();
          this.assertLifecycleEpoch(startEpoch, 'start/wait-ready');

          // Connect WebSocket
          await this.connect(this.status.port);
          this.assertLifecycleEpoch(startEpoch, 'start/connect');

          // Start health monitoring
          this.startHealthCheck();
          logger.debug('Gateway started successfully');
          return;
        } catch (error) {
          if (error instanceof LifecycleSupersededError) {
            throw error;
          }
          if (shouldAttemptConfigAutoRepair(error, this.recentStartupStderrLines, configRepairAttempted)) {
            configRepairAttempted = true;
            logger.warn(
              'Detected invalid OpenClaw config during Gateway startup; running doctor repair before retry'
            );
            const repaired = await runOpenClawDoctorRepair();
            if (repaired) {
              logger.info('OpenClaw doctor repair completed; retrying Gateway startup');
              this.setStatus({ state: 'starting', error: undefined, reconnectAttempts: 0 });
              continue;
            }
            logger.error('OpenClaw doctor repair failed; not retrying Gateway startup');
          }

          // Retry on transient connect errors
          const errMsg = String(error);
          const isTransientError = isTransientGatewayStartError(error);

          if (startAttempts < MAX_START_ATTEMPTS && isTransientError) {
            logger.warn(`Transient start error: ${errMsg}. Retrying... (${startAttempts}/${MAX_START_ATTEMPTS})`);
            await new Promise((r) => setTimeout(r, 1000));
            continue;
          }

          throw error;
        }
      }

    } catch (error) {
      if (error instanceof LifecycleSupersededError) {
        logger.debug(error.message);
        return;
      }
      logger.error(
        `Gateway start failed (port=${this.status.port}, reconnectAttempts=${this.reconnectAttempts}, spawn=${this.lastSpawnSummary ?? 'n/a'})`,
        error
      );
      this.setStatus({ state: 'error', error: String(error) });
      throw error;
    } finally {
      this.startLock = false;
      this.flushDeferredRestart('start:finally');
    }
  }

  /**
   * Stop Gateway process
   */
  async stop(): Promise<void> {
    logger.info('Gateway stop requested');
    this.bumpLifecycleEpoch('stop');
    // Disable auto-reconnect
    this.shouldReconnect = false;

    // Clear all timers
    this.clearAllTimers();

    // If this manager is attached to an external gateway process, ask it to shut down
    // over protocol before closing the socket.
    if (!this.ownsProcess && this.ws?.readyState === WebSocket.OPEN) {
      try {
        await this.rpc('shutdown', undefined, 5000);
      } catch (error) {
        logger.warn('Failed to request shutdown for externally managed Gateway:', error);
      }
    }

    // Close WebSocket
    if (this.ws) {
      this.ws.close(1000, 'Gateway stopped by user');
      this.ws = null;
    }

    // Kill process
    if (this.process && this.ownsProcess) {
      const child = this.process;
      await terminateOwnedGatewayProcess(child);

      if (this.process === child) {
        this.process = null;
      }
    }
    this.ownsProcess = false;

    clearPendingGatewayRequests(this.pendingRequests, new Error('Gateway stopped'));

    this.deferredRestartPending = false;
    this.setStatus({ state: 'stopped', error: undefined, pid: undefined, connectedAt: undefined, uptime: undefined });
  }

  /**
   * Restart Gateway process
   */
  async restart(): Promise<void> {
    if (this.isRestartDeferred()) {
      this.markDeferredRestart('restart');
      return;
    }

    if (this.restartInFlight) {
      logger.debug('Gateway restart already in progress, joining existing request');
      await this.restartInFlight;
      return;
    }

    logger.debug('Gateway restart requested');
    this.restartInFlight = (async () => {
      await this.stop();
      await this.start();
    })();

    try {
      await this.restartInFlight;
    } finally {
      this.restartInFlight = null;
      this.flushDeferredRestart('restart:finally');
    }
  }

  /**
   * Debounced restart — coalesces multiple rapid restart requests into a
   * single restart after `delayMs` of inactivity.  This prevents the
   * cascading stop/start cycles that occur when provider:save,
   * provider:setDefault and channel:saveConfig all fire within seconds
   * of each other during setup.
   */
  debouncedRestart(delayMs = 2000): void {
    if (this.restartDebounceTimer) {
      clearTimeout(this.restartDebounceTimer);
    }
    logger.debug(`Gateway restart debounced (will fire in ${delayMs}ms)`);
    this.restartDebounceTimer = setTimeout(() => {
      this.restartDebounceTimer = null;
      void this.restart().catch((err) => {
        logger.warn('Debounced Gateway restart failed:', err);
      });
    }, delayMs);
  }

  /**
   * Clear all active timers
   */
  private clearAllTimers(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }
    if (this.restartDebounceTimer) {
      clearTimeout(this.restartDebounceTimer);
      this.restartDebounceTimer = null;
    }
  }

  /**
   * Make an RPC call to the Gateway
   * Uses OpenClaw protocol format: { type: "req", id: "...", method: "...", params: {...} }
   */
  async rpc<T>(method: string, params?: unknown, timeoutMs = 30000): Promise<T> {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        reject(new Error('Gateway not connected'));
        return;
      }

      const id = crypto.randomUUID();

      // Set timeout for request
      const timeout = setTimeout(() => {
        rejectPendingGatewayRequest(this.pendingRequests, id, new Error(`RPC timeout: ${method}`));
      }, timeoutMs);

      // Store pending request
      this.pendingRequests.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timeout,
      });

      // Send request using OpenClaw protocol format
      const request = {
        type: 'req',
        id,
        method,
        params,
      };

      try {
        this.ws.send(JSON.stringify(request));
      } catch (error) {
        rejectPendingGatewayRequest(this.pendingRequests, id, new Error(`Failed to send RPC request: ${error}`));
      }
    });
  }

  /**
   * Start health check monitoring
   */
  private startHealthCheck(): void {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
    }

    this.healthCheckInterval = setInterval(async () => {
      if (this.status.state !== 'running') {
        return;
      }

      try {
        const health = await this.checkHealth();
        if (!health.ok) {
          logger.warn(`Gateway health check failed: ${health.error ?? 'unknown'}`);
          this.emit('error', new Error(health.error || 'Health check failed'));
        }
      } catch (error) {
        logger.error('Gateway health check error:', error);
      }
    }, 30000); // Check every 30 seconds
  }

  /**
   * Check Gateway health via WebSocket ping
   * OpenClaw Gateway doesn't have an HTTP /health endpoint
   */
  async checkHealth(): Promise<{ ok: boolean; error?: string; uptime?: number }> {
    try {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        const uptime = this.status.connectedAt
          ? Math.floor((Date.now() - this.status.connectedAt) / 1000)
          : undefined;
        return { ok: true, uptime };
      }
      return { ok: false, error: 'WebSocket not connected' };
    } catch (error) {
      return { ok: false, error: String(error) };
    }
  }

  /**
   * Start Gateway process
   * Uses OpenClaw npm package from node_modules (dev) or resources (production)
   */
  private async startProcess(): Promise<void> {
    // Ensure no system-managed gateway service will compete with our process.
    await unloadLaunchctlGatewayService();
    const launchContext = await prepareGatewayLaunchContext(this.status.port);
    const {
      openclawDir,
      entryScript,
      gatewayArgs,
      forkEnv,
      mode,
      binPathExists,
      loadedProviderKeyCount,
      proxySummary,
      channelStartupSummary,
    } = launchContext;

    logger.info(
      `Starting Gateway process (mode=${mode}, port=${this.status.port}, entry="${entryScript}", args="${this.sanitizeSpawnArgs(gatewayArgs).join(' ')}", cwd="${openclawDir}", bundledBin=${binPathExists ? 'yes' : 'no'}, providerKeys=${loadedProviderKeyCount}, channels=${channelStartupSummary}, proxy=${proxySummary})`
    );
    this.lastSpawnSummary = `mode=${mode}, entry="${entryScript}", args="${this.sanitizeSpawnArgs(gatewayArgs).join(' ')}", cwd="${openclawDir}"`;

    return new Promise((resolve, reject) => {
      // Reset exit tracking for this new process instance.
      this.processExitCode = null;
      const runtimeEnv = { ...forkEnv };

      // Inject fetch preload so OpenRouter requests carry ClawX headers.
      // The preload patches globalThis.fetch before any module loads.
      // NODE_OPTIONS --require is blocked by Electron in packaged apps, so skip
      // this injection when packaged to avoid the "NODE_OPTIONs not supported"
      // errors being printed to the gateway's stderr on every startup.
      if (!app.isPackaged) {
        try {
          const preloadPath = ensureGatewayFetchPreload();
          if (existsSync(preloadPath)) {
            runtimeEnv['NODE_OPTIONS'] = appendNodeRequireToNodeOptions(
              runtimeEnv['NODE_OPTIONS'],
              preloadPath,
            );
          }
        } catch (err) {
          logger.warn('Failed to set up OpenRouter headers preload:', err);
        }
      }

      // utilityProcess.fork() runs the .mjs entry directly without spawning a
      // shell or visible console window. Works identically in dev and packaged.
      this.process = utilityProcess.fork(entryScript, gatewayArgs, {
        cwd: openclawDir,
        stdio: 'pipe',
        env: runtimeEnv as NodeJS.ProcessEnv,
        serviceName: 'OpenClaw Gateway',
      });
      const child = this.process;
      this.ownsProcess = true;

      child.on('error', (error) => {
        this.ownsProcess = false;
        logger.error('Gateway process spawn error:', error);
        reject(error);
      });

      child.on('exit', (code: number) => {
        this.processExitCode = code;
        const expectedExit = !this.shouldReconnect || this.status.state === 'stopped';
        const level = expectedExit ? logger.info : logger.warn;
        level(`Gateway process exited (code=${code}, expected=${expectedExit ? 'yes' : 'no'})`);
        this.ownsProcess = false;
        if (this.process === child) {
          this.process = null;
        }
        this.emit('exit', code);

        if (this.status.state === 'running') {
          this.setStatus({ state: 'stopped' });
          this.scheduleReconnect();
        }
      });

      // UtilityProcess doesn't emit 'close'; stdout/stderr end naturally on exit.

      // Log stderr
      child.stderr?.on('data', (data) => {
        const raw = data.toString();
        for (const line of raw.split(/\r?\n/)) {
          recordGatewayStartupStderrLine(this.recentStartupStderrLines, line);
          const classified = classifyGatewayStderrMessage(line);
          if (classified.level === 'drop') continue;
          if (classified.level === 'debug') {
            logger.debug(`[Gateway stderr] ${classified.normalized}`);
            continue;
          }
          logger.warn(`[Gateway stderr] ${classified.normalized}`);
        }
      });

      // PID is only available after the child process has fully spawned.
      // utilityProcess.fork() is asynchronous — child.pid is undefined if read
      // synchronously right after fork(). Use the 'spawned' event instead.
      child.on('spawn', () => {
        logger.info(`Gateway process started (pid=${child.pid})`);
        this.setStatus({ pid: child.pid });
      });

      resolve();
    });
  }

  /**
   * Wait for Gateway to be ready by checking if it can issue connect challenges.
   */
  private async waitForReady(retries = 2400, interval = 200): Promise<void> {
    const child = this.process;
    for (let i = 0; i < retries; i++) {
      // Early exit if the gateway process has already exited.
      // UtilityProcess has no synchronous exitCode/signalCode — use our tracked flag.
      if (child && this.processExitCode !== null) {
        const code = this.processExitCode;
        logger.error(`Gateway process exited before ready (code=${code})`);
        throw new Error(`Gateway process exited before becoming ready (code=${code})`);
      }

      try {
        const ready = await probeGatewayReady(this.status.port, 1500);

        if (ready) {
          logger.debug(`Gateway ready after ${i + 1} attempt(s)`);
          return;
        }
      } catch {
        // Gateway not ready yet
      }

      if (i > 0 && i % 10 === 0) {
        logger.debug(`Still waiting for Gateway... (attempt ${i + 1}/${retries})`);
      }

      await new Promise((resolve) => setTimeout(resolve, interval));
    }

    logger.error(`Gateway failed to become ready after ${retries} attempts on port ${this.status.port}`);
    throw new Error(`Gateway failed to start after ${retries} retries (port ${this.status.port})`);
  }

  /**
   * Connect WebSocket to Gateway
   */
  private async connect(port: number, _externalToken?: string): Promise<void> {
    logger.debug(`Connecting Gateway WebSocket (ws://localhost:${port}/ws)`);

    return new Promise((resolve, reject) => {
      // WebSocket URL (token will be sent in connect handshake, not URL)
      const wsUrl = `ws://localhost:${port}/ws`;

      this.ws = new WebSocket(wsUrl);
      let handshakeComplete = false;
      let connectId: string | null = null;
      let handshakeTimeout: NodeJS.Timeout | null = null;
      let settled = false;

      let challengeTimer: NodeJS.Timeout | null = null;

      const cleanupHandshakeRequest = () => {
        if (challengeTimer) {
          clearTimeout(challengeTimer);
          challengeTimer = null;
        }
        if (handshakeTimeout) {
          clearTimeout(handshakeTimeout);
          handshakeTimeout = null;
        }
        if (connectId && this.pendingRequests.has(connectId)) {
          const request = this.pendingRequests.get(connectId);
          if (request) {
            clearTimeout(request.timeout);
          }
          this.pendingRequests.delete(connectId);
        }
      };

      const resolveOnce = () => {
        if (settled) return;
        settled = true;
        cleanupHandshakeRequest();
        resolve();
      };

      const rejectOnce = (error: unknown) => {
        if (settled) return;
        settled = true;
        cleanupHandshakeRequest();
        const err = error instanceof Error ? error : new Error(String(error));
        reject(err);
      };

      // Sends the connect frame using the server-issued challenge nonce.
      const sendConnectHandshake = async (challengeNonce: string) => {
        logger.debug('Sending connect handshake with challenge nonce');

        const currentToken = await getSetting('gatewayToken');
        const connectPayload = buildGatewayConnectFrame({
          challengeNonce,
          token: currentToken,
          deviceIdentity: this.deviceIdentity,
          platform: process.platform,
        });
        connectId = connectPayload.connectId;

        this.ws?.send(JSON.stringify(connectPayload.frame));

        const requestTimeout = setTimeout(() => {
          if (!handshakeComplete) {
            logger.error('Gateway connect handshake timed out');
            this.ws?.close();
            rejectOnce(new Error('Connect handshake timeout'));
          }
        }, 10000);
        handshakeTimeout = requestTimeout;

        this.pendingRequests.set(connectId, {
          resolve: (_result) => {
            handshakeComplete = true;
            logger.debug('Gateway connect handshake completed');
            this.setStatus({
              state: 'running',
              port,
              connectedAt: Date.now(),
            });
            this.startPing();
            resolveOnce();
          },
          reject: (error) => {
            logger.error('Gateway connect handshake failed:', error);
            rejectOnce(error);
          },
          timeout: requestTimeout,
        });
      };

      // Timeout for receiving the initial connect.challenge from the server.
      // Without this, if the server never sends the challenge (e.g. orphaned
      // process from a different version), the connect() promise hangs forever.
      challengeTimer = setTimeout(() => {
        if (!challengeReceived && !settled) {
          logger.error('Gateway connect.challenge not received within timeout');
          this.ws?.close();
          rejectOnce(new Error('Timed out waiting for connect.challenge from Gateway'));
        }
      }, 10000);

      this.ws.on('open', () => {
        logger.debug('Gateway WebSocket opened, waiting for connect.challenge...');
      });

      let challengeReceived = false;

      this.ws.on('message', (data) => {
        try {
          const message = JSON.parse(data.toString());

          // Intercept the connect.challenge event before the general handler
          if (
            !challengeReceived &&
            typeof message === 'object' && message !== null &&
            message.type === 'event' && message.event === 'connect.challenge'
          ) {
            challengeReceived = true;
            if (challengeTimer) {
              clearTimeout(challengeTimer);
              challengeTimer = null;
            }
            const nonce = message.payload?.nonce as string | undefined;
            if (!nonce) {
              rejectOnce(new Error('Gateway connect.challenge missing nonce'));
              return;
            }
            logger.debug('Received connect.challenge, sending handshake');
            sendConnectHandshake(nonce);
            return;
          }

          this.handleMessage(message);
        } catch (error) {
          logger.debug('Failed to parse Gateway WebSocket message:', error);
        }
      });

      this.ws.on('close', (code, reason) => {
        const reasonStr = reason?.toString() || 'unknown';
        logger.warn(`Gateway WebSocket closed (code=${code}, reason=${reasonStr}, handshake=${handshakeComplete ? 'ok' : 'pending'})`);
        if (!handshakeComplete) {
          // If the socket closes before the handshake completes, it usually means the server is still starting or restarting.
          // Rejecting this promise will cause the caller (startProcess/reconnect logic) to retry cleanly.
          rejectOnce(new Error(`WebSocket closed before handshake: ${reasonStr}`));
          return;
        }
        cleanupHandshakeRequest();
        if (this.status.state === 'running') {
          this.setStatus({ state: 'stopped' });
          this.scheduleReconnect();
        }
      });

      this.ws.on('error', (error) => {
        // Suppress noisy ECONNREFUSED/WebSocket handshake errors that happen during expected Gateway restarts.
        if (error.message?.includes('closed before handshake') || (error as NodeJS.ErrnoException).code === 'ECONNREFUSED') {
          logger.debug(`Gateway WebSocket connection error (transient): ${error.message}`);
        } else {
          logger.error('Gateway WebSocket error:', error);
        }
        if (!handshakeComplete) {
          rejectOnce(error);
        }
      });
    });
  }

  /**
   * Handle incoming WebSocket message
   */
  private handleMessage(message: unknown): void {
    if (typeof message !== 'object' || message === null) {
      logger.debug('Received non-object Gateway message');
      return;
    }

    const msg = message as Record<string, unknown>;

    // Handle OpenClaw protocol response format: { type: "res", id: "...", ok: true/false, ... }
    if (msg.type === 'res' && typeof msg.id === 'string') {
      if (msg.ok === false || msg.error) {
        const errorObj = msg.error as { message?: string; code?: number } | undefined;
        const errorMsg = errorObj?.message || JSON.stringify(msg.error) || 'Unknown error';
        if (rejectPendingGatewayRequest(this.pendingRequests, msg.id, new Error(errorMsg))) {
          return;
        }
      } else if (resolvePendingGatewayRequest(this.pendingRequests, msg.id, msg.payload ?? msg)) {
        return;
      }
    }

    // Handle OpenClaw protocol event format: { type: "event", event: "...", payload: {...} }
    if (msg.type === 'event' && typeof msg.event === 'string') {
      dispatchProtocolEvent(this, msg.event, msg.payload);
      return;
    }

    // Fallback: Check if this is a JSON-RPC 2.0 response (legacy support)
    if (isResponse(message) && message.id && this.pendingRequests.has(String(message.id))) {
      if (message.error) {
        const errorMsg = typeof message.error === 'object'
          ? (message.error as { message?: string }).message || JSON.stringify(message.error)
          : String(message.error);
        rejectPendingGatewayRequest(this.pendingRequests, String(message.id), new Error(errorMsg));
      } else {
        resolvePendingGatewayRequest(this.pendingRequests, String(message.id), message.result);
      }
      return;
    }

    // Check if this is a JSON-RPC notification (server-initiated event)
    if (isNotification(message)) {
      dispatchJsonRpcNotification(this, message);
      return;
    }

    this.emit('message', message);
  }

  /**
   * Start ping interval to keep connection alive
   */
  private startPing(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
    }

    this.pingInterval = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.ping();
      }
    }, 30000);
  }

  /**
   * Schedule reconnection attempt with exponential backoff
   */
  private scheduleReconnect(): void {
    const decision = getReconnectScheduleDecision({
      shouldReconnect: this.shouldReconnect,
      hasReconnectTimer: this.reconnectTimer !== null,
      reconnectAttempts: this.reconnectAttempts,
      maxAttempts: this.reconnectConfig.maxAttempts,
      baseDelay: this.reconnectConfig.baseDelay,
      maxDelay: this.reconnectConfig.maxDelay,
    });

    if (decision.action === 'skip') {
      logger.debug(`Gateway reconnect skipped (${decision.reason})`);
      return;
    }

    if (decision.action === 'already-scheduled') {
      return;
    }

    if (decision.action === 'fail') {
      logger.error(`Gateway reconnect failed: max attempts reached (${decision.maxAttempts})`);
      this.setStatus({
        state: 'error',
        error: 'Failed to reconnect after maximum attempts',
        reconnectAttempts: this.reconnectAttempts
      });
      return;
    }

    const { delay, nextAttempt, maxAttempts } = decision;
    this.reconnectAttempts = nextAttempt;
    logger.warn(`Scheduling Gateway reconnect attempt ${nextAttempt}/${maxAttempts} in ${delay}ms`);

    this.setStatus({
      state: 'reconnecting',
      reconnectAttempts: this.reconnectAttempts
    });
    const scheduledEpoch = this.lifecycleEpoch;

    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      const skipReason = getReconnectSkipReason({
        scheduledEpoch,
        currentEpoch: this.lifecycleEpoch,
        shouldReconnect: this.shouldReconnect,
      });
      if (skipReason) {
        logger.debug(`Skipping reconnect attempt: ${skipReason}`);
        return;
      }
      try {
        // Use the guarded start() flow so reconnect attempts cannot bypass
        // lifecycle locking and accidentally start duplicate Gateway processes.
        await this.start();
        this.reconnectAttempts = 0;
      } catch (error) {
        logger.error('Gateway reconnection attempt failed:', error);
        this.scheduleReconnect();
      }
    }, delay);
  }

  /**
   * Update status and emit event
   */
  private setStatus(update: Partial<GatewayStatus>): void {
    this.stateController.setStatus(update);
  }
}
