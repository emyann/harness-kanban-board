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
 * The pull request whose head is `branch` and which THIS attempt could have opened, or null.
 *
 * `notBefore` is the fence, and it is not optional caution. A branch name is unique per database,
 * not per remote, so a repository that has run hkb before may already carry a `kb-4-1` with a
 * pull request on it from months ago. Phase 5's job #4 hit exactly that: the lookup returned a
 * *closed* pull request from an unrelated experiment, and the board recorded it as the Job's
 * output while the real work sat on another branch, invisible. A pull request created before the
 * attempt began cannot be that attempt's output, whatever branch it is on.
 *
 * Ordered newest-first and filtered rather than `--limit 1`, because the one gh returns first is
 * the one most likely to be the stale one.
 *
 * One call, and a failure is null rather than a throw: a worker that did good work and could not
 * reach GitHub has still done the work, and the attempt record should say so rather than being
 * lost to a network error.
 */
export function prForBranch(cwd: string, branch: string, notBefore?: Date): ForgePr | null {
  const r = spawnSync('gh', [
    'pr', 'list', '--head', branch, '--state', 'all', '--limit', '20',
    '--json', 'number,url,isDraft,state,createdAt,headRefName',
  ], { cwd, encoding: 'utf8' });
  if (r.status !== 0) return null;
  try {
    return pickPr(JSON.parse(r.stdout) as PrRow[], branch, notBefore);
  } catch {
    return null;
  }
}

export type PrRow = ForgePr & { createdAt: string; headRefName: string };

/**
 * Which of the pull requests on this branch, if any, is this attempt's.
 *
 * Pure and exported because this is where the bug was, not in the `gh` call: the old version took
 * whatever came back first and the first thing back was a closed pull request from months earlier.
 * A decision this consequential — it is the whole of the board↔forge join — should be testable
 * without a network or a GitHub account.
 */
export function pickPr(rows: PrRow[], branch: string, notBefore?: Date): ForgePr | null {
  const p = rows
    // `--head` should guarantee this; asserting it costs nothing and the join is the one thing
    // tying a pull request to a Job.
    .filter((r) => r.headRefName === branch)
    .filter((r) => !notBefore || Date.parse(r.createdAt) >= notBefore.getTime())
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0];
  return p ? { number: p.number, url: p.url, isDraft: p.isDraft, state: p.state } : null;
}
