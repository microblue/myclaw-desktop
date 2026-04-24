import electronBinaryPath from 'electron';
import { _electron as electron, expect, test as base, type ElectronApplication, type Page } from '@playwright/test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

type ElectronFixtures = {
  electronApp: ElectronApplication;
  page: Page;
  homeDir: string;
  userDataDir: string;
  launchElectronApp: () => Promise<ElectronApplication>;
};

const repoRoot = resolve(process.cwd());
const electronEntry = join(repoRoot, 'dist-electron/main/index.js');

async function allocatePort(): Promise<number> {
  return await new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close(() => reject(new Error('Failed to allocate an ephemeral port')));
        return;
      }
      const { port } = address;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolvePort(port);
      });
    });
  });
}

async function launchMyClawElectron(homeDir: string, userDataDir: string): Promise<ElectronApplication> {
  const hostApiPort = await allocatePort();

  // MYCLAW_INSTALLED_EXE = absolute path to a packaged MyClaw.One.exe from
  // a real installer run.  Set by windows-install-smoke.yml to point at
  // `C:\Program Files\MyClaw.One\MyClaw.One.exe` — lets the same spec file
  // exercise the real packaged binary without a separate fixture.
  //
  // In installed-exe mode we intentionally don't override HOME / USERPROFILE
  // so the test shares the runner's real ~/.myclaw/runtime/ with preceding
  // smoke steps (no second first-launch npm install).  Runner is ephemeral;
  // state leakage across the job is fine.
  const installedExe = process.env.MYCLAW_INSTALLED_EXE;
  if (installedExe) {
    return await electron.launch({
      executablePath: installedExe,
      args: [],
      env: {
        ...process.env,
        MYCLAW_E2E: '1',
        MYCLAW_USER_DATA_DIR: userDataDir,
        MYCLAW_PORT_MYCLAW_HOST_API: String(hostApiPort),
        ...(process.env.OPENROUTER_TEST_API_KEY
          ? { OPENROUTER_TEST_API_KEY: process.env.OPENROUTER_TEST_API_KEY }
          : {}),
      },
      // First-launch splash + runtime npm install can take up to ~90s on
      // Windows CI.  Subsequent launches are fast.  Conservative budget.
      timeout: 180_000,
    });
  }

  const electronEnv = process.platform === 'linux'
    ? { ELECTRON_DISABLE_SANDBOX: '1' }
    : {};
  return await electron.launch({
    executablePath: electronBinaryPath,
    args: [electronEntry],
    env: {
      ...process.env,
      ...electronEnv,
      HOME: homeDir,
      USERPROFILE: homeDir,
      APPDATA: join(homeDir, 'AppData', 'Roaming'),
      LOCALAPPDATA: join(homeDir, 'AppData', 'Local'),
      XDG_CONFIG_HOME: join(homeDir, '.config'),
      MYCLAW_E2E: '1',
      MYCLAW_USER_DATA_DIR: userDataDir,
      MYCLAW_PORT_MYCLAW_HOST_API: String(hostApiPort),
      ...(process.env.OPENROUTER_TEST_API_KEY
        ? { OPENROUTER_TEST_API_KEY: process.env.OPENROUTER_TEST_API_KEY }
        : {}),
    },
    timeout: 90_000,
  });
}

/**
 * Return the first window that is NOT the runtime-progress splash.
 * On a fresh installed-exe launch the splash opens first while the
 * runtime npm install runs; the main app window follows once that
 * completes (30-90s typical).  This helper hides that transition from
 * the test body.
 */
async function getMainAppWindow(app: ElectronApplication): Promise<Page> {
  let candidate = await app.firstWindow({ timeout: 300_000 });
  let iterations = 0;
  while (iterations++ < 5) {
    const url = candidate.url();
    if (!url.includes('runtime-progress')) return candidate;
    // The splash is showing.  Wait for the next window event — which is
    // the main app window opening after runtime init completes.
    candidate = await app.waitForEvent('window', { timeout: 300_000 });
  }
  return candidate;
}

export const test = base.extend<ElectronFixtures>({
  homeDir: async ({ browserName: _browserName }, provideHomeDir) => {
    const homeDir = await mkdtemp(join(tmpdir(), 'myclaw-e2e-home-'));
    await mkdir(join(homeDir, '.config'), { recursive: true });
    await mkdir(join(homeDir, 'AppData', 'Local'), { recursive: true });
    await mkdir(join(homeDir, 'AppData', 'Roaming'), { recursive: true });
    try {
      await provideHomeDir(homeDir);
    } finally {
      await rm(homeDir, { recursive: true, force: true });
    }
  },

  userDataDir: async ({ browserName: _browserName }, provideUserDataDir) => {
    const userDataDir = await mkdtemp(join(tmpdir(), 'myclaw-e2e-user-data-'));
    try {
      await provideUserDataDir(userDataDir);
    } finally {
      await rm(userDataDir, { recursive: true, force: true });
    }
  },

  launchElectronApp: async ({ homeDir, userDataDir }, provideLauncher) => {
    await provideLauncher(async () => await launchMyClawElectron(homeDir, userDataDir));
  },

  electronApp: async ({ launchElectronApp }, provideElectronApp) => {
    const app = await launchElectronApp();
    let appClosed = false;
    app.once('close', () => {
      appClosed = true;
    });

    try {
      await provideElectronApp(app);
    } finally {
      if (!appClosed) {
        await app.close().catch(() => {});
      }
    }
  },

  page: async ({ electronApp }, providePage) => {
    const page = await getMainAppWindow(electronApp);
    await page.waitForLoadState('domcontentloaded');
    await providePage(page);
  },
});

export async function completeSetup(page: Page): Promise<void> {
  await expect(page.getByTestId('setup-page')).toBeVisible();
  await page.getByTestId('setup-skip-button').click();
  await expect(page.getByTestId('main-layout')).toBeVisible();
}

export { expect };
