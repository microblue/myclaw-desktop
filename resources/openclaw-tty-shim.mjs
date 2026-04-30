// Spawned by openclaw-auth-runner.ts in place of openclaw.mjs.
//
// Two pre-import patches are applied here, then we dynamic-import the real
// openclaw entry from $OPENCLAW_TTY_SHIM_TARGET.
//
// Patch #1 — TTY spoof
// --------------------
// openclaw 2026.4.x's `models auth login` rejects non-interactive invocation
// outright with `Error: models auth login requires an interactive TTY.`
// MyClaw forks openclaw via Electron's utilityProcess with stdio:'pipe' so
// process.stdin.isTTY is false, hitting that guard before the OAuth flow
// runs.  The actual provider OAuth flow uses an openUrl callback + a
// localhost listener — no real TTY required.  We spoof TTY=true on
// stdin/stdout/stderr before openclaw's argv is parsed.
//
// Patch #2 — browser-launch announce
// ----------------------------------
// openclaw's own browser launcher (browser-open-*.js's openUrl) spawns
// explorer.exe / open / xdg-open via child_process and silently returns
// false on failure.  In Electron's utilityProcess context this fails for
// Google Gemini OAuth specifically (extensions/google/oauth.js calls
// `await ctx.openUrl(url)` and only logs the URL inside a `catch` that
// never fires, since the inner openUrl swallows errors instead of
// throwing).  Result: no browser opens, OAuth hangs forever.
//
// We monkey-patch child_process.spawn so any spawn matching a known
// URL-opener binary (explorer.exe / open / xdg-open / wslview) prints
// `Open: <url>` to stdout BEFORE the actual spawn.  The MyClaw auth-runner
// snoops that line and re-opens the URL via Electron's shell.openExternal
// from the main process — which always works.  The original spawn still
// happens; if it succeeds, modern browsers de-dupe the second navigate.
//
// Required env:
//   OPENCLAW_TTY_SHIM_TARGET = absolute file:// URL of openclaw.mjs

import { createRequire } from 'node:module';
import { syncBuiltinESMExports } from 'node:module';

// --- Patch #1: TTY spoof ---
Object.defineProperty(process.stdin,  'isTTY', { value: true, configurable: true });
Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
Object.defineProperty(process.stderr, 'isTTY', { value: true, configurable: true });

// --- Patch #2: announce browser-launch URLs to stdout ---
const require = createRequire(import.meta.url);
const cp = require('node:child_process');

const URL_OPENER_BASENAMES = new Set([
  'explorer', 'explorer.exe',
  'open',
  'xdg-open',
  'wslview',
]);

function basename(p) {
  const s = String(p || '');
  const i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
  return (i >= 0 ? s.slice(i + 1) : s).toLowerCase();
}

function announceUrlIfOpener(command, args) {
  try {
    const base = basename(command);
    if (!URL_OPENER_BASENAMES.has(base)) return;
    if (!Array.isArray(args)) return;
    for (const arg of args) {
      const s = String(arg);
      if (/^https?:\/\//i.test(s)) {
        process.stdout.write(`Open: ${s}\n`);
        return;
      }
    }
  } catch { /* never let the patch break the spawn */ }
}

const originalSpawn = cp.spawn;
cp.spawn = function patchedSpawn(command, args, options) {
  announceUrlIfOpener(command, args);
  return originalSpawn.call(this, command, args, options);
};
syncBuiltinESMExports();

// --- Now load openclaw with both patches in effect ---
const target = process.env.OPENCLAW_TTY_SHIM_TARGET;
if (!target) {
  process.stderr.write('openclaw-tty-shim: OPENCLAW_TTY_SHIM_TARGET env not set\n');
  process.exit(1);
}

await import(target);
