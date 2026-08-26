// `hkb stats`: the window, the attempt roll-up, the spend coverage — and the read budget.
// The pure functions are exercised directly; the command runs against the in-memory GitHub
// (test/fake-gh.js), where "nothing was written" is something a test can assert.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_BOARD } from '../src/board.js';
import { STATUSES, OUTCOMES } from '../src/model.js';
import {
  parseSince, tasksInWindow, collectAttempts, summarizeTasks, summarizeAttempts, summarizeSpend,
  spawnBudget, computeStats, formatStats, sessionFromLog, stats, DEFAULT_SINCE,
} from '../src/stats.js';
import { FakeGh, kbIssue, runWith } from './fake-gh.js';

const NOW = new Date('2026-08-26T12:00:00.000Z');
const ago = (ms, from = NOW) => new Date(from.getTime() - ms).toISOString();
const minutes = (n) => n * 60_000;
const hours = (n) => n * 3_600_000;
const days = (n) => n * 86_400_000;

const task = (number, over = {}) => ({ number, status: 'ready', state: 'OPEN', needsHuman: false, updatedAt: ago(hours(1)), ...over });

// ---------- the window ----------

test('parseSince reads spans, dates and "all"', () => {
  assert.equal(parseSince(undefined, NOW).window, DEFAULT_SINCE);
  assert.equal(parseSince(undefined, NOW).since, ago(days(7)));
  assert.deepEqual(parseSince('90m', NOW), { since: ago(minutes(90)), window: '90m' });
  assert.deepEqual(parseSince('36h', NOW), { since: ago(hours(36)), window: '36h' });
  assert.deepEqual(parseSince('2w', NOW), { since: ago(days(14)), window: '2w' });
  assert.deepEqual(parseSince('all', NOW), { since: null, window: 'all' });
  assert.equal(parseSince('2026-08-01', NOW).since, '2026-08-01T00:00:00.000Z');
  assert.equal(parseSince('2026-08-01T06:30:00Z', NOW).since, '2026-08-01T06:30:00.000Z');
});

test('parseSince names the fix when it cannot read the value', () => {
  assert.throws(() => parseSince(true, NOW), (e) => e.exitCode === 2 && /--since needs a value/.test(e.message));
  assert.throws(() => parseSince('last tuesday', NOW), (e) => e.exitCode === 2 && /7d, 36h, 90m, 2w/.test(e.message));
  assert.throws(() => parseSince('0d', NOW), (e) => e.exitCode === 2 && /zero-length/.test(e.message));
});

test('the window keeps what has news — plus every running task, whose heartbeat is silent', () => {
  const tasks = [
    task(1, { updatedAt: ago(minutes(10)) }),
    task(2, { updatedAt: ago(days(30)) }),
    task(3, { status: 'running', updatedAt: ago(days(30)) }),
    task(4, { updatedAt: null }),
  ];
  assert.deepEqual(tasksInWindow(tasks, ago(days(7))).map((t) => t.number), [1, 3]);
  assert.deepEqual(tasksInWindow(tasks, null).map((t) => t.number), [1, 2, 3, 4]);
});

// ---------- attempts ----------

const runs = (map) => new Map(Object.entries(map).map(([n, run]) => [Number(n), run]));

test('an ended attempt is in the window when it ended inside it; an open one always is', () => {
  const rows = collectAttempts([task(7)], runs({
    7: runWith([
      { attempt: 1, started_at: ago(days(30)), ended_at: ago(days(29)), outcome: 'completed' }, // long gone
      { attempt: 2, started_at: ago(days(9)), ended_at: ago(days(2)), outcome: 'completed' }, // started before, ended inside
      { attempt: 3, started_at: ago(days(30)) }, // still open: its start is old but it is happening now
      { attempt: 4, started_at: 'not a date' },
    ]),
  }), ago(days(7)));
  assert.deepEqual(rows.map((r) => r.attempt), [2, 3]);
  assert.equal(rows[0].duration_ms, days(7));
  assert.equal(rows[0].outcome, 'completed');
  assert.equal(rows[1].outcome, null, 'an open attempt has no outcome yet');
  assert.equal(rows[1].duration_ms, null);
});

test('collectAttempts takes the cost off the row, then off the worker log', () => {
  const rows = collectAttempts([task(7)], runs({
    7: runWith([
      { attempt: 1, started_at: ago(hours(2)), ended_at: ago(hours(1)), outcome: 'completed', total_cost_usd: 0.5, num_turns: 12 },
      { attempt: 2, started_at: ago(hours(2)), ended_at: ago(hours(1)), outcome: 'protocol_violation', log: '.kanban/logs/7-2.log' },
      { attempt: 3, started_at: ago(minutes(5)), log: '.kanban/logs/7-3.log' },
    ]),
  }), null, { cost: (a) => (a.log === '.kanban/logs/7-2.log' ? { total_cost_usd: 0.25, num_turns: 7 } : null) });
  assert.deepEqual(rows.map((r) => [r.cost_usd, r.cost_source]), [[0.5, 'run_record'], [0.25, 'worker_log'], [null, null]]);
  assert.equal(rows[1].num_turns, 7);
});

test('summarizeAttempts splits delivered from blocked from failed, and averages only real work', () => {
  const rows = collectAttempts([task(1), task(2)], runs({
    1: runWith([
      { attempt: 1, started_at: ago(minutes(30)), ended_at: ago(minutes(20)), outcome: 'completed' }, // 10m
      { attempt: 2, started_at: ago(minutes(20)), ended_at: ago(minutes(10)), outcome: 'crashed' }, // 10m
    ]),
    2: runWith([
      { attempt: 1, started_at: ago(minutes(60)), ended_at: ago(minutes(30)), outcome: 'review_requested' }, // 30m
      { attempt: 2, started_at: ago(minutes(10)), ended_at: ago(minutes(9)), outcome: 'blocked' }, // 1m
      { attempt: 3, started_at: ago(minutes(9)), ended_at: ago(minutes(9)), outcome: 'gave_up', synthetic: true },
      { attempt: 4, started_at: ago(minutes(1)) },
    ]),
  }), null);
  const a = summarizeAttempts(rows);
  assert.equal(a.total, 6);
  assert.equal(a.tasks, 2);
  assert.equal(a.ended, 5);
  assert.equal(a.active, 1);
  assert.deepEqual([a.delivered, a.blocked, a.failed], [2, 1, 2]);
  assert.equal(a.delivered_rate, 0.4);
  assert.equal(a.by_outcome.completed, 1);
  assert.equal(a.by_outcome.gave_up, 1);
  assert.equal(a.duration_ms.count, 4, 'the synthetic gave_up row is bookkeeping, not an attempt that ran');
  assert.equal(a.duration_ms.mean, minutes(51 / 4));
  assert.equal(a.duration_ms.median, minutes(10));
  assert.equal(a.duration_ms.max, minutes(30));
});

test('an empty window still answers with the full shape', () => {
  const a = summarizeAttempts([]);
  assert.equal(a.total, 0);
  assert.equal(a.delivered_rate, null);
  assert.deepEqual(Object.keys(a.by_outcome), OUTCOMES);
  assert.deepEqual(a.duration_ms, { count: 0, total: 0, mean: null, median: null, p90: null, max: null });
});

// ---------- spend ----------

test('spend is per profile, and says how much of it is guesswork-free', () => {
  const rows = collectAttempts([task(1), task(2)], runs({
    1: runWith([
      { attempt: 1, profile: 'claude', started_at: ago(hours(2)), ended_at: ago(hours(1)), outcome: 'completed', total_cost_usd: 1.5, num_turns: 20 },
      { attempt: 2, profile: 'claude', started_at: ago(hours(1)), ended_at: ago(minutes(30)), outcome: 'crashed', total_cost_usd: 0.5, num_turns: 4 },
    ]),
    2: runWith([
      { attempt: 1, profile: 'copilot-cli', started_at: ago(hours(3)), ended_at: ago(hours(2)), outcome: 'completed' },
      { attempt: 2, profile: 'claude', started_at: ago(minutes(5)) },
    ]),
  }), null);
  const s = summarizeSpend(rows);
  assert.equal(s.total_usd, 2);
  assert.equal(s.attempts_with_cost, 2);
  assert.equal(s.attempts_missing_cost, 1, 'the copilot attempt ended without a price; the open one is not counted');
  assert.deepEqual(s.sources, { run_record: 2, worker_log: 0 });
  assert.deepEqual(s.by_profile.claude, { attempts: 3, with_cost: 2, total_usd: 2, mean_usd: 1, max_usd: 1.5, turns: 24 });
  assert.deepEqual(s.by_profile['copilot-cli'], { attempts: 1, with_cost: 0, total_usd: 0, mean_usd: null, max_usd: null, turns: 0 });
});

test('sessionFromLog reads the final JSON off a worker log, and shrugs at anything else', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hkb-stats-log-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, '.kanban/logs'), { recursive: true });
  fs.writeFileSync(path.join(root, '.kanban/logs/7-1.log'), [
    '# 2026-08-26T10:00:00Z spawn claude for #7 attempt 1',
    'some noise',
    JSON.stringify({ type: 'result', session_id: 'sess-7', total_cost_usd: 0.42, num_turns: 9, duration_ms: 61_000 }),
  ].join('\n'));
  fs.writeFileSync(path.join(root, '.kanban/logs/7-2.log'), 'backgrounded · abc123\n');

  assert.equal(sessionFromLog(root, { log: '.kanban/logs/7-1.log' }).total_cost_usd, 0.42);
  assert.equal(sessionFromLog(root, { log: '.kanban/logs/7-2.log' }), null);
  assert.equal(sessionFromLog(root, { log: '.kanban/logs/nope.log' }), null);
  assert.equal(sessionFromLog(root, {}), null);
});

// ---------- spawns ----------

test('spawns today comes from the dispatcher state, and a stale day reads as zero', () => {
  assert.deepEqual(spawnBudget({ spawn_day: '2026-08-26', spawned_today: 12 }, 40, NOW), { day: '2026-08-26', today: 12, cap: 40, remaining: 28, at_cap: false, known: true });
  assert.deepEqual(spawnBudget({ spawn_day: '2026-08-25', spawned_today: 40 }, 40, NOW), { day: '2026-08-26', today: 0, cap: 40, remaining: 40, at_cap: false, known: true });
  assert.equal(spawnBudget({ spawn_day: '2026-08-26', spawned_today: 40 }, 40, NOW).at_cap, true);
  assert.deepEqual(spawnBudget({}, null, NOW), { day: '2026-08-26', today: 0, cap: null, remaining: null, at_cap: false, known: true });
  assert.equal(spawnBudget(null, 40, NOW).known, false, 'a checkout that never ran a tick knows nothing, it is not at zero');
});

test('a checkout with no dispatcher state says so instead of reporting zero spawns', () => {
  const text = formatStats(computeStats({ board: 'default', now: NOW, spawns: spawnBudget(null, 40, NOW) }));
  assert.match(text, /spawns {5}unknown here · cap 40 — no dispatcher state in this checkout/);
});

// ---------- the whole report ----------

const report = () => computeStats({
  board: 'default',
  repo: 'acme/board',
  now: NOW,
  since: ago(days(7)),
  window: '7d',
  spawns: spawnBudget({ spawn_day: '2026-08-26', spawned_today: 3 }, 40, NOW),
  tasks: [
    task(1, { status: 'done', state: 'CLOSED' }),
    task(2, { status: 'running' }),
    task(3, { status: 'ready', needsHuman: true }),
  ],
  runs: runs({
    1: runWith([{ attempt: 1, started_at: ago(hours(3)), ended_at: ago(hours(2)), outcome: 'completed', total_cost_usd: 1.25, num_turns: 30 }]),
    2: runWith([{ attempt: 1, started_at: ago(minutes(20)) }]),
    3: runWith([]),
  }),
});

test('computeStats answers with a stable shape a script can rely on', () => {
  const s = report();
  assert.deepEqual(Object.keys(s), ['board', 'repo', 'generated_at', 'since', 'window', 'tasks', 'attempts', 'spawns', 'spend', 'reads']);
  assert.deepEqual(Object.keys(s.tasks.by_status), STATUSES);
  assert.deepEqual(Object.keys(s.attempts.by_outcome), OUTCOMES);
  assert.equal(s.tasks.total, 3);
  assert.equal(s.tasks.open, 2);
  assert.equal(s.tasks.needs_human, 1);
  assert.equal(s.tasks.by_status.done, 1);
  assert.equal(s.attempts.total, 2);
  assert.equal(s.attempts.active, 1);
  assert.equal(s.attempts.duration_ms.mean, hours(1));
  assert.equal(s.spend.total_usd, 1.25);
  assert.equal(s.spawns.remaining, 37);
  assert.deepEqual(s.reads, { board: 1, run_comments: 3 });
});

test('the human report is one line per thing, and says what it does not know', () => {
  const text = formatStats(report());
  assert.match(text, /board "default" · acme\/board · window 7d/);
  assert.match(text, /tasks {6}3 \(2 open, 1 needs-human\)/);
  assert.match(text, /ready 1 · running 1 · done 1/);
  assert.match(text, /attempts {3}2 over 2 tasks · 1 ended · 1 active/);
  assert.match(text, /duration {3}mean 1h00m/);
  assert.match(text, /spawns {5}3 \/ 40 today · 37 left/);
  assert.match(text, /spend {6}\$1\.25 · recorded on 1 of 1 worker attempt/);
  assert.match(text, /claude {7}\s+\$1\.25 · 1 attempt · mean \$1\.25 · max \$1\.25 · 30 turns/);
  assert.match(text, /read 1 board query \+ 3 run records; nothing was written\./);
});

test('a board with nothing recorded still reports, and points at why there is no spend', () => {
  const text = formatStats(computeStats({
    board: 'default', now: NOW, since: ago(days(7)), window: '7d',
    tasks: [task(1, { status: 'todo' })],
    runs: runs({ 1: runWith([{ attempt: 1, started_at: ago(hours(4)), ended_at: ago(hours(3)), outcome: 'crashed' }]) }),
    spawns: spawnBudget({}, 40, NOW),
  }));
  assert.match(text, /spend {6}not recorded on any of the 1 worker attempt — only a harness whose log/);
  assert.match(text, /spawns {5}0 \/ 40 today/);
});

test('at the cap, the report says so where a human will see it', () => {
  const text = formatStats(computeStats({ board: 'default', now: NOW, spawns: spawnBudget({ spawn_day: '2026-08-26', spawned_today: 40 }, 40, NOW) }));
  assert.match(text, /AT CAP/);
  assert.match(text, /attempts {3}none in the window/);
});

// ---------- the command, end to end ----------

function harness({ board = 'default', dispatch = {}, state = null } = {}) {
  const gh = new FakeGh();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hkb-stats-'));
  fs.mkdirSync(path.join(root, '.kanban'), { recursive: true });
  if (state) fs.writeFileSync(path.join(root, '.kanban', 'state.json'), JSON.stringify(state));
  const ctx = {
    root,
    cfg: { ...DEFAULT_BOARD, repo: gh.nameWithOwner, board, dispatch: { ...DEFAULT_BOARD.dispatch, ...dispatch } },
    repo: { owner: gh.owner, repo: gh.repo, nameWithOwner: gh.nameWithOwner },
    board,
    host: 'test-host',
    json: false,
    caps: {},
    _cache: {},
    requireBoard() { return this; },
  };
  const restore = gh.install();
  const lines = [];
  return {
    gh,
    ctx,
    root,
    out: () => lines.join('\n'),
    run: (flags = {}) => stats(ctx, { since: 'all', ...flags }, { now: NOW, write: (s) => lines.push(s) }),
    cleanup: () => { restore(); fs.rmSync(root, { recursive: true, force: true }); },
  };
}

test('hkb stats: one board query, the run comments of the window, and not one write', async (t) => {
  const h = harness({ state: { spawn_day: '2026-08-26', spawned_today: 5 } });
  t.after(h.cleanup);
  h.gh.addIssue(kbIssue({
    number: 1, status: 'done', state: 'CLOSED', stateReason: 'COMPLETED', agent: 'claude', updatedAt: ago(hours(2)),
    run: runWith([{ attempt: 1, started_at: ago(hours(3)), ended_at: ago(hours(2)), outcome: 'completed', total_cost_usd: 0.8, num_turns: 15 }]),
  }));
  h.gh.addIssue(kbIssue({
    number: 2, status: 'running', agent: 'claude', updatedAt: ago(days(40)),
    run: runWith([{ attempt: 1, started_at: ago(minutes(15)) }]),
  }));
  h.gh.addIssue(kbIssue({ number: 3, status: 'ready', updatedAt: ago(days(40)) }));

  assert.equal(await h.run({ since: '7d' }), 0);
  const text = h.out();
  assert.match(text, /tasks {6}3 \(2 open\)/);
  assert.match(text, /attempts {3}2 over 2 tasks · 1 ended · 1 active/);
  assert.match(text, /spawns {5}5 \/ 40 today · 35 left/);
  assert.match(text, /spend {6}\$0\.80/);

  const boardQueries = h.gh.calls.filter((c) => c.kind === 'graphql' && /issues\(/.test(c.query || ''));
  assert.equal(boardQueries.length, 1, 'one board query per run');
  const commentReads = h.gh.callsMatching('GET', /issues\/\d+\/comments/);
  assert.deepEqual(commentReads.map((c) => Number(/issues\/(\d+)\//.exec(c.path)[1])), [1, 2], '#3 has no news and is not running');
  for (const method of ['POST', 'PATCH', 'DELETE']) assert.deepEqual(h.gh.callsMatching(method), [], `stats must not ${method}`);
});

test('hkb stats --json: the same object, and the local worker log fills a missing price', async (t) => {
  const h = harness();
  t.after(h.cleanup);
  fs.mkdirSync(path.join(h.root, '.kanban/logs'), { recursive: true });
  fs.writeFileSync(path.join(h.root, '.kanban/logs/5-1.log'), JSON.stringify({ session_id: 's5', total_cost_usd: 0.37, num_turns: 11 }) + '\n');
  h.gh.addIssue(kbIssue({
    number: 5, status: 'review', agent: 'claude', updatedAt: ago(minutes(5)),
    run: runWith([{ attempt: 1, started_at: ago(hours(1)), ended_at: ago(minutes(30)), outcome: 'review_requested', log: '.kanban/logs/5-1.log' }]),
  }));

  h.ctx.json = true;
  assert.equal(await h.run(), 0);
  const s = JSON.parse(h.out());
  assert.equal(s.board, 'default');
  assert.equal(s.window, 'all');
  assert.equal(s.since, null);
  assert.equal(s.spend.total_usd, 0.37);
  assert.deepEqual(s.spend.sources, { run_record: 0, worker_log: 1 });
  assert.equal(s.spend.by_profile.claude.turns, 11);
  assert.equal(s.attempts.delivered, 1);
  assert.equal(s.attempts.duration_ms.mean, minutes(30));
  assert.deepEqual(s.reads, { board: 1, run_comments: 1 });
});
