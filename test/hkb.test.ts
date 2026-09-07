import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hkb-kb-'));
process.env.HKB_DATABASE_URL = `file:${path.join(dir, 'hkb.db')}`;
const REPO = path.resolve(import.meta.dirname, '..');
execFileSync(process.execPath, ['node_modules/prisma/build/index.js', 'migrate', 'deploy'], {
  cwd: REPO, env: process.env, stdio: 'ignore',
});

const { main } = await import('../src/hkb.ts');
const { openBoard, closeBoard } = await import('../src/db.ts');
const db = openBoard();

/**
 * The whole suite runs from a throwaway repository, not the one you are working in.
 *
 * `hkb new` defaults `isolate` to true and `hkb run` reconciles in `process.cwd()`, so a single
 * un-flagged `hkb run` in these tests cut a 620 MB worktree into the developer's own checkout and
 * left it. Boards created here take their `repoPath` from wherever we are standing, so standing
 * somewhere disposable fixes it for every test at once rather than one `--no-isolate` at a time.
 * The two tests that chdir for their own reasons still restore to here.
 */
const HOME_REPO = path.join(dir, 'suite-repo');
fs.mkdirSync(HOME_REPO);
{
  const g = (...a: string[]) => execFileSync('git', a, { cwd: HOME_REPO, stdio: 'ignore' });
  g('init', '-q', '-b', 'main');
  g('config', 'user.email', 'k@test');
  g('config', 'user.name', 'k');
  fs.writeFileSync(path.join(HOME_REPO, 'README.md'), '# suite\n');
  g('add', '-A');
  g('commit', '-qm', 'base');
}
const LAUNCHED_FROM = process.cwd();
process.chdir(HOME_REPO);

test.after(async () => {
  process.chdir(LAUNCHED_FROM);
  await closeBoard();
  fs.rmSync(dir, { recursive: true, force: true });
});

/**
 * Run a verb and capture what it printed, so `--json` is asserted on its real output.
 *
 * The runner's own frames have to be kept out of the capture and passed through to the real stream. `node --test` multiplexes its reporter protocol
 * (`test:enqueue`, `test:pass`, …) over this very stream as v8-serialized binary, so anything that
 * patches `process.stdout.write` captures whatever the runner happened to emit in the same window.
 * That made this harness quietly timing-dependent: it passed for as long as no frame landed mid-verb,
 * and failed with `Unexpected token '\uFFFD'` the moment one did.
 *
 * A frame is PASSED THROUGH, never merely skipped. Dropping one loses an event the parent process
 * reconstructs the test tree from, and its reporter then dies on a `test:pass` for a subtest it
 * never saw start \u2014 the whole run, taken down by the harness, on a timing nobody controls.
 */
const RUNNER_FRAME = /\btest:(enqueue|dequeue|start|pass|fail|plan|diagnostic|complete|coverage|stderr|stdout|watch)\b/;

async function hkb(...argv: string[]): Promise<{ code: number; out: string }> {
  const chunks: string[] = [];
  const write = process.stdout.write.bind(process.stdout);
  (process.stdout as { write: unknown }).write = (s: string) => {
    const text = String(s);
    // Forwarded, not dropped. Swallowing a frame does not just lose a line: the parent process's
    // reporter is a state machine over that stream, and a missing `test:start` crashes it
    // (`assert(subtest.data.name === data.name)`) after every subtest has already passed.
    if (RUNNER_FRAME.test(text)) return write(s as never);
    chunks.push(text);
    return true;
  };
  try {
    const code = await main(argv);
    return { code, out: chunks.join('') };
  } finally {
    (process.stdout as { write: unknown }).write = write;
  }
}
const json = (s: string) => JSON.parse(s);

// ---------------------------------------------------------------- shape

test('no verb prints help and exits 0', async () => {
  const r = await hkb();
  assert.equal(r.code, 0);
  assert.match(r.out, /hkb — run one agent against one brief/);
});

test('an unknown verb names the ones that exist', async () => {
  await assert.rejects(() => hkb('frobnicate'), /unknown verb.*new, ls, show, run, retry, done, cancel, rm/s);
});

// ---------------------------------------------------------------- new

test('new files a Job and returns its id', async () => {
  const r = await hkb('new', 'first', '--brief', 'do the thing', '--json');
  const j = json(r.out);
  assert.equal(j.phase, 'pending');
  assert.equal(j.name, 'first');
  assert.ok(j.id > 0);
  const row = await db.job.findUniqueOrThrow({ where: { id: j.id } });
  assert.equal(row.brief, 'do the thing');
  assert.equal(row.isolate, true, 'isolation is the default, not the opt-in');
});

test('new refuses without a brief, and says how to give one', async () => {
  await assert.rejects(() => hkb('new', 'no brief'), /--brief|--brief-file/);
});

test('new reads a brief from a file', async () => {
  const p = path.join(dir, 'brief.md');
  fs.writeFileSync(p, '  from a file  ');
  const j = json((await hkb('new', 'filed', '--brief-file', p, '--json')).out);
  assert.equal((await db.job.findUniqueOrThrow({ where: { id: j.id } })).brief, 'from a file');
});

test('new names a missing brief file rather than failing obscurely', async () => {
  await assert.rejects(() => hkb('new', 'x', '--brief-file', '/nope/nothing.md'), /no such file/);
});

test('--propose files a proposing Job, and a proposing Job is a GATED Job', async () => {
  const j = json((await hkb('new', 'decomposer', '--brief', 'break it down', '--propose', '--json')).out);
  const row = await db.job.findUniqueOrThrow({ where: { id: j.id } });
  assert.equal(row.proposes, 'jobs');
  // The one that matters. ADR-011 applies nothing without an approval, so a proposing Job with no
  // gate would propose into a board where nobody is ever asked — which is not a smaller version of
  // the feature, it is the feature missing.
  assert.ok(row.gate, 'a proposal with no approver is a proposal nothing reads');

  const own = json((await hkb('new', 'decomposer with a question', '--brief', 'b', '--propose',
    '--gate', 'is this the right split?', '--json')).out);
  assert.equal((await db.job.findUniqueOrThrow({ where: { id: own.id } })).gate, 'is this the right split?',
    'and the operator’s own question wins over the default');

  const plain = json((await hkb('new', 'not a proposer', '--brief', 'b', '--json')).out);
  const plainRow = await db.job.findUniqueOrThrow({ where: { id: plain.id } });
  assert.equal(plainRow.proposes, null, 'proposing is opt-in');
  assert.equal(plainRow.gate, null, 'and it is the only thing that turns the gate on by itself');
});

test('new validates effort against the closed set', async () => {
  await assert.rejects(() => hkb('new', 'x', '--brief', 'b', '--effort', 'turbo'), /low\|medium\|high/);
});

test('new carries the spec flags onto the row', async () => {
  const j = json((await hkb('new', 'specced', '--brief', 'b', '--json',
    '--model', 'claude-opus-5', '--effort', 'high', '--max-turns', '3',
    '--max-budget', '0.25', '--max-retries', '0', '--no-isolate')).out);
  const row = await db.job.findUniqueOrThrow({ where: { id: j.id } });
  assert.equal(row.model, 'claude-opus-5');
  assert.equal(row.effort, 'high');
  assert.equal(row.maxTurns, 3);
  assert.equal(row.maxBudgetUsd, 0.25);
  assert.equal(row.maxRetries, 0);
  assert.equal(row.isolate, false);
});

test('new records the paths a Job must produce', async () => {
  const j = json((await hkb('new', 'skill-card', '--brief', 'b', '--json',
    '--export', '.claude/skills/sdk-docs/', '--export', 'NOTES.md')).out);
  const row = await db.job.findUniqueOrThrow({ where: { id: j.id } });
  assert.deepEqual(row.exports, ['.claude/skills/sdk-docs', 'NOTES.md'],
    'repeatable, and normalised — a trailing slash is how a directory is written, not part of the path');
  assert.deepEqual(j.exports, ['.claude/skills/sdk-docs', 'NOTES.md']);
});

test('a Job that declares nothing stores null, not an empty declaration', async () => {
  const j = json((await hkb('new', 'declares-nothing', '--brief', 'b', '--json')).out);
  assert.equal((await db.job.findUniqueOrThrow({ where: { id: j.id } })).exports, null,
    '"produces no file" and "produced none of the files it promised" are different facts');
});

test('new REFUSES an export path that escapes the repository, and files nothing', async () => {
  // Admission, in the Kubernetes sense: an illegal request must not become state. The board does
  // this copy itself, with the operator's authority and no agent in the loop to notice.
  const before = await db.job.count();
  for (const [bad, why] of [
    ['../elsewhere', /escapes the worktree/],
    ['/etc/passwd', /absolute/],
    ['.hkb/board.db', /board's own directory/],
  ] as [string, RegExp][]) {
    await assert.rejects(() => hkb('new', 'sneaky', '--brief', 'b', '--export', bad), why);
  }
  assert.equal(await db.job.count(), before, 'and no half-filed Job is left behind');
});

test('a numeric flag given a non-number says so', async () => {
  await assert.rejects(() => hkb('new', 'x', '--brief', 'b', '--max-turns', 'lots'), /wants a number/);
});

// ---------------------------------------------------------------- ls / show

test('ls is empty-safe and says so', async () => {
  const r = await hkb('ls', '--board', 'nothing-here');
  assert.equal(r.code, 0);
  assert.match(r.out, /no jobs on nothing-here/);
});

test('ls --json lists what is on the board', async () => {
  const rows = json((await hkb('ls', '--json')).out);
  assert.ok(rows.length >= 3);
  assert.ok(rows.every((r: { phase: string }) => r.phase === 'pending'));
});

test('ls --phase rejects a phase that is not one', async () => {
  await assert.rejects(() => hkb('ls', '--phase', 'nearly'), /pending\|running/);
});

test('show is the one screen: spec, phase and attempts', async () => {
  const j = json((await hkb('new', 'showme', '--brief', 'b', '--json')).out);
  const r = await hkb('show', String(j.id));
  assert.match(r.out, /phase\s+pending/);
  assert.match(r.out, /maxBudget/);
  assert.match(r.out, /attempts \(none yet\)/);
});

test('show names the board and the checkout the Job runs in', async () => {
  await db.board.create({ data: { slug: 'accounting', repoPath: '/srv/accounting' } });
  const j = json((await hkb('new', 'ledger', '--board', 'accounting', '--brief', 'b', '--json')).out);
  const r = await hkb('show', String(j.id));
  assert.match(r.out, /board\s+accounting\s+\/srv\/accounting/);

  // A board with no repoPath has nowhere to cut a worktree, so the line has to say that outright
  // rather than print a blank column that reads like "here".
  await db.board.create({ data: { slug: 'homeless' } });
  const k = json((await hkb('new', 'adrift', '--board', 'homeless', '--brief', 'b', '--json')).out);
  assert.match((await hkb('show', String(k.id))).out, /board\s+homeless\s+\(no repo — `hkb boards add homeless --repo <path>`\)/);
});

test('show on a missing id points at ls', async () => {
  await assert.rejects(() => hkb('show', '99999'), /no Job #99999.*hkb ls/s);
});

// ---------------------------------------------------------------- how long it took

const { formatDuration } = await import('../src/hkb.ts');

test('formatDuration steps at a minute and at an hour, and truncates at both', () => {
  assert.equal(formatDuration(0), '0s');
  assert.equal(formatDuration(4_000), '4s');
  assert.equal(formatDuration(59_000), '59s');
  assert.equal(formatDuration(60_000), '1m');
  // A second short of an hour is 59 minutes. Rounding would print `60m` — an hour that has not
  // happened yet — which is the one number this must never say.
  assert.equal(formatDuration(3_599_000), '59m');
  assert.equal(formatDuration(3_600_000), '1h00m');
  assert.equal(formatDuration(3_840_000), '1h04m');
  // Two hosts, two clocks: the end can land before the start.
  assert.equal(formatDuration(-5_000), '0s');
});

test('show prints how long each attempt took, and marks one still running', async () => {
  const j = json((await hkb('new', 'timed', '--brief', 'b', '--json')).out);
  const started = new Date('2026-09-05T10:00:00Z');
  await db.attempt.create({
    data: {
      jobId: j.id, k: 1, startedAt: started, endedAt: new Date(started.getTime() + 3_840_000),
      outcome: 'completed', costUsd: 0.4, maxBudgetUsd: 1,
    },
  });
  await db.attempt.create({ data: { jobId: j.id, k: 2, startedAt: new Date(Date.now() - 90_000), maxBudgetUsd: 1 } });
  const r = await hkb('show', String(j.id));
  // $0.40 means very little without "and it took an hour" beside it.
  assert.match(r.out, /completed\s+1h04m \$0\.4000/);
  assert.match(r.out, /running\s+1m\+ up to \$1\.00/,
    'an attempt in flight shows elapsed-so-far and the cap it is running under, not nothing');
});

// ---------------------------------------------------------------- run

test('run on an empty board is a no-op that exits 0', async () => {
  const r = await hkb('run', '--board', 'nothing-here', '--fake');
  assert.equal(r.code, 0);
  assert.match(r.out, /nothing pending/);
});

test('run --fake works a Job to succeeded and records the session pointer', async () => {
  const j = json((await hkb('new', 'runme', '--brief', 'b', '--json')).out);
  await hkb('run', String(j.id), '--fake');
  const row = await db.job.findUniqueOrThrow({ where: { id: j.id }, include: { attempts: true } });
  assert.equal(row.phase, 'succeeded');
  assert.equal(row.attempts.length, 1);
  assert.ok(row.attempts[0].sessionId);
});

test('run <id> touches only that Job', async () => {
  const a = json((await hkb('new', 'only-a', '--brief', 'b', '--json')).out);
  const b = json((await hkb('new', 'not-b', '--brief', 'b', '--json')).out);
  await hkb('run', String(a.id), '--fake');
  assert.equal((await db.job.findUniqueOrThrow({ where: { id: a.id } })).phase, 'succeeded');
  assert.equal((await db.job.findUniqueOrThrow({ where: { id: b.id } })).phase, 'pending');
});

test('run on a Job that is not pending says so rather than pretending', async () => {
  const j = json((await hkb('new', 'settled', '--brief', 'b', '--json')).out);
  await hkb('run', String(j.id), '--fake');
  const r = await hkb('run', String(j.id), '--fake');
  assert.match(r.out, new RegExp(`#${j.id} is not pending`));
});

test('run on a missing id refuses before spending anything', async () => {
  await assert.rejects(() => hkb('run', '99999', '--fake'), /no Job #99999/);
});

// ---------------------------------------------------------------- rm

test('rm deletes a Job and its attempts', async () => {
  const j = json((await hkb('new', 'goner', '--brief', 'b', '--json')).out);
  await hkb('run', String(j.id), '--fake');
  await hkb('rm', String(j.id));
  assert.equal(await db.job.findUnique({ where: { id: j.id } }), null);
  assert.equal(await db.attempt.count({ where: { jobId: j.id } }), 0, 'cascaded');
});

// ---------------------------------------------------------------- done / cancel
//
// The gap: a Job whose pull request was reviewed and merged while it sat `pending` on a spent
// budget. Until these verbs the only thing that stopped the next reconcile from spending the whole
// cap again was `hkb rm`, which deletes the record that the work happened.

test('done ends a Job the runtime could not, and records who said so and why', async () => {
  const j = json((await hkb('new', 'merged-elsewhere', '--brief', 'b', '--board', 'byhand', '--json')).out);
  const r = await hkb('done', String(j.id), 'PR #364 was reviewed and merged', '--board', 'byhand', '--json');
  assert.equal(r.code, 0);
  const said = json(r.out);
  assert.equal(said.phase, 'done');
  assert.equal(said.from, 'pending');
  assert.equal(said.endedFor, 'PR #364 was reviewed and merged');

  const row = await db.job.findUniqueOrThrow({ where: { id: j.id } });
  assert.equal(row.phase, 'done');
  assert.notEqual(row.phase, 'succeeded', 'succeeded means the session completed, and this one did not');
  assert.ok(row.endedBy, 'a decision with no one attached to it is not a decision');
  assert.equal(row.endedFor, 'PR #364 was reviewed and merged');
  assert.ok(row.finishedAt, 'and it is finished');
});

test('a Job ended by hand is not claimed again — the whole point', async () => {
  const j = json((await hkb('new', 'do-not-redo', '--brief', 'b', '--board', 'byhand', '--json')).out);
  await hkb('done', String(j.id), 'landed as PR #364', '--board', 'byhand');
  const r = await hkb('run', '--board', 'byhand', '--fake');
  assert.match(r.out, /nothing pending/);
  assert.equal(await db.attempt.count({ where: { jobId: j.id } }), 0, 'and nothing was spent redoing it');
});

test('cancel is a different statement from done, and ls can ask for either', async () => {
  const j = json((await hkb('new', 'not-wanted', '--brief', 'b', '--board', 'byhand', '--json')).out);
  await hkb('cancel', String(j.id), 'superseded by ADR-008', '--board', 'byhand');
  const rows = json((await hkb('ls', '--phase', 'cancelled', '--board', 'byhand', '--json')).out);
  assert.deepEqual(rows.map((x: { id: number }) => x.id), [j.id]);
  const done = json((await hkb('ls', '--phase', 'done', '--board', 'byhand', '--json')).out);
  assert.ok(!done.some((x: { id: number }) => x.id === j.id), 'cancelled is not done, and the board keeps them apart');
});

test('done refuses without a reason, and says what to type instead', async () => {
  const j = json((await hkb('new', 'no-reason', '--brief', 'b', '--board', 'byhand', '--json')).out);
  await assert.rejects(
    () => hkb('done', String(j.id), '--board', 'byhand'),
    (e: Error & { exitCode?: number }) => {
      assert.equal(e.exitCode, 2);
      assert.match(e.message, /needs a reason/);
      assert.match(e.message, /hkb done \d+ "/, 'and shows the shape of one');
      return true;
    },
  );
  assert.equal((await db.job.findUniqueOrThrow({ where: { id: j.id } })).phase, 'pending', 'and nothing moved');
});

test('done REFUSES a leased Job — that is a running worker — and says how to stop it', async () => {
  const j = json((await hkb('new', 'still-running', '--brief', 'b', '--board', 'byhand', '--json')).out);
  await db.lease.create({
    data: { jobId: j.id, holder: 'host/9@daemon', token: 't', expiresAt: new Date(Date.now() + 60_000) },
  });
  try {
    for (const verb of ['done', 'cancel']) {
      await assert.rejects(
        () => hkb(verb, String(j.id), 'because', '--board', 'byhand'),
        (e: Error & { exitCode?: number }) => {
          assert.equal(e.exitCode, 2);
          assert.match(e.message, /leased by host\/9@daemon/);
          assert.match(e.message, /hkb down/, 'and names the way out');
          assert.match(e.message, /wait/, 'or the other way out');
          return true;
        },
      );
    }
    assert.equal((await db.job.findUniqueOrThrow({ where: { id: j.id } })).phase, 'pending', 'and it is untouched');
  } finally {
    await db.lease.delete({ where: { jobId: j.id } });
  }
});

test('done refuses a Job the runtime already concluded', async () => {
  const j = json((await hkb('new', 'ran-fine', '--brief', 'b', '--board', 'byhand', '--json')).out);
  await hkb('run', String(j.id), '--board', 'byhand', '--fake');
  await assert.rejects(
    () => hkb('done', String(j.id), 'redundant', '--board', 'byhand'),
    /already succeeded/,
  );
});

test('saying the same thing twice is refused; correcting done to cancelled is not', async () => {
  const j = json((await hkb('new', 'mistyped', '--brief', 'b', '--board', 'byhand', '--json')).out);
  await hkb('done', String(j.id), 'thought it landed', '--board', 'byhand');
  await assert.rejects(
    () => hkb('done', String(j.id), 'again', '--board', 'byhand'),
    /already done/,
  );
  // The escape from a mistyped verb must not be `hkb rm` — that is the trap this verb removes.
  await hkb('cancel', String(j.id), 'actually it never landed', '--board', 'byhand');
  const row = await db.job.findUniqueOrThrow({ where: { id: j.id } });
  assert.equal(row.phase, 'cancelled');
  assert.equal(row.endedFor, 'actually it never landed');
  const kinds = (await db.event.findMany({ where: { jobId: j.id }, orderBy: { id: 'asc' } })).map((e) => e.kind);
  assert.deepEqual(kinds, ['created', 'done', 'cancelled'], 'and the log keeps both statements, in order');
});

test('the transition is recorded with the person as the actor, so hkb log reads differently', async () => {
  const j = json((await hkb('new', 'logged', '--brief', 'b', '--board', 'byhand', '--json')).out);
  await hkb('done', String(j.id), 'merged by hand', '--board', 'byhand');
  const ev = await db.event.findFirstOrThrow({ where: { jobId: j.id, kind: 'done' } });
  assert.deepEqual(ev.payload, { from: 'pending', reason: 'merged by hand' });
  assert.ok(ev.actor && !/@cli$/.test(ev.actor), 'a human decision is not attributed to a process');
  const out = (await hkb('log', String(j.id), '--board', 'byhand')).out;
  assert.match(out, /done/);
  assert.match(out, /merged by hand/);
});

test('show makes the human decision visible rather than leaving it to be inferred', async () => {
  const j = json((await hkb('new', 'visible', '--brief', 'b', '--board', 'byhand', '--json')).out);
  await hkb('done', String(j.id), 'PR #364 was reviewed and merged', '--board', 'byhand');
  const out = (await hkb('show', String(j.id), '--board', 'byhand')).out;
  assert.match(out, /phase +done/);
  assert.match(out, /ended +by /, 'who');
  assert.match(out, /PR #364 was reviewed and merged/, 'and why');
  assert.doesNotMatch(out, /succeeded/, 'the session did not complete, and the screen must not say it did');
});

test('an attempt still open on an unleased Job is closed, not left climbing for ever', async () => {
  // How a Job gets here: a holder died between releasing its lease and writing the Job row. No
  // lease is left for the reclaim to find, so the operator is the only thing that can conclude it.
  const j = json((await hkb('new', 'stranded', '--brief', 'b', '--board', 'byhand', '--json')).out);
  await db.job.update({ where: { id: j.id }, data: { phase: 'running' } });
  await db.attempt.create({ data: { jobId: j.id, k: 1, host: 'host/9@daemon', maxBudgetUsd: 1 } });
  await hkb('done', String(j.id), 'the PR it opened was merged', '--board', 'byhand');
  const a = await db.attempt.findUniqueOrThrow({ where: { jobId_k: { jobId: j.id, k: 1 } } });
  assert.ok(a.endedAt, 'closed');
  assert.equal(a.outcome, 'lost', 'never heard from again is exactly what happened to it');
});

// ---------------------------------------------------------------- stop / start

test('stop is the kill switch: it refuses to claim and says who stopped it', async () => {
  await hkb('new', 'blocked-by-stop', '--brief', 'b', '--board', 'switch', '--json');
  await hkb('stop', '--board', 'switch');
  const r = await hkb('run', '--board', 'switch', '--fake');
  assert.match(r.out, /refused:.*stopped/);
  assert.match(r.out, /hkb start/, 'and says what to do about it');
});

test('a stopped board leaves its Jobs pending, not failed', async () => {
  const rows = json((await hkb('ls', '--board', 'switch', '--json')).out);
  assert.ok(rows.every((j: { phase: string; attempts: number }) => j.phase === 'pending' && j.attempts === 0),
    'refusing to start is not failing');
});

test('start clears it and reports the ceilings', async () => {
  const r = await hkb('start', '--board', 'switch');
  assert.match(r.out, /started/);
  // "1 concurrent" was a capacity; "runs up to 1 at once" is what the board actually does.
  assert.match(r.out, /no ceiling, runs up to 1 at once/);
  const after = await hkb('run', '--board', 'switch', '--fake');
  assert.match(after.out, /1 succeeded/);
});

test('rm refuses a leased Job rather than orphaning a running worker', async () => {
  // Named, not inferred: `switch` above pointed a second board at this checkout, so from here on
  // bare resolution refuses rather than choosing between them.
  const j = json((await hkb('new', 'leased', '--brief', 'b', '--board', 'switch', '--json')).out);
  await db.lease.create({
    data: { jobId: j.id, holder: 'someone-else', token: 't', expiresAt: new Date(Date.now() + 60_000) },
  });
  await assert.rejects(() => hkb('rm', String(j.id), '--board', 'switch'), /leased by someone-else/);
  await db.lease.delete({ where: { jobId: j.id } });
});

test('--interval has a floor: a sub-second tick is a mistake, not a preference', async () => {
  // It had none, and `--interval 0` ran 2221 passes in three seconds against the board. The loop
  // is time-driven and nothing it watches has a sub-minute tolerance.
  for (const bad of ['0', '-5', '0.5']) {
    await assert.rejects(
      () => main(['up', '--foreground', '--interval', bad, '--board', 'nope']),
      (e: Error & { exitCode?: number }) => {
        assert.equal(e.exitCode, 2, 'a usage error, not a crash');
        assert.match(e.message, /at least 1/);
        assert.match(e.message, /the default is 45/, 'an error says what to do next');
        return true;
      },
      `--interval ${bad} should be refused`,
    );
  }
});

// ---------------------------------------------------------------- log --since

const { parseDuration } = await import('../src/hkb.ts');

test('parseDuration reads the four units', () => {
  assert.equal(parseDuration('90s'), 90_000);
  assert.equal(parseDuration('30m'), 1_800_000);
  assert.equal(parseDuration('2h'), 7_200_000);
  assert.equal(parseDuration('3d'), 259_200_000);
  assert.equal(parseDuration('  2h  '), 7_200_000, 'a shell that leaves whitespace is not a mistake');
});

test('parseDuration refuses a bare number and names the units', () => {
  // The whole point of the guard: `sleep` means seconds, `find -mtime` means days, so a bare `30`
  // is off by 1440 half the time and silently — a too-wide window still prints plausible events.
  for (const bad of ['30', '0', '1.5']) {
    assert.throws(
      () => parseDuration(bad),
      (e: Error & { exitCode?: number }) => {
        assert.equal(e.exitCode, 2, 'a usage error, not a crash');
        assert.match(e.message, /has no unit/);
        assert.match(e.message, /m \(minutes\)/, 'and says which units exist');
        return true;
      },
      `--since ${bad} should be refused`,
    );
  }
});

test('parseDuration refuses a unit it does not have', () => {
  assert.throws(() => parseDuration('2w'), /does not know the unit "w".*d \(days\)/s);
  assert.throws(() => parseDuration('2ms'), /does not know the unit "ms"/);
});

test('parseDuration refuses empty, and says what one looks like', () => {
  assert.throws(() => parseDuration(''), /wants a duration like 30m/);
  assert.throws(() => parseDuration('   '), /wants a duration like 30m/);
});

test('parseDuration refuses a duration that points forwards', () => {
  // `--since` reads backwards from now, so a negative one has no meaning to fall back on.
  assert.throws(() => parseDuration('-30m'), /positive duration, got -30m/);
  assert.throws(() => parseDuration('0m'), /positive duration/);
});

test('parseDuration refuses what is not a duration at all', () => {
  for (const bad of ['lunch', 'm', '1h30m', '--json']) {
    assert.throws(() => parseDuration(bad), /does not understand|has no unit/, `${bad} should be refused`);
  }
});

test('parseDuration names the flag it was given, so the message fits the caller', () => {
  assert.throws(() => parseDuration('30', '--within'), /--within 30 has no unit/);
});

test('log --since keeps only what is newer, and drops what is older', async () => {
  const j = json((await hkb('new', 'lunchtime', '--brief', 'b', '--board', 'window', '--json')).out);
  const board = await db.board.findUniqueOrThrow({ where: { slug: 'window' } });
  await db.event.create({
    data: { kind: 'ancient', jobId: j.id, boardId: board.id, at: new Date(Date.now() - 6 * 3_600_000) },
  });
  await db.event.create({
    data: { kind: 'justnow', jobId: j.id, boardId: board.id, at: new Date(Date.now() - 60_000) },
  });
  const kinds = json((await hkb('log', '--board', 'window', '--since', '1h', '--json')).out)
    .map((e: { kind: string }) => e.kind);
  assert.ok(kinds.includes('justnow'));
  assert.ok(!kinds.includes('ancient'), 'six hours ago is not in the last hour');
});

test('log --since composes with -n and with a Job id', async () => {
  const other = json((await hkb('new', 'not-in-the-window', '--brief', 'b', '--board', 'window', '--json')).out);
  const both = json((await hkb('log', String(other.id), '--board', 'window', '--since', '1h', '--json')).out);
  assert.ok(both.length >= 1);
  assert.ok(both.every((e: { jobId: number }) => e.jobId === other.id), '--since narrows, it does not widen');

  const capped = json((await hkb('log', '--board', 'window', '--since', '1h', '-n', '1', '--json')).out);
  assert.equal(capped.length, 1, 'both apply: the window narrows, the count caps');
});

test('log --since says the window was empty rather than that the log is', async () => {
  // "nothing recorded yet" on a board with a month of history reads as data loss.
  const board = await db.board.create({ data: { slug: 'quiet' } });
  await db.event.create({
    data: { kind: 'long_ago', boardId: board.id, at: new Date(Date.now() - 30 * 86_400_000) },
  });
  const r = await hkb('log', '--board', 'quiet', '--since', '2h');
  assert.match(r.out, /nothing on quiet in the last 2h/);
  assert.match((await hkb('log', '--board', 'quiet')).out, /long_ago/, 'and the log itself is not empty');
});

test('log --since refuses a bad duration before it queries anything', async () => {
  await assert.rejects(() => main(['log', '--board', 'window', '--since', '30']), /has no unit/);
});

// ---------------------------------------------------------------- one machine, many repositories

const { resolveBoard, gitRoot } = await import('../src/hkb.ts');

/** A throwaway repository, so "which board does this cwd mean" can be asked somewhere real. */
function scratchRepo(name: string): string {
  const root = path.join(dir, name);
  fs.mkdirSync(root, { recursive: true });
  const git = (...a: string[]) => execFileSync('git', a, { cwd: root, stdio: 'ignore' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 's@t');
  git('config', 'user.name', 's');
  fs.writeFileSync(path.join(root, 'README.md'), '# scratch\n');
  git('add', '-A');
  git('commit', '-qm', 'base');
  return fs.realpathSync(root);
}

test('--board wins over where you are standing', async () => {
  const s = await resolveBoard(db, 'explicit', REPO);
  assert.equal(s.slug, 'explicit');
});

test('a repository with a board resolves to that board, whatever it is called', async () => {
  const root = scratchRepo('named-repo');
  await db.board.create({ data: { slug: 'nothing-like-the-directory', repoPath: root } });
  const s = await resolveBoard(db, undefined, root);
  assert.equal(s.slug, 'nothing-like-the-directory', 'matched on repoPath, not on the folder name');
  assert.equal(s.known, true);
});

test('two boards on one repository refuses instead of picking one, and names both', async () => {
  // `hkb boards add` allows this deliberately — different budgets for different work — so both
  // answers are valid and neither is inferable. Silently taking the older one is the bug.
  const root = scratchRepo('two-boards');
  await db.board.create({ data: { slug: 'zeta-budget', repoPath: root } });
  await db.board.create({ data: { slug: 'alpha-budget', repoPath: root } });
  await assert.rejects(
    () => resolveBoard(db, undefined, root),
    (e: Error & { exitCode?: number }) => {
      assert.equal(e.exitCode, 2, 'a usage error, not a crash');
      assert.match(e.message, /alpha-budget/);
      assert.match(e.message, /zeta-budget/);
      assert.match(e.message, /--board <slug>/, 'an error says what to do next');
      return true;
    },
  );
  // And naming one still resolves: the refusal is about the guess, not about the repository.
  assert.equal((await resolveBoard(db, 'zeta-budget', root)).slug, 'zeta-budget');
});

test('a repository with no board resolves to one named after it, ready to be created', async () => {
  const root = scratchRepo('unregistered');
  const s = await resolveBoard(db, undefined, root);
  assert.equal(s.slug, 'unregistered');
  assert.equal(s.repoPath, root);
  assert.equal(s.known, false, 'reading verbs find nothing, which is the truth');
});

test('outside a repository there is nothing to infer, so it is `default`', async () => {
  const notARepo = fs.mkdtempSync(path.join(os.tmpdir(), 'hkb-bare-'));
  try {
    assert.equal(gitRoot(notARepo), null);
    const s = await resolveBoard(db, undefined, notARepo);
    assert.equal(s.slug, 'default');
    assert.equal(s.repoPath, null);
  } finally {
    fs.rmSync(notARepo, { recursive: true, force: true });
  }
});

test('filing work in a repository points its new board at that checkout', async () => {
  // Without this a machine-level daemon would have nowhere to cut the worktree — the whole reason
  // `repoPath` is a column rather than the daemon's cwd.
  const root = scratchRepo('files-work');
  const before = process.cwd();
  process.chdir(root);
  try {
    const j = json((await hkb('new', 'from here', '--brief', 'b', '--json')).out);
    assert.equal(j.board, 'files-work');
    const board = await db.board.findUniqueOrThrow({ where: { slug: 'files-work' } });
    assert.equal(board.repoPath, root);
  } finally {
    process.chdir(before);
  }
});

test('hkb boards add refuses a path that is not a repository, and says why', async () => {
  const notARepo = fs.mkdtempSync(path.join(os.tmpdir(), 'hkb-nope-'));
  try {
    await assert.rejects(
      () => main(['boards', 'add', 'bogus', '--repo', notARepo]),
      (e: Error & { exitCode?: number }) => {
        assert.equal(e.exitCode, 2);
        assert.match(e.message, /not a git repository/);
        return true;
      },
    );
    assert.equal(await db.board.findUnique({ where: { slug: 'bogus' } }), null, 'and nothing was created');
  } finally {
    fs.rmSync(notARepo, { recursive: true, force: true });
  }
});

test('hkb boards add points a board at a repository, and re-pointing is not an error', async () => {
  const a = scratchRepo('target-a');
  const b = scratchRepo('target-b');
  await hkb('boards', 'add', 'moved', '--repo', a);
  assert.equal((await db.board.findUniqueOrThrow({ where: { slug: 'moved' } })).repoPath, a);
  await hkb('boards', 'add', 'moved', '--repo', b);
  assert.equal((await db.board.findUniqueOrThrow({ where: { slug: 'moved' } })).repoPath, b,
    'repositories move; a board should not have to be recreated when one does');
});

test('hkb boards lists every board on the machine with its repository', async () => {
  const rows = json((await hkb('boards', '--json')).out);
  const moved = rows.find((r: { board: string }) => r.board === 'moved');
  assert.ok(moved, 'the cluster view is one query, not a hunt across checkouts');
  assert.equal(moved.daemon, 'down');
  assert.equal(typeof moved.spent24h, 'number');
});

// ---------------------------------------------------------------- the ceilings, without SQL

test('hkb boards set changes the ceilings, and none removes one', async () => {
  // Phase 5 set these with a Prisma one-liner. For a system whose exit criterion is "safe to
  // leave alone", the safety limits being reachable only through SQL is not a small gap.
  const r = scratchRepo('ceilings');
  await hkb('boards', 'add', 'ceilings', '--repo', r);
  const set = json((await hkb('boards', 'set', 'ceilings', '--max-concurrent', '3', '--daily-budget', '40', '--json')).out);
  assert.equal(set.maxConcurrent, 3);
  assert.equal(set.dailyBudgetUsd, 40);

  const off = json((await hkb('boards', 'set', 'ceilings', '--daily-budget', 'none', '--json')).out);
  assert.equal(off.dailyBudgetUsd, null, 'a board with no ceiling is a real configuration, not an unset one');
  assert.equal(off.maxConcurrent, 3, 'and setting one ceiling does not clear the other');
});

test('hkb boards set refuses a nonsense ceiling rather than storing it', async () => {
  const r = scratchRepo('bad-ceilings');
  await hkb('boards', 'add', 'bad-ceilings', '--repo', r);
  for (const [flag, value, why] of [
    ['--max-concurrent', '-1', /whole number of slots/],
    ['--max-concurrent', '1.5', /whole number of slots/],
    ['--daily-budget', '-5', /dollars, 0 or more/],
  ] as [string, string, RegExp][]) {
    await assert.rejects(
      () => main(['boards', 'set', 'bad-ceilings', flag, value]),
      (e: Error & { exitCode?: number }) => { assert.equal(e.exitCode, 2); assert.match(e.message, why); return true; },
      `${flag} ${value} should be refused`,
    );
  }
  const b = await db.board.findUniqueOrThrow({ where: { slug: 'bad-ceilings' } });
  assert.equal(b.maxConcurrent, 1, 'and nothing was written');
});

test('hkb boards set with nothing to set says so, instead of a silent no-op', async () => {
  const r = scratchRepo('empty-set');
  await hkb('boards', 'add', 'empty-set', '--repo', r);
  await assert.rejects(() => main(['boards', 'set', 'empty-set']), /needs something to set/);
});

test('maxConcurrent 0 is allowed — it drains a board without stopping it', async () => {
  const r = scratchRepo('draining');
  await hkb('boards', 'add', 'draining', '--repo', r);
  const set = json((await hkb('boards', 'set', 'draining', '--max-concurrent', '0', '--json')).out);
  assert.equal(set.maxConcurrent, 0);
});

test('hkb boards rejects a subcommand it does not have, rather than listing anyway', async () => {
  await assert.rejects(() => main(['boards', 'remove', 'x']), /no subcommand "remove"/);
  await assert.rejects(() => main(['boards', 'remove', 'x']), /boards set/, 'and lists the ones it does');
});

// ---------------------------------------------------------------- ls --all

test('ls --all lists Jobs from every board, and says which board each is on', async () => {
  await hkb('new', 'far off', '--brief', 'b', '--board', 'far-away');
  const rows = json((await hkb('ls', '--all', '--json')).out);
  const boards = new Set(rows.map((r: { board: string }) => r.board));
  assert.ok(boards.has('far-away'));
  assert.ok(boards.has('switch'), 'a board nobody is standing in still shows up');
  assert.ok(boards.size > 1, 'one query, not one run per board');
});

test('ls --all still filters by phase', async () => {
  const rows = json((await hkb('ls', '--all', '--phase', 'succeeded', '--json')).out);
  assert.ok(rows.length > 0, 'something has succeeded by now');
  assert.ok(rows.every((r: { phase: string }) => r.phase === 'succeeded'));
  assert.ok(rows.every((r: { board: string }) => r.board), 'and every row still names its board');
});

test('ls --json carries the board whether or not --all is given', async () => {
  // A stable shape beats a conditional one: a consumer should not have to remember which flags it
  // passed to know which fields it got.
  const rows = json((await hkb('ls', '--board', 'far-away', '--json')).out);
  assert.ok(rows.length > 0);
  assert.ok(rows.every((r: { board: string }) => r.board === 'far-away'));
});

test('the BOARD column appears only with --all', async () => {
  const all = await hkb('ls', '--all');
  assert.match(all.out, /^far-away\s+#\d+\s+pending/m, 'a column, padded to the longest slug');
  const one = await hkb('ls', '--board', 'far-away');
  assert.match(one.out, /^#\d+\s+pending/m, 'scoped output is unchanged — the board is not news');
});

test('ls --all does not resolve a board it will not read', async () => {
  // Two PRs that were each correct alone and wrong together: `--all` ignores the board scope, but
  // resolution runs before the verb does, so once `resolveBoard` learned to refuse an ambiguous
  // checkout, `ls --all` started refusing on a board it never looks at.
  const root = scratchRepo('shared-checkout');
  await db.board.create({ data: { slug: 'twin-a', repoPath: root } });
  await db.board.create({ data: { slug: 'twin-b', repoPath: root } });
  const before = process.cwd();
  process.chdir(root);
  try {
    await assert.rejects(() => main(['ls']), /boards point at/, 'a scoped ls still refuses, as it should');
    const rows = json((await hkb('ls', '--all', '--json')).out);
    assert.ok(rows.length > 0, 'and --all is unaffected, because it asked for no board');
  } finally {
    process.chdir(before);
  }
});

test('ls refuses --all together with --board rather than guessing which one wins', async () => {
  await assert.rejects(
    () => main(['ls', '--all', '--board', 'far-away']),
    (e: Error & { exitCode?: number }) => {
      assert.equal(e.exitCode, 2, 'a usage error, not a crash');
      assert.match(e.message, /contradict/);
      assert.match(e.message, /Drop whichever you did not mean/, 'an error says what to do next');
      return true;
    },
  );
});

test('ls --all on a machine with no jobs at all says so', async () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'hkb-empty-'));
  const prev = process.env.HKB_DATABASE_URL;
  process.env.HKB_DATABASE_URL = `file:${path.join(empty, 'other.db')}`;
  try {
    await closeBoard();
    const r = await hkb('ls', '--all');
    assert.equal(r.code, 0);
    assert.match(r.out, /no jobs on any board/);
  } finally {
    await closeBoard();
    process.env.HKB_DATABASE_URL = prev;
    fs.rmSync(empty, { recursive: true, force: true });
  }
});
// ---------------------------------------------------------------- boards rm
//
// Removing a board cascades to every Job, Attempt, Lease and Event on it, and the operator who
// runs this may be a worker with nobody to answer a confirmation prompt. So both tests below are
// refusals: what matters is not that the delete works, it is that it declines to.

test('hkb boards rm removes an empty board, and says so in the log', async () => {
  const r = scratchRepo('rm-empty');
  await hkb('boards', 'add', 'rm-empty', '--repo', r);
  const out = json((await hkb('boards', 'rm', 'rm-empty', '--json')).out);
  assert.equal(out.removed, 'rm-empty');
  assert.equal(await db.board.findUnique({ where: { slug: 'rm-empty' } }), null);
  const ev = await db.event.findFirst({ where: { kind: 'board_removed' }, orderBy: { id: 'desc' } });
  assert.equal(ev?.boardId, null, 'a boardId would have cascaded away with the board it names');
  assert.equal((ev?.payload as { slug: string }).slug, 'rm-empty');
});

test('hkb boards rm refuses a board with jobs on it until --force', async () => {
  const r = scratchRepo('rm-busy');
  await hkb('boards', 'add', 'rm-busy', '--repo', r);
  const j = json((await hkb('new', 'still here', '--brief', 'b', '--board', 'rm-busy', '--json')).out);

  await assert.rejects(
    () => main(['boards', 'rm', 'rm-busy']),
    (e: Error & { exitCode?: number }) => {
      assert.equal(e.exitCode, 2);
      assert.match(e.message, /has 1 job\b/);
      assert.match(e.message, /--force/, 'a refusal that does not say how to proceed is a dead end');
      return true;
    },
  );
  assert.ok(await db.job.findUnique({ where: { id: j.id } }), 'and the job is untouched');

  await hkb('boards', 'rm', 'rm-busy', '--force');
  assert.equal(await db.board.findUnique({ where: { slug: 'rm-busy' } }), null);
  assert.equal(await db.job.findUnique({ where: { id: j.id } }), null, 'the jobs went with it');
});

test('hkb boards rm refuses a board a daemon is leading, --force or not', async () => {
  const r = scratchRepo('rm-led');
  await hkb('boards', 'add', 'rm-led', '--repo', r);
  const board = await db.board.findUniqueOrThrow({ where: { slug: 'rm-led' } });
  // This process is alive and this is its hostname, so the row reads as live the same way a real
  // daemon's does — no clock to wind forward.
  await db.controller.create({
    data: {
      boardId: board.id,
      holder: `${os.hostname()}/${process.pid}@daemon`,
      intervalMs: 60_000,
      version: 'v-test',
      expiresAt: new Date(Date.now() + 60 * 60_000),
    },
  });
  try {
    await assert.rejects(
      () => main(['boards', 'rm', 'rm-led', '--force']),
      (e: Error & { exitCode?: number }) => {
        assert.equal(e.exitCode, 2);
        assert.match(e.message, /hkb down/, '`--force` is not a way to delete a board out from under a running controller');
        return true;
      },
    );
    assert.ok(await db.board.findUnique({ where: { slug: 'rm-led' } }), 'and the board is still there');
  } finally {
    await db.controller.deleteMany({ where: { boardId: board.id } });
  }
});


// ---------------------------------------------------------------- the spec defaults
//
// A board that runs cheap, high-volume work should say so once. What has to be true for that to be
// safe: the Job still wins, `none` gets you back to "no opinion", and `hkb show` can tell you which
// level answered — a spec you cannot trace is worse than one you must repeat.

test('a Job queued with structured input stores the RENDERED brief, and refuses a typo', async () => {
  const r = scratchRepo('structured');
  await hkb('boards', 'add', 'structured', '--repo', r);
  const filed = json((await hkb(
    'new', 'review a PR', '--board', 'structured', '--json',
    '--brief', 'Review PR {{pr.number}} in {{pr.repo}} with a {{style}} eye.',
    '--input', 'pr=value:{"number":42,"repo":"example"}',
    '--input', 'style=value:strict',
    '--input', 'schema=file:README.md',
  )).out);

  // A value that went into the brief is not also handed over as a data block.
  assert.deepEqual(filed.inputs, [{ name: 'schema', valueFrom: { file: { path: 'README.md' } } }],
    'the consumed values are gone; the fetched source stays, in the k8s-shaped union');

  const shown = (await hkb('show', String(filed.id), '--board', 'structured')).out;
  assert.match(shown, /brief\s+Review PR 42 in example with a strict eye\./,
    'what the board stores is what the run is given — `hkb show` and the prompt cannot disagree');

  // Refused where the operator is standing, not discovered by a worker.
  await assert.rejects(
    () => main(['new', 'typo', '--board', 'structured', '--brief', 'Look at {{prr}}.', '--input', 'pr=value:1']),
    (e: Error & { exitCode?: number }) => e.exitCode === 2 && /declares no `value:` input called `prr`/.test(e.message),
  );

  // And the line the design rests on: a fetched source may not reach the instruction.
  await assert.rejects(
    () => main(['new', 'nope', '--board', 'structured', '--brief', 'Use {{sch}}.', '--input', 'sch=file:README.md']),
    (e: Error & { exitCode?: number }) =>
      e.exitCode === 2 && /is not a `value:`/.test(e.message) && /reaches the run as data/.test(e.message),
  );
});

test('hkb boards set carries the spec defaults, and none clears one', async () => {
  const r = scratchRepo('defaults');
  await hkb('boards', 'add', 'defaults', '--repo', r);
  const set = json((await hkb(
    'boards', 'set', 'defaults', '--model', 'claude-haiku-4-5', '--effort', 'low',
    '--max-turns', '8', '--max-budget', '0.25', '--max-retries', '0',
    '--allow-tools', 'Read,Grep', '--default-plugin-dirs', '.claude', '--guide', 'CLAUDE.md', '--json',
  )).out);
  assert.deepEqual(set.defaults, {
    model: 'claude-haiku-4-5', effort: 'low', maxTurns: 8, maxBudgetUsd: 0.25, maxRetries: 0,
    allowedTools: ['Read', 'Grep'], pluginPaths: ['.claude'], guide: 'CLAUDE.md',
  });

  const cleared = json((await hkb('boards', 'set', 'defaults', '--model', 'none', '--json')).out);
  assert.equal(cleared.defaults.model, null, 'none clears the default rather than setting the word');
  assert.equal(cleared.defaults.maxTurns, 8, 'and clearing one leaves the others alone');
  assert.equal(cleared.defaults.maxRetries, 0, 'including a default of zero, which is a real answer');
  assert.deepEqual(cleared.defaults.pluginPaths, ['.claude'], 'and the board-wide grant survives clearing a model');
  assert.equal(cleared.defaults.guide, 'CLAUDE.md', 'and so does the guide (ADR-013)');

  // The guide is a path the BOARD reads with the operator's authority and puts in front of a model,
  // so it sits behind the same fence the grant does.
  await assert.rejects(
    () => main(['boards', 'set', 'defaults', '--guide', '../elsewhere/CLAUDE.md']),
    /outside|escape|\.\./,
  );
  const noGuide = json((await hkb('boards', 'set', 'defaults', '--guide', 'none', '--json')).out);
  assert.equal(noGuide.defaults.guide, null, '"none" clears the grant rather than naming a file called none');

  // The grant is a path the board acts on with the operator's authority, so a path that was never
  // legal must not become state — the same fence `--export` sits behind (ADR-012).
  await assert.rejects(
    () => main(['boards', 'set', 'defaults', '--default-plugin-dirs', '../elsewhere']),
    (e: Error & { exitCode?: number }) => e.exitCode === 2 && /escapes the repository/.test(e.message),
    'a grant that escapes the repository is refused at file time, not at run time',
  );

  const gone = json((await hkb('boards', 'set', 'defaults', '--default-plugin-dirs', 'none', '--json')).out);
  assert.equal(gone.defaults.pluginPaths, null, 'and "none" gives the grant back');
});

test('hkb boards set refuses a nonsense default rather than storing it', async () => {
  const r = scratchRepo('bad-defaults');
  await hkb('boards', 'add', 'bad-defaults', '--repo', r);
  for (const [flag, value, why] of [
    ['--effort', 'turbo', /low\|medium\|high\|xhigh\|max/],
    ['--max-turns', '0', /turns, 1 or more/],
    ['--max-turns', '2.5', /turns, 1 or more/],
    ['--max-budget', '0', /dollars above zero/],
    ['--max-budget', '-1', /dollars above zero/],
    ['--max-retries', '-1', /retries, 0 or more/],
    ['--max-retries', '1.5', /retries, 0 or more/],
    ['--model', '', /pass a value/],
  ] as [string, string, RegExp][]) {
    await assert.rejects(
      () => main(['boards', 'set', 'bad-defaults', flag, value]),
      (e: Error & { exitCode?: number }) => {
        assert.equal(e.exitCode, 2);
        assert.match(e.message, why);
        // Every one of these has to name the way out, or an operator who typed a bad value has no
        // way to learn that "no opinion" is even expressible.
        assert.match(e.message, /none/, `${flag} ${value} must name "none" as the way to clear it`);
        return true;
      },
      `${flag} ${value} should be refused`,
    );
  }
  const b = await db.board.findUniqueOrThrow({ where: { slug: 'bad-defaults' } });
  assert.equal(b.defaultModel, null, 'and nothing was written');
  assert.equal(b.defaultMaxTurns, null);
});

test('a Job filed without a flag records null, so the board can still answer', async () => {
  // The whole mechanism turns on this. A Job that recorded 20 turns because nobody said otherwise
  // would outrank its board's default for ever, and the default would be dead on arrival.
  const repo = scratchRepo('unset');
  await hkb('boards', 'add', 'unset', '--repo', repo);
  const r = await hkb('new', 'says-nothing', '--brief', 'x', '--board', 'unset', '--json');
  const row = await db.job.findUniqueOrThrow({ where: { id: json(r.out).id } });
  assert.equal(row.maxTurns, null);
  assert.equal(row.maxBudgetUsd, null);
  assert.equal(row.maxRetries, null);
  assert.equal(row.model, null);
});

test('hkb show names the source of every resolved field', async () => {
  const repo = scratchRepo('traced');
  await hkb('boards', 'add', 'traced', '--repo', repo);
  await hkb('boards', 'set', 'traced', '--model', 'claude-haiku-4-5', '--max-turns', '8');
  const id = json((await hkb('new', 'traced-job', '--brief', 'x', '--board', 'traced',
    '--max-budget', '2', '--json')).out).id;

  const out = (await hkb('show', String(id), '--board', 'traced')).out;
  assert.match(out, /model\s+claude-haiku-4-5\s+from board traced/);
  assert.match(out, /maxTurns\s+8\s+from board traced/);
  assert.match(out, /maxBudget\s+\$2\s+set on the Job/);
  assert.match(out, /maxRetries\s+2\s+built-in default/, 'the last resort says so too');

  // And in --json, where a consumer needs the provenance without parsing a table.
  const j = json((await hkb('show', String(id), '--board', 'traced', '--json')).out);
  assert.deepEqual(j.spec.model, { value: 'claude-haiku-4-5', from: 'board' });
  assert.deepEqual(j.spec.maxBudgetUsd, { value: 2, from: 'job' });
  assert.deepEqual(j.spec.maxRetries, { value: 2, from: 'built-in' });
});

test('hkb show reports the cap an attempt was FROZEN at, not what the board says today', async () => {
  const repo = scratchRepo('frozen-show');
  await hkb('boards', 'add', 'frozen-show', '--repo', repo);
  await hkb('boards', 'set', 'frozen-show', '--max-budget', '3');
  const id = json((await hkb('new', 'ran-at-three', '--brief', 'x', '--board', 'frozen-show', '--json')).out).id;
  await db.attempt.create({
    data: {
      jobId: id, k: 1, startedAt: new Date(), endedAt: new Date(),
      outcome: 'max_budget', costUsd: 3, maxBudgetUsd: 3,
    },
  });
  // The operator reacts to the bill by lowering the board's default. The attempt is history.
  await hkb('boards', 'set', 'frozen-show', '--max-budget', '0.5');

  const out = (await hkb('show', String(id), '--board', 'frozen-show')).out;
  assert.match(out, /max_budget\s+\S+\s+\$3\.0000 of \$3\.00/,
    'spent against the cap that actually stopped it — re-resolving would print $0.50');
  assert.match(out, /maxBudget\s+\$0\.5\s+from board frozen-show/,
    'while the spec block shows what the NEXT attempt would get, which is the other question');
});

test('hkb retry does not crash on a Job whose cap came from the board', async () => {
  // `job.maxBudgetUsd` is null for the commonest Job there is — one filed with no `--max-budget`.
  // Read raw, the guard that exists to refuse a pointless re-queue threw instead of refusing.
  const repo = scratchRepo('retry-inherited');
  await hkb('boards', 'add', 'retry-inherited', '--repo', repo);
  await hkb('boards', 'set', 'retry-inherited', '--max-budget', '3');
  const id = json((await hkb('new', 'spent-it', '--brief', 'x', '--board', 'retry-inherited', '--json')).out).id;
  await db.attempt.create({
    data: {
      jobId: id, k: 1, startedAt: new Date(), endedAt: new Date(),
      outcome: 'max_budget', costUsd: 3, maxBudgetUsd: 3,
    },
  });
  await db.job.update({ where: { id }, data: { phase: 'failed' } });

  await assert.rejects(
    () => main(['retry', String(id), '--board', 'retry-inherited']),
    (e: Error & { exitCode?: number }) => {
      assert.equal(e.exitCode, 2, 'a refusal, not a TypeError');
      assert.match(e.message, /\$3\.00 budget/, 'and it names the cap the attempt really ran under');
      assert.match(e.message, /--max-budget 6\.00/);
      return true;
    },
  );

  // Raising the BOARD's default is also a real raise: the next attempt genuinely gets more, so
  // refusing that retry would send an operator to override a limit no longer in the way.
  await hkb('boards', 'set', 'retry-inherited', '--max-budget', '10');
  const ok = json((await hkb('retry', String(id), '--board', 'retry-inherited', '--json')).out);
  assert.equal(ok.maxBudgetUsd, 10, 'the retry runs under the board\'s new default');
  assert.equal((await db.job.findUniqueOrThrow({ where: { id } })).maxBudgetUsd, null,
    'and nothing was written onto the Job — it still has no opinion of its own');
});

test('hkb boards prints a defaults line only for the boards that have one', async () => {
  const repo = scratchRepo('listed-defaults');
  await hkb('boards', 'add', 'listed-defaults', '--repo', repo);
  await hkb('boards', 'set', 'listed-defaults', '--model', 'claude-haiku-4-5');
  const out = (await hkb('boards')).out;
  assert.match(out, /defaults\s+model=claude-haiku-4-5/);

  const rows = json((await hkb('boards', '--json')).out) as { board: string; hasDefaults: boolean; defaults: unknown }[];
  const mine = rows.find((r) => r.board === 'listed-defaults');
  assert.equal(mine?.hasDefaults, true);
  const bare = rows.find((r) => r.board !== 'listed-defaults' && !r.hasDefaults);
  assert.ok(bare, 'a board with no defaults exists in this suite');
  assert.deepEqual(bare.defaults,
    { model: null, effort: null, maxTurns: null, maxBudgetUsd: null, maxRetries: null, allowedTools: null, pluginPaths: null, guide: null },
    '--json carries the key either way: a consumer inferring absence from a missing key reads a shape, not a record');
});

/**
 * `hkb version`, and the one thing about it that is not cosmetic.
 *
 * The release workflow installs the freshly published tarball on a clean runner and matches this
 * output's tail against the tag, so a build that cannot say what it is fails the release rather
 * than shipping. Written as a refusal: run it in a subprocess pointed at a board file that does
 * not exist, and prove the file is STILL not there afterwards. Every other verb creates and
 * migrates the board on first touch, and a version check that did the same would leave a database
 * behind on a machine whose owner only asked what they had installed.
 */
test('hkb version prints the package version, and opens no board doing it', () => {
  const home = fs.mkdtempSync(path.join(dir, 'version-'));
  const board = path.join(home, 'never-created.db');
  const env = { ...process.env, HKB_DATABASE_URL: `file:${board}` };
  const entry = path.join(REPO, 'bin', 'hkb.ts');
  const expected = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8')).version;

  const out = execFileSync(process.execPath, [entry, 'version'], { env, cwd: home, encoding: 'utf8' });
  assert.equal(out, `hkb ${expected}\n`, 'the release verify matches this against the tag, tail-anchored');
  assert.equal(fs.existsSync(board), false, 'asking what is installed must not create a board');

  const asJson = JSON.parse(execFileSync(process.execPath, [entry, 'version', '--json'], { env, cwd: home, encoding: 'utf8' }));
  assert.deepEqual(asJson, { version: expected });
  assert.equal(fs.existsSync(board), false);
});

/**
 * Finding 11: `succeeded` does not mean "produced anything".
 *
 * The machinery never required a pull request — `withProtocol` asks for one in prose, only when the
 * Job is isolated, and `nextPhase` reads the runtime's status alone. That is deliberate: "I looked,
 * and there is nothing to change" is a real outcome. What was not acceptable is that such a Job read
 * *identically* to one that shipped a diff, so a board of fifty succeeded Jobs where five produced
 * nothing looked uniform.
 *
 * Tested as a refusal at both layers: the pure predicate must say no for every shape that DID
 * produce something, and the listing must actually print the marker — a predicate nothing renders is
 * the silently-inert guard this project has shipped three times.
 */
const { producedNothing, declaredExports, describeDefaults } = await import('../src/hkb.ts');

test('producedNothing refuses every Job that left something behind', () => {
  const bare = { phase: 'succeeded', pr: null, exports: [] as string[] };
  assert.equal(producedNothing(bare), true, 'succeeded, no PR, nothing declared — the case that matters');

  assert.equal(producedNothing({ ...bare, pr: 'https://github.com/x/y/pull/1' }), false, 'a pull request is an artifact');
  assert.equal(producedNothing({ ...bare, exports: ['docs/report.md'] }), false,
    'a declared export counts without re-checking: a path the run did not write already failed the attempt');
  assert.equal(producedNothing({ ...bare, results: ['finding'] }), false,
    'and so does a declared result — the output of a Job that makes no commit at all');

  // A proposing Job only reaches `succeeded` once the controller has FILED what it proposed, so
  // rows on the board are its output — the most concrete thing anything here produces. Marking it
  // "produced nothing" was this complaint misreading its own answer, seen on a live run.
  assert.equal(producedNothing({ ...bare, proposes: 'jobs' }), false,
    'a proposer that succeeded has filed Jobs, which is not nothing');
  assert.equal(producedNothing({ ...bare, proposes: null }), true, 'and the column being present changes nothing on its own');

  // Only `succeeded` is news. A failed Job with nothing to show is not a finding, and marking it
  // would be the noise that stops a signal being read.
  for (const phase of ['pending', 'running', 'failed', 'suspended', 'done', 'cancelled']) {
    assert.equal(producedNothing({ ...bare, phase }), false, `${phase} is not marked`);
  }
});

test('declaredExports survives whatever is in the Json column', () => {
  assert.deepEqual(declaredExports(['a', 'b']), ['a', 'b']);
  assert.deepEqual(declaredExports(null), []);
  assert.deepEqual(declaredExports(undefined), []);
  assert.deepEqual(declaredExports('docs/x.md'), [], 'a bare string is not a list of paths');
  assert.deepEqual(declaredExports([1, 'a', null]), ['a'], 'and non-strings are dropped rather than printed');
});

test('hkb ls says so when a succeeded Job produced nothing, and stays quiet when one did', async () => {
  const repo = scratchRepo('produced-nothing');
  await hkb('boards', 'add', 'produced-nothing', '--repo', repo);
  const board = await db.board.findUniqueOrThrow({ where: { slug: 'produced-nothing' } });

  const empty = await db.job.create({
    data: { boardId: board.id, name: 'looked and found nothing', brief: 'x', phase: 'succeeded' },
  });
  const shipped = await db.job.create({
    data: { boardId: board.id, name: 'opened a pull request', brief: 'x', phase: 'succeeded' },
  });
  await db.attempt.create({
    data: {
      jobId: shipped.id, k: 1, host: 'h', maxBudgetUsd: 1,
      branch: `kb-${shipped.id}-1`, prNumber: 7, prUrl: 'https://github.com/x/y/pull/7',
    },
  });

  const out = (await hkb('ls', '--board', 'produced-nothing')).out;
  const line = (id: number) => out.split('\n').find((l) => l.includes(`#${id}`)) ?? '';
  assert.match(line(empty.id), /produced nothing/, 'the absence is on the row, not only in `hkb show`');
  assert.doesNotMatch(line(shipped.id), /produced nothing/, 'and a Job that shipped is not accused of it');
  assert.match(out, /1 of 2 succeeded Jobs? produced no pull request and declared no outputs\./,
    'and the count is the aggregate the finding asked for');

  const rows = json((await hkb('ls', '--board', 'produced-nothing', '--json')).out) as
    { id: number; pr: string | null; exports: string[]; producedNothing: boolean }[];
  const row = (id: number) => rows.find((r) => r.id === id)!;
  assert.equal(row(empty.id).producedNothing, true);
  assert.deepEqual([row(empty.id).pr, row(empty.id).exports], [null, []],
    '--json carries the facts, not only the verdict');
  assert.equal(row(shipped.id).producedNothing, false);
  assert.equal(row(shipped.id).pr, 'https://github.com/x/y/pull/7');
});

test('a succeeded Job that declared an export is not marked, even with no pull request', async () => {
  // The `--no-isolate` shape ADR-008 exists for: no branch, no PR, and a deliverable anyway.
  const repo = scratchRepo('exported-only');
  await hkb('boards', 'add', 'exported-only', '--repo', repo);
  const board = await db.board.findUniqueOrThrow({ where: { slug: 'exported-only' } });
  const job = await db.job.create({
    data: {
      boardId: board.id, name: 'wrote a report', brief: 'x', phase: 'succeeded',
      isolate: false, exports: ['docs/report.md'],
    },
  });

  const out = (await hkb('ls', '--board', 'exported-only')).out;
  assert.doesNotMatch(out, /produced nothing/, 'a declared export IS the artifact');
  const rows = json((await hkb('ls', '--board', 'exported-only', '--json')).out) as
    { id: number; exports: string[]; producedNothing: boolean }[];
  assert.deepEqual(rows.find((r) => r.id === job.id)?.exports, ['docs/report.md']);
});

test('retry refuses a proposer whose proposal has already been filed', async () => {
  const j = json((await hkb('new', 'already filed', '--brief', 'b', '--board', 'suite-repo', '--propose', '--json')).out);
  // The state a real one reaches after `hkb approve` and one reconcile pass: succeeded, with an
  // `applied` event. Retrying it would find the same approval, re-file rows the unique key already
  // refuses, and finish it again without the worker ever running — a retry that quietly does
  // nothing, which is the failure mode this project has shipped before.
  await db.job.update({ where: { id: j.id }, data: { phase: 'succeeded' } });
  await db.event.create({
    data: { kind: 'applied', jobId: j.id, actor: 'ada', payload: { filed: [999], already: 0, attempt: 1 } },
  });
  await assert.rejects(() => hkb('retry', String(j.id), '--board', 'suite-repo'), /already been filed[\s\S]*file a new Job/);

  // An ordinary Job in the same phase is still retryable: the refusal is about the proposal having
  // been applied, not about the Job being finished.
  const plain = json((await hkb('new', 'ordinary', '--brief', 'b', '--board', 'suite-repo', '--json')).out);
  await db.job.update({ where: { id: plain.id }, data: { phase: 'succeeded' } });
  assert.equal((await hkb('retry', String(plain.id), '--board', 'suite-repo')).code, 0);
});

test('a run that only filed a proposal does not report "nothing pending"', async () => {
  const j = json((await hkb('new', 'proposes two', '--brief', 'b', '--board', 'suite-repo', '--propose', '--json')).out);
  // The state after a proposing run and an approval, seeded directly: the fake runtime writes no
  // files, and what is under test here is the reporting rather than the proposing.
  await db.attempt.create({
    data: {
      jobId: j.id, k: 1, maxBudgetUsd: 1, outcome: 'completed', endedAt: new Date(),
      proposal: { jobs: [{ name: 'first', brief: 'x' }, { name: 'second', brief: 'y' }], clamped: [] },
    },
  });
  await db.event.create({ data: { kind: 'approved', jobId: j.id, actor: 'ada', payload: {} } });

  const r = await hkb('run', String(j.id), '--fake', '--board', 'suite-repo');
  assert.doesNotMatch(r.out, /nothing to do|nothing pending/,
    'the pass created two Jobs — saying it did nothing is the opposite of what happened');
  assert.match(r.out, /2 filed from a proposal/);
  assert.equal(await db.job.count({ where: { proposedByJobId: j.id } }), 2);
});
// ---------------------------------------------------------------- watch

test('watch refuses the two ways of asking it two things at once', async () => {
  await assert.rejects(() => hkb('watch', '--all', '--board', 'other'), /contradict/);
  // Both name where to start and mean different things; picking one silently would make the same
  // command line join the stream in two different places depending on flag order.
  await assert.rejects(() => hkb('watch', '--board', 'suite-repo', '--after', '1', '--since', '5m'), /--after <id>.*--since <dur>/s);
  await assert.rejects(() => hkb('watch', '--board', 'suite-repo', '999999'), /no Job #999999/);
});

test('watch streams NDJSON on stdout, one event per line, each carrying its cursor', async () => {
  const j = json((await hkb('new', 'watched', '--brief', 'b', '--board', 'suite-repo', '--json')).out);
  // `-n` bounds it so the test terminates; `--after 0` replays from the start of this board.
  const r = await hkb('watch', String(j.id), '--board', 'suite-repo', '--after', '0', '-n', '1', '--json', '--timeout', '10');
  assert.equal(r.code, 0);
  const lines = r.out.trim().split('\n');
  assert.equal(lines.length, 1, 'a stream is one object per line, not one object at the end');
  const e = json(lines[0]);
  assert.equal(e.kind, 'created');
  assert.equal(e.jobId, j.id);
  assert.ok(e.id > 0, 'and the id is what `--after` takes back');
});

test('the board defaults line names every grant, including the ones nobody can otherwise see', () => {
  // A board-wide grant that prints nothing is state that becomes a surprise: `allowTools` decides
  // what every Job on the board may DO, `plugins` what it may READ, and `guide` what it is told to
  // FOLLOW. This is the one line an operator reads to find out, so it is asserted whole rather than
  // field by field — the same reason the resolved-spec test in test/spec.test.ts loops.
  assert.equal(
    describeDefaults({
      model: 'claude-haiku-4-5', effort: 'low', maxTurns: 8, maxBudgetUsd: 0.25, maxRetries: 0,
      allowedTools: ['Read', 'Grep'], pluginPaths: ['.claude'], guide: 'CLAUDE.md',
    }),
    'model=claude-haiku-4-5 effort=low maxTurns=8 maxBudget=$0.25 maxRetries=0 allowTools=Read|Grep plugins=.claude guide=CLAUDE.md',
  );
  assert.equal(
    describeDefaults({ model: null, effort: null, maxTurns: null, maxBudgetUsd: null, maxRetries: null, allowedTools: null, pluginPaths: null, guide: null }),
    '(none)',
  );
  // An empty list is a value and says so; a null is an absence and says nothing.
  assert.match(
    describeDefaults({ model: null, effort: null, maxTurns: null, maxBudgetUsd: null, maxRetries: null, allowedTools: [], pluginPaths: [], guide: null }),
    /allowTools=\(none\) plugins=\(none\)/,
  );
});

// ---------------------------------------------------------------- triage

test('--triage files a note without a brief, and it is not queued', async () => {
  // The capture path, and it has to be one line: a note that demanded a brief would not get
  // written down, which is the whole failure this state exists to prevent.
  const j = json((await hkb('new', 'the --status budget accounting is wrong', '--board', 'suite-repo', '--triage', '--json')).out);
  const row = await db.job.findUniqueOrThrow({ where: { id: j.id } });
  assert.equal(row.phase, 'triage');
  assert.equal(row.brief, 'the --status budget accounting is wrong', 'the name IS the brief until somebody decides');

  // And filing normally is unchanged: no phase, and a brief is still required.
  await assert.rejects(() => hkb('new', 'no brief', '--board', 'suite-repo'), /--brief|--brief-file/);
  const plain = json((await hkb('new', 'ordinary', '--brief', 'b', '--board', 'suite-repo', '--json')).out);
  assert.equal((await db.job.findUniqueOrThrow({ where: { id: plain.id } })).phase, 'pending');
});

test('queue turns a note into work, optionally re-briefed, and refuses anything else', async () => {
  const j = json((await hkb('new', 'a thing I noticed', '--board', 'suite-repo', '--triage', '--json')).out);
  await hkb('queue', String(j.id), 'Fix it properly: read src/limits.ts first.', '--board', 'suite-repo');
  const row = await db.job.findUniqueOrThrow({ where: { id: j.id } });
  assert.equal(row.phase, 'pending');
  assert.equal(row.brief, 'Fix it properly: read src/limits.ts first.',
    'the moment it stops being a note is the moment the brief has to say what to DO');

  // Queueing what is already queued is a mistake worth naming rather than a no-op.
  await assert.rejects(() => hkb('queue', String(j.id), '--board', 'suite-repo'), /already queued/);
  // And the event stream says a person decided.
  const ev = await db.event.findFirstOrThrow({ where: { jobId: j.id, kind: 'queued' } });
  assert.deepEqual(ev.payload, { rebriefed: true });
});

test('triage is the way back, and it refuses a Job that has started', async () => {
  const j = json((await hkb('new', 'filed in haste', '--brief', 'b', '--board', 'suite-repo', '--json')).out);
  await hkb('triage', String(j.id), '--board', 'suite-repo');
  assert.equal((await db.job.findUniqueOrThrow({ where: { id: j.id } })).phase, 'triage',
    'a pending Job can be deferred without being cancelled, which would throw the note away');
  await assert.rejects(() => hkb('triage', String(j.id), '--board', 'suite-repo'), /already in triage/);

  // Not a way to unwind work that happened: those have their own verbs, and the message says so.
  const done = json((await hkb('new', 'already ran', '--brief', 'b', '--board', 'suite-repo', '--json')).out);
  await db.job.update({ where: { id: done.id }, data: { phase: 'succeeded' } });
  await assert.rejects(() => hkb('triage', String(done.id), '--board', 'suite-repo'), /hkb retry|hkb cancel/);
});

test('--phase triage is the inbox', async () => {
  const rows = json((await hkb('ls', '--phase', 'triage', '--board', 'suite-repo', '--json')).out) as { phase: string }[];
  assert.ok(rows.length > 0);
  assert.ok(rows.every((r) => r.phase === 'triage'), 'and it lists nothing else');
});

/**
 * `hkb new --from` — the template primitive (ADR-015 decision 3).
 *
 * `src/templates.ts` owns the format and its refusals; what is asserted here is the CLI's half: that
 * a workflow's keys really do arrive as the flags they are named after, and that an explicit flag
 * beats the file. The precedence is the failing case that matters — a workflow quietly outranking a
 * `--model` the operator typed breaks nothing and runs the wrong thing.
 */
const workflow = (name: string, text: string) => {
  const dir = path.join(HOME_REPO, '.hkb', 'workflows');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${name}.md`), text);
};

test('a workflow`s frontmatter arrives as the flags it is named after', async () => {
  workflow('paged', [
    '---', 'name: paged', 'description: Draft one page', 'model: claude-opus-5', 'max-budget: 2',
    'max-turns: 40', 'allow-tool: [Read, Grep, Write]', 'plugin-dir: [.claude]', 'guide: README.md',
    'gate: does this earn its place?', 'result: [verdict]', '---', '', 'Draft the page.', '',
  ].join('\n'));
  const r = await hkb('new', 'a page', '--from', 'paged', '--board', 'suite-repo', '--json');
  const j = json(r.out) as { id: number; from: string };
  assert.equal(j.from, 'paged');
  const row = await db.job.findUniqueOrThrow({ where: { id: j.id } });
  assert.equal(row.brief, 'Draft the page.', 'the body is the brief');
  assert.equal(row.model, 'claude-opus-5');
  assert.equal(row.maxBudgetUsd, 2, '`max-budget: 2` is `--max-budget 2`, parsed by the same code');
  assert.equal(row.maxTurns, 40);
  assert.deepEqual(row.allowedTools, ['Read', 'Grep', 'Write']);
  assert.deepEqual(row.pluginPaths, ['.claude']);
  assert.equal(row.guide, 'README.md');
  assert.equal(row.gate, 'does this earn its place?');
  assert.deepEqual(row.results, ['verdict']);
});

test('a flag on the line WINS over the workflow, and a list replaces rather than appends', async () => {
  const j = json((await hkb(
    'new', 'a page', '--from', 'paged', '--model', 'claude-haiku-5', '--max-budget', '0.5',
    '--allow-tool', 'Read', '--board', 'suite-repo', '--json',
  )).out) as { id: number };
  const row = await db.job.findUniqueOrThrow({ where: { id: j.id } });
  assert.equal(row.model, 'claude-haiku-5', 'the more specific value wins — the same grain as src/spec.ts');
  assert.equal(row.maxBudgetUsd, 0.5);
  assert.deepEqual(row.allowedTools, ['Read'],
    'a narrowed surface has to be narrowable: appending would make a workflow`s grant impossible to reduce');
  assert.equal(row.guide, 'README.md', 'and what the line did not say still comes from the file');
});

test('--brief overrides the body, and the workflow names the Job when nothing else does', async () => {
  const j = json((await hkb('new', '--from', 'paged', '--brief', 'something else', '--board', 'suite-repo', '--json')).out) as { id: number; name: string };
  assert.equal(j.name, 'paged');
  assert.equal((await db.job.findUniqueOrThrow({ where: { id: j.id } })).brief, 'something else');
});

test('a workflow that is not there fails before anything is created, naming the path', async () => {
  const before = await db.job.count();
  await assert.rejects(
    () => hkb('new', 'a page', '--from', 'not-a-workflow', '--board', 'suite-repo'),
    (e: Error & { exitCode?: number }) => {
      assert.equal(e.exitCode, 2);
      assert.match(e.message, /\.hkb[/\\]workflows[/\\]not-a-workflow\.md/);
      return true;
    },
  );
  assert.equal(await db.job.count(), before, 'and no Job was filed');
});

test('a workflow`s placeholders interpolate from `value:` inputs, and are refused when unsupplied', async () => {
  workflow('templated', ['---', 'name: templated', '---', '', 'Draft ONE page at {{page}}.', ''].join('\n'));
  const j = json((await hkb(
    'new', 'a page', '--from', 'templated', '--input', 'page=value:concepts/ceilings', '--board', 'suite-repo', '--json',
  )).out) as { id: number };
  assert.equal((await db.job.findUniqueOrThrow({ where: { id: j.id } })).brief, 'Draft ONE page at concepts/ceilings.');

  // The hole this closes: `renderBrief` leaves a brief alone when a Job declares no input at all, so
  // without a check the Job would be filed with the literal `{{page}}` in its instructions.
  await assert.rejects(
    () => hkb('new', 'a page', '--from', 'templated', '--board', 'suite-repo'),
    /needs `\{\{page\}\}`.*--input page=value:/s,
  );
});
