import { execSync } from 'node:child_process';

import { expect, test } from './fixtures/electron';

type E2EBridge = {
  autoLoginHint: {
    maybeShowAutoLoginHintOnce: () => Promise<void>;
    __getE2EState: () => { netplwizInvocations: number };
  };
  store: {
    getSetting: (key: string) => Promise<unknown>;
  };
};

test.describe('Windows auto-login hint', () => {
  test.skip(process.platform !== 'win32', 'Windows-only feature');

  test('first run: enables launchAtStartup, opens netplwiz, marks as shown', async ({ electronApp }) => {
    await electronApp.evaluate(({ dialog }) => {
      (dialog as unknown as { showMessageBox: unknown }).showMessageBox = async () => ({
        response: 0,
        checkboxChecked: false,
      });
    });

    await electronApp.evaluate(async () => {
      const bridge = (globalThis as { __myclawE2E?: E2EBridge }).__myclawE2E!;
      await bridge.autoLoginHint.maybeShowAutoLoginHintOnce();
    });

    const launchAtStartup = await electronApp.evaluate(async () => {
      const bridge = (globalThis as { __myclawE2E?: E2EBridge }).__myclawE2E!;
      return await bridge.store.getSetting('launchAtStartup');
    });
    expect(launchAtStartup).toBe(true);

    const alreadyShown = await electronApp.evaluate(async () => {
      const bridge = (globalThis as { __myclawE2E?: E2EBridge }).__myclawE2E!;
      return await bridge.store.getSetting('hasShownAutoLoginHint');
    });
    expect(alreadyShown).toBe(true);

    const netplwizInvocations = await electronApp.evaluate(() => {
      const bridge = (globalThis as { __myclawE2E?: E2EBridge }).__myclawE2E!;
      return bridge.autoLoginHint.__getE2EState().netplwizInvocations;
    });
    expect(netplwizInvocations).toBe(1);

    const regOutput = execSync(
      'reg query "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run"',
      { encoding: 'utf8' },
    );
    expect(regOutput).toMatch(/MyClaw/i);
  });

  test('shows only once: second call is a no-op when already dismissed', async ({ electronApp }) => {
    await electronApp.evaluate(({ dialog }) => {
      (globalThis as { __dialogCalls?: number }).__dialogCalls = 0;
      (dialog as unknown as { showMessageBox: unknown }).showMessageBox = async () => {
        (globalThis as { __dialogCalls?: number }).__dialogCalls! += 1;
        return { response: 2, checkboxChecked: false };
      };
    });

    await electronApp.evaluate(async () => {
      const bridge = (globalThis as { __myclawE2E?: E2EBridge }).__myclawE2E!;
      await bridge.autoLoginHint.maybeShowAutoLoginHintOnce();
    });

    await electronApp.evaluate(async () => {
      const bridge = (globalThis as { __myclawE2E?: E2EBridge }).__myclawE2E!;
      await bridge.autoLoginHint.maybeShowAutoLoginHintOnce();
    });

    const dialogCalls = await electronApp.evaluate(() => {
      return (globalThis as { __dialogCalls?: number }).__dialogCalls ?? 0;
    });
    expect(dialogCalls).toBe(1);
  });
});
