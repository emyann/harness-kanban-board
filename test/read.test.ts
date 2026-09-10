import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

/**
 * The read model, without a terminal.
 *
 * `hkb boards`, `hkb ls` and `hkb show` each held their query, their shaping and their printing in
 * one `case` of `switch (verb)`, so the only way to ask the board a question was to hand argv to
 * `main()` and parse what came back on stdout. **There is no CLI here**: these three answers are
 * what any consumer needs, and the object each returns is the object `--json` prints.
 *
 * Written against the facts a second consumer would get wrong by re-deriving them — a resolved spec
 * with its source, a `producedNothing` marker, a count for a phase the CLI's table has no column
 * for — rather than against the rendering, which stays in the verb.
 */

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hkb-read-'));
process.env.HKB_DATABASE_URL = `file:${path.join(dir, 'test.db')}`;
const PKG = path.resolve(import.meta.dirname, '..');
execFileSync(process.execPath, ['node_modules/prisma/build/index.js', 'migrate', 'deploy'], {
  cwd: PKG, env: process.env, stdio: 'ignore',
});

const { openBoard, closeBoard } = await import('../src/db.ts');
const {
  boardSummaries, boardSummary, listJobs, showJob, producedNothing, PHASES,
} = await import('../src/read.ts');

const db = openBoard();
const one = await db.board.upsert({
  where: { slug: 'read-one' }, update: {},
  create: { slug: 'read-one', repoPath: '/tmp/one', defaultModel: 'opus', defaultMaxBudgetUsd: 4 },
});
const two = await db.board.upsert({
  where: { slug: 'read-two' }, update: {}, create: { slug: 'read-two' },
});

const mkJob = (boardId: number, name: string, extra: Record<string, unknown> = {}) =>
  db.job.create({ data: { boardId, name, brief: `do ${name}`, ...extra } });

test.after(async () => { await closeBoard(); fs.rmSync(dir, { recursive: true, force: true }); });

// ---------------------------------------------------------------- hkb boards

test('a board summary counts EVERY phase, including the two the table has no column for', async () => {
  // #57: `hkb boards` prints PEND RUN OK FAIL ENDED, so a board with four cards in triage shows
  // `PEND 0` and nothing else. Whether the table grows a column is that card's business; what the
  // read model must not do is answer six of the eight phases and send a consumer back to SQL for
  // the rest.
  const b = await db.board.upsert({ where: { slug: 'read-counts' }, update: {}, create: { slug: 'read-counts' } });
  for (const phase of PHASES) await mkJob(b.id, `a ${phase} one`, { phase });

  const row = await boardSummary(db, 'read-counts');
  assert.ok(row);
  for (const phase of PHASES) {
    assert.equal((row as unknown as Record<string, number>)[phase], 1, `${phase} is counted`);
  }
  assert.equal(row.triage, 1, 'the inbox is visible');
  assert.equal(row.suspended, 1, 'and so is what is waiting for a person');
  assert.equal(row.pending, 1, 'and neither of them was folded into PEND');
});

test('a summary carries the ceilings, the spend and the daemon, set or not', async () => {
  await db.attempt.create({
    data: {
      jobId: (await mkJob(one.id, 'spent')).id, k: 1, host: 'h', runtime: 'fake',
      startedAt: new Date(), endedAt: new Date(), costUsd: 1.25, maxBudgetUsd: 4, attemptDeadlineSeconds: 1800,
    },
  });
  const row = await boardSummary(db, 'read-one');
  assert.ok(row);
  assert.equal(row.spent24h, 1.25);
  assert.equal(row.daemon, 'down', 'nothing is serving this board, and that is a fact rather than an absence');
  assert.equal(row.paused, false);
  assert.equal(row.maxConcurrent, 1);
  assert.equal(row.dailyBudgetUsd, null);
  assert.equal(row.hasDefaults, true);
  assert.equal(row.defaults.model, 'opus', 'the defaults are on every row, so nobody infers them from a missing key');
  assert.equal(row.repoPath, '/tmp/one');
});

test('a spend older than the window is not charged to today', async () => {
  const j = await mkJob(two.id, 'yesterday');
  await db.attempt.create({
    data: {
      jobId: j.id, k: 1, host: 'h', runtime: 'fake', costUsd: 99, maxBudgetUsd: 1, attemptDeadlineSeconds: 1800,
      startedAt: new Date(Date.now() - 26 * 60 * 60 * 1000), endedAt: new Date(Date.now() - 25 * 60 * 60 * 1000),
    },
  });
  assert.equal((await boardSummary(db, 'read-two'))?.spent24h, 0);
});

test('the plural and the singular are one query with a where, so they cannot disagree', async () => {
  const all = await boardSummaries(db);
  const mine = all.find((r) => r.board === 'read-one');
  assert.deepEqual(await boardSummary(db, 'read-one'), mine);
  assert.ok(all.length > 1, 'the cluster view is every board on the machine');
  assert.deepEqual([...all].sort((a, b) => a.board.localeCompare(b.board)).map((r) => r.board),
    all.map((r) => r.board), 'ordered by slug, the way an operator reads and retypes it');
  assert.equal(await boardSummary(db, 'no-such-board'), null);
});

// ---------------------------------------------------------------- hkb ls

test('the listing carries the attempt count and the pull request from one read', async () => {
  const j = await mkJob(one.id, 'has attempts', { phase: 'succeeded' });
  for (const k of [1, 2]) {
    await db.attempt.create({
      data: {
        jobId: j.id, k, host: 'h', runtime: 'fake', startedAt: new Date(), maxBudgetUsd: 1,
        attemptDeadlineSeconds: 1800, ...(k === 2 ? { prUrl: 'https://example/pull/7' } : {}),
      },
    });
  }
  const row = (await listJobs(db, { slug: 'read-one' })).find((r) => r.id === j.id);
  assert.ok(row);
  assert.equal(row.attempts, 2);
  assert.equal(row.pr, 'https://example/pull/7', 'the newest attempt that has one answers');
  assert.equal(row.producedNothing, false, 'a pull request is something left behind');
  assert.equal(row.board, 'read-one', 'the board is on every row whatever the scope was');
});

test('a succeeded Job that left nothing behind is marked, and one that failed is not', async () => {
  const empty = await mkJob(one.id, 'looked and found nothing', { phase: 'succeeded' });
  const failed = await mkJob(one.id, 'went wrong', { phase: 'failed' });
  const rows = await listJobs(db, { slug: 'read-one' });
  assert.equal(rows.find((r) => r.id === empty.id)?.producedNothing, true);
  assert.equal(rows.find((r) => r.id === failed.id)?.producedNothing, false,
    'a failed Job producing nothing is not news, and marking it would be noise');
  // The predicate itself, at the boundary that matters.
  assert.equal(producedNothing({ phase: 'succeeded', pr: null, exports: [] }), true);
  assert.equal(producedNothing({ phase: 'succeeded', pr: null, exports: [], proposes: 'jobs' }), false,
    'a proposer reaches succeeded only once its rows are filed, and rows are the most concrete output here');
});

test('a null slug is every board, a slug is one, and a label selector is ANDed equality', async () => {
  await mkJob(one.id, 'labelled', { labels: { area: 'parser', workflow: 'release' } });
  await mkJob(one.id, 'half labelled', { labels: { area: 'parser' } });
  const scoped = await listJobs(db, { slug: 'read-one' });
  const everywhere = await listJobs(db, { slug: null });
  assert.ok(everywhere.length > scoped.length, 'a null slug is `hkb ls --all`');
  assert.ok(everywhere.some((r) => r.board === 'read-two'));

  const both = await listJobs(db, { slug: 'read-one' }, { labels: { area: 'parser', workflow: 'release' } });
  assert.deepEqual(both.map((r) => r.name), ['labelled'], 'every selector must match, not any');
});

test('a phase filter narrows, and a phase that is not one is refused rather than answered "none"', async () => {
  const rows = await listJobs(db, { slug: 'read-one' }, { phase: 'failed' });
  assert.ok(rows.length);
  assert.ok(rows.every((r) => r.phase === 'failed'));
  // The refusal that matters: an empty listing reads as "nothing matches", which is the one answer
  // a typo must never get.
  await assert.rejects(
    () => listJobs(db, { slug: 'read-one' }, { phase: 'nearly' as never }),
    (e: Error & { exitCode?: number }) => {
      assert.equal(e.exitCode, 2);
      assert.match(e.message, /no phase "nearly"/);
      return true;
    },
  );
});

// ---------------------------------------------------------------- hkb show

test('show resolves the spec and names which of the three levels answered', async () => {
  // The reason this is not `findUnique`: most spec columns are null on a board that sets defaults,
  // and a null `model` is not an answer to "which model does this run on".
  const j = await mkJob(one.id, 'inherits', { maxTurns: 7 });
  const shown = await showJob(db, j.id);
  assert.equal(shown.model, null, 'the raw column is still there, and still says nothing');
  assert.deepEqual(shown.spec.model, { value: 'opus', from: 'board' });
  assert.deepEqual(shown.spec.maxTurns, { value: 7, from: 'job' });
  assert.deepEqual(shown.spec.maxBudgetUsd, { value: 4, from: 'board' });
  assert.equal(shown.spec.maxRetries.from, 'built-in');
  assert.equal(shown.board.slug, 'read-one');
});

test('show says the check that will RUN, in the one shape `hkb new` also prints', async () => {
  await db.board.update({ where: { id: two.id }, data: { defaultCheck: 'npm test' } });
  const inherits = await showJob(db, (await mkJob(two.id, 'inherits a check')).id);
  assert.deepEqual(inherits.check, { value: 'npm test', source: 'board' },
    'the raw column is null and the resolved command is what an attempt will be judged by');

  const optedOut = await showJob(db, (await mkJob(two.id, 'opts out', { check: '' })).id);
  assert.deepEqual(optedOut.check, { value: '', source: 'job' },
    'the empty string is a value — no check, and do not inherit the board\'s');

  const proposer = await showJob(db, (await mkJob(two.id, 'proposes', { proposes: 'jobs' })).id);
  assert.deepEqual(proposer.check, { value: null, source: 'proposes' },
    'a proposing Job runs none whatever the board says');
});

test('show carries the attempts in order, and the lease when one is held', async () => {
  const j = await mkJob(one.id, 'running now', { phase: 'running' });
  for (const k of [1, 2]) {
    await db.attempt.create({
      data: {
        jobId: j.id, k, host: 'h', runtime: 'fake', startedAt: new Date(), maxBudgetUsd: 2,
        attemptDeadlineSeconds: 1800, ...(k === 1 ? { outcome: 'crashed' as const, endedAt: new Date(), turns: 3 } : {}),
      },
    });
  }
  await db.lease.create({
    data: { jobId: j.id, holder: 'host/9', token: 'tok', slot: 0, expiresAt: new Date(Date.now() + 60_000) },
  });
  const shown = await showJob(db, j.id);
  assert.deepEqual(shown.attempts.map((a) => a.k), [1, 2], 'oldest first, the order they are read in');
  assert.equal(shown.attempts[0].turns, 3);
  assert.equal(shown.lease?.holder, 'host/9');
});

test('show names the standing steps a Job will get — and never for the two that will not', async () => {
  const repo = fs.mkdtempSync(path.join(dir, 'steps-'));
  const b = await db.board.upsert({
    where: { slug: 'read-steps' }, update: {},
    create: { slug: 'read-steps', repoPath: repo, defaultWorkflow: 'implement' },
  });
  assert.equal((await showJob(db, (await mkJob(b.id, 'ordinary')).id)).standingSteps, 'implement');
  assert.equal((await showJob(db, (await mkJob(b.id, 'proposer', { proposes: 'jobs' })).id)).standingSteps, null,
    'a proposing Job writes one JSON file — steps about a branch are not an instruction it can follow');
  assert.equal((await showJob(db, (await mkJob(b.id, 'in place', { isolate: false })).id)).standingSteps, null,
    'and an un-isolated Job has no branch for them to be about');
});

test('show refuses an id that is not on the board, and points at the listing', async () => {
  await assert.rejects(() => showJob(db, 999999), (e: Error & { exitCode?: number }) => {
    assert.equal(e.exitCode, 2);
    assert.match(e.message, /no Job #999999 — `hkb ls` shows what is on the board/);
    return true;
  });
});

// ---------------------------------------------------------------- the seam itself

test('the CLI no longer holds the board-wide read — ADR-015 rule, checked rather than remembered', () => {
  // The same weak-test-of-a-strong-rule as `filing.test.ts`, on the other half: a verb that reads
  // the board by hand is a shape a second consumer has to re-derive, and re-derived shapes are how
  // `hkb new --json` and `hkb show --json` came to print different checks for the same Job.
  const src = fs.readFileSync(path.join(PKG, 'src', 'hkb.ts'), 'utf8');
  assert.equal(src.includes('db.job.findMany'), false,
    'listing the board belongs to src/read.ts — `hkb ls` calls listJobs and prints');
});
