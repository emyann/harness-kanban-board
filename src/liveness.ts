import os from 'node:os';

/**
 * Is the process that holds this lease still alive?
 *
 * A lease expires on the **wall clock**, and the wall clock lies across a suspend. A run's own
 * `timeoutMs` is a `setTimeout`, and Node's timers are monotonic — on Linux they do not advance
 * while the machine is asleep. So after a two-hour laptop sleep a worker that is five minutes into
 * a thirty-minute Job believes, correctly, that it has twenty-five minutes left, while its lease
 * row says it expired an hour and a half ago. Reclaiming on expiry alone would mark that live
 * attempt `lost` and start a second one: the same double run the lease fix closed, arriving by a
 * different road.
 *
 * Expiry is therefore evidence, not proof. This module supplies the proof when it can get it, and
 * says so when it cannot — the three answers are deliberately not a boolean.
 */

export type Liveness =
  | 'alive'    // the holder is a running process on this machine. Do not touch its lease.
  | 'dead'     // the holder was on this machine and is gone. Reclaim, without waiting for expiry.
  | 'unknown'; // another machine's holder. We cannot see it; fall back to the clock.

/** `<hostname>/<pid>@<runtime>` — the host is what makes the pid mean anything. */
export function holderId(runtime: string, pid = process.pid, host = os.hostname()): string {
  return `${host}/${pid}@${runtime}`;
}

const HOLDER = /^([^/]+)\/(\d+)@/;

export function parseHolder(holder: string): { host: string; pid: number } | null {
  const m = HOLDER.exec(holder);
  return m ? { host: m[1], pid: Number(m[2]) } : null;
}

/**
 * When this machine last booted.
 *
 * `os.uptime()` is seconds since boot from the kernel's boot clock, which *does* count time spent
 * suspended — that is what makes it usable here, where the whole problem is a clock that did not.
 */
export const bootTime = (now = Date.now()) => now - os.uptime() * 1000;

/** Boot time is measured, so it carries a little slop; only call a lease pre-boot when it clearly is. */
const BOOT_SLOP_MS = 5_000;

/**
 * Whether the holder of a lease is still running.
 *
 * `acquiredAt` is not decoration: a pid is only unique until it is recycled, and the cheapest
 * proof that a pid was recycled is that the machine rebooted after the lease was taken. Without
 * that check a lease acquired at pid 4242 before a reboot would read as `alive` the moment
 * anything else landed on 4242, and the Job would never be reclaimed at all — a stuck Job rather
 * than a double-run one, but stuck forever.
 */
export function holderLiveness(
  holder: string,
  acquiredAt: Date,
  deps: { hostname?: string; now?: () => number; alive?: (pid: number) => boolean } = {},
): Liveness {
  const parsed = parseHolder(holder);
  if (!parsed) return 'unknown';

  const me = deps.hostname ?? os.hostname();
  // A pid on another machine is a number with no referent here. Say so rather than guessing:
  // guessing `dead` double-runs, and guessing `alive` strands the Job.
  if (parsed.host !== me) return 'unknown';

  const now = deps.now?.() ?? Date.now();
  if (acquiredAt.getTime() < bootTime(now) - BOOT_SLOP_MS) return 'dead';

  return (deps.alive ?? pidIsAlive)(parsed.pid) ? 'alive' : 'dead';
}

/**
 * Signal 0 asks the kernel "could I signal this pid?" without sending anything.
 * `EPERM` means the process exists and belongs to somebody else — which is still *exists*, and
 * the only question here is whether it is running.
 */
export function pidIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}
