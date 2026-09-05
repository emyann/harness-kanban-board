import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

/**
 * A checkout per attempt.
 *
 * The Agent SDK has **no** isolation option for a top-level `query()` — `isolation: "worktree"` is
 * a parameter of the `Agent` *tool*, which only covers subagents. So the controller makes the
 * checkout itself and passes it as `cwd`. That is the whole of this module.
 *
 * Two properties the caller depends on, both of them git's rather than ours:
 *
 *   1. **A worktree is a checkout of a commit.** Uncommitted work in the operator's tree is
 *      invisible inside it, whatever base is chosen. A worker sees committed state only.
 *   2. **Gitignored files do not come across.** `.kanban/*.db` is gitignored, so the board is
 *      invisible from a worker. That is by design — the controller owns every store write — and
 *      it must stay that way: copying the board in would give each worktree a divergent copy.
 */

const git = (cwd: string, args: string[]) => spawnSync('git', args, { cwd, encoding: 'utf8' });
const short = (s: string) => (s || '').trim().split('\n').pop() || '';

export type Worktree = {
  path: string;
  branch: string;
  /** The ref we branched from, for the operator's benefit: `origin/main`. */
  baseLabel: string;
  /**
   * That ref **resolved to a commit, against the root repo**, and this is not a detail.
   * `worktreeHasWork` asks whether the worktree is ahead of its base, and a symbolic base is
   * resolved *inside the worktree* — so in a repository with no remote, where the base falls back
   * to `HEAD`, `HEAD..HEAD` is always zero and a worktree full of commits reads as empty. It would
   * then be removed, and the commits with it. A sha cannot drift out from under the question.
   */
  base: string;
};

/** `kb-<jobId>-<k>` — deterministic, so nothing needs to remember it. */
export const branchFor = (jobId: number, k: number) => `kb-${jobId}-${k}`;

/**
 * What a new branch is cut from.
 *
 * `origin/<default>` when there is one, so a worker starts from what the remote agrees on rather
 * than from whatever the operator happens to have checked out. Falls back to local HEAD when
 * there is no remote — a repo with no origin is a normal thing to develop in.
 */
export function baseRef(root: string): string {
  const head = git(root, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']);
  if (head.status === 0 && head.stdout.trim()) return head.stdout.trim();
  for (const guess of ['origin/main', 'origin/master']) {
    if (git(root, ['rev-parse', '--verify', '--quiet', `${guess}^{commit}`]).status === 0) return guess;
  }
  return 'HEAD';
}

/**
 * Make the attempt's checkout. Idempotent: an existing worktree at the path is reused, because a
 * retry that resumes a session should land in the tree that session was working in.
 */
export function createWorktree(root: string, jobId: number, k: number): Worktree {
  const branch = branchFor(jobId, k);
  const dir = path.join(root, '.kanban', 'worktrees', branch);
  const baseLabel = baseRef(root);
  const base = resolveBase(root, baseLabel);
  if (fs.existsSync(dir)) return { path: dir, branch, baseLabel, base };

  fs.mkdirSync(path.dirname(dir), { recursive: true });
  // `-B` rather than `-b`: a branch left behind by a removed worktree must not fail the next
  // attempt. The branch is ours, named after the attempt, and nothing else may be on it.
  const r = git(root, ['worktree', 'add', '-B', branch, dir, base]);
  if (r.status !== 0) {
    const e = new Error(`could not create a worktree for #${jobId} attempt ${k}: ${short(r.stderr)}`) as Error & { exitCode: number };
    e.exitCode = 2;
    throw e;
  }
  return { path: dir, branch, baseLabel, base };
}

/** Resolve a ref to a commit **in the root repo**, never in the worktree. See `Worktree.base`. */
function resolveBase(root: string, ref: string): string {
  const r = git(root, ['rev-parse', '--verify', `${ref}^{commit}`]);
  if (r.status === 0 && r.stdout.trim()) return r.stdout.trim();
  return ref;
}

/** Did the worker leave anything behind — changes, untracked files, or commits of its own? */
export function worktreeHasWork(root: string, wt: Worktree): boolean {
  const dirty = git(wt.path, ['status', '--porcelain']);
  if (dirty.status === 0 && dirty.stdout.trim()) return true;
  const ahead = git(wt.path, ['rev-list', '--count', `${wt.base}..HEAD`]);
  return ahead.status === 0 && Number(ahead.stdout.trim() || 0) > 0;
}

/**
 * Remove the checkout when it holds nothing, and say so when it does.
 *
 * Never `--force`. A worktree with work in it is the one thing here worth more than tidiness: if a
 * worker committed and the push failed, that directory is the only copy.
 */
export function removeWorktree(root: string, wt: Worktree): { removed: boolean; why: string } {
  if (!fs.existsSync(wt.path)) return { removed: true, why: 'already gone' };
  if (worktreeHasWork(root, wt)) return { removed: false, why: 'it still holds work' };
  const r = git(root, ['worktree', 'remove', wt.path]);
  if (r.status !== 0) return { removed: false, why: short(r.stderr) || 'git refused' };
  git(root, ['branch', '-D', wt.branch]);
  return { removed: true, why: 'clean' };
}
