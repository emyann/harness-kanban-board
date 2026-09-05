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
 *
 * Property 2 is also the feature's cost. A repository whose tests need a gitignored `.env` passes
 * for the human and fails in a worker, and it fails in a way that reads as the worker's fault. So
 * the repository may *declare* what it needs carried across: see `.worktreeinclude` below.
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
 *
 * Declared gitignored files are carried in on creation only. A resumed attempt lands in a tree the
 * previous one has been living in; re-copying would overwrite whatever it did to its own `.env`.
 */
export function createWorktree(root: string, jobId: number, k: number): Worktree {
  // The DIRECTORY keeps the deterministic name so `existingWorktree` can find it without being
  // told; only the BRANCH disambiguates, and the attempt row records which one it got.
  const dir = path.join(root, '.kanban', 'worktrees', branchFor(jobId, k));
  const branch = freeBranch(root, jobId, k);
  const baseLabel = baseRef(root);
  const base = resolveBase(root, baseLabel);
  if (fs.existsSync(dir)) return { path: dir, branch, baseLabel, base };

  // Resolved BEFORE the checkout exists, so a `.worktreeinclude` that reaches the board is refused
  // without leaving half a worktree behind for the operator to clean up.
  const carry = includedFiles(root);

  fs.mkdirSync(path.dirname(dir), { recursive: true });
  // `-B` rather than `-b`: a branch left behind by a removed worktree must not fail the next
  // attempt. The branch is ours, named after the attempt, and nothing else may be on it.
  const r = git(root, ['worktree', 'add', '-B', branch, dir, base]);
  if (r.status !== 0) {
    const e = new Error(`could not create a worktree for #${jobId} attempt ${k}: ${short(r.stderr)}`) as Error & { exitCode: number };
    e.exitCode = 2;
    throw e;
  }
  copyIncluded(root, dir, carry);
  return { path: dir, branch, baseLabel, base };
}

// ------------------------------------------------------------- what a repository asks to carry in

/** `.gitignore` syntax, at the repository root. Claude Code's name for the same idea, and its shape. */
export const INCLUDE_FILE = '.worktreeinclude';

/**
 * The board's own directory, and the one thing no pattern may reach.
 *
 * `.kanban/` holds `board.db`, its WAL, the daemon's pid files and the worktrees themselves. The
 * controller owns every store write; a worker with a copy of the board would read state that stops
 * being true the moment the controller moves, and write into a file nothing ever reads back.
 */
const BOARD_DIR = '.kanban';

const nulList = (s: string) => s.split('\0').filter(Boolean);

/**
 * The gitignored files this repository has declared it needs in a worktree.
 *
 * The rule is Claude Code's: a file is carried in only if it **matches a pattern in
 * `.worktreeinclude` and is itself gitignored**, so a tracked file is never duplicated into the
 * checkout that already contains it. Both halves are asked of git rather than reimplemented — a
 * second `.gitignore` matcher in this repository would be a second set of bugs, and this one is
 * exactly the matcher the patterns were written against:
 *
 *   - `--exclude-standard` lists the files git already considers ignored;
 *   - `--exclude-from=.worktreeinclude` lists the untracked files the declaration matches;
 *   - `--others` means neither list can contain a tracked file at all.
 *
 * The intersection is the answer. One deviation from the documented Claude Code behaviour, on
 * purpose: there, a globstar-leading pattern reaches inside a wholly-ignored directory only when
 * the first name after the globstar is one of that directory's own path segments. Git has no such
 * rule, so a globstar pattern finds `vendor/deep/config.json` here, and the operator does not have
 * to know a matcher quirk to write a pattern that works.
 */
export function includedFiles(root: string): string[] {
  const declaration = path.join(root, INCLUDE_FILE);
  if (!fs.existsSync(declaration)) return [];

  const matched = lsFiles(root, `--exclude-from=${declaration}`, `read ${INCLUDE_FILE}`);
  if (!matched.length) return [];
  // The second question is asked only about the paths the first one named: `.kanban/worktrees/` is
  // itself gitignored, so an unbounded listing walks every earlier attempt's checkout — `node_modules`
  // and all — to answer a question about three files. The exception is a declaration broad enough
  // that naming its matches would overflow argv, where the walk is the cheaper of the two.
  // `:(literal)` because a path is a path: a file called `:weird` is not pathspec magic.
  const narrow = matched.map((f) => `:(literal)${f}`);
  const tooMany = narrow.reduce((n, s) => n + s.length + 1, 0) > 100_000;
  const listed = lsFiles(root, '--exclude-standard', 'list the gitignored files', tooMany ? [] : narrow);
  const wanted = new Set(matched);
  const files = tooMany ? listed.filter((f) => wanted.has(f)) : listed;

  refuseTheBoard(files);
  return files;
}

/** Untracked files that `rule` selects, relative to `root`, in git's own ignore syntax. */
function lsFiles(root: string, rule: string, doing: string, paths: string[] = []): string[] {
  const r = git(root, ['ls-files', '-z', '--others', '--ignored', rule, ...(paths.length ? ['--', ...paths] : [])]);
  if (r.status !== 0) {
    const e = new Error(
      `could not ${doing} in ${root}: ${short(r.stderr) || 'git failed'}. ` +
        `Fix or remove ${INCLUDE_FILE} at the repository root, then retry.`,
    ) as Error & { exitCode: number };
    e.exitCode = 2;
    throw e;
  }
  return nulList(r.stdout);
}

/**
 * Refuse a declaration that would carry the board into a worker's checkout.
 *
 * Refuse, rather than quietly drop the offending path: a pattern broad enough to catch `board.db`
 * — `*.db`, `.kanban/**`, a bare globstar — is a pattern whose author did not mean what they
 * wrote, and the copy it produces is somebody's afternoon. The guard is on the resolved *paths*,
 * not on the pattern text, so it holds however the pattern is spelled.
 */
function refuseTheBoard(files: string[]): void {
  const reached = files.filter((f) => f === BOARD_DIR || f.startsWith(`${BOARD_DIR}/`));
  if (!reached.length) return;
  const e = new Error(
    `${INCLUDE_FILE} matches ${reached[0]}${reached.length > 1 ? ` (and ${reached.length - 1} more)` : ''}, ` +
      `inside ${BOARD_DIR}/ — the board's own state, which never crosses into a worktree: the controller owns ` +
      `every store write, and a worker's copy would diverge from it the moment the controller moved. ` +
      `Narrow the pattern in ${INCLUDE_FILE} so it cannot reach ${BOARD_DIR}/ — name the files you ` +
      `meant, as in \`config/secrets.json\`, rather than a pattern that sweeps the tree — then retry.`,
  ) as Error & { exitCode: number };
  e.exitCode = 2;
  throw e;
}

/**
 * Copy the declared files into a fresh checkout. Returns what actually arrived.
 *
 * A destination that already exists is left alone. Nothing gitignored can be in a fresh checkout,
 * so a collision means the base commit tracks that path — and overwriting it would be exactly the
 * duplication the match rule exists to prevent.
 */
export function copyIncluded(root: string, dest: string, files: string[] = includedFiles(root)): string[] {
  const arrived: string[] = [];
  for (const rel of files) {
    const to = path.join(dest, rel);
    if (fs.existsSync(to)) continue;
    const from = path.join(root, rel);
    if (!fs.statSync(from, { throwIfNoEntry: false })?.isFile()) continue;
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
    arrived.push(rel);
  }
  return arrived;
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
