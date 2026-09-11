/**
 * Whether another Job may start.
 *
 * Pure on purpose. Every guard in this system that turned out to be silently inert — the admission
 * gate under `bypassPermissions`, the worktree base that made a tree full of commits read as empty
 * — was inert because nothing tested that it *refused*. A decision with no I/O in it can be tested
 * exhaustively against the refusing case, which is the case that matters.
 *
 * Three rules, checked before a claim and never during a run: a ceiling that could stop a running
 * worker would strand its worktree, while one that declines to start another is only a decision.
 */

/**
 * Which ceiling said no.
 *
 * Named, not just described, because the caller has to treat them differently: a `stopped` board
 * will not un-stop by waiting, while `concurrency` and `budget` are both walls a reconciler can be
 * standing at *because of its own runs in flight* — and a refusal it caused itself is not news to
 * report, it is a reason to wait for a slot. `src/controller.ts` makes exactly that distinction,
 * and it cannot make it by matching on prose.
 */
export type ClaimLimit = 'stopped' | 'concurrency' | 'budget';

export type ClaimGate = { ok: true } | { ok: false; limit: ClaimLimit; why: string };

export type ClaimInputs = {
  /** The board's kill switch. */
  pausedAt: Date | null;
  pausedBy: string | null;
  /** Leases held right now, on this board, by anyone. */
  liveLeases: number;
  /** How many Jobs may hold a lease on this board at once, across every reconciler. */
  maxConcurrent: number;
  /** Spent on this board in the last rolling 24 hours, by attempts that have ENDED. */
  spent24h: number;
  /**
   * Promised to attempts on this board that are still open, and so have reported no cost yet.
   *
   * Without this the budget ceiling stopped meaning anything the moment two Jobs could run at once:
   * `spent24h` only moves when an attempt ends, so N concurrent claims would each be judged against
   * a spend none of them had yet contributed to, and the board could commit N × its ceiling in the
   * time it takes the first one to finish. It is the same rule the ceiling already used for the
   * claimant — charge what a run *could* cost — applied to the runs already going.
   *
   * The caller sums `Attempt.maxBudgetUsd`, the cap each live run was CLAIMED under, and not
   * whatever the Job's spec resolves to today. Those differ exactly when someone edits a board's
   * `defaultMaxBudgetUsd` while work is in flight, and a re-resolving caller would then hand this
   * gate a number no running attempt is bound by — lower than the truth if the default was lowered,
   * which admits work that takes the board past its ceiling. The freeze is argued on
   * `Attempt.maxBudgetUsd` in `prisma/schema.prisma`; what matters here is only that this input is
   * a promise already made, never a promise recomputed.
   */
  committedUsd: number;
  /** The board's ceiling, or null for no ceiling. */
  dailyBudgetUsd: number | null;
  /**
   * What this Job could cost if it runs to its own cap — resolved through `src/spec.ts`, since the
   * Job's own column is null whenever it takes the board's default or the built-in.
   */
  jobBudgetUsd: number;
};

export function gateClaim(i: ClaimInputs): ClaimGate {
  if (i.pausedAt) {
    const by = i.pausedBy ? ` by ${i.pausedBy}` : '';
    return {
      ok: false,
      limit: 'stopped',
      why: `the board is stopped${by} since ${i.pausedAt.toISOString()} — \`hkb start\` to resume`,
    };
  }

  if (i.liveLeases >= i.maxConcurrent) {
    return {
      ok: false,
      limit: 'concurrency',
      why: `${i.liveLeases} of ${i.maxConcurrent} concurrent slots are in use — `
        + '`hkb boards set <slug> --max-concurrent <n>` raises the ceiling, or wait for a run to finish',
    };
  }

  if (i.dailyBudgetUsd !== null) {
    // The ceiling is checked against what this Job *could* cost, not what it has cost. A cap that
    // only notices after the money is gone is a report, not a ceiling.
    const projected = i.spent24h + i.committedUsd + i.jobBudgetUsd;
    if (projected > i.dailyBudgetUsd) {
      const inFlight = i.committedUsd > 0
        ? ` plus $${i.committedUsd.toFixed(2)} committed to runs in flight` : '';
      const wait = i.committedUsd > 0
        ? 'raise it, or wait for a run to finish or the window to roll'
        : 'raise it or wait for the window to roll';
      return {
        ok: false,
        limit: 'budget',
        why: `board budget: $${i.spent24h.toFixed(2)} spent in 24h${inFlight} `
          + `and this Job may cost $${i.jobBudgetUsd.toFixed(2)}, `
          + `over the $${i.dailyBudgetUsd.toFixed(2)} ceiling — ${wait}`,
      };
    }
  }

  return { ok: true };
}

/** The start of the rolling window. Not a calendar day: there is no timezone to get wrong. */
export const windowStart = (now: Date) => new Date(now.getTime() - 24 * 60 * 60 * 1000);

/**
 * Has this Job outrun its deadline — the one that spans every attempt?
 *
 * Kubernetes' `JobSpec.activeDeadlineSeconds`, with **one deliberate deviation, and the name is the
 * argument for it**. Kubernetes measures from the Job's `startTime`, so a Pod sitting `Pending`
 * burns the clock; that is tolerable there because a Pod pends for seconds while the scheduler finds
 * a node. An hkb Job pends for *hours*: at `maxConcurrent: 1` — the shipped default — a Job whose
 * first attempt crashed at 09:00 may not be claimed again until 14:00. Measuring wall clock there
 * fails a Job that used five minutes of compute because the board was busy, which bounds luck rather
 * than cost.
 *
 * So this counts **time a session was actually running**: the sum of the attempts' own durations.
 * It is what `active` means in the field's own name, and it makes the deadline answer the question
 * an operator is really asking — how much work is this Job allowed to be worth.
 *
 * **Pure, and in this module rather than the controller**, because it is a ceiling and this is where
 * ceilings live (`src/spec.ts`'s header draws that line). The controller sums the attempts and calls
 * in; nothing here reads a clock or a database, so the refusing case is testable without either.
 *
 * Null `seconds` is "no deadline", which is the shipped default and Kubernetes' own.
 */
export function deadlineExceeded(activeMs: number, seconds: number | null | undefined): boolean {
  if (seconds == null) return false;
  return activeMs >= seconds * 1000;
}

/**
 * How long a Job has actually been running, across every attempt.
 *
 * An attempt still open is counted up to `now`, which is what makes the claim-time guard and the
 * post-run verdict agree: the run in flight is part of what the Job has spent.
 */
export function activeMs(
  attempts: { startedAt: Date; endedAt?: Date | null }[],
  now: Date,
): number {
  return attempts.reduce(
    (sum, a) => sum + Math.max(0, (a.endedAt ?? now).getTime() - a.startedAt.getTime()),
    0,
  );
}

/**
 * A duration an operator reads, with resolution where the flags have it.
 *
 * Seconds below ten minutes, minutes above. The threshold is not cosmetic: the flags take any
 * positive integer of seconds, so a 90-second deadline and a 100-second run are both reachable —
 * and rounding those to minutes printed "ran 2m and its deadline is 2m", which reads as a Job
 * killed for hitting a limit it did not exceed. Two different numbers must not render the same.
 */
const duration = (ms: number): string =>
  ms < 600_000 ? `${Math.round(ms / 1000)}s` : `${Math.round(ms / 60_000)}m`;

/**
 * What the operator is told when a Job is ended by its own deadline.
 *
 * Names the two numbers that decide it and the way back, because "DeadlineExceeded" on its own sends
 * nobody anywhere. It says `hkb job set --deadline` rather than "retry", since a retry is precisely
 * what this outcome refuses: the Job is out of deadline, not out of luck.
 */
export function deadlineShortfall(jobId: number, ranForMs: number, seconds: number): string {
  return `#${jobId} has run ${duration(ranForMs)} across its attempts and its deadline is `
    + `${duration(seconds * 1000)} — ended without another attempt, retries or not. `
    + `\`hkb job set ${jobId} --deadline <seconds>\` then \`hkb retry ${jobId}\` to give it more.`;
}

/**
 * How much longer a Job whose last attempt failed must wait before it may be claimed again.
 *
 * Kubernetes recreates a failed Job's Pod after a back-off — 10s, doubling to a six-minute cap — and
 * `backoffLimit` counts the retries. hkb had only the count. The spacing was the daemon's interval,
 * by accident: a pass read its pending Jobs once and then sat on its runs, so a Job that failed
 * mid-pass could not be claimed before the next tick. When a pass stopped sitting on its runs and a
 * run's end began to wake the loop, the accident went with it — a Job that fails in a second was
 * retried on the next wake, by anybody's run, and spent its retries in seconds. So the spacing is
 * written down here, as a fact about the Job rather than about who woke whom: constant rather than
 * doubling, because the accident being kept was constant.
 *
 * Only an attempt that **spent a retry** waits — the two exemptions `charged` makes in
 * `src/controller.ts`. A `stopped` attempt was the operator turning the daemon off, and waiting after
 * it would delay every resume by an interval; a `completed` one belongs to a gated Job its approval
 * re-queued, which a person is waiting on.
 *
 * Pure: the caller reads the last ended attempt and the clock. Zero means claimable now.
 */
export function retryBackoffMs(
  last: { endedAt: Date; outcome: string | null } | null,
  now: Date,
  afterMs: number,
): number {
  if (!last || afterMs <= 0) return 0;
  if (last.outcome === 'stopped' || last.outcome === 'completed') return 0;
  return Math.max(0, last.endedAt.getTime() + afterMs - now.getTime());
}
