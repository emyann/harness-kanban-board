// `hkb watch` / `hkb tail`: the snapshot diffs, the flag parsing, and the conditional poll loop.
// No `gh` and no network — `restRaw` is injected, so a 304 is something a test can assert on.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseIncluded, restRaw, setTransport } from '../src/gh.js';
import { serializeRunComment, serializeResultComment, RESULT_MARKER } from '../src/model.js';
import {
  boardIndex, diffBoard, emptyWatchState, commentEvents, issueNumberOf, afterFloor,
  parseKinds, matchesKinds, resolveInterval, resolvePolls, describeEvent, formatEvent, sortEvents,
  watch, tail, KIND_TOKENS, MIN_INTERVAL, DEFAULT_INTERVAL,
} from '../src/watch.js';

// ---------- fixtures ----------

const ISSUE_URL = 'https://api.github.com/repos/acme/board/issues/7';

const issue = ({ number = 7, status = 'ready', agent = 'claude', board = 'default', needsHuman = false, state = 'open', reason = null, at = '2026-08-26T08:00:00Z', title = 'watch the board' } = {}) => ({
  number,
  title,
  state,
  state_reason: reason,
  updated_at: at,
  html_url: `https://github.com/acme/board/issues/${number}`,
  labels: [
    ...(board ? [{ name: `kb:board:${board}` }] : []),
    ...(status ? [{ name: `kb:status:${status}` }] : []),
    ...(agent ? [{ name: `kb:agent:${agent}` }] : []),
    ...(needsHuman ? [{ name: 'kb:needs-human' }] : []),
  ],
});

const comment = ({ id = 1, body = 'hello', at = '2026-08-26T08:00:00Z', login = 'emyann', number = 7 } = {}) => ({
  id, body, created_at: at, updated_at: at, user: { login },
  html_url: `https://github.com/acme/board/issues/${number}#issuecomment-${id}`,
  issue_url: `https://api.github.com/repos/acme/board/issues/${number}`,
});

const runComment = (attempts, over = {}) => comment({
  id: 900,
  body: serializeRunComment({ v: 1, attempts, failures: 0, block_loops: {}, last_error: null }),
  ...over,
});

// ---------- board snapshots ----------

test('boardIndex keeps only what a transition can be seen in, and only this board', () => {
  const index = boardIndex([issue(), issue({ number: 8, board: 'other' }), { number: 9, pull_request: {}, labels: [] }], 'default');
  assert.deepEqual([...index.keys()], [7]);
  assert.deepEqual(index.get(7), {
    number: 7, title: 'watch the board', status: 'ready', agent: 'claude', needsHuman: false,
    state: 'OPEN', stateReason: null, at: '2026-08-26T08:00:00Z', url: 'https://github.com/acme/board/issues/7',
  });
});

test('diffBoard reports one event per label, state and agent change', () => {
  const before = boardIndex([issue()], 'default');
  const after = boardIndex([issue({ status: 'running', agent: 'codex', needsHuman: true, at: '2026-08-26T08:05:00Z' })], 'default');
  const kinds = diffBoard(before, after).map((e) => e.kind);
  assert.deepEqual(kinds, ['status', 'agent', 'needs-human']);
  const [status] = diffBoard(before, after);
  assert.deepEqual({ from: status.from, to: status.to, number: status.number, at: status.at }, { from: 'ready', to: 'running', number: 7, at: '2026-08-26T08:05:00Z' });
  assert.deepEqual(status.tags, ['status', 'running']);
});

test('diffBoard is silent when nothing changed', () => {
  const before = boardIndex([issue()], 'default');
  assert.deepEqual(diffBoard(before, boardIndex([issue()], 'default')), []);
});

test('a task that is new to the window appears; one that scrolled out is not a departure', () => {
  const before = boardIndex([issue(), issue({ number: 8 })], 'default');
  const after = boardIndex([issue({ number: 9, status: 'todo' })], 'default');
  const events = diffBoard(before, after);
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, 'appeared');
  assert.deepEqual(events[0].tags, ['appeared', 'todo']);
});

test('closing and reopening an issue are transitions with a reason', () => {
  const open = boardIndex([issue()], 'default');
  const closed = boardIndex([issue({ state: 'closed', reason: 'completed' })], 'default');
  const [done] = diffBoard(open, closed);
  assert.deepEqual({ kind: done.kind, reason: done.reason, tags: done.tags }, { kind: 'closed', reason: 'completed', tags: ['closed', 'state'] });
  const [back] = diffBoard(closed, open);
  assert.equal(back.kind, 'reopened');
});

// ---------- comments ----------

test('a run comment yields one attempt event, then one outcome event, and never repeats', () => {
  const state = emptyWatchState();
  const started = [{ attempt: 1, profile: 'claude', host: 'YRND1', started_at: '2026-08-26T08:01:00Z' }];
  const first = commentEvents(state, [runComment(started)]);
  assert.equal(first.length, 1);
  assert.deepEqual(
    { kind: first[0].kind, attempt: first[0].attempt, profile: first[0].profile, at: first[0].at },
    { kind: 'attempt', attempt: 1, profile: 'claude', at: '2026-08-26T08:01:00Z' },
  );

  assert.deepEqual(commentEvents(state, [runComment(started)]), [], 'an unchanged run comment says nothing');

  const ended = [{ ...started[0], ended_at: '2026-08-26T08:09:00Z', outcome: 'completed', summary: 'added src/watch.js\nand tests' }];
  const second = commentEvents(state, [runComment(ended)]);
  assert.equal(second.length, 1);
  assert.deepEqual(
    { kind: second[0].kind, outcome: second[0].outcome, summary: second[0].summary, tags: second[0].tags },
    { kind: 'outcome', outcome: 'completed', summary: 'added src/watch.js', tags: ['outcome', 'completed'] },
  );
  assert.deepEqual(commentEvents(state, [runComment(ended)]), []);
});

test('an attempt found already ended reports both its start and its outcome', () => {
  const state = emptyWatchState();
  const events = commentEvents(state, [runComment([{ attempt: 2, profile: 'codex', started_at: '2026-08-26T08:01:00Z', ended_at: '2026-08-26T08:02:00Z', outcome: 'blocked', reason: 'needs a token' }])]);
  assert.deepEqual(events.map((e) => e.kind), ['attempt', 'outcome']);
  assert.equal(events[1].summary, 'needs a token');
});

test('result comments and human comments are each reported once', () => {
  const state = emptyWatchState();
  const result = comment({ id: 5, body: serializeResultComment({ attempt: 1, summary: 'done: the watcher polls conditionally', metadata: {} }) });
  const chat = comment({ id: 6, body: 'looks good to me\nship it' });
  const events = commentEvents(state, [result, chat]);
  assert.deepEqual(events.map((e) => e.kind), ['result', 'comment']);
  assert.equal(events[0].summary, 'done: the watcher polls conditionally');
  assert.equal(events[0].attempt, 1);
  assert.equal(events[1].actor, 'emyann');
  assert.equal(events[1].text, 'looks good to me');
  assert.deepEqual(commentEvents(state, [result, chat]), []);
});

test('repository-wide comments outside the board index are not ours', () => {
  const state = emptyWatchState();
  const known = new Map([[7, {}]]);
  const events = commentEvents(state, [comment({ id: 1, number: 7 }), comment({ id: 2, number: 99 })], { known });
  assert.deepEqual(events.map((e) => e.number), [7]);
});

test('issueNumberOf reads the issue out of a comment url, or falls back', () => {
  assert.equal(issueNumberOf({ issue_url: ISSUE_URL }), 7);
  assert.equal(issueNumberOf({}, 12), 12);
  assert.equal(issueNumberOf({}), null);
});

test('comments are read oldest first, so an attempt is reported before its outcome', () => {
  const state = emptyWatchState();
  const events = commentEvents(state, [
    comment({ id: 2, body: 'later', at: '2026-08-26T09:00:00Z' }),
    comment({ id: 1, body: 'earlier', at: '2026-08-26T08:00:00Z' }),
  ]);
  assert.deepEqual(events.map((e) => e.text), ['earlier', 'later']);
});

// ---------- flags ----------

test('--kinds accepts an event kind, a status or an outcome', () => {
  const kinds = parseKinds('completed,blocked,attempt');
  assert.ok(matchesKinds({ tags: ['outcome', 'completed'] }, kinds));
  assert.ok(matchesKinds({ tags: ['status', 'blocked'] }, kinds));
  assert.ok(matchesKinds({ tags: ['attempt'] }, kinds));
  assert.ok(!matchesKinds({ tags: ['status', 'running'] }, kinds));
  assert.ok(matchesKinds({ tags: ['status', 'running'] }, null), 'no filter means everything');
});

test('--kinds names the tokens it would have accepted', () => {
  assert.throws(() => parseKinds('finished'), (e) => {
    assert.equal(e.exitCode, 2);
    assert.match(e.message, /unknown finished/);
    assert.match(e.message, /completed/);
    return true;
  });
  assert.throws(() => parseKinds(true), /--kinds needs a value/);
  assert.equal(parseKinds(undefined), null);
  assert.ok(KIND_TOKENS.includes('review_requested'));
});

test('--interval is floored, and a non-number says so', () => {
  assert.equal(resolveInterval(undefined), DEFAULT_INTERVAL);
  assert.equal(resolveInterval('1'), MIN_INTERVAL);
  assert.equal(resolveInterval('45'), 45);
  assert.throws(() => resolveInterval('soon'), /must be a number of seconds/);
  assert.throws(() => resolveInterval(true), /needs a value in seconds/);
});

test('--polls must be a whole count, and is unbounded by default', () => {
  assert.equal(resolvePolls(undefined), Infinity);
  assert.equal(resolvePolls('3'), 3);
  assert.throws(() => resolvePolls('0'), /1 or more/);
  assert.throws(() => resolvePolls('1.5'), /whole number/);
});

test('backfill older than the floor is not an event', () => {
  const floor = '2026-08-26T08:00:00.000Z';
  assert.ok(afterFloor({ at: '2026-08-26T08:00:01Z' }, floor));
  assert.ok(!afterFloor({ at: '2026-08-25T23:00:00Z' }, floor));
  assert.ok(afterFloor({ at: null }, floor), 'an event with no timestamp is kept');
  assert.ok(afterFloor({ at: '2020-01-01T00:00:00Z' }, null));
});

// ---------- formatting ----------

test('every event kind has a one-line description', () => {
  const lines = {
    appeared: describeEvent({ kind: 'appeared', to: 'ready' }),
    status: describeEvent({ kind: 'status', from: 'ready', to: 'running' }),
    agent: describeEvent({ kind: 'agent', from: 'claude', to: 'codex' }),
    'needs-human': describeEvent({ kind: 'needs-human', to: true }),
    closed: describeEvent({ kind: 'closed', reason: 'completed' }),
    attempt: describeEvent({ kind: 'attempt', attempt: 2, profile: 'claude', host: 'box' }),
    outcome: describeEvent({ kind: 'outcome', attempt: 2, outcome: 'completed', summary: 'it works' }),
    result: describeEvent({ kind: 'result', attempt: 2, summary: 'it works' }),
    comment: describeEvent({ kind: 'comment', actor: 'emyann', text: 'ship it' }),
  };
  assert.equal(lines.status, 'ready → running');
  assert.equal(lines.attempt, 'attempt 2 started (claude@box)');
  assert.equal(lines.outcome, 'attempt 2 completed — it works');
  assert.equal(lines.comment, 'comment by emyann — ship it');
  for (const [kind, line] of Object.entries(lines)) {
    assert.ok(line && !line.includes('\n'), `${kind} must be one line`);
  }
});

test('formatEvent is one line: time, number, what happened, title', () => {
  const line = formatEvent({ at: '2026-08-26T08:05:09Z', number: 7, kind: 'status', from: 'ready', to: 'running', title: 'watch the board' });
  assert.match(line, /^08:05:09 #7 {4}ready → running {2,}watch the board$/);
  assert.match(formatEvent({ number: 7, kind: 'reopened' }), /^--:--:-- #7 {4}reopened$/);
});

test('a tick is printed in the order things happened', () => {
  const events = sortEvents([
    { at: '2026-08-26T08:09:00Z', number: 7, kind: 'outcome' },
    { at: '2026-08-26T08:01:00Z', number: 7, kind: 'attempt' },
    { at: '2026-08-26T08:05:00Z', number: 8, kind: 'status' },
  ]);
  assert.deepEqual(events.map((e) => e.kind), ['attempt', 'status', 'outcome']);
});

// ---------- gh: conditional transport ----------

test('parseIncluded splits a `gh api -i` response into status, headers and body', () => {
  const raw = 'HTTP/2.0 200 OK\nEtag: W/"abc"\nX-Ratelimit-Used: 17\n\r\n[{"number":7}]\n';
  const r = parseIncluded(raw);
  assert.equal(r.status, 200);
  assert.equal(r.headers.etag, 'W/"abc"');
  assert.equal(r.headers['x-ratelimit-used'], '17');
  assert.deepEqual(JSON.parse(r.body), [{ number: 7 }]);

  const notModified = parseIncluded('HTTP/2.0 304 Not Modified\nEtag: "abc"\n\r\n');
  assert.equal(notModified.status, 304);
  assert.equal(notModified.body, '');
  assert.equal(parseIncluded('').status, 0);
});

test('restRaw treats a transport that returns a bare payload as a 200', async () => {
  const restore = setTransport((req) => {
    assert.equal(req.raw, true);
    return [{ number: 7 }];
  });
  try {
    const r = await restRaw('GET', 'repos/acme/board/issues');
    assert.deepEqual(r, { status: 200, headers: {}, data: [{ number: 7 }] });
  } finally { restore(); }
});

test('restRaw passes the response envelope through untouched', async () => {
  const restore = setTransport(() => ({ __response: true, status: 304, headers: { etag: '"a"' }, data: null }));
  try {
    assert.deepEqual(await restRaw('GET', 'repos/acme/board/issues', { headers: { 'If-None-Match': '"a"' } }), { status: 304, headers: { etag: '"a"' }, data: null });
  } finally { restore(); }
});

// ---------- the loop ----------

const ctxFor = (over = {}) => ({
  board: 'default',
  json: false,
  repo: { owner: 'acme', repo: 'board', nameWithOwner: 'acme/board' },
  ...over,
});

/** A scripted `restRaw`: one entry per call, in order, recording what was asked for. */
function scripted(responses) {
  const calls = [];
  return {
    calls,
    restRaw: async (method, path, { headers = {} } = {}) => {
      calls.push({ method, path, headers });
      const next = responses.shift();
      assert.ok(next, `unscripted call: ${method} ${path}`);
      if (next.throws) throw next.throws;
      return { status: next.status, headers: next.headers || {}, data: next.data ?? null };
    },
  };
}

function harness(responses, ctx = ctxFor()) {
  const lines = [];
  const logs = [];
  const net = scripted(responses);
  return {
    ctx, lines, logs, calls: net.calls,
    deps: {
      restRaw: net.restRaw,
      write: (s) => lines.push(s),
      log: (s) => logs.push(s),
      sleeper: { sleep: async () => {}, wake: () => {} },
      signals: false,
      since: '2026-08-26T08:00:00.000Z',
    },
  };
}

const ok = (data, etag, used) => ({ status: 200, headers: { etag, 'x-ratelimit-used': String(used) }, data });
const notModified = (used) => ({ status: 304, headers: { 'x-ratelimit-used': String(used) }, data: null });

test('watch: the first poll is a baseline, the second is a free 304, the third prints the change', async () => {
  const h = harness([
    ok([issue({ status: 'ready', at: '2026-08-26T08:00:30Z' })], '"b1"', 10),
    ok([], '"c1"', 11),
    notModified(11),
    notModified(11),
    ok([issue({ status: 'running', at: '2026-08-26T08:02:00Z' })], '"b2"', 12),
    ok([runComment([{ attempt: 1, profile: 'claude', started_at: '2026-08-26T08:01:50Z' }])], '"c2"', 13),
  ]);
  const code = await watch(h.ctx, { interval: 5, polls: 3 }, h.deps);

  assert.equal(code, 0);
  assert.deepEqual(h.lines, [
    formatEvent({ at: '2026-08-26T08:01:50Z', number: 7, kind: 'attempt', attempt: 1, profile: 'claude', host: null, title: 'watch the board' }),
    formatEvent({ at: '2026-08-26T08:02:00Z', number: 7, kind: 'status', from: 'ready', to: 'running', title: 'watch the board' }),
  ]);
  assert.match(h.logs[0], /acme\/board board "default" — 1 task \(1 open\) at baseline/);
});

test('watch: the ETag of the last 200 is what the next poll sends', async () => {
  const h = harness([
    ok([issue()], 'W/"board-1"', 10),
    ok([], 'W/"comments-1"', 11),
    notModified(11),
    notModified(11),
  ]);
  await watch(h.ctx, { interval: 5, polls: 2 }, h.deps);

  assert.deepEqual(h.calls.map((c) => c.headers['If-None-Match']), [undefined, undefined, 'W/"board-1"', 'W/"comments-1"']);
  assert.match(h.calls[0].path, /^repos\/acme\/board\/issues\?labels=kb%3Aboard%3Adefault&state=all&sort=updated&direction=desc&per_page=100$/);
  assert.match(h.calls[1].path, /^repos\/acme\/board\/issues\/comments\?per_page=100&sort=updated&direction=desc&since=2026-08-26T08%3A00%3A00\.000Z$/);
  assert.deepEqual(h.calls[1].path, h.calls[3].path, 'the poll URL never moves, or no ETag could ever match');
});

test('watch: --kinds keeps only what was asked for', async () => {
  const h = harness([
    ok([issue({ status: 'running' })], '"b1"', 10),
    ok([], '"c1"', 11),
    ok([issue({ status: 'blocked', at: '2026-08-26T08:03:00Z' })], '"b2"', 12),
    ok([comment({ id: 3, body: 'a human says something', at: '2026-08-26T08:03:10Z' })], '"c2"', 13),
  ]);
  await watch(h.ctx, { interval: 5, polls: 2, kinds: 'blocked' }, h.deps);
  assert.equal(h.lines.length, 1);
  assert.match(h.lines[0], /running → blocked/);
});

test('watch --json emits one JSON object per line', async () => {
  const h = harness([
    ok([issue({ status: 'ready' })], '"b1"', 10),
    ok([], '"c1"', 11),
    ok([issue({ status: 'review', at: '2026-08-26T08:04:00Z' })], '"b2"', 12),
    ok([], '"c2"', 13),
  ], ctxFor({ json: true }));
  await watch(h.ctx, { interval: 5, polls: 2 }, h.deps);
  assert.equal(h.lines.length, 1);
  assert.deepEqual(JSON.parse(h.lines[0]), {
    number: 7, title: 'watch the board', url: 'https://github.com/acme/board/issues/7',
    at: '2026-08-26T08:04:00Z', kind: 'status', from: 'ready', to: 'review', tags: ['status', 'review'],
  });
});

test('watch: a transient failure is retried, not fatal; an auth failure stops', async () => {
  const flaky = Object.assign(new Error('dial tcp: connection refused'), { kind: 'network' });
  const h = harness([
    { throws: flaky },
    ok([issue({ status: 'ready' })], '"b1"', 10),
    ok([], '"c1"', 11),
  ]);
  await watch(h.ctx, { interval: 5, polls: 2 }, h.deps);
  assert.match(h.logs[0], /connection refused — retrying in 5s/);
  assert.match(h.logs[1], /at baseline/);

  const fatal = harness([{ throws: Object.assign(new Error('Bad credentials'), { kind: 'auth' }) }]);
  await assert.rejects(watch(fatal.ctx, { interval: 5, polls: 2 }, fatal.deps), /Bad credentials/);
});

test('watch: a run comment first seen mid-watch does not replay the attempts that predate it', async () => {
  const old = { attempt: 1, profile: 'claude', started_at: '2026-08-25T10:00:00Z', ended_at: '2026-08-25T11:00:00Z', outcome: 'crashed' };
  const fresh = { attempt: 2, profile: 'claude', started_at: '2026-08-26T08:02:00Z' };
  const h = harness([
    ok([issue()], '"b1"', 10),
    ok([], '"c1"', 11),
    notModified(11),
    ok([runComment([old, fresh])], '"c2"', 12),
  ]);
  await watch(h.ctx, { interval: 5, polls: 2 }, h.deps);
  assert.equal(h.lines.length, 1);
  assert.match(h.lines[0], /attempt 2 started/);
});

test('tail follows one issue: its status changes and its comments', async () => {
  const h = harness([
    ok(issue({ status: 'running' }), '"i1"', 10),
    ok([runComment([{ attempt: 1, profile: 'claude', started_at: '2026-08-26T08:00:10Z' }])], '"c1"', 11),
    ok(issue({ status: 'review', at: '2026-08-26T08:06:00Z' }), '"i2"', 12),
    ok([
      runComment([{ attempt: 1, profile: 'claude', started_at: '2026-08-26T08:00:10Z', ended_at: '2026-08-26T08:05:50Z', outcome: 'completed', summary: 'watch and tail landed' }]),
      comment({ id: 7, body: `${RESULT_MARKER}\n### Result\n\n\`\`\`json\n{"summary":"watch and tail landed","attempt":1}\n\`\`\``, at: '2026-08-26T08:05:55Z' }),
    ], '"c2"', 13),
  ]);
  await tail(h.ctx, 7, { interval: 5, polls: 2 }, h.deps);

  assert.deepEqual(h.lines.map((l) => l.replace(/\s+/g, ' ')), [
    '08:05:50 #7 attempt 1 completed — watch and tail landed watch the board',
    '08:05:55 #7 result (attempt 1) — watch and tail landed watch the board',
    '08:06:00 #7 running → review watch the board',
  ]);
  assert.deepEqual(h.calls.map((c) => c.path), [
    'repos/acme/board/issues/7',
    'repos/acme/board/issues/7/comments?per_page=100&sort=updated&direction=desc',
    'repos/acme/board/issues/7',
    'repos/acme/board/issues/7/comments?per_page=100&sort=updated&direction=desc',
  ]);
  assert.match(h.logs[0], /#7 running \(claude\)/);
});
