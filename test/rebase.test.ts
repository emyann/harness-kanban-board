import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import type { Runtime, RuntimeEvent, WorkerOutcome, WorkerSpec } from '../src/runtime/index.ts';

/**
 * Rebase-and-verify: `docs/rebuild-plan.md` item 10's cheap half.
 *
 * Exercised against a real remote — a bare repository on disk with two clones of it — rather than
 * against a double, for the same reason `test/worktree.test.ts` is: every interesting case here is
 * git's own behaviour. Whether `--force-with-lease` refuses, whether an aborted rebase really
 * leaves the branch where it was, whether a fetch of one branch touches another: a double would
 * answer all three the way the author expected instead of the way git does, which is exactly the
 * shape of bug this file exists to catch.
 */

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hkb-rebase-'));
// A scratch board, migrated the way production is, for the controller test at the end.
process.env.HKB_DATABASE_URL = `file:${path.join(dir, 'test.db')}`;
const PKG = path.resolve(import.meta.dirname, '..');
execFileSync(process.execPath, ['node_modules/prisma/build/index.js', 'migrate', 'deploy'], {
  cwd: PKG, env: process.env, stdio: 'ignore',
});

const { openBoard, closeBoard } = await import('../src/db.ts');
const { reconcile } = await import('../src/controller.ts');
const {
  rebaseOntoBase, rebasePlan, rebaseNote, conflictReason, conflictedPaths, pushRefused,
} = await import('../src/rebase.ts');
const {
  createWorktree, baseFor, baseRef, checkRef, fetchBase, heldWork, isAttemptBranch, validRef,
} = await import('../src/worktree.ts');
const { withSandbox } = await import('../src/brief.ts');
const { JOB_FIELDS } = await import('../src/inputs.ts');

const git = (cwd: string, args: string[]) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} in ${cwd}: ${r.stderr || r.stdout}`);
  return r.stdout.trim();
};
const at = (cwd: string, ref: string) => git(cwd, ['rev-parse', ref]);

/** A remote, and a clone with a first commit on `main`. */
function makeRemote(name: string): { origin: string; repo: string; other: string } {
  const origin = path.join(dir, `${name}.git`);
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  // Built rather than cloned: cloning an empty bare repository works and warns about it on every
  // call, and twenty of those buries the assertions this file is here for.
  const seed = path.join(dir, `${name}-seed`);
  fs.mkdirSync(seed);
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: seed });
  git(seed, ['remote', 'add', 'origin', origin]);
  git(seed, ['config', 'user.email', 'rb@test']);
  git(seed, ['config', 'user.name', 'rb']);
  fs.writeFileSync(path.join(seed, 'README.md'), 'one\ntwo\nthree\n');
  fs.writeFileSync(path.join(seed, 'other.txt'), 'untouched\n');
  git(seed, ['add', '-A']);
  git(seed, ['commit', '-qm', 'base']);
  git(seed, ['push', '-q', '-u', 'origin', 'main']);

  const repo = path.join(dir, name);
  execFileSync('git', ['clone', '-q', origin, repo]);
  git(repo, ['config', 'user.email', 'rb@test']);
  git(repo, ['config', 'user.name', 'rb']);
  // A second checkout of the same remote: this is how the base moves under a running attempt,
  // which is the whole scenario. Nothing in `repo` knows it happened until something fetches.
  const other = path.join(dir, `${name}-other`);
  execFileSync('git', ['clone', '-q', origin, other]);
  git(other, ['config', 'user.email', 'rb@test']);
  git(other, ['config', 'user.name', 'rb']);
  return { origin, repo, other };
}

/** Somebody else's pull request lands: `main` moves on the remote. */
function moveMain(other: string, file: string, text: string, msg: string): string {
  git(other, ['fetch', '-q', 'origin', 'main']);
  git(other, ['checkout', '-q', '-B', 'main', 'origin/main']);
  fs.writeFileSync(path.join(other, file), text);
  git(other, ['add', '-A']);
  git(other, ['commit', '-qm', msg]);
  git(other, ['push', '-q', 'origin', 'main']);
  return at(other, 'HEAD');
}

/** What a worker does: commit on its branch and push it. */
function work(wtPath: string, file: string, text: string, msg: string): void {
  fs.writeFileSync(path.join(wtPath, file), text);
  git(wtPath, ['add', '-A']);
  git(wtPath, ['commit', '-qm', msg]);
}

test.after(async () => { await closeBoard(); fs.rmSync(dir, { recursive: true, force: true }); });

// ---------------------------------------------------------------- the pure decision

test('rebasePlan: a branch already on the base is left alone', () => {
  const p = rebasePlan({ label: 'origin/main', ahead: 3, onBase: true, pushed: true, mayRewrite: true });
  assert.equal(p.act, 'nothing');
  assert.match(p.why, /already on origin\/main/);
});

test('rebasePlan: a branch with nothing committed on it is left alone', () => {
  // The base moved AND the branch is behind it — but there is nothing to replay, so replaying
  // would rewrite a branch and spend a force-push to produce the base itself.
  const p = rebasePlan({ label: 'origin/main', ahead: 0, onBase: false, pushed: false, mayRewrite: true });
  assert.equal(p.act, 'nothing');
  assert.match(p.why, /nothing was committed/);
});

test('rebasePlan: commits plus a base that moved is the one case that rebases', () => {
  const p = rebasePlan({ label: 'origin/main', ahead: 2, onBase: false, pushed: true, mayRewrite: true });
  assert.equal(p.act, 'rebase');
  assert.match(p.why, /moved/);
});

test('rebasePlan: a pushed branch under a pull request nobody may rewrite is left alone', () => {
  // The safety argument for rewriting an attempt branch is that the PR is a draft nobody has read.
  // ADR-010's gate suspends an attempt precisely so somebody DOES read it.
  const p = rebasePlan({ label: 'origin/main', ahead: 2, onBase: false, pushed: true, mayRewrite: false });
  assert.equal(p.act, 'nothing');
  assert.match(p.why, /no longer a draft/);
});

test('rebasePlan: an unpushed branch needs nobody\'s permission, there being no remote history to rewrite', () => {
  const p = rebasePlan({ label: 'origin/main', ahead: 2, onBase: false, pushed: false, mayRewrite: false });
  assert.equal(p.act, 'rebase');
});

test('conflictedPaths reads the STATE, because git\'s wording for it moved between 2.43 and 2.55', () => {
  assert.deepEqual(conflictedPaths(' M README.md\n?? new.txt\n'), [], 'dirty is not conflicted');
  assert.deepEqual(conflictedPaths('UU README.md\n M other.txt\n'), ['README.md']);
  // Every unmerged code, not just the one that is easy to remember.
  assert.deepEqual(
    conflictedPaths('DD a\nAU b\nUD c\nUA d\nDU e\nAA f\nUU g\n'),
    ['a', 'b', 'c', 'd', 'e', 'f', 'g'],
  );
});

test('pushRefused: a lease refusal is the Job\'s problem, an unreachable remote is ours', () => {
  assert.equal(pushRefused(' ! [rejected]        kb-1-1 -> kb-1-1 (stale info)'), true);
  assert.equal(pushRefused("fatal: '/nope.git' does not appear to be a git repository"), false);
  assert.equal(pushRefused(''), false);
});

test('conflictReason: the CONFLICT lines are what a reader needs, not the --continue paragraph', () => {
  const out = [
    'Auto-merging README.md',
    'CONFLICT (content): Merge conflict in README.md',
    'error: could not apply 1234567... do the thing',
    'hint: Resolve all conflicts manually, mark them as resolved with',
    'hint: "git add/rm <conflicted_files>", then run "git rebase --continue".',
  ].join('\n');
  assert.equal(conflictReason(out), 'CONFLICT (content): Merge conflict in README.md');
});

test('conflictReason: many conflicts are capped, because this lands in a 300-character column', () => {
  const out = ['a', 'b', 'c', 'd', 'e'].map((f) => `CONFLICT (content): Merge conflict in ${f}.md`).join('\n');
  const why = conflictReason(out);
  assert.match(why, /\(\+2 more\)$/);
  assert.ok(why.length < 300, why);
});

test('conflictReason: a refusal that is not a conflict still says something true', () => {
  const out = 'error: cannot rebase: You have unstaged changes.\n';
  assert.match(conflictReason(out), /unstaged changes/);
  assert.equal(conflictReason(''), 'git gave no reason');
});

// ---------------------------------------------------------------- the fetch

test('fetchBase brings the base up to date — nothing did before, so every base was as stale as the last pull', () => {
  const { repo, other } = makeRemote('fetch');
  const moved = moveMain(other, 'other.txt', 'moved\n', 'somebody else landed');
  assert.notEqual(at(repo, 'origin/main'), moved, 'the clone has not heard about it yet');

  const r = fetchBase(repo);
  assert.equal(r.fetched, true);
  assert.equal(at(repo, 'origin/main'), moved);
});

test('fetchBase fetches the BASE branch only, so --force-with-lease keeps its meaning', () => {
  // The guard: a blanket `git fetch origin` would refresh `refs/remotes/origin/kb-*` too, and the
  // lease compares the remote against exactly that ref — refreshing it turns the lease into a
  // plain `--force` and the protection is gone silently.
  const { repo, other } = makeRemote('fetch-scope');
  const wt = createWorktree(repo, 1, 1);
  work(wt.path, 'README.md', 'one\nmine\nthree\n', 'mine');
  git(wt.path, ['push', '-q', '-u', 'origin', wt.branch]);
  const ours = at(repo, `refs/remotes/origin/${wt.branch}`);

  // Somebody else moves BOTH the base and our branch on the remote.
  moveMain(other, 'other.txt', 'moved\n', 'landed');
  git(other, ['fetch', '-q', 'origin', wt.branch]);
  git(other, ['checkout', '-q', '-B', wt.branch, `origin/${wt.branch}`]);
  fs.writeFileSync(path.join(other, 'stranger.txt'), 'not ours\n');
  git(other, ['add', '-A']);
  git(other, ['commit', '-qm', 'a stranger pushed']);
  git(other, ['push', '-q', 'origin', wt.branch]);

  fetchBase(repo);
  assert.equal(at(repo, `refs/remotes/origin/${wt.branch}`), ours, 'the attempt branch ref is untouched');
});

test('with no remote there is nothing to fetch, and that is not a failure', () => {
  const solo = path.join(dir, 'solo');
  fs.mkdirSync(solo);
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: solo });
  git(solo, ['config', 'user.email', 'rb@test']);
  git(solo, ['config', 'user.name', 'rb']);
  fs.writeFileSync(path.join(solo, 'a.txt'), 'a\n');
  git(solo, ['add', '-A']);
  git(solo, ['commit', '-qm', 'a']);
  assert.equal(baseRef(solo), 'HEAD');
  assert.equal(fetchBase(solo).fetched, false);
  assert.match(fetchBase(solo).why, /no remote/);
});

// ---------------------------------------------------------------- the happy paths

test('a base that has not moved costs one merge-base and rewrites nothing', () => {
  const { repo } = makeRemote('current');
  const wt = createWorktree(repo, 1, 1);
  work(wt.path, 'new.txt', 'work\n', 'work');
  const before = at(wt.path, 'HEAD');

  const r = rebaseOntoBase(repo, wt);
  assert.equal(r.kind, 'current');
  assert.equal(at(wt.path, 'HEAD'), before, 'the branch is untouched');
});

test('a branch that never committed is not rebased, whatever the base did', () => {
  const { repo, other } = makeRemote('empty');
  const wt = createWorktree(repo, 1, 1);
  moveMain(other, 'other.txt', 'moved\n', 'landed');

  const r = rebaseOntoBase(repo, wt);
  assert.equal(r.kind, 'current');
  assert.match(r.kind === 'current' ? r.why : '', /nothing was committed/);
});

test('a base that moved is replayed onto, and the remote is brought along', () => {
  const { origin, repo, other } = makeRemote('replay');
  const wt = createWorktree(repo, 7, 1);
  work(wt.path, 'mine.txt', 'mine\n', 'my work');
  git(wt.path, ['push', '-q', '-u', 'origin', wt.branch]);
  const moved = moveMain(other, 'other.txt', 'theirs\n', 'somebody else landed');

  const r = rebaseOntoBase(repo, wt);
  assert.equal(r.kind, 'rebased');
  assert.equal(r.kind === 'rebased' && r.pushed, true);
  assert.equal(git(wt.path, ['rev-parse', 'HEAD~1']), moved, 'our commit now sits on their commit');
  assert.equal(at(origin, wt.branch), at(wt.path, 'HEAD'), 'and the remote has what the reviewer will read');
  assert.equal(fs.readFileSync(path.join(wt.path, 'other.txt'), 'utf8'), 'theirs\n', 'their change is in the tree');
});

test('a branch nobody pushed is rebased and left alone — no remote state is invented for it', () => {
  const { origin, repo, other } = makeRemote('unpushed');
  const wt = createWorktree(repo, 8, 1);
  work(wt.path, 'mine.txt', 'mine\n', 'my work');
  moveMain(other, 'other.txt', 'theirs\n', 'landed');

  const r = rebaseOntoBase(repo, wt);
  assert.equal(r.kind, 'rebased');
  assert.equal(r.kind === 'rebased' && r.pushed, false);
  assert.equal(
    spawnSync('git', ['rev-parse', '--verify', '--quiet', wt.branch], { cwd: origin }).status,
    1,
    'the remote never heard of this branch and still has not',
  );
});

test('uncommitted work rides along, because exports and results are legitimate output', () => {
  const { repo, other } = makeRemote('autostash');
  const wt = createWorktree(repo, 9, 1);
  work(wt.path, 'mine.txt', 'mine\n', 'my work');
  // The shape a Job with `exports` or `results` ends in: a real file, deliberately uncommitted.
  fs.writeFileSync(path.join(wt.path, 'report.md'), 'the answer\n');
  moveMain(other, 'other.txt', 'theirs\n', 'landed');

  const r = rebaseOntoBase(repo, wt);
  assert.equal(r.kind, 'rebased');
  assert.equal(fs.readFileSync(path.join(wt.path, 'report.md'), 'utf8'), 'the answer\n', 'still there');
});

// ---------------------------------------------------------------- the refusals

test('a branch that will not replay REFUSES, and leaves the branch exactly as the worker left it', () => {
  const { origin, repo, other } = makeRemote('conflict');
  const wt = createWorktree(repo, 3, 1);
  work(wt.path, 'README.md', 'one\nMINE\nthree\n', 'my line');
  git(wt.path, ['push', '-q', '-u', 'origin', wt.branch]);
  const before = at(wt.path, 'HEAD');
  const remoteBefore = at(origin, wt.branch);
  moveMain(other, 'README.md', 'one\nTHEIRS\nthree\n', 'their line');

  const r = rebaseOntoBase(repo, wt);
  assert.equal(r.kind, 'conflict');
  assert.match(r.kind === 'conflict' ? r.why : '', /README\.md/, 'and it names the file that collided');

  assert.equal(at(wt.path, 'HEAD'), before, 'the branch is where it was');
  assert.equal(at(origin, wt.branch), remoteBefore, 'and so is the remote');
  assert.equal(git(wt.path, ['status', '--porcelain']), '', 'no half-applied rebase left in the tree');
  assert.equal(
    fs.existsSync(path.join(repo, '.git', 'worktrees', path.basename(wt.path), 'rebase-merge')),
    false,
    'and no rebase in progress for the operator to discover',
  );
});

test('a remote somebody else moved is REFUSED by the lease, rather than overwritten', () => {
  // `--force-with-lease` is the whole safety argument for the controller rewriting a pushed branch.
  // A test that only ever pushes onto a remote nobody touched proves nothing about it.
  const { origin, repo, other } = makeRemote('lease');
  const wt = createWorktree(repo, 4, 1);
  work(wt.path, 'mine.txt', 'mine\n', 'my work');
  git(wt.path, ['push', '-q', '-u', 'origin', wt.branch]);

  // A stranger adds to our branch on the remote, and the base moves too so a rebase is wanted.
  git(other, ['fetch', '-q', 'origin', wt.branch]);
  git(other, ['checkout', '-q', '-B', wt.branch, `origin/${wt.branch}`]);
  fs.writeFileSync(path.join(other, 'stranger.txt'), 'not ours\n');
  git(other, ['add', '-A']);
  git(other, ['commit', '-qm', 'a stranger pushed']);
  git(other, ['push', '-q', 'origin', wt.branch]);
  const strangers = at(origin, wt.branch);
  moveMain(other, 'other.txt', 'theirs\n', 'landed');

  const r = rebaseOntoBase(repo, wt);
  assert.equal(r.kind, 'rejected');
  assert.equal(at(origin, wt.branch), strangers, 'the stranger\'s commit is still on the remote');
});

test('a replay whose autostash does not come back BLOCKS, and pushes nothing — git exits 0 there', () => {
  // The trap this exists for: `rebase --autostash` that replays every commit and then cannot
  // reapply the stash exits **0**, leaving an unmerged index with conflict markers and the worker's
  // uncommitted output in an unnamed stash entry. Believing the exit code means reporting success
  // and force-pushing over it.
  const { origin, repo, other } = makeRemote('autostash-conflict');
  const wt = createWorktree(repo, 11, 1);
  work(wt.path, 'mine.txt', 'mine\n', 'my work');
  git(wt.path, ['push', '-q', '-u', 'origin', wt.branch]);
  const remoteBefore = at(origin, wt.branch);
  // Uncommitted, and on the same line the base is about to move: the legitimate `exports` shape.
  fs.writeFileSync(path.join(wt.path, 'README.md'), 'one\nMINE\nthree\n');
  moveMain(other, 'README.md', 'one\nTHEIRS\nthree\n', 'their line');

  const r = rebaseOntoBase(repo, wt);
  const state = `git ${git(repo, ['--version'])}; status:\n${git(wt.path, ['status', '--porcelain'])}\n`
    + `stash: ${git(wt.path, ['stash', 'list'])}`;
  assert.equal(r.kind, 'autostash', `not \`rebased\` — git said 0 and it is not what happened. ${state}`);
  assert.equal(at(origin, wt.branch), remoteBefore, 'and nothing was pushed over it');
  assert.match(
    git(wt.path, ['stash', 'list']),
    /autostash/,
    'the uncommitted work is still recoverable, which is what the message has to say',
  );
});

test('a remote we could not REACH does not fail the attempt — that is our fault, not the work\'s', () => {
  const { repo, other } = makeRemote('unreachable');
  const wt = createWorktree(repo, 12, 1);
  work(wt.path, 'mine.txt', 'mine\n', 'my work');
  git(wt.path, ['push', '-q', '-u', 'origin', wt.branch]);
  moveMain(other, 'other.txt', 'theirs\n', 'landed');
  git(repo, ['fetch', '-q', 'origin', 'main']);
  // The remote goes away between the run and the push: a timeout, an auth blip, a forge outage.
  git(repo, ['remote', 'set-url', 'origin', path.join(dir, 'gone.git')]);

  const r = rebaseOntoBase(repo, wt);
  assert.equal(r.kind, 'unpushed', 'not `rejected` — nothing refused us, we never arrived');
  assert.ok(r.staleBase, 'and the fetch that failed first is not swallowed either');
});

test('a pull request out of draft stops the rewrite dead, because that is the safety argument', () => {
  const { origin, repo, other } = makeRemote('reviewed');
  const wt = createWorktree(repo, 13, 1);
  work(wt.path, 'mine.txt', 'mine\n', 'my work');
  git(wt.path, ['push', '-q', '-u', 'origin', wt.branch]);
  const before = at(origin, wt.branch);
  moveMain(other, 'other.txt', 'theirs\n', 'landed');

  const r = rebaseOntoBase(repo, wt, { mayRewrite: false });
  assert.equal(r.kind, 'current');
  assert.match(r.kind === 'current' ? r.why : '', /no longer a draft/);
  assert.equal(at(origin, wt.branch), before, 'a reviewer\'s comments still line up with the commits');
  assert.equal(at(wt.path, 'HEAD'), before, 'and the local branch was not split off from them either');
});

test('a rebased checkout does not then read as holding the base\'s own commits', () => {
  // `wt.base` is the floor the sweep counts unpushed work from. Left at the OLD base after a
  // replay, every commit the new base brought is counted as work that exists only here — an
  // inflated "push them" message and a checkout kept for ever on it.
  const { repo, other } = makeRemote('held');
  const wt = createWorktree(repo, 14, 1);
  work(wt.path, 'mine.txt', 'mine\n', 'my work');
  moveMain(other, 'other.txt', 'theirs\n', 'landed');

  const r = rebaseOntoBase(repo, wt);
  assert.equal(r.kind, 'rebased');
  assert.equal(heldWork(repo, wt).unpushed, 1, 'one commit is ours; the base\'s is not');
});

// ---------------------------------------------------------------- the base as a spec field

test('baseFor: nothing asked for is the repository\'s default branch', () => {
  const { repo } = makeRemote('base-default');
  assert.equal(baseFor(repo), 'origin/main');
  assert.equal(baseFor(repo, null), 'origin/main');
  assert.equal(baseFor(repo, '  '), 'origin/main', 'a blank is an absence, not a ref named " "');
});

test('baseFor: a plain name means the REMOTE branch, so the fetch is not a no-op for it', () => {
  // Preferring the local ref made `fetchBase` pointless for a plain-name base: it refreshed
  // `origin/develop` while the checkout was cut from a local `develop` nobody had pulled. On a
  // daemon host nobody pulls on, that is a Job built on a weeks-old tree reported as current.
  const { repo, other } = makeRemote('base-ladder');
  const wt = createWorktree(repo, 1, 1);
  work(wt.path, 'mine.txt', 'mine\n', 'my work');
  git(wt.path, ['push', '-q', '-u', 'origin', wt.branch]);

  assert.equal(baseFor(repo, wt.branch), `origin/${wt.branch}`, 'the pushed branch, which is what merges');

  // A ref with no remote counterpart still resolves — a tag, a sha, a local-only branch.
  git(repo, ['tag', 'v1']);
  assert.equal(baseFor(repo, 'v1'), 'v1');
  assert.equal(baseFor(repo, 'origin/main'), 'origin/main', 'an origin/ ref is tried as written');

  // And once the sweep takes the checkout and its local branch, the remote one still answers.
  moveMain(other, 'unrelated.txt', 'x\n', 'unrelated');
  git(repo, ['worktree', 'remove', '--force', wt.path]);
  git(repo, ['branch', '-D', wt.branch]);
  assert.equal(baseFor(repo, wt.branch), `origin/${wt.branch}`);
});

test('validRef refuses what git would read as an OPTION rather than a ref', () => {
  // Measured: `git fetch --quiet origin '--upload-pack=touch /tmp/x && git-upload-pack'` runs the
  // command. A base arrives from a flag, from `boards set`, and from the `base:` key of a workflow
  // file in the repository — written by whoever wrote the repository.
  assert.equal(validRef('--upload-pack=touch /tmp/PWNED && git-upload-pack'), false);
  assert.equal(validRef('-foo'), false, 'any leading dash at all');
  assert.equal(validRef('--exec=sh'), false);
  // Other things that are not refs.
  for (const bad of ['', '   ', 'a b', 'a..b', 'a//b', 'a/', 'a.', 'x.lock', 'a;rm -rf /', '$(id)', 'a\nb', 42, null]) {
    assert.equal(validRef(bad as string), false, `refused: ${String(bad)}`);
  }
  // And what a ref actually looks like.
  for (const ok of ['main', 'origin/main', 'kb-33-1', 'origin/kb-33-1-2', 'release/2.1', 'v1.0.0', 'a1b2c3d']) {
    assert.equal(validRef(ok), true, `allowed: ${ok}`);
  }
});

test('checkRef refuses at the boundary, and says why a dash is not a typo', () => {
  assert.throws(() => checkRef('--upload-pack=sh', '--base'), (e: Error & { exitCode?: number }) => {
    assert.equal(e.exitCode, 2);
    assert.match(e.message, /--base wants a git ref/);
    assert.match(e.message, /would reach git as an option/);
    return true;
  });
  assert.equal(checkRef('  origin/main  ', '--base'), 'origin/main', 'and it trims what it accepts');
});

test('fetchBase NEVER refreshes an attempt branch — that ref is somebody else\'s lease', () => {
  // The trap this closes, and it is the round-one blanket-fetch bug walking back in through the
  // front door: a chain step whose base is `kb-33-1` fetching that branch updates
  // `refs/remotes/origin/kb-33-1`, which is exactly what `--force-with-lease` compares against when
  // Job 33's own attempt ends. Its lease would then pass over a commit somebody pushed by hand.
  const { repo, other } = makeRemote('lease-via-base');
  const wt = createWorktree(repo, 33, 1);
  work(wt.path, 'mine.txt', 'mine\n', 'my work');
  git(wt.path, ['push', '-q', '-u', 'origin', wt.branch]);
  const ours = at(repo, `refs/remotes/origin/${wt.branch}`);

  // A human pushes a fixup onto Job 33's branch while it is still running.
  git(other, ['fetch', '-q', 'origin', wt.branch]);
  git(other, ['checkout', '-q', '-B', wt.branch, `origin/${wt.branch}`]);
  fs.writeFileSync(path.join(other, 'fixup.txt'), 'by hand\n');
  git(other, ['add', '-A']);
  git(other, ['commit', '-qm', 'a human fixed something']);
  git(other, ['push', '-q', 'origin', wt.branch]);

  // A chain step claims, naming that branch as its base.
  const r = fetchBase(repo, wt.branch);
  assert.equal(r.fetched, false);
  assert.equal(r.skipped, true, 'a decision, not a failure — it must not read as one in the log');
  assert.match(r.why, /attempt branch/);
  assert.equal(at(repo, `refs/remotes/origin/${wt.branch}`), ours, 'the lease still sees what it pushed');

  assert.equal(isAttemptBranch('kb-33-1'), true);
  assert.equal(isAttemptBranch('kb-33-1-2'), true, 'including a suffixed one from a name collision');
  assert.equal(isAttemptBranch('main'), false);
  assert.equal(isAttemptBranch('kb-feature'), false, 'a human branch that merely starts kb- is not ours');
});

test('a Job branching from another Job\'s branch starts from its commits — the belt', async () => {
  const { origin, repo } = makeRemote('belt');
  const db = openBoard();
  const board = await db.board.upsert({
    where: { slug: 'belt' }, update: { repoPath: repo }, create: { slug: 'belt', repoPath: repo },
  });
  const first = await db.job.create({ data: { boardId: board.id, name: 'step one', brief: 'write it' } });

  const runtime = (file: string, text: string): Runtime => ({
    name: 'step',
    async run(spec: WorkerSpec, onEvent?: (e: RuntimeEvent) => void): Promise<WorkerOutcome> {
      const branch = git(spec.cwd, ['branch', '--show-current']);
      work(spec.cwd, file, text, `wrote ${file}`);
      git(spec.cwd, ['push', '-q', '-u', 'origin', branch]);
      onEvent?.({ kind: 'ended', taskId: spec.taskId, status: 'completed' });
      return {
        status: 'completed', ok: true, sessionId: `s-${spec.taskId}`, text: 'done', costUsd: 0,
        turns: 1, durationMs: 0, stopReason: 'end_turn', denials: 0, error: null,
      };
    },
  });

  await reconcile({ runtime: runtime('one.txt', 'one\n'), cwd: repo, board: 'belt', readPr: false });
  const firstBranch = (await db.job.findUniqueOrThrow({
    where: { id: first.id }, include: { attempts: true },
  })).attempts[0].branch ?? '';
  assert.ok(firstBranch, 'step one pushed a branch');

  // Step two is filed pointing at step one's branch. This is the whole feature: a coding Job's
  // output is a branch, and until now there was nowhere to say "start from that one".
  const second = await db.job.create({
    data: { boardId: board.id, name: 'step two', brief: 'add to it', base: firstBranch },
  });
  await reconcile({ runtime: runtime('two.txt', 'two\n'), cwd: repo, board: 'belt', readPr: false });

  const done = await db.job.findUniqueOrThrow({ where: { id: second.id }, include: { attempts: true } });
  assert.equal(done.phase, 'succeeded');
  // Asserted on the REMOTE, not in the checkout: a clean pushed worktree is swept at the end of the
  // run, and what a reviewer opens is the branch anyway.
  const tree = git(origin, ['ls-tree', '--name-only', done.attempts[0].branch ?? '']);
  assert.match(tree, /one\.txt/, 'step two is standing on step one\'s work, not on origin/main');
  assert.match(tree, /two\.txt/, 'and it added its own');
});

test('a base that names nothing FAILS the Job before a session is bought', async () => {
  const { repo } = makeRemote('bad-base');
  const db = openBoard();
  const board = await db.board.upsert({
    where: { slug: 'bad-base' }, update: { repoPath: repo }, create: { slug: 'bad-base', repoPath: repo },
  });
  const job = await db.job.create({
    data: { boardId: board.id, name: 'nowhere', brief: 'do it', base: 'kb-999-1' },
  });

  let ran = 0;
  const runtime: Runtime = {
    name: 'never',
    async run(): Promise<WorkerOutcome> {
      ran += 1;
      throw new Error('the runtime must not be reached — the base was checked first');
    },
  };
  await reconcile({ runtime, cwd: repo, board: 'bad-base', readPr: false });

  const after = await db.job.findUniqueOrThrow({ where: { id: job.id }, include: { attempts: true } });
  assert.equal(ran, 0, 'nothing was spent');
  assert.equal(after.phase, 'failed', 'not pending — retrying against a ref that does not exist is a loop');
  assert.equal(after.attempts[0].outcome, 'no_input', 'the same value a declared input that cannot be read gets');
  assert.match(after.lastError ?? '', /kb-999-1/, 'and it names the ref that was asked for');
  assert.match(after.lastError ?? '', /origin\/kb-999-1/, 'including the fallback it also tried');
});

test('a repository whose origin names no default branch does not go to the network for HEAD', () => {
  // `git remote add origin` on an existing repository leaves no `origin/HEAD`, no `origin/main` and
  // no `origin/master`, so `baseRef` answers `HEAD` — the LOCAL ref. Testing for a remote instead of
  // for the shape of the ref made that `git fetch origin HEAD`: up to the full network timeout every
  // pass, refreshing nothing anything here reads, and reporting success for it.
  const bare = path.join(dir, 'headless.git');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'trunk', bare]);
  const repo = path.join(dir, 'headless');
  fs.mkdirSync(repo);
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
  git(repo, ['config', 'user.email', 'rb@test']);
  git(repo, ['config', 'user.name', 'rb']);
  git(repo, ['remote', 'add', 'origin', bare]);
  fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n');
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-qm', 'a']);

  assert.equal(baseRef(repo), 'HEAD', 'there is an origin, but nothing on it we can name');
  const r = fetchBase(repo);
  assert.equal(r.skipped, true, 'declined, not attempted');
  assert.equal(r.fetched, false, 'and certainly not reported as done');
});

test('declining to fetch is not reported as failing to', () => {
  // Two ways not to fetch and only one is worth a word. Reporting a decision as "could not refresh
  // the base" puts a false warning on every pass of every chain step — and the callers used to tell
  // these apart by matching the message text, a filter that stops working the next time a reason is
  // added.
  const { repo } = makeRemote('quiet-skip');
  const wt = createWorktree(repo, 51, 1);
  work(wt.path, 'mine.txt', 'mine\n', 'my work');
  git(wt.path, ['push', '-q', '-u', 'origin', wt.branch]);

  const step = createWorktree(repo, 52, 1, wt.branch);
  const r = rebaseOntoBase(repo, step);
  assert.equal(r.staleBase, undefined, 'the attempt-branch skip is silent');
  assert.equal(rebaseNote(52, step, r), null, 'so there is nothing to say about it');

  // And a repository with no remote is the other deliberate one.
  const solo = path.join(dir, 'solo-skip');
  fs.mkdirSync(solo);
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: solo });
  git(solo, ['config', 'user.email', 'rb@test']);
  git(solo, ['config', 'user.name', 'rb']);
  fs.writeFileSync(path.join(solo, 'a.txt'), 'a\n');
  git(solo, ['add', '-A']);
  git(solo, ['commit', '-qm', 'a']);
  assert.equal(fetchBase(solo).skipped, true);
});

test('a base that has gone does not kill an attempt RESUMING in a checkout it already has', async () => {
  // A chain step's parent branch is deleted the moment its pull request merges. A fresh checkout
  // genuinely cannot be cut then — but a resumed attempt continues in a tree that already exists
  // and asks the base for nothing, so failing it is killing a Job over a question nobody asked.
  const { repo } = makeRemote('gone-base');
  const db = openBoard();
  const board = await db.board.upsert({
    where: { slug: 'gone-base' }, update: { repoPath: repo }, create: { slug: 'gone-base', repoPath: repo },
  });
  // A parent branch that exists for exactly as long as it takes attempt 1 to start.
  git(repo, ['branch', 'parent-branch', 'main']);
  git(repo, ['push', '-q', 'origin', 'parent-branch']);
  const job = await db.job.create({
    data: { boardId: board.id, name: 'two goes', brief: 'do it', base: 'parent-branch' },
  });

  const attempts: number[] = [];
  const runtime: Runtime = {
    name: 'two-goes',
    async run(spec: WorkerSpec, onEvent?: (e: RuntimeEvent) => void): Promise<WorkerOutcome> {
      attempts.push(spec.attempt);
      if (spec.attempt === 1) {
        work(spec.cwd, 'partway.txt', 'partway\n', 'partway');
        onEvent?.({ kind: 'ended', taskId: spec.taskId, status: 'max_turns' });
        return {
          status: 'max_turns', ok: false, sessionId: 'g-1', text: 'partway', costUsd: 0, turns: 1,
          durationMs: 0, stopReason: 'max_turns', denials: 0, error: null,
        };
      }
      onEvent?.({ kind: 'ended', taskId: spec.taskId, status: 'completed' });
      return {
        status: 'completed', ok: true, sessionId: 'g-2', text: 'done', costUsd: 0, turns: 1,
        durationMs: 0, stopReason: 'end_turn', denials: 0, error: null,
      };
    },
  };

  await reconcile({ runtime, cwd: repo, board: 'gone-base', readPr: false });
  // The parent lands and its branch is deleted, both sides, exactly as a merged PR does.
  git(repo, ['push', '-q', 'origin', '--delete', 'parent-branch']);
  git(repo, ['branch', '-D', 'parent-branch']);
  await reconcile({ runtime, cwd: repo, board: 'gone-base', readPr: false });

  assert.deepEqual(attempts, [1, 2], 'the second attempt ran');
  assert.equal((await db.job.findUniqueOrThrow({ where: { id: job.id } })).phase, 'succeeded');
});

test('a chain step is told the right things about its parent branch, by the controller', async () => {
  // `withSandbox` is tested directly above; this is the half that binds it. The controller decides
  // whether the worker may fetch and what it rebases onto, and both were wrong in a way no unit
  // test of the renderer could see. At the shipped defaults: nothing here configures the gate.
  const { repo } = makeRemote('advice');
  const db = openBoard();
  const board = await db.board.upsert({
    where: { slug: 'advice' }, update: { repoPath: repo }, create: { slug: 'advice', repoPath: repo },
  });
  const first = await db.job.create({ data: { boardId: board.id, name: 'one', brief: 'write it' } });

  const specs: WorkerSpec[] = [];
  const runtime: Runtime = {
    name: 'capturing',
    async run(spec: WorkerSpec, onEvent?: (e: RuntimeEvent) => void): Promise<WorkerOutcome> {
      specs.push(spec);
      const branch = git(spec.cwd, ['branch', '--show-current']);
      work(spec.cwd, `f${spec.taskId}.txt`, 'x\n', 'work');
      git(spec.cwd, ['push', '-q', '-u', 'origin', branch]);
      onEvent?.({ kind: 'ended', taskId: spec.taskId, status: 'completed' });
      return {
        status: 'completed', ok: true, sessionId: `a-${spec.taskId}`, text: 'done', costUsd: 0,
        turns: 1, durationMs: 0, stopReason: 'end_turn', denials: 0, error: null,
      };
    },
  };

  await reconcile({ runtime, cwd: repo, board: 'advice', readPr: false });
  const parent = (await db.job.findUniqueOrThrow({
    where: { id: first.id }, include: { attempts: true },
  })).attempts[0].branch ?? '';

  // The trunk Job: fetch its base, rebase onto it, and nothing about a forge.
  assert.match(specs[0].prompt, /git fetch origin main/, 'a trunk Job refreshes its own base');
  assert.doesNotMatch(specs[0].prompt, /pull request/i, 'the core stopped asking for one');
  // And the one rule it does not merely ask for: the trunk is the trunk, and this worker owns one
  // branch. Read off the spec the runtime is handed, because that is what builds the gate.
  assert.deepEqual(
    specs[0].admission?.push,
    { branch: `kb-${first.id}-1`, defaultBranch: 'main' },
    'the push gate is wired at the shipped defaults, not only when a test asks for it',
  );

  await db.job.create({
    data: {
      boardId: board.id, name: 'two', brief: 'add to it', base: parent,
      // The fact that used to be `BaseAdvice.prBase`, as data a step's own content can read.
      inputs: ['where=self:base'],
    },
  });
  await reconcile({ runtime, cwd: repo, board: 'advice', readPr: false });

  const step = specs[1].prompt;
  assert.match(step, new RegExp(`git rebase origin/${parent}`), 'the chain step still rebases');
  assert.doesNotMatch(step, /git fetch/, 'but fetches nothing — that ref is its parent\'s lease');
  assert.match(step, new RegExp(`### \`where\`  \\(self:base\\)[\\s\\S]*origin/${parent}`),
    '`self:base` is the ref the checkout was actually cut from — the parent branch, not the trunk');
});

test('a base that is on the REMOTE but not in this clone says so, instead of "wait for it"', async () => {
  // `fetchBase` will not refresh an attempt branch, so `origin/kb-*` resolves only if this working
  // copy already holds the ref. A re-cloned repoPath or a pruned ref then produced "wait for the
  // branch it names to be pushed" about a branch sitting on the forge — which sends the operator to
  // look in entirely the wrong place.
  const { repo, other } = makeRemote('remote-only');
  const db = openBoard();
  const board = await db.board.upsert({
    where: { slug: 'remote-only' }, update: { repoPath: repo }, create: { slug: 'remote-only', repoPath: repo },
  });
  // A branch that exists on the remote and that `repo` has never fetched.
  git(other, ['checkout', '-q', '-b', 'kb-77-1']);
  fs.writeFileSync(path.join(other, 'theirs.txt'), 'theirs\n');
  git(other, ['add', '-A']);
  git(other, ['commit', '-qm', 'elsewhere']);
  git(other, ['push', '-q', 'origin', 'kb-77-1']);

  const job = await db.job.create({
    data: { boardId: board.id, name: 'chained', brief: 'do it', base: 'kb-77-1' },
  });
  const runtime: Runtime = { name: 'never', async run(): Promise<WorkerOutcome> { throw new Error('unreachable'); } };
  await reconcile({ runtime, cwd: repo, board: 'remote-only', readPr: false });

  const after = await db.job.findUniqueOrThrow({ where: { id: job.id } });
  assert.equal(after.phase, 'failed');
  assert.match(after.lastError ?? '', /IS on the remote/, 'the true thing, not the plausible one');
  assert.match(after.lastError ?? '', /git -C .* fetch origin kb-77-1/, 'and the command that fixes it');
  assert.doesNotMatch(after.lastError ?? '', /Wait for the branch/);
});

test('the refusal names a fallback only when there was one, and clears the session', async () => {
  const { repo } = makeRemote('msg');
  const db = openBoard();
  const board = await db.board.upsert({
    where: { slug: 'msg' }, update: { repoPath: repo }, create: { slug: 'msg', repoPath: repo },
  });
  // A base already written `origin/…` is tried as given, so there is no second form to name — the
  // message used to read "neither `origin/foo` nor `origin/foo`".
  const job = await db.job.create({
    data: {
      boardId: board.id, name: 'nowhere', brief: 'do it', base: 'origin/nope',
      // A session left over from a resumable stop. A terminal failure must not keep it.
      lastSessionId: 'stale-session', suspendedFor: 'something',
    },
  });
  const runtime: Runtime = { name: 'never', async run(): Promise<WorkerOutcome> { throw new Error('unreachable'); } };
  const lines: string[] = [];
  await reconcile({ runtime, cwd: repo, board: 'msg', readPr: false, onEvent: (l) => lines.push(l) });

  const after = await db.job.findUniqueOrThrow({ where: { id: job.id } });
  assert.equal(after.phase, 'failed');
  // `say` prefixes `#<id>` already, so the message must not carry one too — the operator was
  // reading `#40 #40 asks to branch from …`. The JOB ROW is the other way round: nothing prefixes
  // that, so it must carry the id.
  assert.ok(lines.some((l) => /asks to branch from/.test(l)), 'it was said');
  assert.ok(!lines.some((l) => /#\d+ #\d+/.test(l)), 'and said once');
  assert.match(after.lastError ?? '', /^#\d+ asks to branch from/, 'the row still names the Job');
  assert.doesNotMatch(after.lastError ?? '', /origin\/origin/, 'no doubled prefix');
  assert.equal((after.lastError ?? '').match(/origin\/nope/g)?.length, 1, 'named once, not twice');
  assert.equal(after.lastSessionId, null, 'a terminal failure drops the session, like every other one');
  assert.equal(after.suspendedFor, null);
});

test('a Job\'s branch is rebased onto ITS base, never the repository\'s default', async () => {
  // The belt would come apart here: a step cut from the previous step's branch, rebased onto
  // origin/main at the end of its run, arrives back at the trunk carrying the other step's commits
  // as its own diff — which is the opposite of what it was filed to do.
  const { repo, other } = makeRemote('rebase-onto-base');
  const wt = createWorktree(repo, 1, 1);
  work(wt.path, 'trunk.txt', 'one\n', 'step one');
  git(wt.path, ['push', '-q', '-u', 'origin', wt.branch]);

  // A second step, branched from the first.
  const step2 = createWorktree(repo, 2, 1, wt.branch);
  assert.equal(step2.baseLabel, `origin/${wt.branch}`, 'a plain name means the pushed branch');
  work(step2.path, 'two.txt', 'two\n', 'step two');
  // Meanwhile the trunk moves, and step one's branch gains a commit of its own.
  moveMain(other, 'trunk-only.txt', 'trunk moved\n', 'someone landed');
  work(wt.path, 'one-more.txt', 'more\n', 'step one, again');
  git(wt.path, ['push', '-q', 'origin', wt.branch]);

  const r = rebaseOntoBase(repo, step2);
  assert.equal(r.kind, 'rebased');
  assert.equal(r.kind === 'rebased' && r.label, `origin/${wt.branch}`, 'onto step one, not onto origin/main');
  assert.equal(
    fs.existsSync(path.join(step2.path, 'one-more.txt')), true,
    'so it picked up step one\'s newer commit',
  );
  assert.equal(
    fs.existsSync(path.join(step2.path, 'trunk-only.txt')), false,
    'and not the trunk\'s, which it was never based on',
  );
});

// ---------------------------------------------------------------- the prompt half

test('the sandbox contract asks the worker to rebase before it finishes', () => {
  // It used to say "before you PUSH", which was true while the core told every worker to push.
  // Whether a Job pushes is a workflow's business now (ADR-017 decision 5); whether its branch is on
  // the base when the attempt ends is the machinery's, so that is what is asked for.
  const p = withSandbox('do the thing', 'kb-1-1', { rebaseOnto: 'origin/main' });
  assert.match(p, /Before you finish, rebase onto the base/);
  assert.ok(p.indexOf('git rebase origin/main') > p.indexOf('Commit it on'), 'after the commit it rebases');
  assert.match(p, /3\. Reply with one line/, 'the steps are renumbered rather than repeating a number');
  assert.doesNotMatch(p, /git push/, 'and pushing is not one of them');
});

test('the contract does not ask a worker to fetch a branch that is somebody\'s lease', () => {
  // The third direction this hole has been opened from: `fetchBase` refuses to refresh an attempt
  // branch, and the prompt then asked the worker to do it — inside a worktree, whose ref store is
  // the parent repo's.
  const p = withSandbox('do it', 'kb-34-1', { rebaseOnto: 'origin/kb-33-1', fetch: false });
  assert.match(p, /git rebase origin\/kb-33-1/, 'it still rebases');
  assert.doesNotMatch(p, /git fetch/, 'and it fetches nothing at all');
  assert.match(p, /do NOT fetch it first/, 'said out loud, so it does not read as an omission');
});

test('where the review opens is no longer the core\'s to say — the base is data instead', () => {
  // `BaseAdvice.prBase` wrote "open it against `kb-33-1`" into prose that only a pull request step
  // could use, in a core that no longer knows whether this Job opens one. The fact survives as
  // `self:base` (`src/inputs.ts`), where a workflow's own steps can ask for it.
  const p = withSandbox('do it', 'kb-34-1', { rebaseOnto: 'origin/kb-33-1', fetch: false });
  assert.doesNotMatch(p, /pull request/i);
  assert.doesNotMatch(p, /--base/);
  assert.ok((JOB_FIELDS as readonly string[]).includes('base'), 'and it is a field a Job may read about itself');
});

test('the contract never asks for a BLANKET fetch, which would undo the lease it is paired with', () => {
  // A worktree shares its parent's ref store, so `git fetch origin` inside one updates
  // `refs/remotes/origin/kb-<id>-<k>` — the exact ref `--force-with-lease` compares against.
  // `fetchBase` narrows itself for this reason; asking the worker to widen it again gives it back.
  const p = withSandbox('do the thing', 'kb-1-1', { rebaseOnto: 'origin/main' });
  assert.match(p, /git fetch origin main\b/, 'the base branch, by name');
  assert.doesNotMatch(p, /git fetch origin(?!\s+\S)/, 'and never a bare `git fetch origin`');
});

test('a repository with no remote is not told to fetch one', () => {
  const p = withSandbox('do the thing', 'kb-1-1', { rebaseOnto: 'HEAD' });
  assert.doesNotMatch(p, /git fetch origin/);
  assert.match(p, /2\. Reply with one line/, 'and the steps close back up');
});

// ---------------------------------------------------------------- through the controller, at the shipped defaults

test('a Job whose base moved under it FAILS as conflicted, keeps its checkout, and says what to do', async () => {
  const { repo, other } = makeRemote('ctl');
  const db = openBoard();
  const board = await db.board.upsert({
    where: { slug: 'rebase' }, update: { repoPath: repo }, create: { slug: 'rebase', repoPath: repo },
  });
  const job = await db.job.create({
    data: { boardId: board.id, name: 'collide', brief: 'edit the readme' },
  });

  /** A worker that edits the same line somebody else is about to land. */
  const runtime: Runtime = {
    name: 'colliding',
    async run(spec: WorkerSpec, onEvent?: (e: RuntimeEvent) => void): Promise<WorkerOutcome> {
      const branch = git(spec.cwd, ['branch', '--show-current']);
      work(spec.cwd, 'README.md', 'one\nMINE\nthree\n', 'my line');
      git(spec.cwd, ['push', '-q', '-u', 'origin', branch]);
      // …and while this session was running, somebody else's pull request landed on the same line.
      moveMain(other, 'README.md', 'one\nTHEIRS\nthree\n', 'their line');
      onEvent?.({ kind: 'ended', taskId: spec.taskId, status: 'completed' });
      return {
        status: 'completed', ok: true, sessionId: 'x-1', text: 'done', costUsd: 0, turns: 1,
        durationMs: 0, stopReason: 'end_turn', denials: 0, error: null,
      };
    },
  };

  const lines: string[] = [];
  await reconcile({ runtime, cwd: repo, board: 'rebase', readPr: false, onEvent: (l) => lines.push(l) });

  const after = await db.job.findUniqueOrThrow({
    where: { id: job.id }, include: { attempts: true },
  });
  assert.equal(after.phase, 'failed');
  assert.equal(after.attempts[0].outcome, 'conflicted', 'not no_output — the work is fine, the base moved');
  assert.match(after.lastError ?? '', /conflicts with origin\/main/);
  assert.match(after.lastError ?? '', /README\.md/, 'which file');
  assert.match(after.lastError ?? '', /git -C .* rebase origin\/main/, 'and the command that fixes it');
  assert.match(after.lastError ?? '', /push --force-with-lease/);

  const wtPath = path.join(repo, '.hkb', 'worktrees', `kb-${job.id}-1`);
  assert.equal(fs.existsSync(wtPath), true, 'the checkout to rebase IN is still there');
  assert.ok(lines.some((l) => /rebase it there/.test(l)), 'and the operator was told so');
});

test('a resumed attempt is NOT asked to rebase — on a pushed branch the step has no legal ending', async () => {
  // Rebase then `git push -u`, on a branch already on the remote, is a non-fast-forward rejection —
  // and the next rule in the same protocol forbids the force that would fix it. The controller
  // rebases that case itself after the run instead.
  const { repo } = makeRemote('resumed');
  const db = openBoard();
  const board = await db.board.upsert({
    where: { slug: 'resumed' }, update: { repoPath: repo }, create: { slug: 'resumed', repoPath: repo },
  });
  const job = await db.job.create({ data: { boardId: board.id, name: 'twice', brief: 'do it twice' } });

  const prompts: string[] = [];
  const runtime: Runtime = {
    name: 'two-goes',
    async run(spec: WorkerSpec, onEvent?: (e: RuntimeEvent) => void): Promise<WorkerOutcome> {
      prompts.push(spec.prompt);
      const branch = git(spec.cwd, ['branch', '--show-current']);
      if (spec.attempt === 1) {
        work(spec.cwd, 'mine.txt', 'partway\n', 'partway');
        git(spec.cwd, ['push', '-q', '-u', 'origin', branch]);
        onEvent?.({ kind: 'ended', taskId: spec.taskId, status: 'max_turns' });
        return {
          status: 'max_turns', ok: false, sessionId: 's-1', text: 'partway', costUsd: 0, turns: 1,
          durationMs: 0, stopReason: 'max_turns', denials: 0, error: null,
        };
      }
      onEvent?.({ kind: 'ended', taskId: spec.taskId, status: 'completed' });
      return {
        status: 'completed', ok: true, sessionId: 's-2', text: 'done', costUsd: 0, turns: 1,
        durationMs: 0, stopReason: 'end_turn', denials: 0, error: null,
      };
    },
  };

  await reconcile({ runtime, cwd: repo, board: 'resumed', readPr: false });
  await reconcile({ runtime, cwd: repo, board: 'resumed', readPr: false });

  assert.equal(prompts.length, 2, 'it really did run twice');
  assert.match(prompts[0], /git rebase origin\/main/, 'the first attempt, on a branch nobody has pushed, is asked');
  assert.doesNotMatch(prompts[1], /git rebase origin\/main/, 'the second, resuming on a pushed branch, is not');
  assert.equal((await db.job.findUniqueOrThrow({ where: { id: job.id } })).phase, 'succeeded');
});

test('a remote that went away does not fail a Job whose work is already on it', async () => {
  const { repo, other } = makeRemote('ctl-unreachable');
  const db = openBoard();
  const board = await db.board.upsert({
    where: { slug: 'unreachable' }, update: { repoPath: repo }, create: { slug: 'unreachable', repoPath: repo },
  });
  const job = await db.job.create({ data: { boardId: board.id, name: 'offline', brief: 'add a file' } });

  const runtime: Runtime = {
    name: 'then-offline',
    async run(spec: WorkerSpec, onEvent?: (e: RuntimeEvent) => void): Promise<WorkerOutcome> {
      const branch = git(spec.cwd, ['branch', '--show-current']);
      work(spec.cwd, 'mine.txt', 'mine\n', 'my work');
      git(spec.cwd, ['push', '-q', '-u', 'origin', branch]);
      moveMain(other, 'other.txt', 'theirs\n', 'their work');
      git(repo, ['fetch', '-q', 'origin', 'main']);
      // The forge goes down between the run ending and the controller pushing.
      git(repo, ['remote', 'set-url', 'origin', path.join(dir, 'vanished.git')]);
      onEvent?.({ kind: 'ended', taskId: spec.taskId, status: 'completed' });
      return {
        status: 'completed', ok: true, sessionId: 'z-1', text: 'done', costUsd: 0, turns: 1,
        durationMs: 0, stopReason: 'end_turn', denials: 0, error: null,
      };
    },
  };

  const lines: string[] = [];
  await reconcile({ runtime, cwd: repo, board: 'unreachable', readPr: false, onEvent: (l) => lines.push(l) });

  const after = await db.job.findUniqueOrThrow({ where: { id: job.id }, include: { attempts: true } });
  assert.equal(after.phase, 'succeeded', 'a network fault is not evidence about the work');
  assert.equal(after.attempts[0].outcome, 'completed');
  assert.ok(lines.some((l) => /could not be reached/.test(l)), 'and it is not silent either');
});

test('a Job whose base moved somewhere else succeeds, rebased, with the remote brought along', async () => {
  const { origin, repo, other } = makeRemote('ctl-ok');
  const db = openBoard();
  const board = await db.board.upsert({
    where: { slug: 'rebase-ok' }, update: { repoPath: repo }, create: { slug: 'rebase-ok', repoPath: repo },
  });
  const job = await db.job.create({ data: { boardId: board.id, name: 'coexist', brief: 'add a file' } });

  const runtime: Runtime = {
    name: 'coexisting',
    async run(spec: WorkerSpec, onEvent?: (e: RuntimeEvent) => void): Promise<WorkerOutcome> {
      const branch = git(spec.cwd, ['branch', '--show-current']);
      work(spec.cwd, 'mine.txt', 'mine\n', 'my work');
      git(spec.cwd, ['push', '-q', '-u', 'origin', branch]);
      moveMain(other, 'other.txt', 'theirs\n', 'their work');
      onEvent?.({ kind: 'ended', taskId: spec.taskId, status: 'completed' });
      return {
        status: 'completed', ok: true, sessionId: 'y-1', text: 'done', costUsd: 0, turns: 1,
        durationMs: 0, stopReason: 'end_turn', denials: 0, error: null,
      };
    },
  };

  await reconcile({ runtime, cwd: repo, board: 'rebase-ok', readPr: false });

  const after = await db.job.findUniqueOrThrow({ where: { id: job.id }, include: { attempts: true } });
  assert.equal(after.phase, 'succeeded');
  const branch = after.attempts[0].branch ?? '';
  assert.equal(
    git(origin, ['rev-parse', `${branch}^`]),
    git(repo, ['rev-parse', 'origin/main']),
    'the pushed branch now sits on the base a reviewer would merge it into',
  );
});
