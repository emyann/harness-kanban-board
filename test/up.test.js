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
import { loop } from '../src/dispatch.js';
import { pidFile, processState, readPidFile, recordExit, readExit, DEFAULT_BOARD } from '../src/board.js';
import { FakeGh, kbIssue } from './fake-gh.js';
import {
  PROCESSES, detachedEnv, startDecision, processLine, startLogLine, formatSince, decidePermission,
  allowedCommandsFrom, pidFileStale, stopWaitMs, PID_BOOT_SLACK_MS,
  pidClaimStale, cmdlineIsOurs, bootInstantMs, parseBtimeSec, parseKernBoottimeSec,
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

/** `up`'s post-spawn liveness recheck, with the 300ms wait taken out of the suite's way. */
const upDeps = (spawn) => ({ spawn, spawnCheckMs: 0 });

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
  assert.deepEqual(s.dispatch, { name: 'dispatch', running: false, pid: null, since: null, stale: false, log: path.join('.kanban', 'logs', 'dispatch.log'), exit: null, exited_at: null });
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

/**
 * `.kanban/*.pid` is a plain file: it survives a reboot, and after one the pid it names belongs to
 * whatever the kernel handed it to next. `pidAlive` would say "running" and `hkb down` would SIGTERM
 * a stranger. The guard is arithmetic — written before the boot means written by a dead machine.
 */
test('a pid file that predates the boot names a stranger, not a dispatcher', () => {
  const now = Date.parse('2026-08-28T19:30:00Z');
  const uptime = 3600; // up for an hour: booted at 18:30
  assert.equal(pidFileStale('2026-08-28T19:02:00Z', { now, uptime }), false, 'written after the boot: a real claim');
  assert.equal(pidFileStale('2026-08-28T17:55:00Z', { now, uptime }), true, 'written before it: a claim on a reissued pid');
  // the two clocks disagree (mtime is wall time, uptime is monotonic), and the slack errs towards
  // believing a pid file — calling a live dispatcher stale is how you get two loops
  assert.equal(pidFileStale(new Date(now - uptime * 1000 - PID_BOOT_SLACK_MS + 1).toISOString(), { now, uptime }), false);
  assert.equal(pidFileStale(null, { now, uptime }), false);
  assert.equal(pidFileStale('2026-08-20T00:00:00Z', { now, uptime: 0 }), false, 'no uptime to compare against: believe the file');
});

test('bootInstantMs prefers a kernel-reported btime over the derived now - uptime', () => {
  const now = Date.parse('2026-08-28T19:30:00Z');
  assert.equal(bootInstantMs({ uptime: 3600, now }), now - 3600_000, 'no btime: derive it');
  assert.equal(bootInstantMs({ btimeSec: 1000, uptime: 3600, now }), 1000_000, 'btime wins when there is one');
  assert.equal(bootInstantMs({ now }), null, 'no evidence at all: no verdict');
});

test('parseBtimeSec / parseKernBoottimeSec read the boot instant out of real tool output', () => {
  assert.equal(parseBtimeSec('cpu  1 2 3\nbtime 1690000000\nprocesses 4\n'), 1690000000);
  assert.equal(parseBtimeSec('nothing here'), null);
  assert.equal(parseKernBoottimeSec('{ sec = 1690000000, usec = 123456 } Wed Jul ...'), 1690000000);
  assert.equal(parseKernBoottimeSec(''), null);
});

test('cmdlineIsOurs matches our own long-running processes and nothing else', () => {
  assert.equal(cmdlineIsOurs(['node', '/x/bin/hkb.js', 'dispatch', '--loop', '60', '--board', 'default'].join('\0'), 'dispatch'), true);
  assert.equal(cmdlineIsOurs(['node', '/x/bin/hkb.js', 'serve', '--board', 'default'].join('\0'), 'serve'), true);
  assert.equal(cmdlineIsOurs(['node', '--test', 'test/up.test.js'].join('\0'), 'dispatch'), false, 'some other process entirely');
  assert.equal(cmdlineIsOurs(['node', '/x/bin/hkb.js', 'dispatch'].join('\0'), 'dispatch'), false, 'dispatch without --loop is a one-shot tick, not the daemon');
  assert.equal(cmdlineIsOurs(null, 'dispatch'), null, 'nothing to check against');
  assert.equal(cmdlineIsOurs('', 'dispatch'), null);
});

/**
 * The bug this task fixes: on WSL2 the wall clock resyncs against the Windows host across
 * suspend/resume while `/proc/uptime` keeps counting on its own, so the derived boot instant walks
 * forward past a pid file `hkb up` itself wrote earlier in the same session — `pidFileStale` alone
 * says stale. Corroboration rescues it: the pid is alive and its `/proc/<pid>/cmdline` still says
 * `hkb dispatch --loop`, so whatever the arithmetic concluded, this is our claim.
 */
test('pidClaimStale: a live pid whose cmdline is still ours is never stale, however the clock skewed', () => {
  const uptime = 2054.62; // 34m14.62s up
  const now = Date.parse('2026-09-01T17:42:32Z') + uptime * 1000; // derived boot = 17:42:32
  const at = '2026-09-01T17:32:37Z'; // written 10 minutes "before boot" per the arithmetic
  assert.equal(pidFileStale(at, { now, uptime }), true, 'the arithmetic alone gets this wrong');
  const ours = pidClaimStale({
    at, name: 'dispatch', alive: true, cmdline: ['node', '/x/bin/hkb.js', 'dispatch', '--loop', '60', '--board', 'default'].join('\0'),
    now, uptime,
  });
  assert.equal(ours, false, 'corroborated: this is our own dispatcher, believed despite the skew');
});

test('pidClaimStale: a live pid that does NOT corroborate stays refused — the #202 reused-pid case', () => {
  const now = Date.parse('2026-08-28T19:30:00Z');
  const uptime = 3600; // booted 18:30, genuinely
  const at = '2026-08-28T17:55:00Z'; // written before that real boot
  const reissued = pidClaimStale({
    at, name: 'dispatch', alive: true, cmdline: ['some-other-daemon', '--flag'].join('\0'), now, uptime,
  });
  assert.equal(reissued, true, 'the kernel handed this pid to a stranger; still refused');
});

test('pidClaimStale: with no /proc to corroborate against (macOS), the timestamp verdict stands', () => {
  const uptime = 2054.62;
  const now = Date.parse('2026-09-01T17:42:32Z') + uptime * 1000;
  const at = '2026-09-01T17:32:37Z';
  assert.equal(pidClaimStale({ at, name: 'dispatch', alive: true, cmdline: null, now, uptime }), true);
});

test('pidClaimStale never manufactures staleness the timestamp verdict did not already reach', () => {
  const now = Date.parse('2026-08-28T19:30:00Z');
  const uptime = 3600;
  const at = '2026-08-28T19:02:00Z'; // written after boot: arithmetic already believes it
  // an unrelated cmdline (or none at all) must not override a verdict that was already "not stale" —
  // corroboration only ever rescues, never revokes
  assert.equal(pidClaimStale({ at, name: 'dispatch', alive: true, cmdline: 'some-other-daemon', now, uptime }), false);
  assert.equal(pidClaimStale({ at, name: 'dispatch', alive: false, cmdline: null, now, uptime }), false);
});

test('readPidFile: /proc corroboration rescues a live pid the timestamp alone would call stale', () => {
  const root = tmpRoot();
  const proc = fs.mkdtempSync(path.join(os.tmpdir(), 'hkb-proc-'));
  try {
    fs.writeFileSync(pidFile(root, 'dispatch'), `${process.pid}\n`);
    fs.utimesSync(pidFile(root, 'dispatch'), new Date(0), new Date(0)); // 1970: arithmetic alone calls this stale
    fs.mkdirSync(path.join(proc, String(process.pid)), { recursive: true });
    fs.writeFileSync(path.join(proc, String(process.pid), 'cmdline'), ['node', 'bin/hkb.js', 'dispatch', '--loop', '60'].join('\0'));

    assert.equal(readPidFile(root, 'dispatch', { proc: path.join(proc, 'nope') }).stale, true, 'no /proc to corroborate against: the timestamp verdict stands');
    assert.equal(readPidFile(root, 'dispatch', { proc }).stale, false, "corroborated our own dispatcher: believed despite the file's age");
  } finally { fs.rmSync(proc, { recursive: true, force: true }); }
});

test('a stale pid file reports stopped, and says why the file is there', () => {
  const root = tmpRoot();
  fs.writeFileSync(pidFile(root, 'dispatch'), `${process.pid}\n`);
  fs.utimesSync(pidFile(root, 'dispatch'), new Date(0), new Date(0)); // 1970: before every boot there has been
  const st = processState(root, 'dispatch');
  assert.equal(st.stale, true);
  assert.equal(st.running, false, 'this pid is alive, and that is exactly the trap');
  assert.equal(st.pid, null);
  assert.equal(processLine(st), 'dispatch stopped (pid file predates this boot — hkb up replaces it)');
});

test('hkb down leaves a stale pid file alone rather than signalling whoever holds that pid now', async () => {
  const root = tmpRoot();
  fs.writeFileSync(pidFile(root, 'dispatch'), `${process.pid}\n`);
  fs.utimesSync(pidFile(root, 'dispatch'), new Date(0), new Date(0));
  const out = sink();
  const kill = () => assert.fail('down must not signal a pid a reboot invalidated');
  assert.equal(await down(ctxOf(root), {}, out, { kill }), 0);
  assert.match(out.lines[0], /^dispatch stopped \(pid file predates this boot/);
});

/**
 * `down` tidies a stale pid file in the same branch (it is never running, so never signalled) — the
 * line right after that removal must say "removed", not the `hkb up replaces it` `processLine` uses
 * for the read-only `--status` view, where nothing was actually touched.
 */
test('down says "removed" for a stale pid file it just removed', async () => {
  const root = tmpRoot();
  fs.writeFileSync(pidFile(root, 'dispatch'), `${process.pid}\n`);
  fs.utimesSync(pidFile(root, 'dispatch'), new Date(0), new Date(0));
  const out = sink();
  assert.equal(await down(ctxOf(root), {}, out), 0);
  assert.equal(out.lines[0], 'dispatch stopped (pid file predates this boot — removed)');
  assert.equal(fs.existsSync(pidFile(root, 'dispatch')), false, 'down actually removed it, so the line says so');
});

test('how long down waits: two of the loop\'s own intervals, floored and capped', () => {
  assert.equal(stopWaitMs(60), 120_000);
  assert.equal(stopWaitMs(1), 5_000, 'a fast board still gets a fair wait');
  assert.equal(stopWaitMs(600), 120_000, 'and down never becomes the thing that hangs');
  assert.equal(stopWaitMs(undefined), 5_000);
});

test('the loop that gave itself up says so instead of reporting a plain "stopped"', () => {
  const root = tmpRoot();
  recordExit(root, 'dispatch', { code: 4, at: '2026-08-28T19:02:00Z', reason: 'claim came back unknown 5 ticks in a row' });
  const st = processState(root, 'dispatch');
  assert.equal(st.running, false);
  assert.equal(st.exit, 4);
  assert.match(processLine(st), /exited \(4\).*hkb up restarts it/);
});

test('up --status --json is the same shape, for a script', async () => {
  const root = tmpRoot();
  fs.writeFileSync(pidFile(root, 'serve'), `${process.pid}\n`);
  const out = sink();
  assert.equal(await up(ctxOf(root, { json: true }), { status: true }, out), 0);
  const j = JSON.parse(out.lines.join('\n'));
  assert.deepEqual(Object.keys(j), PROCESSES);
  assert.equal(j.serve.running, true);
  assert.equal(j.serve.pid, process.pid);
  assert.equal(j.dispatch.running, false);
  assert.equal(j.dispatch.log, path.join('.kanban', 'logs', 'dispatch.log'));
});

// ---------- up ----------

test('up starts the dispatcher detached, claims the pid file, and logs one header', async () => {
  const root = tmpRoot();
  const ctx = ctxOf(root);
  const spawnFn = fakeSpawn();
  const out = sink();

  assert.equal(await up(ctx, {}, out, upDeps(spawnFn)), 0);
  assert.equal(spawnFn.calls.length, 1, 'one child, the dispatcher — --serve is what asks for the second');
  const call = spawnFn.calls[0];
  assert.equal(call.cmd, process.execPath, 'the child runs under this node, not whatever is on PATH');
  assert.deepEqual(call.args, [hkbBin(), 'dispatch', '--loop', '60', '--board', 'default']);
  assert.equal(call.opts.cwd, root);
  assert.equal(call.opts.detached, true);
  assert.equal(call.opts.windowsHide, true, 'no console window flashes up on Windows');
  assert.deepEqual(call.opts.stdio.length, 3);
  assert.equal(call.opts.stdio[0], 'ignore');
  assert.equal(call.opts.stdio[1], call.opts.stdio[2], 'stdout and stderr go to the one log');
  assert.equal(call.unrefed, true, 'unref, or `hkb up` never returns the terminal');

  assert.equal(fs.readFileSync(pidFile(root, 'dispatch'), 'utf8').trim(), String(process.pid));
  assert.match(logText(root, 'dispatch'), /^# \d{4}-\d\d-\d\dT[\d:.]+Z started pid \d+ — hkb dispatch --loop 60 --board default\n$/);
  assert.match(out.lines.join('\n'), /^dispatch started pid \d+ · log \.kanban\/logs\/dispatch\.log$/);
  assert.equal(fs.existsSync(pidFile(root, 'serve')), false, 'nothing started the board server');
});

test('the child is handed no KB_* but the config home', async () => {
  const root = tmpRoot();
  const spawnFn = fakeSpawn();
  const before = { KB_TASK: process.env.KB_TASK, KB_ATTEMPT: process.env.KB_ATTEMPT };
  process.env.KB_TASK = '148';
  process.env.KB_ATTEMPT = '1';
  try {
    await up(ctxOf(root), {}, sink(), upDeps(spawnFn));
  } finally {
    for (const [k, v] of Object.entries(before)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
  const env = spawnFn.calls[0].opts.env;
  assert.deepEqual(Object.keys(env).filter((k) => k.startsWith('KB_') && k !== 'KB_CONFIG_HOME'), [],
    'a session that believes it is a worker must not hand that belief to a daemon that outlives it');
  assert.equal(env.PATH, process.env.PATH);
});

test('up --serve twice: the second reports both already running and starts nothing', async () => {
  const root = tmpRoot();
  const ctx = ctxOf(root);
  const spawnFn = fakeSpawn();

  const first = sink();
  await up(ctx, { serve: true }, first, upDeps(spawnFn));
  assert.equal(spawnFn.calls.length, 2);
  assert.deepEqual(spawnFn.calls.map((c) => c.args[1]), ['dispatch', 'serve']);

  const second = sink();
  await up(ctx, { serve: true }, second, upDeps(spawnFn));
  assert.equal(spawnFn.calls.length, 2, 'idempotent: a live pid file is not a reason to start a rival');
  assert.equal(second.lines.length, 2);
  for (const line of second.lines) assert.match(line, /already running pid \d+ since \d\d:\d\d/);
  for (const name of PROCESSES) {
    assert.equal(logText(root, name).split('started pid').length - 1, 1, `${name}.log has one header per start`);
  }
});

test('--port implies --serve, and up --json names what it started and what was already up', async () => {
  const root = tmpRoot();
  const spawnFn = fakeSpawn();
  fs.writeFileSync(pidFile(root, 'dispatch'), `${process.pid}\n`); // a dispatcher is already up
  const out = sink();

  await up(ctxOf(root, { json: true }), { port: '4700' }, out, upDeps(spawnFn));
  assert.deepEqual(spawnFn.calls.map((c) => c.args.slice(1)), [['serve', '--board', 'default', '--port', '4700']]);
  const j = JSON.parse(out.lines.join('\n'));
  assert.deepEqual(j.started, ['serve']);
  assert.deepEqual(j.already, ['dispatch']);
  assert.equal(j.serve.running, true);
  assert.equal(j.dispatch.running, true);
});

test('starting again clears the exit that was reported while nothing was running', async () => {
  const root = tmpRoot();
  recordExit(root, 'dispatch', { code: 4, at: '2026-08-28T19:02:00Z', reason: 'gave itself up' });
  await up(ctxOf(root), {}, sink(), upDeps(fakeSpawn()));
  assert.equal(readExit(root, 'dispatch'), null, 'a running loop is the news, not the last one\'s death');
  assert.equal(processState(root, 'dispatch').exit, null);
});

/**
 * "started pid 3843" about a process that died in the same millisecond is worse than an error: the
 * operator walks away believing the board is up. One recheck, a beat later, turns it into a line that
 * names the log holding the reason.
 */
test('up looks again a beat later, and does not claim to have started a corpse', async () => {
  const root = tmpRoot();
  const dead = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  await new Promise((r) => dead.on('exit', r));
  const out = sink();
  const code = await up(ctxOf(root), {}, out, upDeps(fakeSpawn(dead.pid)));
  assert.match(out.lines[0], /^dispatch exited immediately \(pid \d+\) — see \.kanban[/\\]logs[/\\]dispatch\.log$/);
  assert.equal(code, 1, 'a corpse in `started` is a clean run for a board that is not up (#164)');
});

/**
 * The bug the second-pass review of #151 measured (#164): `hkb up --serve --port 80` on a refused
 * port died at the recheck, but still went into `started`, exit 0, no `--json` error field — a script
 * that only reads `started`/exit-code sees a board that is up. The loop half still starts and reports
 * fine next to it.
 */
test('a child dead at the recheck is `failed`, not `started`, under both outputs — and up exits 1', async () => {
  const root = tmpRoot();
  const dead = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  await new Promise((r) => dead.on('exit', r));
  const alive = process.pid;
  const pids = [alive, dead.pid]; // dispatch starts fine; serve is the one that dies
  const spawnFn = () => ({ pid: pids.shift(), on() {}, unref() {} });

  const out = sink();
  const code = await up(ctxOf(root, { json: true }), { serve: true }, out, upDeps(spawnFn));
  assert.equal(code, 1);
  const j = JSON.parse(out.lines.join('\n'));
  assert.deepEqual(j.started, ['dispatch']);
  assert.deepEqual(j.failed, [{ name: 'serve', pid: dead.pid, log: path.join('.kanban', 'logs', 'serve.log') }]);
  assert.equal(j.dispatch.running, true, 'the loop half still started');
  assert.equal(j.serve.running, false);

  const human = sink();
  const humanCode = await up(ctxOf(root), { serve: true }, human, upDeps(() => ({ pid: dead.pid, on() {}, unref() {} })));
  assert.equal(humanCode, 1);
});

/**
 * `up` owns the claim it just wrote for the child it spawned, and has just verified that pid dead —
 * leaving `serve.pid` naming the corpse it reported as `failed` is the same stray-claim bug as `down`
 * not tidying one, just on the writer's side of it (#177).
 */
test('up --serve --port 80 leaves no serve.pid when the child dies at the recheck; --status says stopped', async () => {
  const root = tmpRoot();
  const dead = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  await new Promise((r) => dead.on('exit', r));
  const pids = [process.pid, dead.pid]; // dispatch starts fine; serve is the one that dies
  const spawnFn = () => ({ pid: pids.shift(), on() {}, unref() {} });

  const out = sink();
  const code = await up(ctxOf(root), { serve: true, port: 80 }, out, upDeps(spawnFn));
  assert.equal(code, 1);
  assert.equal(fs.existsSync(pidFile(root, 'serve')), false, 'up must not leave serve.pid naming the corpse it just reported as failed');

  const status = sink();
  await up(ctxOf(root), { status: true }, status);
  assert.equal(status.lines[1], 'serve stopped');
});

test('a rival up that got there first keeps the pid file, and the loser says so', async () => {
  const root = tmpRoot();
  const other = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  after(() => other.kill('SIGKILL'));
  // the spawn "wins" the race for the file a millisecond before this one claims it
  const spawnFn = () => {
    fs.writeFileSync(pidFile(root, 'dispatch'), `${other.pid}\n`);
    return { pid: process.pid, on() {}, unref() {} };
  };
  const out = sink();
  await up(ctxOf(root), {}, out, { spawn: spawnFn, spawnCheckMs: 0 });
  assert.match(out.lines[0], /^dispatch started pid \d+, but .*dispatch\.pid names pid \d+ — one of the two will be refused/);
  assert.equal(readPidFile(root, 'dispatch').pid, other.pid, 'the winner keeps the claim; the loser is what the singleton lock refuses');
});

// ---------- down ----------

test('down signals what the pid file names, waits for it to be gone, and only then tidies the file', async () => {
  const root = tmpRoot();
  const ctx = ctxOf(root);
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve(signal || code)));
  fs.writeFileSync(pidFile(root, 'dispatch'), `${child.pid}\n`);

  const out = sink();
  assert.equal(await down(ctx, {}, out), 0);
  assert.equal(await exited, 'SIGTERM');
  assert.equal(fs.existsSync(pidFile(root, 'dispatch')), false, 'a file naming a dead pid helps nobody');
  assert.match(out.lines[0], /^dispatch stopped \(SIGTERM to pid \d+\); workers keep running$/);
  assert.equal(statusReport(ctx).dispatch.running, false, 'and a third --status says stopped');
});

/**
 * The bug this whole pass exists for. `down` used to SIGTERM and `rmSync` the pid file in the same
 * breath, so `hkb down && hkb up` started a second loop next to a first that was still finishing a
 * tick — the singleton lock never saw it, because the lock is that file. `down` must not report
 * "stopped", and must not drop the claim, while the process it signalled is alive.
 */
test('down never reports stopped while the process is still up, and leaves the claim standing', async () => {
  const root = tmpRoot();
  // a child that ignores SIGTERM: the dispatcher asleep mid-tick, in the small
  const child = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdio: 'ignore' });
  after(() => child.kill('SIGKILL'));
  await new Promise((r) => setTimeout(r, 200)); // let the handler be installed
  fs.writeFileSync(pidFile(root, 'dispatch'), `${child.pid}\n`);

  const out = sink();
  const ctx = ctxOf(root);
  // the real budget is two of the loop's intervals (`stopWaitMs`, asserted above); one second here is
  // the same code path with the waiting taken out of the suite's way
  assert.equal(await down(ctx, {}, out, { waitMs: 1000, pollMs: 20 }), 1, 'a give-up is not a success');
  assert.match(out.lines[0], /^dispatch: pid \d+ still running 1s after SIGTERM — a tick in flight finishes first/);
  assert.equal(readPidFile(root, 'dispatch').pid, child.pid, 'the claim is true, so it stands: the next hkb up must find it');
  assert.equal(statusReport(ctx).dispatch.running, true, 'and --status agrees rather than lying about it');
});

/**
 * `down` on a pid file naming a process that is simply dead (crashed without dropping its own claim)
 * used to say "not running" and leave the file — the next `hkb up --status` kept reporting the same
 * stale claim forever. `down` tidies it, same as it tidies the file of a process it watched die (#164).
 */
test('down tidies a pid file whose process is already dead, even though there was nothing to signal', async () => {
  const root = tmpRoot();
  fs.writeFileSync(pidFile(root, 'dispatch'), '2147483646\n'); // a pid nothing answers for
  const out = sink();
  assert.equal(await down(ctxOf(root), {}, out), 0);
  assert.equal(out.lines[0], 'dispatch not running');
  assert.equal(fs.existsSync(pidFile(root, 'dispatch')), false, 'a dead claim helps nobody');
});

/**
 * The invariant the file header states: a pid file is never dropped while it names something alive.
 * `down` takes its `processState` snapshot, sees the pid dead, and is about to tidy the file — but a
 * concurrent `hkb up` (or the child's own `claimServePid`/`acquireLoopLock`) can have rewritten it to a
 * fresh live pid in the meantime. The fresh, guarded read `down` does right before `rmSync` must see
 * that write and leave the claim standing (#177).
 */
test('down never drops a pid file a rival rewrote to a live pid between the state read and the tidy', async () => {
  const root = tmpRoot();
  fs.writeFileSync(pidFile(root, 'dispatch'), '2147483646\n'); // dead at the processState read
  const out = sink();
  const readPidFileRacy = (r, name) => {
    fs.writeFileSync(pidFile(r, name), `${process.pid}\n`); // a rival claims it right before the tidy's read
    return readPidFile(r, name);
  };
  assert.equal(await down(ctxOf(root), {}, out, { readPidFile: readPidFileRacy }), 0);
  assert.equal(out.lines[0], 'dispatch not running');
  assert.equal(readPidFile(root, 'dispatch').pid, process.pid, 'the fresh claim survives the tidy it raced');
});

/**
 * A kill that throws ESRCH means the process died between `processState`'s liveness check and this
 * signal — `down` was asked for it to be gone, and it is. That is `stopped`, not `failed` (#164).
 */
test('a kill that races the process\'s own death (ESRCH) counts as stopped, not failed', async () => {
  const root = tmpRoot();
  fs.writeFileSync(pidFile(root, 'dispatch'), `${process.pid}\n`); // alive, so down gets as far as the signal
  const out = sink();
  const kill = () => { throw Object.assign(new Error('no such process'), { code: 'ESRCH' }); };
  assert.equal(await down(ctxOf(root, { json: true }), {}, out, { kill }), 0);
  const j = JSON.parse(out.lines.join('\n'));
  assert.deepEqual(j.stopped, [{ name: 'dispatch', pid: process.pid }]);
  assert.deepEqual(j.failed, []);
  assert.equal(fs.existsSync(pidFile(root, 'dispatch')), false, 'the claim died with the process; nothing left to tidy later');

  fs.writeFileSync(pidFile(root, 'dispatch'), `${process.pid}\n`);
  const human = sink();
  await down(ctxOf(root), {}, human, { kill });
  assert.match(human.lines[0], /^dispatch stopped \(SIGTERM to pid \d+\); workers keep running$/);
});

test('down says so when there is nothing to stop, and points at the server it left alone', async () => {
  const root = tmpRoot();
  fs.writeFileSync(pidFile(root, 'serve'), `${process.pid}\n`);
  const out = sink();
  await down(ctxOf(root), {}, out);
  assert.deepEqual(out.lines, ['dispatch not running', `serve still running pid ${process.pid} — hkb down --serve stops it too`]);
  assert.equal(fs.existsSync(pidFile(root, 'serve')), true, 'down without --serve never touches the server');
});

test('down --json names what it stopped and what it could not', async () => {
  const root = tmpRoot();
  const out = sink();
  assert.equal(await down(ctxOf(root, { json: true }), { serve: true }, out), 0);
  const j = JSON.parse(out.lines.join('\n'));
  assert.deepEqual(j.stopped, []);
  assert.deepEqual(j.failed, []);
  assert.deepEqual(Object.keys(j), ['stopped', 'failed', ...PROCESSES]);
});

/**
 * A signal that throws used to leave `--json` saying `{stopped: [], ...}` and exit 0 — the human line
 * said "stop it yourself" and the script that read the JSON saw a clean run. Whatever `down` could
 * not do belongs in the payload and in the exit code.
 */
test('down --json reports a signal it could not send, and exits non-zero', async () => {
  const root = tmpRoot();
  fs.writeFileSync(pidFile(root, 'dispatch'), `${process.pid}\n`); // alive, so down gets as far as the signal
  const out = sink();
  // the kill is injected rather than aimed at a real process nobody owns: EPERM is what a pid the
  // operator may not signal answers, and the point of the test is what `down` does about it
  const kill = () => { throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' }); };
  assert.equal(await down(ctxOf(root, { json: true }), {}, out, { kill }), 1);
  const j = JSON.parse(out.lines.join('\n'));
  assert.deepEqual(j.stopped, []);
  assert.deepEqual(j.failed, [{ name: 'dispatch', pid: process.pid, error: 'EPERM' }]);
  assert.equal(readPidFile(root, 'dispatch').pid, process.pid, 'a claim down could not act on is not a claim it may delete');

  const human = sink();
  await down(ctxOf(root), {}, human, { kill });
  assert.match(human.lines[0], /^dispatch: could not signal pid \d+ \(EPERM\) — stop it yourself; .*dispatch\.pid still names it$/);
});

// ---------- the other half of down: the loop has to be able to hear it ----------

/**
 * The measured bug (#151 review): a loop asleep in `sleeper(interval)` used to notice a SIGTERM only
 * after its *next* tick — up to a whole interval later. `down` reported it stopped, `up` started its
 * replacement, and two dispatchers ran the same board side by side while the singleton lock (which is
 * that pid file) watched. Waiting in `down` is half the fix; hearing the signal is the other half.
 */
test('SIGTERM lands in the sleep, and the loop leaves from there — not through another tick', async (t) => {
  const gh = new FakeGh();
  gh.addIssue(kbIssue({ number: 1, title: 'a card nobody claims', status: 'todo' }));
  t.after(gh.install());
  const root = tmpRoot();
  const mine = new Set(process.listeners('SIGTERM'));
  t.after(() => { for (const l of process.listeners('SIGTERM')) if (!mine.has(l)) process.removeListener('SIGTERM', l); });

  const ctx = {
    root,
    cfg: { ...DEFAULT_BOARD, repo: gh.nameWithOwner, version_check: false, profiles: {} },
    repo: { owner: gh.owner, repo: gh.repo, nameWithOwner: gh.nameWithOwner },
    board: 'default', host: 'test-host', json: false, caps: {}, _cache: {}, requireBoard() { return this; },
  };

  const lines = [];
  let sleeps = 0;
  const sleeper = () => new Promise(() => { sleeps++; }); // a wait nothing but the signal can end
  const running = loop(ctx, { interval: 60, max: Infinity, log: (s) => lines.push(s), sleeper });

  const deadline = Date.now() + 20_000;
  while (!sleeps && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
  assert.equal(sleeps, 1, 'the loop ran its tick and is now in the wait');
  process.emit('SIGTERM');
  await running;

  assert.equal(lines.filter((l) => l.startsWith('tick:')).length, 1, 'one tick — the signal did not buy a second');
  assert.ok(lines.some((l) => l.startsWith('stopping now')), `the log says it left the sleep: ${lines.join(' | ')}`);
  assert.equal(fs.existsSync(pidFile(root, 'dispatch')), false, 'and it dropped its own claim on the way out, which is what down waits for');
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
  try { await up(ctxOf(root), {}, sink()); } finally { if (before === undefined) delete process.env.KB_TASK; else process.env.KB_TASK = before; }

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
