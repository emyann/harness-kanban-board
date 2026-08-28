// The dispatcher tick against an in-memory GitHub (test/fake-gh.js): promotion, claims,
// reclaim, the failure limit and the guards. No `gh`, no network, no worker — the profile's
// launch template is `["true"]`, a process that exits immediately.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { tick, withoutWorktreeFlag } from '../src/dispatch.js';
import { DEFAULT_BOARD } from '../src/board.js';
import { claim, release, listLocks } from '../src/lock.js';
import { complete, requestChanges } from '../src/lifecycle.js';
import { activePrGuard, L, RESULT_MARKER, worktreePath } from '../src/model.js';
import { FakeGh, kbIssue, runWith } from './fake-gh.js';

const ago = (seconds) => new Date(Date.now() - seconds * 1000).toISOString();

function harness({ dispatch = {}, board = 'default', host = 'test-host', root: given = null, profiles = null } = {}) {
  const gh = new FakeGh();
  const root = given || fs.mkdtempSync(path.join(os.tmpdir(), 'hkb-dispatch-'));
  const cfg = {
    ...DEFAULT_BOARD,
    repo: gh.nameWithOwner,
    board,
    dispatch: { ...DEFAULT_BOARD.dispatch, ...dispatch },
    // the spawn stub: `true` exits immediately, so no worker ever runs
    profiles: profiles || { claude: { mode: 'process', max_in_progress: 2, model: null, allowed_tools: [], launch: ['true'] } },
  };
  const ctx = {
    root,
    cfg,
    repo: { owner: gh.owner, repo: gh.repo, nameWithOwner: gh.nameWithOwner },
    board,
    host,
    json: false,
    caps: {},
    _cache: {},
    requireBoard() { return this; },
  };
  const restore = gh.install();
  const logs = [];
  return {
    gh,
    ctx,
    root,
    logs,
    log: () => logs.join('\n'),
    tick: (opts = {}) => tick(ctx, { log: (m) => logs.push(m), ...opts }),
    cleanup: () => { restore(); fs.rmSync(root, { recursive: true, force: true }); },
  };
}

test('todo → ready only when every blocker closed as completed', async (t) => {
  const h = harness();
  t.after(h.cleanup);
  h.gh.addIssue(kbIssue({ number: 1, title: 'shipped', status: 'done', state: 'CLOSED', stateReason: 'COMPLETED' }));
  h.gh.addIssue(kbIssue({ number: 2, title: 'dropped', status: 'archived', state: 'CLOSED', stateReason: 'NOT_PLANNED' }));
  h.gh.addIssue(kbIssue({ number: 3, status: 'todo', blockedBy: [1] }));
  h.gh.addIssue(kbIssue({ number: 4, status: 'todo', blockedBy: [1, 2] }));
  h.gh.addIssue(kbIssue({ number: 5, status: 'todo', blockedBy: [{ number: 99, state: 'OPEN' }] }));

  const s = await h.tick({ max: 0 }); // no slot: promotion must not depend on capacity

  assert.deepEqual(s.promoted, [3]);
  assert.equal(h.gh.statusOf(3), 'ready');
  assert.equal(h.gh.statusOf(4), 'todo'); // NOT_PLANNED is not "done"
  assert.equal(h.gh.statusOf(5), 'todo');
  assert.match(h.log(), /#3: todo → ready/);
});

test('a scheduled task is not promoted before its time', async (t) => {
  const h = harness();
  t.after(h.cleanup);
  h.gh.addIssue(kbIssue({ number: 1, status: 'todo', kb: { scheduled_at: ago(-3600) } }));
  h.gh.addIssue(kbIssue({ number: 2, status: 'todo', kb: { scheduled_at: ago(3600) } }));

  const s = await h.tick({ max: 0 });

  assert.deepEqual(s.promoted, [2]);
  assert.equal(h.gh.statusOf(1), 'todo');
});

test('a ready task is claimed once: ref, run comment, running label, worker spawned', async (t) => {
  const h = harness();
  t.after(h.cleanup);
  h.gh.addIssue(kbIssue({ number: 7, status: 'ready', agent: 'claude' }));

  const s = await h.tick();

  assert.equal(s.claimed.length, 1);
  assert.equal(s.claimed[0].number, 7);
  assert.equal(s.claimed[0].attempt, 1);
  assert.ok(s.claimed[0].pid > 0, 'the stub worker got a pid');
  assert.equal(h.gh.statusOf(7), 'running');
  assert.deepEqual(h.gh.lockRefs(), ['refs/kb/locks/7/1']);
  const run = h.gh.runOf(7);
  assert.equal(run.attempts.length, 1);
  assert.equal(run.attempts[0].host, 'test-host');
  assert.equal(run.attempts[0].profile, 'claude');
  assert.equal(run.attempts[0].ended_at, undefined);
  assert.equal(run.attempts[0].log, '.kanban/logs/7-1.log');
  assert.ok(fs.existsSync(path.join(h.root, '.kanban', 'logs', '7-1.log')));
  // one run comment, created then updated — never a second create
  assert.equal(h.gh.callsMatching('POST', /issues\/7\/comments$/).length, 1);
});

test('claim held elsewhere: skipped, and nothing on the issue is touched', async (t) => {
  const h = harness();
  t.after(h.cleanup);
  h.gh.addIssue(kbIssue({ number: 7, status: 'ready', agent: 'claude' }));
  // another dispatcher won the ref between our board read and our POST
  h.gh.fail({ method: 'POST', path: 'git/refs' }, { status: 422, message: 'Reference already exists' });

  const s = await h.tick();

  assert.deepEqual(s.held, [7]);
  assert.equal(s.claimed.length, 0);
  assert.equal(h.gh.statusOf(7), 'ready');
  assert.equal(h.gh.callsMatching('POST', /issues\/7\/labels/).length, 0);
  assert.equal(h.gh.issues.get(7).comments.length, 0);
  assert.match(h.log(), /#7: lock held elsewhere/);
});

test('claim result unknown (503): back off for this tick, no label change', async (t) => {
  const h = harness();
  t.after(h.cleanup);
  h.gh.addIssue(kbIssue({ number: 7, status: 'ready', agent: 'claude' }));
  h.gh.addIssue(kbIssue({ number: 8, status: 'ready', agent: 'claude' }));
  h.gh.fail({ method: 'POST', path: 'git/refs' }, { status: 503, message: 'Server Error' });

  const s = await h.tick();

  // #7 backs off; a 5xx is not fatal for the tick, so #8 is still claimed
  assert.equal(s.held.length, 0);
  assert.deepEqual(s.claimed.map((c) => c.number), [8]);
  assert.equal(h.gh.statusOf(7), 'ready');
  assert.equal(h.gh.callsMatching('POST', /issues\/7\/labels/).length, 0);
  assert.equal(h.gh.issues.get(7).comments.length, 0);
  assert.deepEqual(h.gh.lockRefs(), ['refs/kb/locks/8/1']);
  assert.match(h.log(), /#7: claim result unknown \(server:/);
});

test('an auth failure on claim stops the tick instead of burning the rest of the board', async (t) => {
  const h = harness();
  t.after(h.cleanup);
  h.gh.addIssue(kbIssue({ number: 7, status: 'ready', agent: 'claude' }));
  h.gh.addIssue(kbIssue({ number: 8, status: 'ready', agent: 'claude' }));
  h.gh.fail({ method: 'POST', path: 'git/refs' }, { status: 401, message: 'Bad credentials', times: 2 });

  const s = await h.tick();

  assert.equal(s.claimed.length, 0);
  assert.deepEqual(h.gh.lockRefs(), []);
  assert.equal(h.gh.statusOf(8), 'ready');
});

test('a stale heartbeat is reclaimed: lock released, attempt closed, back to ready', async (t) => {
  const h = harness({ dispatch: { stale_after: 60 } });
  t.after(h.cleanup);
  const run = runWith([{ attempt: 1, host: 'other-host', started_at: ago(600), heartbeat_at: ago(600), pid: 4_000_000 }]);
  h.gh.addIssue(kbIssue({ number: 7, status: 'running', agent: 'claude', kb: { max_runtime: 86_400 }, run }));
  h.gh.refs.set('refs/kb/locks/7/1', 'f'.repeat(40));

  const s = await h.tick({ max: 0 }); // no slot, so the freed task is not immediately re-claimed

  assert.deepEqual(s.reclaimed, [{ number: 7, outcome: 'reclaimed' }]);
  assert.equal(h.gh.statusOf(7), 'ready');
  assert.deepEqual(h.gh.lockRefs(), []);
  const saved = h.gh.runOf(7);
  assert.equal(saved.failures, 1);
  assert.equal(saved.attempts[0].outcome, 'reclaimed');
  assert.match(saved.attempts[0].reason, /^reclaimed after \d+s$/);
  assert.ok(saved.attempts[0].ended_at);
  assert.match(h.log(), /#7: reclaimed → ready/);
});

test('a ref-CAS beat keeps a worker alive: the run comment is stale, the lock ref is not', async (t) => {
  const h = harness({ dispatch: { stale_after: 60 } });
  t.after(h.cleanup);
  // a CAS heartbeat writes nothing to the run comment, so heartbeat_at is as old as the claim
  const run = runWith([{ attempt: 1, host: 'other-host', started_at: ago(3600), heartbeat_at: ago(3600), lock_sha: 'a'.repeat(40) }]);
  h.gh.addIssue(kbIssue({ number: 7, status: 'running', agent: 'claude', kb: { max_runtime: 86_400 }, run }));
  h.gh.beat(7, 1, ago(20));

  const s = await h.tick({ max: 0 });

  assert.deepEqual(s.reclaimed, []);
  assert.equal(h.gh.statusOf(7), 'running');
  assert.deepEqual(h.gh.lockRefs(), ['refs/kb/locks/7/1'], 'the lock is left alone');
  assert.equal(h.gh.callsMatching('PATCH', /issues\/comments/).length, 0, 'and the run record is not rewritten');
  assert.match(h.log(), /#7: attempt 1 beat on refs\/kb\/locks\/7\/1 \d+s ago — alive/);
});

test('a ref-CAS worker whose last beat is old is reclaimed like any other', async (t) => {
  const h = harness({ dispatch: { stale_after: 60 } });
  t.after(h.cleanup);
  const run = runWith([{ attempt: 1, host: 'other-host', started_at: ago(3600), heartbeat_at: ago(3600), lock_sha: 'a'.repeat(40) }]);
  h.gh.addIssue(kbIssue({ number: 7, status: 'running', agent: 'claude', kb: { max_runtime: 86_400 }, run }));
  h.gh.beat(7, 1, ago(900));

  const s = await h.tick({ max: 0 });

  assert.deepEqual(s.reclaimed, [{ number: 7, outcome: 'reclaimed' }]);
  assert.equal(h.gh.statusOf(7), 'ready');
  assert.deepEqual(h.gh.lockRefs(), []);
});

test('a fresh lock ref does not save a worker whose process is gone', async (t) => {
  const h = harness({ dispatch: { stale_after: 60 } });
  t.after(h.cleanup);
  const run = runWith([{ attempt: 1, host: 'test-host', started_at: ago(600), heartbeat_at: ago(5), pid: 4_000_000 }]);
  h.gh.addIssue(kbIssue({ number: 7, status: 'running', agent: 'claude', kb: { max_runtime: 86_400 }, run }));
  h.gh.beat(7, 1, ago(1));

  const s = await h.tick({ max: 0 });

  assert.deepEqual(s.reclaimed, [{ number: 7, outcome: 'crashed' }]);
});

test('a hand-claimed attempt is not a crashed spawn: it has no pid and never will', async (t) => {
  const h = harness({ dispatch: { stale_after: 3600 } });
  t.after(h.cleanup);
  // `hkb claim 7` with no --spawn: this host, no pid, no job — a human (or an agent they started)
  // is working it in their own terminal, and the CAS heartbeat leaves the run comment untouched
  const run = runWith([{ attempt: 1, host: 'test-host', started_at: ago(7200), heartbeat_at: ago(7200), lock_sha: 'a'.repeat(40), manual: true }]);
  h.gh.addIssue(kbIssue({ number: 7, status: 'running', agent: 'claude', kb: { max_runtime: 86_400 }, run }));
  h.gh.beat(7, 1, ago(120));

  const first = await h.tick({ max: 0 });
  const second = await h.tick({ max: 0 }); // the 180s rule used to fire on every tick, forever

  assert.deepEqual(first.reclaimed, []);
  assert.deepEqual(second.reclaimed, []);
  assert.equal(h.gh.statusOf(7), 'running');
  assert.deepEqual(h.gh.lockRefs(), ['refs/kb/locks/7/1'], 'the lock the worker beats on survives');
  assert.equal(h.gh.callsMatching('PATCH', /issues\/comments/).length, 0, 'and its run record is not rewritten');
  assert.match(h.log(), /#7: attempt 1 beat on refs\/kb\/locks\/7\/1 \d+s ago — alive/);
});

test('a hand-claimed attempt that stops beating is reclaimed after stale_after', async (t) => {
  const h = harness({ dispatch: { stale_after: 3600 } });
  t.after(h.cleanup);
  const run = runWith([{ attempt: 1, host: 'test-host', started_at: ago(9000), heartbeat_at: ago(9000), lock_sha: 'a'.repeat(40), manual: true }]);
  h.gh.addIssue(kbIssue({ number: 7, status: 'running', agent: 'claude', kb: { max_runtime: 86_400 }, run }));
  h.gh.beat(7, 1, ago(5400)); // last beat 90 minutes ago: past stale_after, whoever it was is gone

  const s = await h.tick({ max: 0 });

  assert.deepEqual(s.reclaimed, [{ number: 7, outcome: 'reclaimed' }], 'stale_after, not the no-handle rule');
  assert.equal(h.gh.statusOf(7), 'ready');
  assert.deepEqual(h.gh.lockRefs(), []);
});

test('a claim records the sha that starts the worker\'s beat chain', async (t) => {
  const h = harness();
  t.after(h.cleanup);
  h.gh.addIssue(kbIssue({ number: 7, status: 'ready', agent: 'claude' }));

  await h.tick();

  assert.equal(h.gh.runOf(7).attempts[0].lock_sha, h.gh.refs.get('refs/heads/main'));
  assert.equal(h.gh.refs.get('refs/kb/locks/7/1'), h.gh.runOf(7).attempts[0].lock_sha);
});

test('a task past max_runtime is timed_out, not merely reclaimed', async (t) => {
  const h = harness({ dispatch: { stale_after: 60 } });
  t.after(h.cleanup);
  const run = runWith([{ attempt: 1, host: 'other-host', started_at: ago(600), heartbeat_at: ago(1) }]);
  h.gh.addIssue(kbIssue({ number: 7, status: 'running', agent: 'claude', kb: { max_runtime: 120 }, run }));

  const s = await h.tick({ max: 0 });

  assert.deepEqual(s.reclaimed, [{ number: 7, outcome: 'timed_out' }]);
  assert.equal(h.gh.runOf(7).attempts[0].outcome, 'timed_out');
});

test('failures past max_retries give up: blocked + kb:needs-human, no retry', async (t) => {
  const h = harness({ dispatch: { stale_after: 60 } });
  t.after(h.cleanup);
  const run = runWith(
    [
      { attempt: 1, host: 'other-host', started_at: ago(9000), ended_at: ago(8000), outcome: 'crashed' },
      { attempt: 2, host: 'other-host', started_at: ago(7000), ended_at: ago(6000), outcome: 'protocol_violation' },
      { attempt: 3, host: 'other-host', started_at: ago(600), heartbeat_at: ago(600) },
    ],
    { failures: 2 },
  );
  h.gh.addIssue(kbIssue({ number: 7, status: 'running', agent: 'claude', kb: { max_retries: 2, max_runtime: 86_400 }, run }));
  h.gh.refs.set('refs/kb/locks/7/3', 'f'.repeat(40));

  const s = await h.tick();

  assert.deepEqual(s.reclaimed, [{ number: 7, outcome: 'gave_up' }]);
  assert.equal(h.gh.statusOf(7), 'blocked');
  assert.ok(h.gh.labelsOf(7).includes(L.needsHuman));
  assert.deepEqual(h.gh.lockRefs(), []);
  const saved = h.gh.runOf(7);
  assert.equal(saved.failures, 3);
  assert.equal(saved.attempts[2].outcome, 'reclaimed');
  const last = saved.attempts[3];
  assert.equal(last.outcome, 'gave_up');
  assert.equal(last.synthetic, true);
  assert.equal(last.profile, 'dispatcher');
  assert.match(last.reason, /3 consecutive failures \(limit 2\)/);
  assert.equal(s.claimed.length, 0); // and it is not picked up again
});

test('active_pr guard: an open PR sends a ready task to review, even with no slot', async (t) => {
  const h = harness();
  t.after(h.cleanup);
  h.gh.addIssue(kbIssue({ number: 7, status: 'ready', agent: 'claude', prs: [{ number: 42, state: 'OPEN', isDraft: true }] }));
  h.gh.addIssue(kbIssue({ number: 8, status: 'ready', agent: 'claude', prs: [{ number: 41, state: 'MERGED', merged: true }] }));

  const s = await h.tick({ max: 0 });

  assert.deepEqual(s.guarded, [{ number: 7, guard: 'active_pr', pr: 42 }]);
  assert.equal(h.gh.statusOf(7), 'review');
  assert.equal(h.gh.statusOf(8), 'ready'); // a merged PR is not a reason to wait
  assert.deepEqual(h.gh.lockRefs(), []);
  assert.match(h.log(), /#7: open PR #42 → review \(active_pr guard\)/);
});

// ---------- the active_pr guard and its one exemption (#153) ----------

test('activePrGuard: only the reviewer\'s changes_requested row exempts an open PR', () => {
  const pr = { number: 42, state: 'OPEN', headRefName: 'worktree-kb-7-1' };
  const merged = { number: 41, state: 'MERGED', merged: true };
  const row = (outcome, over = {}) => ({ attempt: 1, profile: 'claude', ended_at: ago(60), outcome, ...over });
  const sent_back = { attempt: 2, profile: 'reviewer', outcome: 'changes_requested', synthetic: true, ended_at: ago(10) };
  const table = [
    ['no PR at all', [row('completed')], [], { guard: false, continues: false }],
    ['no PR, no attempts', [], [], { guard: false, continues: false }],
    ['a merged PR is not a reason to wait', [row('completed')], [merged], { guard: false, continues: false }],
    ['an open PR with no attempts', [], [pr], { guard: true, continues: false }],
    ['an open PR after a completed attempt', [row('completed')], [pr], { guard: true, continues: false }],
    ['an open PR after a review request', [row('review_requested')], [pr], { guard: true, continues: false }],
    ['an open PR after a crash', [row('crashed')], [pr], { guard: true, continues: false }],
    ['the card request-changes produces', [row('review_requested'), sent_back], [pr], { guard: false, continues: true }],
    ['changes_requested, but not the latest row', [row('review_requested'), sent_back, row('crashed', { attempt: 3 })], [pr], { guard: true, continues: false }],
    ['changes_requested with no open PR', [row('review_requested'), sent_back], [merged], { guard: false, continues: false }],
  ];
  for (const [why, attempts, prs, want] of table) {
    const got = activePrGuard(attempts, prs);
    assert.equal(got.guard, want.guard, `${why}: guard`);
    assert.equal(got.continues, want.continues, `${why}: continues`);
    assert.equal(got.pr?.number ?? null, prs.some((p) => p.state === 'OPEN') ? pr.number : null, `${why}: pr`);
  }
});

test('a card sent back by the reviewer is claimed, not guarded, and the attempt names the PR', async (t) => {
  const h = harness();
  t.after(h.cleanup);
  const run = runWith([
    { attempt: 1, started_at: ago(900), ended_at: ago(600), outcome: 'review_requested', summary: 'done', pr: 42 },
    { attempt: 2, profile: 'reviewer', started_at: ago(30), ended_at: ago(30), outcome: 'changes_requested', reason: 'rename the flag', synthetic: true },
  ]);
  h.gh.addIssue(kbIssue({ number: 7, status: 'ready', agent: 'claude', run, prs: [{ number: 42, state: 'OPEN', isDraft: true, headRefName: 'worktree-kb-7-1' }] }));
  // the ordinary case, side by side: an open PR with no reviewer row is still parked in review
  h.gh.addIssue(kbIssue({ number: 8, status: 'ready', agent: 'claude', prs: [{ number: 43, state: 'OPEN', isDraft: true }] }));

  const s = await h.tick();

  assert.deepEqual(s.guarded, [{ number: 8, guard: 'active_pr', pr: 43 }]);
  assert.equal(h.gh.statusOf(8), 'review');
  assert.deepEqual(s.claimed.map((c) => c.number), [7]);
  assert.equal(s.claimed[0].continues_pr, 42);
  assert.equal(h.gh.statusOf(7), 'running');
  const last = h.gh.runOf(7).attempts.at(-1);
  assert.equal(last.attempt, 3);
  assert.equal(last.continues_pr, 42, 'the run record says which PR this attempt continues');
  assert.match(h.log(), /#7: claimed attempt 3 .*continuing PR #42/);
});

test('a claim that could not take the PR branch still runs, and says so', async (t) => {
  const h = harness(); // the board root is a plain temp directory: no git, so no checkout is possible
  t.after(h.cleanup);
  const run = runWith([
    { attempt: 1, ended_at: ago(600), outcome: 'review_requested' },
    { attempt: 2, profile: 'reviewer', ended_at: ago(30), outcome: 'changes_requested', synthetic: true },
  ]);
  h.gh.addIssue(kbIssue({ number: 7, status: 'ready', agent: 'claude', run, prs: [{ number: 42, state: 'OPEN', headRefName: 'worktree-kb-7-1' }] }));

  const s = await h.tick();

  assert.deepEqual(s.claimed.map((c) => c.number), [7]);
  const last = h.gh.runOf(7).attempts.at(-1);
  assert.equal(last.continues_pr, 42);
  assert.equal(last.continues_branch, undefined, 'no branch was checked out, so the row does not claim one');
  assert.match(h.log(), /continuing PR #42 from a fresh worktree \(.*\) — the brief says which PR to push to/);
});

test('the continuation runs in a worktree on the PR\'s own branch', async (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hkb-continue-')));
  const git = (...args) => {
    const r = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
    return r.stdout.trim();
  };
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'test');
  git('commit', '-q', '--allow-empty', '-m', 'root');
  // attempt 1's branch and the worktree still sitting on it — nothing sweeps a card in review
  git('worktree', 'add', '-q', '-b', 'worktree-kb-7-1', path.join(root, worktreePath('kb-7-1')));
  const h = harness({ root });
  t.after(h.cleanup);
  const run = runWith([
    { attempt: 1, ended_at: ago(600), outcome: 'review_requested', pr: 42 },
    { attempt: 2, profile: 'reviewer', ended_at: ago(30), outcome: 'changes_requested', synthetic: true },
  ]);
  h.gh.addIssue(kbIssue({ number: 7, status: 'ready', agent: 'claude', run, prs: [{ number: 42, state: 'OPEN', headRefName: 'worktree-kb-7-1' }] }));

  const s = await h.tick();

  assert.deepEqual(s.claimed.map((c) => c.number), [7]);
  const dir = path.join(root, worktreePath('kb-7-3'));
  assert.ok(fs.existsSync(path.join(dir, '.git')), 'attempt 3 got a checkout of its own');
  assert.equal(spawnSync('git', ['branch', '--show-current'], { cwd: dir, encoding: 'utf8' }).stdout.trim(), 'worktree-kb-7-1');
  assert.ok(!fs.existsSync(path.join(root, worktreePath('kb-7-1'), '.git')), 'the ended attempt\'s checkout was freed to release the branch');
  const last = h.gh.runOf(7).attempts.at(-1);
  assert.equal(last.continues_pr, 42);
  assert.equal(last.continues_branch, 'worktree-kb-7-1');
  assert.equal(last.wt, 'kb-7-3');
  assert.match(h.log(), /continuing PR #42 on worktree-kb-7-1/);
});

test('the review loop turns: request-changes → claim → finish, all on one PR', async (t) => {
  const h = harness();
  t.after(h.cleanup);
  const run = runWith([{ attempt: 1, started_at: ago(900), ended_at: ago(600), outcome: 'review_requested', summary: 'ready', pr: 42 }]);
  h.gh.addIssue(kbIssue({ number: 7, status: 'review', agent: 'claude', run, prs: [{ number: 42, state: 'OPEN', isDraft: false, headRefName: 'worktree-kb-7-1' }] }));

  const sentBack = await requestChanges(h.ctx, 7, { reason: 'rename the flag' });
  assert.deepEqual(sentBack, { number: 7, status: 'ready', pr: 42, note: 'PR #42 stays open; the next attempt continues it' });

  const s = await h.tick();
  assert.deepEqual(s.claimed.map((c) => c.number), [7], 'the card the reviewer sent back is relaunched, not parked');

  const done = await complete(h.ctx, 7, { summary: 'flag renamed', attempt: 3 });
  assert.equal(done.status, 'review');
  assert.equal(done.pr, 42);
  assert.equal(done.pr_continued, true);
  assert.match(done.note, /^continued PR #42 —/);

  // one PR, three rows, and the result comment says the PR was continued rather than opened
  assert.deepEqual(h.gh.runOf(7).attempts.map((a) => a.outcome), ['review_requested', 'changes_requested', 'completed']);
  assert.equal(h.gh.issues.get(7).prs.length, 1);
  const result = h.gh.issues.get(7).comments.map((c) => c.body).find((b) => b.startsWith(RESULT_MARKER));
  assert.match(result, /\*\*PR:\*\* #42 — continued after changes requested, not reopened/);
});

test('withoutWorktreeFlag drops the harness\'s own checkout flag and nothing else', () => {
  assert.deepEqual(
    withoutWorktreeFlag(['claude', '--bg', '--worktree', 'kb-7-2', '--permission-mode', 'dontAsk', 'the prompt']),
    ['claude', '--bg', '--permission-mode', 'dontAsk', 'the prompt'],
  );
  assert.deepEqual(withoutWorktreeFlag(['claude', '--worktree=kb-7-2', '-p']), ['claude', '-p']);
  // codex's -C names the dispatcher's own directory: it must survive
  assert.deepEqual(withoutWorktreeFlag(['codex', 'exec', '-C', '/w/kb-7-2', '--sandbox']), ['codex', 'exec', '-C', '/w/kb-7-2', '--sandbox']);
});

test('path_overlap guard: a ready task waits for the running task that owns its files', async (t) => {
  const h = harness();
  t.after(h.cleanup);
  const run = runWith([{ attempt: 1, host: 'test-host', started_at: ago(30), heartbeat_at: ago(5), pid: process.pid }]);
  h.gh.addIssue(kbIssue({ number: 7, status: 'running', agent: 'claude', kb: { paths: ['src/'] }, run }));
  h.gh.addIssue(kbIssue({ number: 8, status: 'ready', agent: 'claude', kb: { paths: ['src/gh.js'] } }));
  h.gh.addIssue(kbIssue({ number: 9, status: 'ready', agent: 'claude', kb: { paths: ['docs/readme.md'] } }));
  h.gh.refs.set('refs/kb/locks/7/1', 'f'.repeat(40));

  const s = await h.tick();

  assert.deepEqual(s.reclaimed, []); // the live worker is left alone
  assert.deepEqual(s.guarded, [{ number: 8, guard: 'path_overlap' }]);
  assert.equal(h.gh.statusOf(8), 'ready');
  assert.deepEqual(s.claimed.map((c) => c.number), [9]); // a disjoint path still goes
  assert.deepEqual(h.gh.lockRefs(), ['refs/kb/locks/7/1', 'refs/kb/locks/9/1']);
});

test('recent_success guard: a task that just completed is not immediately re-run', async (t) => {
  const h = harness({ dispatch: { recent_success_window: 600 } });
  t.after(h.cleanup);
  const run = runWith([{ attempt: 1, host: 'test-host', started_at: ago(400), ended_at: ago(60), outcome: 'completed' }]);
  h.gh.addIssue(kbIssue({ number: 7, status: 'ready', agent: 'claude', run }));

  const s = await h.tick();

  assert.deepEqual(s.guarded, [{ number: 7, guard: 'recent_success' }]);
  assert.deepEqual(h.gh.lockRefs(), []);
});

test('claims are create-if-absent, and releasing twice is not an error', async (t) => {
  const h = harness();
  t.after(h.cleanup);

  assert.equal((await claim(h.ctx, 4, 1)).result, 'claimed');
  const second = await claim(h.ctx, 4, 1);
  assert.equal(second.result, 'held');
  assert.equal(second.error, null);
  assert.deepEqual((await listLocks(h.ctx)).map((l) => `${l.n}/${l.k}`), ['4/1']);
  assert.equal(await release(h.ctx, 4, 1), true);
  assert.equal(await release(h.ctx, 4, 1), false);
  assert.deepEqual(await listLocks(h.ctx), []);
});

test('a dry run reports what it would do and writes nothing', async (t) => {
  const h = harness();
  t.after(h.cleanup);
  h.gh.addIssue(kbIssue({ number: 1, status: 'done', state: 'CLOSED', stateReason: 'COMPLETED' }));
  h.gh.addIssue(kbIssue({ number: 2, status: 'todo', blockedBy: [1] }));
  h.gh.addIssue(kbIssue({ number: 3, status: 'ready', agent: 'claude' }));

  const s = await h.tick({ dryRun: true });

  assert.deepEqual(s.promoted, [2]);
  assert.deepEqual(s.claimed, [{ number: 3, attempt: 1, profile: 'claude', dry: true }]);
  assert.equal(h.gh.statusOf(2), 'todo');
  assert.equal(h.gh.statusOf(3), 'ready');
  assert.deepEqual(h.gh.lockRefs(), []);
  assert.equal(h.gh.callsMatching('POST').length, 0);
  assert.equal(h.gh.callsMatching('PATCH').length, 0);
  assert.equal(h.gh.callsMatching('DELETE').length, 0);
});
