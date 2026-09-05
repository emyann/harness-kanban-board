import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { openBoard } from './db.ts';
import { boardDir } from './db-url.ts';

export { boardDir };
import { reconcile } from './controller.ts';
import { sweepWorktrees } from './worktree.ts';
import { holderId, holderLiveness, parseHolder, pidIsAlive } from './liveness.ts';
import { windowStart } from './limits.ts';
import { cliEntry, PACKAGE_ROOT } from './paths.ts';
import type { Runtime } from './runtime/index.ts';

/**
 * The loop — and only now.
 *
 * Phase 1 shipped `kb run`, a foreground command, on purpose: a daemon built first would have hidden
 * every failure the foreground runs surfaced, and it did (the admission gate, the worktree base and
 * the lease were all silently inert, and all three were found by watching a run happen). What is
 * left is the half a human at a keyboard genuinely cannot do — **time**.
 *
 * That is the whole justification for this file, and it is why the interval is slow. Four things
 * here are time-driven and nothing else is:
 *
 *   - a lease expires, because its holder died without releasing it;
 *   - a run passes its wall clock (the runtime's own timer, but only while something is watching it);
 *   - work scheduled for later becomes due — a kind that does not exist yet;
 *   - a worktree becomes safe to reclaim, because its pull request landed somewhere else and
 *     nothing here was told. That one is a sweep, on its own slower timer: see `SWEEP_EVERY_MS`.
 *
 * The change-driven half — "a Job was just filed, run it" — is always one `kb run` away, so it does
 * not need a loop and does not set the cadence. All three of the above have minute-scale tolerances,
 * so 45 seconds is generous and the cost of a tick is one indexed query against a local file.
 *
 * **One daemon serves every board**, the way one controller-manager serves every namespace. Which
 * boards it may serve is decided per board by a `Controller` row — leader election, not exclusion.
 * That row replaced a pid file, which was a second source of truth outside the store re-deriving
 * rules `Lease` already owned, and getting one of them wrong: it recorded a hostname and never read
 * it back, so on a shared filesystem it asked the wrong machine's process table.
 */

/** Slow on purpose. See above: nothing time-driven here has a sub-minute tolerance. */
export const DEFAULT_INTERVAL_MS = 45_000;

/**
 * How often the tick reclaims worktrees. Much slower than the tick itself.
 *
 * This is the fourth time-driven thing, and it belongs here for the same reason as the other
 * three: a checkout becomes safe to delete *later*, when its pull request lands, and nothing tells
 * us when that happened. Only a clock can ask again. It is rare because the answer changes on the
 * scale of a code review, and because asking costs one `ls-remote`.
 */
export const SWEEP_EVERY_MS = 10 * 60_000;

/**
 * How far the wall clock may run past a tick before we call it a suspend rather than a slow pass.
 * Two intervals of slack, so ordinary lateness — a long reconcile, a busy machine — never trips it.
 */
const SLEEP_FACTOR = 2;
const SLEEP_SLACK_MS = 30_000;

/** A controller lease outlives three ticks, so two missed renewals are survivable. */
const controllerLeaseMs = (intervalMs: number) => Math.max(3 * intervalMs, 90_000);

/** One log per board for a `--board`-scoped daemon; one for the machine otherwise. */
export const logPath = (board: string, url?: string) => path.join(boardDir(url), `kb-${board}.log`);
export const machineLogPath = (url?: string) => path.join(boardDir(url), 'kb.log');

/**
 * What this daemon is running, for `kb up --status` to compare against the checkout.
 *
 * A daemon runs the code it was started with: edit the controller and the running one keeps the old
 * behaviour until restarted. The previous dispatcher had the same hazard and it was managed by
 * remembering to restart. Recording the build turns silent staleness into a line somebody can read.
 */
export function buildVersion(cwd = PACKAGE_ROOT): string {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim() || 'unknown';
  } catch {
    return 'unknown';
  }
}

// ---------------------------------------------------------------- who is in charge

export type ControllerRow = {
  boardId: number;
  holder: string;
  intervalMs: number;
  version: string | null;
  startedAt: Date;
  renewedAt: Date;
  expiresAt: Date;
};

/** Is this controller row still answered by a living process? The same three answers as a lease. */
export function controllerIsLive(row: ControllerRow, at = new Date()): boolean {
  const live = holderLiveness(row.holder, row.startedAt);
  if (live === 'alive') return true;
  if (live === 'dead') return false;
  // Another machine: the clock is all we have, which is all a Kubernetes lease ever has either.
  return row.expiresAt > at;
}

/**
 * Take or renew the controller lease for one board.
 *
 * The insert is the compare-and-swap, exactly as it is for a Job, and losing is a normal outcome.
 * A row whose holder is provably gone is taken over; one whose holder is alive is left alone and
 * this daemon simply does not serve that board.
 */
export async function acquireBoard(
  db: ReturnType<typeof openBoard>,
  boardId: number,
  holder: string,
  intervalMs: number,
  version: string,
  now: () => Date,
): Promise<boolean> {
  const at = now();
  const expiresAt = new Date(at.getTime() + controllerLeaseMs(intervalMs));
  const mine = await db.controller.updateMany({
    where: { boardId, holder },
    data: { renewedAt: at, expiresAt, intervalMs },
  });
  if (mine.count > 0) return true;

  const held = await db.controller.findUnique({ where: { boardId } });
  if (held) {
    if (controllerIsLive(held as ControllerRow, at)) return false;
    // Fenced on the holder we read: if it changed under us, somebody else got there first.
    const taken = await db.controller.deleteMany({ where: { boardId, holder: held.holder } });
    if (taken.count === 0) return false;
  }
  try {
    await db.controller.create({
      data: { boardId, holder, intervalMs, version, startedAt: at, renewedAt: at, expiresAt },
    });
    return true;
  } catch {
    return false; // lost the race; normal
  }
}

export async function releaseBoards(db: ReturnType<typeof openBoard>, holder: string): Promise<number> {
  const gone = await db.controller.deleteMany({ where: { holder } });
  return gone.count;
}

export type BoardStatus = {
  slug: string;
  boardId: number;
  repoPath: string | null;
  running: boolean;
  stale: boolean;
  holder: string | null;
  intervalMs: number | null;
  since: Date | null;
  uptimeMs: number | null;
  /** The checkout's build, when the daemon started from a different one. Null when in step. */
  behind: string | null;
  version: string | null;
  log: string;
  /**
   * Why a daemon that is up may still claim nothing. `running` answers "is there a controller";
   * these answer "and will it take anything", which is the question that actually follows — and
   * every one of them is an input to `gateClaim`, so they are the same four facts a refusal cites.
   */
  stopped: boolean;
  stoppedAt: Date | null;
  stoppedBy: string | null;
  maxConcurrent: number;
  dailyBudgetUsd: number | null;
  /** Spent on this board inside the same rolling window the gate charges against. */
  spent24h: number;
};

/**
 * Who is serving what.
 *
 * One query with a join, which is the point of moving this out of a pid file: the old shape needed
 * a glob over `kb-*.pid`, then a stat and a boot-time check per file, and still could not answer
 * "and what has that board spent" in the same breath.
 */
export async function status(board?: string, now = Date.now()): Promise<BoardStatus[]> {
  const db = openBoard();
  const boards = await db.board.findMany({
    where: board ? { slug: board } : {},
    include: { controller: true },
    orderBy: { slug: 'asc' },
  });
  const here = buildVersion();

  // The spend for every board in one pass, summed here rather than per board: an aggregate per
  // row would make `kb up --status` cost N+1 queries to answer a question the join already holds.
  // Same window as the gate, from the same function — a status that disagreed with the refusal it
  // is meant to explain would be worse than not printing it.
  const costs = new Map<number, number>();
  const charged = await db.attempt.findMany({
    where: {
      startedAt: { gte: windowStart(new Date(now)) },
      job: { boardId: { in: boards.map((b) => b.id) } },
    },
    select: { costUsd: true, job: { select: { boardId: true } } },
  });
  for (const a of charged) {
    costs.set(a.job.boardId, (costs.get(a.job.boardId) ?? 0) + (a.costUsd ?? 0));
  }

  return boards.map((b) => {
    const c = (b.controller ?? null) as ControllerRow | null;
    const live = !!c && controllerIsLive(c, new Date(now));
    return {
      slug: b.slug,
      boardId: b.id,
      repoPath: b.repoPath,
      running: live,
      stale: !!c && !live,
      holder: c?.holder ?? null,
      intervalMs: c?.intervalMs ?? null,
      version: c?.version ?? null,
      since: live ? c!.startedAt : null,
      uptimeMs: live ? now - c!.startedAt.getTime() : null,
      behind: live && c!.version && c!.version !== 'unknown' && here !== 'unknown' && c!.version !== here
        ? here : null,
      log: logPath(b.slug),
      stopped: !!b.pausedAt,
      stoppedAt: b.pausedAt,
      stoppedBy: b.pausedBy,
      maxConcurrent: b.maxConcurrent,
      dailyBudgetUsd: b.dailyBudgetUsd,
      spent24h: costs.get(b.id) ?? 0,
    };
  });
}

// ---------------------------------------------------------------- the loop

export type LoopDeps = {
  runtime: Runtime;
  /** Fallback checkout for a board with no `repoPath`. */
  cwd?: string;
  /** One board, or every board on the machine when omitted. */
  board?: string;
  intervalMs?: number;
  signal: AbortSignal;
  log?: (line: string) => void;
  now?: () => number;
  /** Stop after this many ticks. Tests only — a loop with no exit is not a thing to unit test. */
  maxTicks?: number;
  /** Reclaim worktrees on the tick. Default on; off for a caller that wants no remote reads. */
  sweep?: boolean;
  /** How often to sweep. Defaults to `SWEEP_EVERY_MS`; a test that wants every tick passes 0. */
  sweepEveryMs?: number;
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
 * Reconcile every board this daemon leads, on an interval, until stopped.
 *
 * Runs in the foreground of whatever process calls it — `kb up` detaches by spawning a second
 * process that calls this, so the loop itself has no opinion about daemonising and can be tested
 * in-process.
 */
export async function loop(deps: LoopDeps): Promise<number> {
  const db = openBoard();
  const now = deps.now ?? Date.now;
  const at = () => new Date(now());
  const intervalMs = deps.intervalMs ?? DEFAULT_INTERVAL_MS;
  const log = deps.log ?? ((l: string) => process.stdout.write(`${stamp()} ${l}\n`));
  const sleep = deps.sleep ?? nap;
  const holder = holderId('daemon');
  const version = buildVersion();
  const sweepEvery = Math.max(1, Math.round((deps.sweepEveryMs ?? SWEEP_EVERY_MS) / intervalMs));

  log(`up${deps.board ? ` on ${deps.board}` : ' on every board'} — every ${Math.round(intervalMs / 1000)}s, `
    + `pid ${process.pid}, build ${version}`);

  let ticks = 0;
  let last = now();
  /** Boards this daemon has taken leadership of, so `daemon_up` is written once, not every tick. */
  const led = new Set<number>();
  // Only announce a refusal, or a board we cannot lead, when it changes. Repeating either every
  // interval produces a log nobody can skim, which is a log nobody reads.
  const said = new Map<string, string | null>();
  const announce = (key: string, msg: string | null) => {
    if (said.get(key) === msg) return;
    said.set(key, msg);
    if (msg) log(msg);
  };

  while (!deps.signal.aborted && (deps.maxTicks === undefined || ticks < deps.maxTicks)) {
    ticks++;
    const drift = now() - last;

    // Did the machine sleep? Node's timers run on a monotonic clock that does not advance while
    // suspended, so the tick after a resume arrives on schedule *by its own reckoning* while the
    // wall clock has jumped hours. Every lease on the board looks expired at that instant, and not
    // one of them expired for a reason anybody chose.
    //
    // Reclaim is skipped for exactly that pass. It is belt and braces — `holderLiveness` already
    // refuses to take a lease off a running local process — but it is the half that also covers a
    // holder on another machine, which no pid check here can see.
    // The first tick sweeps, then one tick in every `sweepEvery`. A daemon started to clean up
    // should not have to wait ten minutes to do it, and a daemon left running should not ask the
    // remote every 45 seconds.
    const sweeping = deps.sweep !== false && (ticks - 1) % sweepEvery === 0;

    const slept = ticks > 1 && drift > intervalMs * SLEEP_FACTOR + SLEEP_SLACK_MS;
    if (slept) log(`woke — ${Math.round(drift / 1000)}s of wall clock passed since the last tick, skipping reclaim`);

    try {
      // Re-read every tick: a board created since the daemon started is picked up without a
      // restart, which is the difference between a controller and a launcher.
      const boards = await db.board.findMany({
        where: deps.board ? { slug: deps.board } : {},
        select: { id: true, slug: true, repoPath: true },
        orderBy: { slug: 'asc' },
      });
      if (slept && boards.length) {
        await db.event.createMany({
          data: boards.map((b) => ({ kind: 'woke', boardId: b.id, actor: holder, payload: { driftMs: drift } })),
        });
      }
      announce('empty', boards.length ? null : 'no boards yet — `kb new` inside a repository creates one');

      for (const b of boards) {
        if (deps.signal.aborted) break;
        if (!(await acquireBoard(db, b.id, holder, intervalMs, version, at))) {
          announce(`lead:${b.slug}`, `not leading ${b.slug} — another daemon holds it`);
          continue;
        }
        if (said.get(`lead:${b.slug}`)) log(`leading ${b.slug} now`);
        said.set(`lead:${b.slug}`, null);
        if (!led.has(b.id)) {
          led.add(b.id);
          await db.event.create({
            data: { kind: 'daemon_up', boardId: b.id, actor: holder, payload: { intervalMs, version } },
          });
        }

        const report = await reconcile({
          runtime: deps.runtime,
          cwd: deps.cwd,
          board: b.slug,
          // One loop, one clock. The pass decides what has expired, and it must decide it against
          // the same time the pass used to decide whether the machine had been asleep.
          now: at,
          reclaim: !slept,
          signal: deps.signal,
          readPr: deps.readPr,
          onEvent: (l) => log(boards.length > 1 ? `[${b.slug}] ${l}` : l),
        });
        announce(`refused:${b.slug}`, report.refused ? `refused  ${b.slug}: ${report.refused}` : null);

        // ---- reclaim the checkouts of work that has landed. After reconcile, never before: a
        // pass that claimed a Job has just locked that Job's worktree, and the sweep must see the
        // lock rather than race it.
        if (sweeping) {
          const repo = b.repoPath ?? deps.cwd;
          if (repo) {
            for (const swept of sweepWorktrees(repo)) {
              const where = boards.length > 1 ? `[${b.slug}] ` : '';
              if (swept.removed) {
                log(`${where}swept ${swept.path} — ${swept.why}`);
                said.delete(`kept:${swept.path}`);
                await db.event.create({
                  data: {
                    kind: 'swept', boardId: b.id, actor: holder,
                    payload: { path: swept.path, branch: swept.branch, why: swept.why },
                  },
                });
              } else {
                // Once, not every ten minutes: a checkout kept for the same reason all week is one
                // line of log, the same way a refusal is.
                announce(`kept:${swept.path}`, `${where}kept  ${swept.path} — ${swept.why}`);
              }
            }
          }
        }
      }
    } catch (e) {
      // A pass that throws must not take the loop with it: the next tick is 45 seconds away and
      // may well succeed, and a daemon that exits on the first transient database error is worse
      // than one that logs and carries on.
      log(`tick failed: ${(e as Error).message}`);
    }

    last = now();
    if (!deps.signal.aborted && (deps.maxTicks === undefined || ticks < deps.maxTicks)) {
      await sleep(intervalMs, deps.signal);
    }
  }

  if (led.size) {
    await db.event.createMany({
      data: [...led].map((boardId) => ({ kind: 'daemon_down', boardId, actor: holder, payload: { ticks } })),
    });
  }
  const freed = await releaseBoards(db, holder);
  log(`down after ${ticks} tick${ticks === 1 ? '' : 's'}, released ${freed} board${freed === 1 ? '' : 's'}`);
  return ticks;
}

// ---------------------------------------------------------------- up / down

export type StartResult = { started: boolean; pid: number; log: string; why?: string };

/**
 * Spawn a detached loop and return.
 *
 * The child is this same binary with `up --foreground`, which keeps one implementation of the loop
 * and means the thing a supervisor (systemd, launchd) runs is a documented command rather than an
 * internal entry point.
 *
 * No lock is taken here. The daemon claims its boards once it is up, and one that can lead nothing
 * says so and idles — taking a lock in advance would need a second source of truth, which is
 * exactly what the `Controller` row replaced.
 */
export function start(
  opts: { board?: string; intervalMs?: number; fake?: boolean; cwd?: string; url?: string; execPath?: string } = {},
): StartResult {
  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
  const lp = opts.board ? logPath(opts.board, opts.url) : machineLogPath(opts.url);
  fs.mkdirSync(path.dirname(lp), { recursive: true });
  const out = fs.openSync(lp, 'a');
  const entry = opts.execPath ?? cliEntry();

  try {
    const child = spawn(
      process.execPath,
      [entry, 'up', '--foreground', '--interval', String(Math.round(intervalMs / 1000)),
        ...(opts.board ? ['--board', opts.board] : []),
        ...(opts.fake ? ['--fake'] : [])],
      {
        cwd: opts.cwd ?? process.cwd(),
        // Its own process group, so a Ctrl-C in the terminal that launched it does not also kill it.
        detached: true,
        stdio: ['ignore', out, out],
        env: process.env,
      },
    );
    child.unref();
    return { started: true, pid: child.pid ?? -1, log: lp };
  } finally {
    fs.closeSync(out);
  }
}

export type StopResult = { stopped: boolean; pid?: number; waitedMs?: number; why?: string };

/**
 * Signal the daemon leading these boards and wait for it to go.
 *
 * SIGTERM, never SIGKILL: the loop's shutdown path is what releases both the Job lease in flight
 * and its own controller rows, and killing it outright would leave both held until they expired.
 * The wait is generous because a clean stop includes interrupting a worker, which is not instant.
 */
export async function stop(
  opts: { board?: string; timeoutMs?: number; pollMs?: number } = {},
): Promise<StopResult> {
  const db = openBoard();
  const rows = await db.controller.findMany({
    where: opts.board ? { board: { slug: opts.board } } : {},
  });
  const live = rows.filter((r) => controllerIsLive(r as ControllerRow));
  if (!live.length) {
    const cleared = await db.controller.deleteMany({ where: { boardId: { in: rows.map((r) => r.boardId) } } });
    return {
      stopped: false,
      why: cleared.count ? 'no daemon running — cleared a stale controller row' : 'no daemon running',
    };
  }

  // One daemon may lead several boards; it is still one process.
  const holders = [...new Set(live.map((r) => r.holder))];
  if (holders.length > 1) {
    return {
      stopped: false,
      why: `${holders.length} daemons lead these boards (${holders.join(', ')}) — stop them one at a time with --board`,
    };
  }
  const holder = holders[0];
  const parsed = parseHolder(holder);
  if (!parsed) return { stopped: false, why: `cannot parse the holder ${holder}` };
  if (holderLiveness(holder, live[0].startedAt) === 'unknown') {
    return { stopped: false, why: `${holder} is on another machine — stop it there` };
  }

  try {
    process.kill(parsed.pid, 'SIGTERM');
  } catch (e) {
    return { stopped: false, pid: parsed.pid, why: `could not signal pid ${parsed.pid}: ${(e as Error).message}` };
  }

  const timeoutMs = opts.timeoutMs ?? 60_000;
  const pollMs = opts.pollMs ?? 200;
  const began = Date.now();
  while (Date.now() - began < timeoutMs) {
    if (!pidIsAlive(parsed.pid)) {
      await db.controller.deleteMany({ where: { holder } });
      return { stopped: true, pid: parsed.pid, waitedMs: Date.now() - began };
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
  // Deliberately not escalating to SIGKILL. A daemon still winding down is finishing the writes
  // that make the record true; killing it here would trade a slow stop for a lost attempt row.
  return {
    stopped: false,
    pid: parsed.pid,
    waitedMs: Date.now() - began,
    why: `pid ${parsed.pid} is still shutting down after ${Math.round(timeoutMs / 1000)}s — it is interrupting a worker. `
      + 'Check `kb up --status`; it will exit on its own.',
  };
}
