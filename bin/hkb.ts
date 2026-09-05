#!/usr/bin/env node
/**
 * `hkb` — the entry point.
 *
 * It was `bin/kb.ts` for as long as the pre-ADR-007 CLI still ran beside it: two systems in one
 * repository sharing no code, and a second binary was what kept that honest. That system is gone,
 * so the name came back to the one the package has always been called.
 *
 * This file is what a checkout runs (`node bin/hkb.ts`) and what an `npm link` install runs, because
 * a symlinked bin's realpath is the checkout. It is NOT what a published install runs: Node refuses
 * to strip types under `node_modules`, so `bin.hkb` points at `dist/bin/hkb.js`, which `prepack`
 * transpiles from this. See docs/wiki/concepts/node-floor-and-type-check.
 */
import { run } from '../src/hkb.ts';

try {
  process.exitCode = await run(process.argv.slice(2));
} catch (e) {
  const err = e as Error & { exitCode?: number };
  process.stderr.write(`hkb: ${err.message}\n`);
  process.exitCode = err.exitCode ?? 1;
}
