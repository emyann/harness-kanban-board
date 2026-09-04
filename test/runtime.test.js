// The runtime seam (src/runtime/, docs/local-first.md §4). Three adapters implement one interface,
// so the interface is what is tested: the same liveness scenarios are put to every one of them, and
// each is then asked the questions only it can answer.
//
// The last block runs a whole tick against `test/fake-runtime.js` — no `claude` on PATH, nothing
// spawned, no worktree — which is the point of the double.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runtimeFor, listHandles, stopHandle, NOT_IMPLEMENTED, REGISTER_GRACE } from '../src/runtime/index.js';
import * as processRuntime from '../src/runtime/process.js';
import * as claudeBg from '../src/runtime/claude-bg.js';
import * as manual from '../src/runtime/manual.js';
import { tick } from '../src/dispatch.js';
import { DEFAULT_BOARD } from '../src/board.js';
import { installDoubles, kbIssue } from './fake-store.js';
import { installRuntime } from './fake-runtime.js';

const ago = (seconds) => new Date(Date.now() - seconds * 1000).toISOString();
const ctxOn = (host = 'test-host', root = '/repo') => ({ host, root, board: 'default', cfg: DEFAULT_BOARD, repo: { nameWithOwner: 'acme/board' } });
const ctx = ctxOn();

// A pid nothing can be running under: `pidAlive` answers false, and `kill(pid, 0)` is harmless.
const DEAD_PID = 0x3fffffff;

// ---------- selection ----------

test('runtimeFor picks by profile mode, by attempt row, and by handle', () => {
  assert.equal(runtimeFor({ mode: 'claude-bg' }), claudeBg);
  assert.equal(runtimeFor({ mode: 'process' }), processRuntime);
  assert.equal(runtimeFor({ manual: true }), manual);
  assert.equal(runtimeFor({ remote: true }), manual); // the retired Actions rows still on old records
  assert.equal(runtimeFor({ bg: true }), claudeBg);
  assert.equal(runtimeFor({ job: 'j1' }), claudeBg);
  assert.equal(runtimeFor({ pid: 4242 }), processRuntime);
  assert.equal(runtimeFor({ runtime: 'claude-bg', id: 'j1' }), claudeBg);
  // a spawn that never recorded a handle is what a process launch would have been
  assert.equal(runtimeFor({ attempt: 1, host: 'h' }), processRuntime);
  // an unknown mode is somebody else's error to report, not a liveness check's
  assert.equal(runtimeFor({ mode: 'trigger' }), processRuntime);
  assert.equal(runtimeFor(null), processRuntime);
});

// ---------- the same scenarios, every adapter ----------

const ADAPTERS = [['process', processRuntime], ['claude-bg', claudeBg], ['manual', manual]];

for (const [name, rt] of ADAPTERS) {
  test(`${name}: an attempt on another host is never called dead — the runtime has nothing to say`, () => {
    const a = { attempt: 1, host: 'other-host', started_at: ago(9999), pid: DEAD_PID, bg: true, job: 'j1' };
    const seen = rt.inspect(ctx, a, { jobs: new Map() });
    assert.equal(seen.alive, null);
    assert.equal(seen.outcome, null);
    assert.equal(rt.stop(ctx, a), false); // and nothing of ours to stop, either
  });

  test(`${name}: inspect always answers the whole Liveness shape`, () => {
    const seen = rt.inspect(ctx, { attempt: 1, host: 'test-host', started_at: ago(5) }, { jobs: new Map() });
    for (const k of ['alive', 'working', 'handle', 'session', 'outcome', 'patch']) {
      assert.equal(k in seen, true, `${name}.inspect() must answer with ${k}`);
    }
  });

  test(`${name}: pause and resume say they are not built yet, rather than half-working`, () => {
    const a = { attempt: 1, host: 'test-host' };
    assert.deepEqual(rt.pause(ctx, a), NOT_IMPLEMENTED);
    assert.deepEqual(rt.resume(ctx, a), NOT_IMPLEMENTED);
    assert.equal(rt.pause(ctx, a).ok, false);
    assert.match(rt.resume(ctx, a).why, /B4/);
  });

  test(`${name}: inspect never mutates the row it was given`, () => {
    const a = { attempt: 1, host: 'test-host', started_at: ago(600), pid: DEAD_PID, bg: true };
    const before = JSON.stringify(a);
    rt.inspect(ctx, a, { jobs: new Map(), task: { number: 7 } });
    assert.equal(JSON.stringify(a), before);
  });
}

// ---------- process ----------

test('process: a live pid is alive, a dead one is crashed', () => {
  const live = processRuntime.inspect(ctx, { attempt: 1, host: 'test-host', pid: process.pid, started_at: ago(10) });
  assert.equal(live.alive, true);
  assert.equal(live.outcome, null);
  assert.deepEqual(live.handle, { runtime: 'process', pid: process.pid });

  const dead = processRuntime.inspect(ctx, { attempt: 1, host: 'test-host', pid: DEAD_PID, started_at: ago(10) });
  assert.equal(dead.alive, false);
  assert.equal(dead.outcome, 'crashed');
});

test('process: a spawn that never recorded a pid gets the registration grace, then is written off', () => {
  const young = processRuntime.inspect(ctx, { attempt: 1, host: 'test-host', started_at: ago(REGISTER_GRACE - 30) });
  assert.equal(young.outcome, null);
  assert.equal(young.alive, null); // "no answer", not "dead": the heartbeat still gets its say
  const old = processRuntime.inspect(ctx, { attempt: 1, host: 'test-host', started_at: ago(REGISTER_GRACE + 30) });
  assert.equal(old.outcome, 'crashed');
});

test('process: postMortem reads the attempt\'s own log, and only for a row it owns', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hkb-rt-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, '.kanban', 'logs'), { recursive: true });
  const rel = path.join('.kanban', 'logs', '7-1.log');
  fs.writeFileSync(path.join(root, rel), `${JSON.stringify({ type: 'result', session_id: 'sess-7', total_cost_usd: 0.5, num_turns: 3 })}\n`);
  const here = ctxOn('test-host', root);

  const a = { attempt: 1, host: 'test-host', pid: DEAD_PID, log: rel };
  const post = processRuntime.postMortem(here, a);
  assert.equal(post.session.session_id, 'sess-7');
  assert.equal(post.session.total_cost_usd, 0.5);

  // no log, no pid, another host: nothing to read, and the caller must not open a transcript either
  assert.equal(processRuntime.postMortem(here, { attempt: 1, host: 'test-host', pid: DEAD_PID }), null);
  assert.equal(processRuntime.postMortem(here, { attempt: 1, host: 'test-host', log: rel }), null);
  assert.equal(processRuntime.postMortem(here, { attempt: 1, host: 'elsewhere', pid: 1, log: rel }), null);

  // an unreadable log is not a throw: the row still gets written off, it just carries no session
  assert.deepEqual(processRuntime.postMortem(here, { attempt: 1, host: 'test-host', pid: DEAD_PID, log: 'nope.log' }), { session: null });
});

// ---------- claude-bg ----------

const parked = { state: 'blocked', status: 'waiting' }; // verified shape of a permission prompt
const finishedTurn = { state: 'done', status: 'idle' };

test('claude-bg: a job parked on a permission prompt is ALIVE, and not working', () => {
  const jobs = new Map([['j1', { id: 'j1', task: 7, ...parked }]]);
  const seen = claudeBg.inspect(ctx, { attempt: 1, host: 'test-host', job: 'j1', bg: true, started_at: ago(600) }, { jobs });
  assert.equal(seen.alive, true);
  assert.equal(seen.working, false);
  assert.equal(seen.outcome, null);
  assert.equal(seen.handle.id, 'j1');
});

test('claude-bg: a job that has finished its turn without a terminal verb is a protocol violation', () => {
  const jobs = new Map([['j1', { id: 'j1', task: 7, ...finishedTurn }]]);
  const fresh = claudeBg.inspect(ctx, { attempt: 1, host: 'test-host', job: 'j1', bg: true, started_at: ago(5) }, { jobs });
  assert.equal(fresh.outcome, null); // still handing over
  const settled = claudeBg.inspect(ctx, { attempt: 1, host: 'test-host', job: 'j1', bg: true, started_at: ago(600) }, { jobs });
  assert.equal(settled.outcome, 'protocol_violation');
  assert.equal(settled.alive, false);
});

test('claude-bg: a job that never registered gets the cold-daemon grace, then is crashed', () => {
  const jobs = new Map();
  const young = claudeBg.inspect(ctx, { attempt: 1, host: 'test-host', bg: true, wt: 'kb-7-1', started_at: ago(REGISTER_GRACE - 30) }, { jobs, task: { number: 7 } });
  assert.equal(young.outcome, null);
  assert.equal(young.alive, null);
  const old = claudeBg.inspect(ctx, { attempt: 1, host: 'test-host', bg: true, wt: 'kb-7-1', started_at: ago(REGISTER_GRACE + 30) }, { jobs, task: { number: 7 } });
  assert.equal(old.outcome, 'crashed');
});

test('claude-bg: a bg attempt with no job id is matched by the worktree it is sitting in', () => {
  const jobs = new Map([['j9', { id: 'j9', task: 7, cwd: '/repo/.claude/worktrees/kb-7-1', ...parked }]]);
  const byRow = claudeBg.inspect(ctx, { attempt: 1, host: 'test-host', bg: true, wt: 'kb-7-1', started_at: ago(600) }, { jobs });
  assert.equal(byRow.handle.id, 'j9');
  // and without a `wt` on the row, from the card and attempt numbers
  const byNumbers = claudeBg.inspect(ctx, { attempt: 1, host: 'test-host', bg: true, started_at: ago(600) }, { jobs, task: { number: 7 } });
  assert.equal(byNumbers.handle.id, 'j9');
});

test('claude-bg: the job id in the launch log is recovered onto the row — but never in a dry run', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hkb-rt-'));
  const rel = path.join('.kanban', 'logs', '7-1.log');
  fs.mkdirSync(path.join(root, path.dirname(rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), 'backgrounded · abc123def · kb #7 · a card\n');
  const here = ctxOn('test-host', root);
  const jobs = new Map([['abc123def', { id: 'abc123def', task: 7, ...parked }]]);
  const a = { attempt: 1, host: 'test-host', bg: true, log: rel, started_at: ago(600) };

  assert.deepEqual(claudeBg.inspect(here, a, { jobs }).patch, { job: 'abc123def' });
  assert.equal(claudeBg.inspect(here, a, { jobs, dryRun: true }).patch, null);
  assert.equal(claudeBg.inspect(here, a, { jobs, dryRun: true }).session, null);
  fs.rmSync(root, { recursive: true, force: true });
});

test('claude-bg: the gate in front of `claude stop` — one ask per attempt, and only for our own', () => {
  // `stopJob` shells out, so what is asserted here is everything that decides NOT to reach it:
  // a row already stamped, a launch with no job id yet, and an attempt belonging to another host.
  assert.equal(claudeBg.stop(ctx, { attempt: 1, host: 'test-host', job: 'j1', job_stopped: true }), false);
  assert.equal(claudeBg.stop(ctx, { attempt: 1, host: 'test-host', bg: true }), false);
  assert.equal(claudeBg.stop(ctx, { attempt: 1, host: 'somewhere-else', job: 'j1' }), false);
});

// ---------- manual ----------

test('manual: a human is the runtime — nothing to launch, nothing to inspect, nothing to stop', () => {
  assert.throws(() => manual.launch(ctx, { number: 7 }), (e) => e.exitCode === 2 && /hkb claim 7/.test(e.message));
  const seen = manual.inspect(ctx, { attempt: 1, host: 'test-host', manual: true, started_at: ago(99999) });
  assert.equal(seen.alive, null);
  assert.equal(seen.outcome, null); // the heartbeat and max_runtime are the whole check
  assert.equal(manual.stop(ctx, { attempt: 1, host: 'test-host', manual: true }), false);
  assert.equal(manual.postMortem(), null);
});

// ---------- the listing, and the double ----------

test('a board with no listing runtime makes no local subprocess', () => {
  const only = { ...ctx, cfg: { ...DEFAULT_BOARD, profiles: { claude: { mode: 'process', launch: ['true'] } } } };
  const h = listHandles(only);
  assert.deepEqual(h.all, []);
  assert.equal(h.byId.size, 0);
});

test('the fake runtime answers the listing, and stopHandle reaches the runtime that found it', (t) => {
  const rt = installRuntime({ handles: [{ id: 'f1', task: 7, raw: { id: 'f1', task: 7, ...parked } }] });
  t.after(rt.restore);
  const h = listHandles({ ...ctx, cfg: { ...DEFAULT_BOARD, profiles: { claude: { mode: 'process', launch: ['true'] } } } });
  assert.deepEqual(h.all.map((x) => x.id), ['f1']);
  assert.equal(h.byId.get('f1').status, 'waiting');
  assert.equal(stopHandle(ctx, h.all[0]), true);
  assert.deepEqual(rt.stops, [{ handle: 'f1', ok: true }]);
});

// ---------- a whole tick, with nothing spawned ----------

function harness({ host = 'test-host' } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hkb-runtime-'));
  const { gh, store, ctx: c, restore } = installDoubles((g) => ({
    root,
    cfg: {
      ...DEFAULT_BOARD,
      repo: g.nameWithOwner,
      board: 'default',
      profiles: { claude: { mode: 'claude-bg', max_in_progress: 2, model: null, allowed_tools: [], launch: ['claude', '--bg', '{prompt}'] } },
    },
    repo: { owner: g.owner, repo: g.repo, nameWithOwner: g.nameWithOwner },
    board: 'default',
    host,
    json: false,
    caps: {},
    _cache: {},
    requireBoard() { return this; },
  }), { board: 'default', host });
  const logs = [];
  return {
    gh, store, ctx: c, root,
    log: () => logs.join('\n'),
    tick: (opts = {}) => tick(c, { log: (m) => logs.push(m), ...opts }),
    cleanup: () => { restore(); fs.rmSync(root, { recursive: true, force: true }); },
  };
}

test('a tick claims and launches through the seam — no claude binary, no process, no worktree', async (t) => {
  const rt = installRuntime();
  const h = harness();
  t.after(() => { h.cleanup(); rt.restore(); });
  h.store.addIssue(kbIssue({ number: 7, status: 'ready', agent: 'claude' }));

  const s = await h.tick({ max: 1 });

  assert.deepEqual(s.claimed.map((c) => c.number), [7]);
  assert.deepEqual(rt.launches.map((l) => ({ task: l.task, attempt: l.attempt, profile: l.profile })), [{ task: 7, attempt: 1, profile: 'claude' }]);
  // the handle the double returned is what landed on the row
  const a = h.store.runOf(7).attempts.at(-1);
  assert.equal(a.pid, rt.launches[0].pid);
  assert.equal(h.store.statusOf(7), 'running');
  assert.match(h.log(), /#7: claimed attempt 1 → claude fake pid /);
});

test('a tick asks the seam about every running card, and writes off the one it calls crashed', async (t) => {
  const rt = installRuntime({ liveness: (a) => (a.attempt === 1 ? { alive: false, outcome: 'crashed' } : { alive: true }) });
  const h = harness();
  t.after(() => { h.cleanup(); rt.restore(); });
  h.store.addIssue(kbIssue({
    number: 7, status: 'running', agent: 'claude',
    kb: { max_runtime: 86_400 },
    run: { attempts: [{ attempt: 1, profile: 'claude', host: 'test-host', started_at: ago(600), heartbeat_at: ago(30), pid: 4242 }] },
  }));

  const s = await h.tick({ max: 0 });

  assert.deepEqual(s.reclaimed, [{ number: 7, outcome: 'crashed' }]);
  assert.deepEqual(rt.inspected.map((i) => i.attempt), [1]);
  assert.deepEqual(rt.stops.map((x) => x.attempt), [1]); // failAttempt ended it through the seam
  assert.equal(h.store.statusOf(7), 'ready');
});

test('a live handle is enough: a running card whose runtime says alive is left alone', async (t) => {
  const rt = installRuntime({ liveness: () => ({ alive: true, working: true }) });
  const h = harness();
  t.after(() => { h.cleanup(); rt.restore(); });
  h.store.addIssue(kbIssue({
    number: 7, status: 'running', agent: 'claude',
    kb: { max_runtime: 86_400 },
    // a heartbeat far past the idle threshold: only the live handle keeps this card
    run: { attempts: [{ attempt: 1, profile: 'claude', host: 'test-host', started_at: ago(3600), heartbeat_at: ago(3000), pid: 4242 }] },
  }));

  const s = await h.tick({ max: 0 });

  assert.deepEqual(s.reclaimed, []);
  assert.deepEqual(rt.stops, []);
  assert.equal(h.store.statusOf(7), 'running');
});
