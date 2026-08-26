#!/usr/bin/env node
import { main } from '../src/cli.js';

main(process.argv.slice(2)).then(
  (code) => process.exit(typeof code === 'number' ? code : 0),
  (err) => {
    const msg = err?.userMessage || err?.message || String(err);
    process.stderr.write(`hkb: ${msg}\n`);
    if (process.env.GHK_DEBUG && err?.stack) process.stderr.write(err.stack + '\n');
    process.exit(err?.exitCode || 1);
  },
);
