import { expect, test } from './fixtures/electron';

test.describe('Chat end-to-end with OpenRouter', () => {
  test.skip(
    !process.env.OPENROUTER_TEST_API_KEY,
    'OPENROUTER_TEST_API_KEY not configured — skipping live-LLM smoke',
  );

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
      { timeout: 90_000 },
    );

    await page.getByTestId('sidebar-new-chat').click();

    const input = page.getByTestId('chat-input-textarea');
    await expect(input).toBeVisible();
    await expect(input).toBeEnabled({ timeout: 60_000 });

    await input.fill('Reply with exactly one word: ok');
    await page.getByTestId('chat-send-button').click();

    const assistantMessage = page.getByTestId('chat-message-assistant').first();
    await expect(assistantMessage).toBeVisible({ timeout: 120_000 });
    await expect(assistantMessage).not.toBeEmpty();

    const text = (await assistantMessage.textContent())?.trim() ?? '';
    expect(text.length).toBeGreaterThan(0);
  });
});
