import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseSessionLog, sessionUpdate, formatSession, resumeCommand, worktreePath } from '../src/model.js';
import { stopHook, markSessionClaim } from '../src/hook.js';
import { loadRun } from '../src/tasks.js';
import { DEFAULT_BOARD } from '../src/board.js';
import { FakeGh, kbIssue, runWith } from './fake-gh.js';

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

// ---------- the session identity a track hands its nodes ----------
// A worker session is one task; a track runner's session is a whole subgraph. The Stop hook is
// handed one session id and `KB_TASK` is the root, so without the claim markers every node the
// runner worked would end with a bare attempt row and a post-mortem would start with archaeology.

const PAYLOAD = { session_id: 'sid-1', transcript_path: '/t/sid-1.jsonl', total_cost_usd: 1.25, num_turns: 210, duration_ms: 900_000 };
const ended = (outcome = 'complete') => ({ started_at: '2026-08-27T09:00:00Z', ended_at: '2026-08-27T09:40:00Z', outcome });
const writes = (gh) => gh.calls.filter((c) => ['POST', 'PATCH', 'DELETE'].includes(c.method)).length;

/** A track runner's worktree and its board: root #7, plus #8 and #9 as nodes it claimed. */
function trackHarness({ rootStatus = 'review' } = {}) {
  const gh = new FakeGh();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hkb-hook-'));
  const root = path.join(dir, 'kb-7-1'); // `claude --worktree kb-<n>-<k>`: where the one session runs
  fs.mkdirSync(path.join(root, '.kanban'), { recursive: true });
  gh.addIssue(kbIssue({ number: 7, status: rootStatus, agent: 'claude-track', run: runWith([{ attempt: 1, host: 'h', wt: 'kb-7-1', track: true, ...ended() }]) }));
  gh.addIssue(kbIssue({ number: 8, status: 'review', agent: 'claude', run: runWith([{ attempt: 1, host: 'h', manual: true, ...ended() }]) }));
  // #9's claimed attempt is its second, and both of its attempts have ended: only the exact
  // attempt the marker names can be found, never "the open one".
  gh.addIssue(kbIssue({ number: 9, status: 'review', agent: 'claude', run: runWith([{ attempt: 1, host: 'h', ...ended('failed') }, { attempt: 2, host: 'h', manual: true, ...ended() }]) }));
  // a node with a live attempt that is somebody else's — a reclaim, or a worker the tick dispatched
  gh.addIssue(kbIssue({ number: 10, status: 'running', agent: 'claude', run: runWith([{ attempt: 1, host: 'other', started_at: '2026-08-27T10:00:00Z' }]) }));

  const cfg = { ...DEFAULT_BOARD, repo: gh.nameWithOwner };
  const ctx = { root, cfg, repo: { owner: gh.owner, repo: gh.repo, nameWithOwner: gh.nameWithOwner }, board: 'default', host: 'h', json: false, caps: {}, _cache: {}, requireBoard() { return this; } };
  const restore = gh.install();
  const saved = { ...process.env };
  Object.assign(process.env, { KB_TASK: '7', KB_ATTEMPT: '1', KB_PROFILE: 'claude-track' });
  const markerFile = (n, k) => path.join(root, '.kanban', 'sessions', `${n}-${k}`);
  return {
    gh, ctx, root,
    marker: (n, k) => { try { return fs.readFileSync(markerFile(n, k), 'utf8'); } catch { return null; } },
    attempt: async (n, k) => (await loadRun(ctx, n)).run.attempts.find((a) => a.attempt === k),
    stop: (payload = PAYLOAD) => stopHook(ctx, { readStdin: () => JSON.stringify(payload) }),
    cleanup: () => {
      restore();
      for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
      Object.assign(process.env, saved);
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('stop hook: one session, a root and two claimed nodes — every attempt row gets the identity', async () => {
  const h = trackHarness();
  try {
    assert.equal(markSessionClaim(h.root, 8, 1), true);
    assert.equal(markSessionClaim(h.root, 9, 2), true);
    assert.equal(h.marker(8, 1), 'claimed-by 7-1 kb-7-1\n');

    await h.stop();

    for (const [n, k] of [[7, 1], [8, 1], [9, 2]]) {
      const a = await h.attempt(n, k);
      assert.equal(a.session_id, 'sid-1', `#${n} attempt ${k} session_id`);
      assert.equal(a.transcript_path, '/t/sid-1.jsonl', `#${n} attempt ${k} transcript_path`);
      assert.equal(a.total_cost_usd, 1.25);
    }
    // the node rows point at the runner's worktree, so `hkb show <node>` prints a resume line that
    // names a checkout that exists — `kb-9-2` never did
    assert.equal(formatSession(await h.attempt(9, 2)), 'session sid-1 · $1.25 · 210 turns · 15m00s');
    assert.equal(resumeCommand(await h.attempt(9, 2), 9), 'cd .claude/worktrees/kb-7-1 && claude --resume sid-1');
    assert.equal((await h.attempt(9, 1)).session_id, undefined, 'an attempt this session never claimed');
    // every marker now holds the id, so the next fire has nothing to look up
    for (const [n, k] of [[7, 1], [8, 1], [9, 2]]) assert.equal(h.marker(n, k), 'sid-1\n', `marker ${n}-${k}`);

    const before = writes(h.gh);
    await h.stop();
    assert.equal(writes(h.gh), before, 'a second Stop fire re-records nothing');
  } finally { h.cleanup(); }
});

test('stop hook: nothing to record — no marker written, no run touched', async () => {
  const h = trackHarness();
  try {
    markSessionClaim(h.root, 8, 1);
    const before = writes(h.gh);
    await h.stop({ cwd: '/repo', hook_event_name: 'Stop' }); // Copilot's payload, minus its ids
    assert.equal(writes(h.gh), before);
    assert.equal(h.marker(7, 1), null, 'the hook did not even open the marker directory');
    assert.equal(h.marker(8, 1), 'claimed-by 7-1 kb-7-1\n', 'the claim is still pending');
    assert.equal((await h.attempt(8, 1)).session_id, undefined);
  } finally { h.cleanup(); }
});

test('stop hook: a node another session claimed is left to that session', async () => {
  const h = trackHarness();
  try {
    process.env.KB_TASK = '20'; // a second runner, in a checkout that happens to be shared
    markSessionClaim(h.root, 8, 1);
    process.env.KB_TASK = '7';
    await h.stop();
    assert.equal((await h.attempt(8, 1)).session_id, undefined);
    assert.equal(h.marker(8, 1), 'claimed-by 20-1 kb-7-1\n', 'still pending, for #20 to stamp');
    assert.equal((await h.attempt(7, 1)).session_id, 'sid-1', 'the root is still recorded');
  } finally { h.cleanup(); }
});

test('stop hook: a claimed row that is gone is never swapped for whoever holds the node now', async () => {
  const h = trackHarness();
  try {
    markSessionClaim(h.root, 10, 4); // an attempt #10's run record does not have
    await h.stop();
    assert.equal((await h.attempt(10, 1)).session_id, undefined, "#10's open attempt is another worker's");
    assert.equal(h.marker(10, 4), 'sid-1\n', 'stamped all the same: there is nothing left to try');
  } finally { h.cleanup(); }
});

test('stop hook: the nudge still fires, and the session is recorded in the same breath', async () => {
  const h = trackHarness({ rootStatus: 'running' });
  const out = [];
  const write = process.stdout.write;
  process.stdout.write = (s) => { out.push(String(s)); return true; };
  try {
    markSessionClaim(h.root, 8, 1);
    await h.stop();
    process.stdout.write = write;
    assert.deepEqual(JSON.parse(out.join('')).decision, 'block');
    assert.equal((await h.attempt(8, 1)).session_id, 'sid-1');
  } finally { process.stdout.write = write; h.cleanup(); }
});

test('markSessionClaim: only ever marks another task, from inside a session', () => {
  const h = trackHarness();
  try {
    assert.equal(markSessionClaim(h.root, 7, 1), false, "the session's own task is the hook's business");
    delete process.env.KB_TASK;
    assert.equal(markSessionClaim(h.root, 8, 1), false, 'no session, no marker');
    process.env.KB_TASK = '7';
    assert.equal(markSessionClaim(h.root, 8, 1), true);
    assert.equal(markSessionClaim(h.root, 8, 1), false, 'idempotent: never overwrite what is there');
  } finally { h.cleanup(); }
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
