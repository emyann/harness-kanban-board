import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

/**
 * A throwaway repository per run. Worktree behaviour is git's, so it is exercised against real git
 * rather than a double — the interesting cases (a base that is not HEAD, a tree that still holds
 * work) are exactly the ones a double would get wrong.
 */
const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'hkb-wt-'));
const git = (args: string[], cwd = repo) => spawnSync('git', args, { cwd, encoding: 'utf8' });

git(['init', '-q', '-b', 'main']);
git(['config', 'user.email', 'wt@test']);
git(['config', 'user.name', 'wt']);
fs.writeFileSync(path.join(repo, 'README.md'), '# base\n');
git(['add', '-A']);
git(['commit', '-qm', 'base']);

const {
  createWorktree, existingWorktree, removeWorktree, worktreeHasWork, branchFor, baseRef, freeBranch,
  sweepWorktrees, lockWorktree, listWorktrees, heldWork,
} = await import('../src/worktree.ts');

test.after(() => fs.rmSync(repo, { recursive: true, force: true }));

test('the branch name is derived, so nothing has to remember it', () => {
  assert.equal(branchFor(12, 3), 'kb-12-3');
});

test('with no remote, the base falls back to HEAD rather than failing', () => {
  assert.equal(baseRef(repo), 'HEAD');
});

test('a worktree is a real checkout on its own branch', () => {
  const wt = createWorktree(repo, 1, 1);
  assert.ok(fs.existsSync(path.join(wt.path, 'README.md')), 'the base commit is checked out');
  assert.equal(wt.branch, 'kb-1-1');
  const b = spawnSync('git', ['branch', '--show-current'], { cwd: wt.path, encoding: 'utf8' });
  assert.equal(b.stdout.trim(), 'kb-1-1');
});

test('a clean worktree is removed, and its branch with it', () => {
  const wt = createWorktree(repo, 2, 1);
  assert.equal(worktreeHasWork(repo, wt), false);
  const r = removeWorktree(repo, wt);
  assert.equal(r.removed, true);
  assert.equal(fs.existsSync(wt.path), false);
  assert.equal(git(['rev-parse', '--verify', '--quiet', 'kb-2-1']).status, 1, 'branch gone too');
});

test('a worktree holding uncommitted work is kept, and says why', () => {
  const wt = createWorktree(repo, 3, 1);
  fs.writeFileSync(path.join(wt.path, 'unpushed.txt'), 'work');
  assert.equal(worktreeHasWork(repo, wt), true);
  const r = removeWorktree(repo, wt);
  assert.equal(r.removed, false, 'never forced — this may be the only copy');
  assert.match(r.why, /uncommitted changes/);
  assert.match(r.why, /git -C/, 'and the message says what to do next');
  assert.equal(fs.existsSync(path.join(wt.path, 'unpushed.txt')), true);
});

test('a worktree holding a commit that was never pushed is kept too, though the tree is clean', () => {
  const wt = createWorktree(repo, 4, 1);
  fs.writeFileSync(path.join(wt.path, 'committed.txt'), 'work');
  git(['add', '-A'], wt.path);
  git(['commit', '-qm', 'worker commit'], wt.path);
  assert.equal(git(['status', '--porcelain'], wt.path).stdout.trim(), '', 'tree is clean');
  assert.equal(worktreeHasWork(repo, wt), true, 'but that commit exists nowhere else');
  assert.equal(heldWork(repo, wt).pushedAt, null, 'nothing here has ever seen the branch on a remote');
  const r = removeWorktree(repo, wt);
  assert.equal(r.removed, false);
  assert.match(r.why, /never been pushed/);
});

test('creating twice returns the same checkout — a resumed attempt lands where it left off', () => {
  const a = createWorktree(repo, 5, 1);
  fs.writeFileSync(path.join(a.path, 'marker.txt'), 'first');
  const b = createWorktree(repo, 5, 1);
  assert.equal(b.path, a.path);
  assert.equal(fs.readFileSync(path.join(b.path, 'marker.txt'), 'utf8'), 'first');
});

test('the worker never sees the board: a gitignored file does not cross into a worktree', () => {
  fs.mkdirSync(path.join(repo, '.kanban'), { recursive: true });
  fs.writeFileSync(path.join(repo, '.gitignore'), '.kanban/*.db\n');
  fs.writeFileSync(path.join(repo, '.kanban', 'board.db'), 'pretend-sqlite');
  git(['add', '.gitignore']);
  git(['commit', '-qm', 'ignore the board']);

  const wt = createWorktree(repo, 6, 1);
  assert.equal(fs.existsSync(path.join(wt.path, '.kanban', 'board.db')), false,
    'the controller owns every store write — a worktree copy would diverge');
});

test('a resumed attempt finds the checkout the previous one left', () => {
  const first = createWorktree(repo, 20, 1);
  fs.writeFileSync(path.join(first.path, 'in-progress.txt'), 'half done');

  const found = existingWorktree(repo, 20, 1);
  assert.ok(found, 'attempt 2 can find attempt 1s checkout');
  assert.equal(found.path, first.path);
  assert.equal(found.branch, 'kb-20-1', 'and it is still on attempt 1s branch, where the PR is');
  assert.equal(fs.readFileSync(path.join(found.path, 'in-progress.txt'), 'utf8'), 'half done',
    'resume is not restart — the work is still there');
});

test('there is nothing to resume into when the previous checkout was clean and removed', () => {
  const wt = createWorktree(repo, 21, 1);
  removeWorktree(repo, wt);
  assert.equal(existingWorktree(repo, 21, 1), null, 'so a fresh one is cut instead');
});

// ---------------------------------------------------------------- the name is not ours to assume

test('a remote branch with unrelated history does not get pushed onto — the name moves aside', () => {
  // Phase 5's job #4, exactly. `Job.id` is an autoincrement per DATABASE, so `kb-4-1` is a name
  // the next fresh board.db produces too, and a repo that has run hkb before already has one.
  const remote = fs.mkdtempSync(path.join(os.tmpdir(), 'hkb-remote-'));
  spawnSync('git', ['init', '-q', '--bare', remote]);
  git(['remote', 'add', 'origin', remote]);
  git(['push', '-q', 'origin', 'main']);

  // Somebody else's `kb-40-1`, on history this checkout does not contain.
  const stranger = fs.mkdtempSync(path.join(os.tmpdir(), 'hkb-stranger-'));
  spawnSync('git', ['clone', '-q', remote, stranger]);
  const sg = (a: string[]) => spawnSync('git', a, { cwd: stranger, encoding: 'utf8' });
  sg(['config', 'user.email', 's@t']); sg(['config', 'user.name', 's']);
  sg(['checkout', '-q', '-b', 'kb-40-1']);
  fs.writeFileSync(path.join(stranger, 'theirs.txt'), 'not ours\n');
  sg(['add', '-A']); sg(['commit', '-qm', 'an experiment from months ago']);
  sg(['push', '-q', 'origin', 'kb-40-1']);
  git(['fetch', '-q', 'origin']);

  assert.equal(freeBranch(repo, 40, 1), 'kb-40-1-2',
    'the taken name is stepped over rather than fought — a worker told never to force-push has no other move');
  const wt = createWorktree(repo, 40, 1);
  assert.equal(wt.branch, 'kb-40-1-2', 'and the checkout is on the name it can actually push');
  assert.ok(wt.path.endsWith('kb-40-1'), 'while the DIRECTORY stays derivable, so resume still finds it');

  const found = existingWorktree(repo, 40, 1);
  assert.equal(found?.branch, 'kb-40-1-2',
    'and resume reads the branch off the checkout rather than deriving the one it could not have');

  removeWorktree(repo, wt);
  fs.rmSync(stranger, { recursive: true, force: true });
  fs.rmSync(remote, { recursive: true, force: true });
  git(['remote', 'remove', 'origin']);
});

test('a free name is used as-is — the check costs nothing when nothing is in the way', () => {
  assert.equal(freeBranch(repo, 41, 1), 'kb-41-1', 'no remote at all, so nothing can be proved');
});

// ---------------------------------------------------------------------------------- the sweep
//
// Its own repository, with a real remote: everything interesting about reclaim is a fact about
// what the remote does or does not still have, and the tests are written as refusals — a checkout
// that survives a sweep it had every superficial reason to be taken by.

const srepo = fs.mkdtempSync(path.join(os.tmpdir(), 'hkb-sweep-'));
const sremote = fs.mkdtempSync(path.join(os.tmpdir(), 'hkb-sweep-remote-'));
spawnSync('git', ['init', '-q', '--bare', '-b', 'main', sremote]);
const sgit = (args: string[], cwd = srepo) => spawnSync('git', args, { cwd, encoding: 'utf8' });
spawnSync('git', ['init', '-q', '-b', 'main', srepo]);
sgit(['config', 'user.email', 'sw@test']);
sgit(['config', 'user.name', 'sw']);
fs.writeFileSync(path.join(srepo, '.gitignore'), 'node_modules/\n');
fs.writeFileSync(path.join(srepo, 'README.md'), '# sweep\n');
sgit(['add', '-A']);
sgit(['commit', '-qm', 'base']);
sgit(['remote', 'add', 'origin', sremote]);
sgit(['push', '-q', '-u', 'origin', 'main']);

test.after(() => {
  fs.rmSync(srepo, { recursive: true, force: true });
  fs.rmSync(sremote, { recursive: true, force: true });
});

/** Two commits, because one squashes into an identical patch and this must be honest. See below. */
function commitTwo(dir: string, tag: string) {
  for (const n of [1, 2]) {
    fs.writeFileSync(path.join(dir, `${tag}-${n}.txt`), `${tag} ${n}\n`);
    spawnSync('git', ['add', '-A'], { cwd: dir });
    spawnSync('git', ['commit', '-qm', `${tag} ${n}`], { cwd: dir });
  }
}

/** The forge deletes a branch when its pull request lands. It does not touch our local refs. */
const deleteOnRemote = (branch: string) =>
  spawnSync('git', ['--git-dir', sremote, 'update-ref', '-d', `refs/heads/${branch}`], { encoding: 'utf8' });

const findSwept = (results: ReturnType<typeof sweepWorktrees>, wtPath: string) => {
  const r = results.find((x) => x.path === wtPath);
  assert.ok(r, `the sweep considered ${wtPath}`);
  return r;
};

test('a worktree holding unpushed commits survives a sweep, and says how to push them', () => {
  const wt = createWorktree(srepo, 60, 1);
  commitTwo(wt.path, 'unpushed');

  const r = findSwept(sweepWorktrees(srepo), wt.path);
  assert.equal(r.removed, false, 'this work exists only here');
  assert.match(r.why, /never been pushed/);
  assert.match(r.why, new RegExp(`push -u origin ${wt.branch}`), 'and the message says what to do next');
  assert.equal(fs.existsSync(path.join(wt.path, 'unpushed-2.txt')), true);
});

test('a worktree with a dirty tree survives a sweep, even once its branch has landed', () => {
  const wt = createWorktree(srepo, 61, 1);
  commitTwo(wt.path, 'pushed');
  sgit(['push', '-q', '-u', 'origin', wt.branch], wt.path);
  deleteOnRemote(wt.branch);
  // Everything about the branch says "reclaim me"; the tree says otherwise, and the tree wins.
  fs.writeFileSync(path.join(wt.path, 'notes.md'), 'the artifact the Job actually produced\n');

  const r = findSwept(sweepWorktrees(srepo), wt.path);
  assert.equal(r.removed, false, 'an uncommitted file is the only copy of itself');
  assert.match(r.why, /uncommitted changes or untracked files/);
  assert.equal(fs.readFileSync(path.join(wt.path, 'notes.md'), 'utf8'), 'the artifact the Job actually produced\n');
});

test('a worktree whose branch is gone from the remote and whose tree is clean is removed', () => {
  const wt = createWorktree(srepo, 62, 1);
  commitTwo(wt.path, 'landed');
  sgit(['push', '-q', '-u', 'origin', wt.branch], wt.path);
  // The 614 MB per checkout: gitignored, so `status` never sees it, and it is why this matters.
  fs.mkdirSync(path.join(wt.path, 'node_modules', 'dep'), { recursive: true });
  fs.writeFileSync(path.join(wt.path, 'node_modules', 'dep', 'index.js'), 'module.exports = 1\n');

  // The forge squash-merges, then deletes the branch.
  sgit(['merge', '-q', '--squash', wt.branch]);
  sgit(['commit', '-qm', `squashed ${wt.branch} (#1)`]);
  deleteOnRemote(wt.branch);

  // BEWARE THE OBVIOUS TEST. This repository squash-merges, so the branch's own commits are
  // ancestors of nothing and a sweep built on ancestry would keep every merged checkout for ever.
  assert.notEqual(sgit(['merge-base', '--is-ancestor', wt.branch, 'main']).status, 0,
    'the merged branch is NOT an ancestor of main');
  assert.match(sgit(['cherry', 'main', wt.branch]).stdout.trim(), /^\+/,
    'and `git cherry` calls its commits unmerged too');
  // What is true instead, and what the sweep uses:
  assert.equal(sgit(['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${wt.branch}`]).status, 0,
    'the local remote-tracking ref survives the forge deleting the branch — so "unpushed" is still answerable');
  assert.equal(heldWork(srepo, wt).unpushed, 0);

  const r = findSwept(sweepWorktrees(srepo), wt.path);
  assert.equal(r.removed, true, r.why);
  assert.equal(fs.existsSync(wt.path), false, 'and the node_modules with it');
  assert.equal(sgit(['rev-parse', '--verify', '--quiet', wt.branch]).status, 1, 'branch gone too');
});

test('a sweep that cannot reach the remote removes nothing — silence is not proof', () => {
  const wt = createWorktree(srepo, 63, 1);
  commitTwo(wt.path, 'landed');
  sgit(['push', '-q', '-u', 'origin', wt.branch], wt.path);
  deleteOnRemote(wt.branch);
  sgit(['remote', 'set-url', 'origin', path.join(sremote, 'does-not-exist')]);

  const r = findSwept(sweepWorktrees(srepo), wt.path);
  assert.equal(r.removed, false, 'a remote that cannot be asked has not said the branch is gone');
  assert.match(r.why, /could not ask the remote/);
  assert.equal(fs.existsSync(wt.path), true);

  sgit(['remote', 'set-url', 'origin', sremote]);
  assert.equal(findSwept(sweepWorktrees(srepo), wt.path).removed, true, 'and it goes once the remote can be asked');
});

test('a worktree a live run holds is not swept out from under it', () => {
  const wt = createWorktree(srepo, 64, 1);
  commitTwo(wt.path, 'inflight');
  sgit(['push', '-q', '-u', 'origin', wt.branch], wt.path);
  deleteOnRemote(wt.branch);
  // Every other test would remove this one. The lock is the whole difference.
  assert.equal(lockWorktree(srepo, wt, `${os.hostname()}/${process.pid}@daemon`), true);
  assert.match(listWorktrees(srepo).find((w) => w.path === wt.path)!.locked!, /^kb:/);

  const r = findSwept(sweepWorktrees(srepo), wt.path);
  assert.equal(r.removed, false, 'the controller is running in there');
  assert.match(r.why, /a run holds it/);
  assert.equal(fs.existsSync(wt.path), true);
});

test('a lock left by a process that is gone does not strand the checkout for ever', () => {
  const wt = createWorktree(srepo, 65, 1);
  commitTwo(wt.path, 'orphan');
  sgit(['push', '-q', '-u', 'origin', wt.branch], wt.path);
  deleteOnRemote(wt.branch);
  // A daemon killed mid-run. Respecting this lock would recreate the bug the sweep exists to fix.
  lockWorktree(srepo, wt, `${os.hostname()}/4294967294@daemon`);

  assert.equal(findSwept(sweepWorktrees(srepo), wt.path).removed, true);
  assert.equal(fs.existsSync(wt.path), false);
});

test('a lock somebody set by hand is left alone, and the sweep says how to release it', () => {
  const wt = createWorktree(srepo, 66, 1);
  commitTwo(wt.path, 'byhand');
  sgit(['push', '-q', '-u', 'origin', wt.branch], wt.path);
  deleteOnRemote(wt.branch);
  sgit(['worktree', 'lock', '--reason', 'debugging-this-one', wt.path]);

  const r = findSwept(sweepWorktrees(srepo), wt.path);
  assert.equal(r.removed, false);
  assert.match(r.why, /locked by hand/);
  assert.match(r.why, /worktree unlock/, 'and says what to do next');
});

test('the sweep only touches checkouts hkb made', () => {
  const outside = path.join(srepo, 'not-ours');
  sgit(['worktree', 'add', '-q', '-b', 'somebody-elses', outside, 'HEAD']);
  assert.equal(sweepWorktrees(srepo).some((r) => r.path === outside), false,
    'a worktree outside .kanban/worktrees is not this module\'s to reason about');
  assert.equal(fs.existsSync(outside), true);
  sgit(['worktree', 'remove', outside]);
});

test('uncommitted operator work is invisible to a worker', () => {
  fs.writeFileSync(path.join(repo, 'dirty.txt'), 'not committed');
  const wt = createWorktree(repo, 7, 1);
  assert.equal(fs.existsSync(path.join(wt.path, 'dirty.txt')), false,
    'a worktree is a checkout of a commit, not of a working tree');
  fs.rmSync(path.join(repo, 'dirty.txt'));
});
