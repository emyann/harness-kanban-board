// `hkb up` / `hkb down` — the two long-running processes of a board, started and stopped as a verb.
//
// A board that is meant to keep moving needs a dispatcher loop, and usually the web board next to it.
// Before this, starting them was a shell recipe: `ps`/`ss` to learn whether they were already up, then
// `setsid nohup node bin/hkb.js dispatch --loop 60 > somewhere.log 2>&1 < /dev/null &` — different on
// every machine, unwritable for a harness that vets a command line word by word (`nohup`, `&`, the
// redirections), and logs wherever the operator happened to be standing.
//
// Everything that decides anything is pure and lives in model.js (`startDecision`, `processLine`,
// `startLogLine`, `detachedEnv`); everything that reads a pid file is board.js (`processState`). What
// is left here is the spawn, the log and the signal.
//
// `up` is NOT a supervisor. It never restarts, never polls, never forks a watchdog: exit code 4 stays
// what it is — the loop giving itself up for a supervisor (cron, systemd, Actions, a human) to start a
// fresh one — and `hkb up --status` reports that exit so an operator session can see it in one call.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  ensureLocalDirs, pidFile, processLogFile, processState, readPidFile, pidAlive, clearExit,
} from './board.js';
import { PROCESSES, detachedEnv, startDecision, processLine, startLogLine } from './model.js';

const usage = (msg) => { const e = new Error(msg); e.exitCode = 2; return e; };
const nowIso = () => new Date().toISOString();

/**
 * The binary the child runs: this package's own `bin/hkb.js`, resolved from this module, under the
 * `node` that is running now. So a checkout starts the checkout's dispatcher and a global install
 * starts the global one — no PATH lookup, and no way for `hkb up` in a source tree to hand the board
 * to whatever `hkb` a login shell happens to find. (`process.argv[1]` would usually say the same
 * thing, but not when hkb is driven as a library, through a loader, or under `node --test`.)
 */
export function hkbBin() { return fileURLToPath(new URL('../bin/hkb.js', import.meta.url)); }

/** The command line `hkb up` gives each child. `--board` is explicit because `KB_BOARD` is scrubbed. */
export function childArgv(ctx, name, flags = {}) {
  if (name === 'dispatch') return ['dispatch', '--loop', String(loopInterval(ctx, flags)), '--board', ctx.board];
  const argv = ['serve', '--board', ctx.board];
  if (flags.port !== undefined) argv.push('--port', String(port(flags)));
  return argv;
}

function loopInterval(ctx, flags) {
  if (flags.loop === undefined || flags.loop === true) return ctx.cfg.dispatch.interval;
  const n = Number(flags.loop);
  if (!Number.isInteger(n) || n <= 0) throw usage(`--loop must be a number of seconds, got "${flags.loop}"`);
  return n;
}

function port(flags) {
  if (flags.port === true) throw usage('--port needs a value, e.g. --port 4666');
  const n = Number(flags.port);
  if (!Number.isInteger(n) || n < 0 || n > 65535) throw usage(`--port must be a port number, got "${flags.port}"`);
  return n;
}

/**
 * Write `<pid>` into `.kanban/<name>.pid` for the child that was just spawned, so a second `hkb up`
 * one millisecond later sees a live process instead of starting a rival — the child writes the same
 * file itself when it boots, but that takes a moment and idempotence cannot wait for it.
 *
 * A live pid that is not ours is never clobbered: two `hkb up`s racing means one of the two children
 * loses (the dispatcher's singleton lock refuses it, the server's port is taken), and the pid file
 * must keep naming the one that won.
 */
function claimPid(root, name, pid) {
  const { pid: current } = readPidFile(root, name);
  if (current && current !== pid && pidAlive(current)) return false;
  const file = pidFile(root, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, String(pid) + '\n');
  return true;
}

/**
 * Start one process detached — the same `spawn(..., { detached: true, stdio: ['ignore', fd, fd] })` +
 * `unref()` the dispatcher uses for workers, so `hkb up` can exit and leave the board running.
 * Output is appended to `.kanban/logs/<name>.log`, under one `# <ISO> started pid N` header per start.
 * @returns the child's pid
 */
function startProcess(ctx, name, flags, deps = {}) {
  ensureLocalDirs(ctx.root);
  const argv = childArgv(ctx, name, flags);
  const file = processLogFile(ctx.root, name);
  const fd = fs.openSync(file, 'a');
  let child;
  try {
    child = (deps.spawn || spawn)(process.execPath, [hkbBin(), ...argv], {
      cwd: ctx.root, env: detachedEnv(process.env), detached: true, stdio: ['ignore', fd, fd],
    });
    // The child is unref'd, so a spawn error has nobody left to tell — put it where `--status` points.
    child.on('error', (e) => { try { fs.appendFileSync(file, `# ${nowIso()} spawn failed: ${e.message}\n`); } catch { /* best effort */ } });
    if (!child.pid) throw new Error(`could not start hkb ${argv[0]}: spawn returned no pid`);
    fs.writeSync(fd, startLogLine(nowIso(), child.pid, ['hkb', ...argv]));
  } finally { fs.closeSync(fd); } // the child holds its own copy
  child.unref();
  clearExit(ctx.root, name); // this process is starting; its predecessor's death is no longer the news
  claimPid(ctx.root, name, child.pid);
  return child.pid;
}

/** `{ dispatch: {...}, serve: {...} }` — pid files and liveness, no board read and no network. */
export function statusReport(ctx) {
  const out = {};
  for (const name of PROCESSES) out[name] = processState(ctx.root, name);
  return out;
}

/**
 * `hkb up [--serve] [--loop S] [--port N]` · `hkb up --status [--json]`.
 * Idempotent: a live pid file means "already running", not a second loop.
 */
export function up(ctx, flags = {}, out = () => {}, deps = {}) {
  const status = statusReport(ctx);
  if (flags.status) {
    if (ctx.json) out(JSON.stringify(status, null, 2));
    else for (const name of PROCESSES) out(processLine(status[name]));
    return 0;
  }
  // `--port` without `--serve` can only mean one thing, so it means it rather than being refused.
  const names = flags.serve || flags.port !== undefined ? PROCESSES : ['dispatch'];
  for (const name of names) childArgv(ctx, name, flags); // validate every flag before spawning anything

  const now = new Date();
  const started = [];
  const already = [];
  const lines = [];
  for (const name of names) {
    const decision = startDecision(status[name], { now });
    if (!decision.start) { already.push(name); lines.push(decision.line); continue; }
    const pid = startProcess(ctx, name, flags, deps);
    started.push(name);
    lines.push(`${name} started pid ${pid} · log ${status[name].log}`);
  }
  const report = { started, already, ...statusReport(ctx) };
  if (ctx.json) out(JSON.stringify(report, null, 2));
  else for (const line of lines) out(line);
  return 0;
}

/**
 * `hkb down [--serve]` — SIGTERM to what the pid files name, and the files removed.
 *
 * Workers are never touched: a running attempt belongs to the board and the next dispatcher reclaims
 * or adopts it, which is exactly what the loop's own SIGTERM handler already says. The dispatcher
 * finishes its current tick before it exits, so "stopping" is the honest word for what just happened.
 */
export function down(ctx, flags = {}, out = () => {}) {
  const names = flags.serve ? PROCESSES : ['dispatch'];
  const stopped = [];
  const lines = [];
  for (const name of names) {
    const st = processState(ctx.root, name);
    if (!st.running) { lines.push(st.exit === null ? `${name} not running` : processLine(st)); continue; }
    let error = null;
    try { process.kill(st.pid, 'SIGTERM'); } catch (e) { error = e.code || e.message; }
    fs.rmSync(pidFile(ctx.root, name), { force: true });
    if (error) lines.push(`${name}: could not signal pid ${st.pid} (${error}) — stop it yourself; the pid file is gone either way`);
    else {
      stopped.push({ name, pid: st.pid });
      lines.push(`${name} stopping (SIGTERM to pid ${st.pid})${name === 'dispatch' ? ' — the loop exits after its current tick; workers keep running' : ''}`);
    }
  }
  if (!flags.serve) {
    const serve = processState(ctx.root, 'serve');
    if (serve.running) lines.push(`serve still running pid ${serve.pid} — hkb down --serve stops it too`);
  }
  const report = { stopped, ...statusReport(ctx) };
  if (ctx.json) out(JSON.stringify(report, null, 2));
  else for (const line of lines) out(line);
  return 0;
}
