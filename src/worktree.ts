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
 * A branch name this attempt can actually push to.
 *
 * `Job.id` is an autoincrement per *database*, not per remote, so `kb-4-1` is not a name this
 * repository owns — it is a name the next fresh `board.db` will also produce. A remote that has
 * ever run hkb already has some, and pushing onto one with unrelated history is rejected as
 * non-fast-forward. A worker told never to force-push then has no move, which is exactly what
 * happened to Phase 5's job #4: it pushed under a name of its own and the board recorded a
 * different, closed pull request as its output.
 *
 * So the name is checked before it is used. A remote branch whose tip is an ancestor of our base
 * is ours to continue — a resumed attempt, or one already merged. Anything else is somebody
 * else's history, and we take the next free suffix rather than fight it.
 */
export function freeBranch(root: string, jobId: number, k: number): string {
  const wanted = branchFor(jobId, k);
  for (let n = 1; n < 50; n++) {
    const name = n === 1 ? wanted : `${wanted}-${n}`;
    const ls = git(root, ['ls-remote', '--heads', 'origin', name]);
    // No remote, or the call failed: nothing can be proved, and the deterministic name is right.
    if (ls.status !== 0) return name;
    if (!ls.stdout.trim()) return name;
    const sha = ls.stdout.trim().split(/\s+/)[0];
    // Ours to continue: already contained in what we are branching from.
    if (git(root, ['merge-base', '--is-ancestor', sha, 'HEAD']).status === 0) return name;
  }
  return wanted;
}

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
  // The DIRECTORY keeps the deterministic name so `existingWorktree` can find it without being
  // told; only the BRANCH disambiguates, and the attempt row records which one it got.
  const dir = path.join(root, '.kanban', 'worktrees', branchFor(jobId, k));
  const branch = freeBranch(root, jobId, k);
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

/**
 * The checkout an earlier attempt left behind, or null.
 *
 * A resumed session continues its transcript, so it believes it is in the directory it was working
 * in — and cutting a fresh `kb-<jobId>-<k>` from origin would wake it on a different branch with
 * none of its own commits, while the brief told it to push to the new one. Resume is not restart,
 * and that has to be true of the filesystem as well as of the session.
 *
 * `base` is resolved fresh rather than remembered. If origin has moved since, the worktree may read
 * as "ahead" when it is not — which errs toward keeping it, and keeping is the safe direction.
 */
export function existingWorktree(root: string, jobId: number, k: number): Worktree | null {
  const dir = path.join(root, '.kanban', 'worktrees', branchFor(jobId, k));
  if (!fs.existsSync(dir)) return null;
  // Read the branch off the checkout rather than deriving it: a collision on the remote may have
  // given the first attempt a suffixed name, and resuming onto the derived one would put the
  // session on a branch its own commits are not on.
  const on = git(dir, ['branch', '--show-current']);
  const branch = on.status === 0 && on.stdout.trim() ? on.stdout.trim() : branchFor(jobId, k);
  const baseLabel = baseRef(root);
  return { path: dir, branch, baseLabel, base: resolveBase(root, baseLabel) };
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
