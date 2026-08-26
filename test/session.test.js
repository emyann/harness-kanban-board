import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSessionLog, sessionUpdate, formatSession, resumeCommand, worktreePath } from '../src/model.js';

const RESULT = {
  type: 'result',
  subtype: 'success',
  is_error: false,
  duration_ms: 372_480,
  duration_api_ms: 351_002,
  num_turns: 37,
  result: 'Done: recorded session_id and cost on the attempt row.',
  session_id: '1f0c4c1e-9c0b-4d7f-8a21-2b7e5c9a3d10',
  total_cost_usd: 0.4231,
  usage: { input_tokens: 12, output_tokens: 3400 },
};

const header = '# 2026-08-26T06:43:37.343Z spawn claude for #18 attempt 2\n';

test('parseSessionLog: the single JSON line `claude -p --output-format json` signs off with', () => {
  const log = header + JSON.stringify(RESULT) + '\n';
  assert.deepEqual(parseSessionLog(log), {
    session_id: RESULT.session_id,
    total_cost_usd: 0.4231,
    num_turns: 37,
    duration_ms: 372_480,
  });
});

test('parseSessionLog: stream-json — the last line wins, earlier events are skipped', () => {
  const log = [
    header.trim(),
    JSON.stringify({ type: 'system', subtype: 'init', session_id: 'earlier-id' }),
    JSON.stringify({ type: 'assistant', message: { content: 'working' } }),
    JSON.stringify(RESULT),
  ].join('\n') + '\n';
  assert.equal(parseSessionLog(log).session_id, RESULT.session_id);
  assert.equal(parseSessionLog(log).num_turns, 37);
});

test('parseSessionLog: pretty-printed JSON spanning several lines', () => {
  const log = header + JSON.stringify(RESULT, null, 2) + '\n';
  assert.equal(parseSessionLog(log).total_cost_usd, 0.4231);
});

test('parseSessionLog: a log with only some of the fields yields only those', () => {
  const log = header + JSON.stringify({ type: 'result', session_id: 'abc' }) + '\n';
  assert.deepEqual(parseSessionLog(log), { session_id: 'abc' });
});

test('parseSessionLog: never throws, returns null when there is nothing to read', () => {
  assert.equal(parseSessionLog(''), null);
  assert.equal(parseSessionLog(null), null);
  assert.equal(parseSessionLog(undefined), null);
  assert.equal(parseSessionLog(header + 'Error: claude: command not found\n'), null);
  // a tail that cut the object in half must not be mistaken for a result
  assert.equal(parseSessionLog('_id":"abc","total_cost_usd":0.42}\n'), null);
  // JSON without any session field
  assert.equal(parseSessionLog(JSON.stringify({ type: 'result', is_error: true })), null);
  // NaN/Infinity can't survive JSON, but a hand-built object must not slip through either
  assert.equal(parseSessionLog(JSON.stringify({ total_cost_usd: null, session_id: '' })), null);
});

test('sessionUpdate: records once — the second call is a no-op', () => {
  const a = { attempt: 2, profile: 'claude' };
  const first = sessionUpdate(a, { session_id: 'sid', transcript_path: '/t/sid.jsonl', stop_hook_active: true });
  assert.deepEqual(first, { session_id: 'sid', transcript_path: '/t/sid.jsonl' });
  Object.assign(a, first);
  assert.equal(sessionUpdate(a, { session_id: 'sid', transcript_path: '/t/sid.jsonl' }), null);
});

test('sessionUpdate: only what is new — the dispatcher adds cost to a row that has the id', () => {
  const a = { attempt: 2, session_id: 'sid', transcript_path: '/t/sid.jsonl' };
  assert.deepEqual(sessionUpdate(a, { session_id: 'sid', total_cost_usd: 0.42, num_turns: 37 }), {
    total_cost_usd: 0.42, num_turns: 37,
  });
});

test('sessionUpdate: nothing to record', () => {
  assert.equal(sessionUpdate({}, null), null);
  assert.equal(sessionUpdate({}, {}), null);
  assert.equal(sessionUpdate({}, { cwd: '/repo', hook_event_name: 'Stop' }), null);
  assert.equal(sessionUpdate(null, { session_id: 'sid' }).session_id, 'sid'); // no row yet → all of it
});

test('formatSession: one line per attempt, only what is known', () => {
  assert.equal(formatSession({ session_id: 'sid', total_cost_usd: 0.4231, num_turns: 37, duration_ms: 372_480 }),
    'session sid · $0.42 · 37 turns · 6m12s');
  assert.equal(formatSession({ session_id: 'sid' }), 'session sid');
  assert.equal(formatSession({ total_cost_usd: 0.0034, duration_ms: 4200 }), '$0.0034 · 4s');
  assert.equal(formatSession({ attempt: 1, profile: 'claude' }), '');
  assert.equal(formatSession(null), '');
});

test('resumeCommand: reopens the session in the worker worktree', () => {
  assert.equal(resumeCommand({ attempt: 2, session_id: 'sid', wt: 'kb-18-2' }, 18),
    'cd .claude/worktrees/kb-18-2 && claude --resume sid');
  // no wt on the row (process mode): the worktree name is derived from the task and attempt
  assert.equal(resumeCommand({ attempt: 2, session_id: 'sid' }, 18),
    'cd .claude/worktrees/kb-18-2 && claude --resume sid');
  assert.equal(resumeCommand({ attempt: 2, session_id: 'sid' }), 'claude --resume sid');
  assert.equal(resumeCommand({ attempt: 2 }, 18), null);
  assert.equal(resumeCommand(null, 18), null);
  assert.equal(worktreePath('kb-18-2'), '.claude/worktrees/kb-18-2');
});
