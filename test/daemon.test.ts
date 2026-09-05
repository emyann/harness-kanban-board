import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

/**
 * The loop, and the two things Phase 4 exists to guarantee:
 *
 *   1. a laptop sleep does not turn a live run into two;
 *   2. `kb down` leaves no lease held.
 *
 * Both are written as refusals. The first asserts a lease is *still there* after a pass that had
 * every clock-based reason to take it; the second asserts a lease is *gone* after a shutdown that
 * could have simply exited and left it. Neither would fail if the daemon merely "worked".
 */

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hkb-daemon-'));
process.env.HKB_DATABASE_URL = `file:${path.join(dir, 'test.db')}`;
const REPO = path.resolve(import.meta.dirname, '..');
execFileSync(process.execPath, ['node_modules/prisma/build/index.js', 'migrate', 'deploy'], {
  cwd: REPO, env: process.env, stdio: 'ignore',
});

const { openBoard, closeBoard } = await import('../src/db.ts');
const { reconcile } = await import('../src/controller.ts');
const { fakeRuntime } = await import('../src/runtime/fake.ts');
const { holderId } = await import('../src/liveness.ts');
const daemon = await import('../src/daemon.ts');

const db = openBoard();
const HERE = os.hostname();

/**
 * A second, throwaway repository — the whole point of `Board.repoPath`. A machine-level daemon has
 * no meaningful cwd of its own, so "which checkout does this Job run in" has to be a fact on the
 * board, and the way to prove it is a board pointing somewhere the daemon has never stood.
 */
const elsewhere = path.join(dir, 'elsewhere');
fs.mkdirSync(elsewhere);
const git = (args: string[]) => spawnSync('git', args, { cwd: elsewhere, encoding: 'utf8' });
git(['init', '-q', '-b', 'main']);
git(['config', 'user.email', 'e@test']);
git(['config', 'user.name', 'e']);
fs.writeFileSync(path.join(elsewhere, 'ELSEWHERE.md'), '# a different repository\n');
git(['add', '-A']);
git(['commit', '-qm', 'base']);

test.after(async () => { await closeBoard(); fs.rmSync(dir, { recursive: true, force: true }); });

// A controller row is daemon state, not board state: it outlives the test that made it and every
// holder here shares this process's pid, so without this each leadership test inherits the last
// one's leases. (Phase 3's lesson, one table over.)
test.beforeEach(async () => { await db.controller.deleteMany({}); });

// Phase 3's lesson: a shared board leaks state between tests the moment one of them fails.
let n = 0;
const freshBoard = () => db.board.upsert({
  where: { slug: `d${++n}` }, update: {}, create: { slug: `d${n}` },
});
const mkJob = (boardId: number, extra: Record<string, unknown> = {}) =>
  db.job.create({ data: { boardId, name: `job${n}`, brief: 'do a thing', isolate: false, ...extra } });

// ---------------------------------------------------------------- the sleep

test('a lapsed lease whose holder is still running is NOT reclaimed', async () => {
  const board = await freshBoard();
  const job = await mkJob(board.id);
  // Exactly the state a laptop sleep leaves behind: the wall clock says this expired an hour ago,
  // and the process holding it is right here, still working, with twenty-five monotonic minutes
  // left on its own timer.
  await db.lease.create({
    data: {
      jobId: job.id,
      holder: holderId('claude', process.pid, HERE),
      token: 'live',
      expiresAt: new Date(Date.now() - 60 * 60_000),
    },
  });
  await db.job.update({ where: { id: job.id }, data: { phase: 'running' } });
  await db.attempt.create({ data: { jobId: job.id, k: 1, host: 'me', runtime: 'fake' } });

  const report = await reconcile({ runtime: fakeRuntime(), cwd: REPO, board: board.slug, readPr: false });

  assert.deepEqual(report.reclaimed, [], 'nothing was reclaimed');
  assert.ok(await db.lease.findUnique({ where: { jobId: job.id } }), 'the lease is still held');
  const attempt = await db.attempt.findUniqueOrThrow({ where: { jobId_k: { jobId: job.id, k: 1 } } });
  assert.equal(attempt.outcome, null, 'the live attempt was not marked lost');
  assert.equal((await db.job.findUniqueOrThrow({ where: { id: job.id } })).phase, 'running');
});

test('a lapsed lease whose holder has exited IS reclaimed, without waiting any longer', async () => {
  const board = await freshBoard();
  const job = await mkJob(board.id);
  const done = spawnSync(process.execPath, ['-e', '0']);
  await db.lease.create({
    data: {
      jobId: job.id,
      holder: holderId('claude', done.pid as number, HERE),
      token: 'dead',
      expiresAt: new Date(Date.now() - 60_000),
    },
  });
  await db.job.update({ where: { id: job.id }, data: { phase: 'running' } });
  await db.attempt.create({ data: { jobId: job.id, k: 1, host: 'gone', runtime: 'fake' } });

  const report = await reconcile({ runtime: fakeRuntime(), cwd: REPO, board: board.slug, readPr: false });
  assert.deepEqual(report.reclaimed, [job.id]);
  assert.equal(await db.lease.findUnique({ where: { jobId: job.id } }), null);
  const attempt = await db.attempt.findUniqueOrThrow({ where: { jobId_k: { jobId: job.id, k: 1 } } });
  assert.equal(attempt.outcome, 'lost');
});

test('a holder on another machine is left to the clock, and the clock says take it', async () => {
  const board = await freshBoard();
  const job = await mkJob(board.id);
  await db.lease.create({
    data: {
      jobId: job.id,
      holder: holderId('claude', 4242, 'some-other-laptop'),
      token: 'remote',
      expiresAt: new Date(Date.now() - 60_000),
    },
  });
  await db.job.update({ where: { id: job.id }, data: { phase: 'running' } });
  const report = await reconcile({ runtime: fakeRuntime(), cwd: REPO, board: board.slug, readPr: false });
  assert.deepEqual(report.reclaimed, [job.id], 'we cannot see that host, so expiry is all there is');
});

test('reclaim: false leaves even a provably dead holder alone — the pass after a resume', async () => {
  const board = await freshBoard();
  const job = await mkJob(board.id);
  const done = spawnSync(process.execPath, ['-e', '0']);
  await db.lease.create({
    data: {
      jobId: job.id, holder: holderId('claude', done.pid as number, HERE),
      token: 'dead', expiresAt: new Date(Date.now() - 60_000),
    },
  });
  await db.job.update({ where: { id: job.id }, data: { phase: 'running' } });

  const skipped = await reconcile({ runtime: fakeRuntime(), cwd: REPO, board: board.slug, readPr: false, reclaim: false });
  assert.deepEqual(skipped.reclaimed, []);
  assert.ok(await db.lease.findUnique({ where: { jobId: job.id } }), 'held through the woke pass');

  const next = await reconcile({ runtime: fakeRuntime(), cwd: REPO, board: board.slug, readPr: false });
  assert.deepEqual(next.reclaimed, [job.id], 'and taken on the very next one');
});

// ---------------------------------------------------------------- the shutdown

test('a shutdown mid-run releases the lease, and records a stop rather than a failure', async () => {
  const board = await freshBoard();
  const job = await mkJob(board.id, { maxRetries: 0 });
  const stopper = new AbortController();
  // maxRetries 0 is the sharp version: one attempt is all this Job is allowed. If a stop spends
  // it, the Job is `failed` and unrunnable, having never once failed at anything.
  const run = reconcile({
    runtime: fakeRuntime({ delayMs: 30_000 }), cwd: REPO, board: board.slug, readPr: false,
    signal: stopper.signal,
  });
  await new Promise((r) => setTimeout(r, 150));
  stopper.abort();
  const report = await run;

  assert.deepEqual(report.stopped, [job.id]);
  assert.equal(await db.lease.findUnique({ where: { jobId: job.id } }), null,
    'a stop that leaves the lease held is not a stop — the Job would be unclaimable until it expired');
  const after = await db.job.findUniqueOrThrow({ where: { id: job.id }, include: { attempts: true } });
  assert.equal(after.phase, 'pending', 'ready to go again, not out of retries');
  assert.equal(after.attempts[0].outcome, 'stopped');
  assert.ok(after.lastSessionId, 'the session is kept, so `kb up` resumes rather than restarts');
});

test('a stopped attempt does not spend a retry: the Job still runs to completion afterwards', async () => {
  const board = await freshBoard();
  const job = await mkJob(board.id, { maxRetries: 0 });
  const stopper = new AbortController();
  const run = reconcile({
    runtime: fakeRuntime({ delayMs: 30_000 }), cwd: REPO, board: board.slug, readPr: false,
    signal: stopper.signal,
  });
  await new Promise((r) => setTimeout(r, 150));
  stopper.abort();
  await run;

  await reconcile({ runtime: fakeRuntime(), cwd: REPO, board: board.slug, readPr: false });
  const after = await db.job.findUniqueOrThrow({ where: { id: job.id }, include: { attempts: { orderBy: { k: 'asc' } } } });
  assert.equal(after.phase, 'succeeded');
  assert.equal(after.attempts.length, 2, 'k still advanced — it is half a primary key');
  assert.deepEqual(after.attempts.map((a) => a.outcome), ['stopped', 'completed']);
});

test('a shutdown claims nothing new', async () => {
  const board = await freshBoard();
  const a = await mkJob(board.id);
  const b = await mkJob(board.id);
  await db.board.update({ where: { id: board.id }, data: { maxConcurrent: 5 } });
  const stopper = new AbortController();
  stopper.abort();
  const report = await reconcile({
    runtime: fakeRuntime(), cwd: REPO, board: board.slug, readPr: false, signal: stopper.signal,
  });
  assert.deepEqual(report.claimed, [], 'already stopping when the pass began');
  for (const j of [a, b]) {
    assert.equal((await db.job.findUniqueOrThrow({ where: { id: j.id } })).phase, 'pending');
  }
});

// ---------------------------------------------------------------- the loop

test('the loop ticks, then stops when asked, and both ends are on the record', async () => {
  const board = await freshBoard();
  await mkJob(board.id);
  const stopper = new AbortController();
  const lines: string[] = [];
  const ticks = await daemon.loop({
    runtime: fakeRuntime(), cwd: REPO, board: board.slug, intervalMs: 5,
    signal: stopper.signal, maxTicks: 3, log: (l) => lines.push(l),
  });
  assert.equal(ticks, 3);
  const kinds = (await db.event.findMany({ where: { boardId: board.id }, orderBy: { id: 'asc' } })).map((e) => e.kind);
  assert.equal(kinds[0], 'daemon_up');
  assert.equal(kinds.at(-1), 'daemon_down');
  assert.ok(kinds.includes('completed'), 'the Job on the board was actually run by the loop');
});

test('the loop notices the wall clock jumped, and skips reclaim for exactly that pass', async () => {
  const board = await freshBoard();
  const job = await mkJob(board.id);
  // The whole story, in order: a worker holds a good lease with ten minutes left on it; the
  // machine sleeps for an hour; the loop wakes to find it long expired. The holder is *provably*
  // dead here (a real pid that really exited), so nothing but the suspend detection can save this
  // lease — which is the point. On the pass after a resume every lease on the board looks expired
  // at once, and not one of them expired for a reason anybody chose.
  let clock = Date.now();
  const done = spawnSync(process.execPath, ['-e', '0']);
  await db.lease.create({
    data: {
      jobId: job.id, holder: holderId('claude', done.pid as number, HERE),
      token: 'dead', expiresAt: new Date(clock + 10 * 60_000),
    },
  });
  await db.job.update({ where: { id: job.id }, data: { phase: 'running' } });

  // The suspend, where a suspend actually happens: in the wait between ticks. Once only — the
  // third tick is an ordinary one, and is what proves the skip was for that pass and not for ever.
  let slept = false;
  const stopper = new AbortController();
  const lines: string[] = [];
  const held: boolean[] = [];
  await daemon.loop({
    runtime: fakeRuntime(), cwd: REPO, board: board.slug, intervalMs: 5,
    signal: stopper.signal, maxTicks: 3, log: (l) => lines.push(l),
    now: () => clock,
    sleep: async () => {
      held.push(!!(await db.lease.findUnique({ where: { jobId: job.id } })));
      if (!slept) { slept = true; clock += 60 * 60_000; }
    },
  });

  assert.ok(lines.some((l) => l.startsWith('woke —')), `expected a woke line, got:\n${lines.join('\n')}`);
  assert.deepEqual(held, [true, true], 'held through the tick before the sleep AND the tick after it');
  const woke = await db.event.findFirst({ where: { boardId: board.id, kind: 'woke' } });
  assert.ok(woke, 'and it is on the record, because an unexplained gap in a log is a bug report');
  assert.equal(await db.lease.findUnique({ where: { jobId: job.id } }), null,
    'the third tick is ordinary, and a dead holder does not keep a lease for ever');
});

test('a tick that throws does not take the loop with it', async () => {
  const board = await freshBoard();
  await mkJob(board.id);
  const stopper = new AbortController();
  const lines: string[] = [];
  let calls = 0;
  const exploding = {
    name: 'exploding',
    run: async () => { calls++; throw new Error('the runtime fell over'); },
  };
  const ticks = await daemon.loop({
    runtime: exploding as never, cwd: REPO, board: board.slug, intervalMs: 5,
    signal: stopper.signal, maxTicks: 2, log: (l) => lines.push(l),
  });
  assert.equal(ticks, 2, 'the next tick is 45 seconds away and may well succeed');
  assert.ok(calls >= 1);
});

// ---------------------------------------------------------------- leadership

test('a board with no controller row has no daemon', async () => {
  const board = await freshBoard();
  const [s] = await daemon.status(board.slug);
  assert.equal(s.running, false);
  assert.equal(s.stale, false);
  assert.equal(s.holder, null);
});

test('the second daemon does not get the board, and that is a normal outcome', async () => {
  const board = await freshBoard();
  const now = () => new Date();
  const first = await daemon.acquireBoard(db, board.id, holderId('daemon', process.pid, HERE), 1000, 'v1', now);
  const second = await daemon.acquireBoard(db, board.id, holderId('daemon', process.pid + 1, HERE), 1000, 'v1', now);
  assert.equal(first, true);
  assert.equal(second, false, 'the insert is the compare-and-swap; losing is not an error');
  assert.equal((await db.controller.findUniqueOrThrow({ where: { boardId: board.id } })).version, 'v1');
});

test('the same daemon renewing keeps the board and pushes its expiry out', async () => {
  const board = await freshBoard();
  const me = holderId('daemon', process.pid, HERE);
  const t0 = new Date('2026-09-05T10:00:00Z');
  await daemon.acquireBoard(db, board.id, me, 1000, 'v1', () => t0);
  const first = await db.controller.findUniqueOrThrow({ where: { boardId: board.id } });
  const t1 = new Date('2026-09-05T10:01:00Z');
  assert.equal(await daemon.acquireBoard(db, board.id, me, 1000, 'v1', () => t1), true);
  const after = await db.controller.findUniqueOrThrow({ where: { boardId: board.id } });
  assert.ok(after.expiresAt > first.expiresAt, 'renewed, not re-taken');
  assert.deepEqual(after.startedAt, first.startedAt, 'and it is still the same daemon');
});

test('a board led by a dead process is taken over without waiting for the clock', async () => {
  const board = await freshBoard();
  const done = spawnSync(process.execPath, ['-e', '0']);
  const ghost = holderId('daemon', done.pid as number, HERE);
  const far = new Date(Date.now() + 60 * 60_000);
  await db.controller.create({
    data: { boardId: board.id, holder: ghost, intervalMs: 1000, version: 'v0', expiresAt: far },
  });
  assert.equal(daemon.controllerIsLive({ ...(await db.controller.findUniqueOrThrow({ where: { boardId: board.id } })) } as never), false,
    'its lease has an hour left, and its process does not exist');

  const me = holderId('daemon', process.pid, HERE);
  assert.equal(await daemon.acquireBoard(db, board.id, me, 1000, 'v1', () => new Date()), true);
  assert.equal((await db.controller.findUniqueOrThrow({ where: { boardId: board.id } })).holder, me);
});

test('a board led from another machine is left alone until its lease lapses', async () => {
  const board = await freshBoard();
  const elsewhere = holderId('daemon', 4242, 'some-other-laptop');
  await db.controller.create({
    data: {
      boardId: board.id, holder: elsewhere, intervalMs: 1000, version: 'v0',
      expiresAt: new Date(Date.now() + 60 * 60_000),
    },
  });
  const me = holderId('daemon', process.pid, HERE);
  assert.equal(await daemon.acquireBoard(db, board.id, me, 1000, 'v1', () => new Date()), false,
    'we cannot see that host, so the clock is all there is — and it says the lease is good');

  await db.controller.update({
    where: { boardId: board.id }, data: { expiresAt: new Date(Date.now() - 1000) },
  });
  assert.equal(await daemon.acquireBoard(db, board.id, me, 1000, 'v1', () => new Date()), true, 'lapsed, so takeover');
});

test('status says a daemon is behind when the checkout has moved past it', async () => {
  const board = await freshBoard();
  await daemon.acquireBoard(db, board.id, holderId('daemon', process.pid, HERE), 1000, 'deadbee', () => new Date());
  const [s] = await daemon.status(board.slug);
  assert.equal(s.running, true);
  assert.equal(s.version, 'deadbee');
  assert.equal(s.behind, daemon.buildVersion(), 'a daemon quietly serving old code is a line you can read');
});

test('status does not cry stale for a daemon running this build', async () => {
  const board = await freshBoard();
  await daemon.acquireBoard(db, board.id, holderId('daemon', process.pid, HERE), 1000, daemon.buildVersion(), () => new Date());
  const [s] = await daemon.status(board.slug);
  assert.equal(s.behind, null);
});

test('releasing gives up every board this daemon led, and only those', async () => {
  const a = await freshBoard();
  const b = await freshBoard();
  const me = holderId('daemon', process.pid, HERE);
  const other = holderId('daemon', process.pid + 1, HERE);
  const now = () => new Date();
  await daemon.acquireBoard(db, a.id, me, 1000, 'v', now);
  await daemon.acquireBoard(db, b.id, other, 1000, 'v', now);
  assert.equal(await daemon.releaseBoards(db, me), 1);
  assert.equal(await db.controller.findUnique({ where: { boardId: a.id } }), null);
  assert.ok(await db.controller.findUnique({ where: { boardId: b.id } }), 'not ours to release');
});

test('kb down with nothing to stop is a fact, not an error story', async () => {
  const res = await daemon.stop({ board: (await freshBoard()).slug });
  assert.equal(res.stopped, false);
  assert.equal(res.why, 'no daemon running');
});

test('kb down clears a controller row whose daemon is gone', async () => {
  const board = await freshBoard();
  const done = spawnSync(process.execPath, ['-e', '0']);
  await db.controller.create({
    data: {
      boardId: board.id, holder: holderId('daemon', done.pid as number, HERE),
      intervalMs: 1000, version: 'v', expiresAt: new Date(Date.now() + 3600_000),
    },
  });
  const res = await daemon.stop({ board: board.slug });
  assert.equal(res.stopped, false);
  assert.match(res.why as string, /stale/);
  assert.equal(await db.controller.findUnique({ where: { boardId: board.id } }), null);
});

test('kb down refuses to reach across the network at a daemon on another machine', async () => {
  const board = await freshBoard();
  await db.controller.create({
    data: {
      boardId: board.id, holder: holderId('daemon', 4242, 'some-other-laptop'),
      intervalMs: 1000, version: 'v', expiresAt: new Date(Date.now() + 3600_000),
    },
  });
  const res = await daemon.stop({ board: board.slug });
  assert.equal(res.stopped, false);
  assert.match(res.why as string, /another machine/);
  await db.controller.deleteMany({ where: { boardId: board.id } });
});

// ---------------------------------------------------------------- many boards, one daemon

test('one daemon serves every board, the way one controller-manager serves every namespace', async () => {
  const a = await freshBoard();
  const b = await freshBoard();
  await mkJob(a.id);
  await mkJob(b.id);
  const stopper = new AbortController();
  const lines: string[] = [];
  await daemon.loop({
    runtime: fakeRuntime(), cwd: REPO, intervalMs: 5,
    signal: stopper.signal, maxTicks: 2, log: (l) => lines.push(l),
  });
  for (const board of [a, b]) {
    const jobs = await db.job.findMany({ where: { boardId: board.id } });
    assert.ok(jobs.every((j) => j.phase === 'succeeded'), `${board.slug} was served`);
    const kinds = (await db.event.findMany({ where: { boardId: board.id } })).map((e) => e.kind);
    assert.ok(kinds.includes('daemon_up'), `${board.slug} recorded the daemon taking it`);
    assert.ok(kinds.includes('daemon_down'), `${board.slug} recorded it letting go`);
  }
  assert.ok(lines.some((l) => l.includes(`[${a.slug}]`)), 'lines say which board they came from');
  assert.equal(await db.controller.count(), 0, 'and it let go of both on the way out');
});

test('a board created after the daemon started is picked up without a restart', async () => {
  const stopper = new AbortController();
  let later: { id: number; slug: string } | null = null;
  await daemon.loop({
    runtime: fakeRuntime(), cwd: REPO, intervalMs: 5,
    signal: stopper.signal, maxTicks: 2, log: () => {},
    sleep: async () => {
      if (later) return;
      later = await freshBoard();
      await mkJob(later.id);
    },
  });
  const jobs = await db.job.findMany({ where: { boardId: later!.id } });
  assert.ok(jobs.length && jobs.every((j) => j.phase === 'succeeded'),
    'a controller re-reads the world; only a launcher needs restarting');
});

test('the Job runs in the repository its BOARD names, not wherever the daemon started', async () => {
  // The reason `repoPath` exists: a machine-level daemon has no meaningful cwd of its own.
  const board = await db.board.create({
    data: { slug: `repo${++n}`, repoPath: elsewhere },
  });
  const job = await db.job.create({
    data: { boardId: board.id, name: 'in its own repo', brief: 'x', isolate: true, maxRetries: 0 },
  });
  await reconcile({ runtime: fakeRuntime(), cwd: REPO, board: board.slug, readPr: false });
  const after = await db.job.findUniqueOrThrow({ where: { id: job.id }, include: { attempts: true } });
  assert.equal(after.attempts[0].branch, `kb-${job.id}-1`);
  assert.ok(fs.existsSync(path.join(elsewhere, 'ELSEWHERE.md')),
    'sanity: the other repository is the one with this file in it');
  const wt = path.join(elsewhere, '.kanban', 'worktrees');
  assert.equal(fs.existsSync(path.join(REPO, '.kanban', 'worktrees', `kb-${job.id}-1`)), false,
    'and no worktree was cut in the daemon-cwd repository');
  void wt;
});
