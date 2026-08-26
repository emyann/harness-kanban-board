import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs } from '../src/cli.js';

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
