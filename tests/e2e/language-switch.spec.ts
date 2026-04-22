import { expect, test } from './fixtures/electron';

test.describe('Language switch', () => {
  test('switching language updates visible UI text and persists across relaunch', async ({
    electronApp,
    launchElectronApp,
    page,
  }) => {
    await page.getByTestId('setup-skip-button').click();
    await expect(page.getByTestId('main-layout')).toBeVisible();

    await page.getByTestId('sidebar-nav-settings').click();
    await expect(page.getByTestId('settings-page')).toBeVisible();

    await expect(page.getByText('Language', { exact: true })).toBeVisible();

    await page.getByRole('button', { name: '中文', exact: true }).click();
    await expect(page.getByText('语言', { exact: true })).toBeVisible();

    await page.getByRole('button', { name: '日本語', exact: true }).click();
    await expect(page.getByText('言語', { exact: true })).toBeVisible();

    await page.getByRole('button', { name: '中文', exact: true }).click();
    await expect(page.getByText('语言', { exact: true })).toBeVisible();

    await electronApp.close();

    const relaunchedApp = await launchElectronApp();
    try {
      const relaunchedWindow = await relaunchedApp.firstWindow();
      await relaunchedWindow.waitForLoadState('domcontentloaded');
      await relaunchedWindow.getByTestId('sidebar-nav-settings').click();
      await expect(relaunchedWindow.getByText('语言', { exact: true })).toBeVisible();
    } finally {
      await relaunchedApp.close();
    }
  });
});
