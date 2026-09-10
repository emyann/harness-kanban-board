import { reconcile, type ControllerDeps, type ReconcileReport } from './controller.ts';
import { openBoard } from './db.ts';
import { reconcileRuns, type RunsReport } from './runs.ts';

/**
 * One pass of **every** kind on the board, in the order they depend on each other.
 *
 * ## Why this file exists at all
 *
 * ADR-018's boundary is a *direction of dependency*: the board may use core primitives, and the core
 * may never name a board concept. `Run`/`Step` is a board kind (`src/runs.ts`); `Job` is the core
 * one (`src/controller.ts`). So the Job controller must not call the Run controller — and the Run
 * controller must not be wired into it "just here, just this once", which is how the last three
 * attempts at this line dissolved.
 *
 * What is left is composition, and composition is a third thing that depends on both. It is thirty
 * lines, it is the whole of the coupling, and it is greppable: `test/boundary.test.ts` asserts that
 * neither `src/controller.ts` nor `src/daemon.ts` imports `src/runs.ts`, so the day somebody finds
 * it convenient to reach across, a test says so by name.
 *
 * This is also where the seam between hkb's two halves is visible in one screen. **A step becoming
 * ready is a *request* to schedule; whether it runs now is the fleet's business.** `reconcileRuns`
 * files rows and has no opinion about concurrency, budgets, leases or liveness — it must never
 * import `src/limits.ts` or `src/liveness.ts`, and never touch `Lease`. If the Run controller ever
 * grows its own concurrency knob, sequencing and scheduling have re-conflated and the two features
 * are one again.
 *
 * ## The order, which is load-bearing
 *
 * Runs first, then the claim loop — the same argument `applyProposals` already makes for sitting
 * where it does. A step whose predecessor succeeded on the last pass becomes a pending Job here and
 * is claimable *in this same pass*, so a two-step run does not cost an extra tick of the daemon's
 * timer per step. Reversed, every edge would add up to a whole interval of latency for nothing.
 */

/** What one whole pass did: the Job controller's report, plus what the runs added to it. */
export type PassReport = ReconcileReport & { runs: RunsReport };

/**
 * One pass: file what is ready, then run what is pending.
 *
 * `deps.only` skips the runs entirely, and that is a deliberate reading of what the flag means.
 * `hkb run <id>` is *"do this one Job"* — an operator pointing at a row. Cutting new rows off a run
 * they did not mention would be the command doing something they did not ask for, and the whole
 * point of `--only` is to be narrow.
 */
export async function pass(deps: ControllerDeps): Promise<PassReport> {
  const runs = deps.only
    ? { filed: [], stalled: [] }
    : await reconcileRuns(openBoard(), { board: deps.board, cwd: deps.cwd });
  const report = await reconcile(deps);
  // Merged into `filed`, because from the operator's side there is one answer to "what did this
  // pass create": a Job filed from an approved proposal and a Job filed from a ready step are the
  // same fact. Kept in `runs` as well, because the *reason* differs and a caller may want it.
  report.filed.push(...runs.filed);
  report.filed.sort((a, b) => a - b);
  return { ...report, runs };
}

/** A whole pass, to a fixpoint — `reconcileToRest` with the runs in front of it. */
export async function passToRest(deps: ControllerDeps, maxPasses = 20): Promise<PassReport[]> {
  const passes: PassReport[] = [];
  for (let i = 0; i < maxPasses; i++) {
    const r = await pass(deps);
    passes.push(r);
    if (deps.signal?.aborted) break;
    // `filed` counts as movement, unlike in `reconcileToRest`: a pass that filed a step's Job and
    // claimed nothing has still changed the board, and stopping there would leave the Job it just
    // created for the *next* call rather than this one. A run therefore reaches its end inside one
    // `passToRest`, which is what a test — and an operator running it in the foreground — expects.
    if (!r.claimed.length && !r.reclaimed.length && !r.filed.length) break;
  }
  return passes;
}
