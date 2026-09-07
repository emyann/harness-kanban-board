import type { Prisma } from './generated/prisma/client.ts';
import type { openBoard } from './db.ts';
import { resolveSpec } from './spec.ts';

/**
 * The human half of a Job's lifecycle.
 *
 * A Job's phase moves for two reasons and they belong to different owners. The **controller** moves
 * it by observing: `pending → running`, then `running → succeeded | failed | suspended | pending`,
 * plus reclaiming a lease whose holder died. That half has been a module since ADR-007. The other
 * half moves because a **person decided** — queue this, put it back, approve it, retry it, this is
 * finished, this is not wanted — and it had no module at all. It grew one verb at a time inside
 * `switch (verb)` in `src/hkb.ts`, downstream of argv parsing, where nothing but the CLI can reach
 * it.
 *
 * That is the failing half of ADR-015's own test — *"could a web board be built without touching
 * `src/hkb.ts`? No"* — and this module is the answer to it. Nothing here is new behaviour: the
 * guards, the messages, the events and the returned shapes are the ones the verbs already had, and
 * the verbs now parse arguments, call one of these, and print.
 *
 * ## What a transition is, and why it is not a phase write
 *
 * Every one of these is a lookup, a set of refusals, and a group of writes that belong together.
 * The refusals are the part worth having a module for. `#12 is leased by host/9 — it is running`
 * is not defensive coding; it is the reason concluding a Job out from under a live worker leaves
 * that worker reporting to a record which says the question was already settled. A second consumer
 * that re-implemented these from the phase diagram would get the diagram right and the reasoning
 * wrong, which is precisely how the machinery and the product become one thing.
 *
 * ## The actor is a parameter, and that is the one deliberate change
 *
 * The verbs read `process.env.USER` and `os.hostname()` to decide who acted. A web board's actor is
 * a logged-in person and a daemon's is a host — neither is an environment variable here. So every
 * function takes `by`, and no function in this module has an opinion about who is calling it. That
 * is the smallest thing that makes these callable by something that is not a terminal.
 *
 * ## Writes are atomic here, which three of them were not
 *
 * `queue` and `approve` already wrapped their writes in `$transaction`; `done`, `retry` and `rm`
 * did the same work as separate awaits, because they were written on different days. A phase moved
 * without the event that explains it is a Job the log cannot account for — so they are all
 * transactions now. No behaviour changes on the success path; the failure path stops being able to
 * leave half a transition behind.
 */

type Db = ReturnType<typeof openBoard>;

/** Who did it. A username, a host, a service account — this module does not care which. */
export type Actor = string;

/**
 * A refusal, in the shape the CLI already throws: exit code 2 for usage or state, and a message
 * that names the fix. Kept here rather than imported from `src/hkb.ts` so that nothing in this
 * module depends on the CLI — the dependency runs one way, which is the whole point of the file.
 */
function refuse(message: string): never {
  const e = new Error(message) as Error & { exitCode: number };
  e.exitCode = 2;
  throw e;
}

/** The Job, with the two relations every transition needs to judge one, or a refusal. */
async function find(db: Db, id: number, missing: string) {
  const job = await db.job.findUnique({ where: { id }, include: { lease: true } });
  if (!job) refuse(missing);
  return job;
}

/**
 * A lease is a worker running *right now*, and no transition here proceeds past one.
 *
 * This is the plain form, and after the destructive pair moved their check inside a transaction it
 * has exactly one caller — `triageJob`, where a stale read is harmless because the worst case is a
 * phase the next reconcile corrects. `approveJob`/`rejectJob` refuse through `requireSuspended`,
 * `retryJob` inline, and `concludeJob`/`removeJob` in `inOneTransaction`. Four spellings of one
 * rule is more than it deserves, and consolidating them is a job for whoever next touches two of
 * them — noted here rather than done now, because a refactor that rewrites five messages while
 * claiming to change nothing is how a message quietly stops naming the fix.
 */
function refuseIfLeased(job: { id: number; lease: { holder: string; expiresAt: Date } | null }, what: string): void {
  if (!job.lease) return;
  refuse(`#${job.id} is leased by ${job.lease.holder} — ${what}`);
}

type Tx = Prisma.TransactionClient;

/**
 * The two transitions that DESTROY something, with the lease guard **inside the first write**.
 *
 * Everywhere else the lease is read first and written after, and between those two statements a
 * daemon can claim the Job. For a transition that only moves a phase that is a stale read the next
 * reconcile sorts out. For these two it is not: `Lease.job` is `onDelete: Cascade`, so removing a
 * Job silently deletes a lease a worker acquired one millisecond ago — the exact outcome the guard
 * exists to prevent — and concluding one leaves that worker reporting to a record which says the
 * question was already settled.
 *
 * ## Why the guard is a WHERE clause and not a read
 *
 * The obvious shape is `SELECT` the lease, refuse, then write, all inside one transaction. It is
 * correct and it stalls the daemon. Prisma's better-sqlite3 adapter opens an interactive
 * transaction with a plain deferred `BEGIN`, and this board runs in `journal_mode=delete`, so a
 * *read* as the first statement takes a SHARED lock held for the whole transaction: any other
 * process writing the board in that window waits out `busy_timeout` and then fails
 * `SQLITE_BUSY: database is locked`. `hkb up` is running, an operator types `hkb done 12`, and the
 * reconcile pass dies. Before any of this those verbs were autocommit writes with no read window.
 *
 * So the first statement is the *conditional write* — `where: { id, lease: { is: null } }`, which
 * is the guard — and SQLite escalates to RESERVED immediately, where `busy_timeout` does its job.
 * A count of zero is the refusal, and only then is the lease read, to say whose it is.
 *
 * **One guard, not two.** The first version kept an earlier `refuseIfLeased` as well, for its
 * better message, and that made this check unreachable: no mutation of it failed a test, because
 * nothing ever got here holding a lease. An inert guard that reads like the load-bearing one is how
 * this project has shipped three checks that did nothing.
 */
async function whileUnleased(
  db: Db,
  id: number,
  leased: (holder: string, expiresAt: Date) => string,
  claim: (tx: Tx) => Promise<{ count: number }>,
  rest: ((tx: Tx) => Promise<unknown>)[],
): Promise<void> {
  await db.$transaction(async (tx) => {
    const { count } = await claim(tx);
    if (count === 0) {
      const held = await tx.lease.findUnique({ where: { jobId: id } });
      refuse(held
        ? leased(held.holder, held.expiresAt)
        : `#${id} is no longer on the board — nothing was changed.`);
    }
    for (const write of rest) await write(tx);
  });
}

// ---------------------------------------------------------------- triage ⇄ pending

export type Queued = { id: number; phase: 'pending'; rebriefed: boolean };

/**
 * A note becomes work.
 *
 * The brief is rewritable **here and nowhere else**, because this is the moment it stops being a
 * note and becomes an instruction: the note said what you saw, and the brief has to say what to do
 * about it. Optional, because a note that was already a good brief needs no second pass.
 */
export async function queueJob(
  db: Db,
  id: number,
  opts: { brief?: string | null | (() => Promise<string>); by: Actor },
): Promise<Queued> {
  const job = await find(db, id, `no Job #${id} — \`hkb ls\` shows what is on the board`);
  if (job.phase !== 'triage') {
    refuse(`#${id} is ${job.phase}, not triage — \`hkb queue\` is for a Job nobody has decided on yet`
      + (job.phase === 'pending' ? ', and this one is already queued' : ''));
  }
  // A PRODUCER, not just a string, and the ordering is the reason. Reading a brief can block —
  // `--brief -` waits for EOF on stdin — so a caller that reads it before calling turns
  // `hkb queue 999 --brief -` from an instant `no Job #999` into a hang. The guards run first and
  // the read happens here, which is the one place that knows they passed.
  const given = typeof opts.brief === 'function' ? await opts.brief() : opts.brief;
  const brief = given?.trim() || null;
  await db.$transaction([
    db.job.update({ where: { id }, data: { phase: 'pending', ...(brief ? { brief } : {}) } }),
    db.event.create({
      data: { kind: 'queued', jobId: id, boardId: job.boardId, actor: opts.by, payload: brief ? { rebriefed: true } : {} },
    }),
  ]);
  return { id, phase: 'pending', rebriefed: !!brief };
}

export type Triaged = { id: number; phase: 'triage' };

/**
 * The way back.
 *
 * Without it a Job filed in haste can only be cancelled, which is terminal and throws away the note
 * along with the decision not to run it now.
 */
export async function triageJob(db: Db, id: number, opts: { by: Actor }): Promise<Triaged> {
  const job = await find(db, id, `no Job #${id} — \`hkb ls\` shows what is on the board`);
  refuseIfLeased(job, 'it is running now. Wait for it, or let the lease expire.');
  if (job.phase === 'triage') refuse(`#${id} is already in triage`);
  if (job.phase !== 'pending') {
    refuse(`#${id} is ${job.phase}, and triage is for work that has not started`
      + ` — \`hkb retry ${id}\` puts a stopped Job back on the board, \`hkb cancel ${id} "<why>"\` ends it`);
  }
  await db.$transaction([
    db.job.update({ where: { id }, data: { phase: 'triage' } }),
    db.event.create({ data: { kind: 'triaged', jobId: id, boardId: job.boardId, actor: opts.by, payload: {} } }),
  ]);
  return { id, phase: 'triage' };
}

// ---------------------------------------------------------------- the gate (ADR-010)

export type Approved = {
  id: number; phase: 'pending'; by: Actor; note: string | null; proposes: string | null;
};

/**
 * Let a gated Job go on, in the approver's own words.
 *
 * The approval **is** the Event — durable, never consumed, attributable — and the phase change is
 * what the controller acts on. Both in one transaction, because a phase moved without the event
 * that explains it would give the next attempt the brief again instead of the instruction
 * (ADR-010 decision 4).
 */
export async function approveJob(
  db: Db,
  id: number,
  opts: { note?: string; by: Actor },
): Promise<Approved> {
  const job = await find(db, id, `no Job #${id}`);
  requireSuspended(job, id);
  const note = opts.note?.trim() || '';
  await db.$transaction([
    db.event.create({
      data: { kind: 'approved', jobId: id, boardId: job.boardId, actor: opts.by, payload: note ? { note } : {} },
    }),
    db.job.update({ where: { id }, data: { phase: 'pending', suspendedFor: null } }),
  ]);
  return { id, phase: 'pending', by: opts.by, note: note || null, proposes: job.proposes };
}

export type Rejected = { id: number; phase: 'cancelled'; by: Actor; why: string };

/** The other end of the gate. A rejection is terminal, and it must say why. */
export async function rejectJob(
  db: Db,
  id: number,
  opts: { note: string; by: Actor },
): Promise<Rejected> {
  const note = opts.note.trim();
  if (!note) refuse(`hkb reject ${id} "<why>" — a rejection without a reason tells the next reader nothing.`);
  const job = await find(db, id, `no Job #${id}`);
  requireSuspended(job, id);
  await db.$transaction([
    db.job.update({
      where: { id },
      data: { phase: 'cancelled', endedBy: opts.by, endedFor: note, finishedAt: new Date(), suspendedFor: null },
    }),
    db.event.create({
      data: { kind: 'rejected', jobId: id, boardId: job.boardId, actor: opts.by, payload: { note } },
    }),
  ]);
  return { id, phase: 'cancelled', by: opts.by, why: note };
}

/**
 * Both ends of the gate refuse the same two things.
 *
 * Refused rather than queued: a Job that is not waiting has nothing to approve, and saying so beats
 * writing an approval that the next reconcile ignores.
 */
function requireSuspended(
  job: { phase: string; lease: { holder: string; expiresAt: Date } | null },
  id: number,
): void {
  if (job.phase !== 'suspended') {
    refuse(`#${id} is ${job.phase}, not suspended — there is nothing waiting to be decided. `
      + `Only a gated Job that has produced what it declared waits here.`);
  }
  if (job.lease) refuse(`#${id} is held by ${job.lease.holder} — wait for the run to end, or \`hkb down\`.`);
}

// ---------------------------------------------------------------- back onto the board

export type Requeued = {
  id: number; phase: 'pending'; maxBudgetUsd: number | null; resume: string | null;
  /** The raise, when there was one. Its own field rather than a second type for
   * `maxBudgetUsd`, which is what the CLI used to emit and what broke arithmetic on it. */
  raised?: { from: number; to: number };
  /** What the Job was before, for the caller's own message. */
  was: string;
  /** The cap the LAST attempt actually ran under — what a raise is measured from. */
  ranUnder: number;
};

/**
 * The deliberate re-queue.
 *
 * `nextPhase` retries what a retry could plausibly change and stops at what it cannot — a Job that
 * spent its whole budget gets the same cap next time, so the controller fails it rather than making
 * the same wall again. Raising the cap is a change to the Job's spec, which belongs to whoever
 * filed it: this is where they make it, and the raise goes on the event stream so the extra money
 * has a name against it.
 */
export async function retryJob(
  db: Db,
  id: number,
  opts: {
    maxBudgetUsd?: number; maxTurns?: number; maxRetries?: number; by: Actor;
  },
): Promise<Requeued> {
  const job = await db.job.findUnique({
    where: { id },
    include: {
      lease: true, board: true,
      attempts: { where: { endedAt: { not: null } }, orderBy: { k: 'desc' }, take: 1 },
    },
  });
  if (!job) refuse(`no Job #${id} — \`hkb ls\` shows what is on the board`);
  if (job.lease) {
    refuse(`#${id} is leased by ${job.lease.holder} — it is running now. Wait for it, or let the lease expire.`);
  }
  if (job.phase === 'pending') refuse(`#${id} is already pending — \`hkb run ${id}\` works it now`);
  if (job.phase === 'running') {
    refuse(`#${id} says running with no lease — \`hkb run\` reclaims it, and re-queueing it by hand would race that`);
  }
  // A proposing Job whose proposal has been applied has nothing left to do: the next pass would see
  // the same approval, re-file rows the unique key already refuses, and finish it again without
  // ever running the worker. Refused here rather than absorbed there, because a retry that quietly
  // does nothing is the failure mode this project has shipped before.
  if (job.proposes && await db.event.count({ where: { jobId: id, kind: 'applied' } })) {
    refuse(
      `#${id} proposed work that has already been filed — retrying it would re-run nothing, `
      + `because the approval it would find is the one that was already applied. `
      + `\`hkb log ${id}\` shows what it filed; file a new Job to propose again.`,
    );
  }

  const { maxBudgetUsd: budget, maxTurns: turns, maxRetries: retries } = opts;
  // Two different caps, and conflating them is how this guard gets it wrong now that a board can
  // supply one. `ranUnder` is what the failed attempt was frozen at — the number that actually
  // stopped it, read off the Attempt because the Job's column is null for every Job that inherited
  // its cap, and because the board's default may have moved since. `wouldGet` is what the next
  // attempt gets, which is today's resolution unless `--max-budget` overrides it. They differ
  // exactly when the board was raised after the failure, and there the retry genuinely buys
  // something: refusing it would send an operator to override a limit no longer in the way.
  const last = job.attempts[0];
  const resolved = resolveSpec(job, job.board).maxBudgetUsd.value;
  const ranUnder = last?.maxBudgetUsd ?? resolved;
  const wouldGet = budget ?? resolved;
  // The guard. Re-queueing a budget-capped Job under the same cap buys exactly what the automatic
  // retry used to: the same run, the same stopping point, the same bill.
  if (last?.outcome === 'max_budget' && !(wouldGet > ranUnder)) {
    refuse(
      `#${id} spent its whole $${ranUnder.toFixed(2)} budget and stopped with work left — running it `
      + `again under $${wouldGet.toFixed(2)} stops in the same place, at the same price. Give it a bigger `
      + `one: \`hkb retry ${id} --max-budget ${(ranUnder * 2).toFixed(2)}\`, or file a smaller brief.`,
    );
  }
  if (budget !== undefined && !(budget > 0)) {
    refuse(`--max-budget wants dollars above zero, got ${budget} — a Job with no budget cannot run at all`);
  }

  // Recorded, because "the cap was raised, by whom, from what" is the one fact that makes a second
  // $2 attempt legible six weeks later.
  const raised = budget !== undefined && budget !== ranUnder;
  await db.$transaction([
    db.job.update({
      where: { id },
      data: {
        phase: 'pending',
        finishedAt: null,
        lastError: null,
        ...(budget !== undefined ? { maxBudgetUsd: budget } : {}),
        ...(turns !== undefined ? { maxTurns: turns } : {}),
        ...(retries !== undefined ? { maxRetries: retries } : {}),
      },
    }),
    db.event.create({
      data: {
        kind: 'requeued', jobId: id, boardId: job.boardId, actor: opts.by,
        payload: {
          was: job.phase,
          // `raised`, the same spelling `hkb retry --json` uses. It was `maxBudgetUsd` here while
          // the command emitted the raise under that name too — and once the command stopped
          // (because the field's TYPE changed on the raise path), `hkb log --json` and `hkb retry
          // --json` disagreed about the name of one fact. Rows written before today spell it the
          // old way; the log is append-only and that is what append-only costs.
          ...(raised ? { raised: { from: ranUnder, to: budget } } : {}),
          resume: job.lastSessionId,
        },
      },
    }),
  ]);
  return {
    id,
    phase: 'pending',
    maxBudgetUsd: budget ?? wouldGet,
    resume: job.lastSessionId,
    was: job.phase,
    ranUnder,
    ...(raised ? { raised: { from: ranUnder, to: budget as number } } : {}),
  };
}

// ---------------------------------------------------------------- ended by hand

export type Concluded = {
  id: number; name: string; phase: 'done' | 'cancelled'; from: string;
  endedBy: Actor; endedFor: string; finishedAt: Date;
};

/**
 * End a Job the machinery cannot end itself.
 *
 * The gap this closes: a Job whose pull request was reviewed and merged while it sat `pending` on a
 * spent budget. The work is done; the board does not know, and the next reconcile spends the whole
 * cap redoing merged work. Until this the only thing that stopped it was deleting the Job, its
 * attempts and its events — so the choice was between re-running work that already landed and
 * destroying the record that it did, on a board whose whole point is the record.
 *
 * `done` and `cancelled` are two statements, not one with a reason attached: *this achieved its aim
 * by other means* and *stop, this is not wanted*. The reason is required by both, because it says
 * **what** landed or **why** it was dropped, which the phase never can.
 */
export async function concludeJob(
  db: Db,
  id: number,
  opts: { phase: 'done' | 'cancelled'; reason: string; by: Actor },
): Promise<Concluded> {
  const { phase, reason, by } = opts;
  // The verb an operator would retype, derived rather than passed: this module has no CLI in it,
  // but "every error says what to do next" is not a CLI rule, and degrading these messages to
  // "try again" is exactly the drift an extraction is supposed to avoid.
  const verb = phase === 'done' ? 'done' : 'cancel';
  if (!reason.trim()) refuse(`#${id} needs a reason — a terminal phase nobody explained is a record that answers nothing`);
  const job = await find(db, id, `no Job #${id} — \`hkb ls\` shows what is on the board`);
  // A lease is a worker running right now, and concluding its Job out from under it would leave it
  // reporting to a record that says the question was already settled. The daemon is a thing the
  // operator can stop, so the message says so — and the check itself is below, inside the write.
  if (job.phase === 'succeeded') {
    refuse(`#${id} already succeeded — the runtime concluded it, and \`hkb ${verb}\` is for the Jobs it cannot. \`hkb show ${id}\` has the attempts.`);
  }
  if (job.phase === phase) {
    refuse(`#${id} is already ${phase}${job.endedBy ? ` — ${job.endedBy} said so: ${job.endedFor}` : ''}`);
  }
  // Between `done` and `cancelled` a restatement IS allowed, and deliberately: they are both the
  // operator's own word, a mistyped verb is easy, and the alternative escape is deleting the Job —
  // the very trap this exists to remove. The correction is another Event, so the log keeps both
  // statements in order rather than pretending the first never happened.

  const at = new Date();
  await whileUnleased(
    db,
    id,
    (holder, expiresAt) =>
      `#${id} is leased by ${holder} — it is running. \`hkb down\` stops the daemon, or wait for the `
      + `run to finish (the lease lapses by ${expiresAt.toISOString()}), then \`hkb ${verb} ${id}\` again.`,
    (tx) => tx.job.updateMany({
      where: { id, lease: { is: null } },
      data: { phase, endedBy: by, endedFor: reason, finishedAt: at },
    }),
    [
    // An attempt still open on a Job with no lease was never heard from again — `lost` is the
    // Outcome that already means exactly that. Closing it is not cosmetic: `hkb show` renders an
    // open attempt as elapsed-so-far, so a terminal Job would print a duration that climbs for
    // ever. Scoped to `endedAt: null`, so a finished attempt is never rewritten.
    (tx) => tx.attempt.updateMany({
      where: { jobId: id, endedAt: null },
      data: { endedAt: at, outcome: 'lost', reason: `#${id} was ${phase} by ${by} while this attempt was open` },
    }),
    (tx) => tx.event.create({
      data: { kind: phase, jobId: id, boardId: job.boardId, actor: by, payload: { from: job.phase, reason } },
    }),
  ]);
  return {
    id, name: job.name, phase, from: job.phase,
    endedBy: by, endedFor: reason, finishedAt: at,
  };
}

// ---------------------------------------------------------------- gone

export type Removed = { removed: number };

/**
 * Delete a Job, its attempts and its events.
 *
 * Not a phase — the row stops existing — but it belongs here because it is the same decision made
 * by the same person under the same lease rule, and because a consumer offering the other five
 * without this one has an incomplete lifecycle. `concludeJob` is almost always the better answer;
 * this is for a Job that should never have been filed.
 */
export async function removeJob(db: Db, id: number, opts: { by: Actor }): Promise<Removed> {
  const job = await find(db, id, `no Job #${id} — nothing to remove`);
  await whileUnleased(
    db,
    id,
    (holder) => `#${id} is leased by ${holder} — it is running. Wait for it, or let the lease expire.`,
    (tx) => tx.job.deleteMany({ where: { id, lease: { is: null } } }),
    [
      // `jobId` would cascade away with the Job it names, taking the record of the deletion with
      // it. The board keeps this one.
      (tx) => tx.event.create({
        data: { kind: 'removed', boardId: job.boardId, actor: opts.by, payload: { id, name: job.name } },
      }),
    ],
  );
  return { removed: id };
}
