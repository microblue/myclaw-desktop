/**
 * Windows auto-login guidance.
 *
 * Windows' HKLM\Run entries only fire at user logon, and openclaw needs the
 * user's profile (`C:\Users\<user>\.openclaw`, DPAPI-protected secrets) to
 * start correctly — so "run 24/7 without login" requires the user to enable
 * Windows auto-login themselves.  We can't do it for them (no Windows
 * password), but we can show them how.
 *
 * This module:
 *   - Shows a one-time dialog after first successful gateway startup
 *     on Windows, with a "Open netplwiz" action.
 *   - Exposes a manual entry point for the tray menu so users can revisit
 *     the setup later.
 */
import { dialog, BrowserWindow } from 'electron';
import { spawn } from 'node:child_process';
import { logger } from '../utils/logger';
import { getSetting, setSetting } from '../utils/store';
import { applyLaunchAtStartupSetting } from './launch-at-startup';

/** Launch Windows' built-in `netplwiz` dialog (the "User Accounts" applet). */
export function openNetplwiz(): void {
  if (process.platform !== 'win32') return;
  try {
    const child = spawn('netplwiz.exe', [], { detached: true, stdio: 'ignore' });
    child.unref();
  } catch (err) {
    logger.warn('Failed to launch netplwiz.exe:', err);
  }
}

/**
 * Show the auto-login guidance dialog unconditionally — used by the tray
 * "Configure Auto-Login" menu item.
 */
export async function showAutoLoginHintDialog(parent?: BrowserWindow): Promise<void> {
  if (process.platform !== 'win32') return;

  const result = await dialog.showMessageBox(
    parent && !parent.isDestroyed() ? parent : undefined!,
    {
      type: 'info',
      title: '断电重启后自动恢复 MyClaw',
      message: '让电脑重启后自动启动 MyClaw 和 Gateway',
      detail:
        '需要两步：\n' +
        '  ① 开启 MyClaw 开机自启 — 点下方按钮自动完成\n' +
        '  ② 开启 Windows 自动登录 — 会打开 netplwiz，\n' +
        '     取消勾选"要求用户输入用户名和密码"，输入当前密码确认\n\n' +
        '⚠️ 仅在个人电脑使用；共享电脑请勿开启。',
      buttons: ['一键开启', '稍后', '不再提示'],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    },
  );

  if (result.response === 0) {
    try {
      await setSetting('launchAtStartup', true);
      await applyLaunchAtStartupSetting(true);
    } catch (err) {
      logger.warn('Failed to enable launchAtStartup:', err);
    }
    openNetplwiz();
    try {
      await setSetting('hasShownAutoLoginHint', true);
    } catch (err) {
      logger.warn('Failed to persist hasShownAutoLoginHint:', err);
    }
  }
  if (result.response === 2) {
    try {
      await setSetting('hasShownAutoLoginHint', true);
    } catch (err) {
      logger.warn('Failed to persist hasShownAutoLoginHint:', err);
    }
  }
}

/**
 * Show the hint once, the first time the gateway comes up successfully.
 * No-op on non-Windows or if the user already dismissed it.
 */
export async function maybeShowAutoLoginHintOnce(parent?: BrowserWindow): Promise<void> {
  if (process.platform !== 'win32') return;
  try {
    const alreadyShown = await getSetting('hasShownAutoLoginHint');
    if (alreadyShown) return;
  } catch (err) {
    logger.warn('Failed to read hasShownAutoLoginHint; skipping hint:', err);
    return;
  }

  await showAutoLoginHintDialog(parent);
}
