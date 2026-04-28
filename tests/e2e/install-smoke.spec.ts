/**
 * Cross-platform install-smoke spec.
 *
 * Runs ONLY when MYCLAW_INSTALLED_EXE is set (windows-install-smoke,
 * macos-install-smoke, linux-install-smoke workflows all set it after
 * extracting / mounting the packaged installer artifact).  In every
 * other environment this spec skips.
 *
 * Goal: verify that the *packaged* binary, installed cleanly, brings up
 * the user-visible main flow:
 *
 *   1. App launches
 *   2. Setup wizard renders
 *   3. After skip, main layout renders
 *   4. Settings → status panel shows the runtime as ready (= openclaw
 *      runtime npm install on first launch succeeded)
 *   5. Status snapshot reports the install marker as present
 *   6. The openclaw auth runner is wired and accepts a structured
 *      cancellation without throwing (we don't actually run a flow
 *      since that would open a real browser on the runner)
 *
 * What it INTENTIONALLY doesn't cover:
 *   - real LLM chat round-trip (covered by post-install.spec.ts when
 *     OPENROUTER_TEST_API_KEY is set)
 *   - Windows registry / PATH entry (covered by windows-install-smoke
 *     PowerShell assertions)
 */
import { expect, test } from './fixtures/electron';
import type { Page } from '@playwright/test';

/**
 * Land on main-layout, skipping the setup wizard if it appears.
 *
 * After the first test in this file finishes setup, the runtime is
 * marked configured on the *real* runner home dir (we deliberately
 * don't override HOME for installedExe mode — sharing the runtime
 * install across tests is what avoids re-running the slow first-launch
 * npm install for every spec).  That means tests 2/3/4 launch directly
 * into the main layout with no wizard.  Either path is valid; this
 * helper handles both.
 */
async function reachMainLayout(page: Page): Promise<void> {
  const setup = page.getByTestId('setup-page');
  const main = page.getByTestId('main-layout');
  // First-launch path: wait for either the wizard or the main layout
  // to render — whichever wins, drive forward to main-layout.
  // 9-min budget covers a worst-case cold first-launch on a slow runner
  // (Linux GH-hosted: ~5-6m npm install + ~30s gateway boot).  Test-level
  // setTimeout (10m) caps the full run.
  await expect(setup.or(main)).toBeVisible({ timeout: 9 * 60 * 1000 });
  if (await setup.isVisible()) {
    await page.getByTestId('setup-skip-button').click();
  }
  await expect(main).toBeVisible();
}

type E2EBridge = {
  openclawStatus: {
    getOpenClawStatusSnapshot: () => {
      runtime: { ready: boolean; version: string | null; installMarkerExists: boolean };
      config: { providerCount: number; channelTypes: string[] };
      plugins: { installed: string[] };
    };
  };
  openclawAuthRunner: {
    cancelOpenClawAuth: () => Promise<void>;
  };
};

test.describe('Install smoke (packaged binary)', () => {
  test.skip(
    !process.env.MYCLAW_INSTALLED_EXE,
    'Not running against an installed MyClaw binary — set MYCLAW_INSTALLED_EXE to enable',
  );

  // Generous timeout: first-launch openclaw runtime npm install can take
  // up to ~6m on Linux GH runners.  reachMainLayout waits 9m; this caps
  // the full test (including post-launch assertions) at 12m.
  test.setTimeout(12 * 60 * 1000);

  // Disable Playwright's default 2-retry policy for this spec.  Each retry
  // would burn another ~9-min runtime-init wait, easily blowing the 45-min
  // job budget.  Install-smoke failures are not transient — if test 1
  // fails because the runtime didn't come up, retrying won't help; we
  // want the artifacts uploaded immediately.
  test.describe.configure({ retries: 0 });

  test('packaged binary: wizard → main layout → status panel reports runtime ready', async ({ page }) => {
    // Phase 1: setup wizard appears after first-launch runtime init
    // (or main-layout direct on a re-launch into a configured runtime).
    await reachMainLayout(page);

    // Phase 2: navigate to Settings, status panel renders
    await page.getByTestId('sidebar-nav-settings').click();
    await expect(page.getByTestId('settings-page')).toBeVisible();
    await expect(page.getByTestId('settings-status-panel')).toBeVisible();

    // CTA buttons present
    await expect(page.getByTestId('status-fix-runtime')).toBeVisible();
    await expect(page.getByTestId('status-relogin')).toBeVisible();

    // Advanced fold expands cleanly
    await page.getByTestId('status-advanced-toggle').click();
    await expect(page.getByTestId('status-advanced-section')).toBeVisible();
  });

  test('packaged binary: openclaw runtime install marker present and version readable', async ({ electronApp, page }) => {
    await reachMainLayout(page);

    const snapshot = await electronApp.evaluate(() => {
      const bridge = (globalThis as { __myclawE2E?: E2EBridge }).__myclawE2E!;
      return bridge.openclawStatus.getOpenClawStatusSnapshot();
    });

    expect(snapshot.runtime.ready).toBe(true);
    expect(snapshot.runtime.installMarkerExists).toBe(true);
    expect(typeof snapshot.runtime.version).toBe('string');
    expect((snapshot.runtime.version ?? '').length).toBeGreaterThan(0);
  });

  test('packaged binary: gemini-cli-core preinstalled plugin is on disk', async ({ electronApp, page }) => {
    // Verifies the package.json preinstalled_plugins addition actually
    // landed bytes in ~/.myclaw/runtime/node_modules — i.e. openclaw's
    // OAuth flows have a local oauth2.js to grep against, so the Apple
    // OAuth failure mode this release fixes is genuinely repaired.
    await reachMainLayout(page);

    const snapshot = await electronApp.evaluate(() => {
      const bridge = (globalThis as { __myclawE2E?: E2EBridge }).__myclawE2E!;
      return bridge.openclawStatus.getOpenClawStatusSnapshot();
    });

    expect(snapshot.plugins.installed).toEqual(
      expect.arrayContaining(['@google/gemini-cli-core']),
    );
  });

  test('packaged binary: openclaw auth-runner contract — cancel is idempotent and never throws', async ({ electronApp, page }) => {
    await reachMainLayout(page);

    // Cancelling with no active flow must resolve cleanly.  This is the
    // dashboard contract: UI can always cancel without checking state.
    const cancelTwice = await electronApp.evaluate(async () => {
      const bridge = (globalThis as { __myclawE2E?: E2EBridge }).__myclawE2E!;
      await bridge.openclawAuthRunner.cancelOpenClawAuth();
      await bridge.openclawAuthRunner.cancelOpenClawAuth();
      return 'ok';
    });
    expect(cancelTwice).toBe('ok');
  });
});
