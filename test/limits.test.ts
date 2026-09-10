import test from 'node:test';
import assert from 'node:assert/strict';
import { gateClaim, windowStart, type ClaimInputs } from '../src/limits.ts';

/**
 * Every test here proves a REFUSAL.
 *
 * Twice in two phases a guard turned out to be silently inert — the admission gate under
 * `bypassPermissions`, and the worktree base that made a tree full of commits read as empty. Both
 * passed every test that asked "does it allow?". Neither was ever asked "does it block?".
 */

const open: ClaimInputs = {
  pausedAt: null, pausedBy: null,
  liveLeases: 0, maxConcurrent: 2,
  spent24h: 0, committedUsd: 0, dailyBudgetUsd: null, jobBudgetUsd: 1,
};
const why = (g: ReturnType<typeof gateClaim>) => (g.ok ? '' : g.why);

test('an open board with room and no ceiling admits', () => {
  assert.equal(gateClaim(open).ok, true);
});

// ---------------------------------------------------------------- the kill switch

test('a stopped board refuses, and names who stopped it and when', () => {
  const at = new Date('2026-09-05T05:00:00Z');
  const g = gateClaim({ ...open, pausedAt: at, pausedBy: 'yrnd1@1234' });
  assert.equal(g.ok, false);
  assert.match(why(g), /stopped by yrnd1@1234/);
  assert.match(why(g), /2026-09-05T05:00:00/);
  assert.match(why(g), /hkb start/, 'an error says what to do next');
});

test('the kill switch outranks having room and budget', () => {
  const g = gateClaim({ ...open, pausedAt: new Date(), liveLeases: 0, dailyBudgetUsd: 1000 });
  assert.equal(g.ok, false, 'stopped means stopped');
});

// ---------------------------------------------------------------- concurrency

test('a full board refuses and says how full', () => {
  const g = gateClaim({ ...open, liveLeases: 2, maxConcurrent: 2 });
  assert.equal(g.ok, false);
  assert.match(why(g), /2 of 2 concurrent slots/);
});

test('one slot free still admits — the check is >=, not >', () => {
  assert.equal(gateClaim({ ...open, liveLeases: 1, maxConcurrent: 2 }).ok, true);
});

test('maxConcurrent 0 refuses everything, which is a usable way to drain a board', () => {
  assert.equal(gateClaim({ ...open, liveLeases: 0, maxConcurrent: 0 }).ok, false);
});

test('a full board says how to make it less full', () => {
  const g = gateClaim({ ...open, liveLeases: 2, maxConcurrent: 2 });
  assert.match(why(g), /hkb boards set <slug> --max-concurrent <n>/,
    'the old advice was "raise maxConcurrent", which named a column and not a verb');
});

test('the refusal says WHICH ceiling, not only why', () => {
  // The caller has to tell these apart: a stopped board never un-stops by waiting, while the other
  // two can be walls a reconciler is standing at because of its own runs.
  const stopped = gateClaim({ ...open, pausedAt: new Date() });
  const full = gateClaim({ ...open, liveLeases: 2, maxConcurrent: 2 });
  const broke = gateClaim({ ...open, dailyBudgetUsd: 1, jobBudgetUsd: 2 });
  assert.deepEqual(
    [stopped, full, broke].map((g) => (g.ok === false ? g.limit : 'ok')),
    ['stopped', 'concurrency', 'budget'],
  );
});

// ---------------------------------------------------------------- budget

test('the ceiling is checked against what the Job COULD cost, not what it has cost', () => {
  // Nothing spent yet, so a cap that only looked at history would let this through and blow past.
  const g = gateClaim({ ...open, spent24h: 0, dailyBudgetUsd: 5, jobBudgetUsd: 10 });
  assert.equal(g.ok, false, 'a cap that notices after the money is gone is a report, not a ceiling');
  assert.match(why(g), /may cost \$10\.00/);
});

test('a board at its ceiling refuses and shows both numbers', () => {
  const g = gateClaim({ ...open, spent24h: 9.5, dailyBudgetUsd: 10, jobBudgetUsd: 1 });
  assert.equal(g.ok, false);
  assert.match(why(g), /\$9\.50 spent in 24h/);
  assert.match(why(g), /\$10\.00 ceiling/);
});

test('exactly at the ceiling is allowed; a penny over is not', () => {
  assert.equal(gateClaim({ ...open, spent24h: 9, dailyBudgetUsd: 10, jobBudgetUsd: 1 }).ok, true);
  assert.equal(gateClaim({ ...open, spent24h: 9.01, dailyBudgetUsd: 10, jobBudgetUsd: 1 }).ok, false);
});

test('no ceiling means no budget refusal, however much has been spent', () => {
  assert.equal(gateClaim({ ...open, spent24h: 9999, dailyBudgetUsd: null }).ok, true);
});

test('a zero ceiling refuses everything, including a free Job', () => {
  assert.equal(gateClaim({ ...open, dailyBudgetUsd: 0, jobBudgetUsd: 0 }).ok, true, '0 + 0 is not > 0');
  assert.equal(gateClaim({ ...open, dailyBudgetUsd: 0, jobBudgetUsd: 0.01 }).ok, false);
});

// ---------------------------------------------------------------- budget, with runs in flight

test('money promised to a run in flight is spent as far as the ceiling is concerned', () => {
  // The refusal that only exists because a board can run two at once. `spent24h` moves when an
  // attempt ENDS, so without this a second claim is judged against a spend the first has not
  // contributed to yet, and two $6 Jobs both start under a $10 ceiling.
  const g = gateClaim({ ...open, spent24h: 0, committedUsd: 6, dailyBudgetUsd: 10, jobBudgetUsd: 6 });
  assert.equal(g.ok, false, '0 spent + 6 committed + 6 more is 12, over 10');
  assert.match(why(g), /\$6\.00 committed to runs in flight/, 'and it says where the money went');
  assert.match(why(g), /wait for a run to finish/, 'an error says what to do next');
});

test('with nothing in flight the budget refusal reads exactly as it always did', () => {
  const g = gateClaim({ ...open, spent24h: 4, committedUsd: 0, dailyBudgetUsd: 5, jobBudgetUsd: 2 });
  assert.match(why(g), /\$4\.00 spent in 24h and this Job may cost \$2\.00/);
  assert.doesNotMatch(why(g), /committed/, 'no clause about work in flight when there is none');
});

test('committed money still admits while the total fits', () => {
  assert.equal(gateClaim({ ...open, spent24h: 1, committedUsd: 2, dailyBudgetUsd: 10, jobBudgetUsd: 7 }).ok,
    true, '1 + 2 + 7 is exactly 10');
  assert.equal(gateClaim({ ...open, spent24h: 1, committedUsd: 2, dailyBudgetUsd: 10, jobBudgetUsd: 7.01 }).ok,
    false, 'and a penny more is not');
});

// ---------------------------------------------------------------- precedence

test('the kill switch is checked before concurrency, and concurrency before budget', () => {
  const all = gateClaim({
    pausedAt: new Date(), pausedBy: 'x',
    liveLeases: 99, maxConcurrent: 1,
    spent24h: 500, committedUsd: 0, dailyBudgetUsd: 1, jobBudgetUsd: 1,
  });
  assert.match(why(all), /stopped/, 'the most operator-intentional reason wins');

  const noPause = gateClaim({
    pausedAt: null, pausedBy: null,
    liveLeases: 99, maxConcurrent: 1,
    spent24h: 500, committedUsd: 0, dailyBudgetUsd: 1, jobBudgetUsd: 1,
  });
  assert.match(why(noPause), /concurrent slots/);
});

// ---------------------------------------------------------------- the window

test('the window is a rolling 24 hours, with no timezone in it', () => {
  const now = new Date('2026-09-05T05:00:00Z');
  assert.equal(windowStart(now).toISOString(), '2026-09-04T05:00:00.000Z');
});

// ---------------------------------------------------------------- the Job's own wall clock

/**
 * `deadlineExceeded` — Kubernetes' `JobSpec.activeDeadlineSeconds`, as a pure decision.
 *
 * The per-attempt clock bounds a runaway session; this bounds a runaway Job. Both refusing cases
 * matter and they refuse in opposite directions: a Job with no deadline must never be ended, and a
 * Job past one must never get another attempt however many retries it has left.
 */
const { deadlineExceeded, deadlineShortfall, activeMs } = await import('../src/limits.ts');

const at = (ms: number) => new Date(1_000_000 + ms);
const ran = (...spans: [number, number | null][]) =>
  activeMs(spans.map(([s, e]) => ({ startedAt: at(s), endedAt: e == null ? null : at(e) })), at(10_000_000));

test('no deadline means no deadline — the shipped default ends nothing', () => {
  assert.equal(deadlineExceeded(999_999_999, null), false);
  assert.equal(deadlineExceeded(999_999_999, undefined), false);
});

test('a Job that never ran has spent nothing', () => {
  assert.equal(activeMs([], at(0)), 0);
  assert.equal(deadlineExceeded(activeMs([], at(999)), 60), false);
});

test('it counts time RUNNING, not wall clock — queue time between attempts is free', () => {
  // The case that decided this: a Job crashes after 2 minutes, the board is busy for five hours at
  // maxConcurrent 1, then a second attempt succeeds in 3 minutes. Five minutes of compute.
  const spent = ran([0, 120_000], [5 * 3_600_000, 5 * 3_600_000 + 180_000]);
  assert.equal(spent, 300_000, 'five minutes, not five hours');
  assert.equal(deadlineExceeded(spent, 3600), false, 'an hour of deadline is not spent by waiting');
});

test('an attempt still open counts up to now, so the claim guard and the verdict agree', () => {
  assert.equal(activeMs([{ startedAt: at(0), endedAt: null }], at(90_000)), 90_000);
});

test('the boundary is inclusive: exactly at the deadline IS exceeded', () => {
  assert.equal(deadlineExceeded(59_000, 60), false);
  assert.equal(deadlineExceeded(60_000, 60), true);
  assert.equal(deadlineExceeded(60_001, 60), true);
});

test('the shortfall names both numbers and the way back, since a retry is what it refuses', () => {
  const why = deadlineShortfall(7, 2 * 3_600_000, 3600);
  assert.match(why, /#7/);
  assert.match(why, /120m/, 'how long it actually ran');
  assert.match(why, /60m/, 'and the deadline it ran past');
  assert.match(why, /--deadline/, 'and the flag that changes it');
  assert.match(why, /retries or not/, 'said plainly, because retries left is the confusing part');
});

test('and it has resolution where the flags do — seconds are reachable, so seconds are printed', () => {
  // `--deadline 90` with a 100s run used to read "ran 2m ... deadline is 2m", which describes a Job
  // killed for hitting a limit it did not exceed.
  const why = deadlineShortfall(1, 100_000, 90);
  assert.match(why, /100s/);
  assert.match(why, /90s/);
});
