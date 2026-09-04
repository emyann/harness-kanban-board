// The `process` runtime: the dispatcher spawns the harness as a detached child and holds its pid.
//
// The launch is detached, so the pid leads its own process group — which is what makes the pause of
// B4 (`kill(-pid, SIGSTOP)`) possible at all, and what makes `pidAlive` an honest answer here: a
// wrapper that exits while node lives on would otherwise read as dead (observed 2026-08-26).
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pidAlive } from '../board.js';
import { worktreePath, parseSessionLog, sessionUpdate } from '../model.js';
import { NOT_IMPLEMENTED, UNKNOWN, REGISTER_GRACE } from './contract.js';

export const MODE = 'process';

const nowIso = () => new Date().toISOString();
const secondsSince = (iso) => (iso ? (Date.now() - new Date(iso).getTime()) / 1000 : Infinity);

/** SIGTERM, then SIGKILL five seconds later if it is still there. Returns whether anything was signalled. */
export function killPid(pid) {
  if (!pidAlive(pid)) return false;
  try { process.kill(pid, 'SIGTERM'); } catch { return false; }
  setTimeout(() => { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }, 5000).unref();
  return true;
}

/**
 * Spawn the harness. The launch environment is this worker's identity — `KB_TASK` is what tells a
 * session it is a worker at all — and it dies with the process, which is exactly what makes it safe
 * to put there (unlike a `claude --bg` launch: see `../runtime/claude-bg.js`).
 */
export function launch(ctx, task, k, { argv, cwd, logFile, wt = null, profileName, keepRef = false, continued = null, toolsDropped = [] }) {
  const env = {
    ...process.env,
    KB_TASK: String(task.number), KB_ATTEMPT: String(k), KB_BOARD: ctx.board, KB_REPO: ctx.repo.nameWithOwner,
    KB_ROOT: ctx.root, KB_PROFILE: profileName,
  };
  const fd = fs.openSync(logFile, 'a');
  fs.writeSync(fd, `# ${nowIso()} spawn ${argv[0]} for #${task.number} attempt ${k}${wt ? ` in ${worktreePath(wt)}` : ''}\n`);
  const child = spawn(argv[0], argv.slice(1), { cwd, env, detached: true, stdio: ['ignore', fd, fd] });
  child.on('error', () => { /* handled via the exit code the caller watches */ });
  fs.closeSync(fd); // the child holds its own copy
  if (!keepRef) child.unref(); // one-shot dispatch must not wait for the worker
  return {
    argv, pid: child.pid, child, wt, logFile, continued, tools_dropped: toolsDropped,
    handle: child.pid ? { runtime: MODE, pid: child.pid } : null,
    row: wt ? { pid: child.pid, wt } : { pid: child.pid },
    describe: `pid ${child.pid}${wt ? ` in ${worktreePath(wt)}` : ''}`,
  };
}

/**
 * `process.kill(pid, 0)` costs nothing and settles the question outright — a `process` worker never
 * touches the run record between heartbeats either, so timing a signal alone would call a perfectly
 * live one idle on the same schedule a background attempt was (#185, second pass).
 *
 * An attempt with no pid at all is one whose spawn never recorded a handle. It gets the same
 * registration grace a background job gets, and is written off after it.
 */
export function inspect(ctx, attempt) {
  if (!attempt || attempt.host !== ctx.host) return { ...UNKNOWN };
  if (!attempt.pid) {
    return { ...UNKNOWN, outcome: secondsSince(attempt.started_at) > REGISTER_GRACE ? 'crashed' : null };
  }
  const alive = pidAlive(attempt.pid);
  return {
    alive, working: alive,
    handle: { runtime: MODE, pid: attempt.pid },
    session: null,
    outcome: alive ? null : 'crashed',
    patch: null,
  };
}

export function stop(ctx, attempt) {
  if (!attempt || attempt.host !== ctx.host || !attempt.pid) return false;
  return killPid(attempt.pid);
}

export function pause() { return NOT_IMPLEMENTED; }
export function resume() { return NOT_IMPLEMENTED; }

/**
 * A pid-bearing attempt has no job record to name its session — but its own log ends the same way a
 * `claude -p --output-format json` run does, so a `crashed`/`timed_out` row gets its session and its
 * cost the way a `--bg` row has since #137, and its terminal reason since #155.
 *
 * `null` means "this runtime has no post-mortem for that row"; `{session}` means it does, and the
 * session may still be null when the log had nothing to say. The caller reads the transcript for
 * denied tools on the strength of the first, not the second.
 */
export function postMortem(ctx, attempt) {
  if (!attempt || attempt.host !== ctx.host || !attempt.pid || !attempt.log) return null;
  let session = null;
  try {
    const text = fs.readFileSync(path.join(ctx.root, attempt.log), 'utf8').slice(-200_000);
    session = sessionUpdate(attempt, parseSessionLog(text));
  } catch { /* unreadable log */ }
  return { session };
}
