import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs, formatPromote } from '../src/cli.js';

test('parseArgs: positionals, --k v, --k=v, booleans, --', () => {
  const { flags, pos } = parseArgs(['create', 'Add auth', '--blocked-by', '12,13', '--priority=2', '--triage', '--json', '--', '--not-a-flag']);
  assert.deepEqual(pos, ['create', 'Add auth', '--not-a-flag']);
  assert.equal(flags['blocked-by'], '12,13');
  assert.equal(flags.priority, '2');
  assert.equal(flags.triage, true);
  assert.equal(flags.json, true);
});

test('parseArgs: a flag followed by another flag is boolean', () => {
  const { flags, pos } = parseArgs(['dispatch', '--dry-run', '--max', '2']);
  assert.equal(flags['dry-run'], true);
  assert.equal(flags.max, '2');
  assert.deepEqual(pos, ['dispatch']);
});

test('formatPromote (#209): every card the cascade touched is named, moved ones grouped by outcome', () => {
  const line = formatPromote([
    { number: 154, status: 'todo', from: 'triage' },
    { number: 155, status: 'todo', from: 'triage' },
    { number: 158, status: 'todo', from: 'triage' },
    { number: 144, status: 'done', unchanged: true, skipped: true, reason: 'already done' },
  ]);
  assert.equal(line, '#154 #155 #158 → todo · #144 already done');
});

test('formatPromote: a forced leaf and a blocker skipped for a human read differently', () => {
  const line = formatPromote([
    { number: 20, status: 'ready', from: 'todo', forced: true },
    { number: 30, status: 'blocked', unchanged: true, skipped: true, reason: 'blocked — needs human' },
  ]);
  assert.equal(line, '#20 → ready (forced: blockers not done) · #30 blocked — needs human');
});
