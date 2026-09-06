import test from 'node:test';
import assert from 'node:assert/strict';

import { BUILT_IN, boardDefaults, hasDefaults, resolveSpec } from '../src/spec.ts';

/**
 * The resolution order, and the one way it fails silently.
 *
 * Nothing crashes when a Board default wins over a value the operator set on the Job. The Job runs;
 * it just runs on the wrong model, at the wrong cap, and the only trace is a bill. So the tests
 * that matter here are the REFUSALS — the board did *not* win, field by field, including the zeros,
 * where a truthiness check instead of `!= null` would quietly promote "no retries" to the board's.
 *
 * `resolveSpec` is pure and structurally typed, so all of this is plain objects.
 */

const board = {
  defaultModel: 'claude-haiku-4-5',
  defaultEffort: 'low',
  defaultMaxTurns: 8,
  defaultMaxBudgetUsd: 0.25,
  defaultMaxRetries: 5,
  defaultAllowedTools: ['Read', 'Grep'],
};

test('a Job that says nothing takes the board default, and says so', () => {
  const r = resolveSpec({}, board);
  assert.equal(r.model.value, 'claude-haiku-4-5');
  assert.equal(r.model.from, 'board');
  assert.equal(r.maxTurns.value, 8);
  assert.equal(r.maxBudgetUsd.value, 0.25);
  assert.equal(r.maxRetries.value, 5);
  for (const f of [r.effort, r.maxTurns, r.maxBudgetUsd, r.maxRetries]) assert.equal(f.from, 'board');
});

test('the Job wins over the board on every field — the failure that is otherwise invisible', () => {
  const job = {
    model: 'claude-opus-4-6', effort: 'max', maxTurns: 99, maxBudgetUsd: 12, maxRetries: 1,
    allowedTools: ['Read'],
  };
  const r = resolveSpec(job, board);
  assert.equal(r.model.value, 'claude-opus-4-6', 'the board must not override an explicit --model');
  assert.equal(r.effort.value, 'max');
  assert.equal(r.maxTurns.value, 99);
  assert.equal(r.maxBudgetUsd.value, 12);
  assert.equal(r.maxRetries.value, 1);
  assert.deepEqual(r.allowedTools.value, ['Read'], 'a Job that narrowed its own surface keeps it');
  for (const f of Object.values(r)) assert.equal(f.from, 'job');
});

test('a board with no opinion falls through to the built-in, and says so', () => {
  const r = resolveSpec({}, {});
  assert.equal(r.model.value, null, 'saying nothing IS the built-in answer for a model');
  assert.equal(r.effort.value, null);
  assert.equal(r.maxTurns.value, BUILT_IN.maxTurns);
  assert.equal(r.maxBudgetUsd.value, BUILT_IN.maxBudgetUsd);
  assert.equal(r.maxRetries.value, BUILT_IN.maxRetries);
  for (const f of Object.values(r)) assert.equal(f.from, 'built-in');
});

test('a Job with no board at all still resolves — nothing here needs a row to exist', () => {
  const r = resolveSpec({ maxTurns: 3 }, null);
  assert.equal(r.maxTurns.value, 3);
  assert.equal(r.maxTurns.from, 'job');
  assert.equal(r.maxRetries.value, BUILT_IN.maxRetries);
});

test('a zero on the Job is a value, not an absence: `maxRetries: 0` beats the board\'s 5', () => {
  const r = resolveSpec({ maxRetries: 0 }, board);
  assert.equal(r.maxRetries.value, 0, '0 means "one attempt, do not retry" — a truthiness check loses it');
  assert.equal(r.maxRetries.from, 'job');
});

test('a zero on the BOARD is a value too, and beats the built-in', () => {
  const r = resolveSpec({}, { defaultMaxRetries: 0 });
  assert.equal(r.maxRetries.value, 0);
  assert.equal(r.maxRetries.from, 'board');
});

test('one field falling through does not drag the others with it', () => {
  const r = resolveSpec({ model: 'sonnet' }, { defaultMaxTurns: 4 });
  assert.equal(r.model.from, 'job');
  assert.equal(r.maxTurns.from, 'board');
  assert.equal(r.maxBudgetUsd.from, 'built-in');
});

test('hasDefaults is false only when the board says nothing at all', () => {
  assert.equal(hasDefaults({}), false);
  assert.equal(hasDefaults({ defaultModel: null, defaultMaxTurns: null }), false);
  assert.equal(hasDefaults({ defaultMaxRetries: 0 }), true, 'a default of zero is still a default');
  assert.equal(hasDefaults(board), true);
});

test('boardDefaults renames the columns to what a Job calls them, and keeps the nulls', () => {
  assert.deepEqual(boardDefaults(board), {
    model: 'claude-haiku-4-5', effort: 'low', maxTurns: 8, maxBudgetUsd: 0.25, maxRetries: 5,
    allowedTools: ['Read', 'Grep'],
  });
  assert.deepEqual(boardDefaults({}), {
    model: null, effort: null, maxTurns: null, maxBudgetUsd: null, maxRetries: null,
    allowedTools: null,
  });
});
