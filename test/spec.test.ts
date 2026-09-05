import test from 'node:test';
import assert from 'node:assert/strict';
import { BUILT_IN, boardDefaults, hasDefaults, resolveSpec, specValues } from '../src/spec.ts';

/**
 * The resolution order, exhaustively, against the case that would break it.
 *
 * A default that quietly outranks the value the operator set on the Job is the failure this whole
 * feature can have, and it is invisible: the Job runs, it just runs on the wrong model. So most of
 * what is below asserts that the board did NOT win — the refusing case, in the shape a pure
 * function has one.
 */

const empty = {} as const;

// ---------------------------------------------------------------- the order

test('the Job wins over the board, and the board over the built-in', () => {
  const r = resolveSpec(
    { model: 'from-the-job', maxTurns: 3 },
    { defaultModel: 'from-the-board', defaultMaxTurns: 99, defaultMaxRetries: 7 },
  );
  assert.equal(r.model.value, 'from-the-job');
  assert.equal(r.model.from, 'job');
  assert.equal(r.maxTurns.value, 3);
  assert.equal(r.maxTurns.from, 'job');
  assert.equal(r.maxRetries.value, 7, 'the board fills what the Job left null');
  assert.equal(r.maxRetries.from, 'board');
  assert.equal(r.maxBudgetUsd.value, BUILT_IN.maxBudgetUsd, 'and the built-in is the last resort');
  assert.equal(r.maxBudgetUsd.from, 'built-in');
});

test('a board default never overrides a value set on the Job, on any field', () => {
  const job = { model: 'j', effort: 'low', maxTurns: 1, maxBudgetUsd: 0.5, maxRetries: 1 };
  const board = {
    defaultModel: 'b', defaultEffort: 'max', defaultMaxTurns: 100,
    defaultMaxBudgetUsd: 100, defaultMaxRetries: 100,
  };
  const r = resolveSpec(job, board);
  assert.deepEqual(specValues(r), job, 'every field came from the Job');
  for (const f of Object.values(r)) assert.equal(f.from, 'job');
});

test('a board with no defaults changes nothing — the built-ins still answer', () => {
  const r = resolveSpec(empty, empty);
  assert.deepEqual(specValues(r), {
    model: null, effort: null,
    maxTurns: BUILT_IN.maxTurns, maxBudgetUsd: BUILT_IN.maxBudgetUsd, maxRetries: BUILT_IN.maxRetries,
  });
  for (const f of Object.values(r)) assert.equal(f.from, 'built-in');
});

test('no Job and no board at all is still a complete spec, not a crash', () => {
  assert.equal(resolveSpec(null, null).maxTurns.value, BUILT_IN.maxTurns);
  assert.equal(resolveSpec(undefined, undefined).maxRetries.from, 'built-in');
});

// ---------------------------------------------------------------- zero is a value

test('a zero on the Job is the Job speaking, not the Job staying silent', () => {
  // The bug a truthiness check would introduce, and the one that matters most: `maxRetries: 0`
  // means "one attempt, do not retry". Promoting it to the board's 5 would run a Job the operator
  // deliberately capped six times.
  const r = resolveSpec({ maxRetries: 0, maxBudgetUsd: 0 }, { defaultMaxRetries: 5, defaultMaxBudgetUsd: 50 });
  assert.equal(r.maxRetries.value, 0);
  assert.equal(r.maxRetries.from, 'job');
  assert.equal(r.maxBudgetUsd.value, 0);
  assert.equal(r.maxBudgetUsd.from, 'job');
});

test('a zero on the board is the board speaking too', () => {
  const r = resolveSpec(empty, { defaultMaxRetries: 0 });
  assert.equal(r.maxRetries.value, 0);
  assert.equal(r.maxRetries.from, 'board');
});

test('an empty-string model on the board is not a model — it is treated as set, so it is refused at the flag', () => {
  // `kb boards set --model ""` never gets here: the flag refuses an empty value. This records
  // that the resolver itself does no trimming, so the guard has to stay where it is.
  assert.equal(resolveSpec(empty, { defaultModel: '' }).model.value, '');
});

// ---------------------------------------------------------------- the shapes the CLI prints

test('boardDefaults renames the columns to what a Job calls them, nulls included', () => {
  assert.deepEqual(boardDefaults({ defaultModel: 'm', defaultMaxTurns: 4 }), {
    model: 'm', effort: null, maxTurns: 4, maxBudgetUsd: null, maxRetries: null,
  });
});

test('hasDefaults is false only when the board says nothing, and a zero still counts', () => {
  assert.equal(hasDefaults({}), false);
  assert.equal(hasDefaults({ defaultModel: null, defaultMaxRetries: null }), false);
  assert.equal(hasDefaults({ defaultMaxRetries: 0 }), true, '0 retries is an opinion');
  assert.equal(hasDefaults({ defaultModel: 'x' }), true);
});
