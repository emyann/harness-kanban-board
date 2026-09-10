import { realpathSync } from 'node:fs';
import { openBoard } from './db.ts';
import { exportOutputs } from './exports.ts';
import { workspaceName } from './workspaces.ts';
// The read model's own predicates, imported so a second copy cannot drift from the printed one.
import { declaredExports, producedNothing } from './read.ts';
import { readTemplate, withStandingSteps } from './templates.ts';
import {
  approvedPrompt, withArtifacts, withCheck, withCheckFailure, withGuide, withInputs, withProposal,
  withResults, withStandingRules,
} from './brief.ts';
import {
  checkShortfall, describeCheck, runCheck, storedCheck, type CheckRecord,
} from './check.ts';
import { resolvePlugins } from './plugins.ts';
import { readGuide, missingGuide } from './guide.ts';
import {
  declaredInputs, readFileInput, renderBoard, missingInputs, describeSource,
  type ResolvedInput, type BoardRow,
} from './inputs.ts';
import {
  declaredResults, resultPaths, ensureResultsDir, collectResults, clearResults, missingResults,
} from './results.ts';
import {
  declaredArtifacts, artifactPaths, ensureArtifactsDir, collectArtifacts, clearEmptyArtifacts,
  missingArtifacts, bytes,
} from './artifacts.ts';
import {
  PROPOSAL_ARTIFACT, proposalGate, readProposal, storedProposal, type Proposal,
} from './proposals.ts';
import { activeMs, deadlineExceeded, deadlineShortfall, gateClaim, windowStart, type ClaimGate } from './limits.ts';
import { resolveSpec } from './spec.ts';
import { holderId, holderLiveness } from './liveness.ts';
import type { Runtime, RuntimeEvent, WorkerOutcome } from './runtime/index.ts';


/**
 * The controller for the Job kind.
 *
 * One reconcile pass: read the Jobs that want to run, acquire a lease on each, run it, record what
 * happened. It is deliberately the whole of the control plane for this kind — if it grows a second
 * concern, that concern is a second kind.
 *
 * The shape is a reconciler, not a queue consumer: it reads observed state, compares it to desired
 * state, and takes one step. That means it is safe to run repeatedly, safe to interrupt, and safe
 * to run while another host is running it — the lease is what makes the last one true.
 *
 * What it deliberately does NOT do: decide whether the work was any good. A Job is `succeeded` when
 * its agent's session completed AND everything the Job *declared* it would produce is there — the
 * second half is ADR-008's, and it is still not a judgement: a declared path is present or it is
 * not, and nothing here has to believe the agent. Whether the outcome is any *good* remains a
 * judgement, and judgements belong to a kind that has a reviewer in it.
 * ## Why one pass runs several Jobs at once
 *
 * It did not, and `maxConcurrent` was the lie that came of it: this loop awaited each run inside
 * the `for`, so a pass ran Jobs strictly one at a time and the ceiling only ever bound *between*
 * reconcilers. An operator raising it from 1 to 2 got exactly what they had.
 *
 * The tempting fix was the cheap one — rename it `maxAdmitted`, document that throughput comes
 * from running more reconcilers, and call that the Kubernetes shape. It is not the Kubernetes
 * shape, and the giveaway is one table over: `Controller` is keyed `@@id(boardId)`, so
 * `acquireBoard` elects **one leader per board** and a second daemon on the same board is refused.
 * Kubernetes scales controllers for availability, never for throughput; the throughput knob on a
 * Kubernetes Job is `parallelism`, which the Job controller honours by starting that many Pods.
 * Documenting "run more reconcilers" would therefore have documented something the leader election
 * forbids, leaving the only supported way to use the ceiling a `hkb run` racing the daemon — which
 * is a workaround, not a design. A setting whose only honest value is 1 is a setting to delete,
 * and deleting it would have taken the one ceiling an operator most obviously wants with it.
 *
 * So the ceiling is made real, and this is what that costs:
 *
 *   - **Admission stays serial.** The gate and the compare-and-swap happen one Job at a time; only
 *     the run itself is concurrent, so two claims can never read the same `liveLeases` count.
 *   - **Our own runs are not "contention".** A gate that refuses because this very pass filled the
 *     board is not a refusal to report — it is a reason to wait for a slot. `ClaimLimit` is what
 *     lets the two be told apart.
 *   - **The budget ceiling learned about work in flight.** `spent24h` only moves when an attempt
 *     ends, so concurrency would have let N claims each be judged against a spend none of them had
 *     contributed to yet. See `committedUsd` in `src/limits.ts`.
 *   - **Every operator-facing line is tagged `#<job>`.** Indentation grouped lines under a claim,
 *     which only reads as grouping while one Job is speaking. `src/daemon.ts` already does the
 *     same thing per board, so a busy log reads `[board] #12 …`.
 *   - **Shutdown stops all of them.** One `AbortSignal` reaches every in-flight run, and the pass
 *     does not return until each has recorded its own attempt.
 *
 * The CAS is still the thing that makes it safe. The gate refuses contention it can see; the
 * lease insert refuses the contention it cannot.
 */

export type ControllerDeps = {
  runtime: Runtime;
  /**
   * The repository, when the Board does not say.
   *
   * The Board's `repoPath` is the real answer — a machine-level daemon has no meaningful cwd of
   * its own, and "wherever the operator was standing" stopped being a usable definition of the
   * repository the moment one process started serving several. This remains as the fallback for a
   * board with no repo set, which is how `hkb run` in a checkout and every test still works.
   */
  cwd?: string;
  host?: string;
  /** How long a lease is good for. A holder that dies without releasing is reclaimable after this. */
  leaseMs?: number;
  now?: () => Date;
  onEvent?: (line: string) => void;
  /** The runtime's own stream — tool calls and text, for an operator watching a foreground run. */
  onRuntimeEvent?: (e: RuntimeEvent) => void;
  /** Reconcile exactly one Job instead of every pending one. `hkb run <id>`. */
  only?: number;
  /**
   * Scope to one board. A Board is the namespace, and a controller that ignores it reaches across
   * every namespace on the host — which is what `hkb run --board other` silently did before.
   */
  board?: string;
  /**
   * Reclaim leases whose holder is gone. Default on.
   *
   * The daemon turns it off for exactly one pass after it notices the wall clock jumped, because
   * every lease on the board looks expired at that instant and none of them expired for a reason
   * anyone chose. See `src/daemon.ts`.
   */
  reclaim?: boolean;
  /**
   * The operator is shutting down. Claiming stops, and the run in flight is stopped rather than
   * left to finish: `hkb down` that took thirty minutes to return would not be a stop.
   */
  signal?: AbortSignal;
};

export type ReconcileReport = {
  /** Why claiming stopped, when a ceiling or the kill switch stopped it. */
  refused: string | null;
  claimed: number[];
  succeeded: number[];
  failed: number[];
  retrying: number[];
  reclaimed: number[];
  skipped: number[];
  /** Attempts ended by the operator, not by the work. They are pending again and cost no retry. */
  stopped: number[];
  /** Jobs CREATED this pass from an approved proposal — the controller's write, never a worker's. */
  filed: number[];
  /**
   * Jobs now waiting on a person (ADR-010's gate).
   *
   * Its own list because it was previously counted as `retrying`, which told the operator the
   * machine would pick the Job up again when in fact it is waiting for *them* — the one state
   * nothing but a person can clear, reported as the one thing that needs nobody.
   */
  suspended: number[];
};

/** Compared by real path, so a symlinked repository is not mistaken for isolation. */
const fsRealpath = (p: string): string => { try { return realpathSync(p); } catch { return p; } };

const nowDefault = () => new Date();

/** Teardown after an abort is not instant (measured: an 8s timeout ended at ~10s). Five minutes
 *  is far more than that costs, and it is the margin by which a lease outlives its run. */
const LEASE_GRACE_MS = 5 * 60_000;

/**
 * Decide what a Job's next phase is, given how its attempt ended and what it has left.
 *
 * Pure, so it is the part worth testing exhaustively: everything interesting about retry, resume
 * and giving up is decided here, and nothing here touches a database or a model.
 */
export type Decision = {
  phase: 'succeeded' | 'failed' | 'pending' | 'suspended';
  outcome: 'completed' | 'max_turns' | 'max_budget' | 'timed_out' | 'refused' | 'crashed' | 'stopped' | 'no_output' | 'no_input' | 'check_failed' | 'deadline_exceeded';
  resumable: boolean;
  /**
   * What to write on the Job's `lastError`, when the reason it stopped is something a *human* has
   * to change before it could go any differently. Null when the outcome speaks for itself and the
   * runtime's own error text is the better line.
   */
  lastError: string | null;
};

/**
 * What a Job that spent its whole cap needs said to it. It is the only outcome this controller
 * declines to retry *while retries remain*, so it owes the operator the reason and the next move.
 */
function budgetAdvice(maxBudgetUsd?: number): string {
  const cap = maxBudgetUsd === undefined ? 'its whole budget' : `its whole $${maxBudgetUsd.toFixed(2)} budget`;
  const bigger = maxBudgetUsd === undefined ? '<usd>' : (maxBudgetUsd * 2).toFixed(2);
  return `spent ${cap} and stopped with work left. Not retried — a retry gets the same cap and `
    + `stops in the same place. Raise it and re-queue: \`hkb retry <id> --max-budget ${bigger}\`, `
    + 'or file a smaller brief. The session is kept, so that retry resumes rather than starting cold.';
}


/** What a Job that declared an output and did not produce it owes the operator. */
function missingOutputs(id: number, missing: string[]): string {
  const one = missing.length === 1;
  return `#${id} declared ${missing.map((m) => `\`${m}\``).join(', ')} and the run left ${one ? 'it' : 'them'} `
    + `unwritten, so the attempt failed: a declared output that is not there is not work that was done. `
    + `Look in the attempt's summary for what it did instead, then either fix the brief so it produces `
    + `that exact path, or re-file the Job with the path the work really writes. \`hkb retry ${id}\` `
    + 'runs it again once one of those is true.';
}

export function nextPhase(
  outcome: WorkerOutcome | null,
  /** How many attempts have spent a retry, including this one. 1-based. */
  attempt: number,
  maxRetries: number,
  /** The cap this attempt ran under — which is precisely the cap a retry would get. */
  maxBudgetUsd?: number,
  /**
   * The Job's own completion check, when it ran and refused (ADR-016 §3, `src/check.ts`).
   *
   * Passed in rather than read here, because this function is pure and a check is a subprocess.
   * The controller runs it after the run and calls back in with what it said.
   */
  failedCheck?: CheckRecord | null,
  /**
   * The Job's own wall clock, already decided (`deadlineExceeded`, `src/limits.ts`).
   *
   * Passed in rather than computed here for the reason `failedCheck` is: this function is pure and
   * a clock is not. The controller measures from the first attempt's `startedAt` and calls back in.
   */
  jobDeadline?: { jobId: number; exceeded: boolean; ranForMs: number; seconds: number } | null,
): Decision {
  // **First, above the check and above `completed`, because Kubernetes puts it there.** Once a Job
  // reaches `activeDeadlineSeconds` its Pods are terminated and it becomes `Failed` with
  // `DeadlineExceeded` — the deadline outranks `backoffLimit`, so retries left do not matter.
  //
  // Above `completed` too, and that is the ordering worth stating: an attempt that finished cleanly
  // *after* the Job's clock ran out still ended a Job nobody may spend more wall time on. Ordering
  // it below would make the deadline mean "unless the last attempt happened to work", which is a
  // race with the scheduler rather than a ceiling.
  //
  // Not resumable, and no session is kept: what ran out is the Job's clock, not this attempt's, so
  // there is nothing a resumed session could do about it. `hkb job set --deadline` then `hkb retry`
  // is the way back, and the message says so.
  if (jobDeadline?.exceeded) {
    return {
      phase: 'failed',
      outcome: 'deadline_exceeded',
      resumable: false,
      lastError: deadlineShortfall(jobDeadline.jobId, jobDeadline.ranForMs, jobDeadline.seconds),
    };
  }
  // First, and it outranks `completed` — which is exactly the point. A check only ever runs after a
  // session that ended cleanly and produced everything it declared, so `outcome.status` here is
  // always `completed`; taking that as the answer is what having no exit code MEANS, and this is
  // the reconstruction of one. `resumable` is true and not negotiable: the session that wrote the
  // code the check refused is precisely the session worth continuing, and the checkout it wrote it
  // in is kept for it (`decision.resumable && phase === 'pending'` below).
  if (failedCheck) {
    const worthRetrying = attempt <= maxRetries;
    return {
      phase: worthRetrying ? 'pending' : 'failed',
      outcome: 'check_failed',
      resumable: true,
      // Written whether it is retrying or not, and it is one of only two outcomes that carries its
      // own line. ADR-016 §4: a failed check is a missing output, not a crash — it burns a retry
      // and spends nothing more — and there is no runtime error to fall back on, because as far as
      // the runtime is concerned this attempt succeeded.
      lastError: checkShortfall(failedCheck, worthRetrying),
    };
  }
  if (outcome?.status === 'completed') {
    return { phase: 'succeeded', outcome: 'completed', resumable: false, lastError: null };
  }
  const mapped = outcome?.status === 'max_turns' ? 'max_turns'
    : outcome?.status === 'max_budget' ? 'max_budget'
    : outcome?.status === 'timeout' ? 'timed_out'
    : outcome?.status === 'refused' ? 'refused'
    : 'crashed';
  // Two outcomes are not transient faults, and a retry that cannot change anything is only money
  // spent to arrive at the same place:
  //
  //   `refused`    — the same brief gets the same answer.
  //   `max_budget` — the same brief gets the same CAP. Resuming is right in principle: the next
  //                  attempt continues where this one stopped, so it helps whenever the work left
  //                  is smaller than the cap. Nothing checks that, and when it is false the retry
  //                  makes the identical wall at full price. Measured at the shipped defaults:
  //                  job #6 spent $2.05, was retried, spent $2.02 stopping in the same place, and
  //                  its third attempt was refused by the board's daily ceiling — $4.07 for
  //                  nothing. Raising the cap is a change to the Job's SPEC, and the spec belongs
  //                  to whoever filed it, never to this controller; so the Job fails here with the
  //                  advice above, and `hkb retry <id> --max-budget <usd>` is the deliberate raise.
  //                  It stays `resumable`, which is what keeps `lastSessionId` for that retry.
  //
  // `maxRetries: 2` means two retries AFTER the first go, so three attempts in total.
  const transient = mapped !== 'refused' && mapped !== 'max_budget';
  const worthRetrying = transient && attempt <= maxRetries;
  return {
    phase: worthRetrying ? 'pending' : 'failed',
    outcome: mapped,
    // The three stops that left a session worth continuing. A crash and a refusal did not.
    resumable: mapped === 'max_turns' || mapped === 'max_budget' || mapped === 'timed_out',
    lastError: mapped === 'max_budget' ? budgetAdvice(maxBudgetUsd) : null,
  };
}

/**
 * Reclaim Jobs whose holder died: the lease expired and nobody reported an outcome.
 *
 * Two independent things have to be true before a lease is taken — the clock says it lapsed, AND
 * the holder is not observably running. Expiry alone is not enough, because the clock a lease
 * expires on is not the clock a run times out on: see `src/liveness.ts`.
 */
async function reclaimExpired(db: ReturnType<typeof openBoard>, at: Date, report: ReconcileReport, board?: string, log?: (s: string) => void) {
  const dead = await db.lease.findMany({
    where: { expiresAt: { lt: at }, ...(board ? { job: { board: { slug: board } } } : {}) },
    select: { jobId: true, holder: true, acquiredAt: true },
  });
  for (const l of dead) {
    // The proof, where it can be had. `alive` is a local process still running: its lease lapsed
    // because the machine was asleep, not because anything failed, and taking it would start a
    // second worker on a Job that already has one.
    if (holderLiveness(l.holder, l.acquiredAt) === 'alive') {
      log?.(`#${l.jobId} lease from ${l.holder} lapsed, but that process is alive — not reclaiming`);
      continue;
    }

    // Fenced on the expiry too: between the read above and this delete, the holder may have
    // renewed. Deleting unconditionally would take a live claim — the very thing reclaim exists
    // to avoid doing.
    const taken = await db.lease.deleteMany({ where: { jobId: l.jobId, expiresAt: { lt: at } } });
    if (taken.count === 0) continue;
    const open = await db.attempt.findFirst({ where: { jobId: l.jobId, endedAt: null }, orderBy: { k: 'desc' } });
    if (open) {
      await db.attempt.update({
        where: { jobId_k: { jobId: l.jobId, k: open.k } },
        data: { endedAt: at, outcome: 'lost', reason: `lease held by ${l.holder} expired` },
      });
    }
    // Through `resolveSpec`, not off the column: `maxRetries` is nullable now, and a board that
    // says "retry these three times" has to be heard here too. Read raw, the `?? 0` below would
    // have given every inheriting Job exactly one attempt — so a Job whose holder died would be
    // given up on sooner than an identical one that merely failed.
    const job = await db.job.findUnique({
      where: { id: l.jobId },
      select: { maxRetries: true, board: { select: { defaultMaxRetries: true } } },
    });
    const maxRetries = resolveSpec(job, job?.board).maxRetries.value;
    const spent = await db.attempt.count({
      where: { jobId: l.jobId, endedAt: { not: null }, outcome: { not: 'stopped' } },
    });
    await db.job.update({
      where: { id: l.jobId },
      data: { phase: spent < maxRetries + 1 ? 'pending' : 'failed', lastError: 'lease expired' },
    });
    await db.event.create({ data: { kind: 'reclaimed', jobId: l.jobId, actor: l.holder } });
    report.reclaimed.push(l.jobId);
    log?.(`#${l.jobId} reclaimed (the lease from ${l.holder} expired)`);
  }

  // ---- and the state no lease describes: `running` with no Lease row at all.
  //
  // The claim writes the lease before the phase and the release comes after the outcome, so this
  // is never a Job in flight — it is one whose holder released the lease and then could not write
  // the Job row (a `SQLITE_BUSY` past the busy timeout in the `catch`, a process killed between
  // the two). Nothing else can act on it: the lease scan above never sees it, no pass claims a
  // Job that is not `pending`, and `hkb retry` refuses it while pointing here. So here takes it,
  // on the strength of the row alone — which is what level-triggered means.
  const stranded = await db.job.findMany({
    where: { phase: 'running', lease: { is: null }, ...(board ? { board: { slug: board } } : {}) },
    select: { id: true, maxRetries: true, board: { select: { defaultMaxRetries: true } } },
  });
  for (const j of stranded) {
    const open = await db.attempt.findFirst({ where: { jobId: j.id, endedAt: null }, orderBy: { k: 'desc' } });
    // The same proof the lease scan wants. An open attempt whose holder cannot be shown dead — a
    // process on another machine, or one still running here — is somebody's, and a Job in that
    // state is left exactly as it is; with no lease there is no deadline to fall back on, so the
    // conservative answer is to wait for a row that says more.
    if (open && holderLiveness(open.host, open.startedAt ?? at) !== 'dead') continue;
    if (open) {
      await db.attempt.update({
        where: { jobId_k: { jobId: j.id, k: open.k } },
        data: { endedAt: at, outcome: 'lost', reason: 'running with no lease — the holder is gone' },
      });
    }
    const maxRetries = resolveSpec(j, j.board).maxRetries.value;
    const spent = await db.attempt.count({ where: { jobId: j.id, endedAt: { not: null }, outcome: { not: 'stopped' } } });
    // Fenced on the phase: a claim that landed between the read above and this write is not ours to undo.
    const fixed = await db.job.updateMany({
      where: { id: j.id, phase: 'running', lease: { is: null } },
      data: { phase: spent < maxRetries + 1 ? 'pending' : 'failed', lastError: 'running with no lease — the holder is gone' },
    });
    if (fixed.count === 0) continue;
    await db.event.create({ data: { kind: 'reclaimed', jobId: j.id, actor: 'nobody' } });
    report.reclaimed.push(j.id);
    log?.(`#${j.id} reclaimed (running with no lease — the holder is gone)`);
  }
}

/**
 * The outcomes an attempt can end on that **cannot have answered a check**.
 *
 * Each ends the attempt at, before, or beside the runtime call without a verdict: `stopped` is
 * `hkb down` landing mid-run, `lost` is the reclaim closing a row whose holder died, `crashed` is a
 * run that never came back, and `timed_out` and `max_turns` are the two caps a run can hit with the
 * work — and the refusal — still outstanding. None of them writes `Attempt.check`, so an earlier
 * refusal one of these sits on top of is still unanswered, and the next attempt is still the one
 * that has to answer it. They are walked past rather than treated as answers.
 *
 * What is NOT in this set is the point of it: `completed` (the check ran and passed, or the Job has
 * none) and `no_output`, `conflicted`, `refused`, `max_budget` — all of which end the walk because
 * the attempt has a cause of its own that the next one should be reading instead.
 *
 * Membership is not the whole test, and it deliberately cannot be — see `lastRefusedCheck`, where
 * the session the refusal belongs to is checked as well. `crashed` is exactly why: a *runtime-error*
 * crash nulls `Job.lastSessionId`, so the next attempt starts cold in a
 * fresh checkout, and briefing it about a refusal in a session that no longer exists tells it to
 * continue work it cannot see.
 */
/**
 * The attempt's `reason` when a stop landed while its check was running. A marker rather than a
 * column: the run completed and its outcome says so, and the one thing the next attempt needs to
 * know is that the check never answered — read back by `checkWasInterrupted` below.
 */
const CHECK_INTERRUPTED = 'check interrupted by a stop — the run stands, the check runs again';

/**
 * Did the last attempt that could have answered the check finish with the check cut short?
 *
 * Walks back past `CHECKLESS_OUTCOMES` the way `lastRefusedCheck` does — a `stopped`, `lost` or
 * pre-run `crashed` attempt in between ran no check and says nothing about it — and only while the
 * session is still the one that finished: a nulled session starts cold and owes nothing to a
 * checkout it never saw. Looking at `k - 1` alone lost the notice across exactly those rows.
 */
async function checkWasInterrupted(db: ReturnType<typeof openBoard>, jobId: number, sessionId: string | null): Promise<boolean> {
  if (!sessionId) return false;
  const ended = await db.attempt.findMany({
    where: { jobId, endedAt: { not: null } },
    orderBy: { k: 'desc' },
    select: { outcome: true, reason: true, sessionId: true },
  });
  for (const a of ended) {
    if (a.outcome && CHECKLESS_OUTCOMES.has(a.outcome)) continue;
    return a.outcome === 'completed' && a.reason === CHECK_INTERRUPTED && a.sessionId === sessionId;
  }
  return false;
}

// `deadline_exceeded` is here because such an attempt never ran a check: the check block is gated
// on `ran.phase === 'succeeded'` and the deadline verdict lands after it. Without it the walk-backs
// stop on a deadline row and silently drop an unanswered check refusal from an earlier attempt.
const CHECKLESS_OUTCOMES: ReadonlySet<string> = new Set(['stopped', 'lost', 'crashed', 'timed_out', 'max_turns', 'max_budget', 'deadline_exceeded']);

/**
 * The most recent check refusal that nothing has answered yet, **in the session it refused**.
 *
 * Walks back from `k - 1` past attempts that could not have answered a check, and stops at the first
 * one that could: if that one ended `check_failed` its record is what the next attempt is briefed
 * with, and if it ended any other way the check was either satisfied or beside the point. The same
 * shape as `newestWorktree`, which walks back for the checkout because the numbering has exactly
 * this hole in it.
 *
 * **And the session has to still be the one.** `withCheckFailure` says "the work is still there:
 * the same session, and normally the same checkout" and it suppresses the plain `withCheck` line on
 * the strength of that — so a refusal briefed to an attempt that starts COLD is an instruction to
 * fix something the worker has no access to, in place of the one line that would have told it what
 * it has to pass. The walk was written on the premise that nothing it steps over clears the session;
 * that premise is false for a runtime-error `crashed`, which nulls `lastSessionId` and removes the
 * worktree. Rather than special-casing the outcome, the fact is checked directly: the refusal counts
 * only while the attempt that earned it is the attempt whose session the next one will resume.
 */
async function lastRefusedCheck(
  db: ReturnType<typeof openBoard>,
  jobId: number,
  k: number,
  /** `Job.lastSessionId` — the session the next attempt will resume, or null for a cold start. */
  lastSessionId: string | null,
): Promise<CheckRecord | null> {
  // One query, ordered, rather than one per step back: the walk is bounded by the retry count, but
  // a per-`k` read would be a board read per attempt for a fact three rows can settle.
  const before = await db.attempt.findMany({
    where: { jobId, k: { lt: k } },
    orderBy: { k: 'desc' },
    select: { outcome: true, check: true, sessionId: true },
  });
  for (const a of before) {
    if (a.outcome && CHECKLESS_OUTCOMES.has(a.outcome)) continue;
    if (a.outcome !== 'check_failed') return null;
    // Both present and equal. A null on either side is a cold start, and a cold worker briefed
    // about "the same session" is being told about work it cannot reach.
    return a.sessionId && a.sessionId === lastSessionId ? storedCheck(a.check) : null;
  }
  return null;
}

/**
 * Apply the proposals that have been approved, and finish the Jobs that made them.
 *
 * ADR-011 decision 5 in code: **the controller writes, and only against an approval.** A worker
 * proposed rows; a person said yes on the Event stream; this is the only place the rows appear, and
 * it runs before anything is claimed so an approved proposer is finished rather than re-run.
 *
 * Level-triggered like the rest of the pass. It reads what is desired (an approval, and a validated
 * proposal on the attempt that earned it) against what is observed (which of those rows already
 * exist), and takes the step. Safe to interrupt: every created Job carries the natural key
 * `(proposedByJobId, proposedByK, proposalIndex)` under a unique constraint, so a pass that dies
 * half way leaves the rest to the next one and a pass that runs twice creates nothing twice. The
 * duplicate is detected by the DATABASE refusing it, not by this function remembering.
 */
async function applyProposals(
  db: ReturnType<typeof openBoard>,
  now: Date,
  report: ReconcileReport,
  opts: { board?: string; only?: number; log?: (s: string) => void },
): Promise<void> {
  const waiting = await db.job.findMany({
    where: {
      phase: 'pending',
      proposes: { not: null },
      ...(opts.only ? { id: opts.only } : {}),
      ...(opts.board ? { board: { slug: opts.board } } : {}),
    },
    orderBy: { id: 'asc' },
  });

  for (const job of waiting) {
    // The approval, and who gave it. `hkb approve` refuses a Job that is not suspended, so an
    // approval here means this Job proposed something and a person read it — but the check is a
    // read of the stream rather than a flag, because a flag consumed on a transition is wrong after
    // a restart in a controller that is level-triggered.
    const approval = await db.event.findFirst({
      where: { jobId: job.id, kind: 'approved' }, orderBy: { id: 'desc' }, select: { actor: true },
    });
    if (!approval) continue;

    // The most recent attempt that actually produced a proposal. Not simply the last attempt: a
    // retried Job may have proposed on attempt 2 and crashed on attempt 3, and the thing a person
    // approved is the one they were shown.
    // Filtered here rather than in the query: a `Json?` column needs Prisma's null sentinels to be
    // filtered on, and a Job has a handful of attempts, so reading them and picking is both cheaper
    // to be right about and cheaper to read.
    const attempts = await db.attempt.findMany({
      where: { jobId: job.id }, orderBy: { k: 'desc' }, select: { k: true, proposal: true },
    });
    const attempt = attempts.find((a) => storedProposal(a.proposal) !== null);
    const proposal = attempt ? storedProposal(attempt.proposal) : null;
    // Approved, but nothing validated to apply. Left alone rather than failed: it is an ordinary
    // pending Job with a gate, and the claim loop below is entitled to run it.
    if (!attempt || !proposal) continue;

    const filed: number[] = [];
    let already = 0;
    for (const [index, want] of proposal.jobs.entries()) {
      try {
        const created = await db.job.create({
          data: {
            boardId: job.boardId,
            name: want.name,
            brief: want.brief,
            // The only spec field a proposal may set, and only downward — `src/proposals.ts` has
            // already clamped it to what the proposer itself was allowed to spend.
            ...(want.maxBudgetUsd === undefined ? {} : { maxBudgetUsd: want.maxBudgetUsd }),
            proposedByJobId: job.id,
            proposedByK: attempt.k,
            proposalIndex: index,
          },
        });
        filed.push(created.id);
        await db.event.create({
          data: {
            kind: 'created',
            jobId: created.id,
            boardId: job.boardId,
            // The approver, not the worker and not this host: the row exists because a person said
            // so, and that is the fact worth keeping.
            actor: approval.actor,
            payload: { name: want.name, proposedBy: job.id, attempt: attempt.k, index },
          },
        });
      } catch (e) {
        // The unique key doing its job — this row was filed by an earlier pass. Anything else is a
        // real failure and is not swallowed: a board that silently drops half a proposal is worse
        // than one that stops and says so.
        if ((e as { code?: string }).code !== 'P2002') throw e;
        already += 1;
      }
    }

    await db.job.update({
      where: { id: job.id },
      data: {
        phase: 'succeeded',
        suspendedFor: null,
        lastError: null,
        finishedAt: now,
        // Cleared, like every other terminal transition (`lastSessionId: final.resumable ? … : null`
        // on the ordinary path). A proposer's approval is applied HERE — no session ever wakes up in
        // its workspace — so a kept session id is one `hkb show` advertises for a Job nothing will
        // resume, and one the sweep would read as a reason to hold a whole checkout.
        lastSessionId: null,
      },
    });
    await db.event.create({
      data: {
        kind: 'applied',
        jobId: job.id,
        boardId: job.boardId,
        actor: approval.actor,
        payload: { filed, already, attempt: attempt.k },
      },
    });
    report.filed.push(...filed);
    report.succeeded.push(job.id);
    opts.log?.(`#${job.id} approved by ${approval.actor ?? 'someone'} — filed ${filed.length === 0 ? 'nothing new' : filed.map((n) => `#${n}`).join(', ')}`
      + (already ? ` (${already} already filed by an earlier pass)` : ''));
  }
}

/** One pass. Returns what it did, so a caller can loop until nothing changes. */
export async function reconcile(deps: ControllerDeps): Promise<ReconcileReport> {
  const db = openBoard();
  const now = deps.now ?? nowDefault;
  // The holder string is parsed on the way back in, so its shape is load-bearing: a bare pid
  // cannot be checked for liveness, because a pid without a host is a number with no referent.
  const host = deps.host ?? holderId(deps.runtime.name);
  // A lease is derived from the run it covers, never chosen independently. A fixed 15 minutes
  // against a 30-minute `timeoutMs` meant every long Job had its lease expire WHILE ALIVE: the
  // reclaim then marked the live attempt `lost` and re-queued the Job — a double run, at the
  // shipped defaults. The invariant is "the lease outlives the run", so it is computed from the
  // run's own hard bound plus enough grace for teardown and the record writes.
  const leaseFor = (timeoutMs: number) => deps.leaseMs ?? timeoutMs + LEASE_GRACE_MS;
  const report: ReconcileReport = { refused: null, claimed: [], succeeded: [], failed: [], retrying: [], reclaimed: [], skipped: [], stopped: [], filed: [], suspended: [] };

  if (deps.reclaim !== false) await reclaimExpired(db, now(), report, deps.board, deps.onEvent);

  // Before anything is claimed, on purpose. An approved proposing Job is `pending` again — that is
  // how `hkb approve` re-queues it — and what it needs is for its proposal to be applied, not for
  // the worker to be run a second time. Applying first takes it terminal, so the claim loop below
  // never sees it.
  await applyProposals(db, now(), report, { board: deps.board, only: deps.only, log: deps.onEvent });

  const wanted = await db.job.findMany({
    where: {
      phase: 'pending',
      ...(deps.only ? { id: deps.only } : {}),
      ...(deps.board ? { board: { slug: deps.board } } : {}),
    },
    orderBy: { id: 'asc' },
  });

  /**
   * The runs this pass started and has not yet finished.
   *
   * Held as a set of settled-when-done promises rather than a counter, because the pass needs two
   * things from it: how full the board is *because of us*, and something to await when it is full.
   * Nothing in here ever rejects — a failure is recorded in `failure` and re-thrown once, at the
   * end, so that a throw from one run cannot leave the others unawaited or unhandled.
   */
  const inFlight = new Set<Promise<void>>();
  let failure: unknown = null;
  /** Wait for the next run to end. Every iteration shrinks `inFlight`, so a caller cannot spin. */
  const settleOne = () => Promise.race([...inFlight]);

  /** One Job's own log lines. The tag is the only grouping that survives interleaving. */
  const sayFor = (jobId: number) => (line: string) => deps.onEvent?.(`#${jobId} ${line}`);

  for (const job of wanted) {
    // A shutdown stops claiming immediately. Whatever is already running is dealt with below, in
    // the pass that started it — this only refuses to open new work.
    if (deps.signal?.aborted) break;
    const say = sayFor(job.id);

    // The whole row, deliberately, where this used to name its columns.
    //
    // A hand-listed `select` has to be extended for every spec default the board gains, and when it
    // is not, the default does not fail — it silently stops existing, because `resolveSpec` reads
    // `undefined` and falls through to the built-in. That is what happened: `defaultPluginPaths`
    // shipped in ADR-012 and was never selected here, so a board-level skill grant reached no
    // worker at all, and nothing said so. A Board row is a handful of small scalars; reading it
    // whole costs nothing and cannot go stale.
    const board = await db.board.findFirst({
      where: deps.board ? { slug: deps.board } : { id: job.boardId },
    });
    // The spec this Job actually runs with, resolved once and used for everything below: the gate,
    // the cap frozen onto the Attempt, the runtime call and the retry decision. Once, because the
    // alternative is four resolutions of the same three levels that can disagree with each other —
    // and the first of them is a ceiling check, where disagreeing means admitting work the board
    // could not afford.
    const spec = resolveSpec(job, board);
    const boardId = board?.id ?? job.boardId;
    // The repository this Job runs in. On the Board because a Board is the Namespace and the
    // ceilings above are already per-repo facts; on nothing at all is an error worth naming, since
    // the alternative is running the session in whatever directory the daemon happened to start in.
    const cwd = board?.repoPath ?? deps.cwd;
    if (!cwd) {
      throw new Error(
        `board for #${job.id} has no repoPath and no cwd was given — `
        + '`hkb boards add <slug> --repo <path>` points a board at a repository',
      );
    }

    // ---- the ceilings, checked before every claim rather than once per pass: a run that just
    // finished has moved the spend, and the next Job must be judged against that, not against
    // what was true when the pass started.
    //
    // Asked in a loop, because two of the three answers can change without anything else happening:
    // a slot and a budget are both freed by one of THIS pass's own runs ending. Waiting for that is
    // the difference between a ceiling and a stall — a pass that reported "2 of 2 slots in use"
    // while both of those slots were its own would end early and blame the operator for it.
    let gate: ClaimGate;
    for (;;) {
      const [liveLeases, spend, open] = await Promise.all([
        db.lease.count({ where: { job: { boardId } } }),
        db.attempt.aggregate({
          _sum: { costUsd: true },
          where: { job: { boardId }, startedAt: { gte: windowStart(now()) } },
        }),
        // What the runs already going could still cost. An attempt with no `endedAt` has reported
        // no cost, so it is invisible to the aggregate above; charging the cap it was claimed
        // under keeps the budget a ceiling rather than a report. An orphaned attempt whose holder
        // died is counted too, which over-charges — in the safe direction, and only until the
        // reclaim at the top of the next pass closes it.
        //
        // Off the Attempt's own frozen column, which is why this is a `_sum` and not N rows to add
        // up in JavaScript: the number each live run may still spend is a fact about that run, and
        // freezing it at claim is what keeps it both non-null and unable to drift when someone
        // edits the board's default mid-flight. The argument is on `Attempt.maxBudgetUsd`.
        db.attempt.aggregate({
          _sum: { maxBudgetUsd: true },
          where: { job: { boardId }, endedAt: null },
        }),
      ]);
      const answer = gateClaim({
        pausedAt: board?.pausedAt ?? null,
        pausedBy: board?.pausedBy ?? null,
        liveLeases,
        maxConcurrent: board?.maxConcurrent ?? 1,
        spent24h: spend._sum.costUsd ?? 0,
        committedUsd: open._sum.maxBudgetUsd ?? 0,
        dailyBudgetUsd: board?.dailyBudgetUsd ?? null,
        // Resolved, not raw: this column is null for every Job that inherits its cap, and a gate
        // judging a null against the ceiling would wave through the commonest Job there is.
        jobBudgetUsd: spec.maxBudgetUsd.value,
      });
      gate = answer;
      if (answer.ok !== false) break;
      // A wall of our own making is not news. A stopped board is: no amount of waiting un-stops it.
      if (answer.limit === 'stopped' || inFlight.size === 0) break;
      await settleOne();
      if (deps.signal?.aborted) break;
    }

    if (deps.signal?.aborted) break;
    if (gate.ok === false) {
      // Loudly, and once: the whole pass stops, because every remaining Job faces the same wall.
      //
      // Not narrated through `onEvent`. That stream is what the pass *did*, and it is replayed
      // verbatim by every caller; a refusal is the pass's *outcome*, which is why it is on the
      // report. Saying it here as well takes the choice of how often to say it away from the
      // caller — and the daemon, which asks this same question every 45 seconds and deliberately
      // logs the answer only when it changes, had that dedup silently undone by this one line.
      report.refused = gate.why;
      await db.event.create({
        data: { kind: 'refused', jobId: job.id, boardId, actor: host, payload: { why: gate.why } },
      });
      break;
    }

    // Two different counts, and conflating them was a bug waiting to happen. `k` numbers the
    // attempt and must never repeat — it is half the Attempt's primary key. `charged` is how many
    // attempts spent a retry, and an attempt the operator stopped did not: `hkb down` three times
    // would otherwise exhaust a Job that never once failed.
    const done = await db.attempt.findMany({
      where: { jobId: job.id, endedAt: { not: null } },
      select: { outcome: true },
    });
    const k = done.length + 1;
    // Neither a stop NOR a success spends one. `stopped` was already excluded; `completed` was
    // harmless only while success was terminal, and the gate makes a Job survive its own successful
    // attempt — at which point a three-step chain would arrive at step three with no retries left,
    // having never once failed.
    const charged = done.filter((a) => a.outcome !== 'stopped' && a.outcome !== 'completed').length + 1;

    // ---- the deadline, BEFORE a slot or a session is spent on this Job.
    //
    // The post-run verdict alone is not enough and the gap is expensive: a Job already past its
    // deadline would be claimed, cut a checkout, run a full paid attempt and only then be told it
    // was over. The `hkb retry` the deadline's own message points at would do exactly that. A
    // ceiling that only refuses after the money is gone is not a ceiling — which is the argument
    // `gateClaim` is built on, one field over.
    if (spec.activeDeadlineSeconds.value != null) {
      const all = await db.attempt.findMany({
        where: { jobId: job.id }, select: { startedAt: true, endedAt: true },
      });
      const ran = activeMs(all, now());
      if (deadlineExceeded(ran, spec.activeDeadlineSeconds.value)) {
        const why = deadlineShortfall(job.id, ran, spec.activeDeadlineSeconds.value);
        await db.job.update({ where: { id: job.id }, data: { phase: 'failed', lastError: why, finishedAt: now() } });
        await db.event.create({
          data: { kind: 'deadline_exceeded', jobId: job.id, boardId: job.boardId, actor: host, payload: { ranForMs: ran } },
        });
        report.failed.push(job.id);
        say(`deadline  ${why}`);
        continue;
      }
    }

    // ---- acquire. `@@id(jobId)` on Lease is the compare-and-swap: a second holder loses here,
    // and losing is a normal outcome, not an error.
    const token = `${host}:${k}:${now().getTime()}`;
    // Seconds on the column, milliseconds in the arithmetic. The lease is still
    // `<attempt clock> + LEASE_GRACE_MS`, so a longer clock lengthens the lease by exactly as much
    // and the renewer covers the rest — a 60-minute Job is not reclaimed at 35.
    const leaseMs = leaseFor(spec.attemptDeadlineSeconds.value * 1000);
    // The concurrency slot: the lowest non-negative integer no other LIVE lease holds. Machine-wide,
    // because one board file serves one machine and ports do not respect board boundaries.
    //
    // It is what makes `self:slot` worth having. `id` is unique and unbounded; a run that wants a
    // port, a display number or a database name needs a small integer bounded by how many runs
    // there can be at once. Kubernetes gives every Pod its own IP and never has this problem;
    // hkb's workers share one machine.
    //
    // Racy by construction and safe by constraint: two daemons reading the same set compute the
    // same answer, `Lease.slot` is `@unique`, and the loser's create throws into the same catch a
    // lost claim already lands in. Level-triggered — the Job is picked up on the next pass.
    const heldSlots = new Set(
      (await db.lease.findMany({ where: { expiresAt: { gt: now() } }, select: { slot: true } }))
        .map((l) => l.slot).filter((n): n is number => n != null),
    );
    let slot = 0;
    while (heldSlots.has(slot)) slot += 1;
    try {
      await db.lease.create({
        data: { jobId: job.id, holder: host, token, slot, expiresAt: new Date(now().getTime() + leaseMs) },
      });
    } catch {
      report.skipped.push(job.id);
      continue;
    }

    await db.job.update({ where: { id: job.id }, data: { phase: 'running' } });
    // The cap is frozen onto the attempt here, in the same breath as the claim and from the same
    // `spec` the gate was just judged against — so what the next gate check charges this run is
    // exactly what this run was admitted for. See `Attempt.maxBudgetUsd` in the schema.
    await db.attempt.create({
      data: {
        jobId: job.id, k, host, runtime: deps.runtime.name, startedAt: now(),
        maxBudgetUsd: spec.maxBudgetUsd.value,
        // Frozen at claim time beside the cap, and for the same reason: raising the clock afterwards
        // must not rewrite what stopped an earlier attempt.
        attemptDeadlineSeconds: spec.attemptDeadlineSeconds.value,
        // Copied off the Lease so the fact survives the release — `hkb show` can say which slot a
        // past attempt held, which is what makes a port collision diagnosable after the fact.
        slot,
      },
    });
    await db.event.create({ data: { kind: 'claimed', jobId: job.id, boardId: job.boardId, actor: host, payload: { k } } });
    report.claimed.push(job.id);
    say(`claim     k=${k} ${job.name}`);

    // ---- the workspace. **Declared, not provisioned** (ADR-018).
    //
    // This used to be 130 lines: fetch the base, walk back for the previous attempt's checkout,
    // resolve and validate the ref, cut a worktree, lock it, install a `pre-push` hook, and unwind
    // all of it on any failure. Every one of those is something the runtime already does, and does
    // better — it keeps `origin/HEAD` current on a five-second budget, carries `.worktreeinclude`
    // files across, holds a `git worktree lock` for the length of the run, and returns a resumed
    // session to the workspace it left.
    //
    // So the Job kind does what a PodSpec does: it says it wants one, by name. What that name means
    // is the runtime's business, and `WorkerOutcome.workspacePath` reports back where it landed.
    // Nothing here knows whether a git worktree was involved.
    //
    // `isolate: false` asks for none, and the session runs in the repository itself — Kubernetes'
    // `hostPath`, with the properties that implies: no diff to read, nothing to revert, and no
    // safety at `maxConcurrent > 1`, where two such sessions edit the same files with no lock
    // between them.
    const workspace = job.isolate ? { name: workspaceName(job.id) } : undefined;

    // ---- and now let it go. Everything past this point is the run and the record of it, and it
    // is the only part that overlaps with another Job's.
    const done$: Promise<void> = runAndRecord({
      job, spec, k, charged, token, leaseMs, cwd, workspace, say, slot,
      boardSlug: board?.slug ?? null,
      defaultWorkflow: board?.defaultWorkflow ?? null,
    })
      .catch((e: unknown) => { failure ??= e; })
      .finally(() => { inFlight.delete(done$); });
    inFlight.add(done$);
  }

  // Nothing returns until every run this pass started has recorded its own attempt — including on
  // shutdown, where they are all aborting at once rather than one being interrupted and the rest
  // never starting.
  while (inFlight.size) await settleOne();
  if (failure) throw failure;

  // Completion order is not id order once runs overlap, and a report whose contents depend on which
  // worker finished first is a report nothing can assert on.
  for (const list of [report.claimed, report.succeeded, report.failed, report.retrying,
    report.reclaimed, report.skipped, report.stopped, report.filed, report.suspended]) list.sort((a, b) => a - b);

  return report;

  /** One claimed Job: run it, then write down what happened. Concurrent with its siblings. */
  async function runAndRecord(c: {
    job: (typeof wanted)[number];
    /** What the Job runs with once the board's defaults have filled its nulls. */
    spec: ReturnType<typeof resolveSpec>;
    k: number;
    charged: number;
    token: string;
    leaseMs: number;
    cwd: string;
    /** What was ASKED for, by name — never a path, and never something already made. */
    workspace: { name: string } | undefined;
    say: (line: string) => void;
    /** For the downward API (`self:` inputs), and for naming the board in a refusal. */
    boardSlug: string | null;
    /** The board's standing steps, resolved at claim time rather than frozen onto the Job. */
    defaultWorkflow: string | null;
    slot: number;
  }): Promise<void> {
    const { job, spec, k, charged, token, leaseMs, cwd, workspace, say, boardSlug, defaultWorkflow, slot } = c;

    // ---- renew while the run is in flight. Deriving the lifetime already makes expiry-while-alive
    // impossible; renewal is what makes a DEAD holder cheap to reclaim — without it a host that dies
    // one minute into a thirty-minute Job holds the claim for the full thirty-five.
    //
    // Fenced on the token: `updateMany ... where token` writes nothing if somebody else now holds
    // the lease, and that is how this host learns it lost one. `renewedAt` finally has a writer.
    let heldToTheEnd = true;
    // A third of the lease is the usual cadence — two renewals may fail before anything expires.
    // Floored at a second only to stop a pathologically short lease hammering the database; at the
    // real default (35 min) this is ~12 minutes, so the floor never binds in production.
    const renewEvery = Math.max(1_000, Math.floor(leaseMs / 3));
    const renewer = setInterval(() => {
      void db.lease
        .updateMany({
          where: { jobId: job.id, token },
          data: { renewedAt: now(), expiresAt: new Date(now().getTime() + leaseMs) },
        })
        .then((r) => {
          if (r.count === 0) {
            heldToTheEnd = false;
            say('lease lost — another holder has it');
          }
        })
        .catch(() => { /* a renewal that could not be written is retried by the next tick */ });
    }, renewEvery);
    if (typeof renewer.unref === 'function') renewer.unref();

    /**
     * The runtime's own report, hoisted so the `catch` at the foot can read it whether the run
     * happened or not. Null until it has, and null if it never does.
     */
    let outcome: WorkerOutcome | null = null;
    /** Set the moment the Job row carries the outcome. A failure after that rewrites nothing. */
    let recorded = false;
    /** A stop landed while the check was running: the run stands, the check has not answered. */
    let checkInterrupted = false;
    // Everything from here to the release is under one `try`. The renewer above is what makes
    // that non-negotiable: it is a timer that keeps the lease alive, and the `finally` is the only
    // thing that stops it. A `try` that began after the pre-run reads left every throw in them —
    // a SQLITE_BUSY on the approval read, a file where the results directory should be — with a
    // renewer ticking for the daemon's lifetime and a Job `running` that no verb could cancel.
    try {
      // ---- an approval this attempt is acting on, if any. Read from the Event stream rather than a
      // column cleared on use: durable, never consumed, and legible afterwards — `hkb log` shows who
      // approved what and in whose words. Only the most recent one matters; an earlier approval was
      // already acted on by the attempt that followed it.
      const approval = job.gate
        ? await db.event.findFirst({
          where: { jobId: job.id, kind: 'approved' }, orderBy: { id: 'desc' },
        })
        : null;
      const approvalPrompt = approval ? approvedPrompt(approval.actor, (approval.payload as { note?: string } | null)?.note) : null;

      // ---- what the attempt before this one failed its check on, if that is why there is another
      // one. Read off the previous attempts' rows rather than remembered across the transition, like
      // everything else here: a controller that is level-triggered cannot depend on having seen the
      // failure happen, and a flag consumed on a transition is wrong after a restart.
      //
      // **Walked back**, the way `newestWorktree` walks back for the checkout — and for the same
      // reason, because it is the same gap. `k` counts every ended attempt, so reading only `k - 1`
      // meant one `stopped` (`hkb down`), `lost` (a reclaim) or pre-run `crashed` attempt in between
      // silently dropped the briefing: none of those runs a check, none of them writes the column,
      // and none of them clears `lastSessionId` — so the next attempt resumed the very session the
      // check refused, with no word of the refusal. It wakes up believing it finished and produces
      // the same tree, which is the failure mode this briefing exists to prevent.
      //
      // The walk stops at the first attempt that had something to say: anything OTHER than those
      // three either answered the check (a `completed` attempt in between did) or failed for a
      // reason of its own, and quoting an older failure past it would brief this run against a tree
      // that no longer exists.
      //
      // Null once the Job no longer HAS a check: an operator who cleared it is not asking anybody to
      // satisfy it, and briefing a worker about a command that will not run again is noise it would
      // have to act on.
      /**
       * Whether this Job has a completion check at all — asked once, and `job.proposes` is half of it.
       *
       * A PROPOSING Job changes nothing in the tree. Its output is `proposal.json`, read by the
       * controller and applied only after a person approves it (ADR-011), so there is no behaviour for
       * a command to judge and nothing in the checkout for it to judge. Running one anyway did
       * measurable harm rather than none: a check over an unchanged tree fails, and `nextPhase` puts
       * `check_failed` AHEAD of the gate — so the Job never suspended for approval, went round the
       * retry loop instead, and stored the same proposal three times for three paid sessions and zero
       * Jobs filed. `hkb new --propose --check` is refused by name (`src/hkb.ts`); this is the same
       * rule for a check the BOARD supplied, which nobody typed on that Job at all.
       */
      const runsCheck = !!spec.check.value && !job.proposes;
      // A previous attempt that finished and whose check a stop cut short: the resumed session is
      // told so, and told that its declared results are per attempt — the ones it wrote last time
      // were read and are on that attempt; this attempt owes its own.
      const interruptedBefore = k > 1 && runsCheck ? await checkWasInterrupted(db, job.id, job.lastSessionId) : false;
      const priorCheck = k > 1 && runsCheck
        ? await lastRefusedCheck(db, job.id, k, job.lastSessionId)
        : null;

      // ---- the results this attempt is asked for, and the directory it writes them to. Created
      // before the run because the paths go into the prompt; outside every checkout, so writing one
      // cannot land in the worker's diff (`src/results.ts`).
      const wantedNames = declaredResults(job.results);
      const wantedResults = wantedNames.length ? resultPaths(job.id, k, wantedNames) : {};
      // Always made, even when nothing is declared: a run may volunteer a value nobody asked for, and
      // it needs somewhere to put it. The brief only names paths for the DECLARED ones — a volunteered
      // value is the worker's own idea, and telling it where the directory is would make it an
      // invitation, which is a different feature.
      ensureResultsDir(job.id, k);

      // ---- the artifacts this attempt is asked for. Same two rules as results — declared names get
      // a path in the prompt, and the directory is made either way so a run may volunteer — and one
      // difference that is the point of the channel: nothing here is capped, and nothing here is
      // removed (ADR-011, `src/artifacts.ts`).
      //
      // A PROPOSING Job rides the same channel under a name the controller fixes rather than the Job
      // (`proposal.json`), and it is deliberately NOT added to the declared list: `withProposal` names
      // that path itself with the schema beside it, and the validator's own refusal covers the missing
      // file, so declaring it too would mean two code paths saying the same no.
      const wantedArtifactNames = declaredArtifacts(job.artifacts);
      const wantedArtifacts = wantedArtifactNames.length ? artifactPaths(job.id, k, wantedArtifactNames) : {};
      const proposalPath = job.proposes ? artifactPaths(job.id, k, [PROPOSAL_ARTIFACT])[PROPOSAL_ARTIFACT] : null;
      ensureArtifactsDir(job.id, k);

      // ---- the plugin grants: the directories whose skills this worker may see. A directory that
      // has gone is dropped rather than fatal — a board outlives the directories it names, and a Job
      // that cannot run because a skill directory was deleted is a worse failure than one that runs
      // without it. Said out loud, because a worker silently missing what it was granted is the same
      // class of bug as a silently inert guard.
      const granted = resolvePlugins(cwd, spec.pluginPaths.value);
      const grantedPlugins = granted.paths.length ? granted.paths : undefined;
      if (granted.dropped.length) say(`granted plugin path${granted.dropped.length === 1 ? '' : 's'} not found: ${granted.dropped.join(', ')}`);
      // ---- the declared INPUTS, resolved before anything is spent. ADR-008 said what a Job produces
      // and left what it consumes as one static string; this is the other half
      // (`src/inputs.ts`, `docs/workflow-study.md` §7).
      //
      // Against `cwd` — the board's repository — and never the worktree, for the same reason a plugin
      // grant is: the worktree carries this Job's own edits on a resumed attempt, and a Job that fed
      // itself its own output would be reading a different document each time it woke up.
      const wantedInputs = declaredInputs(job.inputs);
      const readInputs: ResolvedInput[] = [];
      const unread: { name: string; source: string; why: string }[] = [];
      for (const want of wantedInputs) {
        const source = describeSource(want);
        // A literal, supplied at file time. Nothing to fetch and nothing that can fail. One that was
        // interpolated into the brief is not here at all — `hkb new` drops it once consumed.
        if ('value' in want) { readInputs.push({ name: want.name, source, text: want.value }); continue; }
        const vf = want.valueFrom;

        // The downward API. `fieldRef` lets a Pod read its own metadata; this lets a Job read its own,
        // and `slot` is the field that earns it: the only fact answering "which of the concurrent
        // workers am I", which is what a run picking a port or a database name needs.
        if ('jobRef' in vf) {
          const self: Record<string, string | null> = {
            id: String(job.id),
            name: job.name,
            board: boardSlug,
            attempt: String(k),
            slot: String(slot),
            repo: cwd,
          };
          const got = self[vf.jobRef.field];
          // Refused BY NAME rather than rendered as an empty string, which is the one thing every
          // other declaration in hkb refuses to do.
          if (got == null) {
            unread.push({ name: want.name, source, why: `this Job has no \`${vf.jobRef.field}\`` });
          } else {
            readInputs.push({ name: want.name, source, text: got });
          }
          continue;
        }

        if ('board' in vf) {
          // One board read, no model, and the projection `hkb ls` already computes — ADR-010 decision
          // 5's "board arithmetic". Every OTHER Job on this board, so a Job reasoning about the board
          // is not confused by finding itself listed as `running`.
          const others = await db.job.findMany({
            where: { boardId: job.boardId, id: { not: job.id } },
            orderBy: { id: 'asc' },
            select: {
              id: true, name: true, phase: true, exports: true, results: true, artifacts: true,
              _count: { select: { attempts: true } },
              attempts: { select: { outcome: true }, orderBy: { k: 'desc' } },
              proposes: true,
            },
          });
          const rows: BoardRow[] = others.map((o) => ({
            id: o.id,
            name: o.name,
            phase: o.phase,
            attempts: o._count.attempts,
            lastOutcome: o.attempts[0]?.outcome ?? null,
            // The SAME predicate the CLI prints, imported rather than restated. It was restated
            // here, and the two copies had drifted twice over: this one had no `proposes` term, so
            // a succeeded proposer was rendered to a worker as "produced nothing" while `hkb ls`
            // disagreed, and it read only the newest attempt. A second consumer re-deriving this is
            // the failure `src/read.ts` exists to end — including when the second consumer is us.
            producedNothing: producedNothing({
              phase: o.phase,
              exports: declaredExports(o.exports),
              results: declaredExports(o.results),
              artifacts: declaredExports(o.artifacts),
              proposes: o.proposes,
            }),
          }));
          readInputs.push({ name: want.name, source, text: renderBoard(rows) });
          continue;
        }

        const got = readFileInput(cwd, vf.file.path);
        if ('why' in got) unread.push({ name: want.name, source, why: got.why });
        else readInputs.push({ name: want.name, source, text: got.text });
      }
      // ---- the contributor guide, if the operator granted one (ADR-013). Read from the board's
      // repository like an input and for the same reasons — the worktree carries this Job's own edits,
      // and a worker that could write the guide its next attempt obeys would be steering itself.
      //
      // A guide that cannot be read fails the attempt in the same breath as an input that cannot,
      // because the failure is the same shape: a Job told to follow rules it was never given runs
      // without them, and that is worse than not running.
      let guide: { text: string; files: string[] } | null = null;
      let guideShortfall: string | null = null;
      if (spec.guide.value) {
        const got = readGuide(cwd, spec.guide.value);
        if ('why' in got) guideShortfall = missingGuide(job.id, got.why);
        else {
          guide = got;
          say(`guided by ${got.files.join(' + ')} (${Buffer.byteLength(got.text)} bytes)`);
        }
      }

      // ---- the board's default workflow, as STANDING STEPS, resolved here rather than at file time.
      //
      // It used to be expanded into `Job.brief` by `hkb new`, and that was wrong in three ways at
      // once, all of which this placement answers. `hkb queue <id> "…"` and `hkb job set --brief`
      // replace the brief wholesale, so the triage → queue flow — the board's own inbox — silently
      // dropped the steps every time. They reached `--no-isolate` Jobs, which get no sandbox and no
      // branch, and told them to push one. And they landed BEFORE the contract, so a worker read
      // "push, open the PR, reply with the URL" and then "1. commit, 2. rebase, 3. reply with the
      // branch" — two reply contracts, in the wrong order.
      //
      // Composed the way the guide and the check line are composed: read from the board as it is
      // NOW, appended after everything the core has to say, and never stored. That is also what
      // makes it a *board* default rather than a fact frozen onto old rows — editing the workflow
      // changes the next attempt, including the next attempt of a Job filed last week.
      //
      // Not to a PROPOSING Job, and for the reason `withWorktree` exists: its whole output is one
      // JSON file, so steps ending in "open a pull request" are not an instruction it can follow.
      let steps: { name: string; brief: string } | null = null;
      let stepsShortfall: string | null = null;
      const wantSteps = defaultWorkflow?.trim();
      if (wantSteps && workspace && !job.proposes) {
        try {
          const t = readTemplate(cwd, wantSteps);
          steps = { name: t.name, brief: t.brief };
        } catch (e) {
          // Named rather than skipped. The operator pointed the board at a workflow, and running
          // without it would be every Job on the board quietly finishing half-way — which is the
          // failure this whole card exists because of.
          stepsShortfall = `#${job.id} did not run: this board files every Job with the workflow `
            + `\`${wantSteps}\`, and ${(e as Error).message} Add the file, or point the board somewhere `
            + `else: \`hkb boards set ${boardSlug ?? '<slug>'} --workflow <name>|none\`.`;
        }
      }

      // One shortfall, and the first cause found is the one reported — the same precedence rule the
      // declared outputs use, for the same reason: two concatenated reasons read worse than one and
      // send the operator to the same place.
      const inputShortfall = missingInputs(job.id, unread) ?? guideShortfall ?? stepsShortfall;
      if (inputShortfall) deps.onEvent?.(`  ${inputShortfall}`);

      // ---- run. A resumable stop leaves a session id; the next attempt continues it rather than
      // starting cold, which is the whole reason that column exists.
      //
      // **The brief goes as filed.** What used to sit here was the sandbox contract — commit on your
      // branch, rebase onto your base, push that branch and nothing else — wrapped around it, plus a
      // `BaseAdvice` computed from the checkout the controller had just cut. All of it is gone with
      // the protocol it described (ADR-018): the core does not require a commit, a push or a rebase,
      // so it has nothing to say about them, and it no longer has a branch to name.
      //
      // A workflow that wants those steps says so in its own content, which is appended below and is
      // exactly where ADR-017 decision 5 put the pull request. A step standing in a workspace can ask
      // git what branch it is on; the core neither answers nor asks.
      const contract = approvalPrompt ?? job.brief;
      // AFTER the contract, which is the ordering the old placement got backwards: the core says how
      // work is done here, and the board's steps say what doing it ends in. Skipped for an approval
      // prompt, which is one human's instruction about one suspended attempt and not a fresh run of
      // the standing shape.
      const opening = steps && !approvalPrompt ? withStandingSteps(contract, steps.name, steps.brief) : contract;
      // What the last attempt's check refused, on top of whatever this attempt was going to be told.
      // ADR-016 §3 makes the check part of the completion condition, so a resumed attempt that is not
      // told about it is one that wakes up believing it finished — the retry-that-does-not-know-why
      // this project has already measured (`docs/rebuild-plan.md`). Composed rather than substituted,
      // unlike `approvedPrompt`: the work has not changed, only what is now known about it.
      //
      // The command it names is `spec.check.value` — what will judge THIS attempt — and not the one
      // on the record, which is what judged the last one. `hkb job set --check 'npm run lint'` then
      // `hkb retry` briefed the worker to make `npm test` exit 0 while `npm run lint` decided; when
      // the two differ `withCheckFailure` says so rather than silently substituting, because the tail
      // below it is still the old command's output and a worker reading them as one thing would be
      // debugging the wrong failure.
      const briefed = priorCheck
        ? withCheckFailure(opening, priorCheck, spec.check.value as string)
        : opening;
      // The guide goes in FRONT of all of it, including an approval prompt: an approver's instruction
      // is the most recent word on what to do, and the repository's rules are the standing word on how
      // anything here is done. Neither replaces the other.
      // The three rules every worker gets (ADR-014), between the task and the output contracts. Not
      // conditional on anything: a rule that reaches only some Jobs is one nothing can rely on, and
      // that includes a resumed attempt carrying an approver's instruction.
      const ruled = withStandingRules(briefed);
      const guided = guide ? withGuide(ruled, guide.text, spec.guide.value as string) : ruled;
      // The completion condition the worker is going to be judged against, told to it BEFORE it is
      // judged. `spec.check.value` used to reach a prompt only through `withCheckFailure` — that is,
      // only after an attempt had already failed on it — so the ordinary shape of a checked Job was:
      // the worker runs `npm test`, pushes, ends green, the check fails on the lint half, and a whole
      // paid session goes on a one-line fix it would have made for free. It sits with the declared
      // outputs because it IS one, in ADR-016 §3's sense.
      //
      // Not a hole in the fence. The fence is about who AUTHORS the command — the row, never the
      // worktree (`src/check.ts`) — and telling a worker the string changes nothing about that: the
      // retry prompt has always disclosed it verbatim, and a worker cannot edit the row it comes from.
      // Skipped when `withCheckFailure` already carries it, which says the same thing at more length.
      const contracted = withArtifacts(withResults(guided, wantedResults), wantedArtifacts);
      // And not to a PROPOSING Job, which none of this applies to: no check runs for one (see the
      // check block below), so a line telling it that a command must exit 0 in its checkout would be
      // asking for work it is not going to do and nothing is going to judge.
      const told = runsCheck && !priorCheck
        ? withCheck(contracted, spec.check.value as string, interruptedBefore)
        : contracted;
      const asked = withInputs(told, readInputs);
      const prompt = proposalPath && !approvalPrompt
        ? withProposal(asked, proposalPath, spec.maxBudgetUsd.value ?? null)
        : asked;

      outcome = inputShortfall ? null : await deps.runtime
        .run({
          taskId: job.id,
          attempt: k,
          // The REPOSITORY, always. Where the session actually stands is the runtime's answer, not
          // ours: it provisions the workspace below and reports the path back on the outcome. Passing
          // a path we had computed was only possible while the controller cut the checkout itself.
          cwd,
          // What we are asking for, by name (ADR-018). Undefined means "run in `cwd` itself" — the
          // `hostPath` case, which `--no-isolate` selects.
          workspace,
          // Still derived from what was asked for rather than from `job.isolate`, so it cannot
          // disagree with the line above. The runtime turns it into the subagent isolation policy: a
          // Job running in the operator's tree has no workspace to bring a subagent's work back to.
          isolated: workspace !== undefined,
          // What this attempt is asked to do. Normally the brief; after an approval, the approver's
          // own instruction — which is the whole of ADR-010 decision 4. A resumed attempt otherwise
          // re-sends the same brief, so an approved Job would propose again instead of applying.
          //
          // A PROPOSING Job gets the proposal contract on top, last, so it is the final thing the
          // worker reads — and never over an approval prompt: an approved proposal is applied by the
          // controller, so a worker asked to propose again would be proposing on top of rows that
          // already exist.
          prompt,
          // All four from the resolved spec: a Job that named none of them still has to run on
          // something, and the board is now allowed to be the one that says what.
          model: spec.model.value ?? undefined,
          effort: spec.effort.value ?? undefined,
          maxTurns: spec.maxTurns.value,
          maxBudgetUsd: spec.maxBudgetUsd.value,
          // The tool surface, resolved like everything else. Undefined — not null — when nobody
          // named one, because `WorkerSpec.allowedTools` is optional and the runtime's own default
          // is what an absent value means. The admission gate is built from this same list
          // (`src/runtime/claude.ts`), so narrowing it here is what actually refuses.
          allowedTools: spec.allowedTools.value ?? undefined,
          // Resolved against the BOARD'S REPOSITORY (`cwd` above), never the workspace — ADR-012,
          // `src/plugins.ts`. A worker writes in its workspace, so a grant that resolved there would
          // let a Job write a hook its own next attempt executes. Against the repository, a merge is
          // the only way to change what a grant loads.
          plugins: grantedPlugins,
          timeoutMs: spec.attemptDeadlineSeconds.value * 1000,
          resume: job.lastSessionId ?? undefined,
          signal: deps.signal,
        }, deps.onRuntimeEvent)
        .catch((): null => null);

      /**
       * Where the session actually stood — **reported by the runtime, never computed here.**
       *
       * A Job that asked for a workspace ran in whatever the runtime made; one that did not ran in
       * the repository. The declared outputs are collected from this and the completion check runs
       * in it, so it has to be the truth rather than a convention this side reconstructed: the
       * controller no longer creates the directory and so has no standing to name it.
       *
       * Falls back to `cwd` when the run never happened (a missing input) or asked for nothing.
       */
      const ranIn = outcome?.workspacePath ?? cwd;
      /**
       * **Did the isolation we asked for actually happen?**
       *
       * `WorkerSpec.workspace` reaches the harness through `Options.extraArgs`, which is an untyped
       * escape hatch: rename `--worktree` upstream, or put an older CLI on the PATH, and the flag is
       * dropped in silence. The session then runs in the operator's own repository while everything
       * here still believes it is isolated — `isolated: true` was already passed to the runtime, so
       * even the subagent policy is wrong.
       *
       * What that costs is not abstract. A Job declaring `--export docs/report.md` on a repository
       * that already has that file would find it, report no shortfall, and record an export the run
       * never produced; and the completion check would run its command inside the operator's
       * checkout. Both are silent.
       *
       * So it is verified rather than assumed, which is the rule this codebase already learned three
       * times: *the admission gate, the worktree base and the lease were each silently inert and each
       * passed every test it had.*
       *
       * **Only on a session that COMPLETED**, and that narrowing is not a softening — it is where the
       * harm is. A crashed run, a capped one and a timeout legitimately report no workspace: they
       * never got far enough to have one, and each already carries a cause of its own that outranks
       * this. They also collect nothing, because every collection block below is gated on the run
       * having succeeded. Asking the question of them would fail real outcomes — a `max_budget` stop
       * would be recorded as an isolation fault and lose the session it was keeping for the retry.
       */
      const isolationShortfall = workspace && outcome?.status === 'completed' && (
        !outcome.workspacePath || fsRealpath(outcome.workspacePath) === fsRealpath(cwd)
      )
        ? `#${job.id} asked for the workspace \`${workspace.name}\` and the runtime did not provide one`
          + `${outcome.workspacePath ? ` — it ran in ${outcome.workspacePath}, which IS the repository` : ''}. `
          + 'The session ran unisolated in the board\'s repository, so nothing it wrote is separable '
          + 'from the operator\'s own tree and no declared output can be trusted. hkb asks for a '
          + 'workspace through the runtime\'s own passthrough (`extraArgs`), which fails silently when '
          + 'the flag it names is gone — check the runtime and its version. `hkb retry ' + `${job.id}\` `
          + 'once it provides one.'
        : null;

      // ---- EVERYTHING FROM HERE IS UNDER `finally`, and the reason is the renewer above it.
      //
      // The `clearInterval` and the fenced release used to be the last two statements of a section
      // about three hundred lines long, reached only on the way through — so any throw between the
      // runtime call and them (a `SQLITE_BUSY` on the fence read, an fs error in `collectResults`, a
      // `runCheck` that rejected before it was made not to) left the renewer ticking for the rest of
      // the daemon's life, pushing a Lease row forward every leaseMs/3 for a run that had ended. The
      // Job stayed `running`, `reclaimExpired` never saw an expired lease to take, `whileUnleased`
      // refused `hkb cancel` and `hkb rm` because a Lease row existed, and nothing on the machine
      // could end it short of deleting the row by hand. Measured: a three-second lease still
      // advancing minutes after the pass had thrown.
      //
      // A lease is a claim with a deadline, and a claim whose holder has stopped must lapse. That is
      // a property of the release, not of the happy path reaching it — so the release IS the finally,
      // and the catch closes the attempt with what went wrong rather than leaving a row open.
      // ---- still ours? A cheap fenced READ, before anything CONTENDED is touched.
      //
      // The lease used to be deleted at this point; it is now held to the end and released after the
      // outcome is recorded — see the release for why. This read is the early half of that: the
      // renewer only notices a lost lease on its own timer (a third of the lease), and the blocks
      // below write to the repository, the remote and the checkout. One `findUnique` buys them the
      // answer now rather than up to twelve minutes from now.
      const held = await db.lease.findUnique({ where: { jobId: job.id }, select: { token: true } });
      if (held?.token !== token) heldToTheEnd = false;

      // The operator's intent outranks whatever the runtime made of being cut off. A stopped run
      // reports `timeout` or `error` depending on where the abort landed, and recording either would
      // be a lie about why it ended AND would spend a retry on it.
      // ---- the Job's own deadline, over the time its sessions have actually RUN.
      //
      // The query is behind the null check on purpose: at the shipped default there is no Job-wide
      // deadline, and a per-Job read whose result is thrown away is what CLAUDE.md's third value
      // forbids. Sum, not "since the first attempt started" — see `deadlineExceeded`.
      const deadlineSeconds = spec.activeDeadlineSeconds.value;
      const jobDeadline = deadlineSeconds == null ? null : await (async () => {
        const all = await db.attempt.findMany({
          where: { jobId: job.id }, select: { startedAt: true, endedAt: true },
        });
        const ran = activeMs(all, now());
        return { jobId: job.id, exceeded: deadlineExceeded(ran, deadlineSeconds), ranForMs: ran, seconds: deadlineSeconds };
      })();

      // `let`, because one thing may still change it after the fact: a stop that lands while the
      // completion check is in flight. See the check block below.
      let ran: Decision = isolationShortfall
        // Terminal and not retried: the same runtime gives the same answer next time, and a retry
        // would run unisolated again. It is `no_input` in the sense `no_input` already carries — the
        // fault is in the machinery around the run, not in the work — and a human has to look.
        ? { phase: 'failed', outcome: 'no_input', resumable: false, lastError: isolationShortfall }
        : inputShortfall
        // Terminal, and not retried, for the reason a missing declared OUTPUT is not: the same read
        // fails identically next time. `hkb retry` is the deliberate second go, once a human has read
        // which input is missing and decided whose mistake it was.
        ? { phase: 'failed', outcome: 'no_input', resumable: false, lastError: inputShortfall }
        : deps.signal?.aborted
        ? { phase: 'pending', outcome: 'stopped', resumable: true, lastError: null }
        // Both from the resolved spec, so the budget advice names the cap this attempt actually ran
        // under — which may be the board's. Quoting the raw column would print `$0.00` and send the
        // operator to raise a limit that was never the one they hit.
        // NOT given the deadline here. A Job past it is over — but the attempt that just finished
        // was paid for, and everything it DECLARED is collected before the verdict lands, because
        // the collection below is gated on `ran.phase === 'succeeded'` and `clearResults` deletes
        // the directory either way. The deadline is applied after, where it still outranks the
        // check and `completed` in what gets RECORDED.
        : nextPhase(outcome, charged, spec.maxRetries.value, spec.maxBudgetUsd.value);

      // ---- the declared outputs, out of the sandbox BEFORE it is torn down. The order is the whole
      // design: a worktree is the pod filesystem and dies with the run, so an artifact still inside it
      // when the checkout goes was never produced. ADR-008, and Bazel's rule verbatim — move the known
      // outputs to the execroot, then delete the sandbox.
      //
      // Only after a run that otherwise succeeded. A crashed or capped attempt has not finished the
      // work, so half its outputs being absent is a description of the stop it already reported, not a
      // second finding; and copying what it did leave would overwrite the repository from a run
      // nobody is going to accept.
      const declared = declaredExports(job.exports);
      let exported: string[] | null = null;
      let shortfall: string | null = null;
      // `heldToTheEnd` gates it for the same reason it gates the Job row: the repository is contended
      // state too, and a holder that lost its lease mid-run must not write into a checkout the new
      // holder is working in. Its worktree is kept below, so the artifact is not destroyed either.
      //
      // **Two halves, and the split is the point.** Asking whether the declared paths are there is a
      // question about the run and it is asked HERE, where its answer still outranks everything after
      // it — a missing declared output is the cheaper cause and it must keep winning over a check
      // that would take ten minutes to report a second one. COPYING them into `Board.repoPath` is a
      // write into the operator's repository, and that waits until the attempt is known to have
      // passed: it ran ~150 lines above the check, so an attempt the check went on to REFUSE had
      // already put its files in the operator's tree, which is exactly what this block's own rule
      // forbids. The copy is below the check.
      let exportPlan: string[] | null = null;
      if (declared.length && ran.phase === 'succeeded' && heldToTheEnd) {
        // `[]` from here, and the copy below replaces it with what actually landed. A Job that
        // declared outputs and handed none over records the empty list rather than null — "produces
        // no file" and "produced none of the files it promised" are different facts, and that stays
        // true of an attempt the check refused as much as of one that never wrote them.
        exported = [];
        try {
          const got = exportOutputs(ranIn, cwd, declared, { copy: false });
          exportPlan = got.exported;
          if (got.missing.length) shortfall = missingOutputs(job.id, got.missing);
        } catch (e) {
          // An illegal declaration — escaping, absolute, or a symlink out of the checkout. It is a
          // fault in the Job's spec rather than in the run, and it stops the copy dead: nothing is
          // written outside the repository on the strength of a path we refused.
          shortfall = (e as Error).message;
        }
        if (shortfall) deps.onEvent?.(`  ${shortfall}`);
      }
      // ---- the declared RESULTS, read back before the collection directory goes. Same rule, same
      // gate, different medium: `exports` are files the repository keeps, results are values the
      // board keeps. A Job with no branch and no commit produces its work here or nowhere.
      let produced: Record<string, string> | null = null;
      if (ran.phase === 'succeeded' && heldToTheEnd) {
        const got = collectResults(job.id, k, wantedNames);
        // Null, not `{}`: a run that wrote nothing has no fact to record, and the column already
        // distinguishes those two the way `exported` does.
        produced = Object.keys(got.produced).length ? got.produced : null;
        const owed = missingResults(job.id, got.missing, got.oversize);
        // The export shortfall keeps precedence — it was found first, and reporting one cause is
        // more use than concatenating two.
        if (owed && !shortfall) shortfall = owed;
        if (owed) deps.onEvent?.(`  ${owed}`);
        else if (Object.keys(got.produced).length) {
          // Volunteered names are named as such: an operator reading the log should be able to tell
          // what the board required from what the run decided to add.
          const extra = got.volunteered.length ? ` (${got.volunteered.length} volunteered)` : '';
          deps.onEvent?.(`  produced ${Object.keys(got.produced).map((n) => `\`${n}\``).join(', ')}${extra}`);
        }
      }
      // Removed whatever happened: the values are durable because they are on the Attempt row, not
      // because the file survives, and a directory kept after a failure is litter nobody reads.
      clearResults(job.id, k);

      // ---- the declared ARTIFACTS. Same rule and same gate again; the differences are that nothing
      // is read (a catalogue goes onto the row, the file stays where the worker put it) and that the
      // directory SURVIVES — for a failed attempt too, because a partial output is usually the most
      // informative thing a failure leaves, and it is the only copy (ADR-011, `src/artifacts.ts`).
      let artifacts: { name: string; kind: string; bytes: number }[] | null = null;
      if (ran.phase === 'succeeded' && heldToTheEnd) {
        const got = collectArtifacts(job.id, k, wantedArtifactNames);
        artifacts = got.produced.length ? got.produced : null;
        const owed = missingArtifacts(job.id, got.missing);
        // Same precedence rule as results: the first cause found is the one reported, because two
        // concatenated shortfalls read worse than one and mean the same thing.
        if (owed && !shortfall) shortfall = owed;
        if (owed) deps.onEvent?.(`  ${owed}`);
        else if (got.produced.length) {
          const extra = got.volunteered.length ? ` (${got.volunteered.length} volunteered)` : '';
          deps.onEvent?.(`  kept ${got.produced.map((a) => `\`${a.name}\` ${bytes(a.bytes)}`).join(', ')}${extra}`);
        }
      }
      // Only when it is empty, which is the common case: every attempt gets a directory because the
      // path goes into the prompt, and a Job that declared nothing and volunteered nothing must not
      // leave one behind per attempt for ever.
      clearEmptyArtifacts(job.id, k);

      // ---- the PROPOSAL, if this Job makes one. Read and refused here, applied nowhere near here:
      // what the controller does now is decide whether the file is something a person could approve,
      // and store it if it is (ADR-011, `src/proposals.ts`).
      //
      // A refusal fails the attempt the same way a missing declared output does, and for the same
      // reason — the Job promised something and what arrived was not it. The message is the parser's
      // own, naming the offending path, because the next reader is either a human deciding whose
      // mistake it was or a retried run that can act on it.
      let proposal: Proposal | null = null;
      if (job.proposes && ran.phase === 'succeeded' && heldToTheEnd && !shortfall) {
        const checked = readProposal(job.id, k, spec.maxBudgetUsd.value ?? null);
        if ('why' in checked) {
          shortfall = `#${job.id} proposed something the board refused: ${checked.why}`;
          deps.onEvent?.(`  ${shortfall}`);
        } else {
          proposal = checked;
          say(`proposes ${checked.jobs.length} Job${checked.jobs.length === 1 ? '' : 's'}`);
          // Said out loud rather than recorded quietly: a number that was quietly reduced is a number
          // the approver would otherwise read as the one that was asked for.
          for (const c2 of checked.clamped) say(`  ${c2}`);
        }
      }

      // ---- what used to be here: a forge read and a rebase.
      //
      // The forge read joined the board to GitHub by head branch, so an attempt could record the
      // pull request it opened. The rebase replayed that branch onto its base as it stood, and
      // force-pushed when the worker had already pushed, so the check below would test what would
      // actually merge. Both are deleted (ADR-018), and neither moved anywhere in the core.
      //
      // They are **Steps**, in Tekton's sense: work a controller does *because it owns the concept
      // of a branch*, which this one no longer does. Kubernetes has no post-run hook on a volume —
      // a Pod ends and the volume is unpublished — and every line that used to sit here was hkb
      // being a Job controller and a workflow engine in the same function.
      //
      // What their absence costs, stated plainly rather than discovered later:
      //
      //   - `Attempt.prUrl`/`prNumber` are gone with them, so `producedNothing` answers from
      //     declared outputs alone. That is the honest question anyway — ADR-008's — and a Job whose
      //     deliverable is a pull request is a Job whose workflow should declare one.
      //   - Nothing replays a branch onto a moved base, so the check below judges the tree **as the
      //     session left it**. It no longer claims to test what would merge, and it no longer says
      //     it does.
      //   - The `conflicted` outcome has no writer. The enum value stays for rows that already
      //     carry it.

      // ---- the completion CHECK: the exit code hkb does not have (ADR-016 §3, `src/check.ts`).
      //
      // Nothing runs at the shipped defaults — `BUILT_IN.check` is null, so this whole block is a
      // null test on a board nobody has configured, which is the property the tests hold.
      //
      // **After the rebase, and after its push.** Two reasons, and both of them are about agreement:
      // it must test what would actually MERGE rather than what the branch was cut from, and the tree
      // it runs in has to agree with what is on the remote — `src/rebase.ts` explains why a tree ahead
      // of its branch strands the next attempt, and a check that ran before the replay would be
      // reporting on a tree the resumed attempt never sees. It runs in the worktree, or in the
      // repository itself for a `--no-isolate` Job, which is the same "where the work happened" either
      // way.
      //
      // Gated exactly like the rebase above it: only a run that otherwise succeeded, only while we
      // still hold the lease (this executes a command in a checkout, and a checkout a new holder is
      // working in is not ours to touch), and only when nothing has already failed the attempt —
      // running a suite over a tree that is missing a declared output would spend ten minutes to
      // report a second cause for a failure that already has one.
      //
      // **The lease is HELD while this runs**, and it is `heldToTheEnd` that says so honestly now: the
      // renewer is still ticking, the Lease row is still ours, and the release is at the far end of
      // this function after the outcome is on the row. A ten-minute command with the claim already
      // dropped is a ten-minute hole in which the Job is `running` with no lease — see the release.
      //
      // And it is awaited rather than blocking: `runCheck` is an async `spawn` that kills its process
      // GROUP on the timeout and honours `deps.signal`, so `hkb down` interrupts it, sibling workers
      // keep running, and a suite that outlives its shell does not outlive the check.
      //
      // Not for a PROPOSING Job — see `runsCheck`, which is where that is argued.
      let failedCheck: CheckRecord | null = null;
      /**
       * Whether the RUN produced everything it promised, decided before the check could change `ran`.
       *
       * The blocks below need "did the work succeed" and not "is `ran` still `succeeded`", because a
       * stop landing mid-check moves `ran` back to `pending` and that is a fact about the *stop*, not
       * about the run. Without it, an attempt whose declared exports were all present recorded
       * `exported: []` — the probe said they were there and the copy was skipped by a phase the stop
       * had already changed.
       */
      const runSucceeded = ran.phase === 'succeeded';
      if (runsCheck && ran.phase === 'succeeded' && heldToTheEnd && !shortfall) {
        // **On the tree as the session left it**, and it no longer claims otherwise. The check used
        // to run after a rebase and its whole justification was that it therefore tested what would
        // merge; with the rebase gone (ADR-018) that claim would be false, so it is not made. What
        // the check still is, exactly, is ADR-016 §3's reconstruction of an exit code: a command the
        // ROW named, run where the work happened.
        say(`  check ${spec.check.value}`);
        const r = await runCheck(ranIn, spec.check.value as string, { signal: deps.signal });
        // A stop that landed mid-check is the operator's intent, and it outranks a verdict the
        // command never got to give: `runCheck` killed it, so what came back describes our own
        // interruption. Recording `check_failed` for it would burn a retry on `hkb down`.
        //
        // **And it relabels nothing about the RUN.** This used to write `stopped` over `ran`, which
        // is a claim about a session that had already finished, produced everything it declared and
        // had its results read back and their collection directory deleted — so the resumed attempt
        // could not re-produce them, ended `no_output`, and went terminal. The Job was destroyed by
        // pressing Ctrl-C during its test suite.
        //
        // What is true is narrower and is all that is recorded: the run COMPLETED, the check was
        // interrupted, and the check has not been answered. So the outcome stays what the run earned,
        // the phase goes back to `pending` so the check is run again, the session is kept, and no
        // retry is burnt — `nextPhase` is not consulted at all, because there is no failure here for
        // it to decide about.
        // From the RECORD, not from `deps.signal.aborted`: the verdict is frozen at `exit`, so an
        // abort landing in the drain window leaves a real exit status behind it, and that status
        // — not the stop — is the answer. Asking the signal re-ran a session whose check had passed.
        if (r.interrupted) {
          say('  check interrupted by the stop — the run stands, and the check runs again');
          checkInterrupted = true;
          ran = { phase: 'pending', outcome: ran.outcome, resumable: true, lastError: null };
        } else if (!r.ok) {
          failedCheck = r.record;
          say(`  ${describeCheck(failedCheck)}`);
        }
      }

      // ---- the declared outputs, COPIED — the second half of the block above, and the last thing
      // that happens before the outcome is decided.
      //
      // Re-planned rather than trusting the probe: the check ran in this tree between the two, and a
      // command that deletes what the run produced has changed the answer. That is a shortfall like
      // any other and it is found here rather than reported as a successful export of nothing.
      //
      // **Gated on the CHECK, and on nothing else that failed.** Moving the copy down here to sit
      // after the check quietly took the shortfall with it, which changed the shipped-default rule:
      // an export that IS present stopped being delivered because a *different* declared output was
      // missing, or because the rebase conflicted — and in the conflict case the attempt is not
      // resumable, so nothing ever delivers it. The rebase block one screen up already states the
      // principle it broke: what an attempt produced "is a durable record of what happened and is
      // worth keeping whether or not its diff still applies". The check is the one exception, and it
      // is the only reason this block moved: an attempt a check went on to REFUSE must not have
      // already written into the operator's repository.
      //
      // A stop that landed mid-check copies too, and `runSucceeded` is what says so: the run finished
      // and produced what it promised, the check gave no verdict either way, and the alternative is
      // recording `exported: []` about files the probe had just seen. The resumed attempt re-runs the
      // check and copies again, which is a no-op over identical bytes.
      // ... and a check that was INTERRUPTED withholds it too: nothing verified this tree, and a
      // copy made now is one the next attempt's check may refuse with no way to take it back.
      if (exportPlan && runSucceeded && heldToTheEnd && !failedCheck && !checkInterrupted) {
        let owed: string | null = null;
        try {
          const got = exportOutputs(ranIn, cwd, declared);
          exported = got.exported;
          if (got.missing.length) owed = missingOutputs(job.id, got.missing);
          else if (exported.length) deps.onEvent?.(`  exported ${exported.length} path${exported.length === 1 ? '' : 's'} into ${cwd}`);
        } catch (e) {
          owed = (e as Error).message;
        }
        // Reported once, and only when it is news: the probe above found the same missing paths a
        // moment ago and already said so, and the first cause found keeps precedence over this one
        // exactly as results and artifacts do.
        if (owed && !shortfall) {
          shortfall = owed;
          deps.onEvent?.(`  ${owed}`);
        }
      }

      // ---- the run is over and nothing else will touch the checkout, so the renewer stops — one
      // line before the claim is verified, so the value it was maintaining is not moving under the
      // read that follows.
      //
      // **Verify, write, delete.** The lease used to be deleted as soon as the runtime returned,
      // which left the Job `running` with no Lease row and an attempt still open for as long as the
      // rebase, the check and these writes took — up to ten minutes with a check in the middle. Every
      // verb that looks into that window got a wrong answer: `hkb cancel` was accepted (`whileUnleased`
      // refuses only when a Lease row EXISTS) and then silently undone by the outcome written below;
      // `hkb rm` cascaded the rows away and turned the `attempt.update` into a P2025 that aborted the
      // whole pass; and a daemon killed in there stranded the Job for ever, because `reclaimExpired`
      // scans Lease rows and there was none to find.
      //
      // The argument that put a fence here is unchanged and still right — a stale holder finishing
      // late must not remove the NEW holder's claim, and the token is what tells the two apart. Only
      // its shape moves: the token is READ here and the row is deleted at the far end, once the
      // outcome is recorded. The count of that delete used to be what said whether we might write;
      // this read says it instead, and says it while the claim is still live.
      clearInterval(renewer);
      const stillHeld = await db.lease.findUnique({ where: { jobId: job.id }, select: { token: true } });
      if (stillHeld?.token !== token) heldToTheEnd = false;

      // A declared output that is not there fails the attempt, and that rule is what makes the
      // declaration worth writing down: without it `succeeded` still means only that a session ended.
      // Not retried — the session's own account is that it finished, so a resumed attempt wakes up
      // done and a cold one re-buys the same run. `hkb retry <id>` is the deliberate second go, once a
      // human has read which path is missing and decided whose mistake it was.
      // ---- the gate. A gated Job that succeeded AND produced everything it declared does not go
      // terminal: it suspends, and waits for a human, a delegated agent, or an auto-approve policy
      // (ADR-010). ORDER MATTERS — the ADR-008 shortfall is evaluated first and outranks it, because
      // a run that did not produce what it promised has nothing worth approving.
      //
      // One-shot, and read off the Event stream rather than a flag cleared on use. A re-entrant gate
      // would delete the Job's completion condition (`prisma/schema.prisma`, `Job.gate`), and a flag
      // consumed on a transition is wrong after a restart in a controller that is level-triggered.
      const approved = job.gate && ran.phase === 'succeeded' && !shortfall
        ? await db.event.count({ where: { jobId: job.id, kind: 'approved' } })
        : 0;
      const decision: Decision = failedCheck
        // Before the gate and before the success, and it cannot collide with the shortfall branch
        // below because the check only runs when there is no shortfall. A gated Job whose check
        // failed does not suspend: nobody should be asked to approve a diff the board already knows
        // does not work, and the answer to it is another attempt rather than a person.
        ? nextPhase(outcome, charged, spec.maxRetries.value, spec.maxBudgetUsd.value, failedCheck)
        : shortfall
        // Not resumable: the session's own account is that it finished, so a resumed attempt wakes
        // up done and a cold one re-buys the same run. `hkb retry <id>` is the deliberate second go,
        // once a human has read which path is missing and decided whose mistake it was.
        //
        // `conflicted` used to be chosen here when the branch rather than the work was the problem.
        // Nothing replays a branch any more, so nothing produces it (ADR-018).
        ? { phase: 'failed', outcome: 'no_output', resumable: false, lastError: shortfall }
        : job.gate && ran.phase === 'succeeded' && approved === 0
          ? { phase: 'suspended', outcome: 'completed', resumable: true, lastError: null }
          : ran;

      // ---- and the Job's own deadline, LAST in precedence and last in code, which are two
      // different orderings and both deliberate.
      //
      // Last in precedence: it outranks the check, the gate and `completed` alike — an attempt that
      // finished cleanly after the Job's deadline ran out still ended a Job nobody may spend more on.
      // Ordering it lower would make the deadline mean "unless the last attempt happened to work",
      // which is a race with the scheduler rather than a ceiling.
      //
      // Last in code so that everything the attempt DECLARED has already been collected above. The
      // work was paid for; discarding a report because a clock expired thirty seconds earlier loses
      // real output and buys nothing. The Job still ends `deadline_exceeded`.
      //
      // Re-measured rather than reused: the value read before the run does not include the run.
      const spent = jobDeadline
        ? await (async () => {
          const all = await db.attempt.findMany({
            where: { jobId: job.id }, select: { startedAt: true, endedAt: true },
          });
          const ran2 = activeMs(all, now());
          return { ...jobDeadline, exceeded: deadlineExceeded(ran2, jobDeadline.seconds), ranForMs: ran2 };
        })()
        : null;
      const final: Decision = spent?.exceeded
        ? {
          phase: 'failed',
          outcome: 'deadline_exceeded',
          resumable: false,
          lastError: deadlineShortfall(spent.jobId, spent.ranForMs, spent.seconds),
        }
        : decision;

      await db.attempt.update({
        where: { jobId_k: { jobId: job.id, k } },
        data: {
          endedAt: now(),
          outcome: final.outcome,
          sessionId: outcome?.sessionId ?? null,
          summary: outcome?.text?.slice(0, 2000) ?? null,
          // The shortfall wins: when a declared output is missing, that is why this attempt ended as
          // it did, and the runtime has no error of its own to report — it thinks it succeeded. A
          // refused check is the same kind of fact and reads the same way in `hkb show`; the tail it
          // captured is on `check` below rather than crammed into 300 characters of prose.
          reason: (shortfall ?? (failedCheck ? describeCheck(failedCheck) : null)
            ?? (checkInterrupted ? CHECK_INTERRUPTED : null) ?? outcome?.error)?.slice(0, 300) ?? null,
          costUsd: outcome?.costUsd ?? null,
          // Measured by the runtime, not reported by the agent. An attempt that never reached the
          // runtime has no measurement rather than a measurement of zero, hence `?? null`.
          turns: outcome?.turns ?? null,
          denials: outcome?.denials ?? null,
          // Omitted rather than nulled: a Job that declared nothing has no fact to record here, and
          // Prisma's Json null needs a sentinel to say which of the two nulls it means.
          ...(exported ? { exported } : {}),
          ...(produced ? { results: produced } : {}),
          ...(artifacts ? { artifacts } : {}),
          // The catalogue, never the content — that is in the prompt and in the transcript the
          // session id points at. It is what makes "declared inputs reduce input tokens" a thing this
          // board can check rather than a thing read in a paper.
          ...(readInputs.length
            ? { inputs: readInputs.map((i) => ({ name: i.name, source: i.source, bytes: Buffer.byteLength(i.text) })) }
            : {}),
          // What was proposed, as the validator accepted it — beside what was produced, not instead of
          // it. The raw `proposal.json` stays in the artifact directory, so a reader can line up what
          // was asked for, what was accepted and (once applied) what was created. A tool call leaves
          // no such record, which is ADR-011's audit argument in one column.
          ...(proposal ? { proposal } : {}),
          // What the check said, when it refused. Nothing for a check that passed and nothing for an
          // attempt that ran none: a passing check is the absence of a finding, and a row per success
          // would be a log rather than a record. It is read back by the NEXT attempt, which is the
          // whole reason it is a column and not a sentence (`prisma/schema.prisma`, `Attempt.check`).
          ...(failedCheck ? { check: failedCheck } : {}),
        },
      });

      // The attempt row is ours whatever happened — it is keyed (jobId, k) and no other holder uses
      // our k. The JOB row is the contended one, so only a holder that kept its lease may write it.
      if (!heldToTheEnd) {
        say('lease was taken mid-run — recording the attempt, leaving the Job alone');
        await db.event.create({
          data: { kind: 'lease_lost', jobId: job.id, boardId: job.boardId, actor: host, payload: { k } },
        });
        report.skipped.push(job.id);
        // The workspace is deliberately left alone: it belongs to whoever holds the lease now, and
        // a stale holder taking it would remove the checkout the new holder's session is standing
        // in. The TTL sweep collects it once the Job is finished, whichever holder finished it.
        return;
      }

      await db.job.update({
        where: { id: job.id },
        data: {
          phase: final.phase,
          // Why it is waiting, in the operator's own words — not derivable from any runtime, which is
          // why the column exists. Cleared on any other transition so a resumed Job does not keep
          // claiming to be waiting for something that already happened.
          // A proposing Job says how much it is asking for, because that is the question. The
          // operator's own `--gate` text stays the fallback, and is all there is until a proposal
          // has actually been validated.
          suspendedFor: final.phase === 'suspended' ? (proposal ? proposalGate(proposal.jobs.length) : job.gate) : null,
          // Keep the session only while continuing it would help; a cold retry must start clean.
          // A gate fires on SUCCESS, and `nextPhase` calls a completed run not-resumable — so the
          // suspended decision sets `resumable: true` itself, which is what keeps the session the
          // approver's instruction is meant to continue. Without that the session would be discarded
          // at the exact moment the Job suspends waiting for it.
          lastSessionId: final.resumable ? (outcome?.sessionId ?? null) : null,
          // The decision's own line wins where it has one: for a stop only a human can undo, "what
          // to change" is worth more than whatever the runtime called it.
          // Null for a Job that is waiting as well as one that finished. The gate fires only on a
          // success that produced everything it declared, so there is no error to carry — and the
          // fallback to `final.outcome` put the word `completed` in the error column of every
          // suspended Job, which `hkb show` printed as `error completed`.
          //
          // And never the word `completed` for a run that did complete but is `pending` again because
          // its check was interrupted — there is nothing for a human to change there either.
          lastError: final.phase === 'succeeded' || final.phase === 'suspended' || final.outcome === 'completed'
            ? null
            : (final.lastError ?? outcome?.error ?? final.outcome),
          // Neither pending nor suspended is finished. A suspended Job is waiting on a person, which
          // is the one state that can last days — stamping it finished would make every "how long did
          // this take" answer include the time somebody spent deciding.
          finishedAt: final.phase === 'pending' || final.phase === 'suspended' ? null : now(),
        },
      });

      // The Job row carries the outcome from here on. A failure past this line — the event write, a
      // closed log pipe — must not be answered by rewriting rows that are already right.
      recorded = true;

      await db.event.create({
        data: {
          kind: final.outcome, jobId: job.id, boardId: job.boardId, actor: host,
          payload: { k, phase: final.phase, ...(checkInterrupted ? { checkInterrupted: true } : {}) },
        },
      });

      // ---- release, LAST, and fenced on the token — in the `finally` at the foot of this
      // function, which is where it is written and why.
      //
      // Last because the Lease row is what tells every other verb that this Job is being worked on:
      // `whileUnleased` refuses `hkb cancel` and `hkb rm` while it is there, and `reclaimExpired`
      // finds a dead holder by it. Dropping it before the outcome was written opened a window in
      // which the Job was `running`, unleased, with an attempt still open — and every one of the
      // three verbs that looked into that window got a wrong answer. The outcome is now on the row,
      // so the window is closed, and the release happens on the way out however this ends.

      // ---- tidy. **Nothing here any more, and that is the design** (ADR-018).
      //
      // What stood here decided whether to keep the checkout: kept when the next attempt would
      // resume in it, kept when a conflict or a refused check meant the operator's next move was to
      // stand in that tree, and otherwise removed unless it held unpushed commits. Four branches,
      // every one of them reasoning about what was inside a git tree.
      //
      // A workspace now dies by `ttlSecondsAfterFinished` and nothing else (`src/workspaces.ts`).
      // That is what `emptyDir` means: it goes with the Pod, on a clock, not on an inspection. The
      // two properties the branches bought are kept without them — a Job that is `pending` or
      // `suspended` has no `finishedAt`, so the sweep will not touch its workspace while another
      // attempt may resume there, and a finished Job's tree survives for the whole TTL, which is the
      // window an operator has to go and look at it.
      //
      // The runtime releases its own lock when the session ends, so there is nothing to unlock here
      // either.

      if (final.phase === 'succeeded') report.succeeded.push(job.id);
      else if (final.phase === 'failed') report.failed.push(job.id);
      else if (final.phase === 'suspended') report.suspended.push(job.id);
      else if (final.outcome === 'stopped' || checkInterrupted) report.stopped.push(job.id);
      else report.retrying.push(job.id);
      say(`${final.phase.padEnd(9)} ${final.outcome}${final.resumable ? ' (resumable)' : ''}`);
    } catch (e) {
      // Our own plumbing, not the work: the run itself already returns its failures as a
      // `WorkerOutcome` and never throws (`.catch(() => null)` above). What lands here is a board
      // write that lost a race, a filesystem that refused, a git invocation that died. The attempt
      // is closed anyway, because an attempt row left open is a Job that reads as `running` for
      // ever, and `crashed` is precisely the outcome for "the run did not come back".
      const why = `#${job.id} the pass failed after the run: ${(e as Error)?.message ?? String(e)}`;
      // `say` goes through `deps.onEvent`, which is one of the things that can have thrown here —
      // a log on a closed pipe is `hkb run | head`. A handler that fails while reporting a failure
      // reports neither.
      try { say(`  ${why}`); } catch { /* the log is gone; the row below is the durable record */ }
      // Past the record, the rows are right and the failure is in the reporting of them — a closed
      // pipe, an event write that lost a race. Rewriting a `completed` attempt as `crashed` and a
      // `succeeded` Job back to `pending` here bought a second paid session for work already
      // delivered. Raise it; touch nothing.
      if (recorded) throw e;
      report.failed.push(job.id);
      // Best effort, and each one on its own: `hkb rm` may have cascaded these rows away while the
      // run was in flight, which is one of the ways to get here in the first place. A throw out of
      // the handler for a throw would take the whole reconcile pass down with it — which is the
      // failure being fixed, one level up.
      const anyway = (p: Promise<unknown>) => p.then(() => {}, () => {});
      await anyway(db.attempt.update({
        where: { jobId_k: { jobId: job.id, k } },
        data: {
          endedAt: now(),
          outcome: 'crashed',
          sessionId: outcome?.sessionId ?? null,
          reason: why.slice(0, 300),
        },
      }));
      // And the Job comes out of `running`. Level-triggered: the next pass has to be able to pick
      // this up or leave it alone on the strength of the row alone, and `running` with no live
      // holder is the one state nothing can act on. Retried if it has retries — the fault was ours
      // and the same brief may well go through next time — and the session is kept, because it
      // finished: what failed was the recording of it.
      //
      // Only by the holder. The body's own rule — the Job row is the contended one, and a lease
      // taken mid-run means another holder is writing it now — does not lapse because the path
      // here is an exception; a stale holder that crashed still has no claim on that row.
      if (heldToTheEnd) {
        const retry = charged <= spec.maxRetries.value;
        await anyway(db.job.update({
          where: { id: job.id },
          data: {
            phase: retry ? 'pending' : 'failed',
            lastError: why,
            // What the run reported, or — when the failure was before the run — what was there:
            // a resumed attempt that crashed reading its inputs has not lost its session.
            lastSessionId: outcome?.sessionId ?? job.lastSessionId ?? null,
            finishedAt: retry ? null : now(),
          },
        }));
        await anyway(db.event.create({
          data: { kind: 'crashed', jobId: job.id, boardId: job.boardId, actor: host, payload: { k, phase: retry ? 'pending' : 'failed' } },
        }));
      }
      // Re-thrown, unchanged: `reconcile` already collects the first failure of a pass and raises it
      // once every in-flight run has recorded its own attempt, and an operator whose pass failed
      // should be told so rather than reading it off a row later. The `finally` below still runs —
      // that is what a `finally` is — so the claim is released on the way past.
      throw e;
    } finally {
      // Unconditionally, both of them, whatever happened above.
      //
      // `clearInterval` is idempotent and is deliberately also called in the body, one line before
      // the fenced read, so the value that read looks at is not moving under it. This is the copy
      // that runs when the body never got there.
      clearInterval(renewer);
      // `deleteMany ... where token` and not `delete ... where jobId`: a holder whose lease was
      // taken from it mid-run must remove ITS claim or nothing, never the new holder's. That is
      // also what makes this safe to run on every path — including the `!heldToTheEnd` return,
      // where the token no longer matches and this deletes nothing.
      await db.lease.deleteMany({ where: { jobId: job.id, token } }).catch(() => {
        // A release that could not be written is not worth a second failure: the lease has a
        // deadline and the renewer has stopped, so `reclaimExpired` takes it within `leaseMs`.
      });
    }
  }
}

/** Reconcile until nothing moves. The controller is idempotent, so this just runs it to a fixpoint. */
export async function reconcileToRest(deps: ControllerDeps, maxPasses = 20): Promise<ReconcileReport[]> {
  const passes: ReconcileReport[] = [];
  for (let i = 0; i < maxPasses; i++) {
    const r = await reconcile(deps);
    passes.push(r);
    if (deps.signal?.aborted) break;
    if (!r.claimed.length && !r.reclaimed.length) break;
  }
  return passes;
}
