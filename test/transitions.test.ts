import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

/**
 * The human half of a Job's lifecycle, tested without a terminal.
 *
 * That is the point of the file as much as its content: every one of these guards used to live
 * inside `switch (verb)` in `src/hkb.ts`, so the only way to exercise one was to hand it argv and
 * read what it printed. A second consumer could not call them and neither could a test. **There is
 * no repository here, no worktree and no CLI** — a transition is a decision about board state, and
 * needing none of those is what makes it callable by a web board.
 *
 * Written as refusals, because that is what these functions are: a lookup, a set of reasons to say
 * no, and a group of writes that belong together.
 */

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hkb-trans-'));
process.env.HKB_DATABASE_URL = `file:${path.join(dir, 'test.db')}`;
const PKG = path.resolve(import.meta.dirname, '..');
execFileSync(process.execPath, ['node_modules/prisma/build/index.js', 'migrate', 'deploy'], {
  cwd: PKG, env: process.env, stdio: 'ignore',
});

const { openBoard, closeBoard } = await import('../src/db.ts');
const {
  approveJob, concludeJob, queueJob, rejectJob, removeJob, retryJob, triageJob,
} = await import('../src/transitions.ts');

const db = openBoard();
const board = await db.board.upsert({ where: { slug: 'trans' }, update: {}, create: { slug: 'trans' } });
let slot = 0;

const mkJob = (name: string, extra: Record<string, unknown> = {}) =>
  db.job.create({ data: { boardId: board.id, name, brief: `do ${name}`, ...extra } });

/** A live lease, which every transition here refuses. */
const lease = (jobId: number, holder = 'host/1') =>
  db.lease.create({
    data: { jobId, holder, token: `t${jobId}`, slot: slot++, expiresAt: new Date(Date.now() + 60_000) },
  });

const events = (jobId: number) => db.event.findMany({ where: { jobId }, orderBy: { id: 'asc' } });
const refusal = async (fn: () => Promise<unknown>, re: RegExp) => {
  await assert.rejects(fn, (e: Error & { exitCode?: number }) => {
    assert.equal(e.exitCode, 2, 'a refusal is exit code 2, the same shape the CLI already threw');
    assert.match(e.message, re);
    return true;
  });
};

test.after(async () => { await closeBoard(); fs.rmSync(dir, { recursive: true, force: true }); });

// ---------------------------------------------------------------- the seam itself

test('the actor is a parameter, so a caller that is not a terminal can say who acted', async () => {
  // The verbs read `process.env.USER` and `os.hostname()`. A web board's actor is a logged-in
  // person and a daemon's is a host; neither is an environment variable, and a module that reads
  // one has quietly decided that only a CLI may call it.
  const j = await mkJob('attributed', { phase: 'triage' });
  await queueJob(db, j.id, { by: 'alice@web' });
  const [e] = await events(j.id);
  assert.equal(e.actor, 'alice@web');
});

test('the guards run BEFORE the brief is read, so a missing Job does not hang on stdin', async () => {
  // `--brief -` blocks until EOF. Reading it before the lookup turned `hkb queue 999 --brief -`
  // from an instant `no Job #999` into a process that never returns.
  let read = false;
  const producer = async () => { read = true; return 'a new brief'; };

  await refusal(() => queueJob(db, 999999, { brief: producer, by: 'a' }), /no Job #999999/);
  assert.equal(read, false, 'nothing was read for a Job that does not exist');

  const pending = await mkJob('not in triage');
  await refusal(() => queueJob(db, pending.id, { brief: producer, by: 'a' }), /already queued/);
  assert.equal(read, false, 'nor for one the guard refuses');

  const j = await mkJob('a note', { phase: 'triage' });
  const r = await queueJob(db, j.id, { brief: producer, by: 'a' });
  assert.equal(read, true, 'and it IS read once the guards pass');
  assert.equal(r.rebriefed, true);
  assert.equal((await db.job.findUniqueOrThrow({ where: { id: j.id } })).brief, 'a new brief');
});

// ---------------------------------------------------------------- triage ⇄ pending

test('queue refuses anything that is not in triage, and says whether it is already queued', async () => {
  const pending = await mkJob('already');
  await refusal(() => queueJob(db, pending.id, { by: 'a' }), /already queued/);
  const done = await mkJob('finished', { phase: 'succeeded' });
  await refusal(() => queueJob(db, done.id, { by: 'a' }), /is succeeded, not triage/);
  await refusal(() => queueJob(db, 999999, { by: 'a' }), /no Job #999999/);
});

test('queue is the one moment the brief may be rewritten, and it says when it was', async () => {
  const j = await mkJob('note', { phase: 'triage' });
  const r = await queueJob(db, j.id, { brief: 'what to actually do', by: 'a' });
  assert.equal(r.rebriefed, true);
  assert.equal((await db.job.findUniqueOrThrow({ where: { id: j.id } })).brief, 'what to actually do');

  const k = await mkJob('good note', { phase: 'triage' });
  const r2 = await queueJob(db, k.id, { by: 'a' });
  assert.equal(r2.rebriefed, false, 'a note that was already a good brief needs no second pass');
  assert.equal((await db.job.findUniqueOrThrow({ where: { id: k.id } })).brief, 'do good note');
});

test('triage refuses a Job that is running, and one that has already started', async () => {
  const running = await mkJob('live');
  await lease(running.id, 'host/9');
  await refusal(() => triageJob(db, running.id, { by: 'a' }), /leased by host\/9/);

  const failed = await mkJob('stopped', { phase: 'failed' });
  await refusal(() => triageJob(db, failed.id, { by: 'a' }), /triage is for work that has not started/);

  const already = await mkJob('back', { phase: 'triage' });
  await refusal(() => triageJob(db, already.id, { by: 'a' }), /already in triage/);
});

// ---------------------------------------------------------------- the gate

test('approve and reject both refuse a Job that is not waiting for anybody', async () => {
  const j = await mkJob('not waiting');
  await refusal(() => approveJob(db, j.id, { by: 'a' }), /is pending, not suspended/);
  await refusal(() => rejectJob(db, j.id, { note: 'no', by: 'a' }), /is pending, not suspended/);
});

test('a rejection without a reason is refused — it tells the next reader nothing', async () => {
  const j = await mkJob('gated', { phase: 'suspended', gate: 'ok?' });
  await refusal(() => rejectJob(db, j.id, { note: '   ', by: 'a' }), /without a reason/);
  // And the Job is untouched by the refusal.
  assert.equal((await db.job.findUniqueOrThrow({ where: { id: j.id } })).phase, 'suspended');
});

test('the approval IS the event, and it carries the words the resumed session will be given', async () => {
  const j = await mkJob('gated ok', { phase: 'suspended', gate: 'ship it?', suspendedFor: 'ship it?' });
  const r = await approveJob(db, j.id, { note: 'yes, but drop the second commit', by: 'yann' });
  assert.equal(r.phase, 'pending');
  const after = await db.job.findUniqueOrThrow({ where: { id: j.id } });
  assert.equal(after.suspendedFor, null, 'nothing is still waiting on a person');
  const ev = (await events(j.id)).at(-1);
  assert.equal(ev?.kind, 'approved');
  assert.equal(ev?.actor, 'yann');
  assert.deepEqual(ev?.payload, { note: 'yes, but drop the second commit' });
});

// ---------------------------------------------------------------- retry

test('retry refuses a spent budget under the same cap — same run, same wall, same bill', async () => {
  const j = await mkJob('expensive', { phase: 'failed', maxBudgetUsd: 2 });
  await db.attempt.create({
    data: {
      jobId: j.id, k: 1, host: 'h', runtime: 'fake', startedAt: new Date(), endedAt: new Date(),
      outcome: 'max_budget', maxBudgetUsd: 2,
    },
  });
  await refusal(() => retryJob(db, j.id, { by: 'a' }), /stops in the same place, at the same price/);
  await refusal(() => retryJob(db, j.id, { maxBudgetUsd: 2, by: 'a' }), /--max-budget 4\.00/);

  // A bigger cap buys something, so it is allowed, and the raise is on the record.
  const r = await retryJob(db, j.id, { maxBudgetUsd: 5, by: 'a' });
  assert.equal(r.phase, 'pending');
  assert.deepEqual(r.raised, { from: 2, to: 5 });
  const ev = (await events(j.id)).at(-1);
  assert.deepEqual(ev?.payload, { was: 'failed', raised: { from: 2, to: 5 }, resume: null },
    'the event spells the raise the way `hkb retry --json` does — one fact, one name');
});

test('retry refuses a Job that is already pending, running, or held', async () => {
  const pending = await mkJob('waiting');
  await refusal(() => retryJob(db, pending.id, { by: 'a' }), /already pending/);

  const ghost = await mkJob('ghost', { phase: 'running' });
  await refusal(() => retryJob(db, ghost.id, { by: 'a' }), /says running with no lease/);

  const held = await mkJob('held', { phase: 'failed' });
  await lease(held.id, 'host/4');
  await refusal(() => retryJob(db, held.id, { by: 'a' }), /leased by host\/4/);
});

test('retry refuses a proposer whose proposal has already been filed', async () => {
  const j = await mkJob('proposer', { phase: 'succeeded', proposes: 'jobs' });
  await db.event.create({ data: { kind: 'applied', jobId: j.id, boardId: board.id, actor: 'ctl' } });
  await refusal(() => retryJob(db, j.id, { by: 'a' }), /would re-run nothing/);
});

// ---------------------------------------------------------------- ended by hand

test('conclude refuses a running Job, and names when the lease lapses on its own', async () => {
  const j = await mkJob('live work');
  await lease(j.id, 'host/7');
  await refusal(
    () => concludeJob(db, j.id, { phase: 'done', reason: 'merged', by: 'a' }),
    /leased by host\/7 — it is running.*hkb down/s,
  );
});

test('conclude refuses what the runtime already concluded, and a restatement of itself', async () => {
  const won = await mkJob('ran fine', { phase: 'succeeded' });
  await refusal(
    () => concludeJob(db, won.id, { phase: 'done', reason: 'x', by: 'a' }),
    /already succeeded — the runtime concluded it/,
  );

  const j = await mkJob('ending');
  await concludeJob(db, j.id, { phase: 'cancelled', reason: 'superseded by #12', by: 'yann' });
  await refusal(
    () => concludeJob(db, j.id, { phase: 'cancelled', reason: 'again', by: 'yann' }),
    /already cancelled — yann said so: superseded by #12/,
  );
});

test('but done and cancelled may restate EACH OTHER, and the log keeps both', async () => {
  // A mistyped verb is easy and the only other escape is deleting the Job — the trap this exists to
  // remove. The correction is another event rather than a rewrite of the first.
  const j = await mkJob('mistyped');
  await concludeJob(db, j.id, { phase: 'cancelled', reason: 'wrong verb', by: 'yann' });
  const r = await concludeJob(db, j.id, { phase: 'done', reason: 'actually it landed', by: 'yann' });
  assert.equal(r.phase, 'done');
  assert.equal(r.from, 'cancelled', 'and the result says where it came from');
  assert.deepEqual((await events(j.id)).map((e) => e.kind), ['cancelled', 'done']);
});

test('conclude needs a reason, because the phase alone answers nothing', async () => {
  const j = await mkJob('unexplained');
  await refusal(() => concludeJob(db, j.id, { phase: 'done', reason: '  ', by: 'a' }), /needs a reason/);
});

test('concluding a Job closes an attempt nobody ever heard from again', async () => {
  // Not cosmetic: `hkb show` renders an open attempt as elapsed-so-far, so a terminal Job would
  // print a duration that climbs for ever.
  const j = await mkJob('abandoned', { phase: 'pending' });
  await db.attempt.create({
    data: { jobId: j.id, k: 1, host: 'h', runtime: 'fake', startedAt: new Date(), maxBudgetUsd: 1 },
  });
  const finished = await db.attempt.create({
    data: {
      jobId: j.id, k: 2, host: 'h', runtime: 'fake', startedAt: new Date(), maxBudgetUsd: 1,
      endedAt: new Date(0), outcome: 'crashed',
    },
  });
  await concludeJob(db, j.id, { phase: 'done', reason: 'landed elsewhere', by: 'yann' });

  const open = await db.attempt.findUniqueOrThrow({ where: { jobId_k: { jobId: j.id, k: 1 } } });
  assert.equal(open.outcome, 'lost');
  assert.match(open.reason ?? '', /was done by yann while this attempt was open/);
  const untouched = await db.attempt.findUniqueOrThrow({ where: { jobId_k: { jobId: j.id, k: 2 } } });
  assert.equal(untouched.outcome, 'crashed', 'a finished attempt is never rewritten');
  assert.equal(untouched.endedAt?.getTime(), finished.endedAt?.getTime());
});

test('a claim landing mid-transition loses the whole thing, not half of it', async () => {
  // `refuseIfLeased` reads and then writes, and a daemon can claim in between. For a phase move
  // that is a stale read the next reconcile sorts out; for these two it is not — `Lease.job` is
  // onDelete: Cascade, so removing a Job silently deletes a lease a worker took a millisecond ago.
  const j = await mkJob('contended');
  // The lease appears after the guard would have read it: the re-check inside the transaction is
  // the only thing standing between here and a deleted lease.
  await lease(j.id, 'host/racer');
  await refusal(() => removeJob(db, j.id, { by: 'a' }), /leased by host\/racer/);
  assert.notEqual(await db.job.findUnique({ where: { id: j.id } }), null, 'the Job is still there');
  assert.notEqual(await db.lease.findUnique({ where: { jobId: j.id } }), null, 'and so is the lease');
});

// ---------------------------------------------------------------- gone

test('remove refuses a running Job, and the record of the deletion outlives the row', async () => {
  const live = await mkJob('running');
  await lease(live.id, 'host/2');
  await refusal(() => removeJob(db, live.id, { by: 'a' }), /leased by host\/2/);

  const j = await mkJob('mistake');
  const r = await removeJob(db, j.id, { by: 'yann' });
  assert.deepEqual(r, { removed: j.id });
  assert.equal(await db.job.findUnique({ where: { id: j.id } }), null);
  // `jobId` would cascade away with the Job it names, taking the record with it. The board keeps it.
  const kept = await db.event.findFirst({ where: { kind: 'removed', boardId: board.id }, orderBy: { id: 'desc' } });
  assert.deepEqual(kept?.payload, { id: j.id, name: 'mistake' });
  assert.equal(kept?.jobId, null);
});
