/**
 * Dynamic imports for openclaw plugin-sdk subpath exports.
 *
 * openclaw is NOT in the asar's node_modules — it lives at resources/openclaw/
 * (extraResources).  Static `import ... from 'openclaw/plugin-sdk/...'` would
 * produce a runtime require() that fails inside the asar.
 *
 * Instead, we create a require context from the openclaw directory itself.
 * Node.js package self-referencing allows a package to require its own exports
 * by name, so `openclawRequire('openclaw/plugin-sdk/discord')` resolves via the
 * exports map in openclaw's package.json.
 *
 * In dev mode (pnpm), the resolved path is in the pnpm virtual store where
 * self-referencing also works.  The projectRequire fallback covers edge cases.
 *
 * NOTE: openclaw 2026.4.5 moved channel SDK functions from plugin-sdk subpaths
 * (e.g. openclaw/plugin-sdk/discord) into per-extension api.js files
 * (dist/extensions/discord/api.js).  We try plugin-sdk first (4.2 compat),
 * then fall back to the extension api.js path (4.5+).
 */
import { createRequire } from 'module';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { getOpenClawDir, getOpenClawResolvedDir } from './paths';

const _openclawPath = getOpenClawDir();
const _openclawResolvedPath = getOpenClawResolvedDir();
const _openclawSdkRequire = createRequire(join(_openclawResolvedPath, 'package.json'));
const _projectSdkRequire = createRequire(join(_openclawPath, 'package.json'));

function requireOpenClawSdk(subpath: string): Record<string, unknown> {
  try {
    return _openclawSdkRequire(subpath);
  } catch {
    return _projectSdkRequire(subpath);
  }
}

/**
 * Try to load a module, first via plugin-sdk subpath (openclaw 4.2 style),
 * then via direct extension api.js path (openclaw 4.5+ style).
 * Returns an empty object if both fail, so the app doesn't crash.
 */
function requireChannelSdk(pluginSdkSubpath: string, extApiRelPath: string): Record<string, unknown> {
  // 1. Try plugin-sdk subpath (openclaw <= 2026.4.2)
  try {
    return _openclawSdkRequire(`openclaw/${pluginSdkSubpath}`);
  } catch { /* fall through */ }
  try {
    return _projectSdkRequire(`openclaw/${pluginSdkSubpath}`);
  } catch { /* fall through */ }

  // 2. Try direct extension api.js (openclaw >= 2026.4.5)
  for (const base of [_openclawResolvedPath, _openclawPath]) {
    const absPath = join(base, extApiRelPath);
    if (existsSync(absPath)) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        return require(absPath);
      } catch { /* fall through */ }
    }
  }

  return {};
}

// --- Channel SDK dynamic imports ---
const _discordSdk = requireChannelSdk('plugin-sdk/discord', 'dist/extensions/discord/api.js') as {
  listDiscordDirectoryGroupsFromConfig: (...args: unknown[]) => Promise<unknown[]>;
  listDiscordDirectoryPeersFromConfig: (...args: unknown[]) => Promise<unknown[]>;
  normalizeDiscordMessagingTarget: (target: string) => string | undefined;
};

const _telegramSdk = requireChannelSdk('plugin-sdk/telegram-surface', 'dist/extensions/telegram/api.js') as {
  listTelegramDirectoryGroupsFromConfig: (...args: unknown[]) => Promise<unknown[]>;
  listTelegramDirectoryPeersFromConfig: (...args: unknown[]) => Promise<unknown[]>;
  normalizeTelegramMessagingTarget: (target: string) => string | undefined;
};

const _slackSdk = requireChannelSdk('plugin-sdk/slack', 'dist/extensions/slack/api.js') as {
  listSlackDirectoryGroupsFromConfig: (...args: unknown[]) => Promise<unknown[]>;
  listSlackDirectoryPeersFromConfig: (...args: unknown[]) => Promise<unknown[]>;
  normalizeSlackMessagingTarget: (target: string) => string | undefined;
};

const _whatsappSdk = requireChannelSdk('plugin-sdk/whatsapp-shared', 'dist/extensions/whatsapp/api.js') as {
  normalizeWhatsAppMessagingTarget: (target: string) => string | undefined;
};

export const {
  listDiscordDirectoryGroupsFromConfig,
  listDiscordDirectoryPeersFromConfig,
  normalizeDiscordMessagingTarget,
} = _discordSdk;

export const {
  listTelegramDirectoryGroupsFromConfig,
  listTelegramDirectoryPeersFromConfig,
  normalizeTelegramMessagingTarget,
} = _telegramSdk;

export const {
  listSlackDirectoryGroupsFromConfig,
  listSlackDirectoryPeersFromConfig,
  normalizeSlackMessagingTarget,
} = _slackSdk;

export const { normalizeWhatsAppMessagingTarget } = _whatsappSdk;
