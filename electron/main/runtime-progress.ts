/**
 * Splash-style window shown while ensure_myclaw_runtime_installed() is
 * running.  The runtime init step spawns `npm install` for the pinned
 * openclaw version, which can take 30-60s on first launch — without a
 * visible surface the user would see nothing but a delayed main window
 * and assume the app is hung.
 *
 * The window renders resources/runtime-progress.html and accepts live
 * log lines via `append_log()`.  Wording is deliberately product-level
 * ("your MyClaw runtime") — see feedback_runtime_naming memory.
 */
import { BrowserWindow } from 'electron';
import { join } from 'path';
import { getResourcesDir } from '../utils/paths';

export interface RuntimeProgressWindow {
  append_log: (line: string) => void;
  close: () => void;
}

export function show_runtime_progress_window(): RuntimeProgressWindow {
  const win = new BrowserWindow({
    width: 520,
    height: 340,
    resizable: false,
    minimizable: true,
    maximizable: false,
    fullscreenable: false,
    title: 'MyClaw.One',
    show: true,
    center: true,
    backgroundColor: '#1b1c2b',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });

  // Strip the menu bar — a splash doesn't need File/Edit/etc.
  win.setMenuBarVisibility(false);

  const html_path = join(getResourcesDir(), 'runtime-progress.html');
  win.loadFile(html_path).catch(() => { /* closed before load */ });

  let last_append: Promise<unknown> = Promise.resolve();

  return {
    append_log: (line) => {
      if (win.isDestroyed()) return;
      // Serialize executeJavaScript calls so very chatty npm output
      // doesn't interleave or overflow the renderer's IPC queue.
      const payload = JSON.stringify(line + '\n');
      last_append = last_append.then(() =>
        win.isDestroyed()
          ? undefined
          : win.webContents.executeJavaScript(
              `{const l=document.getElementById('log');` +
              `if(l){l.textContent+=${payload};l.scrollTop=l.scrollHeight;}}`,
              true,
            ).catch(() => { /* window may be closing */ }),
      );
    },
    close: () => {
      if (!win.isDestroyed()) win.destroy();
    },
  };
}
