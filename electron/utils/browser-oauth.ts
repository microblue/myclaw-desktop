/**
 * Browser-style OAuth wrapper — dashboard-pure mode.
 *
 * This module USED to implement Google + OpenAI OAuth flows itself
 * (with a local PKCE callback server, a grep against `oauth2.js` for
 * Google's published client_id, etc.).  Per the dashboard principle
 * "openclaw 做了的，我们尽量不做", we now delegate the flow to
 * `openclaw models auth login --provider <id>` via openclaw-auth-runner.
 *
 * The class still presents the same public surface the rest of MyClaw
 * already wires up (startFlow / stopFlow / submitManualCode / events)
 * so ProvidersSettings + the IPC handlers keep working unchanged.
 */
import { EventEmitter } from 'events';
import { BrowserWindow } from 'electron';
import { logger } from './logger';
import { runOpenClawAuthLogin, cancelOpenClawAuth } from './openclaw-auth-runner';
import { getProviderService } from '../services/providers/provider-service';

export type BrowserOAuthProviderType = 'google' | 'openai';

const GOOGLE_RUNTIME_PROVIDER_ID = 'google-gemini-cli';
const OPENAI_RUNTIME_PROVIDER_ID = 'openai-codex';
const GOOGLE_OAUTH_DEFAULT_MODEL = 'gemini-3-pro-preview';
const OPENAI_OAUTH_DEFAULT_MODEL = 'gpt-5.4';

function runtimeProviderIdFor(provider: BrowserOAuthProviderType): string {
  return provider === 'google' ? GOOGLE_RUNTIME_PROVIDER_ID : OPENAI_RUNTIME_PROVIDER_ID;
}

function defaultModelFor(provider: BrowserOAuthProviderType): string {
  return provider === 'google' ? GOOGLE_OAUTH_DEFAULT_MODEL : OPENAI_OAUTH_DEFAULT_MODEL;
}

function defaultLabelFor(provider: BrowserOAuthProviderType): string {
  return provider === 'google' ? 'Google Gemini' : 'OpenAI Codex';
}

class BrowserOAuthManager extends EventEmitter {
  private active = false;
  private mainWindow: BrowserWindow | null = null;
  private activeProvider: BrowserOAuthProviderType | null = null;
  private activeAccountId: string | null = null;
  private activeLabel: string | null = null;

  setWindow(window: BrowserWindow) {
    this.mainWindow = window;
  }

  async startFlow(
    provider: BrowserOAuthProviderType,
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
    logger.info('[BrowserOAuth] Flow explicitly stopped');
  }

  /** Manual-code injection — preserved for backwards compat with the
   * old OpenAI flow that used to fall through to a paste prompt.  In
   * the openclaw-delegated world this no longer applies (openclaw owns
   * the callback server), but the API stays so the IPC handler doesn't
   * need to change.  Always returns false. */
  submitManualCode(_code: string): boolean {
    return false;
  }

  private async executeFlow(provider: BrowserOAuthProviderType): Promise<void> {
    const runtimeId = runtimeProviderIdFor(provider);
    const log = (line: string, stream: 'stdout' | 'stderr') => {
      const trimmed = line.trim();
      if (trimmed) logger.info(`[BrowserOAuth:${provider}:${stream}] ${trimmed}`);
      // openclaw prints "Open https://... and enter code ABCD" lines —
      // forward them verbatim to the renderer for display.
      if (this.mainWindow && !this.mainWindow.isDestroyed() && trimmed) {
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
      logger.error(`[BrowserOAuth] Flow error for ${provider}:`, error);
      this.emitError(error instanceof Error ? error.message : String(error));
      this.active = false;
      this.activeProvider = null;
      this.activeAccountId = null;
      this.activeLabel = null;
    }
  }

  private async onSuccess(provider: BrowserOAuthProviderType): Promise<void> {
    const accountId = this.activeAccountId || provider;
    const accountLabel = this.activeLabel;
    this.active = false;
    this.activeProvider = null;
    this.activeAccountId = null;
    this.activeLabel = null;
    logger.info(`[BrowserOAuth] OAuth completed for ${provider} via openclaw`);

    // openclaw already wrote auth-profiles.json + openclaw.json.
    // MyClaw still wants a corresponding ProviderAccount row in its
    // own UI store so the renderer renders the new account.
    try {
      const providerService = getProviderService();
      const existing = await providerService.getAccount(accountId);
      await providerService.createAccount({
        id: accountId,
        vendorId: provider,
        label: accountLabel || existing?.label || defaultLabelFor(provider),
        authMode: 'oauth_browser',
        baseUrl: existing?.baseUrl,
        apiProtocol: existing?.apiProtocol,
        model: existing?.model || defaultModelFor(provider),
        fallbackModels: existing?.fallbackModels,
        fallbackAccountIds: existing?.fallbackAccountIds,
        enabled: existing?.enabled ?? true,
        isDefault: existing?.isDefault ?? false,
        metadata: {
          ...existing?.metadata,
          resourceUrl: runtimeProviderIdFor(provider),
        },
        createdAt: existing?.createdAt || new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
    } catch (err) {
      logger.warn('[BrowserOAuth] Failed to upsert ProviderAccount after openclaw login:', err);
    }

    this.emit('oauth:success', { provider, accountId });
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send('oauth:success', { provider, accountId, success: true });
    }
  }

  private emitError(message: string) {
    this.emit('oauth:error', { message });
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send('oauth:error', { message });
    }
  }
}

export const browserOAuthManager = new BrowserOAuthManager();
