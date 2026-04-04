import { app } from 'electron';
import { execSync } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { logger } from '../utils/logger';
import { getSetting } from '../utils/store';

const LINUX_AUTOSTART_FILE = join('.config', 'autostart', 'myclaw.desktop');

function quoteDesktopArg(value: string): string {
  if (!value) return '""';
  const escaped = value.replace(/(["\\`$])/g, '\\$1');
  if (/[\s"'\\`$]/.test(value)) {
    return `"${escaped}"`;
  }
  return value;
}

function getLinuxExecCommand(): string {
  if (app.isPackaged) {
    return quoteDesktopArg(process.execPath);
  }

  const launchArgs = process.argv.slice(1).filter(Boolean);
  const cmdParts = [process.execPath, ...launchArgs].map(quoteDesktopArg);
  return cmdParts.join(' ');
}

function getLinuxDesktopEntry(): string {
  return [
    '[Desktop Entry]',
    'Type=Application',
    'Version=1.0',
    'Name=MyClaw',
    'Comment=MyClaw - AI Assistant',
    `Exec=${getLinuxExecCommand()}`,
    'Terminal=false',
    'Categories=Utility;',
    'X-GNOME-Autostart-enabled=true',
    '',
  ].join('\n');
}

async function applyLinuxLaunchAtStartup(enabled: boolean): Promise<void> {
  const targetPath = join(app.getPath('home'), LINUX_AUTOSTART_FILE);
  if (enabled) {
    await mkdir(dirname(targetPath), { recursive: true });
    await writeFile(targetPath, getLinuxDesktopEntry(), 'utf8');
    logger.info(`Launch-at-startup enabled via desktop entry: ${targetPath}`);
    return;
  }

  await rm(targetPath, { force: true });
  logger.info(`Launch-at-startup disabled and desktop entry removed: ${targetPath}`);
}

function applyWindowsLaunchAtStartup(enabled: boolean): void {
  const exePath = app.getPath('exe');
  const regValue = `"${exePath}"`;
  const regKey = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';

  // Try Electron's built-in API first
  try {
    app.setLoginItemSettings({
      openAtLogin: enabled,
      openAsHidden: false,
    });
    logger.info(`Launch-at-startup ${enabled ? 'enabled' : 'disabled'} via login items`);
    return;
  } catch (error) {
    logger.warn('app.setLoginItemSettings() failed, falling back to registry:', error);
  }

  // Fallback: write directly to HKCU Run registry (no admin needed)
  try {
    if (enabled) {
      execSync(
        `reg add "${regKey}" /v MyClaw /t REG_SZ /d ${regValue} /f`,
        { stdio: 'ignore', windowsHide: true },
      );
      logger.info(`Launch-at-startup enabled via HKCU registry fallback`);
    } else {
      execSync(
        `reg delete "${regKey}" /v MyClaw /f`,
        { stdio: 'ignore', windowsHide: true },
      );
      logger.info(`Launch-at-startup disabled via HKCU registry fallback`);
    }
  } catch (regError) {
    // reg delete fails if the key doesn't exist — that's fine when disabling
    if (enabled) {
      logger.error('Failed to set launch-at-startup via registry fallback:', regError);
    } else {
      logger.info('Launch-at-startup registry entry already absent (disable is a no-op)');
    }
  }
}

function applyMacLaunchAtStartup(enabled: boolean): void {
  app.setLoginItemSettings({
    openAtLogin: enabled,
    openAsHidden: false,
  });
  logger.info(`Launch-at-startup ${enabled ? 'enabled' : 'disabled'} via login items`);
}

export async function applyLaunchAtStartupSetting(enabled: boolean): Promise<void> {
  try {
    if (process.platform === 'linux') {
      await applyLinuxLaunchAtStartup(enabled);
      return;
    }

    if (process.platform === 'win32') {
      applyWindowsLaunchAtStartup(enabled);
      return;
    }

    if (process.platform === 'darwin') {
      applyMacLaunchAtStartup(enabled);
      return;
    }

    logger.warn(`Launch-at-startup unsupported on platform: ${process.platform}`);
  } catch (error) {
    logger.error(`Failed to apply launch-at-startup=${enabled}:`, error);
  }
}

export async function syncLaunchAtStartupSettingFromStore(): Promise<void> {
  const launchAtStartup = await getSetting('launchAtStartup');
  await applyLaunchAtStartupSetting(Boolean(launchAtStartup));
}
