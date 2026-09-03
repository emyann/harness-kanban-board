// `hkb stats`: the window, the attempt roll-up, the spend coverage — and the read budget.
// The pure functions are exercised directly; the command runs against the in-memory GitHub
// (test/fake-gh.js), where "nothing was written" is something a test can assert.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_BOARD } from '../src/board.js';
import { STATUSES, OUTCOMES } from '../src/model.js';
import {
  parseSince, tasksInWindow, collectAttempts, summarizeTasks, summarizeAttempts, summarizeSpend,
  spawnBudget, computeStats, formatStats, sessionFromLog, stats, DEFAULT_SINCE,
  parseTranscriptUsage, ratesFor, estimateCost, usageFromTranscript,
  parseTranscriptDenials, deniedToolsFromTranscript, transcriptMcpServers, mcpServersFromTranscript, summarizeDeniedTools,
} from '../src/stats.js';
import { FakeGh } from './fake-gh.js';
import { FakeStore, kbIssue, runWith } from './fake-store.js';

const NOW = new Date('2026-08-26T12:00:00.000Z');
const ago = (ms, from = NOW) => new Date(from.getTime() - ms).toISOString();
const minutes = (n) => n * 60_000;
const hours = (n) => n * 3_600_000;
const days = (n) => n * 86_400_000;

const task = (number, over = {}) => ({ number, status: 'ready', state: 'OPEN', needsHuman: false, updatedAt: ago(hours(1)), ...over });

// ---------- the window ----------

test('parseSince reads spans, dates and "all"', () => {
  assert.equal(parseSince(undefined, NOW).window, DEFAULT_SINCE);
  assert.equal(parseSince(undefined, NOW).since, ago(days(7)));
  assert.deepEqual(parseSince('90m', NOW), { since: ago(minutes(90)), window: '90m' });
  assert.deepEqual(parseSince('36h', NOW), { since: ago(hours(36)), window: '36h' });
  assert.deepEqual(parseSince('2w', NOW), { since: ago(days(14)), window: '2w' });
  assert.deepEqual(parseSince('all', NOW), { since: null, window: 'all' });
  assert.equal(parseSince('2026-08-01', NOW).since, '2026-08-01T00:00:00.000Z');
  assert.equal(parseSince('2026-08-01T06:30:00Z', NOW).since, '2026-08-01T06:30:00.000Z');
});

test('parseSince names the fix when it cannot read the value', () => {
  assert.throws(() => parseSince(true, NOW), (e) => e.exitCode === 2 && /--since needs a value/.test(e.message));
  assert.throws(() => parseSince('last tuesday', NOW), (e) => e.exitCode === 2 && /7d, 36h, 90m, 2w/.test(e.message));
  assert.throws(() => parseSince('0d', NOW), (e) => e.exitCode === 2 && /zero-length/.test(e.message));
});

test('the window keeps what has news — plus every running task, whose heartbeat is silent', () => {
  const tasks = [
    task(1, { updatedAt: ago(minutes(10)) }),
    task(2, { updatedAt: ago(days(30)) }),
    task(3, { status: 'running', updatedAt: ago(days(30)) }),
    task(4, { updatedAt: null }),
  ];
  assert.deepEqual(tasksInWindow(tasks, ago(days(7))).map((t) => t.number), [1, 3]);
  assert.deepEqual(tasksInWindow(tasks, null).map((t) => t.number), [1, 2, 3, 4]);
});

// ---------- attempts ----------

const runs = (map) => new Map(Object.entries(map).map(([n, run]) => [Number(n), run]));

test('an ended attempt is in the window when it ended inside it; an open one always is', () => {
  const rows = collectAttempts([task(7)], runs({
    7: runWith([
      { attempt: 1, started_at: ago(days(30)), ended_at: ago(days(29)), outcome: 'completed' }, // long gone
      { attempt: 2, started_at: ago(days(9)), ended_at: ago(days(2)), outcome: 'completed' }, // started before, ended inside
      { attempt: 3, started_at: ago(days(30)) }, // still open: its start is old but it is happening now
      { attempt: 4, started_at: 'not a date' },
    ]),
  }), ago(days(7)));
  assert.deepEqual(rows.map((r) => r.attempt), [2, 3]);
  assert.equal(rows[0].duration_ms, days(7));
  assert.equal(rows[0].outcome, 'completed');
  assert.equal(rows[1].outcome, null, 'an open attempt has no outcome yet');
  assert.equal(rows[1].duration_ms, null);
});

test('collectAttempts takes the cost off the row, then off the worker log', () => {
  const rows = collectAttempts([task(7)], runs({
    7: runWith([
      { attempt: 1, started_at: ago(hours(2)), ended_at: ago(hours(1)), outcome: 'completed', total_cost_usd: 0.5, num_turns: 12 },
      { attempt: 2, started_at: ago(hours(2)), ended_at: ago(hours(1)), outcome: 'protocol_violation', log: '.kanban/logs/7-2.log' },
      { attempt: 3, started_at: ago(minutes(5)), log: '.kanban/logs/7-3.log' },
    ]),
  }), null, { cost: (a) => (a.log === '.kanban/logs/7-2.log' ? { total_cost_usd: 0.25, num_turns: 7 } : null) });
  assert.deepEqual(rows.map((r) => [r.cost_usd, r.cost_source]), [[0.5, 'run_record'], [0.25, 'worker_log'], [null, null]]);
  assert.equal(rows[1].num_turns, 7);
});

test('collectAttempts falls through row → log → transcript, and reads each source only when it must', () => {
  const seen = { log: [], transcript: [] };
  const usage = (turns, input, output) => ({ turns, input_tokens: input, output_tokens: output, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, by_model: { 'claude-opus-5': { turns, input_tokens: input, output_tokens: output, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } });
  const rows = collectAttempts([task(7)], runs({
    7: runWith([
      { attempt: 1, started_at: ago(hours(2)), ended_at: ago(hours(1)), outcome: 'completed', total_cost_usd: 0.5, num_turns: 12, log: 'a.log', transcript_path: '/t/a.jsonl' },
      { attempt: 2, started_at: ago(hours(2)), ended_at: ago(hours(1)), outcome: 'completed', log: 'b.log', transcript_path: '/t/b.jsonl' },
      { attempt: 3, started_at: ago(hours(2)), ended_at: ago(hours(1)), outcome: 'completed', log: 'c.log', transcript_path: '/t/c.jsonl' },
      { attempt: 4, started_at: ago(hours(2)), ended_at: ago(hours(1)), outcome: 'crashed', log: 'd.log' },
      { attempt: 5, started_at: ago(minutes(5)), transcript_path: '/t/e.jsonl' },
    ]),
  }), null, {
    cost: (a) => { seen.log.push(a.attempt); return a.attempt === 2 ? { total_cost_usd: 0.25, num_turns: 7 } : null; },
    usage: (a) => { seen.transcript.push(a.attempt); return a.attempt === 4 ? null : usage(9, 1000, 2000); },
    rates: { 'claude-opus-5': { input: 5, output: 25, cache_write: 0, cache_read: 0 } },
  });

  assert.deepEqual(rows.map((r) => r.cost_source), ['run_record', 'worker_log', 'estimate', null, null]);
  assert.equal(rows[2].cost_usd, 0.055, 'the transcript priced at the board rates: (1000·$5 + 2000·$25) per Mtok');
  assert.equal(rows[2].usage.turns, 9);
  assert.equal(rows[0].usage, null, 'a row that already has a price does not open a transcript');
  assert.equal(rows[3].usage, null, 'nothing anywhere: no cost, no tokens');
  assert.deepEqual(seen.log, [2, 3, 4], 'the log is skipped for a row that already has a cost, and for one still running');
  assert.deepEqual(seen.transcript, [3, 4], 'the transcript is the last resort, and never read for a running attempt');
});

test('with no rates the transcript still answers with turns and tokens, and no dollars', () => {
  const rows = collectAttempts([task(7)], runs({
    7: runWith([{ attempt: 1, started_at: ago(hours(2)), ended_at: ago(hours(1)), outcome: 'completed', transcript_path: '/t/a.jsonl' }]),
  }), null, {
    usage: () => ({ turns: 4, input_tokens: 10, output_tokens: 20, cache_creation_input_tokens: 30, cache_read_input_tokens: 40, by_model: { 'claude-opus-5': { turns: 4, input_tokens: 10, output_tokens: 20, cache_creation_input_tokens: 30, cache_read_input_tokens: 40 } } }),
  });
  assert.equal(rows[0].cost_usd, null);
  assert.equal(rows[0].cost_source, null);
  assert.equal(rows[0].usage.turns, 4);
  const s = summarizeSpend(rows);
  assert.equal(s.basis, 'usage');
  assert.equal(s.attempts_with_usage, 1);
  assert.equal(s.attempts_missing_cost, 0, 'tokens are not nothing — this attempt is not in the "recorded nothing" bucket');
  assert.deepEqual(s.usage, { turns: 4, input_tokens: 10, output_tokens: 20, cache_creation_input_tokens: 30, cache_read_input_tokens: 40 });
});

// A `claude-track` runner claims every node of its subgraph from inside the session already running,
// so the root's attempt row and all of its nodes' rows name the SAME transcript. One session, one
// bill — priced per row, a track of three would report three times what it spent.

const oneSession = () => ({
  turns: 100, input_tokens: 1000, output_tokens: 2000, cache_creation_input_tokens: 4000, cache_read_input_tokens: 8000,
  by_model: { 'claude-opus-5': { turns: 100, input_tokens: 1000, output_tokens: 2000, cache_creation_input_tokens: 4000, cache_read_input_tokens: 8000 } },
});
const OPUS_RATES = { 'claude-opus-5': { input: 5, output: 25, cache_write: 6.25, cache_read: 0.5 } };
// (1000·$5 + 2000·$25 + 4000·$6.25 + 8000·$0.50) per Mtok — what one of those sessions estimates at
const ONE_SESSION_USD = 0.084;

const node = (n, transcript, over = {}) => [n, runWith([{
  attempt: 1, profile: 'claude-track', started_at: ago(hours(3)), ended_at: ago(hours(1)),
  outcome: 'completed', session_id: 's-track', transcript_path: transcript, ...over,
}])];

const trackBoard = () => ({
  tasks: [task(10), task(11), task(12), task(13)],
  runs: runs(Object.fromEntries([
    node(10, '/t/track.jsonl'), // the root, and the session everything below it ran in
    node(11, '/t/track.jsonl'),
    node(12, '/t/track.jsonl'),
    node(13, '/t/cold.jsonl', { session_id: 's-cold' }), // a node the dispatcher started by itself
  ])),
});

test("a track's one transcript is read once and counted once, however many nodes name it", () => {
  const board = trackBoard();
  const reads = [];
  const rows = collectAttempts(board.tasks, board.runs, null, {
    usage: (a) => { reads.push(a.transcript_path); return oneSession(); },
    rates: OPUS_RATES,
  });

  assert.deepEqual(reads, ['/t/track.jsonl', '/t/cold.jsonl'], 'the largest file hkb opens is opened once, not once per node');
  assert.deepEqual(rows.map((r) => r.cost_source), ['estimate', null, null, 'estimate']);
  assert.equal(rows[0].usage.turns, 100);
  assert.equal(rows[1].usage, null, "a node's tokens are on the row that carries the session, not on this one");
  assert.equal(rows[1].num_turns, null, 'and neither are its turns, which would double the same way');
  assert.deepEqual(rows.map((r) => r.session.counted), [true, false, false, true]);
  assert.deepEqual(rows.map((r) => r.session.attempts), [3, 3, 3, 1], 'each row knows how wide the session it shares is');
  assert.equal(rows[0].session.id, 's-track');

  const s = summarizeSpend(rows);
  assert.equal(s.usage.turns, 200, 'two sessions of 100 turns — not the 400 that four rows naming them would be');
  assert.equal(s.estimated_usd, ONE_SESSION_USD * 2);
  assert.equal(s.attempts_estimated, 2);
  assert.equal(s.attempts_with_usage, 2);
  assert.equal(s.attempts_shared_session, 2);
  assert.equal(s.worker_attempts, 4, 'all four nodes ran, and all four still count as attempts');
  assert.equal(s.attempts_missing_cost, 0, 'a node counted on another row is not a hole in the coverage');
  assert.equal(s.by_profile['claude-track'].estimated_usd, ONE_SESSION_USD * 2);
});

test('the report says a shared session is counted once, so no one reads the total as nodes × session', () => {
  const text = formatStats(computeStats({
    board: 'default', now: NOW, ...trackBoard(), spawns: spawnBudget({}, null, NOW),
    usage: () => oneSession(), rates: OPUS_RATES,
  }));
  assert.match(text, /spend {6}~\$0\.17 ESTIMATED on 2 of 4 worker attempts/);
  assert.match(text, /usage {6}200 turns · in 2000 · out 4000 · cache 8000 written \/ 16k read {2}\(2 transcripts over 4 worker attempts\)/);
  assert.match(text, /2 worker attempts ran inside a session another attempt carries — counted once, there, not once per node/);
});

test('summarizeAttempts splits delivered from blocked from failed, and averages only real work', () => {
  const rows = collectAttempts([task(1), task(2)], runs({
    1: runWith([
      { attempt: 1, started_at: ago(minutes(30)), ended_at: ago(minutes(20)), outcome: 'completed' }, // 10m
      { attempt: 2, started_at: ago(minutes(20)), ended_at: ago(minutes(10)), outcome: 'crashed' }, // 10m
    ]),
    2: runWith([
      { attempt: 1, started_at: ago(minutes(60)), ended_at: ago(minutes(30)), outcome: 'review_requested' }, // 30m
      { attempt: 2, started_at: ago(minutes(10)), ended_at: ago(minutes(9)), outcome: 'blocked' }, // 1m
      { attempt: 3, started_at: ago(minutes(9)), ended_at: ago(minutes(9)), outcome: 'gave_up', synthetic: true },
      { attempt: 4, started_at: ago(minutes(1)) },
    ]),
  }), null);
  const a = summarizeAttempts(rows);
  assert.equal(a.total, 6);
  assert.equal(a.tasks, 2);
  assert.equal(a.ended, 5);
  assert.equal(a.active, 1);
  assert.deepEqual([a.delivered, a.blocked, a.failed], [2, 1, 2]);
  assert.equal(a.delivered_rate, 0.4);
  assert.equal(a.by_outcome.completed, 1);
  assert.equal(a.by_outcome.gave_up, 1);
  assert.equal(a.duration_ms.count, 4, 'the synthetic gave_up row is bookkeeping, not an attempt that ran');
  assert.equal(a.duration_ms.mean, minutes(51 / 4));
  assert.equal(a.duration_ms.median, minutes(10));
  assert.equal(a.duration_ms.max, minutes(30));
});

test('an empty window still answers with the full shape', () => {
  const a = summarizeAttempts([]);
  assert.equal(a.total, 0);
  assert.equal(a.delivered_rate, null);
  assert.deepEqual(Object.keys(a.by_outcome), OUTCOMES);
  assert.deepEqual(a.duration_ms, { count: 0, total: 0, mean: null, median: null, p90: null, max: null });
});

// ---------- spend ----------

test('spend is per profile, and says how much of it is guesswork-free', () => {
  const rows = collectAttempts([task(1), task(2)], runs({
    1: runWith([
      { attempt: 1, profile: 'claude', started_at: ago(hours(2)), ended_at: ago(hours(1)), outcome: 'completed', total_cost_usd: 1.5, num_turns: 20 },
      { attempt: 2, profile: 'claude', started_at: ago(hours(1)), ended_at: ago(minutes(30)), outcome: 'crashed', total_cost_usd: 0.5, num_turns: 4 },
    ]),
    2: runWith([
      { attempt: 1, profile: 'copilot-cli', started_at: ago(hours(3)), ended_at: ago(hours(2)), outcome: 'completed' },
      { attempt: 2, profile: 'claude', started_at: ago(minutes(5)) },
    ]),
  }), null);
  const s = summarizeSpend(rows);
  assert.equal(s.total_usd, 2);
  assert.equal(s.basis, 'reported');
  assert.equal(s.attempts_with_cost, 2);
  assert.equal(s.worker_attempts, 3, 'three attempts ended; the open one is not priceable yet');
  assert.equal(s.attempts_missing_cost, 1, 'the copilot attempt ended without a price; the open one is not counted');
  assert.deepEqual(s.sources, { run_record: 2, worker_log: 0, estimate: 0 });
  assert.deepEqual(s.by_profile.claude, { attempts: 3, with_cost: 2, total_usd: 2, mean_usd: 1, max_usd: 1.5, turns: 24, estimated: 0, estimated_usd: 0, usage: null });
  assert.deepEqual(s.by_profile['copilot-cli'], { attempts: 1, with_cost: 0, total_usd: 0, mean_usd: null, max_usd: null, turns: 0, estimated: 0, estimated_usd: 0, usage: null });
});

test('sessionFromLog reads the final JSON off a worker log, and shrugs at anything else', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hkb-stats-log-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, '.kanban/logs'), { recursive: true });
  fs.writeFileSync(path.join(root, '.kanban/logs/7-1.log'), [
    '# 2026-08-26T10:00:00Z spawn claude for #7 attempt 1',
    'some noise',
    JSON.stringify({ type: 'result', session_id: 'sess-7', total_cost_usd: 0.42, num_turns: 9, duration_ms: 61_000 }),
  ].join('\n'));
  fs.writeFileSync(path.join(root, '.kanban/logs/7-2.log'), 'backgrounded · abc123\n');

  assert.equal(sessionFromLog(root, { log: '.kanban/logs/7-1.log' }).total_cost_usd, 0.42);
  assert.equal(sessionFromLog(root, { log: '.kanban/logs/7-2.log' }), null);
  assert.equal(sessionFromLog(root, { log: '.kanban/logs/nope.log' }), null);
  assert.equal(sessionFromLog(root, {}), null);
});

// ---------- the transcript, read locally ----------

/** One assistant line of a Claude transcript. The same `id` twice is the same message, not two. */
const asst = (id, model, usage) => JSON.stringify({
  type: 'assistant', isSidechain: false, uuid: `${id}-${Math.random()}`,
  message: { id, model, type: 'message', role: 'assistant', content: [{ type: 'text', text: 'hi' }], usage },
});
const tokensOf = (input, output, write = 0, read = 0) => ({
  input_tokens: input, output_tokens: output, cache_creation_input_tokens: write, cache_read_input_tokens: read,
});

test('parseTranscriptUsage counts a message once, however many lines it spans, and keeps the models apart', () => {
  const u = parseTranscriptUsage([
    '{"type":"ai-title","aiTitle":"whatever"}',
    'not json at all',
    '',
    // one Opus message written as three lines — thinking, text, tool_use — each repeating its usage
    asst('msg_1', 'claude-opus-5', tokensOf(2, 500, 43_342, 0)),
    asst('msg_1', 'claude-opus-5', tokensOf(2, 500, 43_342, 0)),
    asst('msg_1', 'claude-opus-5', tokensOf(2, 500, 43_342, 0)),
    '{"type":"user","message":{"role":"user","content":[{"type":"tool_result","content":"the word usage appears here"}]}}',
    asst('msg_2', 'claude-opus-5', tokensOf(3, 300, 0, 43_342)),
    asst('msg_3', 'claude-haiku-4-5-20251001', tokensOf(10, 90, 0, 0)),
    '{"message":{"usage":null}}',
  ]);
  assert.equal(u.turns, 3, 'three messages, not the six lines that carried them');
  assert.equal(u.input_tokens, 15);
  assert.equal(u.output_tokens, 890);
  assert.equal(u.cache_creation_input_tokens, 43_342, 'the repeated lines of msg_1 are one cache write, not three');
  assert.equal(u.cache_read_input_tokens, 43_342);
  assert.deepEqual(Object.keys(u.by_model), ['claude-opus-5', 'claude-haiku-4-5-20251001']);
  assert.equal(u.by_model['claude-opus-5'].turns, 2);
  assert.deepEqual(u.by_model['claude-haiku-4-5-20251001'], { turns: 1, input_tokens: 10, output_tokens: 90, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 });
});

test('parseTranscriptUsage shrugs at a file that holds no usage', () => {
  assert.equal(parseTranscriptUsage([]), null);
  assert.equal(parseTranscriptUsage(['# 2026-08-28T01:29:42.943Z launch background agent for #103 attempt 1', 'backgrounded · dd1e06c1']), null);
  assert.equal(parseTranscriptUsage(['{"message":{"usage":{"input_tokens":1}}}, and then garbage']), null, 'a truncated line is skipped, not thrown on');
});

test('usageFromTranscript reads the attempt transcript off disk, and never fails loudly', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hkb-stats-tx-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'sess.jsonl');
  // a line wider than one read chunk, with a multi-byte character on the boundary, must survive
  fs.writeFileSync(file, [
    asst('msg_1', 'claude-opus-5', tokensOf(1, 2, 3, 4)),
    JSON.stringify({ type: 'user', message: { role: 'user', content: '→'.repeat(200_000) } }),
    asst('msg_2', 'claude-opus-5', tokensOf(10, 20, 30, 40)),
  ].join('\n') + '\n');

  assert.deepEqual(usageFromTranscript(root, { transcript_path: file }), {
    turns: 2, input_tokens: 11, output_tokens: 22, cache_creation_input_tokens: 33, cache_read_input_tokens: 44,
    by_model: { 'claude-opus-5': { turns: 2, input_tokens: 11, output_tokens: 22, cache_creation_input_tokens: 33, cache_read_input_tokens: 44 } },
  });
  assert.deepEqual(usageFromTranscript(root, { transcript_path: 'sess.jsonl' }).turns, 2, 'a relative path is resolved against the board root');
  assert.equal(usageFromTranscript(root, { transcript_path: path.join(root, 'gone.jsonl') }), null, 'a transcript from another host is simply absent');
  assert.equal(usageFromTranscript(root, { transcript_path: root }), null, 'a directory is not a transcript');
  assert.equal(usageFromTranscript(root, {}), null);
  assert.equal(usageFromTranscript(root, null), null);
});

// ---------- #130: the two denial shapes only a transcript carries ----------

/** One assistant `tool_use` line — the tool name a following `tool_result` only carries by id. */
const toolUse = (id, name, input = {}) => JSON.stringify({
  type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] },
});
/** One user `tool_result` line answering `id`, plain-string content. */
const toolResult = (id, text, timestamp) => JSON.stringify({
  type: 'user', timestamp, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: text, is_error: true }] },
});

test('parseTranscriptDenials: a dontAsk allowlist miss names the tool and the line\'s own timestamp', () => {
  const found = parseTranscriptDenials([
    toolUse('toolu_1', 'mcp__react-aria__Button'),
    toolResult('toolu_1', "Permission to use mcp__react-aria__Button has been denied because Claude Code is running in don't ask mode.", '2026-08-30T10:00:00.000Z'),
  ]);
  assert.deepEqual(found, [{ tool: 'mcp__react-aria__Button', kind: 'dontask-miss', first_seen: '2026-08-30T10:00:00.000Z' }]);
});

test('parseTranscriptDenials: the worktree guard is a tool ERROR, absent from permission_denials — names the tool_use that carries it', () => {
  const found = parseTranscriptDenials([
    toolUse('toolu_2', 'Bash', { command: 'hkb complete 130 --summary "done"' }),
    toolResult('toolu_2', "this command runs a string through complete, which can't be verified to stay inside the worktree", '2026-08-30T10:05:00.000Z'),
  ]);
  assert.deepEqual(found, [{ tool: 'Bash', kind: 'worktree-guard', first_seen: '2026-08-30T10:05:00.000Z' }]);
});

test('parseTranscriptDenials: a tool_result whose content is an array of text blocks is read the same way', () => {
  const found = parseTranscriptDenials([
    toolUse('toolu_3', 'WebFetch'),
    JSON.stringify({ type: 'user', timestamp: 't3', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_3', content: [{ type: 'text', text: "Permission to use WebFetch has been denied because Claude Code is running in don't ask mode." }] }] } }),
  ]);
  assert.deepEqual(found, [{ tool: 'WebFetch', kind: 'dontask-miss', first_seen: 't3' }]);
});

test('parseTranscriptDenials: shrugs at a transcript with neither shape, or nothing at all', () => {
  assert.equal(parseTranscriptDenials([]), null);
  assert.equal(parseTranscriptDenials([toolUse('t', 'Bash'), toolResult('t', 'ordinary tool output')]), null);
  assert.equal(parseTranscriptDenials(['{"message":{"content":[{"type":"tool_result"']), null, 'a truncated line is skipped, not thrown on');
});

test('deniedToolsFromTranscript reads the attempt transcript off disk, relative or absolute, and never fails loudly', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hkb-stats-denied-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'sess.jsonl');
  fs.writeFileSync(file, [
    toolUse('toolu_1', 'Skill'),
    toolResult('toolu_1', "Permission to use Skill has been denied because Claude Code is running in don't ask mode.", 't1'),
  ].join('\n') + '\n');
  assert.deepEqual(deniedToolsFromTranscript(root, file), [{ tool: 'Skill', kind: 'dontask-miss', first_seen: 't1' }]);
  assert.deepEqual(deniedToolsFromTranscript(root, 'sess.jsonl'), [{ tool: 'Skill', kind: 'dontask-miss', first_seen: 't1' }]);
  assert.equal(deniedToolsFromTranscript(root, path.join(root, 'gone.jsonl')), null);
  assert.equal(deniedToolsFromTranscript(root, null), null);
});

test('transcriptMcpServers: only mcp__<server>__ tool_use calls count, and each server once', () => {
  const servers = transcriptMcpServers([
    toolUse('a', 'mcp__react-aria__Button'),
    toolUse('b', 'mcp__react-aria__Dialog'),
    toolUse('c', 'mcp__playwright__navigate'),
    toolUse('d', 'Bash'),
  ]);
  assert.deepEqual([...servers].sort(), ['playwright', 'react-aria']);
  assert.deepEqual(transcriptMcpServers([]), new Set());
});

test('mcpServersFromTranscript reads off disk the same way deniedToolsFromTranscript does', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hkb-stats-mcp-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'sess.jsonl'), toolUse('a', 'mcp__react-aria__Button') + '\n');
  assert.deepEqual(mcpServersFromTranscript(root, 'sess.jsonl'), new Set(['react-aria']));
  assert.deepEqual(mcpServersFromTranscript(root, path.join(root, 'gone.jsonl')), new Set());
});

test('summarizeDeniedTools sums denied_tools across attempt rows, grouped by tool+kind, most-denied first', () => {
  const rows = [
    { denied_tools: [{ tool: 'Bash', kind: 'permission-rule', count: 2, first_seen: null }] },
    { denied_tools: [{ tool: 'mcp__react-aria__Button', kind: 'dontask-miss', count: 7, first_seen: 't1' }] },
    { denied_tools: null },
    { denied_tools: [{ tool: 'Bash', kind: 'permission-rule', count: 1, first_seen: null }] },
  ];
  assert.deepEqual(summarizeDeniedTools(rows), [
    { tool: 'mcp__react-aria__Button', kind: 'dontask-miss', count: 7, attempts: 1 },
    { tool: 'Bash', kind: 'permission-rule', count: 3, attempts: 2 },
  ]);
  assert.deepEqual(summarizeDeniedTools([]), []);
});

// ---------- pricing those tokens, when the board says what they cost ----------

test('ratesFor matches a model exactly, then by prefix, then "default" — and fills the cache rates in', () => {
  const rates = {
    'claude-opus-5': { input: 5, output: 25, cache_write: 10, cache_read: 1 },
    'claude-haiku': { input: 1, output: 5 },
    default: { input: 3, output: 15 },
  };
  assert.deepEqual(ratesFor(rates, 'claude-opus-5'), { input: 5, output: 25, cache_write: 10, cache_read: 1 });
  assert.deepEqual(ratesFor(rates, 'claude-haiku-4-5-20251001'), { input: 1, output: 5, cache_write: 1.25, cache_read: 0.1 });
  assert.equal(ratesFor(rates, 'gpt-5').input, 3, 'no key matched, so "default" priced it');
  assert.equal(ratesFor({ 'claude-opus-5': { input: 5 } }, 'claude-opus-5'), null, 'a rate without an output price is no rate');
  assert.equal(ratesFor(null, 'claude-opus-5'), null);
});

test('estimateCost prices every model in the session, or refuses to price any of it', () => {
  const usage = {
    by_model: {
      'claude-opus-5': { turns: 1, input_tokens: 1000, output_tokens: 2000, cache_creation_input_tokens: 4000, cache_read_input_tokens: 8000 },
    },
  };
  const rates = { 'claude-opus-5': { input: 5, output: 25, cache_write: 10, cache_read: 1 } };
  assert.equal(estimateCost(usage, rates), 0.103); // (5 + 50 + 40 + 8) thousandths of a dollar
  usage.by_model['claude-haiku-4-5'] = { turns: 1, input_tokens: 10, output_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
  assert.equal(estimateCost(usage, rates), null, 'half a session priced is a wrong number, not a low one');
  assert.equal(estimateCost(usage, null), null);
  assert.equal(estimateCost(null, rates), null);
});

test('estimateCost ignores a model that spent nothing — an interrupted turn must not cost the estimate', () => {
  // Claude Code files an aborted turn under the model `<synthetic>`, every counter at zero
  const usage = {
    by_model: {
      'claude-opus-5': { turns: 2, input_tokens: 1000, output_tokens: 2000, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      '<synthetic>': { turns: 1, input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    },
  };
  assert.equal(estimateCost(usage, { 'claude-opus-5': { input: 5, output: 25 } }), 0.055);
});

// ---------- spawns ----------

test('spawns today comes from the dispatcher state, and a stale day reads as zero', () => {
  assert.deepEqual(spawnBudget({ spawn_day: '2026-08-26', spawned_today: 12 }, 40, NOW), { day: '2026-08-26', today: 12, cap: 40, remaining: 28, at_cap: false, known: true });
  assert.deepEqual(spawnBudget({ spawn_day: '2026-08-25', spawned_today: 40 }, 40, NOW), { day: '2026-08-26', today: 0, cap: 40, remaining: 40, at_cap: false, known: true });
  assert.equal(spawnBudget({ spawn_day: '2026-08-26', spawned_today: 40 }, 40, NOW).at_cap, true);
  assert.deepEqual(spawnBudget({}, null, NOW), { day: '2026-08-26', today: 0, cap: null, remaining: null, at_cap: false, known: true });
  assert.equal(spawnBudget(null, 40, NOW).known, false, 'a checkout that never ran a tick knows nothing, it is not at zero');
});

test('a checkout with no dispatcher state says so instead of reporting zero spawns', () => {
  const text = formatStats(computeStats({ board: 'default', now: NOW, spawns: spawnBudget(null, 40, NOW) }));
  assert.match(text, /spawns {5}unknown here · cap 40 — no dispatcher state in this checkout/);
});

// ---------- the whole report ----------

const report = () => computeStats({
  board: 'default',
  repo: 'acme/board',
  now: NOW,
  since: ago(days(7)),
  window: '7d',
  spawns: spawnBudget({ spawn_day: '2026-08-26', spawned_today: 3 }, 40, NOW),
  tasks: [
    task(1, { status: 'done', state: 'CLOSED' }),
    task(2, { status: 'running' }),
    task(3, { status: 'ready', needsHuman: true }),
  ],
  runs: runs({
    1: runWith([{ attempt: 1, started_at: ago(hours(3)), ended_at: ago(hours(2)), outcome: 'completed', total_cost_usd: 1.25, num_turns: 30 }]),
    2: runWith([{ attempt: 1, started_at: ago(minutes(20)) }]),
    3: runWith([]),
  }),
});

test('computeStats answers with a stable shape a script can rely on', () => {
  const s = report();
  assert.deepEqual(Object.keys(s), ['board', 'repo', 'generated_at', 'since', 'window', 'tasks', 'attempts', 'spawns', 'spend', 'denied_tools', 'reads']);
  assert.deepEqual(Object.keys(s.tasks.by_status), STATUSES);
  assert.deepEqual(Object.keys(s.attempts.by_outcome), OUTCOMES);
  assert.equal(s.tasks.total, 3);
  assert.equal(s.tasks.open, 2);
  assert.equal(s.tasks.needs_human, 1);
  assert.equal(s.tasks.by_status.done, 1);
  assert.equal(s.attempts.total, 2);
  assert.equal(s.attempts.active, 1);
  assert.equal(s.attempts.duration_ms.mean, hours(1));
  assert.equal(s.spend.total_usd, 1.25);
  assert.equal(s.spawns.remaining, 37);
  assert.deepEqual(s.reads, { board: 1, run_comments: 3 });
});

test('the human report is one line per thing, and says what it does not know', () => {
  const text = formatStats(report());
  assert.match(text, /board "default" · acme\/board · window 7d/);
  assert.match(text, /tasks {6}3 \(2 open, 1 needs-human\)/);
  assert.match(text, /ready 1 · running 1 · done 1/);
  assert.match(text, /attempts {3}2 over 2 tasks · 1 ended · 1 active/);
  assert.match(text, /duration {3}mean 1h00m/);
  assert.match(text, /spawns {5}3 \/ 40 today · 37 left/);
  assert.match(text, /spend {6}\$1\.25 reported · on 1 of 1 worker attempt/);
  assert.match(text, /claude {7}\s+\$1\.25 · 1 attempt · mean \$1\.25 · max \$1\.25 · 30 turns/);
  assert.match(text, /read 1 board query \+ 3 run records; nothing was written\./);
});

test('a board with nothing recorded still reports, and points at why there is no spend', () => {
  const text = formatStats(computeStats({
    board: 'default', now: NOW, since: ago(days(7)), window: '7d',
    tasks: [task(1, { status: 'todo' })],
    runs: runs({ 1: runWith([{ attempt: 1, started_at: ago(hours(4)), ended_at: ago(hours(3)), outcome: 'crashed' }]) }),
    spawns: spawnBudget({}, 40, NOW),
  }));
  assert.match(text, /spend {6}not recorded on any of the 1 worker attempt — only a harness whose log/);
  assert.doesNotMatch(text, /^usage/m, 'no transcript, no usage line');
  assert.match(text, /spawns {5}0 \/ 40 today/);
});

// One board, three answers. The report must never let a reader mistake which one it is reading.

const bgBoard = ({ rates = null, reported = false } = {}) => computeStats({
  board: 'default', now: NOW, since: ago(days(7)), window: '7d',
  tasks: [task(1, { status: 'done' }), task(2, { status: 'done' })],
  runs: runs({
    1: runWith([{ attempt: 1, started_at: ago(hours(4)), ended_at: ago(hours(3)), outcome: 'completed', transcript_path: '/t/1.jsonl' }]),
    2: runWith([{ attempt: 1, started_at: ago(hours(2)), ended_at: ago(hours(1)), outcome: 'completed', ...(reported ? { total_cost_usd: 1.5, num_turns: 30 } : { transcript_path: '/t/2.jsonl' }) }]),
  }),
  spawns: spawnBudget({}, 40, NOW),
  usage: () => ({ turns: 21, input_tokens: 900, output_tokens: 12_500, cache_creation_input_tokens: 240_000, cache_read_input_tokens: 4_100_000, by_model: { 'claude-opus-5': { turns: 21, input_tokens: 900, output_tokens: 12_500, cache_creation_input_tokens: 240_000, cache_read_input_tokens: 4_100_000 } } }),
  rates,
});

test('raw usage: a claude-bg board reports turns and tokens where it used to report nothing', () => {
  const s = bgBoard();
  assert.equal(s.spend.basis, 'usage');
  assert.equal(s.spend.total_usd, 0);
  assert.equal(s.spend.attempts_with_usage, 2);
  assert.equal(s.spend.usage.turns, 42);
  const text = formatStats(s);
  assert.match(text, /spend {6}no cost reported on any of the 2 worker attempts — only a harness whose log ends in Claude's final JSON reports one/);
  assert.match(text, /usage {6}42 turns · in 1800 · out 25k · cache 480k written \/ 8\.2M read {2}\(2 transcripts\)/);
  assert.match(text, /no price: put `"stats": \{"rates"/, 'and it says how to turn those tokens into an estimate');
  assert.doesNotMatch(text, /\$\d/, 'not one dollar figure: nothing on this board is a price');
});

test('estimate: with rates the same board is priced, and the number wears the label', () => {
  const s = bgBoard({ rates: { 'claude-opus-5': { input: 5, output: 25, cache_write: 6.25, cache_read: 0.5 } } });
  assert.equal(s.spend.basis, 'estimate');
  assert.equal(s.spend.total_usd, 0, 'reported spend stays zero — an estimate is never folded into it');
  assert.equal(s.spend.estimated_usd, 7.734);
  assert.deepEqual(s.spend.sources, { run_record: 0, worker_log: 0, estimate: 2 });
  const text = formatStats(s);
  assert.match(text, /spend {6}~\$7\.73 ESTIMATED on 2 of 2 worker attempts — the tokens below at your `stats\.rates`/);
  assert.match(text, /usage {6}42 turns/);
});

test('reported and estimated appear on the same board without being added together', () => {
  const s = bgBoard({ reported: true, rates: { 'claude-opus-5': { input: 5, output: 25, cache_write: 6.25, cache_read: 0.5 } } });
  assert.equal(s.spend.basis, 'reported');
  assert.equal(s.spend.total_usd, 1.5);
  assert.equal(s.spend.estimated_usd, 3.867);
  const text = formatStats(s);
  assert.match(text, /spend {6}\$1\.50 reported · on 1 of 2 worker attempts/);
  assert.match(text, /~\$3\.87 estimated on top, for 1 worker attempt priced from their transcripts — an estimate, not a reported cost/);
});

test('at the cap, the report says so where a human will see it', () => {
  const text = formatStats(computeStats({ board: 'default', now: NOW, spawns: spawnBudget({ spawn_day: '2026-08-26', spawned_today: 40 }, 40, NOW) }));
  assert.match(text, /AT CAP/);
  assert.match(text, /attempts {3}none in the window/);
});

// ---------- the command, end to end ----------

function harness({ board = 'default', dispatch = {}, state = null, rates = null } = {}) {
  const gh = new FakeGh();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hkb-stats-'));
  fs.mkdirSync(path.join(root, '.kanban'), { recursive: true });
  if (state) fs.writeFileSync(path.join(root, '.kanban', 'state.json'), JSON.stringify(state));
  const ctx = {
    root,
    cfg: { ...DEFAULT_BOARD, repo: gh.nameWithOwner, board, dispatch: { ...DEFAULT_BOARD.dispatch, ...dispatch }, ...(rates ? { stats: { rates } } : {}) },
    repo: { owner: gh.owner, repo: gh.repo, nameWithOwner: gh.nameWithOwner },
    board,
    host: 'test-host',
    json: false,
    caps: {},
    _cache: {},
    requireBoard() { return this; },
  };
  const restore = gh.install();
  const store = new FakeStore();
  const restoreStore = store.install(ctx);
  const lines = [];
  return {
    gh, store,
    ctx,
    root,
    out: () => lines.join('\n'),
    run: (flags = {}) => stats(ctx, { since: 'all', ...flags }, { now: NOW, write: (s) => lines.push(s) }),
    cleanup: () => { restoreStore(); restore(); fs.rmSync(root, { recursive: true, force: true }); },
  };
}

test('hkb stats: one board query, the run comments of the window, and not one write', async (t) => {
  const h = harness({ state: { spawn_day: '2026-08-26', spawned_today: 5 } });
  t.after(h.cleanup);
  h.store.addIssue(kbIssue({
    number: 1, status: 'done', state: 'CLOSED', stateReason: 'COMPLETED', agent: 'claude', updatedAt: ago(hours(2)),
    run: runWith([{ attempt: 1, started_at: ago(hours(3)), ended_at: ago(hours(2)), outcome: 'completed', total_cost_usd: 0.8, num_turns: 15 }]),
  }));
  h.store.addIssue(kbIssue({
    number: 2, status: 'running', agent: 'claude', updatedAt: ago(days(40)),
    run: runWith([{ attempt: 1, started_at: ago(minutes(15)) }]),
  }));
  h.store.addIssue(kbIssue({ number: 3, status: 'ready', updatedAt: ago(days(40)) }));

  assert.equal(await h.run({ since: '7d' }), 0);
  const text = h.out();
  assert.match(text, /tasks {6}3 \(2 open\)/);
  assert.match(text, /attempts {3}2 over 2 tasks · 1 ended · 1 active/);
  assert.match(text, /spawns {5}5 \/ 40 today · 35 left/);
  assert.match(text, /spend {6}\$0\.80/);

  assert.equal(h.store.callsOf('listTasks').length, 1, 'one board read per run');
  const runReads = h.store.callsOf('loadRun').map((c) => Number(c.args[0]));
  assert.deepEqual(runReads, [1, 2], '#3 has no news and is not running');
  assert.deepEqual(h.store.writes(), [], 'stats reads the board and writes nothing');
});

test('hkb stats --json: the same object, and the local worker log fills a missing price', async (t) => {
  const h = harness();
  t.after(h.cleanup);
  fs.mkdirSync(path.join(h.root, '.kanban/logs'), { recursive: true });
  fs.writeFileSync(path.join(h.root, '.kanban/logs/5-1.log'), JSON.stringify({ session_id: 's5', total_cost_usd: 0.37, num_turns: 11 }) + '\n');
  h.store.addIssue(kbIssue({
    number: 5, status: 'review', agent: 'claude', updatedAt: ago(minutes(5)),
    run: runWith([{ attempt: 1, started_at: ago(hours(1)), ended_at: ago(minutes(30)), outcome: 'review_requested', log: '.kanban/logs/5-1.log' }]),
  }));

  h.ctx.json = true;
  assert.equal(await h.run(), 0);
  const s = JSON.parse(h.out());
  assert.equal(s.board, 'default');
  assert.equal(s.window, 'all');
  assert.equal(s.since, null);
  assert.equal(s.spend.total_usd, 0.37);
  assert.deepEqual(s.spend.sources, { run_record: 0, worker_log: 1, estimate: 0 });
  assert.equal(s.spend.basis, 'reported');
  assert.equal(s.spend.by_profile.claude.turns, 11);
  assert.equal(s.attempts.delivered, 1);
  assert.equal(s.attempts.duration_ms.mean, minutes(30));
  assert.deepEqual(s.reads, { board: 1, run_comments: 1 });
});

// `claude-bg` — the default profile — logs a launch banner and never Claude's final JSON, so the
// transcript the Stop hook recorded is the only thing on the host that knows what the attempt did.

test('hkb stats: a claude-bg board reports turns and tokens off the transcript, not nothing', async (t) => {
  const h = harness();
  t.after(h.cleanup);
  fs.mkdirSync(path.join(h.root, '.kanban/logs'), { recursive: true });
  fs.writeFileSync(path.join(h.root, '.kanban/logs/9-1.log'), [
    '# 2026-08-28T01:29:42.943Z launch background agent for #9 attempt 1',
    'backgrounded · dd1e06c1 · kb #9 · nothing else, ever',
  ].join('\n') + '\n');
  const transcript = path.join(h.root, '.kanban/logs/9-1.jsonl');
  fs.writeFileSync(transcript, [
    asst('msg_1', 'claude-opus-5', tokensOf(2, 500, 40_000, 0)),
    asst('msg_1', 'claude-opus-5', tokensOf(2, 500, 40_000, 0)), // the same message, second block
    asst('msg_2', 'claude-opus-5', tokensOf(2, 1500, 0, 40_000)),
  ].join('\n') + '\n');
  h.store.addIssue(kbIssue({
    number: 9, status: 'done', state: 'CLOSED', stateReason: 'COMPLETED', agent: 'claude', updatedAt: ago(minutes(5)),
    run: runWith([{ attempt: 1, started_at: ago(hours(1)), ended_at: ago(minutes(30)), outcome: 'completed', bg: true, log: '.kanban/logs/9-1.log', transcript_path: transcript }]),
  }));

  assert.equal(await h.run(), 0);
  assert.match(h.out(), /spend {6}no cost reported on any of the 1 worker attempt/);
  assert.match(h.out(), /usage {6}2 turns · in 4 · out 2000 · cache 40k written \/ 40k read {2}\(1 transcript\)/);
  assert.deepEqual(h.store.writes(), [], 'stats reads the board and writes nothing');
});

test('hkb stats: `stats.rates` in board.json turns those tokens into an estimate, marked as one', async (t) => {
  const h = harness({ rates: { 'claude-opus': { input: 5, output: 25, cache_write: 6.25, cache_read: 0.5 } } });
  t.after(h.cleanup);
  const transcript = path.join(h.root, 'sess.jsonl');
  fs.writeFileSync(transcript, asst('msg_1', 'claude-opus-5', tokensOf(1000, 2000, 4000, 8000)) + '\n');
  h.store.addIssue(kbIssue({
    number: 9, status: 'done', state: 'CLOSED', stateReason: 'COMPLETED', agent: 'claude', updatedAt: ago(minutes(5)),
    run: runWith([{ attempt: 1, started_at: ago(hours(1)), ended_at: ago(minutes(30)), outcome: 'completed', transcript_path: transcript }]),
  }));

  h.ctx.json = true;
  assert.equal(await h.run(), 0);
  const s = JSON.parse(h.out());
  assert.equal(s.spend.basis, 'estimate');
  assert.equal(s.spend.total_usd, 0, 'nothing reported a cost, and an estimate is not one');
  assert.equal(s.spend.estimated_usd, 0.084); // (1000·5 + 2000·25 + 4000·6.25 + 8000·0.5) / 1e6
  assert.equal(s.spend.usage.turns, 1);
  assert.equal(s.spend.attempts_missing_cost, 0);
});

test('hkb stats: a track of three nodes prices its one session once, off the file itself', async (t) => {
  const h = harness({ rates: { 'claude-opus': { input: 5, output: 25, cache_write: 6.25, cache_read: 0.5 } } });
  t.after(h.cleanup);
  const transcript = path.join(h.root, '.kanban/track.jsonl');
  fs.mkdirSync(path.dirname(transcript), { recursive: true });
  fs.writeFileSync(transcript, asst('msg_1', 'claude-opus-5', tokensOf(1000, 2000, 4000, 8000)) + '\n');
  // the runner's session, stamped by the Stop hook onto the root's row and every node it claimed
  for (const number of [20, 21, 22]) {
    h.store.addIssue(kbIssue({
      number, status: 'done', state: 'CLOSED', stateReason: 'COMPLETED', agent: 'claude-track', updatedAt: ago(minutes(5)),
      run: runWith([{ attempt: 1, profile: 'claude-track', started_at: ago(hours(1)), ended_at: ago(minutes(30)), outcome: 'completed', session_id: 's-track', transcript_path: transcript }]),
    }));
  }

  h.ctx.json = true;
  assert.equal(await h.run(), 0);
  const s = JSON.parse(h.out());
  assert.equal(s.attempts.total, 3);
  assert.equal(s.spend.usage.turns, 1, 'one message in one transcript — three nodes naming it do not make three');
  assert.equal(s.spend.estimated_usd, 0.084, 'and the estimate is that session, not three times it');
  assert.deepEqual(s.spend.sources, { run_record: 0, worker_log: 0, estimate: 1 });
  assert.equal(s.spend.attempts_shared_session, 2);
  assert.equal(s.spend.attempts_missing_cost, 0);
});

test('hkb stats: a transcript from another host degrades to the old message, never an error', async (t) => {
  const h = harness();
  t.after(h.cleanup);
  h.store.addIssue(kbIssue({
    number: 9, status: 'done', state: 'CLOSED', stateReason: 'COMPLETED', agent: 'claude', updatedAt: ago(minutes(5)),
    run: runWith([{ attempt: 1, started_at: ago(hours(1)), ended_at: ago(minutes(30)), outcome: 'completed', transcript_path: '/home/someone-else/.claude/projects/board/sess.jsonl' }]),
  }));

  assert.equal(await h.run(), 0);
  assert.match(h.out(), /spend {6}not recorded on any of the 1 worker attempt — only a harness whose log ends in Claude's final JSON reports one/);
  assert.doesNotMatch(h.out(), /^usage/m);
});
