/**
 * Main user-flow E2E suite — exercises the "install → configure → use"
 * golden path that defines MyClaw's product value (a smoother UI in
 * front of OpenClaw).  Each test maps to a user-visible milestone:
 *
 *   1. Settings status panel renders runtime + provider + channel info
 *   2. Status panel exposes the user-facing CTAs (repair, re-login)
 *   3. Advanced diagnostics are reachable but folded by default
 *   4. The status snapshot module returns the expected shape
 *   5. The new openclaw:authLogin contract returns a structured failure
 *      when openclaw is missing (it never throws into the renderer)
 */
import { expect, test } from './fixtures/electron';

type E2EBridge = {
  openclawStatus: {
    getOpenClawStatusSnapshot: () => {
      runtime: { ready: boolean; dir: string; installMarkerExists: boolean };
      config: { providerCount: number; channelTypes: string[]; agentCount: number; path: string };
      plugins: { installed: string[]; enabled: string[] };
    };
  };
  openclawAuthRunner: {
    runOpenClawAuthLogin: (
      opts: { provider: string; setDefault?: boolean; method?: string },
    ) => Promise<{
      success: boolean;
      command: string;
      cwd: string;
      stdout: string;
      stderr: string;
      exitCode: number | null;
      error?: string;
    }>;
  };
};

test.describe('Main user flow: install → configure → use', () => {
  test('Settings page exposes the MyClaw status panel with the user-facing CTAs', async ({ page }) => {
    await page.getByTestId('setup-skip-button').click();
    await expect(page.getByTestId('main-layout')).toBeVisible();

    await page.getByTestId('sidebar-nav-settings').click();
    await expect(page.getByTestId('settings-page')).toBeVisible();

    const panel = page.getByTestId('settings-status-panel');
    await expect(panel).toBeVisible();
    await expect(page.getByTestId('status-fix-runtime')).toBeVisible();
    await expect(page.getByTestId('status-relogin')).toBeVisible();
  });

  test('Advanced diagnostics fold is collapsed by default and expandable', async ({ page }) => {
    await page.getByTestId('setup-skip-button').click();
    await expect(page.getByTestId('main-layout')).toBeVisible();

    await page.getByTestId('sidebar-nav-settings').click();
    await expect(page.getByTestId('settings-status-panel')).toBeVisible();

    await expect(page.getByTestId('status-advanced-section')).toHaveCount(0);
    await page.getByTestId('status-advanced-toggle').click();
    await expect(page.getByTestId('status-advanced-section')).toBeVisible();
  });

  test('openclaw status snapshot returns the expected shape', async ({ electronApp }) => {
    const snapshot = await electronApp.evaluate(() => {
      const bridge = (globalThis as { __myclawE2E?: E2EBridge }).__myclawE2E!;
      return bridge.openclawStatus.getOpenClawStatusSnapshot();
    });

    expect(snapshot).toBeTruthy();
    expect(typeof snapshot.runtime.dir).toBe('string');
    expect(typeof snapshot.runtime.installMarkerExists).toBe('boolean');
    expect(typeof snapshot.config.providerCount).toBe('number');
    expect(Array.isArray(snapshot.config.channelTypes)).toBe(true);
    expect(typeof snapshot.config.path).toBe('string');
    expect(Array.isArray(snapshot.plugins.installed)).toBe(true);
    expect(Array.isArray(snapshot.plugins.enabled)).toBe(true);
  });

  test('openclaw auth runner returns a structured result instead of throwing when entry is missing', async ({ electronApp }) => {
    // In E2E mode HOME points at a fresh tempdir, so
    // ~/.myclaw/runtime/node_modules/openclaw/openclaw.mjs does not
    // exist.  The runner must surface a typed failure (success=false +
    // error) — the dashboard contract demands no exceptions leak to UI.
    const result = await electronApp.evaluate(async () => {
      const bridge = (globalThis as { __myclawE2E?: E2EBridge }).__myclawE2E!;
      return await bridge.openclawAuthRunner.runOpenClawAuthLogin({
        provider: 'google-gemini-cli',
        setDefault: true,
      });
    });

    expect(result).toBeDefined();
    expect(typeof result.success).toBe('boolean');
    expect(result.success).toBe(false);
    expect(typeof result.command).toBe('string');
    expect(result.command).toContain('models auth login');
    expect(result.command).toContain('--provider');
    expect(result.command).toContain('google-gemini-cli');
    expect(result.command).toContain('--set-default');
    // Failure surfaces via either the entry-missing branch (.error set)
    // or via the exit branch (exitCode != 0).  Both must be a structured
    // result — never an unhandled throw.
    if (typeof result.error === 'string') {
      expect(result.error.length).toBeGreaterThan(0);
    } else {
      expect(result.exitCode === null || result.exitCode !== 0).toBe(true);
    }
  });
});
