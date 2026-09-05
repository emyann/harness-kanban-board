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

test.after(async () => { await closeBoard(); fs.rmSync(dir, { recursive: true, force: true }); });

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

// ---------------------------------------------------------------- pid files

test('no pid file means no daemon, and says where the log would be', () => {
  const st = daemon.status('nobody-here');
  assert.equal(st.running, false);
  assert.equal(st.stale, false);
  assert.equal(st.daemon, null);
  assert.match(st.log, /kb-nobody-here\.log$/);
  assert.equal(path.dirname(st.pidFile), dir, 'beside the board, not in the real .kanban/');
});

test('a pid file naming a dead process is stale, not running', () => {
  const done = spawnSync(process.execPath, ['-e', '0']);
  fs.writeFileSync(daemon.pidPath('ghost'), JSON.stringify({
    pid: done.pid, board: 'ghost', intervalMs: 1000, startedAt: new Date().toISOString(), holder: 'x',
  }));
  const st = daemon.status('ghost');
  assert.equal(st.running, false);
  assert.equal(st.stale, true);
});

test('a pid file from before this boot is stale even if something now holds that pid', () => {
  // The reboot case. Without it a recycled pid keeps `kb up` refusing for ever, which is the
  // failure that teaches people to delete pid files by hand.
  fs.writeFileSync(daemon.pidPath('rebooted'), JSON.stringify({
    pid: process.pid, board: 'rebooted', intervalMs: 1000,
    startedAt: new Date(Date.now() - 400 * 24 * 3600_000).toISOString(), holder: 'x',
  }));
  const st = daemon.status('rebooted');
  assert.equal(st.running, false, 'our own live pid, and still correctly stale');
  assert.equal(st.stale, true);
});

test('a live pid file reads as running, with an uptime', () => {
  daemon.claimPidFile('live', 1000);
  const st = daemon.status('live');
  assert.equal(st.running, true);
  assert.equal(st.daemon.pid, process.pid);
  assert.ok(st.uptimeMs >= 0);
  daemon.releasePidFile('live');
  assert.equal(daemon.status('live').daemon, null);
});

test('releasing does not delete a pid file that now belongs to somebody else', () => {
  const p = daemon.pidPath('handover');
  fs.writeFileSync(p, JSON.stringify({
    pid: process.pid + 1, board: 'handover', intervalMs: 1000, startedAt: new Date().toISOString(), holder: 'x',
  }));
  daemon.releasePidFile('handover');
  assert.equal(fs.existsSync(p), true, 'that file is the replacement daemons, not ours to remove');
  fs.rmSync(p);
});

test('kb down on a stale pid file clears it and says so rather than pretending it stopped one', async () => {
  const done = spawnSync(process.execPath, ['-e', '0']);
  fs.writeFileSync(daemon.pidPath('leftover'), JSON.stringify({
    pid: done.pid, board: 'leftover', intervalMs: 1000, startedAt: new Date().toISOString(), holder: 'x',
  }));
  const res = await daemon.stop('leftover');
  assert.equal(res.stopped, false);
  assert.match(res.why as string, /stale/);
  assert.equal(fs.existsSync(daemon.pidPath('leftover')), false);
});

test('kb down with nothing to stop is not an error story, just a fact', async () => {
  const res = await daemon.stop('never-existed');
  assert.equal(res.stopped, false);
  assert.equal(res.why, 'no daemon running');
});
