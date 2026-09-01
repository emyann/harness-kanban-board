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

/** `~/.claude/jobs` as `claude --bg` keeps it: a directory per job, holding its state.json. */
function jobsRootWith(records, into) {
  for (const [id, state] of Object.entries(records)) {
    fs.mkdirSync(path.join(into, id), { recursive: true });
    if (state) fs.writeFileSync(path.join(into, id, 'state.json'), JSON.stringify(state));
  }
  return into;
}

/** A `claude` on PATH that answers `claude agents --json` with the given listing. */
function stubClaude(root, jobs) {
  const bin = path.join(root, 'stub-bin');
  fs.mkdirSync(bin, { recursive: true });
  const listing = path.join(bin, 'agents.json');
  fs.writeFileSync(listing, JSON.stringify(jobs));
  fs.writeFileSync(path.join(bin, 'claude'), [
    '#!/bin/sh',
    'case "$1" in',
    `  agents) cat ${JSON.stringify(listing)} ;;`,
    '  stop) exit 0 ;;',
    '  *) exit 1 ;;',
    'esac',
    '',
  ].join('\n'), { mode: 0o755 });
  process.env.PATH = `${bin}${path.delimiter}${process.env.PATH}`;
}

/**
 * `harness()` plus a `claude-bg` profile, a stubbed `claude` on PATH, and a HOME whose
 * `.claude/jobs` holds the given job records — `jobsDir()` reads $HOME, which is the only way to
 * put a job record where the dispatcher's idle check looks for one.
 */
function bgHarness({ jobs = [], records = {}, dispatch = {} } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hkb-dispatch-bg-'));
  const home = path.join(root, 'home');
  jobsRootWith(records, path.join(home, '.claude', 'jobs'));
  const h = harness({
    root, dispatch,
    profiles: { claude: { mode: 'claude-bg', max_in_progress: 2, model: null, allowed_tools: [], launch: ['true'] } },
  });
  const savedEnv = { PATH: process.env.PATH, HOME: process.env.HOME };
  process.env.HOME = home;
  stubClaude(root, jobs);
  const cleanup = h.cleanup;
  h.cleanup = () => { cleanup(); Object.assign(process.env, savedEnv); };
  return h;
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

// #155: a pid-mode attempt the tick writes off as crashed/timed_out has a log of its own, so it
// gets session, cost and `terminal_reason` the way a `--bg` row has since #137.
test('a crashed pid-mode attempt gets session and terminal_reason backfilled from its own log', async (t) => {
  const h = harness({ dispatch: { stale_after: 3600 } });
  t.after(h.cleanup);
  const logRel = '.kanban/logs/7-1.log';
  fs.mkdirSync(path.dirname(path.join(h.root, logRel)), { recursive: true });
  fs.writeFileSync(path.join(h.root, logRel), JSON.stringify({
    type: 'result', session_id: 'sid-crashed', total_cost_usd: 0.12, num_turns: 5, duration_ms: 12_000,
    terminal_reason: 'max_turns',
  }) + '\n');
  const run = runWith([{ attempt: 1, host: 'test-host', started_at: ago(600), heartbeat_at: ago(5), pid: 4_000_000, log: logRel }]);
  h.gh.addIssue(kbIssue({ number: 7, status: 'running', agent: 'claude', kb: { max_runtime: 86_400 }, run }));
  h.gh.beat(7, 1, ago(1));

  const s = await h.tick({ max: 0 });

  assert.deepEqual(s.reclaimed, [{ number: 7, outcome: 'crashed' }]);
  const a = h.gh.runOf(7).attempts[0];
  assert.equal(a.session_id, 'sid-crashed');
  assert.equal(a.terminal_reason, 'max_turns');
  assert.equal(a.total_cost_usd, 0.12);
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

test('protocol_violation with an open PR: the work landed, so the reason is recorded but the retry budget is not spent', async (t) => {
  const h = bgHarness({
    jobs: [{ kind: 'background', id: 'j7', pid: 1007, name: 'kb #7 · task', cwd: '/repo/.claude/worktrees/kb-7-1', state: 'done', status: 'idle' }],
  });
  t.after(h.cleanup);
  const run = runWith([{ attempt: 1, host: 'test-host', bg: true, job: 'j7', wt: 'kb-7-1', started_at: ago(120), heartbeat_at: ago(5) }]);
  h.gh.addIssue(kbIssue({
    number: 7, status: 'running', agent: 'claude', kb: { max_runtime: 86_400 }, run,
    prs: [{ number: 42, state: 'OPEN', headRefName: 'worktree-kb-7-1' }],
  }));
  h.gh.refs.set('refs/kb/locks/7/1', 'f'.repeat(40));

  const s = await h.tick();

  assert.deepEqual(s.reclaimed, [{ number: 7, outcome: 'protocol_violation' }]);
  const saved = h.gh.runOf(7);
  assert.equal(saved.attempts[0].outcome, 'protocol_violation');
  assert.equal(saved.attempts[0].pr, 42, 'the row names the PR the work landed on');
  assert.equal(saved.failures, 0, 'no verb but an open PR is not a failure — nothing went wrong twice');
  assert.equal(h.gh.statusOf(7), 'ready'); // the active_pr guard sends it to review on the next tick
});

test('protocol_violation with no PR: nothing to show, so it counts against the retry budget', async (t) => {
  const h = bgHarness({
    jobs: [{ kind: 'background', id: 'j7', pid: 1007, name: 'kb #7 · task', cwd: '/repo/.claude/worktrees/kb-7-1', state: 'done', status: 'idle' }],
  });
  t.after(h.cleanup);
  const run = runWith([{ attempt: 1, host: 'test-host', bg: true, job: 'j7', wt: 'kb-7-1', started_at: ago(120), heartbeat_at: ago(5) }]);
  h.gh.addIssue(kbIssue({ number: 7, status: 'running', agent: 'claude', kb: { max_runtime: 86_400 }, run }));
  h.gh.refs.set('refs/kb/locks/7/1', 'f'.repeat(40));

  const s = await h.tick();

  assert.deepEqual(s.reclaimed, [{ number: 7, outcome: 'protocol_violation' }]);
  const saved = h.gh.runOf(7);
  assert.equal(saved.attempts[0].outcome, 'protocol_violation');
  assert.equal(saved.attempts[0].pr, undefined, 'no PR to name');
  assert.equal(saved.failures, 1);
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

test('activePrGuard: with two open PRs, the last review_requested/completed row picks the winner', () => {
  const first = { number: 41, state: 'OPEN', headRefName: 'worktree-kb-7-1' };
  const second = { number: 43, state: 'OPEN', headRefName: 'worktree-kb-7-3' };
  const attempts = [
    { attempt: 1, profile: 'claude', outcome: 'review_requested', ended_at: ago(600), pr: 41 },
    { attempt: 2, profile: 'claude', outcome: 'review_requested', ended_at: ago(60), pr: 43 },
  ];

  const got = activePrGuard(attempts, [first, second]);

  assert.equal(got.pr.number, 43, 'the PR the latest review row named, not the first OPEN one in the list');
  assert.equal(got.guard, true);
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

test('a trigger-mode continuation records continues_pr only — no checkout, no continues_branch', async (t) => {
  // trigger mode (claude-action) never runs the worker itself: the real checkout happens elsewhere,
  // in a fresh `actions/checkout` this dispatcher never sees, so it must not claim one of its own (#162)
  const h = harness({ profiles: { claude: { mode: 'trigger', max_in_progress: 2, model: null, allowed_tools: [], launch: ['true'] } } });
  t.after(h.cleanup);
  const run = runWith([
    { attempt: 1, ended_at: ago(600), outcome: 'review_requested', pr: 42 },
    { attempt: 2, profile: 'reviewer', ended_at: ago(30), outcome: 'changes_requested', synthetic: true },
  ]);
  h.gh.addIssue(kbIssue({ number: 7, status: 'ready', agent: 'claude', run, prs: [{ number: 42, state: 'OPEN', headRefName: 'worktree-kb-7-1' }] }));

  const s = await h.tick();

  assert.deepEqual(s.claimed.map((c) => c.number), [7]);
  assert.ok(!fs.existsSync(path.join(h.root, worktreePath('kb-7-3'))), 'no worktree was made for a trigger-mode continuation');
  const last = h.gh.runOf(7).attempts.at(-1);
  assert.equal(last.continues_pr, 42);
  assert.equal(last.continues_branch, undefined, 'the real checkout happens elsewhere; this run record must not claim one');
  assert.equal(last.wt, undefined);
  assert.match(h.log(), /#7: claimed attempt 3 .*continuing PR #42/, 'the claim log line still names the PR it continues');
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

test('a continued checkout is fast-forwarded to a branch a human pushed to since the last attempt', async (t) => {
  const origin = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hkb-continue-origin-')));
  const git = (cwd, ...args) => {
    const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
    assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
    return r.stdout.trim();
  };
  git(origin, 'init', '-q', '--bare', '-b', 'main');

  // a human clone: pushes the branch attempt 1 left, then a second commit attempt 3 has never seen
  const human = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hkb-continue-human-')));
  git(human, 'clone', '-q', origin, '.');
  git(human, 'config', 'user.email', 'test@example.com');
  git(human, 'config', 'user.name', 'test');
  git(human, 'commit', '-q', '--allow-empty', '-m', 'root');
  git(human, 'push', '-q', 'origin', 'main');
  git(human, 'checkout', '-q', '-b', 'worktree-kb-7-1');
  git(human, 'commit', '-q', '--allow-empty', '-m', 'attempt 1');
  git(human, 'push', '-q', 'origin', 'worktree-kb-7-1');

  // the board root: a clone that made attempt 1's worktree at that same commit, then fell behind
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hkb-continue-root-')));
  git(root, 'clone', '-q', origin, '.');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'user.name', 'test');
  git(root, 'worktree', 'add', '-q', '-b', 'worktree-kb-7-1', path.join(root, worktreePath('kb-7-1')), 'origin/worktree-kb-7-1');

  // now a human pushes a second commit to the PR branch — attempt 3's local branch is behind it
  git(human, 'commit', '-q', '--allow-empty', '-m', 'human fixup');
  git(human, 'push', '-q', 'origin', 'worktree-kb-7-1');
  const humanHead = git(human, 'rev-parse', 'worktree-kb-7-1');

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
  assert.equal(git(dir, 'rev-parse', 'HEAD'), humanHead, 'the checkout was fast-forwarded to the branch\'s remote head');
  const last = h.gh.runOf(7).attempts.at(-1);
  assert.equal(last.continues_branch, 'worktree-kb-7-1');
  assert.equal(last.continues_branch_stale, undefined, 'a clean fast-forward has nothing to report');
  // an ordinary push from here must succeed — nothing to push, since the checkout is already at the head
  const push = spawnSync('git', ['push', 'origin', 'HEAD:worktree-kb-7-1'], { cwd: dir, encoding: 'utf8' });
  assert.equal(push.status, 0, push.stderr);
});

test('a branch this host has never fetched is reported as nothing to catch up to, not a divergence', async (t) => {
  // no origin remote at all: the fetch fails silently and `origin/<branch>` was never created, so
  // the ff-only merge has no ref to resolve — distinct from a real divergence (#162 review nit)
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hkb-continue-noref-')));
  const git = (...args) => {
    const r = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
    return r.stdout.trim();
  };
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'test');
  git('commit', '-q', '--allow-empty', '-m', 'root');
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
  const last = h.gh.runOf(7).attempts.at(-1);
  assert.equal(last.continues_branch, 'worktree-kb-7-1');
  assert.match(last.continues_branch_stale, /no origin\/worktree-kb-7-1 ref to catch up to/);
});

test('a checkout reused from a dead spawn is still caught up to the remote head', async (t) => {
  const origin = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hkb-continue-reuse-origin-')));
  const git = (cwd, ...args) => {
    const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
    assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
    return r.stdout.trim();
  };
  git(origin, 'init', '-q', '--bare', '-b', 'main');
  const human = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hkb-continue-reuse-human-')));
  git(human, 'clone', '-q', origin, '.');
  git(human, 'config', 'user.email', 'test@example.com');
  git(human, 'config', 'user.name', 'test');
  git(human, 'commit', '-q', '--allow-empty', '-m', 'root');
  git(human, 'push', '-q', 'origin', 'main');
  git(human, 'checkout', '-q', '-b', 'worktree-kb-7-1');
  git(human, 'commit', '-q', '--allow-empty', '-m', 'attempt 1');
  git(human, 'push', '-q', 'origin', 'worktree-kb-7-1');

  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hkb-continue-reuse-root-')));
  git(root, 'clone', '-q', origin, '.');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'user.name', 'test');
  // a checkout that already exists at kb-7-3, as if a spawn died between the checkout and the launch
  git(root, 'worktree', 'add', '-q', '-b', 'worktree-kb-7-1', path.join(root, worktreePath('kb-7-3')), 'origin/worktree-kb-7-1');

  // a human pushes another commit while this reused checkout is still at the old one
  git(human, 'commit', '-q', '--allow-empty', '-m', 'human fixup');
  git(human, 'push', '-q', 'origin', 'worktree-kb-7-1');
  const humanHead = git(human, 'rev-parse', 'worktree-kb-7-1');

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
  assert.equal(git(dir, 'rev-parse', 'HEAD'), humanHead, 'the reused checkout was fetched and fast-forwarded too');
  const last = h.gh.runOf(7).attempts.at(-1);
  assert.equal(last.continues_branch_stale, undefined, 'a clean fast-forward has nothing to report');
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

test('request-changes keeps the reviewer\'s note in full, unlike the other terminal verbs', async (t) => {
  const h = harness();
  t.after(h.cleanup);
  const run = runWith([{ attempt: 1, started_at: ago(900), ended_at: ago(600), outcome: 'review_requested', summary: 'ready', pr: 42 }]);
  h.gh.addIssue(kbIssue({ number: 7, status: 'review', agent: 'claude', run, prs: [{ number: 42, state: 'OPEN', isDraft: false, headRefName: 'worktree-kb-7-1' }] }));
  const longReason = 'item 1: fix the retry loop. '.repeat(60).trim();
  assert.ok(longReason.length > 1500);

  await requestChanges(h.ctx, 7, { reason: longReason });

  assert.equal(h.gh.runOf(7).attempts.at(-1).reason, longReason, 'the attempt row must not be truncated to 400 chars');
});

// ---------- #195: a long-lived loop must not judge a card on a comments cache from an earlier tick ----------

test('a request-changes from another process between ticks is honoured, not bounced by the loop\'s stale comments cache', async (t) => {
  const h = harness();
  t.after(h.cleanup);
  const run = runWith([{ attempt: 1, started_at: ago(900), ended_at: ago(600), outcome: 'review_requested', summary: 'ready', pr: 42 }]);
  h.gh.addIssue(kbIssue({ number: 7, status: 'ready', agent: 'claude', run, prs: [{ number: 42, state: 'OPEN', isDraft: true, headRefName: 'worktree-kb-7-1' }] }));

  // tick 1: no changes_requested row yet, so the active_pr guard bounces #7 to review — and the
  // loop's ctx now has #7's comments (only the review_requested row) memoized.
  const s1 = await h.tick();
  assert.deepEqual(s1.guarded, [{ number: 7, guard: 'active_pr', pr: 42 }]);
  assert.equal(h.gh.statusOf(7), 'review');

  // another process — a reviewer's own `hkb request-changes`, its own ctx and cache — sends it back.
  const otherCtx = { ...h.ctx, _cache: {}, caps: {} };
  const sentBack = await requestChanges(otherCtx, 7, { reason: 'rename the flag' });
  assert.equal(sentBack.status, 'ready');

  // tick 2, same long-lived loop ctx: judging #7 on tick 1's cached comments would still see only
  // the review_requested row and guard it straight back to review — the exact bounce #153 removed
  // and #195 observed on hkb's own board.
  const s2 = await h.tick();

  assert.deepEqual(s2.guarded, [], 'the changes_requested row written by another process must be seen');
  assert.deepEqual(s2.claimed.map((c) => c.number), [7]);
  assert.equal(s2.claimed[0].continues_pr, 42);
  assert.equal(h.gh.statusOf(7), 'running');
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

test('path_overlap guard: a ready task waits for the running task that owns its files ("running" mode)', async (t) => {
  // "running" is the mode a board keeps by setting it explicitly (#185) — the default on a manual
  // board (this harness's default) is "off"; see the two default tests below.
  const h = harness({ dispatch: { guards: { path_overlap: 'running' } } });
  t.after(h.cleanup);
  const run = runWith([{ attempt: 1, host: 'test-host', started_at: ago(30), heartbeat_at: ago(5), pid: process.pid }]);
  h.gh.addIssue(kbIssue({ number: 7, status: 'running', agent: 'claude', kb: { paths: ['src/'] }, run }));
  h.gh.addIssue(kbIssue({ number: 8, status: 'ready', agent: 'claude', kb: { paths: ['src/gh.js'] } }));
  h.gh.addIssue(kbIssue({ number: 9, status: 'ready', agent: 'claude', kb: { paths: ['docs/readme.md'] } }));
  h.gh.refs.set('refs/kb/locks/7/1', 'f'.repeat(40));

  const s = await h.tick();

  assert.deepEqual(s.reclaimed, []); // the live worker is left alone
  assert.deepEqual(s.guarded, [{ number: 8, guard: 'path_overlap', collides_with: [{ number: 7, paths: ['src/'] }] }]);
  assert.equal(h.gh.statusOf(8), 'ready');
  assert.deepEqual(s.claimed.map((c) => c.number), [9]); // a disjoint path still goes
  assert.deepEqual(h.gh.lockRefs(), ['refs/kb/locks/7/1', 'refs/kb/locks/9/1']);
});

test('path_overlap guard: off by default on a manual board — both overlapping cards run', async (t) => {
  const h = harness(); // dispatch.merge.mode defaults to "manual"
  t.after(h.cleanup);
  const run = runWith([{ attempt: 1, host: 'test-host', started_at: ago(30), heartbeat_at: ago(5), pid: process.pid }]);
  h.gh.addIssue(kbIssue({ number: 7, status: 'running', agent: 'claude', kb: { paths: ['src/'] }, run }));
  h.gh.addIssue(kbIssue({ number: 8, status: 'ready', agent: 'claude', kb: { paths: ['src/gh.js'] } }));

  const s = await h.tick();

  assert.deepEqual(s.guarded, []);
  assert.deepEqual(s.claimed.map((c) => c.number), [8]);
});

test('path_overlap guard: "unmerged" on an auto-merge board keys on review, not just running', async (t) => {
  const h = harness({ dispatch: { merge: { mode: 'auto' } } });
  t.after(h.cleanup);
  h.gh.addIssue(kbIssue({ number: 7, status: 'review', agent: 'claude', kb: { paths: ['src/'] }, prs: [{ number: 42, state: 'OPEN', isDraft: false }] }));
  h.gh.addIssue(kbIssue({ number: 8, status: 'ready', agent: 'claude', kb: { paths: ['src/gh.js'] } }));

  const s = await h.tick();

  assert.deepEqual(s.guarded, [{ number: 8, guard: 'path_overlap', collides_with: [{ number: 7, paths: ['src/'] }] }]);
  assert.deepEqual(s.claimed, []);
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

// ---------- what the launch hands the harness ----------
// `claude --bg` does not run the worker: it asks Claude Code's session daemon to, and a launch that
// finds no daemon STARTS one — which then keeps the launch environment for its whole life and hands
// it to every session it hosts, the operator's own included (#150). The environment reaches no
// worker on that path anyway (#125: the `kb-<n>-<k>` checkout is that profile's identity), so it is
// scrubbed. For every harness the dispatcher runs as a child process it is the whole identity, and
// the hook's gate, so it stays exactly as it was.

/** A launch that writes the environment it was given to `out`, and a `claude` that answers nothing. */
function envRecorder(dir, name) {
  const out = path.join(dir, `${name}.json`);
  const bin = path.join(dir, 'stub-bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'claude'), '#!/bin/sh\nexit 1\n', { mode: 0o755 }); // `claude agents` finds none
  return { out, launch: ['node', '-e', `require('fs').writeFileSync(${JSON.stringify(out)}, JSON.stringify(process.env))`] };
}

async function readWhenWritten(file, tries = 200) {
  for (let i = 0; i < tries; i++) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { await new Promise((r) => setTimeout(r, 25)); }
  }
  throw new Error(`${file} was never written by the launch`);
}

test('a claude --bg launch gets no KB_* at all; a child-process launch keeps its identity', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hkb-launchenv-'));
  const background = envRecorder(dir, 'background');
  const child = envRecorder(dir, 'child');
  const savedPath = process.env.PATH;
  process.env.PATH = `${path.join(dir, 'stub-bin')}${path.delimiter}${savedPath}`;
  const h = harness({
    profiles: {
      claude: { mode: 'claude-bg', max_in_progress: 2, model: null, allowed_tools: [], launch: background.launch },
      'claude-p': { mode: 'process', max_in_progress: 2, model: null, allowed_tools: [], launch: child.launch },
    },
  });
  t.after(() => { process.env.PATH = savedPath; h.cleanup(); fs.rmSync(dir, { recursive: true, force: true }); });
  h.gh.addIssue(kbIssue({ number: 7, status: 'ready', agent: 'claude' }));
  h.gh.addIssue(kbIssue({ number: 8, status: 'ready', agent: 'claude-p' }));

  await h.tick();

  const bg = await readWhenWritten(background.out);
  assert.deepEqual(Object.keys(bg).filter((k) => k.startsWith('KB_')), [],
    'a daemon started by this launch would carry these for its whole life');
  assert.ok(bg.PATH, 'and everything else is still there');

  const proc = await readWhenWritten(child.out);
  assert.equal(proc.KB_TASK, '8', 'a child process has no checkout fallback: this is its only identity');
  assert.equal(proc.KB_ATTEMPT, '1');
  assert.equal(proc.KB_PROFILE, 'claude-p');
  assert.equal(proc.KB_ROOT, h.root);
  assert.equal(proc.KB_LOCK_REF, 'refs/kb/locks/8/1');
});

test('path_overlap guard: an idle no-job, no-pid attempt never holds its paths, in any mode', async (t) => {
  // A hand-claimed (manual) attempt has neither a job record nor a pid to ask, so its lock-ref beat
  // is the only advancing signal (#185, second pass). Past the idle threshold (max(interval, 1200s):
  // a plain heartbeat floors at ~10 minutes, so one tick interval alone is too tight) but still well
  // inside stale_after (3600s default), so the reclaim pass leaves it running rather than reclaiming
  // it — the path_overlap guard must still look straight past it.
  const h = harness({ dispatch: { guards: { path_overlap: 'running' } } });
  t.after(h.cleanup);
  const run = runWith([{ attempt: 1, host: 'test-host', started_at: ago(1800), heartbeat_at: ago(1800), lock_sha: 'a'.repeat(40), manual: true }]);
  h.gh.addIssue(kbIssue({ number: 7, status: 'running', agent: 'claude', kb: { paths: ['src/'] }, run }));
  h.gh.addIssue(kbIssue({ number: 8, status: 'ready', agent: 'claude', kb: { paths: ['src/gh.js'] } }));
  h.gh.beat(7, 1, ago(1800));

  const s = await h.tick();

  assert.deepEqual(s.reclaimed, []); // still well inside stale_after — not reclaimed, just idle
  assert.deepEqual(s.guarded, []);
  assert.deepEqual(s.claimed.map((c) => c.number), [8], '#7 has gone idle, so #8 is not held behind it');
  assert.match(h.log(), /#7: attempt 1 idle since/);
});

test('path_overlap guard: a fresh lock-ref beat keeps a no-job, no-pid attempt holding its paths', async (t) => {
  // The positive half of the case above (#185, third pass): the run comment says 30 minutes of
  // silence, but the ref-CAS beat is 30 seconds old — the idle-threshold beat read must find it and
  // the guard must keep #8 behind #7. This is the manual / remote / other-host shape of a live worker.
  const h = harness({ dispatch: { guards: { path_overlap: 'running' } } });
  t.after(h.cleanup);
  const run = runWith([{ attempt: 1, host: 'test-host', started_at: ago(1800), heartbeat_at: ago(1800), lock_sha: 'a'.repeat(40), manual: true }]);
  h.gh.addIssue(kbIssue({ number: 7, status: 'running', agent: 'claude', kb: { paths: ['src/'] }, run }));
  h.gh.addIssue(kbIssue({ number: 8, status: 'ready', agent: 'claude', kb: { paths: ['src/gh.js'] } }));
  h.gh.beat(7, 1, ago(30));

  const s = await h.tick();

  assert.deepEqual(s.reclaimed, []);
  assert.deepEqual(s.guarded, [{ number: 8, guard: 'path_overlap', collides_with: [{ number: 7, paths: ['src/'] }] }]);
  assert.deepEqual(s.claimed, [], 'the beat is fresh, so #7 keeps holding #8 back');
  assert.doesNotMatch(h.log(), /#7: attempt 1 idle since/);
});

test('path_overlap guard: a live pid holds its paths no matter how old its heartbeat looks', async (t) => {
  // The measured failure (#185, third pass): a `process` attempt's default heartbeat never touches
  // the run comment either, so `lastSignal` sits at `started_at` for its whole life — a live pid
  // must be as authoritative as a live job, not a stale timestamp.
  const h = harness({ dispatch: { guards: { path_overlap: 'running' } } });
  t.after(h.cleanup);
  const run = runWith([{ attempt: 1, host: 'test-host', started_at: ago(1800), heartbeat_at: ago(1800), pid: process.pid }]);
  h.gh.addIssue(kbIssue({ number: 7, status: 'running', agent: 'claude', kb: { paths: ['src/'] }, run }));
  h.gh.addIssue(kbIssue({ number: 8, status: 'ready', agent: 'claude', kb: { paths: ['src/gh.js'] } }));
  h.gh.refs.set('refs/kb/locks/7/1', 'f'.repeat(40));

  const s = await h.tick();

  assert.deepEqual(s.reclaimed, []);
  assert.deepEqual(s.guarded, [{ number: 8, guard: 'path_overlap', collides_with: [{ number: 7, paths: ['src/'] }] }]);
  assert.deepEqual(s.claimed, [], 'the pid is still alive, so #7 keeps holding #8 back');
});

test('path_overlap guard: a dry run never silences the real loop\'s idle log line', async (t) => {
  // The idle line is logged once per attempt via state.idle_logged (#185) — a `--dry-run` tick must
  // not persist that bookkeeping, or the real loop's next tick would find the key already set and
  // say nothing the first time it actually observes the attempt go idle.
  const h = harness({ dispatch: { guards: { path_overlap: 'running' } } });
  t.after(h.cleanup);
  const run = runWith([{ attempt: 1, host: 'test-host', started_at: ago(1800), heartbeat_at: ago(1800), lock_sha: 'a'.repeat(40), manual: true }]);
  h.gh.addIssue(kbIssue({ number: 7, status: 'running', agent: 'claude', kb: { paths: ['src/'] }, run }));
  h.gh.beat(7, 1, ago(1800));

  await h.tick({ dryRun: true });
  const before = h.logs.length;
  const s = await h.tick();

  assert.ok(
    h.logs.slice(before).some((l) => /#7: attempt 1 idle since/.test(l)),
    'the real tick still logs it — the dry run before it did not consume the once-per-attempt line',
  );
  assert.deepEqual(s.reclaimed, []);
});

test('path_overlap guard: a live bg job holds its paths no matter how old its heartbeat looks', async (t) => {
  // The measured failure (#185, reviewed): a `claude --bg` worker's default heartbeat is a ref-CAS
  // that never touches the run comment, so `lastSignal` sits at `started_at` for the attempt's whole
  // life. A job record showing the turn still going must be the authority, not that stale timestamp.
  const h = bgHarness({
    dispatch: { guards: { path_overlap: 'running' } },
    jobs: [{ kind: 'background', id: 'j7', pid: 1007, name: 'kb #7 · task', cwd: '/repo/.claude/worktrees/kb-7-1', state: 'working', status: 'busy' }],
  });
  t.after(h.cleanup);
  const run = runWith([{ attempt: 1, host: 'test-host', bg: true, job: 'j7', wt: 'kb-7-1', started_at: ago(1800), heartbeat_at: ago(1800) }]);
  h.gh.addIssue(kbIssue({ number: 7, status: 'running', agent: 'claude', kb: { paths: ['src/'], max_runtime: 86_400 }, run }));
  h.gh.addIssue(kbIssue({ number: 8, status: 'ready', agent: 'claude', kb: { paths: ['src/gh.js'] } }));
  h.gh.refs.set('refs/kb/locks/7/1', 'f'.repeat(40));

  const s = await h.tick();

  assert.deepEqual(s.reclaimed, []);
  assert.deepEqual(s.guarded, [{ number: 8, guard: 'path_overlap', collides_with: [{ number: 7, paths: ['src/'] }] }]);
  assert.deepEqual(s.claimed, [], 'the job is still working, so #7 keeps holding #8 back');
});

test('path_overlap guard: a bg job whose turn ended never holds its paths, even with a recent-looking heartbeat', async (t) => {
  const h = bgHarness({
    dispatch: { guards: { path_overlap: 'running' } },
    jobs: [{ kind: 'background', id: 'j7', pid: 1007, name: 'kb #7 · task', cwd: '/repo/.claude/worktrees/kb-7-1', state: 'done', status: 'idle' }],
  });
  t.after(h.cleanup);
  const run = runWith([{ attempt: 1, host: 'test-host', bg: true, job: 'j7', wt: 'kb-7-1', started_at: ago(120), heartbeat_at: ago(5) }]);
  h.gh.addIssue(kbIssue({ number: 7, status: 'running', agent: 'claude', kb: { paths: ['src/'], max_runtime: 86_400 }, run }));
  h.gh.addIssue(kbIssue({ number: 8, status: 'ready', agent: 'claude', kb: { paths: ['src/gh.js'] } }));
  h.gh.refs.set('refs/kb/locks/7/1', 'f'.repeat(40));

  const s = await h.tick();

  // classifyJob(job) !== 'running' and started_at is > 30s old: this attempt is also reclaimed as
  // protocol_violation this same tick, which is fine — the point under test is that path_overlap
  // never held #8 behind it in the meantime.
  assert.deepEqual(s.guarded, []);
  assert.deepEqual(s.claimed.map((c) => c.number), [8]);
});

test('path_overlap guard: "unmerged" stops guarding once the holder\'s PR is merged', async (t) => {
  const h = harness({ dispatch: { merge: { mode: 'auto' } } });
  t.after(h.cleanup);
  h.gh.addIssue(kbIssue({ number: 7, status: 'done', state: 'CLOSED', stateReason: 'COMPLETED', kb: { paths: ['src/'] } }));
  h.gh.addIssue(kbIssue({ number: 8, status: 'ready', agent: 'claude', kb: { paths: ['src/gh.js'] } }));

  const s = await h.tick();

  assert.deepEqual(s.guarded, []);
  assert.deepEqual(s.claimed.map((c) => c.number), [8], 'done is neither running nor review — it merged, so it no longer holds anything');
});

test('path_overlap guard: two overlapping ready cards are both claimed in one tick on a manual board', async (t) => {
  const h = harness(); // manual is the default merge.mode, so path_overlap defaults to "off"
  t.after(h.cleanup);
  h.gh.addIssue(kbIssue({ number: 7, status: 'ready', agent: 'claude', kb: { paths: ['src/model.js'] } }));
  h.gh.addIssue(kbIssue({ number: 8, status: 'ready', agent: 'claude', kb: { paths: ['src/model.js', 'src/dispatch.js'] } }));

  const s = await h.tick();

  assert.deepEqual(s.guarded, []);
  assert.deepEqual(s.claimed.map((c) => c.number).sort(), [7, 8]);
});

test('dry-run names the card and paths a guarded candidate collides with', async (t) => {
  const h = harness({ dispatch: { guards: { path_overlap: 'running' } } });
  t.after(h.cleanup);
  const run = runWith([{ attempt: 1, host: 'test-host', started_at: ago(30), heartbeat_at: ago(5), pid: process.pid }]);
  h.gh.addIssue(kbIssue({ number: 7, status: 'running', agent: 'claude', kb: { paths: ['src/'] }, run }));
  h.gh.addIssue(kbIssue({ number: 8, status: 'ready', agent: 'claude', kb: { paths: ['src/gh.js'] } }));

  const s = await h.tick({ dryRun: true });

  assert.deepEqual(s.guarded, [{ number: 8, guard: 'path_overlap', collides_with: [{ number: 7, paths: ['src/'] }] }]);
});

test('docs/wiki/log.md merges by union: two branches that both append to it never conflict', () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hkb-union-merge-')));
  const git = (args, cwd = root) => {
    const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
    return r.stdout;
  };
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.email', 'test@example.com']);
  git(['config', 'user.name', 'test']);
  fs.writeFileSync(path.join(root, '.gitattributes'), 'docs/wiki/log.md merge=union\n');
  fs.mkdirSync(path.join(root, 'docs', 'wiki'), { recursive: true });
  fs.writeFileSync(path.join(root, 'docs', 'wiki', 'log.md'), '- entry 0\n');
  git(['add', '-A']);
  git(['commit', '-q', '-m', 'base']);
  git(['checkout', '-q', '-b', 'pr-a']);
  fs.appendFileSync(path.join(root, 'docs', 'wiki', 'log.md'), '- entry from PR A\n');
  git(['commit', '-q', '-am', 'PR A appends']);
  git(['checkout', '-q', '-b', 'pr-b', 'main']);
  fs.appendFileSync(path.join(root, 'docs', 'wiki', 'log.md'), '- entry from PR B\n');
  git(['commit', '-q', '-am', 'PR B appends']);

  git(['checkout', '-q', 'main']);
  git(['merge', '-q', '--no-ff', '-m', 'merge A', 'pr-a']);
  const r = spawnSync('git', ['merge', '--no-ff', '-m', 'merge B', 'pr-b'], { cwd: root, encoding: 'utf8' });
  assert.equal(r.status, 0, `union merge must not conflict: ${r.stderr}`);

  const merged = fs.readFileSync(path.join(root, 'docs', 'wiki', 'log.md'), 'utf8');
  assert.match(merged, /entry from PR A/);
  assert.match(merged, /entry from PR B/);
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
