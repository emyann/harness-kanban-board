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

const { createWorktree, existingWorktree, removeWorktree, worktreeHasWork, branchFor, baseRef, freeBranch } =
  await import('../src/worktree.ts');

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
  assert.match(r.why, /still holds work/);
  assert.equal(fs.existsSync(path.join(wt.path, 'unpushed.txt')), true);
});

test('a worktree holding a commit is kept too, even though the tree is clean', () => {
  const wt = createWorktree(repo, 4, 1);
  fs.writeFileSync(path.join(wt.path, 'committed.txt'), 'work');
  git(['add', '-A'], wt.path);
  git(['commit', '-qm', 'worker commit'], wt.path);
  assert.equal(git(['status', '--porcelain'], wt.path).stdout.trim(), '', 'tree is clean');
  assert.equal(worktreeHasWork(repo, wt), true, 'but it is ahead of its base');
  assert.equal(removeWorktree(repo, wt).removed, false);
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

test('uncommitted operator work is invisible to a worker', () => {
  fs.writeFileSync(path.join(repo, 'dirty.txt'), 'not committed');
  const wt = createWorktree(repo, 7, 1);
  assert.equal(fs.existsSync(path.join(wt.path, 'dirty.txt')), false,
    'a worktree is a checkout of a commit, not of a working tree');
  fs.rmSync(path.join(repo, 'dirty.txt'));
});
