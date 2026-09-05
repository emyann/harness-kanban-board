import { openBoard } from './db.ts';
import { createWorktree, existingWorktree, removeWorktree, type Worktree } from './worktree.ts';
import { prForBranch } from './pulls.ts';
import { withProtocol } from './brief.ts';
import { gateClaim, windowStart } from './limits.ts';
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
 * its agent's session completed, which is a fact about the process. Whether the *outcome* is
 * acceptable is a judgement, and judgements belong to a kind that has a reviewer in it.
 */

export type ControllerDeps = {
  runtime: Runtime;
  /**
   * Where to cut worktrees, when the Board does not say.
   *
   * The Board's `repoPath` is the real answer — a machine-level daemon has no meaningful cwd of
   * its own, and "wherever the operator was standing" stopped being a usable definition of the
   * repository the moment one process started serving several. This remains as the fallback for a
   * board with no repo set, which is how `kb run` in a checkout and every test still works.
   */
  cwd?: string;
  host?: string;
  /** How long a lease is good for. A holder that dies without releasing is reclaimable after this. */
  leaseMs?: number;
  now?: () => Date;
  onEvent?: (line: string) => void;
  /** The runtime's own stream — tool calls and text, for an operator watching a foreground run. */
  onRuntimeEvent?: (e: RuntimeEvent) => void;
  /** Reconcile exactly one Job instead of every pending one. `kb run <id>`. */
  only?: number;
  /**
   * Scope to one board. A Board is the namespace, and a controller that ignores it reaches across
   * every namespace on the host — which is what `kb run --board other` silently did before.
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
   * left to finish: `kb down` that took thirty minutes to return would not be a stop.
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
  phase: 'succeeded' | 'failed' | 'pending';
  outcome: 'completed' | 'max_turns' | 'max_budget' | 'timed_out' | 'refused' | 'crashed' | 'stopped';
  resumable: boolean;
};

export function nextPhase(
  outcome: WorkerOutcome | null,
  /** How many attempts have spent a retry, including this one. 1-based. */
  attempt: number,
  maxRetries: number,
): Decision {
  if (outcome?.status === 'completed') {
    return { phase: 'succeeded', outcome: 'completed', resumable: false };
  }
  const mapped = outcome?.status === 'max_turns' ? 'max_turns'
    : outcome?.status === 'max_budget' ? 'max_budget'
    : outcome?.status === 'timeout' ? 'timed_out'
    : outcome?.status === 'refused' ? 'refused'
    : 'crashed';
  // A refusal is not a transient fault: trying the same brief again gets the same answer.
  // `maxRetries: 2` means two retries AFTER the first go, so three attempts in total.
  const worthRetrying = mapped !== 'refused' && attempt <= maxRetries;
  return {
    phase: worthRetrying ? 'pending' : 'failed',
    outcome: mapped,
    // The three stops that left a session worth continuing. A crash and a refusal did not.
    resumable: mapped === 'max_turns' || mapped === 'max_budget' || mapped === 'timed_out',
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
      log?.(`  #${l.jobId}: lease from ${l.holder} lapsed, but that process is alive — not reclaiming`);
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
    const job = await db.job.findUnique({ where: { id: l.jobId }, select: { maxRetries: true } });
    const spent = await db.attempt.count({
      where: { jobId: l.jobId, endedAt: { not: null }, outcome: { not: 'stopped' } },
    });
    await db.job.update({
      where: { id: l.jobId },
      data: { phase: spent < (job?.maxRetries ?? 0) + 1 ? 'pending' : 'failed', lastError: 'lease expired' },
    });
    await db.event.create({ data: { kind: 'reclaimed', jobId: l.jobId, actor: l.holder } });
    report.reclaimed.push(l.jobId);
    log?.(`reclaim #${l.jobId} (lease from ${l.holder} expired)`);
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
  const report: ReconcileReport = { refused: null, claimed: [], succeeded: [], failed: [], retrying: [], reclaimed: [], skipped: [], stopped: [] };

  if (deps.reclaim !== false) await reclaimExpired(db, now(), report, deps.board, deps.onEvent);

  const wanted = await db.job.findMany({
    where: {
      phase: 'pending',
      ...(deps.only ? { id: deps.only } : {}),
      ...(deps.board ? { board: { slug: deps.board } } : {}),
    },
    orderBy: { id: 'asc' },
  });

  for (const job of wanted) {
    // A shutdown stops claiming immediately. Whatever is already running is dealt with below, in
    // the pass that started it — this only refuses to open new work.
    if (deps.signal?.aborted) break;

    // ---- the ceilings, checked before every claim rather than once per pass: a run that just
    // finished has moved the spend, and the next Job must be judged against that, not against
    // what was true when the pass started.
    const board = await db.board.findFirst({
      where: deps.board ? { slug: deps.board } : { id: job.boardId },
      select: { pausedAt: true, pausedBy: true, maxConcurrent: true, dailyBudgetUsd: true, id: true, repoPath: true },
    });
    // The repository this Job runs in. On the Board because a Board is the Namespace and the
    // ceilings above are already per-repo facts; on nothing at all is an error worth naming, since
    // the alternative is cutting a worktree of whatever directory the daemon happened to start in.
    const cwd = board?.repoPath ?? deps.cwd;
    if (!cwd) {
      throw new Error(
        `board for #${job.id} has no repoPath and no cwd was given — `
        + '`kb boards add <slug> --repo <path>` points a board at a repository',
      );
    }
    const [liveLeases, spend] = await Promise.all([
      db.lease.count({ where: { job: { boardId: board?.id ?? job.boardId } } }),
      db.attempt.aggregate({
        _sum: { costUsd: true },
        where: { job: { boardId: board?.id ?? job.boardId }, startedAt: { gte: windowStart(now()) } },
      }),
    ]);
    const gate = gateClaim({
      pausedAt: board?.pausedAt ?? null,
      pausedBy: board?.pausedBy ?? null,
      liveLeases,
      maxConcurrent: board?.maxConcurrent ?? 1,
      spent24h: spend._sum.costUsd ?? 0,
      dailyBudgetUsd: board?.dailyBudgetUsd ?? null,
      jobBudgetUsd: job.maxBudgetUsd,
    });
    if (gate.ok === false) {
      // Loudly, and once: the whole pass stops, because every remaining Job faces the same wall.
      report.refused = gate.why;
      deps.onEvent?.(`refused  ${gate.why}`);
      await db.event.create({
        data: { kind: 'refused', jobId: job.id, boardId: board?.id ?? job.boardId, actor: host, payload: { why: gate.why } },
      });
      break;
    }

    // Two different counts, and conflating them was a bug waiting to happen. `k` numbers the
    // attempt and must never repeat — it is half the Attempt's primary key. `charged` is how many
    // attempts spent a retry, and an attempt the operator stopped did not: `kb down` three times
    // would otherwise exhaust a Job that never once failed.
    const done = await db.attempt.findMany({
      where: { jobId: job.id, endedAt: { not: null } },
      select: { outcome: true },
    });
    const k = done.length + 1;
    const charged = done.filter((a) => a.outcome !== 'stopped').length + 1;

    // ---- acquire. `@@id(jobId)` on Lease is the compare-and-swap: a second holder loses here,
    // and losing is a normal outcome, not an error.
    const token = `${host}:${k}:${now().getTime()}`;
    const leaseMs = leaseFor(job.timeoutMs);
    try {
      await db.lease.create({
        data: { jobId: job.id, holder: host, token, expiresAt: new Date(now().getTime() + leaseMs) },
      });
    } catch {
      report.skipped.push(job.id);
      continue;
    }

    await db.job.update({ where: { id: job.id }, data: { phase: 'running' } });
    await db.attempt.create({ data: { jobId: job.id, k, host, runtime: deps.runtime.name } });
    await db.event.create({ data: { kind: 'claimed', jobId: job.id, boardId: job.boardId, actor: host, payload: { k } } });
    report.claimed.push(job.id);
    deps.onEvent?.(`claim   #${job.id} k=${k} ${job.name}`);

    // ---- isolate. The SDK has no isolation option for a top-level query, so the checkout is
    // ours to make. `isolate: false` is the escape hatch for a read-only job and is not the
    // default: a worker that edits the operator's tree is the failure this exists to prevent.
    let wt: Worktree | null = null;
    if (job.isolate) {
      try {
        // A resumed session continues where it left off, on disk as well as in its transcript.
        // The previous attempt's checkout is kept whenever it held work, so it is usually there.
        const resuming = job.lastSessionId ? existingWorktree(cwd, job.id, k - 1) : null;
        wt = resuming ?? createWorktree(cwd, job.id, k);
        deps.onEvent?.(resuming
          ? `  resuming in ${wt.branch} (the checkout attempt ${k - 1} left)`
          : `  worktree ${wt.branch} from ${wt.baseLabel}`);
      } catch (e) {
        // A checkout we could not make is a spawn failure, not a worker failure. Say so, release,
        // and leave the Job pending rather than burning a retry on our own plumbing.
        await db.lease.delete({ where: { jobId: job.id } });
        await db.attempt.update({
          where: { jobId_k: { jobId: job.id, k } },
          data: { endedAt: now(), outcome: 'crashed', reason: (e as Error).message.slice(0, 300) },
        });
        await db.job.update({ where: { id: job.id }, data: { phase: 'pending', lastError: (e as Error).message } });
        await db.event.create({
          data: { kind: 'spawn_failed', jobId: job.id, boardId: job.boardId, actor: host, payload: { k } },
        });
        report.retrying.push(job.id);
        continue;
      }
    }

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
            deps.onEvent?.(`  lease lost on #${job.id} — another holder has it`);
          }
        })
        .catch(() => { /* a renewal that could not be written is retried by the next tick */ });
    }, renewEvery);
    if (typeof renewer.unref === 'function') renewer.unref();

    // ---- run. A resumable stop leaves a session id; the next attempt continues it rather than
    // starting cold, which is the whole reason that column exists.
    const outcome = await deps.runtime
      .run({
        taskId: job.id,
        attempt: k,
        cwd: wt ? wt.path : cwd,
        prompt: wt ? withProtocol(job.brief, wt.branch) : job.brief,
        model: job.model ?? undefined,
        effort: (job.effort as 'low' | 'medium' | 'high' | 'xhigh' | 'max' | undefined) ?? undefined,
        maxTurns: job.maxTurns,
        maxBudgetUsd: job.maxBudgetUsd,
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
    const decision: Decision = deps.signal?.aborted
      ? { phase: 'pending', outcome: 'stopped', resumable: true }
      : nextPhase(outcome, charged, job.maxRetries);

    // ---- what landed on the forge. One read, by head branch: the board and the forge are two
    // systems and this is the only thing that joins them.
    const pr = wt && deps.readPr !== false ? prForBranch(cwd, wt.branch) : null;
    if (pr) deps.onEvent?.(`  ${pr.isDraft ? 'draft ' : ''}PR #${pr.number} ${pr.url}`);

    await db.attempt.update({
      where: { jobId_k: { jobId: job.id, k } },
      data: {
        endedAt: now(),
        outcome: decision.outcome,
        sessionId: outcome?.sessionId ?? null,
        summary: outcome?.text?.slice(0, 2000) ?? null,
        reason: outcome?.error?.slice(0, 300) ?? null,
        costUsd: outcome?.costUsd ?? null,
        branch: wt?.branch ?? null,
        prNumber: pr?.number ?? null,
        prUrl: pr?.url ?? null,
      },
    });

    // The attempt row is ours whatever happened — it is keyed (jobId, k) and no other holder uses
    // our k. The JOB row is the contended one, so only a holder that kept its lease may write it.
    if (!heldToTheEnd) {
      deps.onEvent?.(`  #${job.id}: lease was taken mid-run — recording the attempt, leaving the Job alone`);
      await db.event.create({
        data: { kind: 'lease_lost', jobId: job.id, boardId: job.boardId, actor: host, payload: { k } },
      });
      report.skipped.push(job.id);
      if (wt) removeWorktree(cwd, wt);
      continue;
    }

    await db.job.update({
      where: { id: job.id },
      data: {
        phase: decision.phase,
        // Keep the session only while continuing it would help; a cold retry must start clean.
        lastSessionId: decision.resumable ? (outcome?.sessionId ?? null) : null,
        lastError: decision.phase === 'succeeded' ? null : (outcome?.error ?? decision.outcome),
        finishedAt: decision.phase === 'pending' ? null : now(),
      },
    });

    await db.event.create({
      data: { kind: decision.outcome, jobId: job.id, boardId: job.boardId, actor: host, payload: { k, phase: decision.phase } },
    });

    // ---- tidy. Never forced: a worktree that still holds work is the only copy of it if the
    // push failed, so it stays and the operator is told where.
    if (wt) {
      const gone = removeWorktree(cwd, wt);
      if (!gone.removed) deps.onEvent?.(`  kept ${wt.path} — ${gone.why}`);
    }

    if (decision.phase === 'succeeded') report.succeeded.push(job.id);
    else if (decision.phase === 'failed') report.failed.push(job.id);
    else if (decision.outcome === 'stopped') report.stopped.push(job.id);
    else report.retrying.push(job.id);
    deps.onEvent?.(`  ${decision.phase.padEnd(9)} #${job.id} ${decision.outcome}${decision.resumable ? ' (resumable)' : ''}`);
  }

  return report;
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
