import { spawnSync } from 'node:child_process';

/**
 * Pull requests, and deliberately almost nothing else of the forge.
 *
 * Named `pulls` rather than `forge` because the old system has `src/forge.js`, and a `.ts` file
 * of the same stem shadows it for every `.js` module that imports `./forge.js`. The two systems
 * share no code (ADR-007); they must not share a module name either.
 *
 * The board and the forge are two systems joined by a branch name — the worker opens its own pull
 * request with `gh` (it has Bash), and this reads back the one fact the board keeps: *which* PR
 * this attempt produced. That is history, and it belongs on the attempt row.
 *
 * What is NOT read back and never stored: whether the PR is open, merged or conflicted. That is
 * live state, it belongs to GitHub, and a copy in SQLite could only go stale. Ask the forge.
 *
 * Shelling out to `gh` rather than importing the old `src/gh.js`: the two systems share no code
 * (ADR-007), and `gh` already holds the operator's credentials.
 */

export type ForgePr = { number: number; url: string; isDraft: boolean; state: string };

/** Is there a usable `gh`? A board with no forge is a normal board, not a broken one. */
export function forgeAvailable(): boolean {
  const r = spawnSync('gh', ['auth', 'status'], { encoding: 'utf8' });
  return r.status === 0;
}

/**
 * The pull request whose head is `branch`, or null.
 *
 * One call, and a failure is null rather than a throw: a worker that did good work and could not
 * reach GitHub has still done the work, and the attempt record should say so rather than being
 * lost to a network error.
 */
export function prForBranch(cwd: string, branch: string): ForgePr | null {
  const r = spawnSync('gh', [
    'pr', 'list', '--head', branch, '--state', 'all', '--limit', '1',
    '--json', 'number,url,isDraft,state',
  ], { cwd, encoding: 'utf8' });
  if (r.status !== 0) return null;
  try {
    const rows = JSON.parse(r.stdout) as ForgePr[];
    return rows[0] ?? null;
  } catch {
    return null;
  }
}
