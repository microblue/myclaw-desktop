// Spawned by openclaw-auth-runner.ts in place of openclaw.mjs.
//
// Why:  openclaw 2026.4.x's `models auth login` rejects non-interactive
// invocation outright with `Error: models auth login requires an
// interactive TTY.` (auth-*.js: `if (!process.stdin.isTTY) throw`).
// MyClaw forks openclaw via Electron's utilityProcess with stdio:'pipe'
// so process.stdin.isTTY is false, hitting this guard before the OAuth
// flow runs.
//
// The actual provider OAuth flow (google-gemini-cli, openai, apple, ...)
// uses an `openUrl(url)` callback + a localhost listener for the
// callback — no real TTY required.  The upstream guard is overly
// cautious for the embedded-in-GUI case.
//
// This shim spoofs TTY=true on stdin/stdout/stderr before openclaw's
// argv is parsed, then dynamic-imports openclaw.mjs.  openclaw's
// top-level then runs as if it had a TTY; the provider's `method.run`
// drives OAuth via openUrl() and never reads stdin, so the spoof is
// safe.
//
// Required env:
//   OPENCLAW_TTY_SHIM_TARGET = absolute file:// URL of openclaw.mjs

Object.defineProperty(process.stdin,  'isTTY', { value: true, configurable: true });
Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
Object.defineProperty(process.stderr, 'isTTY', { value: true, configurable: true });

const target = process.env.OPENCLAW_TTY_SHIM_TARGET;
if (!target) {
  process.stderr.write('openclaw-tty-shim: OPENCLAW_TTY_SHIM_TARGET env not set\n');
  process.exit(1);
}

await import(target);
