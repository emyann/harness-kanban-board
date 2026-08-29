// The cleanup sweeps against a real git checkout and the in-memory GitHub (test/fake-gh.js):
// what `hkb gc --yes` removes, what it refuses to touch, and the dispatcher running the very same
// sweeps inside the tick — incrementally when a task leaves the board, in full every N ticks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { agentWorktreeNode, attemptOf, gc, isMerged, listBranches, listWorktrees, sweep, sweepAgentWorktrees, sweepBranches, sweepTask, sweepWorktrees, worktreeAttempt } from '../src/gc.js';
import { tick } from '../src/dispatch.js';
import { DEFAULT_BOARD, readState, writeState } from '../src/board.js';
import { GhError, setTransport } from '../src/gh.js';
import { serializeRunComment } from '../src/model.js';
import { FakeGh, kbIssue, runWith } from './fake-gh.js';

const DEAD_PID = 999_999_999; // out of range on every platform we run on: never alive

function git(root, ...args) {
  const r = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr || r.stdout}`);
  return (r.stdout || '').trim();
}

function makeRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hkb-gc-'));
  git(root, 'init', '-q');
  git(root, 'symbolic-ref', 'HEAD', 'refs/heads/main');
  git(root, 'config', 'user.email', 'hkb@local');
  git(root, 'config', 'user.name', 'hkb');
  git(root, 'config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(root, 'README.md'), '# board\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', 'init');
  return root;
}

function harness({ board = 'default', dispatch = {}, host = 'test-host' } = {}) {
  const gh = new FakeGh();
  const root = makeRepo();
  const cfg = {
    ...DEFAULT_BOARD,
    repo: gh.nameWithOwner,
    board,
    default_branch: 'main',
    dispatch: { ...DEFAULT_BOARD.dispatch, ...dispatch },
    profiles: { claude: { mode: 'process', max_in_progress: 2, model: null, allowed_tools: [], launch: ['true'] } },
  };
  const ctx = {
    root, cfg, board, host,
    repo: { owner: gh.owner, repo: gh.repo, nameWithOwner: gh.nameWithOwner },
    json: false, caps: {}, _cache: {},
    requireBoard() { return this; },
  };
  const restore = gh.install();
  const logs = [];
  return {
    gh, ctx, root, logs,
    log: (m) => logs.push(m),
    text: () => logs.join('\n'),
    tick: (opts = {}) => tick(ctx, { log: (m) => logs.push(m), ...opts }),
    cleanup: () => { restore(); fs.rmSync(root, { recursive: true, force: true }); },
  };
}

/** A worktree the way both harnesses make one: dir `kb-<n>-<k>`, branch either spelling. */
function worktree(root, name, branch = name) {
  const dir = path.join(root, '.claude', 'worktrees', name);
  git(root, 'worktree', 'add', '-q', dir, '-b', branch);
  return dir;
}

/** A branch carrying a commit the default branch does not have. */
function unmergedBranch(root, branch) {
  const dir = path.join(root, '.tmp-wt', branch);
  git(root, 'worktree', 'add', '-q', dir, '-b', branch);
  fs.writeFileSync(path.join(dir, 'work.txt'), 'unpushed\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', `work on ${branch}`);
  git(root, 'worktree', 'remove', '--force', dir);
  return branch;
}

const branches = (root) => git(root, 'for-each-ref', '--format=%(refname:short)', 'refs/heads/').split('\n').filter(Boolean).sort();
const exists = (p) => fs.existsSync(p);

// ---------- names ----------

test('an attempt is recognised by either spelling of its name', () => {
  assert.deepEqual(attemptOf('kb-12-3'), { n: 12, k: 3 });
  assert.deepEqual(attemptOf('worktree-kb-12-3'), { n: 12, k: 3 }); // Claude Code's --worktree branch
  assert.equal(attemptOf('kb-12'), null);
  assert.equal(attemptOf('feature/kb-12-3'), null);
  assert.equal(attemptOf(''), null);
  assert.equal(attemptOf(null), null);
  // a worktree is placed by its directory, whatever branch it happens to have checked out
  assert.deepEqual(worktreeAttempt({ path: '/repo/.claude/worktrees/kb-7-2', branch: 'worktree-kb-7-2' }), { n: 7, k: 2 });
  assert.deepEqual(worktreeAttempt({ path: '/repo/scratch', branch: 'kb-9-1' }), { n: 9, k: 1 });
  assert.equal(worktreeAttempt({ path: '/repo', branch: 'main' }), null);
});

test('an agent-<id> worktree is recognised by its kb/<n> branch, not its name', () => {
  assert.deepEqual(agentWorktreeNode({ path: '/repo/.claude/worktrees/agent-abc123', branch: 'kb/41' }), { n: 41, branch: 'kb/41' });
  assert.equal(agentWorktreeNode({ path: '/repo/.claude/worktrees/agent-abc123', branch: 'agent-abc123' }), null, 'unchanged: still on its own throwaway branch');
  assert.equal(agentWorktreeNode({ path: '/repo/.claude/worktrees/kb-41-1', branch: 'kb/41' }), null, 'not an agent-* checkout at all');
  assert.equal(agentWorktreeNode({ path: '/repo/.claude/worktrees/agent-abc123', branch: 'kb-41-1' }), null, 'a dispatcher-style branch, not a track node branch');
});

// ---------- worktrees ----------

test('sweepWorktrees removes finished attempts and leaves live ones alone', (t) => {
  const h = harness();
  t.after(h.cleanup);
  const done = worktree(h.root, 'kb-1-1', 'worktree-kb-1-1');
  const live = worktree(h.root, 'kb-2-1', 'worktree-kb-2-1');

  const stats = sweepWorktrees(h.ctx, { finished: (n) => n === 1, yes: true, log: h.log });

  assert.equal(stats.removed, 1);
  assert.equal(exists(done), false);
  assert.equal(exists(live), true);
  assert.deepEqual(branches(h.root), ['main', 'worktree-kb-2-1']); // the branch goes with the worktree
  assert.match(h.text(), /removed worktree .*kb-1-1/);
});

test('without --yes a sweep only says what it would do', (t) => {
  const h = harness();
  t.after(h.cleanup);
  const dir = worktree(h.root, 'kb-1-1');

  const stats = sweepWorktrees(h.ctx, { finished: () => true, yes: false, label: (n) => `task #${n} done`, log: h.log });

  assert.deepEqual([stats.removed, stats.pending], [0, 1]);
  assert.equal(exists(dir), true);
  assert.match(h.text(), /would remove worktree .*kb-1-1 \(task #1 done\) — pass --yes/);
});

test('a worktree a live session still holds is skipped, and swept once that pid is gone', (t) => {
  const h = harness();
  t.after(h.cleanup);
  const dir = worktree(h.root, 'kb-1-1');
  git(h.root, 'worktree', 'lock', '--reason', `claude session kb-1-1 (pid ${process.pid} started 2026-08-26)`, dir);

  const held = sweepWorktrees(h.ctx, { finished: () => true, yes: true, log: h.log });
  assert.deepEqual([held.removed, held.skipped], [0, 1]);
  assert.equal(exists(dir), true);
  assert.match(h.text(), /still locked by a live session/);

  // the session ends; the lock reason survives it, and the next pass unlocks and removes
  git(h.root, 'worktree', 'unlock', dir);
  git(h.root, 'worktree', 'lock', '--reason', `claude session kb-1-1 (pid ${DEAD_PID} started 2026-08-26)`, dir);
  const gone = sweepWorktrees(h.ctx, { finished: () => true, yes: true, log: h.log });
  assert.equal(gone.removed, 1);
  assert.equal(exists(dir), false);
});

test('a live session is never swept quietly by the incremental pass either', (t) => {
  const h = harness();
  t.after(h.cleanup);
  const dir = worktree(h.root, 'kb-1-1');
  git(h.root, 'worktree', 'lock', '--reason', `claude session kb-1-1 (pid ${process.pid})`, dir);

  const stats = sweepTask(h.ctx, 1, { log: h.log });

  assert.deepEqual([stats.worktrees, stats.branches], [0, 0]);
  assert.equal(exists(dir), true);
  assert.equal(h.text(), ''); // silent: the next pass retries it
});

test('sweepAgentWorktrees removes an agent-<id> checkout only once its node\'s PR is merged or closed', (t) => {
  const h = harness();
  t.after(h.cleanup);
  const merged = worktree(h.root, 'agent-abc', 'kb/41');
  const closed = worktree(h.root, 'agent-def', 'kb/42');
  const open = worktree(h.root, 'agent-ghi', 'kb/43');
  const none = worktree(h.root, 'agent-jkl', 'kb/44'); // no PR recorded yet
  const prByBranch = (n) => ({ 41: { state: 'MERGED' }, 42: { state: 'CLOSED' }, 43: { state: 'OPEN' } }[n] || null);

  const stats = sweepAgentWorktrees(h.ctx, { prByBranch, yes: true, log: h.log });

  assert.equal(stats.removed, 2);
  assert.equal(exists(merged), false);
  assert.equal(exists(closed), false);
  assert.equal(exists(open), true);
  assert.equal(exists(none), true);
  assert.deepEqual(branches(h.root), ['kb/43', 'kb/44', 'main']); // the branch goes with its worktree
  assert.match(h.text(), /removed worktree .*agent-abc \(#41's PR is merged\)/);
});

test('without --yes, sweepAgentWorktrees only reports what it would remove', (t) => {
  const h = harness();
  t.after(h.cleanup);
  const dir = worktree(h.root, 'agent-abc', 'kb/41');

  const stats = sweepAgentWorktrees(h.ctx, { prByBranch: () => ({ state: 'MERGED' }), yes: false, log: h.log });

  assert.deepEqual([stats.removed, stats.pending], [0, 1]);
  assert.equal(exists(dir), true);
  assert.match(h.text(), /would remove worktree .*agent-abc \(#41's PR is merged\) — pass --yes/);
});

// ---------- branches ----------

test('orphan branches: merged ones go, unmerged ones only when their task is finished', (t) => {
  const h = harness();
  t.after(h.cleanup);
  git(h.root, 'branch', 'kb-1-1'); // no commits of its own → already an ancestor of main
  unmergedBranch(h.root, 'worktree-kb-2-1'); // still open: carries work main has not taken
  unmergedBranch(h.root, 'kb-3-1'); // finished task: the sweep force-deletes it
  const held = worktree(h.root, 'kb-4-1'); // a worktree holds this one — not the branch sweep's call
  git(h.root, 'branch', 'feature-x');

  assert.equal(isMerged(h.root, 'kb-1-1', ['main']), true);
  assert.equal(isMerged(h.root, 'worktree-kb-2-1', ['main']), false);

  const stats = sweepBranches(h.ctx, { finished: (n) => n === 3, yes: true, log: h.log });

  assert.equal(stats.removed, 2);
  assert.deepEqual(branches(h.root), ['feature-x', 'kb-4-1', 'main', 'worktree-kb-2-1']);
  assert.equal(exists(held), true);
  assert.match(h.text(), /deleted branch kb-1-1 \(already merged into the default branch\)/);
  assert.match(h.text(), /deleted branch kb-3-1 \(task #3 is finished\)/);
});

test('listBranches marks the ones a worktree is holding', (t) => {
  const h = harness();
  t.after(h.cleanup);
  worktree(h.root, 'kb-1-1', 'worktree-kb-1-1');
  git(h.root, 'branch', 'kb-2-1');

  assert.deepEqual(listBranches(h.root).map((b) => `${b.branch}:${b.n}/${b.k}:${b.checkedOut}`).sort(),
    ['kb-2-1:2/1:false', 'worktree-kb-1-1:1/1:true']);
  assert.equal(listWorktrees(h.root).length, 2); // the checkout itself, plus the attempt's
});

// ---------- one task at a time (what the tick runs) ----------

test('sweepTask cleans one task, keeps the attempts it is told to keep, and touches nothing else', (t) => {
  const h = harness();
  t.after(h.cleanup);
  const first = worktree(h.root, 'kb-5-1', 'worktree-kb-5-1');
  const second = worktree(h.root, 'kb-5-2', 'worktree-kb-5-2');
  const other = worktree(h.root, 'kb-6-1', 'worktree-kb-6-1');
  unmergedBranch(h.root, 'kb-5-3');
  unmergedBranch(h.root, 'kb-6-2');
  git(h.root, 'branch', 'kb-5-2'); // a merged branch of the kept attempt: still not ours to delete

  const stats = sweepTask(h.ctx, 5, { keep: [2], log: h.log });

  assert.deepEqual([stats.worktrees, stats.branches], [1, 1]);
  assert.equal(exists(first), false);
  assert.equal(exists(second), true); // the attempt still open
  assert.equal(exists(other), true); // another task's
  assert.deepEqual(branches(h.root), ['kb-5-2', 'kb-6-2', 'main', 'worktree-kb-5-2', 'worktree-kb-6-1']);
  assert.match(h.text(), /#5: cleaned up 1 worktree\(s\), 1 branch\(es\)/);
});

// ---------- the full sweep ----------

test('the full sweep is what `hkb gc --yes` runs: worktrees, branches, duplicate run comments, old files', async (t) => {
  const h = harness();
  t.after(h.cleanup);
  const run = runWith([{ attempt: 1, host: 'test-host', started_at: '2026-08-26T01:00:00Z', ended_at: '2026-08-26T02:00:00Z', outcome: 'completed' }]);
  h.gh.addIssue(kbIssue({ number: 1, status: 'done', state: 'CLOSED', stateReason: 'COMPLETED', run, comments: [serializeRunComment(run)] }));
  h.gh.addIssue(kbIssue({ number: 2, status: 'running' }));
  const merged = worktree(h.root, 'kb-1-1', 'worktree-kb-1-1');
  const running = worktree(h.root, 'kb-2-1', 'worktree-kb-2-1');
  unmergedBranch(h.root, 'kb-1-2');
  fs.mkdirSync(path.join(h.root, '.kanban', 'logs'), { recursive: true });
  const old = path.join(h.root, '.kanban', 'logs', '1-1.log');
  const fresh = path.join(h.root, '.kanban', 'logs', '2-1.log');
  fs.writeFileSync(old, 'old\n');
  fs.writeFileSync(fresh, 'fresh\n');
  const longAgo = Date.now() - 30 * 86400_000;
  fs.utimesSync(old, longAgo / 1000, longAgo / 1000);

  const stats = await sweep(h.ctx, { yes: true, log: h.log });

  assert.equal(stats.worktrees, 1);
  assert.equal(stats.branches, 1); // the leftover branch of attempt 2, task finished
  assert.equal(stats.comments, 1); // the older copy of the run record
  assert.equal(stats.files, 1);
  assert.equal(exists(merged), false);
  assert.equal(exists(running), true);
  assert.deepEqual(branches(h.root), ['main', 'worktree-kb-2-1']);
  assert.equal(exists(old), false);
  assert.equal(exists(fresh), true);
  assert.equal(h.gh.runOf(1).attempts.length, 1);
  assert.equal(h.gh.issues.get(1).comments.length, 1);
});

test('the full sweep learns agent-<id> worktrees: gone once #41\'s PR merges, kept while it is still open', async (t) => {
  const h = harness();
  t.after(h.cleanup);
  h.gh.addIssue(kbIssue({ number: 41, status: 'running', prs: [{ number: 900, state: 'MERGED', headRefName: 'kb/41' }] }));
  h.gh.addIssue(kbIssue({ number: 42, status: 'running', prs: [{ number: 901, state: 'OPEN', headRefName: 'kb/42' }] }));
  const merged = worktree(h.root, 'agent-abc', 'kb/41');
  const open = worktree(h.root, 'agent-def', 'kb/42');

  const stats = await sweep(h.ctx, { yes: true, log: h.log });

  assert.equal(stats.worktrees, 1);
  assert.equal(exists(merged), false);
  assert.equal(exists(open), true);
});

test('a sweep given a memo does not read a task again while its issue has not moved', async (t) => {
  const h = harness();
  t.after(h.cleanup);
  h.gh.addIssue(kbIssue({ number: 1, status: 'done', state: 'CLOSED', stateReason: 'COMPLETED', run: runWith([]) }));
  h.gh.addIssue(kbIssue({ number: 2, status: 'ready' }));
  const reads = () => h.gh.callsMatching('GET', /issues\/\d+\/comments/).length;
  const memo = {}; // what the dispatcher keeps in .kanban/state.json

  await sweep(h.ctx, { yes: true, memo, log: h.log });
  assert.equal(reads(), 2); // both tasks, once
  assert.deepEqual(Object.keys(memo).sort(), ['1', '2']);

  h.ctx._cache = {}; // a fresh tick, same board
  await sweep(h.ctx, { yes: true, memo, log: h.log });
  assert.equal(reads(), 2); // nothing moved: this sweep reads no comment at all

  // a duplicate run comment can only appear through a write, and a write bumps the issue's updatedAt
  h.gh.addComment(2, 'a human says something');
  h.gh.issues.get(2).updatedAt = '2026-08-27T09:00:00Z';
  h.ctx._cache = {};
  await sweep(h.ctx, { yes: true, memo, log: h.log });
  assert.equal(reads(), 3); // only #2 read again

  h.ctx._cache = {}; // `hkb gc` passes no memo: a human asking for a sweep gets the thorough one
  await sweep(h.ctx, { yes: true, log: h.log });
  assert.equal(reads(), 5);
});

test('`hkb gc` reports, `hkb gc --yes` removes', async (t) => {
  const h = harness();
  t.after(h.cleanup);
  h.gh.addIssue(kbIssue({ number: 1, status: 'done', state: 'CLOSED', stateReason: 'COMPLETED' }));
  const dir = worktree(h.root, 'kb-1-1', 'worktree-kb-1-1');

  assert.equal(await gc(h.ctx, {}, h.log), 0);
  assert.equal(exists(dir), true);
  assert.match(h.text(), /would remove worktree/);
  assert.match(h.text(), /nothing done/);

  assert.equal(await gc(h.ctx, { yes: true }, h.log), 0);
  assert.equal(exists(dir), false);
  assert.match(h.text(), /gc: 1 worktree\(s\) removed/);
});

test('a retention window that is not a number is refused, never read as "delete everything"', async (t) => {
  const h = harness();
  t.after(h.cleanup);
  await assert.rejects(gc(h.ctx, { yes: true, 'log-retention-days': 'forever' }, h.log), (e) => {
    assert.equal(e.exitCode, 2);
    assert.match(e.message, /takes a number of days/);
    return true;
  });
});

// ---------- inside the tick ----------

test('the tick cleans up after a task GitHub closed behind its back', async (t) => {
  const h = harness({ dispatch: { gc_every_ticks: 0 } });
  t.after(h.cleanup);
  const run = runWith([{ attempt: 1, host: 'test-host', started_at: '2026-08-26T01:00:00Z' }]);
  h.gh.addIssue(kbIssue({ number: 1, status: 'review', state: 'CLOSED', stateReason: 'COMPLETED', run }));
  const dir = worktree(h.root, 'kb-1-1', 'worktree-kb-1-1');
  unmergedBranch(h.root, 'kb-1-2');

  const s = await h.tick();

  assert.equal(s.reconciled[0].status, 'done');
  assert.deepEqual(s.cleaned, [{ number: 1, worktrees: 1, branches: 1, chains: 0, pending: 0 }]);
  assert.equal(exists(dir), false);
  assert.deepEqual(branches(h.root), ['main']);
  assert.equal(s.gc, undefined); // gc_every_ticks: 0 turns the full sweep off
});

test('what a live session held is retried by the next tick, not forgotten', async (t) => {
  const h = harness({ dispatch: { gc_every_ticks: 0 } });
  t.after(h.cleanup);
  h.gh.addIssue(kbIssue({ number: 1, status: 'review', state: 'CLOSED', stateReason: 'COMPLETED', run: runWith([{ attempt: 1, host: 'test-host', started_at: '2026-08-26T01:00:00Z' }]) }));
  const dir = worktree(h.root, 'kb-1-1', 'worktree-kb-1-1');
  git(h.root, 'worktree', 'lock', '--reason', `claude session kb-1-1 (pid ${process.pid})`, dir);

  const first = await h.tick();
  assert.equal(first.cleaned, undefined);
  assert.equal(exists(dir), true);
  assert.deepEqual(readState(h.root).gc_pending, [1]); // remembered, silently

  git(h.root, 'worktree', 'unlock', dir); // the session ends
  const second = await h.tick();

  assert.deepEqual(second.cleaned, [{ number: 1, worktrees: 1, branches: 0, chains: 0, pending: 0 }]);
  assert.equal(exists(dir), false);
  assert.deepEqual(readState(h.root).gc_pending, []);
});

test('a pending cleanup is dropped when the task is back in flight', async (t) => {
  const h = harness({ dispatch: { gc_every_ticks: 0 } });
  t.after(h.cleanup);
  h.gh.addIssue(kbIssue({ number: 1, status: 'ready' })); // reopened, or retried after a failure
  const dir = worktree(h.root, 'kb-1-1', 'worktree-kb-1-1');
  writeState(h.root, { gc_pending: [1] });

  const s = await h.tick({ max: 0 });

  assert.equal(s.cleaned, undefined);
  assert.equal(exists(dir), true); // a fresh worker could be sitting in it
  assert.deepEqual(readState(h.root).gc_pending, [1]); // still owed, once the task settles
});

test('a dry-run tick removes nothing from the host', async (t) => {
  const h = harness({ dispatch: { gc_every_ticks: 1 } });
  t.after(h.cleanup);
  h.gh.addIssue(kbIssue({ number: 1, status: 'review', state: 'CLOSED', stateReason: 'COMPLETED', run: runWith([{ attempt: 1, host: 'test-host', started_at: '2026-08-26T01:00:00Z' }]) }));
  const dir = worktree(h.root, 'kb-1-1', 'worktree-kb-1-1');

  const s = await h.tick({ dryRun: true });

  assert.equal(s.cleaned, undefined);
  assert.equal(s.gc, undefined);
  assert.equal(exists(dir), true);
});

test('the tick runs the full sweep every gc_every_ticks', async (t) => {
  const h = harness({ dispatch: { gc_every_ticks: 2 } });
  t.after(h.cleanup);
  h.gh.addIssue(kbIssue({ number: 1, status: 'done' })); // settled, still open: never reconciled
  const dir = worktree(h.root, 'kb-1-1', 'worktree-kb-1-1');

  const first = await h.tick();
  assert.equal(first.gc, undefined);
  assert.equal(exists(dir), true);

  const second = await h.tick();
  assert.equal(second.gc.worktrees, 1);
  assert.equal(exists(dir), false);
  assert.match(h.text(), /gc: 1 worktree\(s\), 0 branch\(es\)/);
  assert.deepEqual(Object.keys(readState(h.root).gc_scanned), ['1']); // the memo rides in the state file

  const third = await h.tick(); // the counter restarts
  assert.equal(third.gc, undefined);
});

test('a failing sweep never fails the tick', async (t) => {
  const h = harness({ dispatch: { gc_every_ticks: 1 } });
  // only the sweep's board read (the one that includes closed issues) fails
  const unwrap = setTransport((req) => {
    if (req.kind === 'graphql' && /states:\s*\[OPEN, CLOSED\]/.test(req.query || '')) throw new GhError('GitHub is unreachable', { status: 502, kind: 'server' });
    return h.gh.transport(req);
  });
  t.after(() => { unwrap(); h.cleanup(); });
  h.gh.addIssue(kbIssue({ number: 1, status: 'ready' }));

  const s = await h.tick({ max: 0 });

  assert.equal(s.gc.error, 'GitHub is unreachable');
  assert.deepEqual(s.promoted, []); // the tick itself finished normally
  assert.match(h.text(), /gc sweep skipped \(retried in 1 ticks\)/);
});
