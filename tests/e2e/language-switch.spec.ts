import { expect, test } from './fixtures/electron';
import type { Page } from '@playwright/test';

function languageLabel(page: Page, text: string) {
  return page.locator('label').filter({ hasText: text }).first();
}

test.describe('Language switch', () => {
  test('switching language updates visible UI text and persists across relaunch', async ({
    electronApp,
    launchElectronApp,
    page,
  }) => {
    // Windows renderer + i18next re-render can be slow on cold runners.
    test.setTimeout(180_000);

    await page.getByTestId('setup-skip-button').click();
    await expect(page.getByTestId('main-layout')).toBeVisible();

    await page.getByTestId('sidebar-nav-settings').click();
    await expect(page.getByTestId('settings-page')).toBeVisible();

    // The language section sits below the fold on small windows, so scroll
    // a language button into view first to stabilise the subsequent asserts.
    const zhButton = page.getByRole('button', { name: '中文', exact: true });
    await zhButton.scrollIntoViewIfNeeded();
    await expect(languageLabel(page, 'Language')).toBeVisible({ timeout: 30_000 });

    await zhButton.click();
    await expect(languageLabel(page, '语言')).toBeVisible({ timeout: 30_000 });

    const jaButton = page.getByRole('button', { name: '日本語', exact: true });
    await jaButton.scrollIntoViewIfNeeded();
    await jaButton.click();
    await expect(languageLabel(page, '言語')).toBeVisible({ timeout: 30_000 });

    await zhButton.scrollIntoViewIfNeeded();
    await zhButton.click();
    await expect(languageLabel(page, '语言')).toBeVisible({ timeout: 30_000 });

    await electronApp.close();

    const relaunchedApp = await launchElectronApp();
    try {
      const relaunchedWindow = await relaunchedApp.firstWindow();
      await relaunchedWindow.waitForLoadState('domcontentloaded');
      await relaunchedWindow.getByTestId('sidebar-nav-settings').click();
      await expect(languageLabel(relaunchedWindow, '语言')).toBeVisible({ timeout: 30_000 });
    } finally {
      await relaunchedApp.close();
    }
  });
});
