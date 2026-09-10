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
 * A throwaway repository for the one test here that isolates.
 *
 * It used to cut that worktree in the checkout you are working in, and leave it: the test does
 * clean up after itself, but it also writes an untracked `wip.txt` to model a half-finished
 * attempt, so `removeWorktree` correctly refuses a tree that still holds work and 5.3 MB stayed
 * behind on every run. Nothing about the behaviour under test needs it to be *this* repository,
 * and a test suite has no business writing into the tree it is being run from.
 */
const SCRATCH = path.join(dir, 'scratch-repo');
fs.mkdirSync(SCRATCH);
{
  const git = (...a: string[]) => execFileSync('git', a, { cwd: SCRATCH, stdio: 'ignore' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 's@test');
  git('config', 'user.name', 's');
  fs.writeFileSync(path.join(SCRATCH, 'README.md'), '# scratch\n');
  git('add', '-A');
  git('commit', '-qm', 'base');
}

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
    data: { jobId: spent.id, k: 1, startedAt: new Date(), endedAt: new Date(), outcome: 'completed', costUsd: 4, maxBudgetUsd: 4 , attemptDeadlineSeconds: 1800},
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
    data: { jobId: old.id, k: 1, startedAt: longAgo, endedAt: longAgo, outcome: 'completed', costUsd: 99, maxBudgetUsd: 99 , attemptDeadlineSeconds: 1800},
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

// ---------------------------------------------------------------- maxConcurrent means it

/**
 * A runtime that blocks until it is released, and says when it started.
 *
 * This is the only shape that can tell real parallelism from a fast serial loop: with runs that
 * return immediately, "two Jobs ran" is true either way. Holding both open and then asking the
 * database how many leases exist asks the question the operator is actually asking.
 */
function blocking() {
  const started: number[] = [];
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const arrived: Array<() => void> = [];
  const waitFor = (n: number) => new Promise<void>((r) => {
    const check = () => { if (started.length >= n) r(); else arrived.push(check); };
    check();
  });
  return {
    started,
    release,
    waitFor,
    runtime: {
      name: 'blocking',
      async run(spec: { taskId: number }) {
        started.push(spec.taskId);
        for (const f of arrived.splice(0)) f();
        await gate;
        return { status: 'completed', ok: true, sessionId: `s-${spec.taskId}`, text: '', costUsd: 0,
                 turns: 1, durationMs: 0, stopReason: 'end_turn', denials: 0, error: null };
      },
    },
  };
}

test('maxConcurrent 2 runs two Jobs at once — both hold a lease at the same time', async () => {
  const b = await freshBoard();
  await b.set({ maxConcurrent: 2 });
  const one = await b.job('first');
  const two = await b.job('second');

  const w = blocking();
  const pass = b.run({ runtime: w.runtime });

  // Both must be inside their run before anything is released. If the loop were still awaiting each
  // run in turn, this would time the test out rather than fail it — which is the honest signal.
  await w.waitFor(2);
  const heldTogether = await db.lease.findMany({
    where: { job: { boardId: b.id } }, select: { jobId: true }, orderBy: { jobId: 'asc' },
  });
  assert.deepEqual(heldTogether.map((l) => l.jobId), [one.id, two.id],
    'two leases at the same instant — the ceiling is a real parallelism setting, not a spelling of 1');

  w.release();
  const r = await pass;
  assert.deepEqual(r.succeeded, [one.id, two.id], 'and the pass does not return until both are recorded');
  assert.deepEqual(w.started, [one.id, two.id]);
  assert.equal(await db.lease.count({ where: { job: { boardId: b.id } } }), 0, 'both released');
});

test('a third Job is refused while two of two slots are held by another host', async () => {
  const b = await freshBoard();
  await b.set({ maxConcurrent: 2 });
  // Somebody else's two runs, so the refusal is contention this pass did not cause: a wall of our
  // own making is waited out instead, which the test above is what proves.
  const held = [await b.job('theirs-1'), await b.job('theirs-2')];
  for (const j of held) {
    await db.lease.create({
      data: { jobId: j.id, holder: 'another-host', token: `t${j.id}`, expiresAt: new Date(Date.now() + 600_000) },
    });
    await db.job.update({ where: { id: j.id }, data: { phase: 'running' } });
  }
  const third = await b.job('mine');

  const r = await b.run();
  assert.match(r.refused ?? '', /2 of 2 concurrent slots/);
  assert.deepEqual(r.claimed, [], 'a third does not squeeze in');
  assert.equal(await db.attempt.count({ where: { jobId: third.id } }), 0);
  assert.equal(await db.lease.count({ where: { job: { boardId: b.id } } }), 2, 'and their leases are untouched');
});

test('more Jobs than slots: a pass waits for one of its own to finish rather than refusing', async () => {
  const b = await freshBoard();
  await b.set({ maxConcurrent: 2 });
  const ids = [await b.job('a'), await b.job('b'), await b.job('c')].map((j) => j.id);

  // Never more than two inside `run` at once, and all three get their turn in one pass.
  let live = 0;
  let peak = 0;
  const staggered = {
    name: 'staggered',
    async run(spec: { taskId: number }) {
      live += 1;
      peak = Math.max(peak, live);
      await new Promise((r) => setTimeout(r, 30));
      live -= 1;
      return { status: 'completed', ok: true, sessionId: `s-${spec.taskId}`, text: '', costUsd: 0,
               turns: 1, durationMs: 0, stopReason: 'end_turn', denials: 0, error: null };
    },
  };

  const r = await b.run({ runtime: staggered });
  assert.equal(r.refused, null, 'a ceiling this pass is itself filling is not a refusal to report');
  assert.deepEqual(r.succeeded, ids, 'all three, in one pass');
  assert.equal(peak, 2, 'and never three at once');
});

test('the budget ceiling counts runs in flight, so two concurrent Jobs cannot both blow it', async () => {
  const b = await freshBoard();
  await b.set({ maxConcurrent: 3, dailyBudgetUsd: 10 });
  const ids = [await b.job('pricey-1', { maxBudgetUsd: 6 }), await b.job('pricey-2', { maxBudgetUsd: 6 })]
    .map((j) => j.id);

  const w = blocking();
  const pass = b.run({ runtime: w.runtime });
  await w.waitFor(1);
  // The first is running and has reported no cost yet, so its $6 is still only promised. Three
  // slots are free, and the ONLY thing that may stop the second $6 Job is the money — $12 against
  // a $10 ceiling. Before `committedUsd` it would have been waved through against a $0 spend.
  await new Promise((r) => setTimeout(r, 60));
  assert.deepEqual(w.started, [ids[0]], 'the second is held back by the budget, not by a free slot');

  w.release();
  const r = await pass;
  // Held back, not refused: the first run's real cost replaces its projection, and the pass then
  // has room. Refusing would have blamed the operator for a wall this pass was building itself.
  assert.deepEqual(r.succeeded, ids, 'both ran in the end — one after the other');
  assert.equal(r.refused, null);
});

test('money promised to ANOTHER host\'s run in flight refuses, and names it', async () => {
  const b = await freshBoard();
  await b.set({ dailyBudgetUsd: 10, maxConcurrent: 5 });
  // Their attempt is open, so it has reported no cost — but its Job may still cost $6.
  const theirs = await b.job('theirs', { maxBudgetUsd: 6 });
  // The cap is on the ATTEMPT, frozen when another host claimed it — that is the number this gate
  // charges, and it is why the refusal below can name $6 without re-resolving anyone's spec.
  await db.attempt.create({ data: { jobId: theirs.id, k: 1, host: 'another-host', maxBudgetUsd: 6 , attemptDeadlineSeconds: 1800} });
  await db.job.update({ where: { id: theirs.id }, data: { phase: 'running' } });

  const mine = await b.job('mine', { maxBudgetUsd: 6 });
  const r = await b.run();
  assert.match(r.refused ?? '', /\$6\.00 committed to runs in flight/);
  assert.match(r.refused ?? '', /wait for a run to finish/, 'an error says what to do next');
  assert.equal(await db.attempt.count({ where: { jobId: mine.id } }), 0, 'no money was spent finding out');
});

test('a shutdown mid-pass stops every run, not just one, and none of them spends a retry', async () => {
  const b = await freshBoard();
  await b.set({ maxConcurrent: 2 });
  const ids = [await b.job('long-1', { maxRetries: 0 }), await b.job('long-2', { maxRetries: 0 })]
    .map((j) => j.id);

  const ac = new AbortController();
  const started: number[] = [];
  const interruptible = {
    name: 'interruptible',
    async run(spec: { taskId: number; signal?: AbortSignal }) {
      started.push(spec.taskId);
      await new Promise<void>((r) => spec.signal?.addEventListener('abort', () => r(), { once: true }));
      return { status: 'error', ok: false, sessionId: `s-${spec.taskId}`, text: '', costUsd: 0,
               turns: 1, durationMs: 0, stopReason: null, denials: 0, error: 'interrupted' };
    },
  };

  const pass = b.run({ runtime: interruptible, signal: ac.signal });
  while (started.length < 2) await new Promise((r) => setTimeout(r, 5));
  ac.abort();
  const r = await pass;

  assert.deepEqual(r.stopped, ids, 'both, and `stopped` is the operator, not the work');
  assert.deepEqual(r.failed, [], 'a Job with no retries left is not failed by being turned off');
  for (const id of ids) {
    const after = await db.job.findUniqueOrThrow({ where: { id } });
    assert.equal(after.phase, 'pending', `#${id} is queued again`);
  }
  assert.equal(await db.lease.count({ where: { job: { boardId: b.id } } }), 0, 'and nothing is left held');
});

// ---------------------------------------------------------------- the lease invariant
// These run at the SHIPPED DEFAULTS. The earlier G5 test passed only because it pinned leaseMs
// and forced expiry by hand, so it proved a configuration the product does not ship.

test('the lease outlives the run it covers — a 60-minute Job is not reclaimed at 35', async () => {
  // The rule is `attemptDeadlineSeconds + LEASE_GRACE_MS`, and the failure it prevents is a long
  // Job having its lease expire WHILE ALIVE: another host would then reclaim a run that is still
  // going. The old version of this test asserted `x + grace > x`, which is true of every number.
  //
  // Read while the lease is HELD, because that is the only moment the row exists.
  const b = await freshBoard();
  const job = await b.job('long-runner', { attemptDeadlineSeconds: 3600 });
  const grace = 5 * 60_000;
  let held: { expiresAt: Date; acquiredAt: Date } | null = null;
  const watching = {
    name: 'watching',
    async run() {
      held = await db.lease.findUnique({ where: { jobId: job.id } });
      return { status: 'completed', ok: true, sessionId: 's', text: '', costUsd: 0, turns: 1,
               durationMs: 0, stopReason: 'end_turn', denials: 0, error: null };
    },
  };
  await reconcile({ runtime: watching, cwd: REPO, board: b.slug, readPr: false });

  assert.ok(held, 'a lease is held while the run is in flight');
  const life = held!.expiresAt.getTime() - held!.acquiredAt.getTime();
  assert.equal(life, 3600 * 1000 + grace, 'the lease is the attempt clock plus the grace, in ms');
  assert.ok(life > 35 * 60_000, 'so a 60-minute run is not reclaimed at 35 minutes');

  // And the clock the lease was derived from is frozen on the attempt, in seconds.
  const attempt = await db.attempt.findFirstOrThrow({ where: { jobId: job.id } });
  assert.equal(attempt.attemptDeadlineSeconds, 3600);
});

test('a Job that named no attempt clock is leased on the built-in, not on nothing', async () => {
  const b = await freshBoard();
  const job = await b.job('defaulted');
  await b.run();
  const attempt = await db.attempt.findFirstOrThrow({ where: { jobId: job.id } });
  assert.equal(attempt.attemptDeadlineSeconds, 1800, 'the built-in, resolved and frozen');
  const fresh = await db.job.findUniqueOrThrow({ where: { id: job.id } });
  assert.equal(fresh.attemptDeadlineSeconds, null, 'and the column stays null, so a board default can still answer');
});

test('a lease is renewed while the run is in flight, and renewedAt gets a writer', async () => {
  const b = await freshBoard();
  const job = await b.job('renewed');
  // A short lease so the renewer (leaseMs/3) fires during a short fake run.
  let seen = { renewed: false };
  const slow = {
    name: 'slow',
    async run() {
      await new Promise((r) => setTimeout(r, 1600));
      const l = await db.lease.findUnique({ where: { jobId: job.id } });
      seen.renewed = !!l?.renewedAt && l.renewedAt.getTime() > l.acquiredAt.getTime();
      return { status: 'completed', ok: true, sessionId: 's', text: '', costUsd: 0, turns: 1,
               durationMs: 0, stopReason: 'end_turn', denials: 0, error: null };
    },
  };
  await reconcile({ runtime: slow, cwd: REPO, board: b.slug, readPr: false, leaseMs: 3_000 });
  assert.equal(seen.renewed, true, 'renewedAt is written during the run, not left null forever');
});

test('a holder that lost its lease does not overwrite the new holder', async () => {
  const b = await freshBoard();
  const job = await b.job('stolen');

  // Mid-run, somebody else takes the lease. The original must record its own attempt and stop.
  const thief = {
    name: 'thief',
    async run() {
      await db.lease.deleteMany({ where: { jobId: job.id } });
      await db.lease.create({
        data: { jobId: job.id, holder: 'new-holder', token: 'other', expiresAt: new Date(Date.now() + 600_000) },
      });
      return { status: 'completed', ok: true, sessionId: 's', text: '', costUsd: 0, turns: 1,
               durationMs: 0, stopReason: 'end_turn', denials: 0, error: null };
    },
  };
  const r = await reconcile({ runtime: thief, cwd: REPO, board: b.slug, readPr: false });

  assert.ok(r.skipped.includes(job.id), 'the displaced holder skips rather than writing');
  assert.deepEqual(r.succeeded, [], 'and does NOT report success on a Job it no longer holds');
  const after = await db.job.findUniqueOrThrow({ where: { id: job.id } });
  assert.equal(after.phase, 'running', 'the Job is left exactly as the new holder found it');
  const stillTheirs = await db.lease.findUniqueOrThrow({ where: { jobId: job.id } });
  assert.equal(stillTheirs.token, 'other', "the new holder's lease survived the old one finishing");
});

test('reclaim does not steal a lease renewed between the read and the delete', async () => {
  const b = await freshBoard();
  const job = await b.job('renewed-just-in-time');
  await db.job.update({ where: { id: job.id }, data: { phase: 'running' } });
  await db.attempt.create({ data: { jobId: job.id, k: 1, host: 'alive', maxBudgetUsd: 1 , attemptDeadlineSeconds: 1800} });
  await db.lease.create({
    data: { jobId: job.id, holder: 'alive', token: 't', expiresAt: new Date(Date.now() - 1000) },
  });

  // The holder renews before the reclaim's delete lands.
  await db.lease.update({
    where: { jobId: job.id },
    data: { renewedAt: new Date(), expiresAt: new Date(Date.now() + 600_000) },
  });

  const r = await b.run();
  assert.deepEqual(r.reclaimed, [], 'a renewed lease is not expired any more');
  const attempt = await db.attempt.findFirstOrThrow({ where: { jobId: job.id, k: 1 } });
  assert.equal(attempt.outcome, null, 'and its live attempt was not marked lost');
});

/** What is in the real repository's worktree directory, so a test can prove it added nothing. */
const worktreesIn = (root: string): string[] => {
  try {
    return fs.readdirSync(path.join(root, '.hkb', 'worktrees')).sort();
  } catch {
    return [];
  }
};

test('a resumable stop keeps the session, and the retry runs in the same checkout', async () => {
  const worktreesBefore = worktreesIn(REPO);
  const b = await freshBoard();
  const job = await b.job('resumes', { isolate: true, maxRetries: 2 });
  const dirs: string[] = [];

  // First attempt hits its turn cap; second completes. Both record where they ran.
  let n = 0;
  const capThenFinish = {
    name: 'cap-then-finish',
    async run(spec: { cwd: string }) {
      dirs.push(spec.cwd);
      n += 1;
      // A worker that runs out of turns has usually done partial work, and that is what keeps its
      // checkout from being swept as clean. A first attempt that did nothing leaves nothing to
      // resume INTO, and a fresh worktree is then equivalent — there is no work to lose.
      if (n === 1) fs.writeFileSync(path.join(spec.cwd, 'wip.txt'), 'partial');
      return n === 1
        ? { status: 'max_turns', ok: false, sessionId: 'sess-1', text: '', costUsd: 0, turns: 1,
            durationMs: 0, stopReason: null, denials: 0, error: null }
        : { status: 'completed', ok: true, sessionId: 'sess-1', text: 'done', costUsd: 0, turns: 2,
            durationMs: 0, stopReason: 'end_turn', denials: 0, error: null };
    },
  };

  await reconcile({ runtime: capThenFinish, cwd: SCRATCH, board: b.slug, readPr: false });
  const mid = await db.job.findUniqueOrThrow({ where: { id: job.id } });
  assert.equal(mid.lastSessionId, 'sess-1', 'a turn cap is resumable, so the session is kept');

  await reconcile({ runtime: capThenFinish, cwd: SCRATCH, board: b.slug, readPr: false });

  assert.equal(dirs.length, 2);
  assert.equal(dirs[1], dirs[0], 'the retry resumed in the SAME checkout, not a fresh one');

  const after = await db.job.findUniqueOrThrow({ where: { id: job.id }, include: { attempts: { orderBy: { k: 'asc' } } } });
  assert.equal(after.phase, 'succeeded');
  assert.equal(after.attempts[1].branch, `kb-${job.id}-1`, 'and on the branch where its PR already is');

  // Left where it is on purpose: it holds the `wip.txt` the first attempt wrote, and
  // `removeWorktree` is right to refuse a tree that still holds work. It goes with the scratch
  // repository when `test.after` removes the whole temp directory.
  const { existingWorktree } = await import('../src/worktree.ts');
  assert.ok(existingWorktree(SCRATCH, job.id, 1), 'and the checkout it resumed into is still there');

  // Compared as a SET, not by name. This used to assert `existingWorktree(REPO, job.id, 1)` was
  // null — but `job.id` comes from a scratch database and the path is in the real repository, and
  // those two numbering schemes are independent. A real `kb-13-1` worktree from an actual Job made
  // a passing test fail for a reason that had nothing to do with it.
  assert.deepEqual(worktreesIn(REPO), worktreesBefore, 'and this test added nothing to the repo under test');
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
    await db.attempt.create({ data: { jobId: ${job.id}, k: 1, host: 'doomed-child', maxBudgetUsd: 1 , attemptDeadlineSeconds: 1800} });
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
    data: { jobId: job.id, k: 1, startedAt: new Date(), endedAt: new Date(), outcome: 'crashed', maxBudgetUsd: 1 , attemptDeadlineSeconds: 1800},
  });
  await db.attempt.create({ data: { jobId: job.id, k: 2, host: 'dead', maxBudgetUsd: 1 , attemptDeadlineSeconds: 1800} });
  await db.job.update({ where: { id: job.id }, data: { phase: 'running' } });
  await db.lease.create({
    data: { jobId: job.id, holder: 'dead', token: 't', expiresAt: new Date(Date.now() - 1000) },
  });

  await b.run();
  assert.equal((await db.job.findUniqueOrThrow({ where: { id: job.id } })).phase, 'failed',
    'a dead holder is not a fresh start');
});
