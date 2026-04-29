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
  set_stage: (label: string) => void;
  /**
   * Update the determinate progress bar.  `current` is how many packages
   * have landed so far, `total` is the (estimated) total.  When
   * total is omitted the bar falls back to indeterminate / sliding mode.
   */
  set_count: (current: number, total: number) => void;
  close: () => void;
}

export function show_runtime_progress_window(): RuntimeProgressWindow {
  const win = new BrowserWindow({
    width: 540,
    height: 440,
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
    set_stage: (label) => {
      if (win.isDestroyed()) return;
      const payload = JSON.stringify(label);
      last_append = last_append.then(() =>
        win.isDestroyed()
          ? undefined
          : win.webContents.executeJavaScript(
              `{const s=document.getElementById('stage');if(s){s.textContent=${payload};}}`,
              true,
            ).catch(() => { /* window may be closing */ }),
      );
    },
    set_count: (current, total) => {
      if (win.isDestroyed()) return;
      // Clamp to [0, total] and convert to percent.  We allow current >
      // total briefly because the npm install can technically deposit
      // more dirs than our estimate; cap to 99% so the bar never
      // misleadingly reads "100% done" until set_stage('Configuring …')
      // marks the actual transition.
      const safe_current = Math.max(0, current);
      const safe_total = Math.max(1, total);
      const ratio = Math.min(safe_current / safe_total, 0.99);
      const percent = (ratio * 100).toFixed(1);
      const count_text = `${safe_current} / ~${safe_total} packages`;
      last_append = last_append.then(() =>
        win.isDestroyed()
          ? undefined
          : win.webContents.executeJavaScript(
              `{const b=document.getElementById('bar');` +
              `if(b){b.classList.remove('indeterminate');b.style.width=${percent}+'%';}` +
              `const c=document.getElementById('count');` +
              `if(c){c.textContent=${JSON.stringify(count_text)};}}`,
              true,
            ).catch(() => { /* window may be closing */ }),
      );
    },
    close: () => {
      if (!win.isDestroyed()) win.destroy();
    },
  };
}
