#!/usr/bin/env node
// Node 22 emits an ExperimentalWarning for `node:sqlite`; 24 does not. The store (ADR-006) needs it,
// and a warning on every command on the floor version is noise a user cannot act on. Replacing the
// default 'warning' listener rather than passing --no-warnings keeps every *other* warning printing.
process.removeAllListeners('warning');
process.on('warning', (w) => {
  if (w.name === 'ExperimentalWarning' && /SQLite/.test(w.message)) return;
  process.stderr.write(`${w.name}: ${w.message}\n`);
});

const { main } = await import('../src/cli.js');

main(process.argv.slice(2)).then(
  (code) => process.exit(typeof code === 'number' ? code : 0),
  (err) => {
    const msg = err?.userMessage || err?.message || String(err);
    process.stderr.write(`hkb: ${msg}\n`);
    if (process.env.GHK_DEBUG && err?.stack) process.stderr.write(err.stack + '\n');
    process.exit(err?.exitCode || 1);
  },
);
