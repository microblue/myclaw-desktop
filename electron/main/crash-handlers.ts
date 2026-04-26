// Module side-effect: register process-level crash handlers BEFORE any
// other module of the main bundle gets evaluated.  Imported as the first
// statement of electron/main/index.ts so that ESM dependency-order
// evaluation guarantees these handlers are in place before the rest of
// the import graph runs.
//
// Why we need this: if any subsequent module's top-level code throws (a
// missing dynamic require, an uncaught Promise, etc.), Electron's default
// behaviour is to show a synchronous modal "Uncaught Exception" dialog.
// On a CI runner with no human to click OK, the process stays alive but
// inert (CPU ~0, no logs, app.whenReady never fires).  This pattern hid
// the 2026-04-25 baileys top-level-require bug for days — smoke tests
// reported "MyClaw alive idle" and we mistook it for an Electron-on-CI
// environment quirk.
//
// Once these handlers are registered, Electron skips the dialog and
// invokes them instead.  We log to stderr (which the smoke test captures)
// and exit non-zero — the smoke test then sees a real failure and dumps
// the stack, instead of timing out.

process.on('uncaughtException', (err, origin) => {
    const stack = err instanceof Error && err.stack ? err.stack : String(err);
    process.stderr.write(`[MyClaw] uncaughtException (${origin}): ${stack}\n`);
    process.exit(1);
});

process.on('unhandledRejection', (reason) => {
    const stack = reason instanceof Error && reason.stack ? reason.stack : String(reason);
    process.stderr.write(`[MyClaw] unhandledRejection: ${stack}\n`);
    process.exit(1);
});

export {};
