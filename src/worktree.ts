import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { holderLiveness } from './liveness.ts';

/**
 * A checkout per attempt, and the sweep that takes it back.
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
 *
 * A third property is why `sweepWorktrees` exists: **a checkout is expensive**. A worker installs
 * the *target repository's* dependency tree in order to run its tests, so Phase 5's ten Jobs left
 * 6.1 GB in `.kanban/worktrees` — 614 MB each. Reclaim is what bounds that by
 * `maxConcurrent × repo size` instead of by `jobs-ever-run × repo size`, and reclaim cannot happen
 * at the end of a run: **"safe to delete" is a state a worktree enters later**, when its pull
 * request lands. So removal is a sweep, on the daemon's tick, and the run only ever tidies away a
 * checkout that never held anything.
 */

const git = (cwd: string, args: string[]) => spawnSync('git', args, { cwd, encoding: 'utf8' });
const short = (s: string) => (s || '').trim().split('\n').pop() || '';

/** A remote read has to be able to fail rather than hang: a sweep runs inside the daemon's tick. */
const NET_TIMEOUT_MS = 20_000;

/**
 * `ls-remote` over the network, never interactively.
 *
 * A sweep runs unattended in a detached daemon. Without these, a remote that wants credentials
 * blocks on a prompt nobody will ever answer, and the tick with it.
 */
const gitRemote = (cwd: string, args: string[]) => spawnSync('git', args, {
  cwd,
  encoding: 'utf8',
  timeout: NET_TIMEOUT_MS,
  env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: 'echo', SSH_ASKPASS: 'echo' },
});

export type Worktree = {
  path: string;
  branch: string;
  /** The ref we branched from, for the operator's benefit: `origin/main`. */
  baseLabel: string;
  /**
   * That ref **resolved to a commit, against the root repo**, and this is not a detail.
   * It is the fallback the keep-test counts from when a branch has never been pushed, and a
   * symbolic base is resolved *inside the worktree* — so in a repository with no remote, where the
   * base falls back to `HEAD`, `HEAD..HEAD` is always zero and a worktree full of commits reads as
   * empty. It would then be removed, and the commits with it. A sha cannot drift out from under
   * the question.
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

// ---------------------------------------------------------------- what exists only here

/**
 * Where this branch was last seen on a remote, as a ref, or null when nothing here has ever seen
 * it there.
 *
 * This is the whole difference between the two questions. "Is there work here" is answered by
 * counting from the base and is true of every successful Job. "Does this work exist **only** here"
 * is answered by counting from the last thing we pushed — and that record survives the branch
 * being deleted on the forge, because `git push` writes `refs/remotes/origin/<branch>` locally and
 * a branch deleted server-side does not remove it. Verified, not assumed: after another clone
 * squash-merged and deleted the branch, the pushing checkout still had the remote-tracking ref at
 * the pushed tip, and `origin/<branch>..HEAD` was 0.
 *
 * The upstream recorded by `git push -u` is preferred, since that is the ref the worker's own
 * protocol sets, and `origin/<branch>` is the fallback for a push that did not set one.
 */
function pushedRef(root: string, branch: string): string | null {
  const remote = git(root, ['config', '--get', `branch.${branch}.remote`]).stdout.trim();
  const merge = git(root, ['config', '--get', `branch.${branch}.merge`]).stdout.trim();
  const candidates: string[] = [];
  if (remote && merge) candidates.push(`refs/remotes/${remote}/${merge.replace(/^refs\/heads\//, '')}`);
  candidates.push(`refs/remotes/origin/${branch}`);
  for (const ref of candidates) {
    const r = git(root, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
    if (r.status === 0 && r.stdout.trim()) return ref;
  }
  return null;
}

/** What a checkout holds that would be destroyed with it. */
export type Held = {
  /** Uncommitted changes or untracked files. */
  dirty: boolean;
  /** Commits that exist nowhere but this checkout. */
  unpushed: number;
  /** The ref `unpushed` was counted from, or null when the branch has never been pushed. */
  pushedAt: string | null;
};

/**
 * Everything about this checkout that exists only here.
 *
 * Every unanswerable question answers "there is work here". A `rev-list` that fails, a base that
 * no longer resolves, a `status` that errors: none of them prove the checkout is empty, and the
 * only irreversible mistake available in this file is deleting the last copy of something.
 */
export function heldWork(root: string, wt: Worktree): Held {
  const status = git(wt.path, ['status', '--porcelain']);
  const dirty = status.status !== 0 || !!status.stdout.trim();
  const ref = pushedRef(root, wt.branch);
  // With no record of a push, every commit this branch carries is unpushed by definition, and the
  // base is the only floor available to count from.
  const from = ref ?? wt.base;
  const ahead = git(wt.path, ['rev-list', '--count', `${from}..HEAD`]);
  const n = Number(ahead.stdout.trim());
  return { dirty, unpushed: ahead.status === 0 && Number.isFinite(n) ? n : 1, pushedAt: ref };
}

/** Did the worker leave anything behind that exists nowhere else — unpushed commits, or a dirty tree? */
export function worktreeHasWork(root: string, wt: Worktree): boolean {
  const held = heldWork(root, wt);
  return held.dirty || held.unpushed > 0;
}

/** Why a checkout stays, and what the operator can do about it. Empty when nothing is held. */
export function whyKept(wt: Worktree, held: Held): string {
  const parts: string[] = [];
  if (held.dirty) {
    parts.push(`it has uncommitted changes or untracked files — see \`git -C ${wt.path} status\`, `
      + 'then commit and push them; it is swept once they are on the remote');
  }
  if (held.unpushed > 0) {
    const n = `${held.unpushed} commit${held.unpushed === 1 ? '' : 's'}`;
    parts.push(held.pushedAt
      ? `it holds ${n} that exist nowhere else — push them with \`git -C ${wt.path} push origin ${wt.branch}\``
      : `${n} on ${wt.branch} have never been pushed anywhere — push them with `
        + `\`git -C ${wt.path} push -u origin ${wt.branch}\`, or delete the checkout yourself with `
        + `\`git worktree remove --force ${wt.path}\` if they are not worth keeping`);
  }
  return parts.join('; ');
}

// ---------------------------------------------------------------- a run holds its checkout

/** A lock this module set, as opposed to one a human set by hand. The rest is the holder id. */
const LOCK_PREFIX = 'kb:';

/**
 * Say that a run is using this checkout, so a sweep cannot take it out from under a live worker.
 *
 * Until there was a sweep, the controller was the only thing that removed a worktree and no lock
 * was needed. That stopped being true the moment a second remover existed — and the two are not
 * even in the same process, since `kb run` in a checkout and `kb up` on a timer both reconcile the
 * same board. `git worktree remove` refuses a locked worktree without `--force`, and this module
 * never forces, so the lock is a real fence rather than a note.
 *
 * A `kb:` lock left by a process that is gone is taken over rather than respected: a daemon killed
 * mid-run would otherwise leave a checkout no sweep could ever reclaim, which is the bug this
 * whole file is about. A lock somebody set by hand is left alone, and the sweep says so.
 */
export function lockWorktree(root: string, wt: Worktree, holder: string): boolean {
  const reason = `${LOCK_PREFIX}${holder}`;
  if (git(root, ['worktree', 'lock', '--reason', reason, wt.path]).status === 0) return true;
  const current = lockedBy(root, wt.path);
  if (current === null || !current.startsWith(LOCK_PREFIX)) return false;
  git(root, ['worktree', 'unlock', wt.path]);
  return git(root, ['worktree', 'lock', '--reason', reason, wt.path]).status === 0;
}

/** The run is over. Non-zero here means "was not locked", which is not an event. */
export function unlockWorktree(root: string, wt: Worktree): void {
  git(root, ['worktree', 'unlock', wt.path]);
}

function lockedBy(root: string, dir: string): string | null {
  return listWorktrees(root).find((w) => samePath(w.path, dir))?.locked ?? null;
}

// ---------------------------------------------------------------- the sweep

export type WorktreeEntry = {
  path: string;
  /** Null when detached — which nothing here creates, so it is a reason to keep and not to guess. */
  branch: string | null;
  /** The lock reason, or null when unlocked. */
  locked: string | null;
  /** git says the directory is gone; only the admin record is left. */
  prunable: boolean;
};

/** `git worktree list --porcelain`, parsed. Blocks separated by a blank line, one key per line. */
export function listWorktrees(root: string): WorktreeEntry[] {
  const r = git(root, ['worktree', 'list', '--porcelain']);
  if (r.status !== 0) return [];
  const out: WorktreeEntry[] = [];
  let cur: WorktreeEntry | null = null;
  for (const line of r.stdout.split('\n')) {
    const [key, ...rest] = line.trim().split(' ');
    const value = rest.join(' ');
    if (key === 'worktree') {
      cur = { path: value, branch: null, locked: null, prunable: false };
      out.push(cur);
    } else if (!cur) continue;
    else if (key === 'branch') cur.branch = value.replace(/^refs\/heads\//, '');
    else if (key === 'locked') cur.locked = value;
    else if (key === 'prunable') cur.prunable = true;
  }
  return out;
}

/** Two paths naming the same directory, symlinked temp directories included. */
function samePath(a: string, b: string): boolean {
  if (path.resolve(a) === path.resolve(b)) return true;
  try {
    return fs.realpathSync(a) === fs.realpathSync(b);
  } catch {
    return false;
  }
}

export type SweepResult = { path: string; branch: string | null; removed: boolean; why: string };

/**
 * Every branch the remote still has, or null when we could not ask.
 *
 * Null is not "no branches" and the difference is the whole safety of the sweep: a remote that
 * cannot be reached proves nothing, and nothing is exactly what is needed to remove a checkout.
 * One call for the whole sweep rather than one per worktree — the daemon runs this on a timer.
 */
function remoteBranches(root: string): Set<string> | null {
  const r = gitRemote(root, ['ls-remote', '--heads', 'origin']);
  if (r.status !== 0) return null;
  const names = new Set<string>();
  for (const line of (r.stdout || '').split('\n')) {
    const m = /\srefs\/heads\/(.+)$/.exec(line);
    if (m) names.add(m[1].trim());
  }
  return names;
}

/**
 * Reclaim the checkouts whose work is provably somewhere else, and say why about each one that stays.
 *
 * The proof is deliberately narrow, and **the obvious test does not work here**: "every commit is
 * already on the default branch" is false for every merged branch in a repository that
 * squash-merges, because the squash is a new commit and the branch's own commits are ancestors of
 * nothing. Measured, on a scratch repository: after a squash merge, `merge-base --is-ancestor`
 * says no and `git cherry` agrees with it. A sweep built on that test would keep everything for
 * ever, which is the bug it is meant to fix.
 *
 * What actually proved safety during the Phase 5 cleanup, and what is used here:
 *
 *   - the tree is clean, and nothing on the branch is unpushed (`heldWork`), **and**
 *   - the branch is gone from the remote — the forge deletes it when the pull request lands.
 *
 * Both halves are needed. Clean-and-pushed alone would take a checkout whose pull request is still
 * open; branch-gone alone would take a branch that was never pushed in the first place, since a
 * branch nobody has ever pushed is also "not on the remote".
 */
export function sweepWorktrees(root: string, opts: { now?: () => Date } = {}): SweepResult[] {
  const now = opts.now ?? (() => new Date());
  const home = path.join(root, '.kanban', 'worktrees');
  const results: SweepResult[] = [];
  // Only ours. A worktree the operator made elsewhere is not this module's to reason about.
  const mine = listWorktrees(root).filter((w) => samePath(path.dirname(w.path), home));
  if (!mine.length) return results;

  const baseLabel = baseRef(root);
  const base = resolveBase(root, baseLabel);
  // Asked once, and only if something might be removable — a tick should not talk to the network
  // to discover that every checkout is dirty.
  let heads: Set<string> | null | undefined;

  for (const entry of mine) {
    const keep = (why: string) => results.push({ path: entry.path, branch: entry.branch, removed: false, why });

    if (entry.prunable || !fs.existsSync(entry.path)) {
      // The directory is already gone; leaving the admin record behind would fail the next
      // `worktree add` at that path with "already registered".
      git(root, ['worktree', 'prune']);
      results.push({ path: entry.path, branch: entry.branch, removed: true, why: 'the checkout was already gone — pruned its record' });
      continue;
    }

    if (entry.locked) {
      const holder = entry.locked.startsWith(LOCK_PREFIX) ? entry.locked.slice(LOCK_PREFIX.length) : null;
      if (!holder) {
        keep(`it is locked by hand (${entry.locked}) — \`git worktree unlock ${entry.path}\` when it is safe to reclaim`);
        continue;
      }
      // A live holder is a run in flight. `unknown` is a holder on another machine, and a sweep
      // that guessed "dead" there would delete a checkout another host is working in.
      //
      // The lock carries no timestamp, so `now()` stands in for when it was taken. That disables
      // only the reboot guard against a recycled pid — and a recycled pid reads as *alive*, which
      // keeps a checkout that could have gone. The error is in the safe direction, and the next
      // sweep after that pid exits gets it.
      const live = holderLiveness(holder, now());
      if (live !== 'dead') {
        keep(`a run holds it (${holder}) — it is swept after that run ends`);
        continue;
      }
    }

    if (!entry.branch) {
      keep(`it is not on a branch — \`git -C ${entry.path} status\` says what is there; remove it by hand once you know`);
      continue;
    }

    const wt: Worktree = { path: entry.path, branch: entry.branch, baseLabel, base };
    const held = heldWork(root, wt);
    if (held.dirty || held.unpushed > 0) {
      keep(whyKept(wt, held));
      continue;
    }

    if (heads === undefined) heads = remoteBranches(root);
    if (heads === null) {
      keep(`could not ask the remote whether ${entry.branch} still exists — \`git ls-remote --heads origin\` `
        + 'in this repository says why; the checkout stays until it can be asked');
      continue;
    }
    if (heads.has(entry.branch)) {
      keep(`${entry.branch} is still on the remote — its pull request has not landed yet`);
      continue;
    }

    const gone = removeWorktree(root, wt);
    results.push({
      path: entry.path,
      branch: entry.branch,
      removed: gone.removed,
      why: gone.removed ? `${entry.branch} is gone from the remote and the checkout was clean` : gone.why,
    });
  }
  return results;
}

/**
 * Remove the checkout when it holds nothing, and say so when it does.
 *
 * Never `--force`, in either sense: the lock is released first because this run is over, and the
 * removal itself is left to refuse. A worktree with work in it is the one thing here worth more
 * than tidiness — if a worker committed and the push failed, that directory is the only copy.
 *
 * Note what this does NOT decide: whether a checkout whose work is safely pushed should go. At the
 * end of a run that question has only one honest answer — the pull request has just been opened,
 * so the work is at its freshest and the branch is certainly still on the remote. `sweepWorktrees`
 * asks it later, which is when it can be answered.
 */
export function removeWorktree(root: string, wt: Worktree): { removed: boolean; why: string } {
  unlockWorktree(root, wt);
  if (!fs.existsSync(wt.path)) {
    git(root, ['worktree', 'prune']);
    return { removed: true, why: 'already gone' };
  }
  const held = heldWork(root, wt);
  if (held.dirty || held.unpushed > 0) return { removed: false, why: whyKept(wt, held) };
  const r = git(root, ['worktree', 'remove', wt.path]);
  if (r.status !== 0) {
    return {
      removed: false,
      why: `${short(r.stderr) || 'git refused'} — \`git worktree remove ${wt.path}\` in ${root} says the same thing with more room`,
    };
  }
  git(root, ['branch', '-D', wt.branch]);
  return { removed: true, why: 'clean' };
}
