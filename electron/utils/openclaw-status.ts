/**
 * OpenClaw status snapshot — for the Settings status panel.
 *
 * Aggregates everything a user needs to see "is my MyClaw set up?":
 * runtime install state, configured providers, configured channels,
 * preinstalled plugins.  No business logic — it's a read-only view.
 *
 * The aim is the user-facing shape ("已配置 1 个 Provider"), not a
 * developer dump.  The full openclaw doctor diagnostic stays in the
 * "advanced / 故障排查" fold of the UI.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { getOpenClawDir, getOpenClawStatus } from './paths';
import { logger } from './logger';

export interface OpenClawStatusSnapshot {
  runtime: {
    ready: boolean;
    version: string | null;
    dir: string;
    installMarkerExists: boolean;
    needsInstall: boolean;
  };
  config: {
    /** Whether ~/.openclaw/openclaw.json exists. */
    exists: boolean;
    /** Path to the file (always returned for the diagnostic fold). */
    path: string;
    /** Number of providers in models.providers + agents.list keys. */
    providerCount: number;
    /** Default provider key (model ref prefix), if set. */
    defaultProviderKey: string | null;
    /** Configured channel types from `channels.*`. */
    channelTypes: string[];
    /** Number of configured agents (defaults to 1 if list empty). */
    agentCount: number;
  };
  plugins: {
    /** Names of npm packages installed under ~/.myclaw/runtime/node_modules/. */
    installed: string[];
    /** Plugins explicitly enabled via plugins.allow in openclaw.json. */
    enabled: string[];
  };
}

const RUNTIME_NODE_MODULES = join(homedir(), '.myclaw', 'runtime', 'node_modules');
const INSTALL_MARKER = join(homedir(), '.myclaw', 'runtime', '.myclaw-install-complete');
const OPENCLAW_CONFIG_PATH = join(homedir(), '.openclaw', 'openclaw.json');

function safeReadJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as T;
  } catch {
    return null;
  }
}

function listInstalledPluginPackages(): string[] {
  if (!existsSync(RUNTIME_NODE_MODULES)) return [];
  try {
    const names: string[] = [];
    for (const entry of readdirSync(RUNTIME_NODE_MODULES, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith('.')) continue;
      // openclaw itself isn't a plugin
      if (entry.name === 'openclaw') continue;
      // Scoped packages (@scope/...) → recurse one level.
      if (entry.name.startsWith('@')) {
        const scopeDir = join(RUNTIME_NODE_MODULES, entry.name);
        try {
          for (const sub of readdirSync(scopeDir, { withFileTypes: true })) {
            if (sub.isDirectory()) names.push(`${entry.name}/${sub.name}`);
          }
        } catch { /* ignore */ }
        continue;
      }
      names.push(entry.name);
    }
    return names.sort();
  } catch (err) {
    logger.warn('listInstalledPluginPackages failed:', err);
    return [];
  }
}

interface PartialOpenClawConfig {
  models?: {
    providers?: Record<string, unknown>;
    default?: unknown;
  };
  agents?: {
    list?: Array<{ id?: string; modelRef?: string }>;
    defaults?: { model?: { providerKey?: string; modelId?: string } | string };
  };
  channels?: Record<string, { enabled?: boolean }>;
  plugins?: {
    allow?: string[];
    entries?: Record<string, unknown>;
  };
}

function parseConfig(): {
  exists: boolean;
  cfg: PartialOpenClawConfig | null;
} {
  if (!existsSync(OPENCLAW_CONFIG_PATH)) {
    return { exists: false, cfg: null };
  }
  return { exists: true, cfg: safeReadJson<PartialOpenClawConfig>(OPENCLAW_CONFIG_PATH) };
}

function inferDefaultProviderKey(cfg: PartialOpenClawConfig | null): string | null {
  if (!cfg) return null;
  const def = cfg.models?.default;
  if (typeof def === 'string') {
    const slash = def.indexOf('/');
    return slash > 0 ? def.slice(0, slash) : def;
  }
  const dm = cfg.agents?.defaults?.model;
  if (typeof dm === 'object' && dm && 'providerKey' in dm && typeof dm.providerKey === 'string') {
    return dm.providerKey;
  }
  if (typeof dm === 'string') {
    const slash = dm.indexOf('/');
    return slash > 0 ? dm.slice(0, slash) : dm;
  }
  return null;
}

function listConfiguredChannelTypes(cfg: PartialOpenClawConfig | null): string[] {
  if (!cfg?.channels) return [];
  const result: string[] = [];
  for (const [type, section] of Object.entries(cfg.channels)) {
    if (section && (section as { enabled?: boolean }).enabled !== false) {
      result.push(type);
    }
  }
  return result.sort();
}

export function getOpenClawStatusSnapshot(): OpenClawStatusSnapshot {
  const status = getOpenClawStatus();
  const installMarkerExists = existsSync(INSTALL_MARKER);
  // "ready" = package present + dist built + install marker present (when packaged)
  const ready = status.packageExists && status.isBuilt;

  const { exists: cfgExists, cfg } = parseConfig();
  const providers = cfg?.models?.providers ?? {};
  const providerCount = Object.keys(providers).length;
  const channelTypes = listConfiguredChannelTypes(cfg);
  const agentCount = Math.max(1, (cfg?.agents?.list ?? []).length);
  const defaultProviderKey = inferDefaultProviderKey(cfg);

  const installed = listInstalledPluginPackages();
  const enabled = Array.isArray(cfg?.plugins?.allow)
    ? (cfg!.plugins!.allow as string[]).slice().sort()
    : [];

  return {
    runtime: {
      ready,
      version: status.version ?? null,
      dir: getOpenClawDir(),
      installMarkerExists,
      needsInstall: !ready || !installMarkerExists,
    },
    config: {
      exists: cfgExists,
      path: OPENCLAW_CONFIG_PATH,
      providerCount,
      defaultProviderKey,
      channelTypes,
      agentCount,
    },
    plugins: {
      installed,
      enabled,
    },
  };
}

export function statSnapshotMtimeMs(): number {
  try {
    return statSync(OPENCLAW_CONFIG_PATH).mtimeMs;
  } catch {
    return 0;
  }
}
