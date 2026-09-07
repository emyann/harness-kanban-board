import { openBoard } from './db.ts';
import {
  baseFor, createWorktree, exportOutputs, existingWorktree, fetchBase, isAttemptBranch,
  newestWorktree, lockWorktree, onRemote, pushedRef, removeWorktree, resolves, unlockWorktree,
  type Worktree,
} from './worktree.ts';
import { rebaseNote, rebaseOntoBase, rebaseShortfall } from './rebase.ts';
import { prForBranch } from './pulls.ts';
import {
  approvedPrompt, withArtifacts, withGuide, withInputs, withProposal, withProtocol, withResults,
  withStandingRules, withWorktree,
} from './brief.ts';
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
import { gateClaim, windowStart, type ClaimGate } from './limits.ts';
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
 *   - **Admission stays serial.** The gate, the compare-and-swap and the worktree happen one Job
 *     at a time; only the run itself is concurrent. Two claims can therefore never read the same
 *     `liveLeases` count, and `createWorktree` is never re-entered (it is `spawnSync` anyway, so
 *     in-process it could not be).
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
   * Where to cut worktrees, when the Board does not say.
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
  /** Read the pull request back from the forge after a run. Off in tests, which have no forge. */
  readPr?: boolean;
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
  outcome: 'completed' | 'max_turns' | 'max_budget' | 'timed_out' | 'refused' | 'crashed' | 'stopped' | 'no_output' | 'no_input' | 'conflicted';
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

/**
 * The paths a Job declared, read back out of its JSON column.
 *
 * Defensive about the shape because a Json column is not a type: `hkb new --export` validates every
 * path before it is stored, but nothing stops a hand-written row, and a malformed declaration must
 * not take the reconcile pass down with it. An entry that is not a usable path is dropped here and
 * refused again by `checkExportPath` if it somehow survives.
 */
function declaredExports(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === 'string' && v.trim() !== '').map((v) => v.trim());
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
): Decision {
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
      data: { phase: 'succeeded', suspendedFor: null, lastError: null, finishedAt: now },
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
  /**
   * Repositories whose base branch this pass has already fetched.
   *
   * A pass claims up to `maxConcurrent` Jobs, and on one board they all share a repository — so
   * the fetch is a board-wide call and belongs here rather than in the per-Job block, which is the
   * rule CLAUDE.md states as "no per-Job calls when a board-wide one exists".
   */
  const fetchedRepos = new Set<string>();
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
    // the alternative is cutting a worktree of whatever directory the daemon happened to start in.
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

    // ---- acquire. `@@id(jobId)` on Lease is the compare-and-swap: a second holder loses here,
    // and losing is a normal outcome, not an error.
    const token = `${host}:${k}:${now().getTime()}`;
    const leaseMs = leaseFor(job.timeoutMs);
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
        // Copied off the Lease so the fact survives the release — `hkb show` can say which slot a
        // past attempt held, which is what makes a port collision diagnosable after the fact.
        slot,
      },
    });
    await db.event.create({ data: { kind: 'claimed', jobId: job.id, boardId: job.boardId, actor: host, payload: { k } } });
    report.claimed.push(job.id);
    say(`claim     k=${k} ${job.name}`);

    // ---- isolate. The SDK has no isolation option for a top-level query, so the checkout is
    // ours to make.
    //
    // `isolate: false` is not a read-only escape hatch, and calling it one was wrong: a Job whose
    // deliverable IS an uncommitted change in the operator's working tree is the case it exists
    // for, and the code has always let such a Job write. What it gives up is everything a branch
    // buys — there is no diff to read, no branch to open a pull request from, nothing to revert
    // when the answer is no, and no safety at `maxConcurrent > 1`, where two un-isolated attempts
    // edit the same files at the same time with no lock between them. Isolated is the default
    // because those are the properties a reviewer needs, not because writing is forbidden without
    // them. It also decides what this Job's subagents may do — see `isolated` on the spec below.
    //
    // Still on the serial side of the pass, deliberately: cutting a worktree is fast, and doing it
    // before the run is dispatched keeps every git invocation in this file one-at-a-time.
    let wt: Worktree | null = null;
    if (job.isolate) {
      try {
        // A resumed session continues where it left off, on disk as well as in its transcript.
        // The previous attempt's checkout is kept whenever it held work, so it is usually there.
        // The newest checkout this Job still has, not `k - 1`. `createWorktree` names the directory
        // for the attempt that MADE it, so attempt 2 finds `kb-N-1` and attempt 3 asked for
        // `kb-N-2`, found nothing, and cut a fresh worktree from base with the session resumed on
        // top of it — the exact failure `existingWorktree` exists to prevent, reachable the moment a
        // Job has three attempts.
        // The base is a remote-tracking ref, and nothing here had ever updated one — so a Job filed
        // a minute after a pull request landed was cut from a base without it, on a daemon host
        // nobody is pulling on. One fetch of the base branch, before the base is read.
        //
        // **Once per repository per pass, not once per Job.** This is the serial pre-dispatch
        // section, whose own comment justifies its placement with "cutting a worktree is fast" — a
        // network round trip is not, and five Jobs claimed together would have made five identical
        // fetches one after another, each able to burn the full timeout before any worker started.
        // Boards are keyed by their repository because that is what a fetch is about.
        //
        // Keyed by repository AND base, because a board may now carry Jobs branching from different
        // refs — a step cut from `origin/kb-33-1` needs that branch fetched, and the default one
        // having been fetched says nothing about it.
        const wantBase = spec.base.value;
        const fetchKey = `${cwd}\u0000${wantBase ?? ''}`;
        if (!fetchedRepos.has(fetchKey)) {
          fetchedRepos.add(fetchKey);
          const fetched = fetchBase(cwd, wantBase);
          if (!fetched.fetched && !fetched.skipped && fetched.why) {
            say(`could not fetch the base — ${fetched.why.slice(0, 120)}; using the ref as it stands`);
          }
        }
        const resuming = job.lastSessionId ? newestWorktree(cwd, job.id, k - 1, wantBase) : null;
        // A base that names nothing is a fault in the spec, and it is found for free — so it is
        // said as one rather than becoming "could not create a worktree", which is our own plumbing
        // failing and leaves the Job pending to be retried against the same missing ref for ever.
        // Thrown into the catch below only to reach one place that releases the lease and writes
        // the attempt; the phase it lands in is decided there.
        //
        // **Only when a fresh checkout is being cut.** A resumed attempt continues in a tree that
        // already exists and asks the base for nothing, so failing it because the parent branch has
        // since been merged and deleted would kill a Job over a question nobody asked.
        if (wantBase && !resuming) {
          const label = baseFor(cwd, wantBase);
          if (!resolves(cwd, label)) {
            // The fallback is only named when there IS one: for a base already written
            // `origin/foo`, `baseFor` tries it as given, and printing "neither `origin/foo` nor
            // `origin/foo`" reads as a bug in the message, which it was.
            const alt = wantBase.startsWith('origin/') ? '' : ` nor \`origin/${wantBase}\``;
            // One `ls-remote` on the way out, and only here. The two situations need opposite
            // things from the operator, and telling somebody to "wait for it to be pushed" about a
            // branch sitting on the forge sends them to look in the wrong place entirely.
            const there = onRemote(cwd, wantBase);
            const e = new Error(
              `asks to branch from \`${wantBase}\`, and neither it${alt} names a commit in ${cwd}. `
              + (there
                ? `It IS on the remote — this checkout has never fetched it, and hkb does not refresh `
                  + `attempt branches (that ref is a lease). Fetch it by hand: \`git -C ${cwd} fetch origin ${wantBase.replace(/^origin\//, '')}\`.`
                : `Wait for the branch it names to be pushed — or, if it has already been merged and `
                  + `deleted, re-file this Job against what it merged into.`),
            ) as Error & { badSpec?: boolean };
            e.badSpec = true;
            throw e;
          }
        }
        wt = resuming ?? createWorktree(cwd, job.id, k, wantBase);
        // Held for the length of the run. The daemon's sweep is a second remover, in a second
        // process, and without this it could take the checkout a worker is standing in.
        lockWorktree(cwd, wt, host);
        say(resuming
          ? `resuming in ${wt.branch} (the checkout attempt ${k - 1} left)`
          : `worktree ${wt.branch} from ${wt.baseLabel}`);
      } catch (e) {
        // Two different failures land here and they must not end the same way.
        //
        // A checkout we could not MAKE is our own plumbing: say so, release, and leave the Job
        // pending for the next pass without burning a retry on it.
        //
        // A base that names nothing is the Job's SPEC, and retrying it for ever against a ref that
        // does not exist is the pending loop this branch exists to avoid. It is `no_input` for the
        // same reason a declared input that cannot be read is: the run never started, nothing was
        // spent, and the fault is in the spec or in the repository rather than in the work. `hkb
        // retry <id>` is the deliberate second go, once the ref exists or the spec is fixed.
        // `say` already prefixes `#<id>`; the message must not repeat it, and the sibling branch
        // below avoids the same collision by leading with `no checkout — `. What goes on the JOB
        // row carries the id, because nothing prefixes that.
        const bare = (e as Error).message;
        const badSpec = !!(e as Error & { badSpec?: boolean }).badSpec;
        const why = badSpec ? `#${job.id} ${bare}` : bare;
        say(badSpec
          ? bare.slice(0, 240)
          : `no checkout — ${bare.slice(0, 200)}; left pending, the next pass will try again`);
        await db.lease.delete({ where: { jobId: job.id } });
        await db.attempt.update({
          where: { jobId_k: { jobId: job.id, k } },
          data: { endedAt: now(), outcome: badSpec ? 'no_input' : 'crashed', reason: why.slice(0, 300) },
        });
        await db.job.update({
          where: { id: job.id },
          data: {
            phase: badSpec ? 'failed' : 'pending',
            lastError: why,
            // Terminal, so it clears what every other terminal transition clears. A Job stopped
            // resumably keeps `lastSessionId`; failing here without dropping it left `hkb retry`
            // announcing "(resumes …)" and the next attempt waking a transcript that describes a
            // checkout cut from a different base.
            ...(badSpec ? { finishedAt: now(), lastSessionId: null, suspendedFor: null } : {}),
          },
        });
        await db.event.create({
          data: {
            kind: badSpec ? 'no_input' : 'spawn_failed',
            jobId: job.id, boardId: job.boardId, actor: host, payload: { k },
          },
        });
        (badSpec ? report.failed : report.retrying).push(job.id);
        continue;
      }
    }

    // ---- and now let it go. Everything past this point is the run and the record of it, and it
    // is the only part that overlaps with another Job's.
    const done$: Promise<void> = runAndRecord({ job, spec, k, charged, token, leaseMs, cwd, wt, say, boardSlug: board?.slug ?? null, slot })
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
    wt: Worktree | null;
    say: (line: string) => void;
    /** Both only for the downward API (`self:` inputs) — a Job reading facts about itself. */
    boardSlug: string | null;
    slot: number;
  }): Promise<void> {
    const { job, spec, k, charged, token, leaseMs, cwd, wt, say, boardSlug, slot } = c;

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
          branch: wt?.branch ?? null,
          worktree: wt?.path ?? null,
          repo: cwd,
        };
        const got = self[vf.jobRef.field];
        // Null is a real answer for `branch` and `worktree` on an un-isolated Job, and a Job that
        // declared one has asked for something that does not exist here. Refused rather than
        // rendered empty, which is the same rule every other declaration follows.
        if (got == null) {
          unread.push({ name: want.name, source, why: `this Job has no \`${vf.jobRef.field}\`${vf.jobRef.field === 'branch' || vf.jobRef.field === 'worktree' ? ' — it is running without a worktree (`--no-isolate`)' : ''}` });
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
            attempts: { select: { prUrl: true, outcome: true }, orderBy: { k: 'desc' }, take: 1 },
          },
        });
        const rows: BoardRow[] = others.map((o) => ({
          id: o.id,
          name: o.name,
          phase: o.phase,
          attempts: o._count.attempts,
          lastOutcome: o.attempts[0]?.outcome ?? null,
          producedNothing: o.phase === 'succeeded' && !o.attempts[0]?.prUrl
            && !declaredExports(o.exports).length && !declaredExports(o.results).length
            && !declaredExports(o.artifacts).length,
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

    // One shortfall, and the first cause found is the one reported — the same precedence rule the
    // declared outputs use, for the same reason: two concatenated reasons read worse than one and
    // send the operator to the same place.
    const inputShortfall = missingInputs(job.id, unread) ?? guideShortfall;
    if (inputShortfall) deps.onEvent?.(`  ${inputShortfall}`);

    // ---- run. A resumable stop leaves a session id; the next attempt continues it rather than
    // starting cold, which is the whole reason that column exists.
    // What the worker is told about its base, and every clause of it is load-bearing.
    //
    // `rebaseOnto` — omitted for a RESUMED attempt, which lands in a checkout whose branch is
    // already on the remote: rebasing there makes its next push non-fast-forward, and the
    // protocol's own next rule forbids the force that would fix it. The step would have no legal
    // ending, and a worker in that position reports a failed push and often skips the pull request.
    // The controller rebases that case itself after the run instead.
    //
    // `fetch` — false when the base is an attempt branch, because a worktree shares its parent's
    // ref store and `git fetch origin kb-33-1` there updates `refs/remotes/origin/kb-33-1`, which
    // is the ref `--force-with-lease` compares against for Job 33's own push. `fetchBase` refuses
    // that fetch; a prompt that asks the worker to make it hands the protection straight back, and
    // that is the third time this exact hole has been opened from a different direction.
    //
    // `prBase` — whenever the Job named a base at all. A pull request opened with no `--base`
    // targets the repository's default branch, so a chain step's diff would carry its parent's
    // commits and merging it would merge the parent's unreviewed work into the trunk. The rebase
    // keeps the branch on the right base; only this keeps the review on it.
    const baseBranch = wt ? wt.baseLabel.replace(/^origin\//, '') : null;
    const baseAdvice = wt
      ? {
        rebaseOnto: pushedRef(cwd, wt.branch) ? undefined : wt.baseLabel,
        fetch: !(baseBranch && isAttemptBranch(baseBranch)),
        prBase: spec.base.value && baseBranch ? baseBranch : undefined,
      }
      : undefined;
    // The pull-request protocol, or the sandbox note, or neither. A PROPOSING Job produces no
    // commit, so telling it to open a draft pull request contradicts the contract appended below —
    // one prompt saying both "push what you have" and "write the file and stop" is not an
    // instruction. It still needs to know it is standing in a worktree, which is what `withWorktree`
    // says and all it says.
    const opening = approvalPrompt
      ?? (wt ? (job.proposes ? withWorktree(job.brief, wt.branch) : withProtocol(job.brief, wt.branch, baseAdvice)) : job.brief);
    // The guide goes in FRONT of all of it, including an approval prompt: an approver's instruction
    // is the most recent word on what to do, and the repository's rules are the standing word on how
    // anything here is done. Neither replaces the other.
    // The three rules every worker gets (ADR-014), between the task and the output contracts. Not
    // conditional on anything: a rule that reaches only some Jobs is one nothing can rely on, and
    // that includes a resumed attempt carrying an approver's instruction.
    const ruled = withStandingRules(opening);
    const guided = guide ? withGuide(ruled, guide.text, spec.guide.value as string) : ruled;
    const asked = withInputs(
      withArtifacts(withResults(guided, wantedResults), wantedArtifacts),
      readInputs,
    );
    const prompt = proposalPath && !approvalPrompt
      ? withProposal(asked, proposalPath, spec.maxBudgetUsd.value ?? null)
      : asked;

    const outcome = inputShortfall ? null : await deps.runtime
      .run({
        taskId: job.id,
        attempt: k,
        cwd: wt ? wt.path : cwd,
        // Derived from the checkout we actually made, not from `job.isolate`, so it cannot
        // disagree with `cwd` above. The runtime turns it into the subagent isolation policy: a
        // Job running in the operator's tree has no worktree to bring a subagent's work back to.
        isolated: wt !== null,
        // `withProtocol` is the PULL REQUEST protocol and needs a branch, so it is for an isolated
        // Job only. Results are the opposite case — they matter most to a Job that produces no
        // commit — so they are appended either way.
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
        // Resolved against the BOARD'S REPOSITORY (`cwd` above), never the worktree — ADR-012,
        // `src/plugins.ts`. A worker writes in its worktree, so a grant that resolved there would
        // let a Job write a hook its own next attempt executes. Against the repository, a merge is
        // the only way to change what a grant loads.
        plugins: grantedPlugins,
        timeoutMs: job.timeoutMs,
        resume: job.lastSessionId ?? undefined,
        signal: deps.signal,
      }, deps.onRuntimeEvent)
      .catch((): null => null);

    clearInterval(renewer);

    // ---- release, fenced. `delete({ where: { jobId } })` deleted whoever's lease was there, so a
    // stale holder finishing late removed the NEW holder's claim and then overwrote its outcome.
    // The token was written at claim and never read; now it is the fence. Released BEFORE the
    // Job row is touched, because the count is what says whether we may touch it at all.
    const released = await db.lease.deleteMany({ where: { jobId: job.id, token } });
    if (released.count === 0) heldToTheEnd = false;

    // The operator's intent outranks whatever the runtime made of being cut off. A stopped run
    // reports `timeout` or `error` depending on where the abort landed, and recording either would
    // be a lie about why it ended AND would spend a retry on it.
    const ran: Decision = inputShortfall
      // Terminal, and not retried, for the reason a missing declared OUTPUT is not: the same read
      // fails identically next time. `hkb retry` is the deliberate second go, once a human has read
      // which input is missing and decided whose mistake it was.
      ? { phase: 'failed', outcome: 'no_input', resumable: false, lastError: inputShortfall }
      : deps.signal?.aborted
      ? { phase: 'pending', outcome: 'stopped', resumable: true, lastError: null }
      // Both from the resolved spec, so the budget advice names the cap this attempt actually ran
      // under — which may be the board's. Quoting the raw column would print `$0.00` and send the
      // operator to raise a limit that was never the one they hit.
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
    if (declared.length && ran.phase === 'succeeded' && heldToTheEnd) {
      try {
        const got = exportOutputs(wt ? wt.path : cwd, cwd, declared);
        exported = got.exported;
        if (got.missing.length) shortfall = missingOutputs(job.id, got.missing);
        else if (exported.length) deps.onEvent?.(`  exported ${exported.length} path${exported.length === 1 ? '' : 's'} into ${cwd}`);
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

    // ---- what landed on the forge. One read, by head branch: the board and the forge are two
    // systems and this is the only thing that joins them.
    // Fenced on the JOB, not on this attempt. A pull request that existed before the Job did
    // cannot be its output — that is the stale-branch case, where a name this database invented
    // was already taken on the remote. But one opened by an EARLIER ATTEMPT of this Job is very
    // much its output: a resumed attempt continues onto the same branch, which is the whole point
    // of resuming, and dating the fence from the attempt made a Job lose the pull request it had
    // already opened. Measured: #12 opened PR 366 at 12:41 on attempt 1 and recorded null at 13:39
    // on attempt 2.
    const pr = wt && deps.readPr !== false ? prForBranch(cwd, wt.branch, job.createdAt) : null;
    if (pr) say(`${pr.isDraft ? 'draft ' : ''}PR #${pr.number} ${pr.url}`);
    // Said out loud. A run that committed and pushed but opened no pull request has produced
    // something a human still has to find, and silence here is what let job #4 look finished.
    else if (wt && deps.readPr !== false) say(`no pull request on ${wt.branch}`);

    // ---- the base moved under it. The cheap half of `docs/rebuild-plan.md` item 10: replay the
    // attempt's branch onto the base as it is NOW, and push if the worker already pushed
    // (`src/rebase.ts`). In the common case the brief has already had the worker do it and this is
    // one `merge-base` that reports `current`.
    //
    // Placed AFTER the collection blocks on purpose. A conflict is a fact about the branch, not
    // about the work: the results and artifacts an attempt produced are a durable record of what
    // happened and are worth keeping whether or not its diff still applies. It is placed BEFORE the
    // gate for the opposite reason — nobody should be asked to approve a diff that no longer sits
    // on what they would merge it into — and after the forge read, which is what says whether a
    // person is already looking at this branch.
    //
    // Gated on `heldToTheEnd` like every other write outside our own attempt row: the branch and
    // the remote are contended state too, and a holder that lost its lease mid-run must not rewrite
    // history the new holder's worker is committing onto.
    let conflicted: string | null = null;
    if (wt && ran.phase === 'succeeded' && heldToTheEnd && !shortfall) {
      // A pull request somebody has taken out of draft is a diff a person is reading, and the
      // whole safety argument for rewriting an attempt branch was that nobody was. It is checked
      // rather than asserted now: ADR-010's gate suspends an attempt *precisely* so a human
      // reviews, and the approved attempt would otherwise have force-pushed out from under their
      // comments. No pull request read (`--json` tests, no forge) means nothing says otherwise.
      const r = rebaseOntoBase(cwd, wt, { mayRewrite: !pr || pr.isDraft });
      const owed = rebaseShortfall(job.id, wt, r);
      const note = rebaseNote(job.id, wt, r);
      if (note) say(`  ${note}`);
      if (owed) {
        conflicted = owed;
        shortfall = owed;
        say(`  ${owed}`);
      } else if (r.kind === 'rebased') {
        // `wt.base` moved with it, inside `rebaseOntoBase` — the sweep below counts from it.
        say(`  rebased onto ${r.label} ${r.onto.slice(0, 7)}${r.pushed ? ' and force-pushed (lease held)' : ''}`);
      }
    }

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
    const decision: Decision = shortfall
      // `conflicted` rather than `no_output` when the branch is the problem, because the two send an
      // operator to different places: `no_output` is a fault in the work and the answer is another
      // run, a conflict is the base having moved and the answer is a hand rebase in a checkout that
      // is still on disk. Not resumable for the same reason a missing output is not — a resumed
      // worker may not force-push, so it has no move here that a human does not have to make first.
      ? { phase: 'failed', outcome: conflicted ? 'conflicted' : 'no_output', resumable: false, lastError: shortfall }
      : job.gate && ran.phase === 'succeeded' && approved === 0
        ? { phase: 'suspended', outcome: 'completed', resumable: true, lastError: null }
        : ran;

    await db.attempt.update({
      where: { jobId_k: { jobId: job.id, k } },
      data: {
        endedAt: now(),
        outcome: decision.outcome,
        sessionId: outcome?.sessionId ?? null,
        summary: outcome?.text?.slice(0, 2000) ?? null,
        // The shortfall wins: when a declared output is missing, that is why this attempt ended as
        // it did, and the runtime has no error of its own to report — it thinks it succeeded.
        reason: (shortfall ?? outcome?.error)?.slice(0, 300) ?? null,
        costUsd: outcome?.costUsd ?? null,
        // Measured by the runtime, not reported by the agent. An attempt that never reached the
        // runtime has no measurement rather than a measurement of zero, hence `?? null`.
        turns: outcome?.turns ?? null,
        denials: outcome?.denials ?? null,
        branch: wt?.branch ?? null,
        prNumber: pr?.number ?? null,
        prUrl: pr?.url ?? null,
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
      if (wt) removeWorktree(cwd, wt);
      return;
    }

    await db.job.update({
      where: { id: job.id },
      data: {
        phase: decision.phase,
        // Why it is waiting, in the operator's own words — not derivable from any runtime, which is
        // why the column exists. Cleared on any other transition so a resumed Job does not keep
        // claiming to be waiting for something that already happened.
        // A proposing Job says how much it is asking for, because that is the question. The
        // operator's own `--gate` text stays the fallback, and is all there is until a proposal
        // has actually been validated.
        suspendedFor: decision.phase === 'suspended' ? (proposal ? proposalGate(proposal.jobs.length) : job.gate) : null,
        // Keep the session only while continuing it would help; a cold retry must start clean.
        // A gate fires on SUCCESS, and `nextPhase` calls a completed run not-resumable — so the
        // suspended decision sets `resumable: true` itself, which is what keeps the session the
        // approver's instruction is meant to continue. Without that the session would be discarded
        // at the exact moment the Job suspends waiting for it.
        lastSessionId: decision.resumable ? (outcome?.sessionId ?? null) : null,
        // The decision's own line wins where it has one: for a stop only a human can undo, "what
        // to change" is worth more than whatever the runtime called it.
        // Null for a Job that is waiting as well as one that finished. The gate fires only on a
        // success that produced everything it declared, so there is no error to carry — and the
        // fallback to `decision.outcome` put the word `completed` in the error column of every
        // suspended Job, which `hkb show` printed as `error completed`.
        lastError: decision.phase === 'succeeded' || decision.phase === 'suspended'
          ? null
          : (decision.lastError ?? outcome?.error ?? decision.outcome),
        // Neither pending nor suspended is finished. A suspended Job is waiting on a person, which
        // is the one state that can last days — stamping it finished would make every "how long did
        // this take" answer include the time somebody spent deciding.
        finishedAt: decision.phase === 'pending' || decision.phase === 'suspended' ? null : now(),
      },
    });

    await db.event.create({
      data: { kind: decision.outcome, jobId: job.id, boardId: job.boardId, actor: host, payload: { k, phase: decision.phase } },
    });

    // ---- tidy. Never forced: a worktree that still holds work is the only copy of it if the
    // push failed, so it stays and the operator is told where.
    //
    // This is not the reclaim path, and it cannot be: a run that just pushed a pull request is at
    // the one moment its checkout is definitionally still needed. It removes the checkouts that
    // never held anything; the daemon's sweep removes the rest, once their branches land. A
    // resumable stop keeps its checkout unconditionally — the next attempt continues *in* it, and
    // cutting a fresh worktree would reset the branch to base and strand what was already pushed.
    if (wt) {
      // A suspended Job keeps its checkout for the same reason a resumable one does: the approved
      // attempt continues *in* it, and cutting a fresh worktree would reset the branch to base and
      // strand whatever the propose half already pushed.
      //
      // A PROPOSING Job is the exception, and it is the exception because of what approval does to
      // it: the controller files the rows and nothing ever wakes up in that checkout. Keeping it
      // costs a whole repository on disk to hold work no session will return to, and the message
      // said "attempt 2 resumes in it" about an attempt that cannot happen. `removeWorktree` still
      // refuses to take unpushed commits, so a proposer that committed anyway keeps its tree.
      const resumesHere = (decision.resumable && decision.phase === 'pending')
        || (decision.phase === 'suspended' && !job.proposes);
      if (resumesHere) {
        unlockWorktree(cwd, wt);
        say(`kept ${wt.path} — attempt ${k + 1} resumes in it`);
      } else if (conflicted) {
        // The checkout IS the fix, and it would otherwise be swept: a branch that conflicts has
        // normally been pushed, so nothing is unpushed and nothing is dirty, and `removeWorktree`
        // would take it and the local branch with it. Finding the conflict early is only worth
        // anything if the tree to resolve it in is still there when the operator reads the message.
        unlockWorktree(cwd, wt);
        say(`kept ${wt.path} — rebase it there`);
      } else {
        // Everything this Job said it would produce is now in the repository, so whatever is left
        // in the checkout is undeclared — litter, in ADR-008's sense, and the one case where a
        // dirty tree is not evidence of work worth keeping. `removeWorktree` still refuses to take
        // unpushed commits; see the note there for what this waives and what it does not.
        const gone = removeWorktree(cwd, wt, { exported: !!exported && !shortfall });
        if (!gone.removed) say(`kept ${wt.path} — ${gone.why}`);
      }
    }

    if (decision.phase === 'succeeded') report.succeeded.push(job.id);
    else if (decision.phase === 'failed') report.failed.push(job.id);
    else if (decision.phase === 'suspended') report.suspended.push(job.id);
    else if (decision.outcome === 'stopped') report.stopped.push(job.id);
    else report.retrying.push(job.id);
    say(`${decision.phase.padEnd(9)} ${decision.outcome}${decision.resumable ? ' (resumable)' : ''}`);
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
