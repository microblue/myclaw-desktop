import { expect, test } from './fixtures/electron';

type E2EBridge = {
  tray: {
    __getE2EMenuLabels: (mainWindow: unknown) => string[];
  };
};

test.describe('Tray behavior', () => {
  test('closing the window hides it instead of quitting the app', async ({ electronApp, page }) => {
    await page.getByTestId('setup-skip-button').click();
    await expect(page.getByTestId('main-layout')).toBeVisible();

    await electronApp.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0];
      win?.close();
    });

    const { visible, destroyed } = await electronApp.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0];
      return {
        visible: win ? win.isVisible() : null,
        destroyed: win ? win.isDestroyed() : true,
      };
    });

    expect(destroyed).toBe(false);
    expect(visible).toBe(false);
  });

  test('tray menu exposes the expected user-facing items', async ({ electronApp, page }) => {
    await page.getByTestId('setup-skip-button').click();
    await expect(page.getByTestId('main-layout')).toBeVisible();

    const labels = await electronApp.evaluate(({ BrowserWindow }) => {
      const bridge = (globalThis as { __myclawE2E?: E2EBridge }).__myclawE2E!;
      const win = BrowserWindow.getAllWindows()[0];
      return bridge.tray.__getE2EMenuLabels(win);
    });

    expect(labels).toEqual(
      expect.arrayContaining([
        'Show MyClaw',
        'Gateway Status',
        'Quick Actions',
        'Open Chat',
        'Open Settings',
        'Check for Updates...',
        'Quit MyClaw',
      ]),
    );

    if (process.platform === 'win32') {
      expect(labels).toContain('配置开机自动启动...');
    } else {
      expect(labels).not.toContain('配置开机自动启动...');
    }
  });
});
