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
  includedFiles, sweepWorktrees, lockWorktree, listWorktrees, heldWork,
} = await import('../src/worktree.ts');
// Moved out of `src/worktree.ts`: what a Job hands back is ADR-008's execroot, not a git concept.
// The cases stay here, because they are exercised against a real worktree.
const { checkExportPath, exportOutputs } = await import('../src/exports.ts');

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
  fs.mkdirSync(path.join(repo, '.hkb'), { recursive: true });
  fs.writeFileSync(path.join(repo, '.gitignore'), '.hkb/*.db\n');
  fs.writeFileSync(path.join(repo, '.hkb', 'board.db'), 'pretend-sqlite');
  git(['add', '.gitignore']);
  git(['commit', '-qm', 'ignore the board']);

  const wt = createWorktree(repo, 6, 1);
  assert.equal(fs.existsSync(path.join(wt.path, '.hkb', 'board.db')), false,
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

test('a resumed attempt is put back on ITS branch, not on wherever the last one wandered', () => {
  // The hole this closes: the branch read off the checkout is whatever the previous attempt LEFT
  // there, and a worker can `git switch`. Attempt 1 ending on `develop` made `develop` this
  // attempt's own branch — and its own branch is exactly what the sandbox licenses a push to
  // (`src/push.ts`). The name is pinned to what hkb could have given this Job instead.
  const first = createWorktree(repo, 22, 1);
  git(['switch', '-q', '-c', 'develop'], first.path);
  assert.equal(spawnSync('git', ['branch', '--show-current'], { cwd: first.path, encoding: 'utf8' }).stdout.trim(), 'develop');

  const found = existingWorktree(repo, 22, 1);
  assert.equal(found?.branch, 'kb-22-1', 'the sandbox is not renamed by the thing it sandboxes');
});

test('but a suffixed name IS this Job`s, because hkb is what gave it one', () => {
  // `freeBranch` takes the next free suffix when the remote already has `kb-<id>-<k>`, so a resumed
  // attempt has to accept that spelling — refusing it would put the session on a branch its own
  // commits are not on, which is the fault the read-it-back rule exists to prevent.
  const wt = createWorktree(repo, 23, 1);
  git(['switch', '-q', '-c', 'kb-23-1-2'], wt.path);
  assert.equal(existingWorktree(repo, 23, 1)?.branch, 'kb-23-1-2');
  // And a different Job's attempt branch is still refused: the suffix rule is about THIS Job.
  git(['switch', '-q', '-c', 'kb-99-1'], wt.path);
  assert.equal(existingWorktree(repo, 23, 1)?.branch, 'kb-23-1');
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
  assert.match(listWorktrees(srepo).find((w) => w.path === wt.path)!.locked!, /^hkb:/);

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
    'a worktree outside .hkb/worktrees is not this module\'s to reason about');
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

// ------------------------------------------------- .worktreeinclude — what the repo asks to carry
//
// A worktree is a fresh checkout, so a repository whose tests need a gitignored `.env` fails in a
// worker and passes for the human, and it fails in a way that reads as the worker's fault.

const wroteInclude = (text: string) => fs.writeFileSync(path.join(repo, '.worktreeinclude'), text);
const noInclude = () => fs.rmSync(path.join(repo, '.worktreeinclude'), { force: true });

/**
 * The declaration and the ignore rules the group below shares. `.gitignore` is committed, because
 * only a gitignored file is a candidate — that is the half of the rule that keeps a tracked file
 * from being duplicated into the checkout that already has it.
 */
test('setup: the repo ignores an env file, a secrets dir, and the board', () => {
  fs.writeFileSync(path.join(repo, '.gitignore'), '.hkb/*.db\n.env\nsecrets/\n');
  git(['add', '.gitignore']);
  git(['commit', '-qm', 'ignore env and secrets too']);

  fs.writeFileSync(path.join(repo, '.env'), 'TOKEN=from-the-operator\n');
  fs.mkdirSync(path.join(repo, 'secrets', 'deep'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'secrets', 'deep', 'key.json'), '{"k":1}\n');
  fs.mkdirSync(path.join(repo, '.hkb'), { recursive: true });
  fs.writeFileSync(path.join(repo, '.hkb', 'board.db'), 'pretend-sqlite');

  assert.equal(git(['check-ignore', '-q', '.env']).status, 0, 'the env file is gitignored');
  assert.equal(git(['check-ignore', '-q', '.hkb/board.db']).status, 0, 'and so is the board');
});

test('a declared gitignored file arrives in the worktree', () => {
  wroteInclude('.env\nsecrets/**/*.json\n');
  const wt = createWorktree(repo, 30, 1);
  assert.equal(fs.readFileSync(path.join(wt.path, '.env'), 'utf8'), 'TOKEN=from-the-operator\n',
    'the worker gets the file its tests need');
  assert.equal(fs.readFileSync(path.join(wt.path, 'secrets', 'deep', 'key.json'), 'utf8'), '{"k":1}\n',
    'including one inside a wholly-ignored directory — the parent is created on the way');
  noInclude();
});

test('with no .worktreeinclude nothing is carried, and the board still does not cross', () => {
  noInclude();
  assert.deepEqual(includedFiles(repo), []);
  const wt = createWorktree(repo, 31, 1);
  assert.equal(fs.existsSync(path.join(wt.path, '.env')), false, 'undeclared is uncarried');
  assert.equal(fs.existsSync(path.join(wt.path, '.hkb', 'board.db')), false);
});

test('a tracked file is not duplicated, even when a pattern names it', () => {
  // The operator has uncommitted edits to a TRACKED file. If `.worktreeinclude` could carry tracked
  // files, this is what a worker would wake up holding — an edit nobody committed, in a checkout
  // that is supposed to be a commit.
  fs.writeFileSync(path.join(repo, 'README.md'), '# edited, not committed\n');
  wroteInclude('README.md\n');

  assert.deepEqual(includedFiles(repo), [], 'a tracked file is not a candidate at all');
  const wt = createWorktree(repo, 32, 1);
  assert.equal(fs.readFileSync(path.join(wt.path, 'README.md'), 'utf8'), '# base\n',
    'the checkout put it there, and the copy did not overwrite it');

  fs.writeFileSync(path.join(repo, 'README.md'), '# base\n');
  noInclude();
});

test('matching the pattern is not enough — the file must be gitignored too', () => {
  fs.writeFileSync(path.join(repo, 'scratch.txt'), 'untracked but not ignored');
  wroteInclude('scratch.txt\n.env\n');

  assert.deepEqual(includedFiles(repo), ['.env'], 'both halves of the rule, or neither');
  const wt = createWorktree(repo, 33, 1);
  assert.equal(fs.existsSync(path.join(wt.path, 'scratch.txt')), false,
    'untracked-and-unignored is work in progress, not configuration');

  fs.rmSync(path.join(repo, 'scratch.txt'));
  noInclude();
});

test('the copy happens on creation, not on resume into a checkout that already exists', () => {
  wroteInclude('.env\n');
  const first = createWorktree(repo, 34, 1);
  fs.writeFileSync(path.join(first.path, '.env'), 'TOKEN=the-worker-changed-it\n');

  const again = createWorktree(repo, 34, 1);
  assert.equal(again.path, first.path);
  assert.equal(fs.readFileSync(path.join(again.path, '.env'), 'utf8'), 'TOKEN=the-worker-changed-it\n',
    'resume is not restart — re-copying would overwrite what the session has been living with');
  noInclude();
});

// --------------------------------------------------------------- and the one thing it may not do

test('a pattern that would carry the board in is REFUSED, however it is written', () => {
  // Not "quietly skipped". A pattern this broad is one whose author did not mean what they wrote,
  // and a worker holding a copy of board.db writes into a file nothing ever reads back.
  for (const pattern of ['.hkb/*.db', '*.db', '**/board.db', '*']) {
    wroteInclude(`${pattern}\n`);
    assert.throws(() => includedFiles(repo), /never crosses into a worktree/,
      `pattern ${pattern} must be refused`);
  }
  noInclude();
});

test('the refusal happens before the checkout is made, and says what to do next', () => {
  wroteInclude('.hkb/*.db\n.env\n');
  const dir = path.join(repo, '.hkb', 'worktrees', branchFor(35, 1));

  let e: (Error & { exitCode?: number }) | null = null;
  try {
    createWorktree(repo, 35, 1);
  } catch (err) {
    e = err as Error & { exitCode?: number };
  }
  assert.ok(e, 'it refused');
  assert.match(e.message, /\.hkb\/board\.db/, 'it names the file it refused');
  assert.match(e.message, /Narrow the pattern/, 'and the fix, not just the complaint');
  assert.equal(e.exitCode, 2);
  assert.equal(fs.existsSync(dir), false,
    'and no half-made worktree is left for the operator to clean up');

  noInclude();
});

test('the board never crosses even when the declaration is legitimate', () => {
  wroteInclude('.env\n');
  const wt = createWorktree(repo, 36, 1);
  assert.equal(fs.existsSync(path.join(wt.path, '.env')), true, 'the declared file arrived');
  assert.equal(fs.existsSync(path.join(wt.path, '.hkb', 'board.db')), false,
    'and the board did not ride along with it');
  noInclude();
});

// ------------------------------------------------- exports — what a Job takes back out (ADR-008)
//
// The mirror of `.worktreeinclude`: those are the files that cross INTO a checkout, these are the
// ones that have to come out of it before it dies. Bazel's rule, which is the one the ADR adopts:
// move the known outputs to the execroot, THEN delete the sandbox. Order is the design.

const rmFromRepo = (...rels: string[]) =>
  rels.forEach((r) => fs.rmSync(path.join(repo, r), { recursive: true, force: true }));

test('a declared file is copied into the repository, and a declared directory recurses', () => {
  const wt = createWorktree(repo, 70, 1);
  fs.writeFileSync(path.join(wt.path, 'NOTES.md'), 'the artifact\n');
  fs.mkdirSync(path.join(wt.path, '.claude', 'skills', 'sdk-docs', 'ref'), { recursive: true });
  fs.writeFileSync(path.join(wt.path, '.claude', 'skills', 'sdk-docs', 'SKILL.md'), '# skill\n');
  fs.writeFileSync(path.join(wt.path, '.claude', 'skills', 'sdk-docs', 'ref', 'api.md'), '# api\n');

  // The trailing slash is how a directory is usually written and means nothing to the copy.
  const r = exportOutputs(wt.path, repo, ['NOTES.md', '.claude/skills/sdk-docs/']);
  assert.deepEqual(r.missing, []);
  assert.deepEqual(r.exported.slice().sort(), [
    '.claude/skills/sdk-docs/SKILL.md', '.claude/skills/sdk-docs/ref/api.md', 'NOTES.md',
  ].sort(), 'a directory is recorded as the files it stood for');
  assert.equal(fs.readFileSync(path.join(repo, 'NOTES.md'), 'utf8'), 'the artifact\n');
  assert.equal(fs.readFileSync(path.join(repo, '.claude', 'skills', 'sdk-docs', 'ref', 'api.md'), 'utf8'), '# api\n',
    'the parents are created on the way');

  removeWorktree(repo, wt, { exported: true });
  rmFromRepo('NOTES.md', '.claude');
});

test('a declared path the run did not produce is missing — and NOTHING is copied', () => {
  const wt = createWorktree(repo, 71, 1);
  fs.writeFileSync(path.join(wt.path, 'produced.txt'), 'here\n');

  const r = exportOutputs(wt.path, repo, ['produced.txt', 'promised.txt']);
  assert.deepEqual(r.missing, ['promised.txt']);
  assert.deepEqual(r.exported, [], 'the attempt is going to fail, so half of it must not land in the tree');
  assert.equal(fs.existsSync(path.join(repo, 'produced.txt')), false,
    'an artifact from a run nobody accepted, mixed into the repository with no mark on it, is worse than none');

  removeWorktree(repo, wt, { exported: true });
});

test('an export path that leaves the worktree is REFUSED, however it is spelled', () => {
  // A declared output is not a licence to write anywhere: the board does this copy with the
  // operator's authority and no agent in the loop to notice where it landed.
  for (const bad of ['../elsewhere.txt', 'a/../../b.txt', '/etc/passwd', '']) {
    assert.throws(() => checkExportPath(bad), (e: Error & { exitCode?: number }) => {
      assert.equal(e.exitCode, 2);
      assert.match(e.message, /Declare a path inside the repository/, 'and says what to do next');
      return true;
    }, `${JSON.stringify(bad)} must be refused`);
  }
  assert.throws(() => checkExportPath('.hkb/board.db'), /board's own directory/,
    'including the one directory a copy must never land in');
  assert.throws(() => checkExportPath('.git/config'), /repository's own plumbing/,
    'and the other one — in a worktree `.git` is a file, and copying it over a real one breaks the checkout');
  assert.throws(() => checkExportPath('./'), /names the whole checkout/);
  assert.equal(checkExportPath('.claude/skills/x/'), '.claude/skills/x', 'and a legal one is normalised');
});

test('a symlink out of the checkout is refused rather than followed', () => {
  // The half a syntax rule cannot make: `exports: ["out"]` looks innocent, and `out -> /somewhere`
  // would copy somebody else's files into the repository.
  const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'hkb-elsewhere-'));
  fs.writeFileSync(path.join(elsewhere, 'secret.txt'), 'not the Job\'s to take\n');
  const wt = createWorktree(repo, 72, 1);
  fs.symlinkSync(elsewhere, path.join(wt.path, 'out'));

  assert.throws(() => exportOutputs(wt.path, repo, ['out']), /outside the checkout/);
  assert.equal(fs.existsSync(path.join(repo, 'out')), false);

  fs.rmSync(path.join(wt.path, 'out'));
  removeWorktree(repo, wt, { exported: true });
  fs.rmSync(elsewhere, { recursive: true, force: true });
});

test('an un-isolated Job checks its declaration where the work already is', () => {
  fs.writeFileSync(path.join(repo, 'in-place.txt'), 'written in the operator\'s own tree\n');
  assert.deepEqual(exportOutputs(repo, repo, ['in-place.txt']), { exported: ['in-place.txt'], missing: [] },
    'nothing to move — the declaration is a check that it is there');
  assert.deepEqual(exportOutputs(repo, repo, ['never-written.txt']).missing, ['never-written.txt']);
  rmFromRepo('in-place.txt');
});

// ------------------------------------------------- and what that lets the removal say

test('once the declared outputs are out, the rest of the checkout is litter and it goes', () => {
  const wt = createWorktree(repo, 73, 1);
  fs.writeFileSync(path.join(wt.path, 'skill.md'), 'the deliverable\n');
  // The 614 MB per checkout, and the reason `git worktree remove` needs --force here.
  fs.mkdirSync(path.join(wt.path, 'node_modules', 'dep'), { recursive: true });
  fs.writeFileSync(path.join(wt.path, 'node_modules', 'dep', 'index.js'), 'module.exports = 1\n');

  assert.deepEqual(exportOutputs(wt.path, repo, ['skill.md']).missing, []);
  const gone = removeWorktree(repo, wt, { exported: true });
  assert.equal(gone.removed, true, gone.why);
  assert.equal(fs.existsSync(wt.path), false);
  assert.equal(fs.readFileSync(path.join(repo, 'skill.md'), 'utf8'), 'the deliverable\n',
    'and the artifact outlived the sandbox, which is the whole point of the order');
  rmFromRepo('skill.md');
});

test('the same checkout, having declared nothing, is KEPT — the guard is not weakened for everyone else', () => {
  const wt = createWorktree(repo, 74, 1);
  fs.writeFileSync(path.join(wt.path, 'skill.md'), 'the deliverable\n');

  const gone = removeWorktree(repo, wt);
  assert.equal(gone.removed, false, 'with no declaration, nothing can tell this file from an artifact');
  assert.match(gone.why, /uncommitted changes or untracked files/);
  assert.equal(fs.existsSync(path.join(wt.path, 'skill.md')), true);
});

test('an exported checkout still keeps a commit that exists nowhere else', () => {
  const wt = createWorktree(repo, 75, 1);
  fs.writeFileSync(path.join(wt.path, 'out.txt'), 'declared\n');
  assert.deepEqual(exportOutputs(wt.path, repo, ['out.txt']).missing, []);
  // Committed AND dirty: the flag waives the dirty half only.
  fs.writeFileSync(path.join(wt.path, 'src.txt'), 'work\n');
  git(['add', '-A'], wt.path);
  git(['commit', '-qm', 'a worker commit'], wt.path);
  fs.writeFileSync(path.join(wt.path, 'scratch.txt'), 'undeclared\n');

  const gone = removeWorktree(repo, wt, { exported: true });
  assert.equal(gone.removed, false, 'a commit is not litter — it is work whose own channel, a push, never happened');
  assert.match(gone.why, /never been pushed/);
  assert.doesNotMatch(gone.why, /uncommitted changes/, 'and the untracked file is not why it stayed');
  assert.equal(fs.existsSync(wt.path), true);

  rmFromRepo('out.txt');
  git(['worktree', 'remove', '--force', wt.path]);
});
