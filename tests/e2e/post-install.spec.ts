/**
 * Post-install end-to-end smoke against a real packaged installer output.
 *
 * Runs ONLY when MYCLAW_INSTALLED_EXE is set (windows-install-smoke.yml
 * sets it to `C:\Program Files\MyClaw.One\MyClaw.One.exe`).  In every
 * other environment (local dev, electron-e2e workflow) this spec skips.
 *
 * Covers the user journey that was previously a three-way gap between
 * install-smoke (binary runs), chat-smoke (dev build chat), and
 * unverified (channel install):
 *
 *   installer → auto-launch → wizard skip → OpenRouter + Flash Lite →
 *   chat round-trip → configure WeCom channel → verify plugin install
 *
 * The wizard click-through (select OpenRouter in the UI, type api key,
 * pick Flash Lite from the model list) is deliberately NOT covered
 * here — that's a UI-component concern that belongs in a dedicated
 * wizard spec in the electron-e2e matrix, not in install-smoke.  This
 * file verifies the *plumbing* end-to-end: the installer really
 * produces a binary that, when driven through standard IPC, can do a
 * full chat round-trip and install a channel plugin.
 */
import { expect, test } from './fixtures/electron';

test.describe('Post-install end-to-end (packaged installer output)', () => {
  test.skip(
    !process.env.MYCLAW_INSTALLED_EXE,
    'Not running against an installed MyClaw.exe — set MYCLAW_INSTALLED_EXE to enable',
  );
  test.skip(
    !process.env.OPENROUTER_TEST_API_KEY,
    'OPENROUTER_TEST_API_KEY secret not configured — skipping live-LLM journey',
  );

  // First-launch runtime npm install (~60s) + gateway cold start (~30s) +
  // chat round-trip (~15s) + channel install CLI spawn (~20s).  Generous
  // ceiling since install-smoke runs on windows-latest where antivirus
  // scans add variance.
  test.setTimeout(15 * 60 * 1000);

  test('installer binary: wizard skip → OpenRouter + Flash Lite → chat → channel install', async ({ page }) => {
    // === Phase 1: setup wizard ===
    // The installed exe is running first-launch — the setup page shows
    // after runtime init completes.  Skip it (UI click-through of the
    // wizard itself is out-of-scope; see spec header).
    await expect(page.getByTestId('setup-page')).toBeVisible({ timeout: 60_000 });
    await page.getByTestId('setup-skip-button').click();
    await expect(page.getByTestId('main-layout')).toBeVisible();

    // === Phase 2: seed OpenRouter with Google Flash Lite via IPC ===
    // Mirrors chat-smoke's pattern.  We deliberately go through the same
    // IPC surface the UI would use (`provider:save`) rather than writing
    // openclaw.json directly — that keeps the test aligned with real
    // user behaviour even though it skips the UI click-through.
    await page.evaluate(
      async ({ apiKey }) => {
        const now = new Date().toISOString();
        await window.electron.ipcRenderer.invoke(
          'provider:save',
          {
            id: 'openrouter-post-install',
            name: 'OpenRouter (post-install)',
            type: 'openrouter',
            vendorId: 'openrouter',
            baseUrl: 'https://openrouter.ai/api/v1',
            model: 'google/gemini-2.5-flash-lite',
            enabled: true,
            createdAt: now,
            updatedAt: now,
          },
          apiKey,
        );
      },
      { apiKey: process.env.OPENROUTER_TEST_API_KEY! },
    );

    // === Phase 3: start gateway ===
    await page.evaluate(async () => {
      await window.electron.ipcRenderer.invoke('gateway:start');
    });
    await page.waitForFunction(
      async () => {
        const status = await window.electron.ipcRenderer.invoke('gateway:status');
        return status?.state === 'running';
      },
      undefined,
      { timeout: 240_000 },
    );

    // === Phase 4: chat round-trip through real LLM ===
    await page.getByTestId('sidebar-new-chat').click();
    const input = page.getByTestId('chat-input-textarea');
    await expect(input).toBeVisible();
    await expect(input).toBeEnabled({ timeout: 180_000 });

    await input.fill('Reply with the single word: ready');
    await input.press('Enter');

    const assistantBubble = page.getByTestId('chat-assistant-bubble').first();
    await expect(assistantBubble).toBeVisible({ timeout: 120_000 });

    // Don't assert on exact content (LLM output varies) — just confirm
    // a non-trivial assistant message appeared.
    const response = await assistantBubble.textContent();
    expect((response ?? '').trim().length).toBeGreaterThan(2);

    // === Phase 5: channel install verification ===
    // Trigger `channel:saveConfig('wecom', ...)` which internally calls
    // ensureWeComPluginInstalled() -> spawns
    // `openclaw plugins install @wecom/wecom-openclaw-plugin` (per the
    // P2 CLI-delegation refactor).  Assert the install completes
    // successfully — this is the ONLY end-to-end test that exercises
    // the plugin install code path at all.
    const channelResult = await page.evaluate(async () => {
      return await window.electron.ipcRenderer.invoke('channel:saveConfig', 'wecom', {
        // These values are syntactically valid but not real credentials;
        // we're testing that the plugin INSTALLS, not that it connects.
        token: 'test-token-post-install',
        encodingAesKey: 'test-encoding-aes-key-post-install-0000',
        corpId: 'test-corp-id',
      });
    });

    // Soft log the full result for post-mortem if this step ever flakes.
    // eslint-disable-next-line no-console
    console.log('[post-install] channel:saveConfig result:', JSON.stringify(channelResult));

    expect(channelResult).toMatchObject({ success: true });
  });
});
