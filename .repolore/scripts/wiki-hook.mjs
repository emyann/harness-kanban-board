#!/usr/bin/env node
/**
 * wiki-hook.mjs — the non-blocking post-commit nudge.
 *
 * Runs the two cheap checks after each commit and prints ONLY when something
 * needs attention (quiet modes): freshness (which pages went stale) and the
 * new-page nudge (page-worthy source files added since the previous commit
 * that no page covers).
 *
 * Contract, by design (see docs/RESEARCH.md §5c — blocking gates get
 * uninstalled):
 *   - ALWAYS exits 0, no matter what the checks find or whether they crash
 *   - total runtime well under a second on a typical wiki
 *   - silent when everything is green
 *
 * Installed into the repo's git hooks by wiki-install-hook.mjs; hooks are
 * not cloned with repos, so each contributor opts in once.
 */
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const run = (script, args) =>
  spawnSync(process.execPath, [join(here, script), ...args], { stdio: 'inherit' });

try {
  run('wiki-check.mjs', ['--quiet']);
  // First commit in a repo has no HEAD~1; wiki-coverage exits quietly then.
  run('wiki-coverage.mjs', ['--since', 'HEAD~1', '--page-worthy', '--quiet']);
} catch {
  // Never block a commit, even on our own crash.
}
process.exit(0);
