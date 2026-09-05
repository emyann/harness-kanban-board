#!/usr/bin/env node
/**
 * `kb` — the ADR-007 core's entry point, deliberately separate from `bin/hkb.js`.
 *
 * Two systems live in this repository until the migration lands, and they share no code. A second
 * binary keeps that honest: nothing here reaches into `src/cli.js`, and `src/cli.js` does not know
 * this exists. It is renamed to `hkb` when the old one is deleted, not before.
 *
 * This file is what a checkout runs (`node bin/kb.ts`) and what an `npm link` install runs, because
 * a symlinked bin's realpath is the checkout. It is NOT what a published install runs: Node refuses
 * to strip types under `node_modules`, so `bin.kb` points at `dist/bin/kb.js`, which `prepack`
 * transpiles from this. See docs/wiki/concepts/node-floor-and-type-check.
 */
import { run } from '../src/kb.ts';

try {
  process.exitCode = await run(process.argv.slice(2));
} catch (e) {
  const err = e as Error & { exitCode?: number };
  process.stderr.write(`kb: ${err.message}\n`);
  process.exitCode = err.exitCode ?? 1;
}
