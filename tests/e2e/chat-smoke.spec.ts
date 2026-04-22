import { expect, test } from './fixtures/electron';

test.describe('Chat end-to-end with OpenRouter', () => {
  test.skip(
    !process.env.OPENROUTER_TEST_API_KEY,
    'OPENROUTER_TEST_API_KEY not configured — skipping live-LLM smoke',
  );

  // Windows cold-start (antivirus scan + openclaw agent bootstrap) is the
  // pacing factor; the default 90s per-test budget isn't enough.
  test.setTimeout(600_000);

  test('seeds OpenRouter provider, starts gateway, sends message, renders assistant response', async ({
    page,
  }) => {
    await page.getByTestId('setup-skip-button').click();
    await expect(page.getByTestId('main-layout')).toBeVisible();

    await page.evaluate(
      async ({ apiKey }) => {
        const now = new Date().toISOString();
        await window.electron.ipcRenderer.invoke(
          'provider:save',
          {
            id: 'openrouter-e2e',
            name: 'OpenRouter E2E',
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

    await page.evaluate(async () => {
      await window.electron.ipcRenderer.invoke('gateway:start');
    });

    await page.waitForFunction(
      async () => {
        const status = await window.electron.ipcRenderer.invoke('gateway:status');
        return status?.state === 'running';
      },
      undefined,
      { timeout: 180_000 },
    );

    await page.getByTestId('sidebar-new-chat').click();

    // On Windows, cold-start antivirus scans + openclaw agent loading can keep
    // the renderer's gateway-status store stale well after main reports running.
    const input = page.getByTestId('chat-input-textarea');
    await expect(input).toBeVisible();
    await expect(input).toBeEnabled({ timeout: 180_000 });

    // Prompt must actively discourage tool use. openclaw's default agent
    // exposes tools, and without this the model sometimes decides to call
    // them even for trivial prompts, turning a 2s chat into a multi-minute
    // tool-processing loop that has no chat-message-assistant DOM node yet.
    await input.fill('Please reply with only the single word "ok". Do not use any tools, do not think, do not elaborate.');
    await page.getByTestId('chat-send-button').click();

    const assistantMessage = page.getByTestId('chat-message-assistant').first();
    await expect(assistantMessage).toBeVisible({ timeout: 300_000 });
    await expect(assistantMessage).not.toBeEmpty();

    const text = (await assistantMessage.textContent())?.trim() ?? '';
    expect(text.length).toBeGreaterThan(0);
  });
});
