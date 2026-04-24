// CI-only preload: hook every exit path in the Node process and write to
// stderr via fs.writeSync (bypasses the default stream buffering that
// eats last-gasp logs from dying processes).  Used by windows-install-
// smoke.yml Layer 4b to diagnose why the openclaw gateway silently exits
// on Windows between "auth token saved" and "listening on 18789".

const fs = require('fs');
const write = (s) => {
  try { fs.writeSync(2, s + '\n'); } catch {}
};

write('[exit-trace] preload installed, pid=' + process.pid);

process.on('exit', (code) => write('[exit-trace] EXIT code=' + code));
process.on('beforeExit', (code) => write('[exit-trace] BEFORE_EXIT code=' + code));
process.on('uncaughtException', (err, origin) => {
  write('[exit-trace] UNCAUGHT_EXCEPTION origin=' + origin + ' msg=' + (err && err.message));
  write('[exit-trace] stack=' + (err && err.stack));
});
process.on('unhandledRejection', (reason) => {
  write('[exit-trace] UNHANDLED_REJECTION reason=' + (reason && (reason.message || reason)));
  write('[exit-trace] stack=' + (reason && reason.stack));
});
process.on('warning', (w) => {
  write('[exit-trace] WARNING ' + w.name + ': ' + w.message);
});
process.on('SIGTERM', () => write('[exit-trace] SIGTERM received'));
process.on('SIGINT', () => write('[exit-trace] SIGINT received'));
process.on('SIGHUP', () => write('[exit-trace] SIGHUP received'));
process.on('SIGBREAK', () => write('[exit-trace] SIGBREAK received'));

// Capture any code path that cleanly calls process.exit() — by default
// Node doesn't print anything for a clean exit, so a silently-exiting
// module goes unnoticed.  Wrap the function so we get the caller stack.
const origExit = process.exit.bind(process);
process.exit = (code) => {
  write('[exit-trace] process.exit(' + code + ') called from:');
  write(new Error().stack);
  return origExit(code);
};
