// The dispatcher tick against an in-memory board (test/fake-store.js): promotion, claims,
// reclaim, the failure limit and the guards. No `gh`, no network, no worker — the profile's
// launch template is `["true"]`, a process that exits immediately.
//
// The board is a `Store`, not a GitHub: `h.store` seeds the cards and answers every question the
// assertions ask ("what status is #7", "which claims are live", "was anything written"), so a tick
// is tested against the interface rather than against GitHub's REST log. `test/fake-gh.js` is still
// installed underneath for the half that is genuinely a forge — pull requests — and a call that
// reaches it unexpectedly fails loudly with a 501 rather than passing quietly.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { tick, withoutWorktreeFlag, DURABLE_TICK_KEYS } from '../src/dispatch.js';
import { DEFAULT_BOARD } from '../src/board.js';
import { complete, requestChanges } from '../src/lifecycle.js';
import { activePrGuard, L, RESULT_MARKER, worktreePath } from '../src/model.js';
import { installDoubles, kbIssue, runWith } from './fake-store.js';
import { openStore } from '../src/store/index.js';

const ago = (seconds) => new Date(Date.now() - seconds * 1000).toISOString();

function harness({ dispatch = {}, board = 'default', host = 'test-host', root: given = null, profiles = null } = {}) {
  const root = given || fs.mkdtempSync(path.join(os.tmpdir(), 'hkb-dispatch-'));
  const { gh, store, ctx, restore } = installDoubles((g) => ({
    root,
    cfg: {
      ...DEFAULT_BOARD,
      repo: g.nameWithOwner,
      board,
      dispatch: { ...DEFAULT_BOARD.dispatch, ...dispatch },
      // the spawn stub: `true` exits immediately, so no worker ever runs
      profiles: profiles || { claude: { mode: 'process', max_in_progress: 2, model: null, allowed_tools: [], launch: ['true'] } },
    },
    repo: { owner: g.owner, repo: g.repo, nameWithOwner: g.nameWithOwner },
    board,
    host,
    json: false,
    caps: {},
    _cache: {},
    requireBoard() { return this; },
  }), { board, host });
  const logs = [];
  return {
    gh,
    store,
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
  h.store.addIssue(kbIssue({ number: 1, title: 'shipped', status: 'done', state: 'CLOSED', stateReason: 'COMPLETED' }));
  h.store.addIssue(kbIssue({ number: 2, title: 'dropped', status: 'archived', state: 'CLOSED', stateReason: 'NOT_PLANNED' }));
  h.store.addIssue(kbIssue({ number: 3, status: 'todo', blockedBy: [1] }));
  h.store.addIssue(kbIssue({ number: 4, status: 'todo', blockedBy: [1, 2] }));
  h.store.addIssue(kbIssue({ number: 5, status: 'todo', blockedBy: [{ number: 99, state: 'OPEN' }] }));

  const s = await h.tick({ max: 0 }); // no slot: promotion must not depend on capacity

  assert.deepEqual(s.promoted, [3]);
  assert.equal(h.store.statusOf(3), 'ready');
  assert.equal(h.store.statusOf(4), 'todo'); // NOT_PLANNED is not "done"
  assert.equal(h.store.statusOf(5), 'todo');
  assert.match(h.log(), /#3: todo → ready/);
});

test('a scheduled task is not promoted before its time', async (t) => {
  const h = harness();
  t.after(h.cleanup);
  h.store.addIssue(kbIssue({ number: 1, status: 'todo', kb: { scheduled_at: ago(-3600) } }));
  h.store.addIssue(kbIssue({ number: 2, status: 'todo', kb: { scheduled_at: ago(3600) } }));

  const s = await h.tick({ max: 0 });

  assert.deepEqual(s.promoted, [2]);
  assert.equal(h.store.statusOf(1), 'todo');
});

test('a ready task is claimed once: ref, run comment, running label, worker spawned', async (t) => {
  const h = harness();
  t.after(h.cleanup);
  h.store.addIssue(kbIssue({ number: 7, status: 'ready', agent: 'claude' }));

  const s = await h.tick();

  assert.equal(s.claimed.length, 1);
  assert.equal(s.claimed[0].number, 7);
  assert.equal(s.claimed[0].attempt, 1);
  assert.ok(s.claimed[0].pid > 0, 'the stub worker got a pid');
  assert.equal(h.store.statusOf(7), 'running');
  assert.deepEqual(await h.store.locks(), ['7/1']);
  const run = h.store.runOf(7);
  assert.equal(run.attempts.length, 1);
  assert.equal(run.attempts[0].host, 'test-host');
  assert.equal(run.attempts[0].profile, 'claude');
  assert.equal(run.attempts[0].ended_at, undefined);
  assert.equal(run.attempts[0].log, '.kanban/logs/7-1.log');
  assert.ok(fs.existsSync(path.join(h.root, '.kanban', 'logs', '7-1.log')));
  // One run record per card, updated in place. The tick writes it twice — once when it opens the
  // attempt, once when the spawn hands back a pid — and both land on the *same* document, which is
  // what the GitHub store needed a "never a second create" rule to guarantee about its comment.
  assert.deepEqual(h.store.writes('saveRun'), ['saveRun', 'saveRun']);
  assert.equal(h.store.runOf(7).attempts.length, 1, 'one attempt row, not one per write');
});

test('claim held elsewhere: skipped, and nothing on the issue is touched', async (t) => {
  const h = harness();
  t.after(h.cleanup);
  h.store.addIssue(kbIssue({ number: 7, status: 'ready', agent: 'claude' }));
  // another dispatcher won the ref between our board read and our POST
  h.store.fail('claim', { result: 'held' });

  const s = await h.tick();

  assert.deepEqual(s.held, [7]);
  assert.equal(s.claimed.length, 0);
  assert.equal(h.store.statusOf(7), 'ready');
  assert.deepEqual(h.store.writesTo(7), [], 'nothing on the card was touched');
  assert.match(h.log(), /#7: lock held elsewhere/);
});

test('claim result unknown (503): back off for this tick, no label change', async (t) => {
  const h = harness();
  t.after(h.cleanup);
  h.store.addIssue(kbIssue({ number: 7, status: 'ready', agent: 'claude' }));
  h.store.addIssue(kbIssue({ number: 8, status: 'ready', agent: 'claude' }));
  h.store.fail('claim', { kind: 'server', message: 'the store could not say whether the claim was made' });

  const s = await h.tick();

  // #7 backs off; a 5xx is not fatal for the tick, so #8 is still claimed
  assert.equal(s.held.length, 0);
  assert.deepEqual(s.claimed.map((c) => c.number), [8]);
  assert.equal(h.store.statusOf(7), 'ready');
  assert.deepEqual(h.store.writesTo(7), [], 'nothing on the card was touched');
  assert.deepEqual(await h.store.locks(), ['8/1']);
  assert.match(h.log(), /#7: claim result unknown \(server:/);
});

test('an auth failure on claim stops the tick instead of burning the rest of the board', async (t) => {
  const h = harness();
  t.after(h.cleanup);
  h.store.addIssue(kbIssue({ number: 7, status: 'ready', agent: 'claude' }));
  h.store.addIssue(kbIssue({ number: 8, status: 'ready', agent: 'claude' }));
  h.store.fail('claim', { kind: 'auth', message: 'Bad credentials', times: 2 });

  const s = await h.tick();

  assert.equal(s.claimed.length, 0);
  assert.deepEqual(await h.store.locks(), []);
  assert.equal(h.store.statusOf(8), 'ready');
});

test('a stale heartbeat is reclaimed: lock released, attempt closed, back to ready', async (t) => {
  const h = harness({ dispatch: { stale_after: 60 } });
  t.after(h.cleanup);
  const run = runWith([{ attempt: 1, host: 'other-host', started_at: ago(600), heartbeat_at: ago(600), pid: 4_000_000 }]);
  h.store.addIssue(kbIssue({ number: 7, status: 'running', agent: 'claude', kb: { max_runtime: 86_400 }, run }));
  h.store.hold(7, 1);

  const s = await h.tick({ max: 0 }); // no slot, so the freed task is not immediately re-claimed

  assert.deepEqual(s.reclaimed, [{ number: 7, outcome: 'reclaimed' }]);
  assert.equal(h.store.statusOf(7), 'ready');
  assert.deepEqual(await h.store.locks(), []);
  const saved = h.store.runOf(7);
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
  h.store.addIssue(kbIssue({ number: 7, status: 'running', agent: 'claude', kb: { max_runtime: 86_400 }, run }));
  h.store.beat(7, 1, ago(20));

  const s = await h.tick({ max: 0 });

  assert.deepEqual(s.reclaimed, []);
  assert.equal(h.store.statusOf(7), 'running');
  assert.deepEqual(await h.store.locks(), ['7/1'], 'the lock is left alone');
  assert.deepEqual(h.store.writes('saveRun'), [], 'and the run record is not rewritten');
  // The name in that line is `src/model.js`'s `lockRef`, not the store's — the GitHub-ism this
  // branch filed in docs/wiki/FINDINGS.md ("the tick names refs/kb/locks/<n>/<k> on every board").
  // Assert the sentence and not the name, so fixing that finding does not break a test that was
  // never about it.
  assert.match(h.log(), /#7: attempt 1 beat on .+ \d+s ago — alive/);
});

test('a ref-CAS worker whose last beat is old is reclaimed like any other', async (t) => {
  const h = harness({ dispatch: { stale_after: 60 } });
  t.after(h.cleanup);
  const run = runWith([{ attempt: 1, host: 'other-host', started_at: ago(3600), heartbeat_at: ago(3600), lock_sha: 'a'.repeat(40) }]);
  h.store.addIssue(kbIssue({ number: 7, status: 'running', agent: 'claude', kb: { max_runtime: 86_400 }, run }));
  h.store.beat(7, 1, ago(900));

  const s = await h.tick({ max: 0 });

  assert.deepEqual(s.reclaimed, [{ number: 7, outcome: 'reclaimed' }]);
  assert.equal(h.store.statusOf(7), 'ready');
  assert.deepEqual(await h.store.locks(), []);
});

test('a fresh lock ref does not save a worker whose process is gone', async (t) => {
  const h = harness({ dispatch: { stale_after: 60 } });
  t.after(h.cleanup);
  const run = runWith([{ attempt: 1, host: 'test-host', started_at: ago(600), heartbeat_at: ago(5), pid: 4_000_000 }]);
  h.store.addIssue(kbIssue({ number: 7, status: 'running', agent: 'claude', kb: { max_runtime: 86_400 }, run }));
  h.store.beat(7, 1, ago(1));

  const s = await h.tick({ max: 0 });

  assert.deepEqual(s.reclaimed, [{ number: 7, outcome: 'crashed' }]);
});

test('a hand-claimed attempt is not a crashed spawn: it has no pid and never will', async (t) => {
  const h = harness({ dispatch: { stale_after: 3600 } });
  t.after(h.cleanup);
  // `hkb claim 7` with no --spawn: this host, no pid, no job — a human (or an agent they started)
  // is working it in their own terminal, and the CAS heartbeat leaves the run comment untouched
  const run = runWith([{ attempt: 1, host: 'test-host', started_at: ago(7200), heartbeat_at: ago(7200), lock_sha: 'a'.repeat(40), manual: true }]);
  h.store.addIssue(kbIssue({ number: 7, status: 'running', agent: 'claude', kb: { max_runtime: 86_400 }, run }));
  h.store.beat(7, 1, ago(120));

  const first = await h.tick({ max: 0 });
  const second = await h.tick({ max: 0 }); // the 180s rule used to fire on every tick, forever

  assert.deepEqual(first.reclaimed, []);
  assert.deepEqual(second.reclaimed, []);
  assert.equal(h.store.statusOf(7), 'running');
  assert.deepEqual(await h.store.locks(), ['7/1'], 'the lock the worker beats on survives');
  assert.deepEqual(h.store.writes('saveRun'), [], 'and its run record is not rewritten');
  // The name in that line is `src/model.js`'s `lockRef`, not the store's — the GitHub-ism this
  // branch filed in docs/wiki/FINDINGS.md ("the tick names refs/kb/locks/<n>/<k> on every board").
  // Assert the sentence and not the name, so fixing that finding does not break a test that was
  // never about it.
  assert.match(h.log(), /#7: attempt 1 beat on .+ \d+s ago — alive/);
});

test('a hand-claimed attempt that stops beating is reclaimed after stale_after', async (t) => {
  const h = harness({ dispatch: { stale_after: 3600 } });
  t.after(h.cleanup);
  const run = runWith([{ attempt: 1, host: 'test-host', started_at: ago(9000), heartbeat_at: ago(9000), lock_sha: 'a'.repeat(40), manual: true }]);
  h.store.addIssue(kbIssue({ number: 7, status: 'running', agent: 'claude', kb: { max_runtime: 86_400 }, run }));
  h.store.beat(7, 1, ago(5400)); // last beat 90 minutes ago: past stale_after, whoever it was is gone

  const s = await h.tick({ max: 0 });

  assert.deepEqual(s.reclaimed, [{ number: 7, outcome: 'reclaimed' }], 'stale_after, not the no-handle rule');
  assert.equal(h.store.statusOf(7), 'ready');
  assert.deepEqual(await h.store.locks(), []);
});

test('a claim seeds this host\'s beat chain — the attempt row carries no token of its own', async (t) => {
  const h = harness();
  t.after(h.cleanup);
  h.store.addIssue(kbIssue({ number: 7, status: 'ready', agent: 'claude' }));

  await h.tick();

  // `lock_sha` used to ride on the attempt row so the worker's first heartbeat had something to
  // lease on. The claim itself seeds this host's beat chain (`beatToken`), and the store is the
  // authority for the rest, so the row records nothing about the claim at all — a copy of a token
  // is a second place for it to be wrong.
  const store = await openStore(h.ctx);
  assert.equal(h.store.runOf(7).attempts[0].lock_sha, undefined);
  assert.equal(store.beatToken(7, 1), h.store.lockOf(7, 1).token);
});

test('a task past max_runtime is timed_out, not merely reclaimed', async (t) => {
  const h = harness({ dispatch: { stale_after: 60 } });
  t.after(h.cleanup);
  const run = runWith([{ attempt: 1, host: 'other-host', started_at: ago(600), heartbeat_at: ago(1) }]);
  h.store.addIssue(kbIssue({ number: 7, status: 'running', agent: 'claude', kb: { max_runtime: 120 }, run }));

  const s = await h.tick({ max: 0 });

  assert.deepEqual(s.reclaimed, [{ number: 7, outcome: 'timed_out' }]);
  assert.equal(h.store.runOf(7).attempts[0].outcome, 'timed_out');
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
  h.store.addIssue(kbIssue({ number: 7, status: 'running', agent: 'claude', kb: { max_runtime: 86_400 }, run }));
  h.store.beat(7, 1, ago(1));

  const s = await h.tick({ max: 0 });

  assert.deepEqual(s.reclaimed, [{ number: 7, outcome: 'crashed' }]);
  const a = h.store.runOf(7).attempts[0];
  assert.equal(a.session_id, 'sid-crashed');
  assert.equal(a.terminal_reason, 'max_turns');
  assert.equal(a.total_cost_usd, 0.12);
});

// #130: the same crashed pid-mode row also gets its denied-tools ledger — permission_denials from
// the log's own result JSON, merged with a transcript scan for the two shapes that never land there.
test('a crashed pid-mode attempt gets denied_tools backfilled from its log AND its transcript', async (t) => {
  const h = harness({ dispatch: { stale_after: 3600 } });
  t.after(h.cleanup);
  const logRel = '.kanban/logs/7-1.log';
  const transcriptRel = '.kanban/logs/7-1.jsonl';
  fs.mkdirSync(path.dirname(path.join(h.root, logRel)), { recursive: true });
  fs.writeFileSync(path.join(h.root, transcriptRel), [
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'g', name: 'Bash', input: { command: 'hkb complete 7 --summary x' } }] } }),
    JSON.stringify({ type: 'user', timestamp: '2026-08-28T09:10:00Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'g', content: "this command runs a string through complete, which can't be verified to stay inside the worktree", is_error: true }] } }),
  ].join('\n') + '\n');
  fs.writeFileSync(path.join(h.root, logRel), JSON.stringify({
    type: 'result', session_id: 'sid-crashed', total_cost_usd: 0.12, num_turns: 5, duration_ms: 12_000,
    terminal_reason: 'max_turns', transcript_path: transcriptRel,
    permission_denials: [{ tool_name: 'WebFetch' }],
  }) + '\n');
  const run = runWith([{ attempt: 1, host: 'test-host', started_at: ago(600), heartbeat_at: ago(5), pid: 4_000_000, log: logRel }]);
  h.store.addIssue(kbIssue({ number: 7, status: 'running', agent: 'claude', kb: { max_runtime: 86_400 }, run }));
  h.store.beat(7, 1, ago(1));

  const s = await h.tick({ max: 0 });

  assert.deepEqual(s.reclaimed, [{ number: 7, outcome: 'crashed' }]);
  const a = h.store.runOf(7).attempts[0];
  assert.deepEqual(a.denied_tools, [
    { tool: 'WebFetch', kind: 'permission-rule', count: 1, first_seen: null },
    { tool: 'Bash', kind: 'worktree-guard', count: 1, first_seen: '2026-08-28T09:10:00Z' },
  ]);
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
  h.store.addIssue(kbIssue({ number: 7, status: 'running', agent: 'claude', kb: { max_retries: 2, max_runtime: 86_400 }, run }));
  h.store.hold(7, 3);

  const s = await h.tick();

  assert.deepEqual(s.reclaimed, [{ number: 7, outcome: 'gave_up' }]);
  assert.equal(h.store.statusOf(7), 'blocked');
  assert.ok(h.store.labelsOf(7).includes(L.needsHuman));
  assert.deepEqual(await h.store.locks(), []);
  const saved = h.store.runOf(7);
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
  h.store.addIssue(kbIssue({
    number: 7, status: 'running', agent: 'claude', kb: { max_runtime: 86_400 }, run,
    prs: [{ number: 42, state: 'OPEN', headRefName: 'worktree-kb-7-1' }],
  }));
  h.store.hold(7, 1);

  const s = await h.tick();

  assert.deepEqual(s.reclaimed, [{ number: 7, outcome: 'protocol_violation' }]);
  const saved = h.store.runOf(7);
  assert.equal(saved.attempts[0].outcome, 'protocol_violation');
  assert.equal(saved.attempts[0].pr, 42, 'the row names the PR the work landed on');
  assert.equal(saved.failures, 0, 'no verb but an open PR is not a failure — nothing went wrong twice');
  assert.equal(h.store.statusOf(7), 'ready'); // the active_pr guard sends it to review on the next tick
});

test('protocol_violation with no PR: nothing to show, so it counts against the retry budget', async (t) => {
  const h = bgHarness({
    jobs: [{ kind: 'background', id: 'j7', pid: 1007, name: 'kb #7 · task', cwd: '/repo/.claude/worktrees/kb-7-1', state: 'done', status: 'idle' }],
  });
  t.after(h.cleanup);
  const run = runWith([{ attempt: 1, host: 'test-host', bg: true, job: 'j7', wt: 'kb-7-1', started_at: ago(120), heartbeat_at: ago(5) }]);
  h.store.addIssue(kbIssue({ number: 7, status: 'running', agent: 'claude', kb: { max_runtime: 86_400 }, run }));
  h.store.hold(7, 1);

  const s = await h.tick();

  assert.deepEqual(s.reclaimed, [{ number: 7, outcome: 'protocol_violation' }]);
  const saved = h.store.runOf(7);
  assert.equal(saved.attempts[0].outcome, 'protocol_violation');
  assert.equal(saved.attempts[0].pr, undefined, 'no PR to name');
  assert.equal(saved.failures, 1);
});

test('active_pr guard: an open PR sends a ready task to review, even with no slot', async (t) => {
  const h = harness();
  t.after(h.cleanup);
  h.store.addIssue(kbIssue({ number: 7, status: 'ready', agent: 'claude', prs: [{ number: 42, state: 'OPEN', isDraft: true }] }));
  h.store.addIssue(kbIssue({ number: 8, status: 'ready', agent: 'claude', prs: [{ number: 41, state: 'MERGED', merged: true }] }));

  const s = await h.tick({ max: 0 });

  assert.deepEqual(s.guarded, [{ number: 7, guard: 'active_pr', pr: 42 }]);
  assert.equal(h.store.statusOf(7), 'review');
  assert.equal(h.store.statusOf(8), 'ready'); // a merged PR is not a reason to wait
  assert.deepEqual(await h.store.locks(), []);
  assert.match(h.log(), /#7: open PR #42 → review \(active_pr guard\)/);
});

/**
 * The whole join, end to end (#304's second Done-when).
 *
 * `reconcileDecision` is unit-tested against a hand-built listing in test/reconcile.test.js; this is
 * the same claim made of the *tick*, through the forge double, so the listing is one the tick asked
 * GitHub for rather than one a test wrote. It is what "a PR merged on a scratch repo moves its card
 * to done on the next tick" means now that there is no issue for the PR to close: the merge is
 * matched to the card by head branch (`kb-7-1`) and by nothing else.
 */
test('a merged PR moves its card to done on the next tick, found by its head branch alone', async (t) => {
  const h = harness();
  t.after(h.cleanup);
  h.store.addIssue(kbIssue({
    number: 7, status: 'review', agent: 'claude',
    run: runWith([{ attempt: 1, outcome: 'review_requested', pr: 90, ended_at: ago(600) }]),
  }));
  // a card whose branch nobody merged, and a merged PR belonging to no card at all: neither moves
  h.store.addIssue(kbIssue({ number: 8, status: 'review', agent: 'claude' }));
  h.gh.addPull({ number: 90, head: 'kb-7-1', state: 'closed', merged: true, mergedAt: ago(60) });
  h.gh.addPull({ number: 91, head: 'release/2.0', state: 'closed', merged: true, mergedAt: ago(60) });

  const s = await h.tick({ max: 0 });

  assert.deepEqual(s.reconciled.map((r) => ({ number: r.number, status: r.status })), [{ number: 7, status: 'done' }]);
  assert.equal(h.store.statusOf(7), 'done');
  assert.equal(h.store.stateOf(7).state, 'CLOSED');
  assert.equal(h.store.runOf(7).attempts[0].outcome, 'review_requested', 'a closed attempt keeps its own outcome');
  assert.equal(h.store.statusOf(8), 'review', 'a card with no merged branch is left where it is');
  assert.match(h.log(), /#7: review → done \(PR #90 merged \(kb-7-1\)\)/);

  // and it is idempotent: the second tick finds the same merged PR and has nothing to do with it
  h.logs.length = 0;
  const again = await h.tick({ max: 0 });
  assert.deepEqual(again.reconciled, []);
  assert.equal(h.store.statusOf(7), 'done');
});

/**
 * **A merge does not take a claim away from a worker that is still in it** (#304 review, item 3).
 *
 * `running` is a reconcilable status — a worker can die while its pull request lands — but a
 * reviewer merging a worker's PR mid-task, or auto-merge landing a node onto its track branch, must
 * not make the tick stamp `ended_at`, release the lock and close the card out from under it. The
 * worker's next `hkb heartbeat` would be LOCK_LOST and it would exit 3 with no terminal verb, which
 * is the one shape the protocol cannot recover from. `keep` protects the worktree; this is the
 * claim.
 */
test('a merged PR leaves a live worker its claim, and reconciles the card once the worker is gone', async (t) => {
  const h = harness();
  t.after(h.cleanup);
  // The one pid guaranteed to be alive here, and to be this host's: our own.
  const run = runWith([{ attempt: 1, host: 'test-host', started_at: ago(60), heartbeat_at: ago(10), pid: process.pid }]);
  h.store.addIssue(kbIssue({ number: 7, status: 'running', agent: 'claude', kb: { max_runtime: 86_400 }, run }));
  h.store.hold(7, 1);
  h.gh.addPull({ number: 90, head: 'kb-7-1', state: 'closed', merged: true, mergedAt: ago(30) });

  const s = await h.tick({ max: 0 });

  assert.deepEqual(s.reconciled, [], 'nothing was reconciled while the worker was in it');
  assert.deepEqual(s.reconcile_left, [{ number: 7, why: 'worker_alive', attempt: 1, pid: process.pid }]);
  assert.equal(h.store.statusOf(7), 'running', 'the card stays where the worker left it');
  assert.deepEqual(await h.store.locks(), ['7/1'], 'and it still holds its claim');
  assert.equal(h.store.runOf(7).attempts[0].ended_at, undefined, 'no ended_at was stamped under it');
  assert.match(h.log(), /still running here \(pid \d+\) — leaving its claim alone/);

  // The worker is gone: the very next tick reconciles what the merge left behind.
  h.store.runOf(7).attempts[0].pid = 4_000_000; // a pid no process on this host has
  const again = await h.tick({ max: 0 });
  assert.deepEqual(again.reconciled.map((r) => ({ number: r.number, status: r.status })), [{ number: 7, status: 'done' }]);
});

/**
 * **A card a human moved after the merge stays where they put it** (#304 review, item 4).
 *
 * While the board was GitHub Issues this pass required the *issue* to be closed, so a reopened card
 * was believed. Without a second rule, a card whose PR merged and which a reviewer then sent back
 * with `hkb request-changes` — the fix line `checkOrphanedPrs` itself recommends — is forced back to
 * `done` and closed again by the next tick, for as long as that PR stays in the listing.
 */
test('a card moved after its PR merged is left alone, not dragged back to done', async (t) => {
  const h = harness();
  t.after(h.cleanup);
  h.store.addIssue(kbIssue({
    number: 7, status: 'todo', agent: 'claude', updatedAt: ago(10),
    run: runWith([{ attempt: 1, outcome: 'changes_requested', pr: 90, ended_at: ago(10) }]),
  }));
  h.gh.addPull({ number: 90, head: 'kb-7-1', state: 'closed', merged: true, mergedAt: ago(600) });

  const s = await h.tick({ max: 0 });

  assert.deepEqual(s.reconciled, [], 'the merge is older news than the card');
  assert.equal(s.reconcile_left?.[0]?.why, 'moved_after_merge');
  // `ready`, not `todo`: the promote pass ran after the reconcile pass and moved an unblocked card
  // along, which is the ordinary board doing its job. What matters is that it is not `done`.
  assert.equal(h.store.statusOf(7), 'ready');
  assert.notEqual(h.store.stateOf(7).state, 'CLOSED', 'and it was not closed again');
  assert.match(h.log(), /but #7 was moved to todo at/);

  // The other side of the same rule: a card that has *not* moved since the merge still reconciles.
  h.store.addIssue(kbIssue({ number: 8, status: 'review', agent: 'claude', updatedAt: ago(900) }));
  h.gh.addPull({ number: 91, head: 'kb-8-1', state: 'closed', merged: true, mergedAt: ago(600) });
  const again = await h.tick({ max: 0 });
  assert.deepEqual(again.reconciled.map((r) => r.number), [8]);
});

/**
 * **An unreachable forge does not fail the tick, and does not let it guess** (#304 review, item 1).
 *
 * The cards are local and need no network at all; a pull request is an *enrichment* of one. So a
 * failed listing leaves `prs: []` and the tick goes on doing its local work — but it must not then
 * read that empty list as "this card has no PR", because the `active_pr` guard's whole job is to not
 * open a second pull request on a card that already has one. It declines to decide instead.
 */
test('a forge that cannot be reached degrades the tick rather than aborting it, and claims nothing', async (t) => {
  const h = harness();
  t.after(h.cleanup);
  h.store.addIssue(kbIssue({ number: 7, status: 'ready', agent: 'claude' }));
  h.store.addIssue(kbIssue({ number: 8, status: 'triage', agent: 'claude' }));
  h.gh.fail({ method: 'GET', path: '/pulls?state=open' }, { status: 503, message: 'no route to host', times: 99 });

  const s = await h.tick();

  assert.match(s.forge_error, /no route to host/, 'the tick says why, rather than throwing');
  assert.deepEqual(s.claimed, [], 'and claims nothing while the guard cannot be judged');
  assert.deepEqual(await h.store.locks(), [], 'no lock was taken');
  assert.equal(h.store.statusOf(7), 'ready', 'the card is left exactly where it was');
  assert.match(s.skipped.find((x) => x.number === 7)?.why || '', /^pull requests unreachable \(.*no route to host\) — the active_pr guard cannot be judged$/);
  assert.match(h.log(), /pull requests unreachable .* nothing is claimed this tick/);
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
  h.store.addIssue(kbIssue({ number: 7, status: 'ready', agent: 'claude', run, prs: [{ number: 42, state: 'OPEN', isDraft: true, headRefName: 'worktree-kb-7-1' }] }));
  // the ordinary case, side by side: an open PR with no reviewer row is still parked in review
  h.store.addIssue(kbIssue({ number: 8, status: 'ready', agent: 'claude', prs: [{ number: 43, state: 'OPEN', isDraft: true }] }));

  const s = await h.tick();

  assert.deepEqual(s.guarded, [{ number: 8, guard: 'active_pr', pr: 43 }]);
  assert.equal(h.store.statusOf(8), 'review');
  assert.deepEqual(s.claimed.map((c) => c.number), [7]);
  assert.equal(s.claimed[0].continues_pr, 42);
  assert.equal(h.store.statusOf(7), 'running');
  const last = h.store.runOf(7).attempts.at(-1);
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
  h.store.addIssue(kbIssue({ number: 7, status: 'ready', agent: 'claude', run, prs: [{ number: 42, state: 'OPEN', headRefName: 'worktree-kb-7-1' }] }));

  const s = await h.tick();

  assert.deepEqual(s.claimed.map((c) => c.number), [7]);
  const last = h.store.runOf(7).attempts.at(-1);
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
  h.store.addIssue(kbIssue({ number: 7, status: 'ready', agent: 'claude', run, prs: [{ number: 42, state: 'OPEN', headRefName: 'worktree-kb-7-1' }] }));

  const s = await h.tick();

  assert.deepEqual(s.claimed.map((c) => c.number), [7]);
  const dir = path.join(root, worktreePath('kb-7-3'));
  assert.ok(fs.existsSync(path.join(dir, '.git')), 'attempt 3 got a checkout of its own');
  assert.equal(spawnSync('git', ['branch', '--show-current'], { cwd: dir, encoding: 'utf8' }).stdout.trim(), 'worktree-kb-7-1');
  assert.ok(!fs.existsSync(path.join(root, worktreePath('kb-7-1'), '.git')), 'the ended attempt\'s checkout was freed to release the branch');
  const last = h.store.runOf(7).attempts.at(-1);
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
  h.store.addIssue(kbIssue({ number: 7, status: 'ready', agent: 'claude', run, prs: [{ number: 42, state: 'OPEN', headRefName: 'worktree-kb-7-1' }] }));

  const s = await h.tick();

  assert.deepEqual(s.claimed.map((c) => c.number), [7]);
  const dir = path.join(root, worktreePath('kb-7-3'));
  assert.equal(git(dir, 'rev-parse', 'HEAD'), humanHead, 'the checkout was fast-forwarded to the branch\'s remote head');
  const last = h.store.runOf(7).attempts.at(-1);
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
  h.store.addIssue(kbIssue({ number: 7, status: 'ready', agent: 'claude', run, prs: [{ number: 42, state: 'OPEN', headRefName: 'worktree-kb-7-1' }] }));

  const s = await h.tick();

  assert.deepEqual(s.claimed.map((c) => c.number), [7]);
  const last = h.store.runOf(7).attempts.at(-1);
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
  h.store.addIssue(kbIssue({ number: 7, status: 'ready', agent: 'claude', run, prs: [{ number: 42, state: 'OPEN', headRefName: 'worktree-kb-7-1' }] }));

  const s = await h.tick();

  assert.deepEqual(s.claimed.map((c) => c.number), [7]);
  const dir = path.join(root, worktreePath('kb-7-3'));
  assert.equal(git(dir, 'rev-parse', 'HEAD'), humanHead, 'the reused checkout was fetched and fast-forwarded too');
  const last = h.store.runOf(7).attempts.at(-1);
  assert.equal(last.continues_branch_stale, undefined, 'a clean fast-forward has nothing to report');
});

test('the review loop turns: request-changes → claim → finish, all on one PR', async (t) => {
  const h = harness();
  t.after(h.cleanup);
  const run = runWith([{ attempt: 1, started_at: ago(900), ended_at: ago(600), outcome: 'review_requested', summary: 'ready', pr: 42 }]);
  h.store.addIssue(kbIssue({ number: 7, status: 'review', agent: 'claude', run, prs: [{ number: 42, state: 'OPEN', isDraft: false, headRefName: 'worktree-kb-7-1' }] }));

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
  assert.deepEqual(h.store.runOf(7).attempts.map((a) => a.outcome), ['review_requested', 'changes_requested', 'completed']);
  assert.equal(h.store.issues.get(7).prs.length, 1);
  const result = h.store.issues.get(7).comments.map((c) => c.body).find((b) => b.startsWith(RESULT_MARKER));
  assert.match(result, /\*\*PR:\*\* #42 — continued after changes requested, not reopened/);
});

test('request-changes keeps the reviewer\'s note in full, unlike the other terminal verbs', async (t) => {
  const h = harness();
  t.after(h.cleanup);
  const run = runWith([{ attempt: 1, started_at: ago(900), ended_at: ago(600), outcome: 'review_requested', summary: 'ready', pr: 42 }]);
  h.store.addIssue(kbIssue({ number: 7, status: 'review', agent: 'claude', run, prs: [{ number: 42, state: 'OPEN', isDraft: false, headRefName: 'worktree-kb-7-1' }] }));
  const longReason = 'item 1: fix the retry loop. '.repeat(60).trim();
  assert.ok(longReason.length > 1500);

  await requestChanges(h.ctx, 7, { reason: longReason });

  assert.equal(h.store.runOf(7).attempts.at(-1).reason, longReason, 'the attempt row must not be truncated to 400 chars');
});

// ---------- #195: a long-lived loop must not judge a card on a comments cache from an earlier tick ----------

test('a request-changes from another process between ticks is honoured, not bounced by the loop\'s stale comments cache', async (t) => {
  const h = harness();
  t.after(h.cleanup);
  const run = runWith([{ attempt: 1, started_at: ago(900), ended_at: ago(600), outcome: 'review_requested', summary: 'ready', pr: 42 }]);
  h.store.addIssue(kbIssue({ number: 7, status: 'ready', agent: 'claude', run, prs: [{ number: 42, state: 'OPEN', isDraft: true, headRefName: 'worktree-kb-7-1' }] }));

  // tick 1: no changes_requested row yet, so the active_pr guard bounces #7 to review — and the
  // loop's ctx now has #7's comments (only the review_requested row) memoized.
  const s1 = await h.tick();
  assert.deepEqual(s1.guarded, [{ number: 7, guard: 'active_pr', pr: 42 }]);
  assert.equal(h.store.statusOf(7), 'review');

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
  assert.equal(h.store.statusOf(7), 'running');
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
  h.store.addIssue(kbIssue({ number: 7, status: 'running', agent: 'claude', kb: { paths: ['src/'] }, run }));
  h.store.addIssue(kbIssue({ number: 8, status: 'ready', agent: 'claude', kb: { paths: ['src/gh.js'] } }));
  h.store.addIssue(kbIssue({ number: 9, status: 'ready', agent: 'claude', kb: { paths: ['docs/readme.md'] } }));
  h.store.hold(7, 1);

  const s = await h.tick();

  assert.deepEqual(s.reclaimed, []); // the live worker is left alone
  assert.deepEqual(s.guarded, [{ number: 8, guard: 'path_overlap', collides_with: [{ number: 7, paths: ['src/'] }] }]);
  assert.equal(h.store.statusOf(8), 'ready');
  assert.deepEqual(s.claimed.map((c) => c.number), [9]); // a disjoint path still goes
  assert.deepEqual(await h.store.locks(), ['7/1', '9/1']);
});

test('path_overlap guard: off by default on a manual board — both overlapping cards run', async (t) => {
  const h = harness(); // dispatch.merge.mode defaults to "manual"
  t.after(h.cleanup);
  const run = runWith([{ attempt: 1, host: 'test-host', started_at: ago(30), heartbeat_at: ago(5), pid: process.pid }]);
  h.store.addIssue(kbIssue({ number: 7, status: 'running', agent: 'claude', kb: { paths: ['src/'] }, run }));
  h.store.addIssue(kbIssue({ number: 8, status: 'ready', agent: 'claude', kb: { paths: ['src/gh.js'] } }));

  const s = await h.tick();

  assert.deepEqual(s.guarded, []);
  assert.deepEqual(s.claimed.map((c) => c.number), [8]);
});

test('path_overlap guard: "unmerged" on an auto-merge board keys on review, not just running', async (t) => {
  const h = harness({ dispatch: { merge: { mode: 'auto' } } });
  t.after(h.cleanup);
  h.store.addIssue(kbIssue({ number: 7, status: 'review', agent: 'claude', kb: { paths: ['src/'] }, prs: [{ number: 42, state: 'OPEN', isDraft: false }] }));
  h.store.addIssue(kbIssue({ number: 8, status: 'ready', agent: 'claude', kb: { paths: ['src/gh.js'] } }));

  const s = await h.tick();

  assert.deepEqual(s.guarded, [{ number: 8, guard: 'path_overlap', collides_with: [{ number: 7, paths: ['src/'] }] }]);
  assert.deepEqual(s.claimed, []);
});

test('recent_success guard: a task that just completed is not immediately re-run', async (t) => {
  const h = harness({ dispatch: { recent_success_window: 600 } });
  t.after(h.cleanup);
  const run = runWith([{ attempt: 1, host: 'test-host', started_at: ago(400), ended_at: ago(60), outcome: 'completed' }]);
  h.store.addIssue(kbIssue({ number: 7, status: 'ready', agent: 'claude', run }));

  const s = await h.tick();

  assert.deepEqual(s.guarded, [{ number: 7, guard: 'recent_success' }]);
  assert.deepEqual(await h.store.locks(), []);
});

test('claims are create-if-absent, and releasing twice is not an error', async (t) => {
  const h = harness();
  t.after(h.cleanup);

  const store = await openStore(h.ctx);
  assert.equal((await store.claim(4, 1)).result, 'claimed');
  const second = await store.claim(4, 1);
  assert.equal(second.result, 'held');
  assert.equal(second.error, null);
  assert.deepEqual(await h.store.locks(), ['4/1']);
  assert.equal(await store.release(4, 1), true);
  assert.equal(await store.release(4, 1), false);
  assert.deepEqual(await h.store.locks(), []);
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
  h.store.addIssue(kbIssue({ number: 7, status: 'ready', agent: 'claude' }));
  h.store.addIssue(kbIssue({ number: 8, status: 'ready', agent: 'claude-p' }));

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
  // `KB_LOCK_REF` was here. A claim has no ref to name any more (docs/local-first.md §6.1), and a
  // worker that never needed the name — `hkb heartbeat` reads the claim through the store — is one
  // less GitHub-ism in every worker's environment.
  assert.equal(proc.KB_LOCK_REF, undefined);
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
  h.store.addIssue(kbIssue({ number: 7, status: 'running', agent: 'claude', kb: { paths: ['src/'] }, run }));
  h.store.addIssue(kbIssue({ number: 8, status: 'ready', agent: 'claude', kb: { paths: ['src/gh.js'] } }));
  h.store.beat(7, 1, ago(1800));

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
  h.store.addIssue(kbIssue({ number: 7, status: 'running', agent: 'claude', kb: { paths: ['src/'] }, run }));
  h.store.addIssue(kbIssue({ number: 8, status: 'ready', agent: 'claude', kb: { paths: ['src/gh.js'] } }));
  h.store.beat(7, 1, ago(30));

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
  h.store.addIssue(kbIssue({ number: 7, status: 'running', agent: 'claude', kb: { paths: ['src/'] }, run }));
  h.store.addIssue(kbIssue({ number: 8, status: 'ready', agent: 'claude', kb: { paths: ['src/gh.js'] } }));
  h.store.hold(7, 1);

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
  h.store.addIssue(kbIssue({ number: 7, status: 'running', agent: 'claude', kb: { paths: ['src/'] }, run }));
  h.store.beat(7, 1, ago(1800));

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
  h.store.addIssue(kbIssue({ number: 7, status: 'running', agent: 'claude', kb: { paths: ['src/'], max_runtime: 86_400 }, run }));
  h.store.addIssue(kbIssue({ number: 8, status: 'ready', agent: 'claude', kb: { paths: ['src/gh.js'] } }));
  h.store.hold(7, 1);

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
  h.store.addIssue(kbIssue({ number: 7, status: 'running', agent: 'claude', kb: { paths: ['src/'], max_runtime: 86_400 }, run }));
  h.store.addIssue(kbIssue({ number: 8, status: 'ready', agent: 'claude', kb: { paths: ['src/gh.js'] } }));
  h.store.hold(7, 1);

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
  h.store.addIssue(kbIssue({ number: 7, status: 'done', state: 'CLOSED', stateReason: 'COMPLETED', kb: { paths: ['src/'] } }));
  h.store.addIssue(kbIssue({ number: 8, status: 'ready', agent: 'claude', kb: { paths: ['src/gh.js'] } }));

  const s = await h.tick();

  assert.deepEqual(s.guarded, []);
  assert.deepEqual(s.claimed.map((c) => c.number), [8], 'done is neither running nor review — it merged, so it no longer holds anything');
});

test('path_overlap guard: two overlapping ready cards are both claimed in one tick on a manual board', async (t) => {
  const h = harness(); // manual is the default merge.mode, so path_overlap defaults to "off"
  t.after(h.cleanup);
  h.store.addIssue(kbIssue({ number: 7, status: 'ready', agent: 'claude', kb: { paths: ['src/model.js'] } }));
  h.store.addIssue(kbIssue({ number: 8, status: 'ready', agent: 'claude', kb: { paths: ['src/model.js', 'src/dispatch.js'] } }));

  const s = await h.tick();

  assert.deepEqual(s.guarded, []);
  assert.deepEqual(s.claimed.map((c) => c.number).sort(), [7, 8]);
});

test('dry-run names the card and paths a guarded candidate collides with', async (t) => {
  const h = harness({ dispatch: { guards: { path_overlap: 'running' } } });
  t.after(h.cleanup);
  const run = runWith([{ attempt: 1, host: 'test-host', started_at: ago(30), heartbeat_at: ago(5), pid: process.pid }]);
  h.store.addIssue(kbIssue({ number: 7, status: 'running', agent: 'claude', kb: { paths: ['src/'] }, run }));
  h.store.addIssue(kbIssue({ number: 8, status: 'ready', agent: 'claude', kb: { paths: ['src/gh.js'] } }));

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

// ---------- a root with children is a track by default (#161) ----------

/** The default harness profiles plus a track profile, so inference has somewhere to send a root. */
const withTrack = () => ({
  claude: { mode: 'process', max_in_progress: 2, model: null, allowed_tools: [], launch: ['true'] },
  'claude-track': { mode: 'process', track: true, track_agents: ['claude', 'claude-track'], max_in_progress: 1, model: null, allowed_tools: [], launch: ['true'] },
});

test('a root nobody adopted is dispatched as one track, and its children are left to it', async (t) => {
  const h = harness({ profiles: withTrack() });
  t.after(h.cleanup);
  h.store.addIssue(kbIssue({ number: 1, status: 'ready', agent: 'claude' }));
  h.store.addIssue(kbIssue({ number: 2, status: 'ready', agent: 'claude' }));
  h.store.addIssue(kbIssue({ number: 3, status: 'todo', agent: 'claude', blockedBy: [1, 2] }));

  const s = await h.tick();

  assert.deepEqual(s.tracks.map((x) => [x.root, x.ok, x.mode, x.profile, x.nodes]), [[3, true, 'inferred', 'claude-track', [1, 2]]]);
  assert.deepEqual(s.claimed, [], 'both leaves belong to the track: no cold session for either');
  assert.deepEqual(s.skipped.map((x) => x.why), ['held for track #3', 'held for track #3']);
  assert.deepEqual(await h.store.locks(), ['3/1'], 'one lock: the root');
  assert.equal(h.store.statusOf(3), 'running');
});

test('kb:no-track sends the same graph back to node dispatch, one cold session per leaf', async (t) => {
  const h = harness({ profiles: withTrack() });
  t.after(h.cleanup);
  h.store.addIssue(kbIssue({ number: 1, status: 'ready', agent: 'claude' }));
  h.store.addIssue(kbIssue({ number: 2, status: 'ready', agent: 'claude' }));
  h.store.addIssue(kbIssue({ number: 3, status: 'todo', agent: 'claude', labels: [L.noTrack], blockedBy: [1, 2] }));

  const s = await h.tick();

  assert.deepEqual(s.tracks, []);
  assert.deepEqual(s.claimed.map((c) => [c.number, c.profile]), [[1, 'claude'], [2, 'claude']]);
  assert.equal(h.store.statusOf(3), 'todo');
});

test('a running track counts against the track profile\'s cap, not against its card\'s label', async (t) => {
  const h = harness({ profiles: withTrack() });
  t.after(h.cleanup);
  // #3 is already running its inferred track over #1; #6 is a second root that would like one too
  const alive = runWith([{ attempt: 1, profile: 'claude-track', host: 'test-host', started_at: ago(60), heartbeat_at: ago(5), pid: process.pid, track: true, track_mode: 'inferred', track_nodes: [1] }]);
  h.store.addIssue(kbIssue({ number: 1, status: 'ready', agent: 'claude' }));
  h.store.addIssue(kbIssue({ number: 3, status: 'running', agent: 'claude', kb: { max_runtime: 86_400 }, blockedBy: [1], run: alive }));
  h.store.hold(3, 1);
  h.store.addIssue(kbIssue({ number: 5, status: 'ready', agent: 'claude' }));
  h.store.addIssue(kbIssue({ number: 6, status: 'todo', agent: 'claude', blockedBy: [5] }));

  const s = await h.tick();

  assert.deepEqual(s.tracks.map((x) => [x.root, x.ok, x.why]), [[6, false, 'profile claude-track at cap']]);
  // and the refusal is the ordinary fallback: #5 goes out as a cold node rather than waiting
  assert.deepEqual(s.claimed.map((c) => [c.number, c.profile]), [[5, 'claude']]);
  assert.deepEqual(await h.store.locks(), ['3/1', '5/1']);
});

test('a dry run reports what it would do and writes nothing', async (t) => {
  const h = harness();
  t.after(h.cleanup);
  h.store.addIssue(kbIssue({ number: 1, status: 'done', state: 'CLOSED', stateReason: 'COMPLETED' }));
  h.store.addIssue(kbIssue({ number: 2, status: 'todo', blockedBy: [1] }));
  h.store.addIssue(kbIssue({ number: 3, status: 'ready', agent: 'claude' }));

  const s = await h.tick({ dryRun: true });

  assert.deepEqual(s.promoted, [2]);
  assert.deepEqual(s.claimed, [{ number: 3, attempt: 1, profile: 'claude', dry: true }]);
  assert.equal(h.store.statusOf(2), 'todo');
  assert.equal(h.store.statusOf(3), 'ready');
  assert.deepEqual(await h.store.locks(), []);
  assert.deepEqual(h.store.writes(), []);
  // Both halves. The store sees the board; a write that leaves through `src/forge.js` — a PR
  // PATCHed, an auto-merge enabled — never reaches the interface at all, so "writes nothing" is
  // only half-said until the forge says it too.
  assert.deepEqual(h.gh.writeRequests(), []);
});

// ---------- what a host will and will not launch ----------
// `--profiles` and the two unclaimable-profile cases. `test/actions.test.js` held the only coverage
// of the `--profiles` gate and went with the Actions runner (#290); the feature stayed, so the test
// comes back here on local profiles, where it always belonged.

test('--profiles claims only what this host launches, and sweeps the whole board anyway', async (t) => {
  const h = harness({
    profiles: {
      claude: { mode: 'process', max_in_progress: 2, allowed_tools: [], launch: ['true'] },
      'claude-p': { mode: 'process', max_in_progress: 2, allowed_tools: [], launch: ['true'] },
    },
  });
  t.after(h.cleanup);
  h.store.addIssue(kbIssue({ number: 1, title: 'shipped', status: 'done', state: 'CLOSED', stateReason: 'COMPLETED' }));
  h.store.addIssue(kbIssue({ number: 5, status: 'ready', agent: 'claude' }));
  h.store.addIssue(kbIssue({ number: 6, status: 'ready', agent: 'claude-p' }));
  h.store.addIssue(kbIssue({ number: 7, status: 'todo', agent: 'claude-p', blockedBy: [1] }));

  const s = await h.tick({ profiles: ['claude'] });

  assert.deepEqual(s.claimed.map((c) => c.number), [5], 'only the profile this host was told to run');
  assert.deepEqual(s.skipped.filter((x) => x.number === 6).map((x) => x.why), ['profile claude-p is not dispatched from this host']);
  assert.deepEqual(s.promoted, [7], 'promotion still covers the whole board, whatever this host claims');
});

test('a spawn that never starts a process fails the attempt and hands the card back to ready', async (t) => {
  const h = harness({ profiles: { claude: { mode: 'process', max_in_progress: 2, allowed_tools: [], launch: ['hkb-no-such-binary-38fa1c'] } } });
  t.after(h.cleanup);
  h.store.addIssue(kbIssue({ number: 5, status: 'ready', agent: 'claude' }));

  const s = await h.tick();

  assert.deepEqual(s.spawn_failed.map((x) => x.number), [5]);
  assert.equal(h.store.statusOf(5), 'ready', 'the card comes straight back, it was never worked');
  assert.equal(h.store.runOf(5).attempts[0].outcome, 'spawn_failed');
  assert.deepEqual(await h.store.locks(), [], 'and the claim is released');
});

test('a card on a profile hkb removed is skipped, and the note names the re-point', async (t) => {
  const h = harness();
  t.after(h.cleanup);
  h.ctx.cfg.removed_profiles = [{ name: 'claude-action', why: 'the GitHub Actions runner was removed in ADR-006' }];
  h.store.addIssue(kbIssue({ number: 5, status: 'ready', agent: 'claude-action' }));

  const s = await h.tick();

  assert.deepEqual(s.claimed, [], 'never claimed — a claim would spawn-fail every tick until the retries ran out');
  const why = s.skipped.find((x) => x.number === 5).why;
  assert.match(why, /was removed/);
  assert.match(why, /hkb adopt 5 --agent claude --status ready/, 'the fix is the verb that re-points the card, not one that writes the profile back');
  assert.doesNotMatch(why, /hkb init --profiles/);
});

test('a profile with no launch template is skipped, not claimed', async (t) => {
  const h = harness({ profiles: { claude: { mode: 'process', max_in_progress: 2, allowed_tools: [], launch: null } } });
  t.after(h.cleanup);
  h.store.addIssue(kbIssue({ number: 5, status: 'ready', agent: 'claude' }));

  const s = await h.tick();

  assert.deepEqual(s.claimed, []);
  assert.match(s.skipped.find((x) => x.number === 5).why, /no launch template/);
  assert.equal(h.store.statusOf(5), 'ready');
});

test('a legacy remote attempt keeps its heartbeat-only liveness — no pid to look for', async (t) => {
  const h = harness({ dispatch: { stale_after: 3600 } });
  t.after(h.cleanup);
  // Written by an hkb that still had the Actions runner: this host claimed it, and there never was a
  // local process. The no-handle rule would call it crashed 180s in.
  const run = runWith([{ attempt: 1, profile: 'claude-action', host: 'test-host', remote: true, pid: null, started_at: ago(7200), heartbeat_at: ago(7200), lock_sha: 'a'.repeat(40) }]);
  h.store.addIssue(kbIssue({ number: 5, status: 'running', agent: 'claude', kb: { max_runtime: 86_400 }, run }));
  h.store.beat(5, 1, ago(120));

  const s = await h.tick({ max: 0 });

  assert.deepEqual(s.reclaimed, [], 'a fresh heartbeat is the whole check for a row with no local handle');
  assert.equal(h.store.statusOf(5), 'running');
  assert.deepEqual(await h.store.locks(), ['5/1'], 'and its lock is left alone');
});

// ---------- what the loop calls a tick worth pushing (docs/local-first.md §6.2) ----------

test('DURABLE_TICK_KEYS names every summary key a tick writes the branch for', async (t) => {
  // Read off a real tick's summary rather than a retyped list, so a new key that reports a decision
  // has to be classified here rather than silently defaulting to "not durable". That default is
  // what left `tracks` and `spawn_failed` off the list: a board driven by track dispatch does
  // `saveRun` and `setStatus(t, 'running')`, reports it under `tracks` alone, and so never pushed
  // and — worse — never re-stamped, which is how another host's `--take-over` comes to take a board
  // that is ticking right now.
  const h = harness();
  t.after(h.cleanup);
  const s = await tick(h.ctx, { log: h.log });

  // The three keys that are not decisions: a claim somebody else won, a card the tick passed over,
  // and the fatal slot, which is not a list at all.
  const notDecisions = new Set(['held', 'skipped', 'fatal']);
  const expected = Object.keys(s).filter((k) => Array.isArray(s[k]) && !notDecisions.has(k)).sort();
  assert.deepEqual([...DURABLE_TICK_KEYS].sort(), expected);
});

test('a tick whose lock listing failed spends no per-card ref read to make up for it', async (t) => {
  // Routing `lockBeatAt` through the store made the *driver* fall back to `lockSha(n, k)` when the
  // caller passed no token. The old call site passed the sha straight in, so `lockBeatAt(ctx, null)`
  // answered null and asked for nothing. That fallback fires exactly when `listLocks()` threw — one
  // extra REST call per running card, on the tick that already failed to list them.
  const h = harness({ dispatch: { stale_after: 60 } });
  t.after(h.cleanup);
  const run = runWith([{ attempt: 1, host: 'other-host', started_at: ago(3600), heartbeat_at: ago(3600), lock_sha: 'a'.repeat(40) }]);
  h.store.addIssue(kbIssue({ number: 7, status: 'running', agent: 'claude', kb: { max_runtime: 86_400 }, run }));
  h.store.beat(7, 1, ago(900));
  h.store.fail('listLocks', { message: 'the lock listing is down' });

  await h.tick({ max: 0 });

  assert.deepEqual(h.store.callsOf('lockBeatAt'), [],
    'no row in the listing means no token and nothing to read — not a lookup per running card');
  assert.match(h.log(), /lock listing failed/, 'and the tick says so out loud rather than quietly paying for it');
});
