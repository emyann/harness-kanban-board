// `hkb up` / `hkb down` — the two long-running processes of a board, started and stopped as a verb.
//
// A board that is meant to keep moving needs a dispatcher loop, and usually the web board next to it.
// Before this, starting them was a shell recipe: `ps`/`ss` to learn whether they were already up, then
// `setsid nohup node bin/hkb.js dispatch --loop 60 > somewhere.log 2>&1 < /dev/null &` — different on
// every machine, unwritable for a harness that vets a command line word by word (`nohup`, `&`, the
// redirections), and logs wherever the operator happened to be standing.
//
// Everything that decides anything is pure and lives in model.js (`startDecision`, `processLine`,
// `startLogLine`, `detachedEnv`, `pidFileStale`, `stopWaitMs`); everything that reads a pid file is
// board.js (`processState`). What is left here is the spawn, the log, the signal and the wait.
//
// The one invariant that runs through all of it: **a pid file belongs to the process that wrote it.**
// `up` pre-writes one for the child it spawned and `down` tidies one whose process it watched die,
// but neither may drop a claim on a live process — that file is the dispatcher's singleton lock, and
// removing it early is how `hkb down && hkb up` ended up running two loops against one board.
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
  writeServeUrl, dropServeUrl,
} from './board.js';
import { PROCESSES, detachedEnv, startDecision, processLine, startLogLine, stopWaitMs, deadAtRecheck } from './model.js';
import { DEFAULT_PORT } from './serve.js';

const usage = (msg) => { const e = new Error(msg); e.exitCode = 2; return e; };
const nowIso = () => new Date().toISOString();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** How long `up` gives a child to be alive before it believes its own "started pid N". */
export const SPAWN_CHECK_MS = 300;
/** How often `down` looks again while it waits for a signalled process to be gone. */
export const STOP_POLL_MS = 100;

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
 * The URL `hkb up` believes it is about to spawn `serve` on — `--port` is a flag on `up`, so the value
 * is in hand before the child ever boots. `hkb serve`'s own `claimServePid` overwrites this with the
 * real bound origin once the port is actually open, the same relationship the pid file has with
 * `claimPid`: a good guess now, corrected the moment the child can speak for itself. `--host` is never
 * passed to the child (`childArgv`), so it always binds `127.0.0.1`.
 */
function serveOrigin(flags) { return `http://127.0.0.1:${flags.port !== undefined ? port(flags) : DEFAULT_PORT}`; }

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
  const { pid: current, stale } = readPidFile(root, name);
  if (!stale && current && current !== pid && pidAlive(current)) return false;
  const file = pidFile(root, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, String(pid) + '\n');
  return true;
}

/**
 * Remove `<name>.pid` only if it does not, right now, claim a live process — a fresh read, not the
 * `processState`/`claimPid` snapshot the caller acted on, because a concurrent `hkb up` or the
 * process's own startup can have rewritten it to a live pid in between. That is the one invariant
 * (see the file header): a pid file is never dropped while it names something alive.
 * `deps.readPidFile` exists so a test can inject a write between the caller's snapshot and this read.
 */
function dropDeadPidFile(root, name, deps = {}) {
  const read = deps.readPidFile || readPidFile;
  const f = read(root, name);
  if (f.pid && (f.stale || !pidAlive(f.pid))) {
    fs.rmSync(pidFile(root, name), { force: true });
    if (name === 'serve') dropServeUrl(root);
    return true;
  }
  return false;
}

/**
 * Start one process detached — the same `spawn(..., { detached: true, stdio: ['ignore', fd, fd] })` +
 * `unref()` the dispatcher uses for workers, so `hkb up` can exit and leave the board running.
 * Output is appended to `.kanban/logs/<name>.log`, under one `# <ISO> started pid N` header per start.
 *
 * Then it looks once more, a beat later. "started pid 3843" about a process that died in the same
 * millisecond is the one thing `up` can say that is worse than an error — the operator walks away
 * believing the board is running. The recheck costs 300ms once and turns that into a line naming the
 * log that holds the reason — and, since the process never actually came up, a `failed` entry rather
 * than a `started` one (#164).
 * @returns {{pid: number, line: string, failed: {name: string, pid: number, log: string}|null}}
 */
async function startProcess(ctx, name, flags, deps = {}) {
  ensureLocalDirs(ctx.root);
  const argv = childArgv(ctx, name, flags);
  const file = processLogFile(ctx.root, name);
  const rel = path.relative(ctx.root, file);
  const fd = fs.openSync(file, 'a');
  let child;
  try {
    child = (deps.spawn || spawn)(process.execPath, [hkbBin(), ...argv], {
      cwd: ctx.root, env: detachedEnv(process.env), detached: true, windowsHide: true, stdio: ['ignore', fd, fd],
    });
    // The child is unref'd, so a spawn error has nobody left to tell — put it where `--status` points.
    child.on('error', (e) => { try { fs.appendFileSync(file, `# ${nowIso()} spawn failed: ${e.message}\n`); } catch { /* best effort */ } });
    if (!child.pid) throw new Error(`could not start hkb ${argv[0]}: spawn returned no pid`);
    fs.writeSync(fd, startLogLine(nowIso(), child.pid, ['hkb', ...argv]));
  } finally { fs.closeSync(fd); } // the child holds its own copy
  child.unref();
  clearExit(ctx.root, name); // this process is starting; its predecessor's death is no longer the news
  // A rival `up` that got there first keeps the file: the loser's child is the one the singleton lock
  // (or the bound port) is about to refuse, and the pid file must keep naming the winner.
  const claimed = claimPid(ctx.root, name, child.pid);
  // Same reasoning as the pid: pre-write the URL we are about to spawn on so `--status` a millisecond
  // later has something truer than a log grep, then let the child's own `claimServePid` correct it.
  if (claimed && name === 'serve') writeServeUrl(ctx.root, serveOrigin(flags));
  await sleep(deps.spawnCheckMs ?? SPAWN_CHECK_MS);
  if (!pidAlive(child.pid)) {
    const r = deadAtRecheck(name, child.pid, rel);
    // `up` owns this claim (it just wrote it) and has just verified the pid dead — tidy it rather
    // than leaving `serve.pid` naming the corpse it just reported as `failed`. `claimed` narrows this
    // to our own claim; `dropDeadPidFile`'s own fresh read is what keeps a concurrent live claim safe.
    if (claimed) { dropDeadPidFile(ctx.root, name, deps); if (name === 'serve') dropServeUrl(ctx.root); }
    return { pid: child.pid, line: r.line, failed: r.failed };
  }
  if (!claimed) {
    const { pid: holder } = readPidFile(ctx.root, name);
    return { pid: child.pid, line: `${name} started pid ${child.pid}, but ${path.relative(ctx.root, pidFile(ctx.root, name))} names pid ${holder} — one of the two will be refused; hkb up --status says which survived`, failed: null };
  }
  const url = name === 'serve' ? ` · ${serveOrigin(flags)}` : '';
  return { pid: child.pid, line: `${name} started pid ${child.pid}${url} · log ${rel}`, failed: null };
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
export async function up(ctx, flags = {}, out = () => {}, deps = {}) {
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
  const failed = [];
  const already = [];
  const lines = [];
  for (const name of names) {
    const decision = startDecision(status[name], { now });
    if (!decision.start) { already.push(name); lines.push(decision.line); continue; }
    const { line, failed: entry } = await startProcess(ctx, name, flags, deps);
    if (entry) failed.push(entry); else started.push(name);
    lines.push(line);
  }
  const report = { started, failed, already, ...statusReport(ctx) };
  if (ctx.json) out(JSON.stringify(report, null, 2));
  else for (const line of lines) out(line);
  return failed.length ? 1 : 0;
}

/**
 * Wait for a signalled process to actually be gone. Bounded, because `down` must not become the thing
 * that hangs: `stopWaitMs` is two of the loop's own intervals, and past that the honest answer is
 * "still running", not "stopped".
 * @returns true if the process is gone
 */
async function waitGone(pid, budgetMs, deps = {}) {
  const nap = deps.sleep || sleep;
  const deadline = Date.now() + budgetMs;
  for (;;) {
    if (!pidAlive(pid)) return true;
    if (Date.now() >= deadline) return false;
    await nap(Math.min(deps.pollMs ?? STOP_POLL_MS, Math.max(1, deadline - Date.now())));
  }
}

/**
 * `hkb down [--serve]` — SIGTERM to what the pid files name, then wait for them to be gone.
 *
 * **The pid file is not `down`'s to delete.** Every one of these processes drops its own on exit
 * (`acquireLoopLock` in dispatch.js, `claimServePid` in serve.js), and that file is the singleton
 * lock: removing it the instant the signal is sent tells the very next `hkb up` that nothing is
 * running, while the old loop is still finishing a tick. Two loops, one board — the exact thing the
 * lock exists to prevent, defeated by the command that was meant to be its opposite. So `down`
 * signals, waits for `pidAlive` to go false, and only then tidies a file the dead process left
 * behind. If the wait runs out it says so and leaves the claim standing, because the claim is true.
 *
 * Workers are never touched: a running attempt belongs to the board and the next dispatcher reclaims
 * or adopts it, which is exactly what the loop's own SIGTERM handler already says.
 */
export async function down(ctx, flags = {}, out = () => {}, deps = {}) {
  const names = flags.serve ? PROCESSES : ['dispatch'];
  const budget = deps.waitMs ?? stopWaitMs(ctx.cfg?.dispatch?.interval);
  const stopped = [];
  const failed = [];
  const lines = [];
  // The process drops its own pid file on exit; a process that was not one of ours, or died before it
  // could, leaves it, and a file naming a dead pid helps nobody. Only ever tidy the same pid.
  const tidyPidFile = (name, pid) => {
    const { pid: left } = readPidFile(ctx.root, name);
    if (left === pid) { fs.rmSync(pidFile(ctx.root, name), { force: true }); if (name === 'serve') dropServeUrl(ctx.root); }
  };
  for (const name of names) {
    const st = processState(ctx.root, name);
    if (!st.running) {
      // Not stale, no exit recorded — plain "not running" — but a pid file can still be sitting there
      // naming a process that is simply dead (crashed without dropping its own claim); leaving it is
      // what let a later report keep calling the board down when a stray file said otherwise (#164).
      // `dropDeadPidFile` re-reads rather than trusting `st`: a concurrent `hkb up` (or the child's own
      // startup claim) can have rewritten the file to a live pid since `processState` took `st`, and
      // that live claim must survive even though `st.running` says stopped.
      const removed = dropDeadPidFile(ctx.root, name, deps);
      lines.push(st.stale
        ? `${name} stopped (pid file predates this boot — ${removed ? 'removed' : 'hkb up replaces it'})`
        : (st.exit === null ? `${name} not running` : processLine(st)));
      continue;
    }
    try { (deps.kill || process.kill.bind(process))(st.pid, 'SIGTERM'); } catch (e) {
      const error = e.code || e.message;
      // ESRCH means the process died between `processState`'s liveness check and this signal — it is
      // gone, which is what `down` was asked for, not a failure to report.
      if (error === 'ESRCH') {
        stopped.push({ name, pid: st.pid });
        tidyPidFile(name, st.pid);
        lines.push(`${name} stopped (SIGTERM to pid ${st.pid})${name === 'dispatch' ? '; workers keep running' : ''}`);
        continue;
      }
      failed.push({ name, pid: st.pid, error });
      lines.push(`${name}: could not signal pid ${st.pid} (${error}) — stop it yourself; ${path.relative(ctx.root, pidFile(ctx.root, name))} still names it`);
      continue;
    }
    if (await waitGone(st.pid, budget, deps)) {
      stopped.push({ name, pid: st.pid });
      tidyPidFile(name, st.pid);
      lines.push(`${name} stopped (SIGTERM to pid ${st.pid})${name === 'dispatch' ? '; workers keep running' : ''}`);
    } else {
      const error = `still running ${Math.round(budget / 1000)}s after SIGTERM`;
      failed.push({ name, pid: st.pid, error });
      lines.push(`${name}: pid ${st.pid} ${error} — a tick in flight finishes first; hkb up --status says when it is gone`);
    }
  }
  if (!flags.serve) {
    const serve = processState(ctx.root, 'serve');
    if (serve.running) lines.push(`serve still running pid ${serve.pid} — hkb down --serve stops it too`);
  }
  const report = { stopped, failed, ...statusReport(ctx) };
  if (ctx.json) out(JSON.stringify(report, null, 2));
  else for (const line of lines) out(line);
  return failed.length ? 1 : 0;
}
