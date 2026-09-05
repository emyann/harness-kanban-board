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

export type ClaimGate = { ok: true } | { ok: false; why: string };

export type ClaimInputs = {
  /** The board's kill switch. */
  pausedAt: Date | null;
  pausedBy: string | null;
  /** Leases held right now, on this board, by anyone. */
  liveLeases: number;
  maxConcurrent: number;
  /** Spent on this board in the last rolling 24 hours. */
  spent24h: number;
  /** The board's ceiling, or null for no ceiling. */
  dailyBudgetUsd: number | null;
  /** What this Job could cost if it runs to its own cap. */
  jobBudgetUsd: number;
};

export function gateClaim(i: ClaimInputs): ClaimGate {
  if (i.pausedAt) {
    const by = i.pausedBy ? ` by ${i.pausedBy}` : '';
    return { ok: false, why: `the board is stopped${by} since ${i.pausedAt.toISOString()} — \`kb start\` to resume` };
  }

  if (i.liveLeases >= i.maxConcurrent) {
    return {
      ok: false,
      why: `${i.liveLeases} of ${i.maxConcurrent} concurrent slots are in use — raise maxConcurrent or wait`,
    };
  }

  if (i.dailyBudgetUsd !== null) {
    // The ceiling is checked against what this Job *could* cost, not what it has cost. A cap that
    // only notices after the money is gone is a report, not a ceiling.
    const projected = i.spent24h + i.jobBudgetUsd;
    if (projected > i.dailyBudgetUsd) {
      return {
        ok: false,
        why: `board budget: $${i.spent24h.toFixed(2)} spent in 24h and this Job may cost $${i.jobBudgetUsd.toFixed(2)}, `
          + `over the $${i.dailyBudgetUsd.toFixed(2)} ceiling — raise it or wait for the window to roll`,
      };
    }
  }

  return { ok: true };
}

/** The start of the rolling window. Not a calendar day: there is no timezone to get wrong. */
export const windowStart = (now: Date) => new Date(now.getTime() - 24 * 60 * 60 * 1000);
