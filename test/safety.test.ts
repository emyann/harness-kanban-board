import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';

/**
 * G4 and G5: it cannot run away, and killing the machine mid-run loses nothing and double-runs
 * nothing. Both are proved by making the bad thing happen, not by asserting the good path.
 */

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hkb-safety-'));
const DB = `file:${path.join(dir, 'safety.db')}`;
process.env.HKB_DATABASE_URL = DB;
const REPO = path.resolve(import.meta.dirname, '..');
execFileSync(process.execPath, ['node_modules/prisma/build/index.js', 'migrate', 'deploy'], {
  cwd: REPO, env: process.env, stdio: 'ignore',
});

const { openBoard, closeBoard } = await import('../src/db.ts');
const { reconcile } = await import('../src/controller.ts');
const { fakeRuntime } = await import('../src/runtime/fake.ts');
const db = openBoard();

/**
 * One board per test. These tests deliberately leave boards in bad states — stopped, over budget,
 * holding a dead lease — and a shared board makes each failure cascade into the next test as a
 * phantom bug. A namespace per test is what a Namespace is for.
 */
let n = 0;
async function freshBoard() {
  const slug = `safety-${++n}`;
  const board = await db.board.upsert({ where: { slug }, update: {}, create: { slug } });
  return {
    slug,
    id: board.id,
    job: (name: string, extra: Record<string, unknown> = {}) =>
      db.job.create({ data: { boardId: board.id, name, brief: `do ${name}`, isolate: false, ...extra } }),
    set: (data: Record<string, unknown>) => db.board.update({ where: { id: board.id }, data }),
    run: (extra: Record<string, unknown> = {}) =>
      reconcile({ runtime: fakeRuntime(), cwd: REPO, board: slug, readPr: false, ...extra }),
  };
}

test.after(async () => { await closeBoard(); fs.rmSync(dir, { recursive: true, force: true }); });

// ---------------------------------------------------------------- G4: it cannot run away

test('a stopped board claims nothing, and the Job is still there afterwards', async () => {
  const b = await freshBoard();
  const job = await b.job('paused-out');
  await b.set({ pausedAt: new Date(), pausedBy: 'test' });

  const r = await b.run();
  assert.deepEqual(r.claimed, [], 'nothing claimed');
  assert.match(r.refused ?? '', /stopped by test/);
  assert.equal((await db.job.findUniqueOrThrow({ where: { id: job.id } })).phase, 'pending',
    'refusing to start is not the same as failing');
  assert.equal(await db.attempt.count({ where: { jobId: job.id } }), 0, 'and nothing ran');
});

test('a board over its budget refuses to claim, and names the ceiling it hit', async () => {
  const b = await freshBoard();
  const job = await b.job('too-expensive', { maxBudgetUsd: 50 });
  await b.set({ dailyBudgetUsd: 1 });

  const r = await b.run();
  assert.deepEqual(r.claimed, []);
  assert.match(r.refused ?? '', /ceiling/);
  assert.equal(await db.attempt.count({ where: { jobId: job.id } }), 0, 'no money was spent finding out');
});

test('spend already recorded counts against the ceiling', async () => {
  const b = await freshBoard();
  const spent = await b.job('already-spent');
  await db.attempt.create({
    data: { jobId: spent.id, k: 1, startedAt: new Date(), endedAt: new Date(), outcome: 'completed', costUsd: 4 },
  });
  await db.job.update({ where: { id: spent.id }, data: { phase: 'succeeded' } });

  const next = await b.job('the-next-one', { maxBudgetUsd: 2 });
  await b.set({ dailyBudgetUsd: 5 });

  const r = await b.run();
  assert.match(r.refused ?? '', /\$4\.00 spent in 24h/, '4 + 2 > 5');
  assert.equal(await db.attempt.count({ where: { jobId: next.id } }), 0);
});

test('spend outside the rolling window does not count', async () => {
  const b = await freshBoard();
  const old = await b.job('yesterday');
  const longAgo = new Date(Date.now() - 48 * 60 * 60 * 1000);
  await db.attempt.create({
    data: { jobId: old.id, k: 1, startedAt: longAgo, endedAt: longAgo, outcome: 'completed', costUsd: 99 },
  });
  await db.job.update({ where: { id: old.id }, data: { phase: 'succeeded' } });

  const fresh = await b.job('today', { maxBudgetUsd: 1 });
  await b.set({ dailyBudgetUsd: 5 });

  const r = await b.run();
  assert.equal(r.refused, null, '$99 spent two days ago is not this window');
  assert.deepEqual(r.succeeded, [fresh.id]);
});

test('a full board refuses, and the holder keeps its lease', async () => {
  const b = await freshBoard();
  const held = await b.job('held-by-other');
  await db.lease.create({
    data: { jobId: held.id, holder: 'another-host', token: 't', expiresAt: new Date(Date.now() + 600_000) },
  });
  await db.job.update({ where: { id: held.id }, data: { phase: 'running' } });
  const queued = await b.job('waiting');

  const r = await b.run();
  assert.match(r.refused ?? '', /1 of 1 concurrent slots/);
  assert.equal(await db.attempt.count({ where: { jobId: queued.id } }), 0);
  assert.ok(await db.lease.findUnique({ where: { jobId: held.id } }), 'the other holder is untouched');
});

// ---------------------------------------------------------------- G5: a killed process

test('a process killed mid-run is reclaimed, its orphan marked lost, and retried exactly once', async () => {
  const b = await freshBoard();
  const job = await b.job('killed', { maxRetries: 5 });

  // A real child, really killed, holding a real lease — not a lease row faked into the past.
  const script = path.join(dir, 'hang.mjs');
  fs.writeFileSync(script, `
    process.env.HKB_DATABASE_URL = ${JSON.stringify(DB)};
    const { openBoard } = await import(${JSON.stringify(path.join(REPO, 'src/db.ts'))});
    const db = openBoard();
    await db.lease.create({ data: { jobId: ${job.id}, holder: 'doomed-child', token: 'tok',
      expiresAt: new Date(Date.now() + 600000) } });
    await db.job.update({ where: { id: ${job.id} }, data: { phase: 'running' } });
    await db.attempt.create({ data: { jobId: ${job.id}, k: 1, host: 'doomed-child' } });
    process.send?.('claimed');
    await new Promise(() => {});
  `);
  const child = spawn(process.execPath, [script], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  await new Promise((r) => child.once('message', r));
  child.kill('SIGKILL');
  await new Promise((r) => child.once('exit', r));

  // The lease has not expired yet, so a reconcile must NOT steal it — that is the double-run.
  const early = await b.run();
  assert.deepEqual(early.reclaimed, [], 'a live lease is respected even though the holder is dead');
  assert.equal(await db.attempt.count({ where: { jobId: job.id } }), 1, 'no second attempt');

  // Once it expires, exactly one reclaim and exactly one retry.
  await db.lease.update({ where: { jobId: job.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
  const late = await b.run();
  assert.deepEqual(late.reclaimed, [job.id]);

  const after = await db.job.findUniqueOrThrow({ where: { id: job.id }, include: { attempts: { orderBy: { k: 'asc' } } } });
  assert.equal(after.attempts[0].outcome, 'lost', 'nobody ever reported the first one');
  assert.ok(after.attempts[0].endedAt, 'and it is closed, not left open forever');
  assert.equal(after.attempts.length, 2, 'exactly one retry, not two');
  assert.equal(after.phase, 'succeeded', 'and the retry finished the work');
});

test('reclaiming does not resurrect a Job that is out of retries', async () => {
  const b = await freshBoard();
  const job = await b.job('exhausted', { maxRetries: 0 });
  await db.attempt.create({
    data: { jobId: job.id, k: 1, startedAt: new Date(), endedAt: new Date(), outcome: 'crashed' },
  });
  await db.attempt.create({ data: { jobId: job.id, k: 2, host: 'dead' } });
  await db.job.update({ where: { id: job.id }, data: { phase: 'running' } });
  await db.lease.create({
    data: { jobId: job.id, holder: 'dead', token: 't', expiresAt: new Date(Date.now() - 1000) },
  });

  await b.run();
  assert.equal((await db.job.findUniqueOrThrow({ where: { id: job.id } })).phase, 'failed',
    'a dead holder is not a fresh start');
});
