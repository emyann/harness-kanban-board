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
 *   2. **Gitignored files do not come across.** `.hkb/` is gitignored, so a board file kept in the
 *      repository is invisible from a worker. That is by design — the controller owns every store write — and
 *      it must stay that way: copying the board in would give each worktree a divergent copy.
 *
 * Property 2 is also the feature's cost. A repository whose tests need a gitignored `.env` passes
 * for the human and fails in a worker, and it fails in a way that reads as the worker's fault. So
 * the repository may *declare* what it needs carried across: see `.worktreeinclude` below.
 *
 * A third property is why `sweepWorktrees` exists: **a checkout is expensive**. A worker installs
 * the *target repository's* dependency tree in order to run its tests, so Phase 5's ten Jobs left
 * 6.1 GB in `.hkb/worktrees` — 614 MB each. Reclaim is what bounds that by
 * `maxConcurrent × repo size` instead of by `jobs-ever-run × repo size`, and reclaim cannot happen
 * at the end of a run: **"safe to delete" is a state a worktree enters later**, when its pull
 * request lands. So removal is a sweep, on the daemon's tick, and the run only ever tidies away a
 * checkout that never held anything.
 *
 * The exception, and the one thing that can make a checkout safe to delete *at* the end of a run,
 * is a Job that said in advance what it would produce: `exportOutputs` moves those paths into the
 * repository first, and only then is the rest of the checkout litter. See ADR-008, and the note on
 * `removeWorktree` for what that is and is not allowed to waive.
 */

const git = (cwd: string, args: string[]) => spawnSync('git', args, { cwd, encoding: 'utf8' });
const short = (s: string) => (s || '').trim().split('\n').pop() || '';

/** A remote read has to be able to fail rather than hang: a sweep runs inside the daemon's tick. */
export const NET_TIMEOUT_MS = 20_000;

/**
 * What makes a git subprocess unable to ask a question.
 *
 * Every remote call hkb makes runs unattended — inside a detached daemon's tick, or between a
 * worker finishing and its attempt row being written. Without these, a remote that wants
 * credentials blocks on a prompt nobody will ever answer, and the whole pass with it. Exported
 * because `src/rebase.ts` talks to the same remote under the same rule.
 */
export const NET_ENV = { GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: 'echo', SSH_ASKPASS: 'echo' };

/** git over the network, never interactively. */
const gitRemote = (cwd: string, args: string[]) => spawnSync('git', args, {
  cwd,
  encoding: 'utf8',
  timeout: NET_TIMEOUT_MS,
  env: { ...process.env, ...NET_ENV },
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
 * Is this something we may hand to git as a ref?
 *
 * **A ref reaches `git` as a bare argv token, so a value beginning with `-` is an OPTION.** Measured:
 * `git fetch --quiet origin '--upload-pack=touch /tmp/x && git-upload-pack'` runs the command. A
 * base arrives from `hkb new --base`, from `hkb boards set --base`, and from the `base:` key of a
 * workflow file in the repository — the last of which is written by whoever wrote the repository,
 * which is not necessarily whoever is running hkb. Every sibling string flag is checked
 * (`checkExportPath`, `checkPluginPath`); this one was not.
 *
 * Conservative rather than exhaustive, and a pure predicate rather than `git check-ref-format`,
 * because handing the string to a subprocess is the thing being prevented. What is allowed is what
 * a branch, tag or sha actually looks like; everything else is refused by not being in the set.
 */
export function validRef(raw: unknown): boolean {
  if (typeof raw !== 'string') return false;
  const s = raw.trim();
  if (!s || s.length > 255) return false;
  // **The first character class is the security half**, and it is one expression rather than a
  // separate `startsWith('-')` line on purpose: the separate line was unreachable, no mutation of
  // it failed a test, and an inert guard that reads like the load-bearing one is how this project
  // has shipped three checks that did nothing. A ref must START with a letter or a digit, so
  // `--upload-pack=<cmd>` is not one.
  if (!/^[A-Za-z0-9][A-Za-z0-9._+/-]*$/.test(s)) return false;
  // git's own rules, for the handful a plain character class cannot express.
  if (s.includes('..') || s.includes('//') || s.endsWith('/') || s.endsWith('.') || s.endsWith('.lock')) return false;
  return true;
}

/** The same check, as a refusal that names the fix. For the two write points. */
export function checkRef(raw: string, flag: string): string {
  const s = raw.trim();
  if (validRef(s)) return s;
  const e = new Error(
    `${flag} wants a git ref — a branch, tag or commit, like \`origin/main\` or \`kb-33-1\`. `
    + `\`${raw}\` is not one${s.startsWith('-') ? ', and a value beginning with a dash would reach git as an option' : ''}.`,
  ) as Error & { exitCode: number };
  e.exitCode = 2;
  throw e;
}

/**
 * A branch name hkb itself makes, and therefore one hkb may force-push (`branchFor`, `freeBranch`).
 *
 * It exists for `fetchBase`, and the reason is the lease. See there.
 */
export function isAttemptBranch(name: string): boolean {
  return /^kb-\d+-\d+(-\d+)?$/.test(name);
}

/**
 * Does the remote have this branch, whether or not this clone has heard of it?
 *
 * Only ever asked on the way to a refusal, and only to make the refusal true. Because `fetchBase`
 * declines to refresh an attempt branch, `origin/kb-33-1` resolves here only if this working copy
 * already holds the ref — so a re-cloned `Board.repoPath`, a second checkout of the same remote, or
 * a pruned ref all produce "wait for the branch it names to be pushed" about a branch that is
 * pushed and sitting on the forge. One `ls-remote` is what makes the message say the true thing.
 */
export function onRemote(root: string, branch: string): boolean {
  const r = gitRemote(root, ['ls-remote', '--heads', 'origin', branch.replace(/^origin\//, '')]);
  return r.status === 0 && !!r.stdout.trim();
}

/**
 * The ref a checkout is actually cut from: what the Job asked for, or the repository's default.
 *
 * One fallback and no search path — and the REMOTE one is tried first, which is the correction that
 * matters. Preferring the local ref meant `fetchBase` updating `origin/develop` while the checkout
 * was cut from a local `develop` nobody had pulled for weeks: the fetch became a no-op for the ref
 * actually used, which is the exact staleness it was added to remove. `baseRef` already answers
 * `origin/<default>` for the same reason.
 *
 * The plain ref stays as the fallback because it is what a repository with no remote has, and what
 * a tag or a sha resolves to. A chain is unaffected either way: a parent branch is always pushed
 * before a child can name it.
 */
export function baseFor(root: string, want?: string | null): string {
  const asked = typeof want === 'string' && want.trim() ? want.trim() : null;
  if (!asked) return baseRef(root);
  // Anything we would not hand to git is returned untouched, for the caller to refuse by name.
  if (!validRef(asked)) return asked;
  const first = asked.startsWith('origin/') ? asked : `origin/${asked}`;
  if (resolves(root, first)) return first;
  if (resolves(root, asked)) return asked;
  // Neither resolves. Returned as written so the caller's refusal names what the operator typed.
  return asked;
}

/** Does this ref name a commit in this repository? */
export function resolves(root: string, ref: string): boolean {
  return git(root, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]).status === 0;
}

/**
 * What happened when we tried to refresh the base.
 *
 * `skipped` is the distinction the callers need and could not make: there are two ways not to fetch
 * and only one of them is worth a word. A repository with no remote and an attempt branch we refuse
 * to refresh are both **deliberate** — reporting them says "could not fetch the base" about a
 * decision, which on a chain step is every single pass. A network failure or a bad ref is not
 * deliberate and must be loud. Both call sites used to tell these apart by matching the message
 * text, which is a filter that silently stops working the next time a reason is added.
 */
export type FetchedBase = { fetched: boolean; skipped: boolean; why: string };

/**
 * Bring the base branch's remote-tracking ref up to date, so the base is what the remote agrees on
 * rather than what the operator last pulled.
 *
 * Nothing in hkb fetched before this, and `baseRef`/`resolveBase` only ever read local refs — so a
 * Job filed thirty seconds after a pull request landed was cut from a base that did not contain it,
 * and every line number it cited was already one merge stale. The daemon is the case that matters:
 * it runs for days on a machine nobody is pulling on.
 *
 * **Only the base branch, never `git fetch origin`.** Fetching everything would also update
 * `refs/remotes/origin/kb-<id>-<k>`, and that ref is exactly what `--force-with-lease` compares
 * against in `src/rebase.ts` — a blanket fetch would quietly hand back the protection the lease
 * exists to give.
 *
 * Best effort by construction: it returns what happened and no caller treats a failure as fatal. A
 * repository with no remote, an unreachable one, or one that wants credentials all mean the same
 * thing here — the local ref is the best answer available, which is the answer we had before.
 */
export function fetchBase(root: string, want?: string | null): FetchedBase {
  // Asked of the remote itself rather than inferred from the shape of the ref. The base used to be
  // `origin/<something>` whenever there was a remote, so "does it start with `origin/`" answered
  // this by accident; a Job may now name any ref, and a repository with no remote would have gone
  // to the network to be told so.
  if (git(root, ['remote', 'get-url', 'origin']).status !== 0) {
    return { fetched: false, skipped: true, why: 'no remote to fetch from' };
  }
  // A Job may write the base either way round — `kb-33-1` or `origin/kb-33-1` — and origin knows
  // only the former, so the prefix comes off before it is asked for.
  const asked = typeof want === 'string' && want.trim() ? want.trim() : null;
  if (asked !== null && !validRef(asked)) return { fetched: false, skipped: false, why: `\`${asked}\` is not a ref` };
  const ref = asked ?? baseRef(root);
  // An origin exists but names no default branch we can find — no `origin/HEAD`, no `origin/main`,
  // no `origin/master`, which is what `git remote add origin` on an existing repository leaves.
  // `baseRef` then answers `HEAD`, the LOCAL one, and `git fetch origin HEAD` would spend up to the
  // full network timeout every pass to refresh a ref nothing here reads and report success for it.
  if (ref === 'HEAD') {
    return { fetched: false, skipped: true, why: 'the base is a local ref — nothing to fetch for it' };
  }
  const branch = ref.replace(/^origin\//, '');

  // **Never an attempt branch, and this is the lease again.** Fetching `kb-33-1` updates
  // `refs/remotes/origin/kb-33-1`, which is exactly what `--force-with-lease` compares against when
  // Job 33's own attempt ends — so a chain step innocently refreshing its parent's branch would
  // turn its parent's lease into a plain `--force` and let it destroy a commit somebody pushed by
  // hand, with no refusal anywhere. `fetchBase` was already narrowed from a blanket fetch for this
  // reason; naming a `kb-*` branch as a base walked it back in through the front door.
  //
  // The cost is that a chain step may branch from a parent tip that is one hand-pushed commit
  // behind. That is the safe direction: stale work is recoverable and an overwritten commit is not.
  if (isAttemptBranch(branch)) {
    return {
      fetched: false,
      skipped: true,
      why: `${branch} is an attempt branch — not refreshed, because that ref is the lease`,
    };
  }

  const r = gitRemote(root, ['fetch', '--quiet', 'origin', branch]);
  if (r.status === 0) return { fetched: true, skipped: false, why: '' };
  return { fetched: false, skipped: false, why: short(r.stderr) || `git fetch origin ${branch} failed` };
}

/**
 * Make the attempt's checkout. Idempotent: an existing worktree at the path is reused, because a
 * retry that resumes a session should land in the tree that session was working in.
 *
 * Declared gitignored files are carried in on creation only. A resumed attempt lands in a tree the
 * previous one has been living in; re-copying would overwrite whatever it did to its own `.env`.
 */
export function createWorktree(root: string, jobId: number, k: number, want?: string | null): Worktree {
  // The DIRECTORY keeps the deterministic name so `existingWorktree` can find it without being
  // told; only the BRANCH disambiguates, and the attempt row records which one it got.
  const dir = path.join(root, '.hkb', 'worktrees', branchFor(jobId, k));
  const branch = freeBranch(root, jobId, k);
  const baseLabel = baseFor(root, want);
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
 * The repository's own hkb directory, and the one thing no pattern may reach.
 *
 * `.hkb/` holds the worktrees themselves, and a board file when `HKB_DATABASE_URL` points at one
 * here rather than at the machine board. The controller owns every store write; a worker with a
 * copy of the board would read state that stops being true the moment the controller moves, and
 * write into a file nothing ever reads back. And a worktree that copied the worktrees in would be
 * copying itself.
 */
const BOARD_DIR = '.hkb';

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
  // The second question is asked only about the paths the first one named: `.hkb/worktrees/` is
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
 * — `*.db`, `.hkb/**`, a bare globstar — is a pattern whose author did not mean what they
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

// ------------------------------------------------ what a Job takes back out, before the sandbox goes

/**
 * A declared export path, normalised — or a refusal.
 *
 * Bazel's rule, which ADR-008 adopts, is that the *known* outputs move out of the sandbox and the
 * rest is litter. A declaration is therefore a thing the board acts on with the operator's
 * authority: it names a source inside the worktree AND a destination inside the repository, and the
 * copy happens with no agent in the loop to sanity-check it. So the syntax is checked before it is
 * ever used — `..` and an absolute path are the two spellings of "somewhere else", and `.hkb/`
 * is the board's own directory, where a copy would land on top of the worktrees and the board file
 * itself.
 *
 * Refused, not silently dropped, and for the reason `refuseTheBoard` gives above: a path this wrong
 * is one whose author did not mean what they wrote, and the copy it produces is somebody's
 * afternoon.
 */
export function checkExportPath(raw: string): string {
  const rel = String(raw ?? '').trim();
  const refuse = (why: string): never => {
    const e = new Error(
      `${why} Declare a path inside the repository instead, as in \`--export .claude/skills/sdk-docs/\`.`,
    ) as Error & { exitCode: number };
    e.exitCode = 2;
    throw e;
  };
  if (!rel) refuse('an export path is empty — there is no file it could name.');
  if (path.isAbsolute(rel) || /^[a-zA-Z]:[\\/]/.test(rel)) {
    refuse(`the export path ${JSON.stringify(rel)} is absolute, so it points outside the worktree — a declared output is not a licence to write anywhere.`);
  }
  // A trailing separator is how a directory is usually written, and it means nothing to the copy.
  const norm = path.normalize(rel).replace(/[\\/]+$/, '');
  if (!norm || norm === '.') refuse(`the export path ${JSON.stringify(rel)} names the whole checkout rather than an output.`);
  if (/^\.\.([\\/]|$)/.test(norm)) {
    refuse(`the export path ${JSON.stringify(rel)} escapes the worktree — a declared output is not a licence to write anywhere.`);
  }
  if (norm === BOARD_DIR || norm.startsWith(`${BOARD_DIR}${path.sep}`)) {
    refuse(`the export path ${JSON.stringify(rel)} is inside ${BOARD_DIR}/ — the board's own directory, where the worktrees and the board file live, and never a place a Job writes.`);
  }
  // The other directory that is not an artifact. In a worktree `.git` is a *file* pointing at the
  // admin directory, and copying it over the repository's own `.git` is a way to break a checkout
  // in a manner nobody would connect back to an export declaration.
  if (norm === '.git' || norm.startsWith(`.git${path.sep}`)) {
    refuse(`the export path ${JSON.stringify(rel)} is inside .git — the repository's own plumbing, not something a Job produces.`);
  }
  return norm.split(path.sep).join('/');
}

/** What an attempt handed over, and what it owed and did not. */
export type ExportResult = {
  /** The paths that arrived at the destination, a declared directory expanded into its files. */
  exported: string[];
  /** Declared paths that were not in the checkout. Every one of these fails the attempt. */
  missing: string[];
};

/**
 * Move the declared outputs from the checkout into the repository. **Then** the sandbox may go.
 *
 * The order is the design and not an implementation detail: a worktree is the pod filesystem and
 * dies with the run, so an artifact that is still in it when it is removed was never produced. This
 * is Bazel's execroot, one machine, no artifact store — see ADR-008.
 *
 * A missing path is *returned*, not thrown: it is a fact about the run that the caller records on
 * the attempt, in the same shape as every other outcome. A path that is not a path — escaping,
 * absolute, reaching into the board — is thrown, because it was never a legal declaration and the
 * fix is to the Job rather than to the work.
 *
 * `from === to` is the un-isolated Job: the work already happened in the destination, so there is
 * nothing to move and the declaration is a check that it is there.
 *
 * **Nothing is copied until every declaration holds.** A shortfall fails the attempt, and a failed
 * attempt that has already written half of itself into the repository is the worse of the two
 * outcomes: the operator gets an artifact from a run nobody accepted, mixed into the tree with no
 * mark on it. Two passes — resolve, then copy — cost one extra `stat` per path.
 */
export function exportOutputs(from: string, to: string, declared: string[]): ExportResult {
  const inPlace = path.resolve(from) === path.resolve(to);
  const missing: string[] = [];
  /** Each declaration, resolved to the repo-relative files it stands for. */
  const plan: string[] = [];

  for (const raw of declared) {
    const rel = checkExportPath(raw);
    const src = path.join(from, rel);
    const st = fs.statSync(src, { throwIfNoEntry: false });
    if (!st) {
      missing.push(rel);
      continue;
    }
    refuseOutside(from, src, rel);
    if (!st.isDirectory()) {
      plan.push(rel);
      continue;
    }
    const files = filesUnder(from, src, rel);
    // An empty declared directory is still a produced directory — the declaration held, there was
    // simply nothing in it — so it is created at the destination rather than reported missing. The
    // trailing slash is how the record says "a directory, and it was empty".
    plan.push(...(files.length ? files : [`${rel}/`]));
  }
  if (missing.length) return { exported: [], missing };

  if (!inPlace) {
    for (const rel of plan) {
      if (rel.endsWith('/')) fs.mkdirSync(path.join(to, rel), { recursive: true });
      else copyOut(path.join(from, rel), path.join(to, rel));
    }
  }
  return { exported: plan, missing };
}

/** Overwrites: the artifact is the point, and a stale copy at the destination is not worth keeping. */
function copyOut(src: string, dest: string): void {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

/** Every file under a declared directory, repo-relative, depth-first in readdir order. */
function filesUnder(root: string, dir: string, rel: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const childRel = `${rel}/${entry.name}`;
    const child = path.join(dir, entry.name);
    refuseOutside(root, child, childRel);
    // `statSync` rather than the dirent, so a symlink is classified by what it points at — and
    // `refuseOutside` has already established that what it points at is inside the checkout.
    const st = fs.statSync(child, { throwIfNoEntry: false });
    if (!st) continue;
    if (st.isDirectory()) out.push(...filesUnder(root, child, childRel));
    else if (st.isFile()) out.push(childRel);
  }
  return out;
}

/**
 * The other half of the escape check, and the half a syntax rule cannot make.
 *
 * `..` and a leading `/` are how a *declaration* escapes; a symlink is how the filesystem does it
 * behind an innocent-looking one. `exports: ["out"]` where `out -> /etc` would otherwise copy `/etc`
 * into the repository. The question is asked of the resolved path, so it holds however it is spelled.
 */
function refuseOutside(root: string, p: string, rel: string): void {
  let real: string;
  let realRoot: string;
  try {
    real = fs.realpathSync(p);
    realRoot = fs.realpathSync(root);
  } catch {
    return; // Gone between the listing and the check: nothing to copy, and nothing to refuse either.
  }
  if (real === realRoot || real.startsWith(realRoot + path.sep)) return;
  const e = new Error(
    `the export path ${JSON.stringify(rel)} resolves to ${real}, outside the checkout — a symlink that `
    + 'leaves the worktree makes the copy a way to read anything on this machine. Export a real path '
    + 'inside the checkout instead.',
  ) as Error & { exitCode: number };
  e.exitCode = 2;
  throw e;
}

/**
 * The newest checkout this Job still has at or below `upTo`, or null.
 *
 * `existingWorktree` asks about one exact attempt, and every caller that resumes wants a different
 * question: *which checkout is still here*. The directory is named for the attempt that MADE it and
 * a kept checkout is reused by every attempt after it, so attempt 3 asking for `kb-N-2` finds
 * nothing while `kb-N-1` is sitting right there — and the caller then cuts a fresh worktree from
 * base and resumes a session on top of a tree that has none of its work. Counting down is the whole
 * fix, and it is bounded by the attempt number.
 */
export function newestWorktree(root: string, jobId: number, upTo: number, want?: string | null): Worktree | null {
  for (let k = upTo; k >= 1; k--) {
    const found = existingWorktree(root, jobId, k, want);
    if (found) return found;
  }
  return null;
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
 * as "ahead" when it is not — which errs toward keeping it, and keeping is the safe direction. It
 * is resolved against the Job's own base, because a resumed attempt of a Job that branched from an
 * integration branch must not be measured against the repository's default one.
 */
export function existingWorktree(root: string, jobId: number, k: number, want?: string | null): Worktree | null {
  const dir = path.join(root, '.hkb', 'worktrees', branchFor(jobId, k));
  if (!fs.existsSync(dir)) return null;
  // Read the branch off the checkout rather than deriving it: a collision on the remote may have
  // given the first attempt a suffixed name, and resuming onto the derived one would put the
  // session on a branch its own commits are not on.
  const on = git(dir, ['branch', '--show-current']);
  const branch = on.status === 0 && on.stdout.trim() ? on.stdout.trim() : branchFor(jobId, k);
  const baseLabel = baseFor(root, want);
  return { path: dir, branch, baseLabel, base: resolveBase(root, baseLabel) };
}

/** Resolve a ref to a commit **in the root repo**, never in the worktree. See `Worktree.base`. */
export function resolveBase(root: string, ref: string): string {
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
export function pushedRef(root: string, branch: string): string | null {
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
const LOCK_PREFIX = 'hkb:';

/**
 * Say that a run is using this checkout, so a sweep cannot take it out from under a live worker.
 *
 * Until there was a sweep, the controller was the only thing that removed a worktree and no lock
 * was needed. That stopped being true the moment a second remover existed — and the two are not
 * even in the same process, since `hkb run` in a checkout and `hkb up` on a timer both reconcile the
 * same board. `git worktree remove` refuses a locked worktree without `--force`, and this module
 * never forces, so the lock is a real fence rather than a note.
 *
 * A `hkb:` lock left by a process that is gone is taken over rather than respected: a daemon killed
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
  const home = path.join(root, '.hkb', 'worktrees');
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
 *
 * ---
 *
 * **`exported`, and what it is allowed to waive.** ADR-008's claim is that once a Job's *declared*
 * outputs have been copied into the repository, what is left in that checkout is litter **by
 * definition** — Bazel's exact argument for deleting the sandbox after moving the known outputs to
 * the execroot. That is a stronger statement than `heldWork` can make on its own, because
 * `heldWork` reads a filesystem and this reads a spec: a dirty tree is indistinguishable from an
 * artifact until something says which paths were the artifact.
 *
 * So the flag waives the **dirty** half of the guard, and only that half. It does not waive
 * `unpushed`, and the difference is not timidity: an untracked file is an output the Job either
 * declared or did not, whereas a commit is work that already has its own durable channel — a push —
 * and the run's own failure to take it is exactly when the checkout is the last copy. Deleting the
 * dirty tree of an export Job loses nothing it declared; deleting its commits loses history nobody
 * declared *because there was no way to*. Erring here is one-directional.
 *
 * Two things it deliberately does not do. It never fires for a Job that declared nothing — such a
 * checkout is judged exactly as it was before, dirty means kept — and it is not plumbed into
 * `sweepWorktrees`. The sweep sees checkouts, not Jobs: it has no declaration to read and no way to
 * learn one, and inventing a marker on disk would put a second source of truth outside the board.
 * The statement is made at the one moment and in the one place it is true — in the run that owns
 * the Job's spec, immediately after the copy.
 */
export function removeWorktree(
  root: string,
  wt: Worktree,
  opts: { exported?: boolean } = {},
): { removed: boolean; why: string } {
  unlockWorktree(root, wt);
  if (!fs.existsSync(wt.path)) {
    git(root, ['worktree', 'prune']);
    return { removed: true, why: 'already gone' };
  }
  const held = opts.exported ? { ...heldWork(root, wt), dirty: false } : heldWork(root, wt);
  if (held.dirty || held.unpushed > 0) return { removed: false, why: whyKept(wt, held) };
  // `--force` is what "litter by definition" costs: git refuses to remove a worktree with untracked
  // or modified files, and after the export that is precisely the state the checkout is meant to be
  // deleted in. It cannot reach a commit — `unpushed` was checked one line above, and is checked
  // for an export Job exactly as it is for any other.
  const r = git(root, ['worktree', 'remove', ...(opts.exported ? ['--force'] : []), wt.path]);
  if (r.status !== 0) {
    return {
      removed: false,
      why: `${short(r.stderr) || 'git refused'} — \`git worktree remove ${wt.path}\` in ${root} says the same thing with more room`,
    };
  }
  git(root, ['branch', '-D', wt.branch]);
  return { removed: true, why: 'clean' };
}
