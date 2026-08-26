import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseBodyBlock, serializeBodyBlock, DEFAULT_KB, statusOf, agentOf, boardOf,
  parseRunComment, serializeRunComment, emptyRun, openAttempt, parseResultComment, serializeResultComment,
  blockerDone, computeReady, pathsOverlap, sortForDispatch, slugify, lockRef, lockRefPath, hashReason,
} from '../src/model.js';

test('body block: round trip and defaults', () => {
  const kb = { ...DEFAULT_KB, priority: 3, paths: ['apps/web/'] };
  const body = serializeBodyBlock(kb, 'Do the thing.\n\n- a\n- b');
  const { kb: back, rest } = parseBodyBlock(body);
  assert.equal(back.priority, 3);
  assert.deepEqual(back.paths, ['apps/web/']);
  assert.equal(rest, 'Do the thing.\n\n- a\n- b');
});

test('body block: missing or malformed never throws', () => {
  assert.deepEqual(parseBodyBlock('plain body').kb, { ...DEFAULT_KB });
  assert.equal(parseBodyBlock('plain body').rest, 'plain body');
  const bad = parseBodyBlock('<!-- kb: {not json} -->\nhello');
  assert.equal(bad.kb._malformed, true);
  assert.equal(bad.kb.max_retries, DEFAULT_KB.max_retries);
  assert.equal(bad.rest, 'hello');
  assert.deepEqual(parseBodyBlock(null).kb, { ...DEFAULT_KB });
});

test('labels → status/agent/board', () => {
  const labels = ['bug', 'kb:status:ready', 'kb:agent:claude', 'kb:board:default'];
  assert.equal(statusOf(labels), 'ready');
  assert.equal(agentOf(labels), 'claude');
  assert.equal(boardOf(labels), 'default');
  assert.equal(statusOf(['bug']), null);
});

test('run comment: round trip keeps attempts and counters', () => {
  const run = emptyRun();
  run.attempts.push({ attempt: 1, profile: 'claude', host: 'wsl', started_at: '2026-08-26T10:00:00Z', ended_at: '2026-08-26T10:20:00Z', outcome: 'crashed' });
  run.attempts.push({ attempt: 2, profile: 'claude', host: 'wsl', started_at: '2026-08-26T10:21:00Z' });
  run.failures = 1;
  run.block_loops = { abc: 2 };
  const text = serializeRunComment(run);
  assert.ok(text.startsWith('<!-- kb-run -->'));
  const back = parseRunComment(text);
  assert.equal(back.failures, 1);
  assert.equal(back.attempts.length, 2);
  assert.equal(openAttempt(back).attempt, 2);
  assert.deepEqual(back.block_loops, { abc: 2 });
  assert.equal(parseRunComment('random comment'), null);
});

test('result comment: round trip', () => {
  const res = { kind: 'result', attempt: 1, summary: 'Added auth schema', metadata: { changed_files: ['a.ts'], verification: ['npm test'] }, artifacts: [] };
  const back = parseResultComment(serializeResultComment(res));
  assert.equal(back.summary, 'Added auth schema');
  assert.deepEqual(back.metadata.changed_files, ['a.ts']);
});

test('readiness: all blockers must be closed as completed', () => {
  const t = (blockedBy, kb = {}) => ({ blockedBy, kb: { ...DEFAULT_KB, ...kb } });
  assert.equal(computeReady(t([])), true);
  assert.equal(computeReady(t([{ state: 'CLOSED', stateReason: 'COMPLETED' }])), true);
  assert.equal(computeReady(t([{ state: 'OPEN' }])), false);
  assert.equal(computeReady(t([{ state: 'CLOSED', stateReason: 'NOT_PLANNED' }])), false);
  assert.equal(computeReady(t([{ state: 'CLOSED', stateReason: 'COMPLETED' }, { state: 'OPEN' }])), false);
  assert.equal(blockerDone({ state: 'closed', state_reason: 'completed' }), true);
  const future = new Date(Date.now() + 3600_000).toISOString();
  assert.equal(computeReady(t([], { scheduled_at: future })), false);
  assert.equal(computeReady(t([], { scheduled_at: '2020-01-01T00:00:00Z' })), true);
});

test('path overlap guard', () => {
  assert.equal(pathsOverlap(['apps/web/'], ['apps/web/src/']), true);
  assert.equal(pathsOverlap(['apps/web/**'], ['apps/web']), true);
  assert.equal(pathsOverlap(['packages/md3/'], ['packages/db/']), false);
  assert.equal(pathsOverlap([], ['x']), false);
  assert.equal(pathsOverlap([''], ['x']), true);
});

test('dispatch order: priority desc, then oldest', () => {
  const tasks = [
    { number: 5, kb: { priority: 0 } }, { number: 3, kb: { priority: 2 } }, { number: 4, kb: { priority: 2 } }, { number: 9, kb: {} },
  ];
  assert.deepEqual(sortForDispatch(tasks).map((t) => t.number), [3, 4, 5, 9]);
});

test('misc helpers', () => {
  assert.equal(slugify('Implement auth API endpoints!'), 'implement-auth-api-endpoints');
  assert.equal(lockRef(12, 3), 'refs/kb/locks/12/3');
  assert.equal(lockRefPath(12, 3), 'kb/locks/12/3');
  assert.equal(hashReason('Missing  AWS creds'), hashReason('missing aws creds'));
  assert.notEqual(hashReason('a'), hashReason('b'));
});
