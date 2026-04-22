import { execSync } from 'node:child_process';

import { expect, test } from './fixtures/electron';

type E2EBridge = {
  store: { setSetting: (k: string, v: unknown) => Promise<void> };
  launchAtStartup: { applyLaunchAtStartupSetting: (enabled: boolean) => Promise<void> };
};

function readRunKey(): string {
  return execSync(
    'reg query "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run"',
    { encoding: 'utf8' },
  );
}

test.describe('launchAtStartup lifecycle (Windows)', () => {
  test.skip(process.platform !== 'win32', 'Windows-only feature');

  test('enabling writes HKCU Run entry; disabling clears it', async ({ electronApp }) => {
    await electronApp.evaluate(async () => {
      const bridge = (globalThis as { __myclawE2E?: E2EBridge }).__myclawE2E!;
      await bridge.store.setSetting('launchAtStartup', true);
      await bridge.launchAtStartup.applyLaunchAtStartupSetting(true);
    });

    expect(readRunKey()).toMatch(/MyClaw/i);

    await electronApp.evaluate(async () => {
      const bridge = (globalThis as { __myclawE2E?: E2EBridge }).__myclawE2E!;
      await bridge.store.setSetting('launchAtStartup', false);
      await bridge.launchAtStartup.applyLaunchAtStartupSetting(false);
    });

    let regOutput = '';
    try {
      regOutput = readRunKey();
    } catch {
      regOutput = '';
    }
    expect(regOutput).not.toMatch(/MyClaw/i);
  });
});
