import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseBodyBlock, serializeBodyBlock, DEFAULT_KB, statusOf, agentOf, boardOf,
  parseRunComment, serializeRunComment, emptyRun, openAttempt, parseResultComment, serializeResultComment,
  blockerDone, computeReady, pathsOverlap, sortForDispatch, slugify, lockRef, lockRefPath, hashReason,
  normalizeHookInput, stripFrontmatter, sessionUpdate, parseRepoSpecs, boardKey, uniqueKeys, deadAtRecheck,
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
  assert.equal(pathsOverlap(['packages/ui/'], ['packages/db/']), false);
  assert.equal(pathsOverlap([], ['x']), false);
  assert.equal(pathsOverlap([''], ['x']), true);
});

test('deadAtRecheck: a child dead at the recheck reports a failed entry, not a started one', () => {
  const r = deadAtRecheck('serve', 4242, '.kanban/logs/serve.log');
  assert.equal(r.line, 'serve exited immediately (pid 4242) — see .kanban/logs/serve.log');
  assert.deepEqual(r.failed, { name: 'serve', pid: 4242, log: '.kanban/logs/serve.log' });
});

test('dispatch order: priority desc, then oldest', () => {
  const tasks = [
    { number: 5, kb: { priority: 0 } }, { number: 3, kb: { priority: 2 } }, { number: 4, kb: { priority: 2 } }, { number: 9, kb: {} },
  ];
  assert.deepEqual(sortForDispatch(tasks).map((t) => t.number), [3, 4, 5, 9]);
});

test('stop-hook payload: Copilot camelCase folds onto Claude snake_case', () => {
  const copilot = normalizeHookInput({ sessionId: 'abc', transcriptPath: '/t.jsonl', hookEventName: 'agentStop', stopHookActive: true });
  assert.equal(copilot.session_id, 'abc');
  assert.equal(copilot.transcript_path, '/t.jsonl');
  assert.equal(copilot.hook_event_name, 'agentStop');
  assert.equal(copilot.stop_hook_active, true);
  // and the normalised payload feeds the same attempt-row writer
  assert.deepEqual(sessionUpdate({}, copilot), { session_id: 'abc', transcript_path: '/t.jsonl' });
});

test('stop-hook payload: Claude snake_case passes through, and wins over an alias', () => {
  const claude = { session_id: 'x', transcript_path: '/t', stop_hook_active: false, total_cost_usd: 0.4, extra: 1 };
  assert.deepEqual(normalizeHookInput(claude), claude);
  assert.equal(normalizeHookInput({ session_id: 'real', sessionId: 'alias' }).session_id, 'real');
});

test('stop-hook payload: junk is an empty object, never a throw', () => {
  for (const v of [null, undefined, 'string', 42, []]) assert.deepEqual(normalizeHookInput(v), {});
  assert.deepEqual(normalizeHookInput({}), {});
});

test('stripFrontmatter returns the document, front matter or not', () => {
  assert.equal(stripFrontmatter('---\nname: k\n---\n\n# Title\n\nbody\n'), '# Title\n\nbody\n');
  assert.equal(stripFrontmatter('# Title\n'), '# Title\n');
  assert.equal(stripFrontmatter('---\r\nname: k\r\n---\r\n# Title\n'), '# Title\n');
  assert.equal(stripFrontmatter(''), '');
  assert.equal(stripFrontmatter(null), '');
  // a --- rule inside the body is not a second front matter block
  assert.equal(stripFrontmatter('---\na: 1\n---\nx\n\n---\n\ny\n'), 'x\n\n---\n\ny\n');
});

test('--repos parses paths, and #slug picks a board inside a checkout', () => {
  assert.deepEqual(parseRepoSpecs('../a, ../b#release ,'), [
    { path: '../a', board: null },
    { path: '../b', board: 'release' },
  ]);
  assert.deepEqual(parseRepoSpecs(''), []);
  assert.deepEqual(parseRepoSpecs(undefined), []);
  // a trailing "#" is not a board, and a leading one is part of the path, not a separator
  assert.deepEqual(parseRepoSpecs('/tmp/a#'), [{ path: '/tmp/a', board: null }]);
  assert.deepEqual(parseRepoSpecs('#weird'), [{ path: '#weird', board: null }]);
  // the user-level list may spell an entry out as an object
  assert.deepEqual(parseRepoSpecs([{ path: '~/code/a', board: 'release' }, '~/code/b']), [
    { path: '~/code/a', board: 'release' },
    { path: '~/code/b', board: null },
  ]);
});

test('board keys are URL-safe, legible and never shared by two boards', () => {
  assert.equal(boardKey('emyann/harness-kanban-board', 'default'), 'emyann~harness-kanban-board~default');
  assert.equal(boardKey('o/r', 'a b/c'), 'o~r~a~b~c');
  assert.match(boardKey('o/r', 'default'), /^[A-Za-z0-9._~-]+$/);
  assert.deepEqual(uniqueKeys(['a', 'b', 'a', 'a']), ['a', 'b', 'a~2', 'a~3']);
  assert.deepEqual(uniqueKeys(['a', 'a~2', 'a']), ['a', 'a~2', 'a~3']);
});

test('misc helpers', () => {
  assert.equal(slugify('Implement auth API endpoints!'), 'implement-auth-api-endpoints');
  assert.equal(lockRef(12, 3), 'refs/kb/locks/12/3');
  assert.equal(lockRefPath(12, 3), 'kb/locks/12/3');
  assert.equal(hashReason('Missing  AWS creds'), hashReason('missing aws creds'));
  assert.notEqual(hashReason('a'), hashReason('b'));
});
