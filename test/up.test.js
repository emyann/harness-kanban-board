// `hkb up` / `hkb down`: the already-running decision, the status shape, the log line, the env the
// detached child gets, and the signal `down` sends.
//
// The one thing a test must not do here is start a real dispatcher against a real board, so `up`'s
// spawn is injected (`deps.spawn`) and everything around it — the pid file, the log header, the argv,
// the scrubbed env — is asserted for real. `down` is the exception: it is tested against an actual
// child process, because "did the signal arrive" is the whole claim.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { up, down, statusReport, childArgv, hkbBin } from '../src/up.js';
import { claimServePid, portInUse } from '../src/serve.js';
import { pidFile, processState, recordExit, readExit } from '../src/board.js';
import {
  PROCESSES, detachedEnv, startDecision, processLine, startLogLine, formatSince, decidePermission, allowedCommandsFrom,
} from '../src/model.js';

const roots = [];
after(() => { for (const r of roots) fs.rmSync(r, { recursive: true, force: true }); });

function tmpRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hkb-up-'));
  fs.mkdirSync(path.join(root, '.kanban'), { recursive: true });
  roots.push(root);
  return root;
}

const ctxOf = (root, over = {}) => ({ root, board: 'default', json: false, cfg: { dispatch: { interval: 60 } }, ...over });

/** A spawn that records what it was asked to run and hands back a child whose pid is alive (ours). */
function fakeSpawn(pid = process.pid) {
  const calls = [];
  const fn = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    return { pid, on() {}, unref() { calls[calls.length - 1].unrefed = true; } };
  };
  fn.calls = calls;
  return fn;
}

const sink = () => { const lines = []; const out = (s) => lines.push(s); out.lines = lines; return out; };
const logText = (root, name) => fs.readFileSync(path.join(root, '.kanban', 'logs', `${name}.log`), 'utf8');

/** Run `fn` with a fixed zone: `since 19:02` is local time, and the suite must not read the runner's. */
function inZone(tz, fn) {
  const before = process.env.TZ;
  process.env.TZ = tz;
  try { return fn(); } finally { if (before === undefined) delete process.env.TZ; else process.env.TZ = before; }
}

// ---------- the pure parts ----------

test('the detached child inherits no worker identity', () => {
  const env = detachedEnv({
    PATH: '/usr/bin', HOME: '/home/you', KB_CONFIG_HOME: '/tmp/cfg',
    KB_TASK: '148', KB_ATTEMPT: '1', KB_BOARD: 'other', KB_PROFILE: 'claude', KB_ROOT: '/elsewhere', KB_LOCK_REF: 'refs/kb/locks/148/1',
  });
  assert.deepEqual(env, { PATH: '/usr/bin', HOME: '/home/you', KB_CONFIG_HOME: '/tmp/cfg' },
    'every KB_* but the config home is dropped: a loop that believes it is a worker refuses to run');
});

test('a live pid file is "already running", not a second loop', () => {
  const running = { name: 'dispatch', running: true, pid: 3843, since: '2026-08-28T19:02:00Z', log: '.kanban/logs/dispatch.log', exit: null, exited_at: null };
  const d = startDecision(running, { now: new Date('2026-08-28T19:30:00Z') });
  assert.equal(d.start, false);
  assert.match(d.line, /^dispatch already running pid 3843 since \d\d:\d\d · log \.kanban\/logs\/dispatch\.log$/);

  const stopped = { ...running, running: false, pid: null, since: null };
  assert.deepEqual(startDecision(stopped), { start: true, line: null });
});

test('one line per process: running, stopped, and the exit that asks for a supervisor', () => {
  inZone('UTC', () => {
    const now = new Date('2026-08-28T19:30:00Z');
    const base = { name: 'dispatch', log: '.kanban/logs/dispatch.log', exit: null, exited_at: null };
    assert.equal(
      processLine({ ...base, running: true, pid: 3843, since: '2026-08-28T19:02:00Z' }, { now }),
      'dispatch running pid 3843 since 19:02 · log .kanban/logs/dispatch.log');
    assert.equal(processLine({ ...base, name: 'serve', running: false, pid: null, since: null }, { now }), 'serve stopped');
    // exit 4 is the loop giving itself up: `up` reports it and names what would start a fresh one
    assert.equal(
      processLine({ ...base, running: false, pid: null, since: null, exit: 4, exited_at: '2026-08-28T19:02:00Z' }, { now }),
      'dispatch exited (4) at 19:02 — hkb up restarts it · log .kanban/logs/dispatch.log');
  });
});

test('a start that is not today carries its date, so "since 19:02" is never a lie', () => {
  inZone('UTC', () => {
    const now = new Date('2026-08-28T19:30:00Z');
    assert.equal(formatSince('2026-08-28T09:05:00Z', now), '09:05');
    assert.equal(formatSince('2026-08-25T09:05:00Z', now), '2026-08-25 09:05');
    assert.equal(formatSince(null, now), null);
    assert.equal(formatSince('not a date', now), null);
  });
});

test('the log header names the time, the pid and the command', () => {
  const line = startLogLine('2026-08-28T19:02:00.000Z', 3843, ['hkb', 'dispatch', '--loop', '60']);
  assert.equal(line, '# 2026-08-28T19:02:00.000Z started pid 3843 — hkb dispatch --loop 60\n');
});

test('the child command line: the board is explicit, the interval comes from board.json', () => {
  const ctx = ctxOf('/repo', { board: 'release' });
  assert.deepEqual(childArgv(ctx, 'dispatch', {}), ['dispatch', '--loop', '60', '--board', 'release']);
  assert.deepEqual(childArgv(ctx, 'dispatch', { loop: '30' }), ['dispatch', '--loop', '30', '--board', 'release']);
  assert.deepEqual(childArgv(ctx, 'dispatch', { loop: true }), ['dispatch', '--loop', '60', '--board', 'release']);
  assert.deepEqual(childArgv(ctx, 'serve', {}), ['serve', '--board', 'release']);
  assert.deepEqual(childArgv(ctx, 'serve', { port: '4700' }), ['serve', '--board', 'release', '--port', '4700']);
});

test('a flag that would only fail inside the child is refused here, before anything is spawned', () => {
  const ctx = ctxOf('/repo');
  for (const [flags, re] of [[{ loop: 'soon' }, /--loop/], [{ loop: '0' }, /--loop/]]) {
    assert.throws(() => childArgv(ctx, 'dispatch', flags), (e) => e.exitCode === 2 && re.test(e.message));
  }
  for (const flags of [{ port: 'http' }, { port: true }, { port: '99999' }]) {
    assert.throws(() => childArgv(ctx, 'serve', flags), (e) => e.exitCode === 2 && /--port/.test(e.message));
  }
});

test('the same binary that ran up is what the child runs', () => {
  const bin = hkbBin();
  assert.ok(path.isAbsolute(bin) && fs.existsSync(bin), `${bin} should be this package's own bin`);
  assert.equal(path.basename(bin), 'hkb.js');
});

// ---------- status ----------

test('a board nothing has started reports both processes stopped, with the logs they would use', () => {
  const ctx = ctxOf(tmpRoot());
  const s = statusReport(ctx);
  assert.deepEqual(Object.keys(s), PROCESSES);
  assert.deepEqual(s.dispatch, { name: 'dispatch', running: false, pid: null, since: null, log: path.join('.kanban', 'logs', 'dispatch.log'), exit: null, exited_at: null });
  assert.equal(s.serve.running, false);
});

test('a pid file is only believed while the process behind it is alive', () => {
  const root = tmpRoot();
  fs.writeFileSync(pidFile(root, 'dispatch'), `${process.pid}\n`);
  const live = processState(root, 'dispatch');
  assert.equal(live.running, true);
  assert.equal(live.pid, process.pid);
  assert.ok(!Number.isNaN(Date.parse(live.since)), 'since comes from the pid file, written as the process started');

  // a pid nothing answers for: stale file, stopped process — never "running"
  fs.writeFileSync(pidFile(root, 'dispatch'), '2147483646\n');
  assert.deepEqual(processState(root, 'dispatch').running, false);
});

test('the loop that gave itself up says so instead of reporting a plain "stopped"', () => {
  const root = tmpRoot();
  recordExit(root, 'dispatch', { code: 4, at: '2026-08-28T19:02:00Z', reason: 'claim came back unknown 5 ticks in a row' });
  const st = processState(root, 'dispatch');
  assert.equal(st.running, false);
  assert.equal(st.exit, 4);
  assert.match(processLine(st), /exited \(4\).*hkb up restarts it/);
});

test('up --status --json is the same shape, for a script', () => {
  const root = tmpRoot();
  fs.writeFileSync(pidFile(root, 'serve'), `${process.pid}\n`);
  const out = sink();
  assert.equal(up(ctxOf(root, { json: true }), { status: true }, out), 0);
  const j = JSON.parse(out.lines.join('\n'));
  assert.deepEqual(Object.keys(j), PROCESSES);
  assert.equal(j.serve.running, true);
  assert.equal(j.serve.pid, process.pid);
  assert.equal(j.dispatch.running, false);
  assert.equal(j.dispatch.log, path.join('.kanban', 'logs', 'dispatch.log'));
});

// ---------- up ----------

test('up starts the dispatcher detached, claims the pid file, and logs one header', () => {
  const root = tmpRoot();
  const ctx = ctxOf(root);
  const spawnFn = fakeSpawn();
  const out = sink();

  assert.equal(up(ctx, {}, out, { spawn: spawnFn }), 0);
  assert.equal(spawnFn.calls.length, 1, 'one child, the dispatcher — --serve is what asks for the second');
  const call = spawnFn.calls[0];
  assert.equal(call.cmd, process.execPath, 'the child runs under this node, not whatever is on PATH');
  assert.deepEqual(call.args, [hkbBin(), 'dispatch', '--loop', '60', '--board', 'default']);
  assert.equal(call.opts.cwd, root);
  assert.equal(call.opts.detached, true);
  assert.deepEqual(call.opts.stdio.length, 3);
  assert.equal(call.opts.stdio[0], 'ignore');
  assert.equal(call.opts.stdio[1], call.opts.stdio[2], 'stdout and stderr go to the one log');
  assert.equal(call.unrefed, true, 'unref, or `hkb up` never returns the terminal');

  assert.equal(fs.readFileSync(pidFile(root, 'dispatch'), 'utf8').trim(), String(process.pid));
  assert.match(logText(root, 'dispatch'), /^# \d{4}-\d\d-\d\dT[\d:.]+Z started pid \d+ — hkb dispatch --loop 60 --board default\n$/);
  assert.match(out.lines.join('\n'), /^dispatch started pid \d+ · log \.kanban\/logs\/dispatch\.log$/);
  assert.equal(fs.existsSync(pidFile(root, 'serve')), false, 'nothing started the board server');
});

test('the child is handed no KB_* but the config home', () => {
  const root = tmpRoot();
  const spawnFn = fakeSpawn();
  const before = { KB_TASK: process.env.KB_TASK, KB_ATTEMPT: process.env.KB_ATTEMPT };
  process.env.KB_TASK = '148';
  process.env.KB_ATTEMPT = '1';
  try {
    up(ctxOf(root), {}, sink(), { spawn: spawnFn });
  } finally {
    for (const [k, v] of Object.entries(before)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
  const env = spawnFn.calls[0].opts.env;
  assert.deepEqual(Object.keys(env).filter((k) => k.startsWith('KB_') && k !== 'KB_CONFIG_HOME'), [],
    'a session that believes it is a worker must not hand that belief to a daemon that outlives it');
  assert.equal(env.PATH, process.env.PATH);
});

test('up --serve twice: the second reports both already running and starts nothing', () => {
  const root = tmpRoot();
  const ctx = ctxOf(root);
  const spawnFn = fakeSpawn();

  const first = sink();
  up(ctx, { serve: true }, first, { spawn: spawnFn });
  assert.equal(spawnFn.calls.length, 2);
  assert.deepEqual(spawnFn.calls.map((c) => c.args[1]), ['dispatch', 'serve']);

  const second = sink();
  up(ctx, { serve: true }, second, { spawn: spawnFn });
  assert.equal(spawnFn.calls.length, 2, 'idempotent: a live pid file is not a reason to start a rival');
  assert.equal(second.lines.length, 2);
  for (const line of second.lines) assert.match(line, /already running pid \d+ since \d\d:\d\d/);
  for (const name of PROCESSES) {
    assert.equal(logText(root, name).split('started pid').length - 1, 1, `${name}.log has one header per start`);
  }
});

test('--port implies --serve, and up --json names what it started and what was already up', () => {
  const root = tmpRoot();
  const spawnFn = fakeSpawn();
  fs.writeFileSync(pidFile(root, 'dispatch'), `${process.pid}\n`); // a dispatcher is already up
  const out = sink();

  up(ctxOf(root, { json: true }), { port: '4700' }, out, { spawn: spawnFn });
  assert.deepEqual(spawnFn.calls.map((c) => c.args.slice(1)), [['serve', '--board', 'default', '--port', '4700']]);
  const j = JSON.parse(out.lines.join('\n'));
  assert.deepEqual(j.started, ['serve']);
  assert.deepEqual(j.already, ['dispatch']);
  assert.equal(j.serve.running, true);
  assert.equal(j.dispatch.running, true);
});

test('starting again clears the exit that was reported while nothing was running', () => {
  const root = tmpRoot();
  recordExit(root, 'dispatch', { code: 4, at: '2026-08-28T19:02:00Z', reason: 'gave itself up' });
  up(ctxOf(root), {}, sink(), { spawn: fakeSpawn() });
  assert.equal(readExit(root, 'dispatch'), null, 'a running loop is the news, not the last one\'s death');
  assert.equal(processState(root, 'dispatch').exit, null);
});

// ---------- down ----------

test('down signals what the pid file names and removes it', async () => {
  const root = tmpRoot();
  const ctx = ctxOf(root);
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve(signal || code)));
  fs.writeFileSync(pidFile(root, 'dispatch'), `${child.pid}\n`);

  const out = sink();
  assert.equal(down(ctx, {}, out), 0);
  assert.equal(await exited, 'SIGTERM');
  assert.equal(fs.existsSync(pidFile(root, 'dispatch')), false);
  assert.match(out.lines[0], /^dispatch stopping \(SIGTERM to pid \d+\) — the loop exits after its current tick; workers keep running$/);
  assert.equal(statusReport(ctx).dispatch.running, false, 'and a third --status says stopped');
});

test('down says so when there is nothing to stop, and points at the server it left alone', () => {
  const root = tmpRoot();
  fs.writeFileSync(pidFile(root, 'serve'), `${process.pid}\n`);
  const out = sink();
  down(ctxOf(root), {}, out);
  assert.deepEqual(out.lines, ['dispatch not running', `serve still running pid ${process.pid} — hkb down --serve stops it too`]);
  assert.equal(fs.existsSync(pidFile(root, 'serve')), true, 'down without --serve never touches the server');
});

test('down --json names what it stopped', () => {
  const root = tmpRoot();
  const out = sink();
  down(ctxOf(root, { json: true }), { serve: true }, out);
  const j = JSON.parse(out.lines.join('\n'));
  assert.deepEqual(j.stopped, []);
  assert.deepEqual(Object.keys(j), ['stopped', ...PROCESSES]);
});

// ---------- the one real spawn ----------

/**
 * Everything above injects the spawn. This one does not: it starts an actual detached child, and the
 * child is an actual `hkb dispatch` — pointed at a board.json with no `repo`, so the CLI refuses it in
 * milliseconds and no dispatcher tick ever happens. What it proves is the wiring a fake cannot: that
 * the argv runs, that the child's output lands in `.kanban/logs/dispatch.log`, and that `KB_TASK` did
 * not survive the trip — a child that inherited it would refuse with the worker guard's message
 * instead, which is exactly the daemon this scrubbing exists to prevent.
 */
test('the child really is this binary, really detached, and really not a worker', async () => {
  const root = tmpRoot();
  fs.writeFileSync(path.join(root, '.kanban', 'board.json'), JSON.stringify({ version: 1, board: 'default' }) + '\n');
  const before = process.env.KB_TASK;
  process.env.KB_TASK = '148';
  try { up(ctxOf(root), {}, sink()); } finally { if (before === undefined) delete process.env.KB_TASK; else process.env.KB_TASK = before; }

  const deadline = Date.now() + 20_000;
  let text = '';
  while (Date.now() < deadline) {
    text = logText(root, 'dispatch');
    if (/^hkb: /m.test(text)) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.match(text, /^# .* started pid \d+ — hkb dispatch --loop 60 --board default$/m);
  assert.match(text, /^hkb: .*has no "repo"/m, 'the child ran this binary and reported its own refusal into the log');
  assert.doesNotMatch(text, /you are worker for task/, 'KB_TASK must not survive into a process that outlives the session');
});

// ---------- the server's half of the pid protocol ----------

/** A live process that is not this one, for the checks that must distinguish "someone else" from "us". */
function sleeper(t) {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  t.after(() => child.kill('SIGKILL'));
  return child;
}

test('hkb serve claims the pid file it is stopped by, and never clobbers a live claim', (t) => {
  const root = tmpRoot();
  const drop = claimServePid(root, () => {});
  assert.equal(fs.readFileSync(pidFile(root, 'serve'), 'utf8').trim(), String(process.pid));
  drop();
  assert.equal(fs.existsSync(pidFile(root, 'serve')), false, 'the claim dies with the server that made it');

  // a second server, while the first is up: it says whose file it is rather than stealing it, so
  // `hkb down --serve` can never be pointed at the wrong process in silence
  const other = sleeper(t);
  fs.writeFileSync(pidFile(root, 'serve'), `${other.pid}\n`);
  const lines = [];
  claimServePid(root, (s) => lines.push(s));
  assert.equal(fs.readFileSync(pidFile(root, 'serve'), 'utf8').trim(), String(other.pid));
  assert.match(lines[0], /another hkb serve holds .*serve\.pid \(pid \d+\)/);
});

test('a taken port is only reported as "already up" when the pid file agrees', (t) => {
  const root = tmpRoot();
  assert.match(portInUse(root, 4666), /^port 4666 is already in use/, 'no pid file: it could be anything');

  fs.writeFileSync(pidFile(root, 'serve'), '2147483646\n'); // a pid nothing answers for
  assert.match(portInUse(root, 4666), /^port 4666 is already in use/);

  fs.writeFileSync(pidFile(root, 'serve'), `${sleeper(t).pid}\n`);
  assert.match(portInUse(root, 4666), /^hkb serve is already up on port 4666 \(pid \d+\)/);
});

// ---------- the worker guard ----------

test('a worker may not start or stop the dispatcher either', () => {
  const ctx = { allowedCmds: allowedCommandsFrom(['Bash(hkb *)', 'Bash(node *)']), root: '/repo' };
  const decide = (command) => decidePermission('Bash', { command }, ctx).decision;
  assert.equal(decide('hkb up --serve'), 'deny');
  assert.equal(decide('hkb down'), 'deny');
  assert.equal(decide('hkb dispatch --loop 60'), 'deny');
  // and nothing else that merely starts with those letters
  assert.equal(decide('hkb unblock 5'), 'allow');
  assert.equal(decide('hkb update-nothing'), 'allow');
  assert.equal(decide('hkb show 5 --json'), 'allow');
});
