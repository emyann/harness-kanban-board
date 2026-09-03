#!/usr/bin/env node
// Node 22 emits an ExperimentalWarning for `node:sqlite`; 24 does not. The store (ADR-006) needs it,
// and a warning on every command on the floor version is noise a user cannot act on. Filtering the
// listener rather than passing --no-warnings keeps every *other* warning printing.
//
// Node's own handler is kept and re-invoked rather than reimplemented: it is what honours
// --no-deprecation, --throw-deprecation and --trace-warnings, and what prints `warning.code` and the
// `(node:pid)` prefix. It is also absent entirely under --no-warnings / NODE_NO_WARNINGS=1, and an
// empty list here means those flags keep suppressing everything, exactly as they did before.
const defaultWarningListeners = process.listeners('warning');
process.removeAllListeners('warning');
process.on('warning', (w) => {
  if (w.name === 'ExperimentalWarning' && /SQLite/.test(w.message)) return;
  for (const listener of defaultWarningListeners) listener.call(process, w);
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
