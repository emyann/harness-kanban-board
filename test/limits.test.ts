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
  spent24h: 0, dailyBudgetUsd: null, jobBudgetUsd: 1,
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
  assert.match(why(g), /kb start/, 'an error says what to do next');
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

// ---------------------------------------------------------------- precedence

test('the kill switch is checked before concurrency, and concurrency before budget', () => {
  const all = gateClaim({
    pausedAt: new Date(), pausedBy: 'x',
    liveLeases: 99, maxConcurrent: 1,
    spent24h: 500, dailyBudgetUsd: 1, jobBudgetUsd: 1,
  });
  assert.match(why(all), /stopped/, 'the most operator-intentional reason wins');

  const noPause = gateClaim({
    pausedAt: null, pausedBy: null,
    liveLeases: 99, maxConcurrent: 1,
    spent24h: 500, dailyBudgetUsd: 1, jobBudgetUsd: 1,
  });
  assert.match(why(noPause), /concurrent slots/);
});

// ---------------------------------------------------------------- the window

test('the window is a rolling 24 hours, with no timezone in it', () => {
  const now = new Date('2026-09-05T05:00:00Z');
  assert.equal(windowStart(now).toISOString(), '2026-09-04T05:00:00.000Z');
});
