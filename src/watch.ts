import fs from 'node:fs';

import type { PrismaClient } from './db.ts';

/**
 * `watch` — letting the outside world see what the board is doing, without asking it repeatedly.
 *
 * `hkb ls` answers *what is true now*; `hkb log` answers *what happened up to now*. Neither answers
 * *tell me when something happens*, and everything that wants to react to hkb — a status line, a
 * notifier, a second controller, a person watching a long run — has had to poll one of them on a
 * timer and diff the result. That is the caller re-deriving a stream hkb already has.
 *
 * ## Cursors, not state
 *
 * The stream is `Event`, and the thing that makes it a stream rather than a log is that **every line
 * carries the id it was read at**. A consumer that dies resumes with `--after <id>` and misses
 * nothing; a consumer that wants everything starts at `--after 0`. Nothing here ever emits "the
 * current state of Job #5" — it emits "event 412 says #5 was claimed", and what the Job looks like
 * now is `hkb show`'s question. This is Kubernetes' `resourceVersion` split, and it is the property
 * that makes a watcher restartable rather than merely reconnectable.
 *
 * The cursor never expires, which is the one way this is *simpler* than `resourceVersion`. Events are
 * append-only and their ids monotonic, so an old cursor is always still meaningful and a consumer
 * that was away for a week replays rather than being told to start over. There is therefore no
 * bookmark event: nothing needs to keep a client's cursor fresh while the board is quiet.
 *
 * **Why a bare `id > cursor` is a complete read here and would not be on a real server.** With an
 * autoincrement key, a transaction that took id 10 can commit *after* one that took 11, and a reader
 * that has advanced past 11 then never sees 10. SQLite cannot do that: there is one writer at a
 * time, file-wide, so a row with a lower id always commits first. The naive cursor is correct
 * because of the storage engine, not because of the query — worth knowing before this is pointed at
 * anything else.
 *
 * ## Woken, not polled
 *
 * CLAUDE.md value 3 rules out polling loops inside commands, and it is right to: a `hkb watch` on a
 * quiet board should cost nothing. So the loop is woken by `fs.watch` on the board's directory — a
 * commit touches the database file (and its journal), which is a change the OS will tell us about —
 * and the timer underneath is a **fallback**, not the mechanism. That is the same shape as the
 * controller itself: a change is a hint that something is worth re-reading, never the thing that is
 * acted on. If the OS gives us nothing (a filesystem with no inotify, a bind mount, a network
 * share), the fallback still delivers every event, just later.
 */

/** One event as it comes off the board. Structural, so tests need no Prisma row. */
export type WatchEvent = {
  id: number;
  at: Date;
  kind: string;
  jobId: number | null;
  boardId: number | null;
  actor: string | null;
  payload: unknown;
};

/** What a watch is looking at. Empty means every board on this machine. */
export type WatchScope = { jobId?: number; boardId?: number };

/**
 * The `where` for a scope.
 *
 * A board's events are the ones filed *against the board* plus the ones filed against its Jobs —
 * two shapes, because `reclaimed` carries a jobId and no boardId while `daemon_up` carries the
 * reverse. `hkb log` asks the same question and this is the same answer, extracted so the two
 * cannot drift into disagreeing about what "on this board" means.
 */
export function watchWhere(scope: WatchScope): Record<string, unknown> {
  if (scope.jobId) return { jobId: scope.jobId };
  if (scope.boardId) return { OR: [{ boardId: scope.boardId }, { job: { boardId: scope.boardId } }] };
  return {};
}

/**
 * One event, as a line.
 *
 * Shared with `hkb log` so the two never diverge, with one difference that is the whole point of the
 * verb: a watch line leads with its **id**, because that id is what a consumer feeds back as
 * `--after`. A stream whose lines cannot be pointed at is a stream you can only ever join at the
 * end.
 */
export function eventLine(e: WatchEvent, withId = false): string {
  const who = e.actor ? `  ${e.actor}` : '';
  const extra = e.payload && Object.keys(e.payload as object).length ? `  ${JSON.stringify(e.payload)}` : '';
  const id = withId ? `${String(e.id).padStart(6)}  ` : '';
  return `${id}${e.at.toISOString()}  ${(e.jobId ? `#${e.jobId}` : '—').padEnd(5)} ${e.kind.padEnd(13)}${who}${extra}`;
}

/** How many events one read takes. A drained full page goes straight round again. */
const PAGE = 200;

/** The fallback interval: how long a missed filesystem event may delay a line. */
export const WATCH_FALLBACK_MS = 2_000;

/**
 * A latch that a filesystem event or a timer can open, and that a waiter can wait on.
 *
 * Deliberately not an EventEmitter: the only question the loop asks is *has anything happened since
 * I last looked*, and a poke that arrives while nobody is waiting must not be lost — so the flag is
 * sticky and the next `wait()` returns immediately.
 */
class Latch {
  private open = false;
  private wake: (() => void) | null = null;

  poke(): void {
    this.open = true;
    const w = this.wake;
    this.wake = null;
    w?.();
  }

  /** Resolve when poked, when `ms` has passed, or when `signal` aborts. */
  async wait(ms: number, signal?: AbortSignal): Promise<void> {
    if (this.open || signal?.aborted) { this.open = false; return; }
    await new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', done);
        this.wake = null;
        resolve();
      };
      const timer = setTimeout(done, ms);
      // The process must not be held open by the fallback timer alone: a watch that has been
      // aborted should let Node exit, and an unref'd timer still fires while anything else is live.
      timer.unref?.();
      signal?.addEventListener('abort', done, { once: true });
      this.wake = done;
    });
    this.open = false;
  }
}

export type WatchOptions = {
  db: PrismaClient;
  scope: WatchScope;
  /** Emit events with an id greater than this. */
  after: number;
  /** The directory holding the board file — what `fs.watch` is pointed at. */
  dir: string;
  signal: AbortSignal;
  /** Called for every event, in id order, exactly once. */
  onEvent: (e: WatchEvent) => void;
  intervalMs?: number;
  /** Stop after this many events. Undefined means until aborted. */
  limit?: number;
};

/**
 * Follow the board's event stream until the signal aborts, and return the cursor reached.
 *
 * The returned cursor is the contract: whatever stopped the watch, feeding this number back as
 * `after` resumes exactly where it left off. It is returned rather than only printed so a caller
 * inside this process — a test, a future daemon-side subscriber — gets the same guarantee a shell
 * consumer gets from the last line it read.
 */
export async function watchEvents(o: WatchOptions): Promise<number> {
  const where = watchWhere(o.scope);
  let cursor = o.after;
  let seen = 0;
  const latch = new Latch();

  // Best effort by construction: a filesystem that cannot watch is a slower watch, never a broken
  // one, so this is a hint and its failure is not an error the operator has to hear about.
  let watcher: fs.FSWatcher | null = null;
  try {
    watcher = fs.watch(o.dir, () => latch.poke());
    watcher.on('error', () => { /* the fallback interval still delivers everything */ });
  } catch { /* same */ }

  try {
    for (;;) {
      const rows = await o.db.event.findMany({
        where: { ...where, id: { gt: cursor } },
        orderBy: { id: 'asc' },
        take: PAGE,
      });
      for (const e of rows) {
        o.onEvent(e as WatchEvent);
        cursor = e.id;
        seen += 1;
        if (o.limit !== undefined && seen >= o.limit) return cursor;
      }
      // A full page means there is probably more behind it; go again without waiting, so catching
      // up from an old cursor is not paced by the fallback interval.
      if (rows.length === PAGE) continue;
      if (o.signal.aborted) return cursor;
      await latch.wait(o.intervalMs ?? WATCH_FALLBACK_MS, o.signal);
      if (o.signal.aborted) {
        // One last read on the way out. A watch told to stop should not drop an event that landed
        // between its last read and the abort — the cursor it returns must mean what it says.
        const tail = await o.db.event.findMany({
          where: { ...where, id: { gt: cursor } }, orderBy: { id: 'asc' }, take: PAGE,
        });
        for (const e of tail) {
          if (o.limit !== undefined && seen >= o.limit) break;
          o.onEvent(e as WatchEvent);
          cursor = e.id;
          seen += 1;
        }
        return cursor;
      }
    }
  } finally {
    watcher?.close();
  }
}
