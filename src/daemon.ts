import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { openBoard } from './db.ts';
import { databaseUrl } from './db-url.ts';
import { reconcile } from './controller.ts';
import { holderId, pidIsAlive, bootTime } from './liveness.ts';
import type { Runtime } from './runtime/index.ts';

/**
 * The loop — and only now.
 *
 * Phase 1 shipped `kb run`, a foreground command, on purpose: a daemon built first would have hidden
 * every failure the foreground runs surfaced, and it did (the admission gate, the worktree base and
 * the lease were all silently inert, and all three were found by watching a run happen). What is
 * left is the half a human at a keyboard genuinely cannot do — **time**.
 *
 * That is the whole justification for this file, and it is why the interval is slow. Three things
 * here are time-driven and nothing else is:
 *
 *   - a lease expires, because its holder died without releasing it;
 *   - a run passes its wall clock (the runtime's own timer, but only while something is watching it);
 *   - work scheduled for later becomes due — a kind that does not exist yet.
 *
 * The change-driven half — "a Job was just filed, run it" — is always one `kb run` away, so it does
 * not need a loop and does not set the cadence. All three of the above have minute-scale tolerances,
 * so 45 seconds is generous and the cost of a tick is one indexed query against a local file.
 */

/** Slow on purpose. See above: nothing time-driven here has a sub-minute tolerance. */
export const DEFAULT_INTERVAL_MS = 45_000;

/**
 * How far the wall clock may run past a tick before we call it a suspend rather than a slow pass.
 * Two intervals of slack, so ordinary lateness — a long reconcile, a busy machine — never trips it.
 */
const SLEEP_FACTOR = 2;
const SLEEP_SLACK_MS = 30_000;

export type PidFile = {
  pid: number;
  board: string;
  intervalMs: number;
  startedAt: string;
  holder: string;
};

/**
 * The daemon's files live beside the board, not at a fixed path in the repo.
 *
 * `HKB_DATABASE_URL` moves the board; a pid file that did not move with it would make two boards
 * in one checkout fight over one lock, and would make this untestable — every test uses a scratch
 * database, and a test that wrote a pid file into the real `.kanban/` could stop the operator's
 * running daemon.
 */
export function boardDir(url = databaseUrl()): string {
  return path.dirname(url.replace(/^file:/, ''));
}

export const pidPath = (board: string, url?: string) => path.join(boardDir(url), `kb-${board}.pid`);
export const logPath = (board: string, url?: string) => path.join(boardDir(url), `kb-${board}.log`);

export function readPidFile(board: string, url?: string): PidFile | null {
  try {
    return JSON.parse(fs.readFileSync(pidPath(board, url), 'utf8')) as PidFile;
  } catch {
    return null;
  }
}

/**
 * Flat, not a discriminated union: this project type-checks with `strict: false`, and TypeScript
 * does not narrow a union on a boolean discriminant without `strictNullChecks`. Every field is
 * always present, which also makes `--json` output a stable shape rather than one of two.
 */
export type Status = {
  running: boolean;
  /** The pid file as read, whether or not the process it names is still there. Null if there is none. */
  daemon: PidFile | null;
  /** A pid file exists, but its process does not. `kb down` clears it. */
  stale: boolean;
  since: Date | null;
  uptimeMs: number | null;
  pidFile: string;
  log: string;
};

/**
 * Is a daemon up for this board?
 *
 * A pid file is a claim, not a fact — the process it names may have been killed, and its number
 * reused. So the same two questions the lease reclaim asks: is that pid running, and could it
 * still be *ours*? A daemon recorded as starting before this machine booted cannot be, whatever is
 * on that pid now. Without that check a stale file after a reboot would make `kb up` refuse for
 * ever, which is the failure that makes people delete pid files by hand.
 */
export function status(board: string, url?: string, now = Date.now()): Status {
  const pf = readPidFile(board, url);
  const base = { pidFile: pidPath(board, url), log: logPath(board, url), since: null, uptimeMs: null };
  if (!pf) return { running: false, daemon: null, stale: false, ...base };
  const startedAt = new Date(pf.startedAt);
  const booted = startedAt.getTime() >= bootTime(now) - 5_000;
  if (!booted || !pidIsAlive(pf.pid)) return { running: false, daemon: pf, stale: true, ...base };
  return {
    running: true, daemon: pf, stale: false, ...base,
    since: startedAt, uptimeMs: now - startedAt.getTime(),
  };
}

// ---------------------------------------------------------------- the loop

export type LoopDeps = {
  runtime: Runtime;
  cwd: string;
  board: string;
  intervalMs?: number;
  signal: AbortSignal;
  log?: (line: string) => void;
  now?: () => number;
  /** Stop after this many ticks. Tests only — a loop with no exit is not a thing to unit test. */
  maxTicks?: number;
  readPr?: boolean;
  /**
   * The wait between ticks. Injectable because a suspend happens *during* it — a test that models
   * one by advancing a clock here is telling the same story the machine does, and does not have to
   * guess how many times the loop reads the time.
   */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
};

const stamp = (d = new Date()) => d.toISOString().replace('T', ' ').slice(0, 19);

/** Sleep, but wake early if the operator stopped us. */
function nap(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });
}

/**
 * Reconcile on an interval until stopped.
 *
 * Runs in the foreground of whatever process calls it — `kb up` detaches by spawning a second
 * process that calls this, so the loop itself has no opinion about daemonising and can be tested
 * in-process.
 */
export async function loop(deps: LoopDeps): Promise<number> {
  const db = openBoard();
  const now = deps.now ?? Date.now;
  const intervalMs = deps.intervalMs ?? DEFAULT_INTERVAL_MS;
  const log = deps.log ?? ((l: string) => process.stdout.write(`${stamp()} ${l}\n`));
  const sleep = deps.sleep ?? nap;
  const board = await db.board.upsert({ where: { slug: deps.board }, update: {}, create: { slug: deps.board } });
  const holder = holderId('daemon');

  await db.event.create({
    data: { kind: 'daemon_up', boardId: board.id, actor: holder, payload: { intervalMs } },
  });
  log(`up on ${deps.board} — every ${Math.round(intervalMs / 1000)}s, pid ${process.pid}`);

  let ticks = 0;
  let last = now();
  // Only announce a refusal when it changes. A stopped board would otherwise write the same line
  // every interval for as long as it is stopped, and a log nobody can skim is a log nobody reads.
  let saidRefused: string | null = null;

  while (!deps.signal.aborted && (deps.maxTicks === undefined || ticks < deps.maxTicks)) {
    ticks++;
    const at = now();
    const drift = at - last;

    // Did the machine sleep? Node's timers run on a monotonic clock that does not advance while
    // suspended, so the tick after a resume arrives on schedule *by its own reckoning* while the
    // wall clock has jumped hours. Every lease on the board looks expired at that instant, and not
    // one of them expired for a reason anybody chose.
    //
    // Reclaim is skipped for exactly that pass. It is belt and braces — `holderLiveness` already
    // refuses to take a lease off a running local process — but it is the half that also covers a
    // holder on another machine, which no pid check here can see.
    const slept = ticks > 1 && drift > intervalMs * SLEEP_FACTOR + SLEEP_SLACK_MS;
    if (slept) {
      log(`woke — ${Math.round(drift / 1000)}s of wall clock passed since the last tick, skipping reclaim`);
      await db.event.create({
        data: { kind: 'woke', boardId: board.id, actor: holder, payload: { driftMs: drift } },
      });
    }

    try {
      const report = await reconcile({
        runtime: deps.runtime,
        cwd: deps.cwd,
        board: deps.board,
        // One loop, one clock. The pass decides what has expired, and it must decide it against
        // the same time the pass used to decide whether the machine had been asleep.
        now: () => new Date(now()),
        reclaim: !slept,
        signal: deps.signal,
        readPr: deps.readPr,
        onEvent: (l) => log(l),
      });
      if (report.refused !== saidRefused) {
        if (report.refused) log(`refused  ${report.refused}`);
        else if (saidRefused) log('claiming again');
        saidRefused = report.refused;
      }
    } catch (e) {
      // A pass that throws must not take the loop with it: the next tick is 45 seconds away and
      // may well succeed, and a daemon that exits on the first transient database error is worse
      // than one that logs and carries on.
      log(`tick failed: ${(e as Error).message}`);
      await db.event
        .create({ data: { kind: 'tick_failed', boardId: board.id, actor: holder, payload: { error: String((e as Error).message).slice(0, 300) } } })
        .catch(() => { /* if the board is unreachable the log line above is all we have */ });
    }

    last = now();
    if (!deps.signal.aborted && (deps.maxTicks === undefined || ticks < deps.maxTicks)) {
      await sleep(intervalMs, deps.signal);
    }
  }

  await db.event.create({
    data: { kind: 'daemon_down', boardId: board.id, actor: holder, payload: { ticks } },
  });
  log(`down after ${ticks} tick${ticks === 1 ? '' : 's'}`);
  return ticks;
}

// ---------------------------------------------------------------- up / down

export type StartResult = { started: boolean; pid: number; log: string; why?: string };

/**
 * Spawn a detached loop and return.
 *
 * The child is this same binary with `up --foreground`, which keeps one implementation of the loop
 * and means the thing a supervisor (systemd, launchd) should run is a documented command rather
 * than an internal entry point.
 */
export function start(
  board: string,
  opts: { intervalMs?: number; fake?: boolean; cwd?: string; url?: string; execPath?: string } = {},
): StartResult {
  const st = status(board, opts.url);
  if (st.running) {
    return { started: false, pid: st.daemon.pid, log: st.log, why: `already up (pid ${st.daemon.pid}) — \`kb down\` first` };
  }
  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
  const lp = logPath(board, opts.url);
  fs.mkdirSync(path.dirname(lp), { recursive: true });
  const out = fs.openSync(lp, 'a');
  const entry = opts.execPath ?? path.resolve(import.meta.dirname, '..', 'bin', 'kb.ts');

  try {
    const child = spawn(
      process.execPath,
      [entry, 'up', '--foreground', '--board', board, '--interval', String(Math.round(intervalMs / 1000)),
        ...(opts.fake ? ['--fake'] : [])],
      {
        cwd: opts.cwd ?? process.cwd(),
        // Its own process group, so a Ctrl-C in the terminal that launched it does not also kill
        // the daemon — and so `kb down` can signal the group if it ever needs to.
        detached: true,
        stdio: ['ignore', out, out],
        env: process.env,
      },
    );
    child.unref();
    // The child writes the pid file itself once the loop is actually up; writing it here would
    // claim a daemon exists in the window before the child has opened the board, and a `kb up`
    // that fails to start would leave that claim behind.
    return { started: true, pid: child.pid ?? -1, log: lp };
  } finally {
    fs.closeSync(out);
  }
}

export type StopResult = { stopped: boolean; pid?: number; waitedMs?: number; why?: string };

/**
 * Signal the daemon and wait for it to go.
 *
 * SIGTERM, never SIGKILL: the loop's shutdown path is what releases the lease on the run in
 * flight, and killing it outright would leave that lease held until it expired. The wait is
 * generous because a clean stop includes interrupting a worker, which is not instant.
 */
export async function stop(
  board: string,
  opts: { timeoutMs?: number; url?: string; pollMs?: number } = {},
): Promise<StopResult> {
  const st = status(board, opts.url);
  if (!st.running) {
    if (st.stale) fs.rmSync(pidPath(board, opts.url), { force: true });
    return { stopped: false, why: st.stale ? 'no daemon running — cleared a stale pid file' : 'no daemon running' };
  }
  const pid = st.daemon.pid;
  try {
    process.kill(pid, 'SIGTERM');
  } catch (e) {
    return { stopped: false, pid, why: `could not signal pid ${pid}: ${(e as Error).message}` };
  }

  const timeoutMs = opts.timeoutMs ?? 60_000;
  const pollMs = opts.pollMs ?? 200;
  const began = Date.now();
  while (Date.now() - began < timeoutMs) {
    if (!pidIsAlive(pid)) {
      fs.rmSync(pidPath(board, opts.url), { force: true });
      return { stopped: true, pid, waitedMs: Date.now() - began };
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
  // Deliberately not escalating to SIGKILL. A daemon still winding down is finishing the writes
  // that make the record true; killing it here would trade a slow stop for a lost attempt row.
  return {
    stopped: false,
    pid,
    waitedMs: Date.now() - began,
    why: `pid ${pid} is still shutting down after ${Math.round(timeoutMs / 1000)}s — it is interrupting a worker. `
      + `Check \`kb up --status\`; it will exit on its own.`,
  };
}

/** Write the pid file. Called by the loop itself, once it is genuinely up. */
export function claimPidFile(board: string, intervalMs: number, url?: string): string {
  const p = pidPath(board, url);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const body: PidFile = {
    pid: process.pid,
    board,
    intervalMs,
    startedAt: new Date().toISOString(),
    holder: `${os.hostname()}/${process.pid}`,
  };
  fs.writeFileSync(p, JSON.stringify(body, null, 1) + '\n');
  return p;
}

export function releasePidFile(board: string, url?: string): void {
  const p = pidPath(board, url);
  // Only ours. A pid file that now names a different process belongs to the daemon that replaced
  // us, and deleting it would leave that one invisible to `kb up --status`.
  const pf = readPidFile(board, url);
  if (pf && pf.pid !== process.pid) return;
  fs.rmSync(p, { force: true });
}
