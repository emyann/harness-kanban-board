#!/usr/bin/env node
/**
 * `kb` — the ADR-007 core's entry point, deliberately separate from `bin/hkb.js`.
 *
 * Two systems live in this repository until the migration lands, and they share no code. A second
 * binary keeps that honest: nothing here reaches into `src/cli.js`, and `src/cli.js` does not know
 * this exists. It is renamed to `hkb` when the old one is deleted, not before.
 *
 * Not in `package.json`'s `bin` yet — that waits until the Node floor is settled, because these
 * sources are TypeScript that Node runs natively and `engines` still says `>=22.13`
 * (docs/rebuild-plan.md, "Debt this plan does not pay"). Run it as `node bin/kb.ts`.
 */
import { run } from '../src/kb.ts';

try {
  process.exitCode = await run(process.argv.slice(2));
} catch (e) {
  const err = e as Error & { exitCode?: number };
  process.stderr.write(`kb: ${err.message}\n`);
  process.exitCode = err.exitCode ?? 1;
}
