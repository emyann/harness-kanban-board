import fs from 'node:fs';
import path from 'node:path';

/**
 * Where this package is, whichever layout it is in.
 *
 * A checkout runs the TypeScript straight from `src/`; a published install runs the transpile from
 * `dist/src/`. Anything that resolves a sibling file — the migrations, the CLI entry point — is one
 * directory out in the first case and two in the second, and `path.resolve(import.meta.dirname,
 * '..')` silently gives the wrong answer in exactly the layout nobody runs during development.
 *
 * So the root is found rather than assumed: walk up until there is a `package.json`. `dist/` has
 * none, so both layouts land on the same directory.
 */
function findRoot(from: string): string {
  let dir = from;
  for (let i = 0; i < 10; i++) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  // Nothing to be done about it here, and every caller wants a path rather than a throw: the old
  // guess is at least the right answer in a checkout.
  return path.resolve(from, '..');
}

export const PACKAGE_ROOT = findRoot(import.meta.dirname);

/** The SQL `ensureSchema` applies to make a board exist. Shipped in `files`; read at runtime. */
export const migrationsDir = (): string => path.join(PACKAGE_ROOT, 'prisma', 'migrations');

/**
 * The entry point `kb up` re-executes to detach.
 *
 * Resolved beside *this* module rather than from the package root, so the daemon re-executes the
 * layout it is already running: `dist/bin/kb.js` from `dist/src/`, `bin/kb.ts` from `src/`. Rooting
 * it would make a checkout that happens to have a stale `dist/` spawn the stale one.
 */
export function cliEntry(): string {
  const beside = path.resolve(import.meta.dirname, '..', 'bin');
  const built = path.join(beside, 'kb.js');
  return fs.existsSync(built) ? built : path.join(beside, 'kb.ts');
}
