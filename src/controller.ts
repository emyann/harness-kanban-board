import { openBoard } from './db.ts';
import { createWorktree, removeWorktree, type Worktree } from './worktree.ts';
import { prForBranch } from './pulls.ts';
import { withProtocol } from './brief.ts';
import { gateClaim, windowStart } from './limits.ts';
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
  cwd: string;
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
};

const nowDefault = () => new Date();

/**
 * Decide what a Job's next phase is, given how its attempt ended and what it has left.
 *
 * Pure, so it is the part worth testing exhaustively: everything interesting about retry, resume
 * and giving up is decided here, and nothing here touches a database or a model.
 */
export function nextPhase(
  outcome: WorkerOutcome | null,
  /** The attempt number that just ran, 1-based. */
  attempt: number,
  maxRetries: number,
): { phase: 'succeeded' | 'failed' | 'pending'; outcome: 'completed' | 'max_turns' | 'max_budget' | 'timed_out' | 'refused' | 'crashed'; resumable: boolean } {
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

/** Reclaim Jobs whose holder died: the lease expired and nobody reported an outcome. */
async function reclaimExpired(db: ReturnType<typeof openBoard>, at: Date, report: ReconcileReport, board?: string, log?: (s: string) => void) {
  const dead = await db.lease.findMany({
    where: { expiresAt: { lt: at }, ...(board ? { job: { board: { slug: board } } } : {}) },
    select: { jobId: true, holder: true },
  });
  for (const l of dead) {
    await db.lease.delete({ where: { jobId: l.jobId } });
    const open = await db.attempt.findFirst({ where: { jobId: l.jobId, endedAt: null }, orderBy: { k: 'desc' } });
    if (open) {
      await db.attempt.update({
        where: { jobId_k: { jobId: l.jobId, k: open.k } },
        data: { endedAt: at, outcome: 'lost', reason: `lease held by ${l.holder} expired` },
      });
    }
    const job = await db.job.findUnique({ where: { id: l.jobId }, select: { maxRetries: true } });
    const spent = await db.attempt.count({ where: { jobId: l.jobId, endedAt: { not: null } } });
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
  const host = deps.host ?? `${process.pid}@${deps.runtime.name}`;
  const leaseMs = deps.leaseMs ?? 15 * 60_000;
  const report: ReconcileReport = { refused: null, claimed: [], succeeded: [], failed: [], retrying: [], reclaimed: [], skipped: [] };

  await reclaimExpired(db, now(), report, deps.board, deps.onEvent);

  const wanted = await db.job.findMany({
    where: {
      phase: 'pending',
      ...(deps.only ? { id: deps.only } : {}),
      ...(deps.board ? { board: { slug: deps.board } } : {}),
    },
    orderBy: { id: 'asc' },
  });

  for (const job of wanted) {
    // ---- the ceilings, checked before every claim rather than once per pass: a run that just
    // finished has moved the spend, and the next Job must be judged against that, not against
    // what was true when the pass started.
    const board = await db.board.findFirst({
      where: deps.board ? { slug: deps.board } : { id: job.boardId },
      select: { pausedAt: true, pausedBy: true, maxConcurrent: true, dailyBudgetUsd: true, id: true },
    });
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
      break;
    }

    const spent = await db.attempt.count({ where: { jobId: job.id, endedAt: { not: null } } });
    const k = spent + 1;

    // ---- acquire. `@@id(jobId)` on Lease is the compare-and-swap: a second holder loses here,
    // and losing is a normal outcome, not an error.
    const token = `${host}:${k}:${now().getTime()}`;
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
    await db.event.create({ data: { kind: 'claimed', jobId: job.id, actor: host, payload: { k } } });
    report.claimed.push(job.id);
    deps.onEvent?.(`claim   #${job.id} k=${k} ${job.name}`);

    // ---- isolate. The SDK has no isolation option for a top-level query, so the checkout is
    // ours to make. `isolate: false` is the escape hatch for a read-only job and is not the
    // default: a worker that edits the operator's tree is the failure this exists to prevent.
    let wt: Worktree | null = null;
    if (job.isolate) {
      try {
        wt = createWorktree(deps.cwd, job.id, k);
        deps.onEvent?.(`  worktree ${wt.branch} from ${wt.baseLabel}`);
      } catch (e) {
        // A checkout we could not make is a spawn failure, not a worker failure. Say so, release,
        // and leave the Job pending rather than burning a retry on our own plumbing.
        await db.lease.delete({ where: { jobId: job.id } });
        await db.attempt.update({
          where: { jobId_k: { jobId: job.id, k } },
          data: { endedAt: now(), outcome: 'crashed', reason: (e as Error).message.slice(0, 300) },
        });
        await db.job.update({ where: { id: job.id }, data: { phase: 'pending', lastError: (e as Error).message } });
        report.retrying.push(job.id);
        continue;
      }
    }

    // ---- run. A resumable stop leaves a session id; the next attempt continues it rather than
    // starting cold, which is the whole reason that column exists.
    const outcome = await deps.runtime
      .run({
        taskId: job.id,
        attempt: k,
        cwd: wt ? wt.path : deps.cwd,
        prompt: wt ? withProtocol(job.brief, wt.branch) : job.brief,
        model: job.model ?? undefined,
        effort: (job.effort as 'low' | 'medium' | 'high' | 'xhigh' | 'max' | undefined) ?? undefined,
        maxTurns: job.maxTurns,
        maxBudgetUsd: job.maxBudgetUsd,
        timeoutMs: job.timeoutMs,
        resume: job.lastSessionId ?? undefined,
      }, deps.onRuntimeEvent)
      .catch((): null => null);

    const decision = nextPhase(outcome, k, job.maxRetries);

    // ---- what landed on the forge. One read, by head branch: the board and the forge are two
    // systems and this is the only thing that joins them.
    const pr = wt && deps.readPr !== false ? prForBranch(deps.cwd, wt.branch) : null;
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
      data: { kind: decision.outcome, jobId: job.id, actor: host, payload: { k, phase: decision.phase } },
    });
    await db.lease.delete({ where: { jobId: job.id } });

    // ---- tidy. Never forced: a worktree that still holds work is the only copy of it if the
    // push failed, so it stays and the operator is told where.
    if (wt) {
      const gone = removeWorktree(deps.cwd, wt);
      if (!gone.removed) deps.onEvent?.(`  kept ${wt.path} — ${gone.why}`);
    }

    if (decision.phase === 'succeeded') report.succeeded.push(job.id);
    else if (decision.phase === 'failed') report.failed.push(job.id);
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
    if (!r.claimed.length && !r.reclaimed.length) break;
  }
  return passes;
}
