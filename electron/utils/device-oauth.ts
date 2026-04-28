/**
 * Device-style OAuth wrapper — dashboard-pure mode.
 *
 * This module USED to implement MiniMax + Qwen Device-Code OAuth flows
 * itself (with hardcoded client_ids, PKCE, openclaw.json patches, etc.).
 * Per the dashboard principle "openclaw 做了的，我们尽量不做", we now
 * delegate to `openclaw models auth login --provider <id>` via
 * openclaw-auth-runner.
 *
 * The class still presents the same public surface the rest of MyClaw
 * already wires up (startFlow / stopFlow / events) so ProvidersSettings
 * + the IPC handlers keep working unchanged.
 */
import { EventEmitter } from 'events';
import { BrowserWindow } from 'electron';
import { logger } from './logger';
import { runOpenClawAuthLogin, cancelOpenClawAuth } from './openclaw-auth-runner';
import { saveProvider, getProvider, ProviderConfig } from './secure-storage';
import { getProviderDefaultModel } from './provider-registry';

export type OAuthProviderType = 'minimax-portal' | 'minimax-portal-cn' | 'qwen-portal';
export type MiniMaxRegion = 'global' | 'cn';

// Re-exported for legacy consumers that imported MiniMaxOAuthToken / QwenOAuthToken.
export type MiniMaxOAuthToken = {
  access: string;
  refresh: string;
  expires: number;
  resourceUrl?: string;
};
export type QwenOAuthToken = {
  access: string;
  refresh: string;
  expires: number;
  resourceUrl?: string;
};

const RUNTIME_PROVIDER_ID: Record<OAuthProviderType, string> = {
  'minimax-portal': 'minimax-portal',
  'minimax-portal-cn': 'minimax-portal',
  'qwen-portal': 'qwen-portal',
};

const PROVIDER_LABEL: Record<OAuthProviderType, string> = {
  'minimax-portal': 'MiniMax (Global)',
  'minimax-portal-cn': 'MiniMax (CN)',
  'qwen-portal': 'Qwen',
};

/**
 * openclaw's device-flow output typically contains a line like:
 *   "Open https://platform.minimax.io/oauth-authorize?user_code=XXXX ..."
 *   "If prompted, enter the code XXXX."
 * We parse those out so the renderer can show the URL + code in the
 * UI just like the old direct flow did.
 */
function parseVerification(message: string): { verificationUri?: string; userCode?: string } {
  const urlMatch = message.match(/Open\s+(https?:\/\/\S+?)\s+(?:to|and)/i);
  const verificationUri = urlMatch?.[1];

  let userCode: string | undefined;
  if (verificationUri) {
    try {
      const parsed = new URL(verificationUri);
      const qp = parsed.searchParams.get('user_code');
      if (qp) userCode = qp;
    } catch {
      // fall through
    }
  }
  if (!userCode) {
    const codeMatch = message.match(/enter.*?code\s+([A-Za-z0-9][A-Za-z0-9_-]{3,})/i);
    if (codeMatch?.[1]) userCode = codeMatch[1].replace(/\.$/, '');
  }
  return { verificationUri, userCode };
}

class DeviceOAuthManager extends EventEmitter {
  private active = false;
  private mainWindow: BrowserWindow | null = null;
  private activeProvider: OAuthProviderType | null = null;
  private activeAccountId: string | null = null;
  private activeLabel: string | null = null;

  setWindow(window: BrowserWindow) {
    this.mainWindow = window;
  }

  async startFlow(
    provider: OAuthProviderType,
    _region: MiniMaxRegion = 'global',
    options?: { accountId?: string; label?: string },
  ): Promise<boolean> {
    if (this.active) {
      await this.stopFlow();
    }

    this.active = true;
    this.activeProvider = provider;
    this.activeAccountId = options?.accountId || provider;
    this.activeLabel = options?.label || null;
    this.emit('oauth:start', { provider, accountId: this.activeAccountId });

    void this.executeFlow(provider);
    return true;
  }

  async stopFlow(): Promise<void> {
    this.active = false;
    this.activeProvider = null;
    this.activeAccountId = null;
    this.activeLabel = null;
    await cancelOpenClawAuth();
    logger.info('[DeviceOAuth] Flow explicitly stopped');
  }

  private async executeFlow(provider: OAuthProviderType): Promise<void> {
    const runtimeId = RUNTIME_PROVIDER_ID[provider];
    const log = (line: string, stream: 'stdout' | 'stderr') => {
      const trimmed = line.trim();
      if (!trimmed) return;
      logger.info(`[DeviceOAuth:${provider}:${stream}] ${trimmed}`);

      // Detect verification URL + user_code in openclaw's progress output
      // and fan it out to the renderer.
      const { verificationUri, userCode } = parseVerification(trimmed);
      if (verificationUri && userCode) {
        this.emitCode({
          provider,
          verificationUri,
          userCode,
          expiresIn: 300,
        });
      }

      if (this.mainWindow && !this.mainWindow.isDestroyed()) {
        this.mainWindow.webContents.send('openclaw:auth-log', { line, stream });
      }
    };

    try {
      const result = await runOpenClawAuthLogin({
        provider: runtimeId,
        setDefault: true,
        onLog: log,
      });

      if (!this.active) return; // cancelled

      if (!result.success) {
        const reason = result.error || `openclaw auth exited with code ${result.exitCode}`;
        throw new Error(reason);
      }

      await this.onSuccess(provider);
    } catch (error) {
      if (!this.active) return;
      logger.error(`[DeviceOAuth] Flow error for ${provider}:`, error);
      this.emitError(error instanceof Error ? error.message : String(error));
      this.active = false;
      this.activeProvider = null;
      this.activeAccountId = null;
      this.activeLabel = null;
    }
  }

  private async onSuccess(provider: OAuthProviderType): Promise<void> {
    const accountId = this.activeAccountId || provider;
    const accountLabel = this.activeLabel;
    this.active = false;
    this.activeProvider = null;
    this.activeAccountId = null;
    this.activeLabel = null;
    logger.info(`[DeviceOAuth] OAuth completed for ${provider} via openclaw`);

    // openclaw already wrote auth-profiles.json + openclaw.json.
    // MyClaw still keeps a thin ProviderConfig stub so its UI renders.
    try {
      const existing = await getProvider(accountId);
      const providerConfig: ProviderConfig = {
        id: accountId,
        name: accountLabel || existing?.name || PROVIDER_LABEL[provider],
        type: provider,
        enabled: existing?.enabled ?? true,
        baseUrl: existing?.baseUrl,
        model: existing?.model || getProviderDefaultModel(provider),
        createdAt: existing?.createdAt || new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      await saveProvider(providerConfig);
    } catch (err) {
      logger.warn('[DeviceOAuth] Failed to upsert ProviderConfig after openclaw login:', err);
    }

    this.emit('oauth:success', { provider, accountId });
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send('oauth:success', { provider, accountId, success: true });
    }
  }

  private emitCode(data: {
    provider: string;
    verificationUri: string;
    userCode: string;
    expiresIn: number;
  }) {
    this.emit('oauth:code', data);
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send('oauth:code', data);
    }
  }

  private emitError(message: string) {
    this.emit('oauth:error', { message });
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send('oauth:error', { message });
    }
  }
}

export const deviceOAuthManager = new DeviceOAuthManager();
