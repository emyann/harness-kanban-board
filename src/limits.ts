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
 * Has this Job outrun its own wall clock — the one that spans every attempt?
 *
 * Kubernetes' `JobSpec.activeDeadlineSeconds`, measured from the Job's `startTime`, which here is
 * the first attempt's `startedAt`. The per-attempt clock (`attemptDeadlineSeconds`) bounds a
 * runaway *session*; this bounds a runaway *Job*. Without it, three retries under a 90-minute
 * attempt clock can hold a slot for four and a half hours and still be "within its caps".
 *
 * **Pure, and in this module rather than the controller**, because it is a ceiling and this is where
 * ceilings live (`src/spec.ts`'s header draws that line: a *default* is a value a Job may override
 * and is resolved there; a *ceiling* is a limit it may not exceed and is enforced here). The
 * controller supplies `startedAt` and `now`; nothing here reads a clock or a database, so the case
 * that matters — the refusing one — is testable without either.
 *
 * Null `seconds` is "no Job-wide deadline", which is the shipped default and Kubernetes' own. Null
 * `startedAt` is a Job that has never run: it cannot have outrun a clock that never started.
 */
export function deadlineExceeded(
  startedAt: Date | null | undefined,
  now: Date,
  seconds: number | null | undefined,
): boolean {
  if (seconds == null || startedAt == null) return false;
  return now.getTime() - startedAt.getTime() >= seconds * 1000;
}

/**
 * What the operator is told when a Job is ended by its own deadline.
 *
 * Names the two numbers that decide it and the one flag that changes it, because "DeadlineExceeded"
 * on its own sends nobody anywhere. It says `hkb job set --deadline` rather than "retry", since a
 * retry is precisely what this outcome refuses: the Job is out of wall clock, not out of luck.
 */
export function deadlineShortfall(jobId: number, ranForMs: number, seconds: number): string {
  const mins = (ms: number) => `${Math.round(ms / 60_000)}m`;
  return `#${jobId} ran ${mins(ranForMs)} across its attempts and its deadline is ${mins(seconds * 1000)} `
    + `— ended without another attempt, retries or not. `
    + `\`hkb job set ${jobId} --deadline <seconds>\` then \`hkb retry ${jobId}\` to give it more wall clock.`;
}
