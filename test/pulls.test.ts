import test from 'node:test';
import assert from 'node:assert/strict';
import { pickPr, type PrRow } from '../src/pulls.ts';

/**
 * The board and the forge are two systems joined by a branch name, and this is the join.
 *
 * Phase 5's job #4 is the reason these are refusals rather than lookups: the branch `kb-4-1`
 * already existed on the remote from an unrelated experiment months earlier, the lookup returned
 * that experiment's CLOSED pull request, and the board recorded it as the Job's output while the
 * real work sat on another branch where nothing would ever find it. Nothing failed. The record
 * was simply wrong, quietly.
 */

const row = (o: Partial<PrRow> & { number: number; createdAt: string }): PrRow => ({
  url: `https://example/pull/${o.number}`, isDraft: true, state: 'OPEN',
  headRefName: 'kb-4-1', ...o,
});

const attemptStarted = new Date('2026-09-05T09:46:00Z');

test('a pull request older than the attempt is not the attempt output', () => {
  const stale = [row({ number: 341, createdAt: '2026-09-05T05:38:55Z', state: 'CLOSED' })];
  assert.equal(pickPr(stale, 'kb-4-1', attemptStarted), null,
    'this is job #4: the board recorded #341, a closed experiment, as the Job it never belonged to');
});

test('and with nothing else on the branch, null is the honest answer', () => {
  // Better than a wrong number: `kb show` then says "no pull request on kb-4-1", which sends a
  // human looking instead of at a dead link.
  assert.equal(pickPr([], 'kb-4-1', attemptStarted), null);
});

test('a pull request opened during the attempt is taken', () => {
  const mine = [row({ number: 353, createdAt: '2026-09-05T09:49:00Z' })];
  assert.equal(pickPr(mine, 'kb-4-1', attemptStarted)?.number, 353);
});

test('the newest wins when an attempt opened more than one', () => {
  const both = [
    row({ number: 353, createdAt: '2026-09-05T09:49:00Z' }),
    row({ number: 360, createdAt: '2026-09-05T09:58:00Z' }),
  ];
  assert.equal(pickPr(both, 'kb-4-1', attemptStarted)?.number, 360);
});

test('the stale one is skipped even when gh returns it first', () => {
  // `--limit 1` used to make this the only candidate, which is precisely how it won.
  const mixed = [
    row({ number: 341, createdAt: '2026-09-05T05:38:55Z', state: 'CLOSED' }),
    row({ number: 353, createdAt: '2026-09-05T09:49:00Z' }),
  ];
  assert.equal(pickPr(mixed, 'kb-4-1', attemptStarted)?.number, 353);
});

test('a pull request on a different head is refused, whatever gh was asked', () => {
  const wrong = [row({ number: 999, createdAt: '2026-09-05T09:49:00Z', headRefName: 'kb-4-1-boards-rm' })];
  assert.equal(pickPr(wrong, 'kb-4-1', attemptStarted), null,
    'the branch name is the only thing tying a pull request to a Job; it is not a hint');
});

test('with no fence, the newest on the branch is still the answer', () => {
  // `readPr` is also used where there is no attempt to date from, so the filter has to be optional
  // without becoming the old behaviour: newest, not first.
  const rows = [
    row({ number: 1, createdAt: '2020-01-01T00:00:00Z' }),
    row({ number: 2, createdAt: '2026-01-01T00:00:00Z' }),
  ];
  assert.equal(pickPr(rows, 'kb-4-1')?.number, 2);
});

test('a merged pull request is a legitimate answer, a closed one is not special-cased', () => {
  // State is deliberately not filtered: what disqualifies #341 is its age, not that it is closed.
  // A worker can legitimately have its pull request closed by a human while the attempt records it.
  const merged = [row({ number: 353, createdAt: '2026-09-05T09:49:00Z', state: 'MERGED', isDraft: false })];
  const got = pickPr(merged, 'kb-4-1', attemptStarted);
  assert.equal(got?.state, 'MERGED');
  assert.equal(got?.isDraft, false);
});
