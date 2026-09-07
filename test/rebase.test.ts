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
const { rebaseOntoBase, rebasePlan, conflictReason } = await import('../src/rebase.ts');
const { createWorktree, baseRef, fetchBase } = await import('../src/worktree.ts');
const { withProtocol } = await import('../src/brief.ts');

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
  const p = rebasePlan({ label: 'origin/main', ahead: 3, onBase: true });
  assert.equal(p.act, 'nothing');
  assert.match(p.why, /already on origin\/main/);
});

test('rebasePlan: a branch with nothing committed on it is left alone', () => {
  // The base moved AND the branch is behind it — but there is nothing to replay, so replaying
  // would rewrite a branch and spend a force-push to produce the base itself.
  const p = rebasePlan({ label: 'origin/main', ahead: 0, onBase: false });
  assert.equal(p.act, 'nothing');
  assert.match(p.why, /nothing was committed/);
});

test('rebasePlan: commits plus a base that moved is the one case that rebases', () => {
  const p = rebasePlan({ label: 'origin/main', ahead: 2, onBase: false });
  assert.equal(p.act, 'rebase');
  assert.match(p.why, /moved/);
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
  assert.equal(r.kind, 'stale');
  assert.equal(at(origin, wt.branch), strangers, 'the stranger\'s commit is still on the remote');
});

// ---------------------------------------------------------------- the prompt half

test('the protocol asks the worker to rebase BEFORE it pushes, since after it cannot', () => {
  const p = withProtocol('do the thing', 'kb-1-1', 'origin/main');
  const rebaseAt = p.indexOf('git rebase origin/main');
  const pushAt = p.indexOf('git push -u origin kb-1-1');
  assert.ok(rebaseAt > 0, 'it is asked for');
  assert.ok(rebaseAt < pushAt, 'and it is asked for before the push, which is the only place it is free');
  assert.match(p, /3\. Push it/, 'the steps are renumbered rather than repeating a number');
  assert.match(p, /5\. Reply with one line/);
});

test('a repository with no remote is not told to fetch one', () => {
  const p = withProtocol('do the thing', 'kb-1-1', 'HEAD');
  assert.doesNotMatch(p, /git fetch origin/);
  assert.match(p, /2\. Push it/, 'and the steps close back up');
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
