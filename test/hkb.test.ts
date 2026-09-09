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
    '--allow-tools', 'Read,Grep', '--default-plugin-dirs', '.claude', '--guide', 'CLAUDE.md',
    '--base', 'origin/develop', '--check', 'npm test', '--workflow', 'implement', '--json',
  )).out);
  assert.deepEqual(set.defaults, {
    model: 'claude-haiku-4-5', effort: 'low', maxTurns: 8, maxBudgetUsd: 0.25, maxRetries: 0,
    allowedTools: ['Read', 'Grep'], pluginPaths: ['.claude'], guide: 'CLAUDE.md', base: 'origin/develop',
    check: 'npm test', workflow: 'implement',
  });

  const cleared = json((await hkb('boards', 'set', 'defaults', '--model', 'none', '--json')).out);
  assert.equal(cleared.defaults.model, null, 'none clears the default rather than setting the word');
  assert.equal(cleared.defaults.maxTurns, 8, 'and clearing one leaves the others alone');
  assert.equal(cleared.defaults.maxRetries, 0, 'including a default of zero, which is a real answer');
  assert.deepEqual(cleared.defaults.pluginPaths, ['.claude'], 'and the board-wide grant survives clearing a model');
  assert.equal(cleared.defaults.guide, 'CLAUDE.md', 'and so does the guide (ADR-013)');
  assert.equal(cleared.defaults.check, 'npm test', 'and so does the board-wide completion check (ADR-016)');

  // A shell command with an option-looking word in it is a command, not a flag: `boards set` stores
  // it verbatim, because what it does is not hkb's business — only what it exits with.
  const shell = json((await hkb('boards', 'set', 'defaults', '--check', 'npm test -- --run', '--json')).out);
  assert.equal(shell.defaults.check, 'npm test -- --run');
  const noCheck = json((await hkb('boards', 'set', 'defaults', '--check', 'none', '--json')).out);
  assert.equal(noCheck.defaults.check, null, '"none" clears it, so the board verifies nothing again');

  // The guide is a path the BOARD reads with the operator's authority and puts in front of a model,
  // so it sits behind the same fence the grant does.
  await assert.rejects(
    () => main(['boards', 'set', 'defaults', '--guide', '../elsewhere/CLAUDE.md']),
    /outside|escape|\.\./,
  );
  const noGuide = json((await hkb('boards', 'set', 'defaults', '--guide', 'none', '--json')).out);
  assert.equal(noGuide.defaults.guide, null, '"none" clears the grant rather than naming a file called none');

  // The default workflow: a NAME, checked for being one, and not for the file existing — the usual
  // way to set this is in the pull request that adds the workflow, so requiring the file to be
  // merged already would refuse the one command anybody runs. `hkb new` catches a missing file.
  const noSteps = json((await hkb('boards', 'set', 'defaults', '--workflow', 'none', '--json')).out);
  assert.equal(noSteps.defaults.workflow, null, '"none" appends nothing to a brief again');
  await assert.rejects(
    () => main(['boards', 'set', 'defaults', '--workflow', '../elsewhere/steps']),
    /is not a workflow name/,
  );
  const typed = json((await hkb('boards', 'set', 'defaults', '--workflow', 'implement.md', '--json')).out);
  assert.equal(typed.defaults.workflow, 'implement', 'the `.md` an operator tab-completed is not part of the name');

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
  assert.equal(ok.raised, undefined, 'no --max-budget was typed, so nothing was raised BY this retry');

  // And when one IS typed, `maxBudgetUsd` stays a number and the raise gets its own key. It used to
  // spread `{ maxBudgetUsd: { from, to } }` over the numeric field, so the TYPE of that field
  // changed on the raise path only — a consumer doing arithmetic broke exactly when something
  // interesting happened.
  await db.job.update({ where: { id }, data: { phase: 'failed' } });
  const raised = json((await hkb('retry', String(id), '--board', 'retry-inherited', '--max-budget', '20', '--json')).out);
  assert.equal(raised.maxBudgetUsd, 20, 'still a number');
  assert.deepEqual(raised.raised, { from: 3, to: 20 }, 'and the raise is beside it, not on top of it');
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
    { model: null, effort: null, maxTurns: null, maxBudgetUsd: null, maxRetries: null, allowedTools: null, pluginPaths: null, guide: null, base: null, check: null, workflow: null },
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
const {
  producedNothing, declaredExports, describeDefaults, strayWords, unknownFlags,
} = await import('../src/hkb.ts');

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
      allowedTools: ['Read', 'Grep'], pluginPaths: ['.claude'], guide: 'CLAUDE.md', base: 'origin/develop',
      check: 'npm test', workflow: 'implement',
    }),
    'model=claude-haiku-4-5 effort=low maxTurns=8 maxBudget=$0.25 maxRetries=0 allowTools=Read|Grep plugins=.claude guide=CLAUDE.md base=origin/develop check=npm test workflow=implement',
  );
  assert.equal(
    describeDefaults({ model: null, effort: null, maxTurns: null, maxBudgetUsd: null, maxRetries: null, allowedTools: null, pluginPaths: null, guide: null, base: null, check: null, workflow: null }),
    '(none)',
  );
  // An empty list is a value and says so; a null is an absence and says nothing.
  assert.match(
    describeDefaults({ model: null, effort: null, maxTurns: null, maxBudgetUsd: null, maxRetries: null, allowedTools: [], pluginPaths: [], guide: null, base: null, check: null, workflow: null }),
    /allowTools=\(none\) plugins=\(none\)/,
  );
});

// ---------------------------------------------------------------- triage

test('--base refuses what git would read as an option, at the two places it can be written', async () => {
  // A ref reaches git as a bare argv token: `--upload-pack=<cmd>` is a command, not a branch. The
  // `base:` key of a workflow file is the same string arriving from the repository rather than from
  // the operator, which is why it is refused at the boundary and not only where git is called.
  const r = scratchRepo('base-refusals');
  await hkb('boards', 'add', 'base-refusals', '--repo', r);

  const evil = '--upload-pack=touch /tmp/hkb-PWNED && git-upload-pack';
  await assert.rejects(
    () => hkb('new', 'x', '--board', 'base-refusals', '--brief', 'do it', '--base', evil),
    /--base wants a git ref.*would reach git as an option/s,
  );
  assert.equal(fs.existsSync('/tmp/hkb-PWNED'), false, 'and nothing ran');

  // The board default is the same string arriving from the same kind of source. Refused by the
  // argv guard first here (`given`: a value beginning with a dash is a flag the parser handed over,
  // not a value) — a different sentence, the same refusal, and a `/tmp/hkb-PWNED` that stays absent.
  await assert.rejects(
    () => hkb('boards', 'set', 'base-refusals', '--base', evil),
    /is a flag rather than a value/,
  );
  assert.equal(fs.existsSync('/tmp/hkb-PWNED'), false, 'and nothing ran there either');
  // And `checkRef` itself is still what stands behind it on that verb, for the refs that do not
  // begin with a dash: the argv guard is about argv, and this one is about git.
  await assert.rejects(
    () => hkb('boards', 'set', 'base-refusals', '--base', 'a branch with spaces'),
    /--base wants a git ref/,
  );

  // And a ref that IS one still goes through.
  const ok = json((await hkb('new', 'y', '--board', 'base-refusals', '--brief', 'do it', '--base', 'origin/main', '--json')).out);
  assert.equal(ok.id > 0, true);
});

test('hkb job set edits a filed Job, with the same flags `hkb new` takes', async () => {
  const r = scratchRepo('jobset');
  await hkb('boards', 'add', 'jobset', '--repo', r);
  const id = json((await hkb('new', 'adjust me', '--brief', 'do it', '--board', 'jobset', '--json')).out).id;

  const out = (await hkb(
    'job', 'set', String(id), '--board', 'jobset',
    '--model', 'claude-opus-5', '--max-budget', '5', '--label', 'area=parser', '--allow-tool', 'Read',
  )).out;
  assert.match(out, /2 field|4 field/, 'it says how many moved');
  assert.match(out, /model\s+\(none\) → claude-opus-5/);
  assert.match(out, /maxBudgetUsd\s+\(none\) → 5/);

  const shown = (await hkb('show', String(id), '--board', 'jobset')).out;
  assert.match(shown, /claude-opus-5/);
  assert.match(shown, /area=parser/);

  // `none` clears, the way it does on `hkb boards set`.
  await hkb('job', 'set', String(id), '--board', 'jobset', '--model', 'none');
  assert.equal((await db.job.findUniqueOrThrow({ where: { id } })).model, null);
});

/**
 * A value that lost its quotes (triage #40).
 *
 * The pure half first, exhaustively, because the decision is where the bug lives: which positionals
 * count as stray, which flag to blame, and which invocations must stay legal.
 */
test('strayWords: a positional after a flag is a value that lost its quotes', () => {
  // hkb new "x" --input page=value:the wiki page
  const tokens = [
    { kind: 'positional', index: 0, value: 'new' },
    { kind: 'positional', index: 1, value: 'x' },
    { kind: 'option', index: 2, name: 'input', value: 'page=value:the' },
    { kind: 'positional', index: 4, value: 'wiki' },
    { kind: 'positional', index: 5, value: 'page' },
  ];
  assert.deepEqual(strayWords(tokens), { words: ['wiki', 'page'], after: '--input' });
});

test('strayWords: the flag it blames is the one whose value spilled, not the first on the line', () => {
  const tokens = [
    { kind: 'positional', index: 0, value: 'new' },
    { kind: 'positional', index: 1, value: 'a name' },
    { kind: 'option', index: 2, name: 'board', value: 'b' },
    { kind: 'option', index: 4, name: 'brief', value: 'do' },
    { kind: 'positional', index: 6, value: 'the' },
  ];
  assert.equal(strayWords(tokens).after, '--brief');
});

/**
 * The mirror of the refusing tests, and the half that was missing.
 *
 * The first version of this guard shipped with only "must refuse" cases, and broke four legal
 * invocations that no test covered — `hkb new --triage "…"`, `hkb cancel --board x 12 "why"`,
 * `hkb new --from tmpl "Name"` and `--`. A guard has to be proven not to refuse what people
 * actually type, and each of these is a shape somebody uses.
 */
test('strayWords: a boolean flag changes the ADVICE, not the verdict', () => {
  // A word after a boolean was still silently joined into the name, so it is still refused — but
  // only a flag that consumed something can have spilled it, and "as in --json \"…\"" is advice
  // that produces a different error.
  const afterBoolean = strayWords([
    { kind: 'positional', index: 0, value: 'new' },
    { kind: 'positional', index: 1, value: 'a name' },
    { kind: 'option', index: 2, name: 'json' },
    { kind: 'positional', index: 3, value: 'extra' },
  ]);
  assert.deepEqual(afterBoolean.words, ['extra'], 'still caught — it would have been joined in');
  assert.equal(afterBoolean.after, null, 'and nothing is blamed for spilling it');

  // Nor is a value-taking flag blamed across an intervening boolean: `extra` did not fall out of
  // `--brief`, it fell in after `--json`.
  assert.equal(strayWords([
    { kind: 'positional', index: 0, value: 'new' },
    { kind: 'positional', index: 1, value: 'a name' },
    { kind: 'option', index: 2, name: 'brief', value: 'do it' },
    { kind: 'option', index: 4, name: 'json' },
    { kind: 'positional', index: 5, value: 'extra' },
  ]).after, null);
});

test('strayWords: with no positional before the flags, the first one after IS the name', () => {
  // The frictionless-capture path, which the first version of this guard refused outright.
  assert.deepEqual(strayWords([
    { kind: 'positional', index: 0, value: 'new' },
    { kind: 'option', index: 1, name: 'triage' },
    { kind: 'positional', index: 2, value: 'capture this idea' },
  ]).words, []);
  // `hkb new --from tmpl "My Name"` — the name typed on the line, which the templates page documents.
  assert.deepEqual(strayWords([
    { kind: 'positional', index: 0, value: 'new' },
    { kind: 'option', index: 1, name: 'from', value: 'tmpl' },
    { kind: 'positional', index: 3, value: 'My Name' },
  ]).words, []);
});

test('strayWords: a leading boolean does not make the whole line unguarded', () => {
  // The second wrong version asked whether a positional came before the FIRST flag and gave up if
  // not — so one leading `--triage` disabled the check for every later flag, and the exact triage
  // #40 corruption went through silently. The name is the first positional after the flags; the
  // ones beyond it are leftovers.
  const r = strayWords([
    { kind: 'positional', index: 0, value: 'new' },
    { kind: 'option', index: 1, name: 'triage' },
    { kind: 'positional', index: 2, value: 'review the parser' },
    { kind: 'option', index: 3, name: 'input', value: 'page=value:the' },
    { kind: 'positional', index: 5, value: 'wiki' },
    { kind: 'positional', index: 6, value: 'page' },
  ]);
  assert.deepEqual(r.words, ['wiki', 'page']);
  assert.equal(r.after, '--input');
});

test('strayWords: `--` is the override, because a guard with none is one that gets in the way', () => {
  assert.deepEqual(strayWords([
    { kind: 'positional', index: 0, value: 'new' },
    { kind: 'positional', index: 1, value: 'a name' },
    { kind: 'option', index: 2, name: 'brief', value: 'do it' },
    { kind: 'option-terminator', index: 4 },
    { kind: 'positional', index: 5, value: 'more' },
    { kind: 'positional', index: 6, value: 'words' },
  ]).words, []);
});

test('unknownFlags: a flag nobody declared is a boolean under strict:false, so it is caught here', () => {
  const declared = ['brief', 'board', 'json'];
  assert.deepEqual(unknownFlags([
    { kind: 'positional', index: 0, value: 'new' },
    { kind: 'option', index: 1, name: 'brefi', rawName: '--brefi', value: 'do it' },
  ], declared), ['--brefi']);
  // Named once however many times it is typed, and a declared one is never named.
  assert.deepEqual(unknownFlags([
    { kind: 'option', index: 0, name: 'nope', rawName: '--nope' },
    { kind: 'option', index: 1, name: 'nope', rawName: '--nope' },
    { kind: 'option', index: 2, name: 'json', rawName: '--json' },
  ], declared), ['--nope']);
  assert.deepEqual(unknownFlags([{ kind: 'option', index: 0, name: 'board', value: 'x' }], declared), []);
  // A SHORT flag is echoed as it was typed: `-z` is not `--z`, and showing somebody something they
  // did not write is its own small confusion.
  assert.deepEqual(unknownFlags([{ kind: 'option', index: 0, name: 'z', rawName: '-z' }], declared), ['-z']);
});

test('strayWords: the invocations that must stay legal', () => {
  // A multi-word name, unquoted, BEFORE the flags — `hkb new` joins positionals on purpose.
  assert.deepEqual(strayWords([
    { kind: 'positional', index: 0, value: 'new' },
    { kind: 'positional', index: 1, value: 'my' },
    { kind: 'positional', index: 2, value: 'great' },
    { kind: 'positional', index: 3, value: 'job' },
    { kind: 'option', index: 4, name: 'json' },
  ]).words, []);

  // An option BEFORE the verb: `hkb --json new x` still means what it says.
  assert.deepEqual(strayWords([
    { kind: 'option', index: 0, name: 'json' },
    { kind: 'positional', index: 1, value: 'new' },
    { kind: 'positional', index: 2, value: 'x' },
  ]).words, []);

  // Nothing at all, and a bare verb.
  assert.deepEqual(strayWords([]).words, []);
  assert.deepEqual(strayWords([{ kind: 'positional', index: 0, value: 'ls' }]).words, []);
});

test('an unquoted multi-word value is REFUSED rather than absorbed into the name', async () => {
  // Measured before the fix: `--input page=value:the wiki page` filed a Job named
  // "review the parser wiki page" whose input was the single word `the`. Two fields silently
  // wrong, no complaint.
  const r = scratchRepo('stray');
  await hkb('boards', 'add', 'stray', '--repo', r);
  await assert.rejects(
    () => hkb('new', 'review the parser', '--brief', 'do it', '--board', 'stray',
      '--input', 'page=value:the', 'wiki', 'page'),
    /2 stray words after `--input`.*`wiki`, `page`/s,
  );

  // Quoted, it does what it says.
  const ok = json((await hkb('new', 'review the parser', '--brief', 'do it', '--board', 'stray',
    '--input', 'page=value:the wiki page', '--json')).out);
  assert.equal(ok.name, 'review the parser');
  assert.deepEqual(ok.inputs, [{ name: 'page', value: 'the wiki page' }], 'the whole value, not its first word');

  // And an unquoted multi-word NAME, before the flags, still works — that join is deliberate.
  const named = json((await hkb('new', 'my', 'great', 'job', '--brief', 'do it', '--board', 'stray', '--json')).out);
  assert.equal(named.name, 'my great job');
});

test('the invocations that must keep working, end to end', async () => {
  // The first version of this guard broke every one of these, and no test noticed.
  const r = scratchRepo('stray-legal');
  await hkb('boards', 'add', 'stray-legal', '--repo', r);

  // A boolean flag before the name: the frictionless-capture path README documents.
  const t = json((await hkb('new', '--triage', 'capture this idea', '--board', 'stray-legal', '--json')).out);
  assert.equal(t.name, 'capture this idea');
  assert.equal(t.phase, 'triage');

  // A flag before the id, on a verb that also joins a trailing message.
  await hkb('cancel', '--board', 'stray-legal', String(t.id), 'not wanted after all');
  const done = await db.job.findUniqueOrThrow({ where: { id: t.id } });
  assert.equal(done.phase, 'cancelled');
  assert.equal(done.endedFor, 'not wanted after all');

  // `--` says everything after it is a positional, and is the only override the guard has.
  const dashed = json((await hkb('new', '--brief', 'do it', '--board', 'stray-legal', '--json', '--', 'my', 'name')).out);
  assert.equal(dashed.name, 'my name');
});

test('a misspelled flag says so, rather than blaming the quoting of a value that was quoted', async () => {
  // `parseArgs` under strict:false accepts `--brefi` as a BOOLEAN, so its value falls through as a
  // positional. Before this it was reported as a quoting error and the operator was sent to
  // re-quote something already quoted.
  const r = scratchRepo('unknown-flag');
  await hkb('boards', 'add', 'unknown-flag', '--repo', r);
  await assert.rejects(
    () => hkb('new', 'n', '--brefi', 'do it', '--board', 'unknown-flag'),
    /unknown flag: `--brefi`.*hkb --help/s,
  );
  // And it is checked for every verb, not only the greedy ones.
  await assert.rejects(() => hkb('ls', '--phse', 'triage'), /unknown flag: `--phse`/);
});

test('the verbs whose trailing prose is greedy are deliberately NOT guarded', async () => {
  // `hkb cancel 1 --board b "superseded"` and `hkb cancel 1 --board my board name` have the same
  // token shape, and the first is ordinary — so guarding them would mean giving up the greedy join,
  // which exists so an unquoted reason is not silently truncated to its first word. One or the
  // other. See `strayWords`.
  const r = scratchRepo('stray-verbs');
  await hkb('boards', 'add', 'stray-verbs', '--repo', r);
  const id = json((await hkb('new', 'note', '--board', 'stray-verbs', '--brief', 'x', '--json')).out).id;
  await hkb('cancel', String(id), '--board', 'stray-verbs', 'superseded by #12');
  assert.equal((await db.job.findUniqueOrThrow({ where: { id } })).endedFor, 'superseded by #12');

  // And a verb taking a FIXED number of positionals is untouched: an id after a flag is real.
  await assert.rejects(
    () => hkb('watch', '--board', 'stray-verbs', '999999'),
    /no Job #999999|999999/,
  );
});

test('hkb job set drops nothing silently — its arity is fixed, so a leftover is refused', async () => {
  // The other face of the same fault: a non-greedy verb does not absorb a stray, it THROWS IT AWAY.
  // `hkb job set 1 --name a better name` set the name to `a` and lost `better name` without a word.
  const r = scratchRepo('jobset-stray');
  await hkb('boards', 'add', 'jobset-stray', '--repo', r);
  const id = json((await hkb('new', 'original', '--brief', 'x', '--board', 'jobset-stray', '--json')).out).id;
  await assert.rejects(
    () => hkb('job', 'set', String(id), '--board', 'jobset-stray', '--name', 'a', 'better', 'name'),
    /takes one id, and got `better`, `name` as well/,
  );
  assert.equal((await db.job.findUniqueOrThrow({ where: { id } })).name, 'original', 'and nothing was written');
});

test('a mistyped flag does not stop --help from answering', async () => {
  // This module's own argument against `strict: true` is that it errors before help can answer, and
  // a person who has just mistyped a flag is exactly the person about to ask for it.
  const r = await hkb('new', '--brefi', 'x', '--help');
  assert.equal(r.code, 0);
  assert.match(r.out, /hkb — run one agent against one brief/);
});

test('hkb job set --name takes the words, not the boolean parseArgs would make of it', async () => {
  // `parseArgs` runs with strict:false, where an UNDECLARED long option is a boolean — so
  // `--name "a much better name"` yielded `true` and renamed the Job to the literal string "true",
  // with the words pushed silently into positionals.
  const r = scratchRepo('jobset-name');
  await hkb('boards', 'add', 'jobset-name', '--repo', r);
  const id = json((await hkb('new', 'original name', '--brief', 'do it', '--board', 'jobset-name', '--json')).out).id;
  await hkb('job', 'set', String(id), '--board', 'jobset-name', '--name', 'a much better name');
  assert.equal((await db.job.findUniqueOrThrow({ where: { id } })).name, 'a much better name');
});

test('hkb job set resolves --allow-tool over --allow-tools, the way `hkb new` does', async () => {
  // The same two flags must not mean opposite things depending on the verb — this field is the
  // ceiling `src/admission.ts` enforces, not a preference.
  const r = scratchRepo('jobset-tools');
  await hkb('boards', 'add', 'jobset-tools', '--repo', r);
  const id = json((await hkb('new', 'x', '--brief', 'do it', '--board', 'jobset-tools', '--json')).out).id;
  await hkb('job', 'set', String(id), '--board', 'jobset-tools', '--allow-tool', 'Read', '--allow-tools', 'Write,Bash');
  assert.deepEqual((await db.job.findUniqueOrThrow({ where: { id } })).allowedTools, ['Read']);
});

test('hkb job set refuses the subcommand that is not there, and the flag that sets nothing', async () => {
  const r = scratchRepo('jobset-refuse');
  await hkb('boards', 'add', 'jobset-refuse', '--repo', r);
  const id = json((await hkb('new', 'x', '--brief', 'do it', '--board', 'jobset-refuse', '--json')).out).id;

  await assert.rejects(() => hkb('job', 'show', String(id), '--board', 'jobset-refuse'), /the only subcommand/);
  await assert.rejects(() => hkb('job', 'set', String(id), '--board', 'jobset-refuse'), /nothing to set/);
  // The checkers are the ones `hkb new` runs, so a value that could never be filed cannot be set.
  // A dash-leading one never reaches them: `given` refuses it as argv first (see `--check --json`).
  await assert.rejects(
    () => hkb('job', 'set', String(id), '--board', 'jobset-refuse', '--base', '--upload-pack=sh'),
    /is a flag rather than a value/,
  );
  await assert.rejects(
    () => hkb('job', 'set', String(id), '--board', 'jobset-refuse', '--base', 'a branch with spaces'),
    /--base wants a git ref/,
  );
});

test('an un-isolated Job is not shown a base it can never use', async () => {
  // A board's `defaultBase` resolves onto every Job it carries, including one running in the
  // operator's own checkout — where no branch is cut and nothing ever reads it. Printing it said
  // that Job branches from `origin/main`, which is a fact about a checkout that will not exist.
  const r = scratchRepo('show-base');
  await hkb('boards', 'add', 'show-base', '--repo', r);
  await hkb('boards', 'set', 'show-base', '--base', 'origin/main');
  const iso = json((await hkb('new', 'a', '--board', 'show-base', '--brief', 'do it', '--json')).out);
  const bare = json((await hkb('new', 'b', '--board', 'show-base', '--brief', 'do it', '--no-isolate', '--json')).out);

  const shown = (id: number) => hkb('show', String(id), '--board', 'show-base');
  assert.match((await shown(iso.id)).out, /base\s+origin\/main/, 'a worktree Job is told');
  assert.doesNotMatch((await shown(bare.id)).out, /base\s+origin\/main/, 'one with no worktree is not');
});

test('--base and --no-isolate contradict each other, and say so rather than doing nothing', async () => {
  // A Job with no worktree cuts no branch, so the base would be stored, printed by `hkb show`, and
  // never read — the silent failure the fifth value forbids.
  const r = scratchRepo('base-no-isolate');
  await hkb('boards', 'add', 'base-no-isolate', '--repo', r);
  await assert.rejects(
    () => hkb('new', 'x', '--board', 'base-no-isolate', '--brief', 'do it', '--base', 'origin/main', '--no-isolate'),
    /contradict each other.*Drop one/s,
  );
});

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

/**
 * A board's default workflow — how work on this board FINISHES (ADR-017 decisions 1 and 5).
 *
 * The core stopped telling every worker to push and open a pull request, because nothing refuses on
 * either. That left a hand-filed Job with nowhere to get the steps from, and this is the somewhere.
 * What is asserted is the composition, which is deliberately NOT `--from`'s: the frontmatter fills
 * spec nulls the same way, and the body is APPENDED rather than replacing the brief.
 */
test('a board`s default workflow fills the spec nulls and appends its body as standing steps', async () => {
  workflow('finishing', [
    '---', 'name: finishing', 'description: how work here ends', 'guide: README.md',
    'label: [workflow=finishing]', 'max-budget: 3', '---', '',
    'Push your branch and open a draft pull request.', '',
  ].join('\n'));
  await hkb('boards', 'set', 'suite-repo', '--workflow', 'finishing');

  const j = json((await hkb(
    'new', 'a hand-filed Job', '--brief', 'Fix the parser.', '--board', 'suite-repo', '--json',
  )).out) as { id: number; standingSteps: string };
  assert.equal(j.standingSteps, 'finishing', 'and it is echoed: a worker is told something nobody typed');
  const row = await db.job.findUniqueOrThrow({ where: { id: j.id } });

  assert.match(row.brief, /^Fix the parser\./, 'the brief still says WHAT to do, first');
  assert.match(row.brief, /Standing steps for work on this board, from the workflow `finishing`:/);
  assert.match(row.brief, /Push your branch and open a draft pull request\./, 'and the file says how it ends');
  assert.equal(row.guide, 'README.md', 'the frontmatter fills a null exactly as `--from` would');
  assert.equal(row.maxBudgetUsd, 3);
  assert.deepEqual(row.labels, { workflow: 'finishing' });

  // The line still wins over the file, which is the precedence everywhere else here.
  const typed = json((await hkb(
    'new', 'louder', '--brief', 'Do it.', '--max-budget', '0.5', '--board', 'suite-repo', '--json',
  )).out) as { id: number };
  assert.equal((await db.job.findUniqueOrThrow({ where: { id: typed.id } })).maxBudgetUsd, 0.5);
});

test('hkb show names where the standing steps came from', async () => {
  const j = json((await hkb('new', 'shown', '--brief', 'Fix it.', '--board', 'suite-repo', '--json')).out) as { id: number };
  const out = (await hkb('show', String(j.id), '--board', 'suite-repo')).out;
  assert.match(out, /steps\s+standing steps from workflow finishing/,
    'the part of the brief nobody typed is named, like every other resolved field`s source');
  assert.equal(json((await hkb('show', String(j.id), '--board', 'suite-repo', '--json')).out).standingSteps, 'finishing');
});

test('--from governs entirely: a Job filed from a workflow gets no standing steps', async () => {
  // Composing the two would mean a workflow author could not write a step that finishes differently
  // from the board — and "the more specific thing wins" is the rule the rest of this file follows.
  const j = json((await hkb('new', 'from a workflow', '--from', 'paged', '--board', 'suite-repo', '--json')).out) as { id: number; standingSteps: string | null };
  assert.equal(j.standingSteps, null);
  const row = await db.job.findUniqueOrThrow({ where: { id: j.id } });
  assert.equal(row.brief, 'Draft the page.', 'the workflow`s own body, and nothing appended to it');
  assert.equal(row.guide, 'README.md', 'from `paged`, not from the board`s default');
});

test('a proposing Job gets none either — its whole output is a file, and it commits nothing', async () => {
  // The contradiction `withWorktree` exists for, arriving from the other side: a brief ending in
  // "push your branch and open a pull request" is not an instruction a proposing Job can follow.
  const j = json((await hkb('new', 'breaks it down', '--brief', 'Split this up.', '--propose', '--board', 'suite-repo', '--json')).out) as { id: number; standingSteps: string | null };
  assert.equal(j.standingSteps, null);
  assert.doesNotMatch((await db.job.findUniqueOrThrow({ where: { id: j.id } })).brief, /Standing steps/);
});

test('a default workflow that is not there is refused at FILE time, by name, with nothing created', async () => {
  await hkb('boards', 'set', 'suite-repo', '--workflow', 'gone-missing');
  const before = await db.job.count();
  await assert.rejects(
    () => hkb('new', 'x', '--brief', 'do it', '--board', 'suite-repo'),
    (e: Error & { exitCode?: number }) => {
      assert.equal(e.exitCode, 2);
      assert.match(e.message, /board suite-repo files every Job with the workflow `gone-missing`/);
      assert.match(e.message, /hkb boards set suite-repo --workflow <name>\|none/, 'and how to fix it');
      return true;
    },
  );
  assert.equal(await db.job.count(), before, 'a Job missing the steps everything else got is worse than a refusal');
});

test('a default workflow may not use placeholders — there is nothing to fill them from', async () => {
  workflow('placeheld', ['---', 'name: placeheld', '---', '', 'Ship it to {{where}}.', ''].join('\n'));
  await hkb('boards', 'set', 'suite-repo', '--workflow', 'placeheld');
  await assert.rejects(
    () => hkb('new', 'x', '--brief', 'do it', '--board', 'suite-repo'),
    /`\{\{where\}\}`.*appended to every brief/s,
  );
  // And back to a board that says nothing, so the tests after this one are unaffected.
  await hkb('boards', 'set', 'suite-repo', '--workflow', 'none');
  const j = json((await hkb('new', 'plain again', '--brief', 'Do it.', '--board', 'suite-repo', '--json')).out) as { standingSteps: string | null };
  assert.equal(j.standingSteps, null);
});

// ---------------------------------------------------------------- labels

/**
 * Labels — the grouping key, and the selector over it (`src/labels.ts`).
 *
 * The module's own test covers the refusals exhaustively; what is asserted here is the CLI's half:
 * that a label filed on `hkb new` is the one `hkb ls --label` finds, that two requirements narrow
 * rather than widen, and that a Job carrying none says so as `{}` rather than by omitting the key.
 * `--board` is explicit for the reason every late test in this file passes it: by here the suite has
 * several boards pointing at the same checkout, and which one is meant stops being inferable.
 */

test('new labels a Job, ls selects on it, and show prints it', async () => {
  const a = json((await hkb('new', 'labelled a', '--brief', 'x', '--label', 'workflow=release', '--label', 'step=draft', '--board', 'suite-repo', '--json')).out);
  const b = json((await hkb('new', 'labelled b', '--brief', 'x', '--label', 'workflow=release', '--board', 'suite-repo', '--json')).out);
  assert.deepEqual(a.labels, { workflow: 'release', step: 'draft' });
  const row = await db.job.findUniqueOrThrow({ where: { id: b.id } });
  assert.deepEqual(row.labels, { workflow: 'release' });

  const both = json((await hkb('ls', '--label', 'workflow=release', '--board', 'suite-repo', '--json')).out).map((r: { id: number }) => r.id);
  assert.deepEqual(both.sort(), [a.id, b.id].sort());
  // ANDed: the second requirement narrows it to the one Job that carries both.
  const one = json((await hkb('ls', '--label', 'workflow=release', '--label', 'step=draft', '--board', 'suite-repo', '--json')).out);
  assert.deepEqual(one.map((r: { id: number }) => r.id), [a.id]);
  // Equality only, and the refusal is the case that matters: `rel` is not `release`, and no amount
  // of prefix-guessing is going to be added to make it one.
  assert.deepEqual(json((await hkb('ls', '--label', 'workflow=rel', '--board', 'suite-repo', '--json')).out), []);
  // The empty listing names what was asked for, because "no jobs on suite-repo" would answer a
  // question nobody put.
  assert.match((await hkb('ls', '--label', 'workflow=nothing', '--board', 'suite-repo')).out, /no jobs labelled workflow=nothing/);
  // An unlabelled Job is null on the row and `{}` in --json: a consumer inferring absence from a
  // missing key reads a shape, not a record.
  const plain = json((await hkb('new', 'unlabelled', '--brief', 'x', '--board', 'suite-repo', '--json')).out);
  assert.equal((await db.job.findUniqueOrThrow({ where: { id: plain.id } })).labels, null);
  const listed = json((await hkb('ls', '--board', 'suite-repo', '--json')).out).find((r: { id: number }) => r.id === plain.id);
  assert.deepEqual(listed.labels, {});

  assert.match((await hkb('show', String(a.id), '--board', 'suite-repo')).out, /labels {3}step=draft, workflow=release/);
});

test('a label that is not `key=value` is refused before the Job exists', async () => {
  const before = await db.job.count();
  await assert.rejects(() => hkb('new', 'bad label', '--brief', 'x', '--label', 'nope', '--board', 'suite-repo'), /no `=`/);
  await assert.rejects(() => hkb('new', 'bad label', '--brief', 'x', '--label', 'a b=c', '--board', 'suite-repo'), /not a plain token/);
  // The same fence on the reading side: a selector that cannot be parsed is a usage error, never an
  // empty listing that reads as "nothing matches".
  await assert.rejects(() => hkb('ls', '--label', 'workflow', '--board', 'suite-repo'), /no `=`/);
  assert.equal(await db.job.count(), before, 'a refused label must not leave a Job behind');
});

// ---------------------------------------------------------------- the completion check (ADR-016 §3)

test('--check files the command, and `hkb show` names it with where it came from', async () => {
  const repo = scratchRepo('checked');
  await hkb('boards', 'add', 'checked', '--repo', repo);

  // The shipped default first: no Job says anything, no board says anything, and `hkb show` says
  // so rather than leaving the line out — "nothing verifies this" is the answer to "why did this
  // succeed with the suite red".
  const bare = json((await hkb('new', 'unchecked', '--brief', 'x', '--board', 'checked', '--json')).out);
  const shown = (await hkb('show', String(bare.id), '--board', 'checked')).out;
  assert.match(shown, /check\s+\(none — nothing verifies the work\)\s+\[built-in\]/);

  const j = json((await hkb('new', 'checked-job', '--brief', 'x', '--check', 'npm run lint && npm test', '--board', 'checked', '--json')).out);
  assert.deepEqual(j.check, { value: 'npm run lint && npm test', source: 'job' }, '--json carries it');
  const out = (await hkb('show', String(j.id), '--board', 'checked')).out;
  assert.match(out, /check\s+npm run lint && npm test\s+\[job\]/, 'and its source is traced like every other field');

  // The board answers for a Job that says nothing, and the Job still wins where it speaks.
  await hkb('boards', 'set', 'checked', '--check', 'make verify');
  assert.match((await hkb('show', String(bare.id), '--board', 'checked')).out, /check\s+make verify\s+\[board\]/);
  assert.match((await hkb('show', String(j.id), '--board', 'checked')).out, /check\s+npm run lint && npm test\s+\[job\]/);
});

test('hkb new echoes the check it will actually run, board default included', async () => {
  // `check: check ?? null` echoed the Job's own COLUMN, so a Job inheriting the board's printed
  // nothing at all — which is the "an attempt can fail on a command nobody printed" surprise this
  // echo exists to prevent, and the board default is the configuration the README recommends.
  const repo = scratchRepo('echoed');
  await hkb('boards', 'add', 'echoed', '--repo', repo);
  await hkb('boards', 'set', 'echoed', '--check', 'make verify');

  const inherits = await hkb('new', 'inherits-a-check', '--brief', 'x', '--board', 'echoed');
  assert.match(inherits.out, /must pass\s+make verify\s+\[board\]/, 'the command, and whose it is');
  const j = json((await hkb('new', 'inherits-2', '--brief', 'x', '--board', 'echoed', '--json')).out);
  assert.deepEqual(j.check, { value: 'make verify', source: 'board' }, '--json carries the resolved value too');
  // And `hkb show --json` says the SAME thing about the same Job. It printed the raw column, so a
  // Job that inherits its board's check answered `"make verify"` to one verb and `null` to the
  // other, and a script that filed work and then polled it saw a check appear out of nowhere.
  const seen = json((await hkb('show', String(j.id), '--board', 'echoed', '--json')).out);
  assert.deepEqual(seen.check, { value: 'make verify', source: 'board' }, 'one shape, both verbs');

  const own = await hkb('new', 'own-check', '--brief', 'x', '--check', 'npm test', '--board', 'echoed');
  assert.match(own.out, /must pass\s+npm test\s+\[job\]/);
  const out = await hkb('new', 'no-check-here', '--brief', 'x', '--check', '', '--board', 'echoed');
  assert.match(out.out, /must pass\s+nothing — this Job opts out/);
});

// ---------------------------------------------------------------- a bare `--check` is not a check
//
// The refusing case, on all three verbs. `parseArgs` runs with `strict: false`, so a trailing bare
// `--check` comes back as the BOOLEAN `true`, and `String(true)` is the word `true` — a shell
// command that exists, exits 0, and verifies nothing. It was filed: `hkb show` printed
// `check true [job]`, and every attempt of that Job "passed". `--gate`, one line over, has always
// been written `typeof values.gate === 'string'` and has always refused correctly.

test('hkb new: a bare --check is refused, not filed as the shell command `true`', async () => {
  await assert.rejects(
    () => main(['new', 'bare-check', '--brief', 'x', '--board', 'bare-check-board', '--check']),
    (e: Error & { exitCode?: number }) => e.exitCode === 2 && /a bare --check is not a value/.test(e.message),
  );
});

test('hkb boards set: a bare --check is refused too', async () => {
  const repo = scratchRepo('bare-board-check');
  await hkb('boards', 'add', 'bare-board-check', '--repo', repo);
  await assert.rejects(
    () => main(['boards', 'set', 'bare-board-check', '--check']),
    (e: Error & { exitCode?: number }) => e.exitCode === 2 && /a bare --check is not a value/.test(e.message),
  );
  const rows = json((await hkb('boards', '--json')).out) as { board: string; defaults: { check: string | null } }[];
  assert.equal(rows.find((r) => r.board === 'bare-board-check')?.defaults.check, null,
    'and nothing was written — a refusal that still wrote would be the same bug one step later');
});

test('hkb job set: a bare --check is refused as well, so no route files `true`', async () => {
  const b = 'bare-set-check-board';
  const j = json((await hkb('new', 'bare-set-check', '--brief', 'x', '--board', b, '--json')).out);
  // The bare flag LAST, because a flag after it is SWALLOWED as its value rather than falling
  // through — the lost-quotes guard cannot see it, because nothing became a stray positional. That
  // is its own trap and it has its own test below; this one is about the flag with nothing after it.
  await assert.rejects(
    () => main(['job', 'set', String(j.id), '--board', b, '--check']),
    (e: Error & { exitCode?: number }) => e.exitCode === 2 && /a bare --check is not a value/.test(e.message),
  );
  assert.match((await hkb('show', String(j.id), '--board', b)).out, /check\s+\(none — nothing verifies/,
    'and the Job is unchanged — nothing was filed on the strength of a flag with no value');
});

test('a string flag handed the NEXT FLAG is refused, on every verb that takes one', async () => {
  // The third argv trap (`gotchas/argv-traps.md`). `parseArgs` under `strict: false` gives a string
  // option the next token whatever it is, so `--check --json` filed the shell command `--json` —
  // a check that judges every attempt of that Job and is a flag, with `--json` silently not in
  // effect either. Neither of the first two guards catches it: the flag IS declared, and it
  // consumed the token, so nothing falls through as a stray positional.
  const b = 'swallowed-flag-board';
  const repo = scratchRepo('swallowed-flag');
  await hkb('boards', 'add', b, '--repo', repo);
  const j = json((await hkb('new', 'swallow', '--brief', 'x', '--board', b, '--json')).out);
  const flagValue = (e: Error & { exitCode?: number }) =>
    e.exitCode === 2 && /is a flag rather than a value/.test(e.message);

  await assert.rejects(() => main(['new', 'n', '--brief', 'x', '--board', b, '--check', '--json']), flagValue);
  await assert.rejects(() => main(['job', 'set', String(j.id), '--board', b, '--check', '--json']), flagValue);
  await assert.rejects(() => main(['boards', 'set', b, '--check', '--json']), flagValue);
  // The same helper, so the same refusal, on every other flag that shares it.
  await assert.rejects(() => main(['new', 'n', '--brief', 'x', '--board', b, '--guide', '--json']), flagValue);
  await assert.rejects(() => main(['job', 'set', String(j.id), '--board', b, '--model', '--json']), flagValue);
  await assert.rejects(() => main(['new', 'n', '--brief', 'x', '--board', b, '--export', '--json']), flagValue);

  assert.match((await hkb('show', String(j.id), '--board', b)).out, /check\s+\(none — nothing verifies/,
    'and nothing was filed on the strength of it');
  const rows = json((await hkb('boards', '--json')).out) as { board: string; defaults: { check: string | null } }[];
  assert.equal(rows.find((r) => r.board === b)?.defaults.check, null);
});

test('a bare flag files nothing, on every flag `hkb new` takes and not only --check', async () => {
  // A repeatable flag with no value is `[true]` rather than `true`, so it walked past the guard
  // written for the scalar case: `hkb new x --export` declared an output called `true` and the
  // attempt failed for not producing it. `--model` and `--plugin-dir` were worse — a raw `TypeError`
  // out of a path checker, with no exit code of ours and no sentence naming the fix.
  const b = 'bare-flags-board';
  const repo = scratchRepo('bare-flags');
  await hkb('boards', 'add', b, '--repo', repo);
  const bare = (e: Error & { exitCode?: number }) =>
    e.exitCode === 2 && /is not a value/.test(e.message);
  for (const flag of ['--export', '--result', '--artifact', '--input', '--label', '--allow-tool',
    '--allow-tools', '--plugin-dir', '--model', '--effort', '--guide']) {
    await assert.rejects(
      () => main(['new', 'bare', '--brief', 'x', '--board', b, flag]),
      bare,
      `a bare ${flag} must be refused by name, not filed as the word true`,
    );
  }
  const rows = json((await hkb('ls', '--board', b, '--json')).out) as unknown[];
  assert.equal(rows.length, 0, 'and not one of them left a Job behind');

  // And the flags that reach past `hkb new`. A bare `--board` went into
  // `prisma.board.findUnique` as the boolean `true` and came back as a raw client error, and a
  // bare `--repo` as a raw `TypeError` out of `path.resolve` — no exit code of ours, nothing in
  // either naming the fix, which is the fifth value's own definition of a silent failure.
  await assert.rejects(() => main(['ls', '--board']), bare);
  await assert.rejects(() => main(['boards', 'add', 'somewhere', '--repo']), bare);
  await assert.rejects(() => main(['ls', '--board', b, '--label']), bare);
  await assert.rejects(() => main(['new', 'n', '--brief', 'x', '--board', b, '--from']), bare);
});

// ---------------------------------------------------------------- opting one Job out
//
// A board-wide check owned every Job on it: a blank normalised to null, null inherits, and
// `--check none` filed the literal command `none` — exit 127, `check_failed`, resumed and re-failed
// until the retries were gone. The schema's own "a Job whose brief is an investigation has no suite
// to pass" was unhonourable. `''` is the narrowing value, the shape `allowedTools: []` already uses.

test('--check "" is a Job that runs NO check and does not inherit the board\'s', async () => {
  const repo = scratchRepo('opt-out');
  await hkb('boards', 'add', 'opt-out', '--repo', repo);
  await hkb('boards', 'set', 'opt-out', '--check', 'npm test');

  const investigation = json((await hkb('new', 'investigate', '--brief', 'read it', '--check', '', '--board', 'opt-out', '--json')).out);
  assert.deepEqual(investigation.check, { value: '', source: 'job' }, 'the empty string is a VALUE, not an absence');
  assert.match((await hkb('show', String(investigation.id), '--board', 'opt-out')).out, /check\s+\(none\)\s+\[job\]/);

  // Whitespace normalises INTO the opt-out: a command of one space is not a command.
  const spaces = json((await hkb('new', 'investigate-2', '--brief', 'x', '--check', '  ', '--board', 'opt-out', '--json')).out);
  assert.equal(spaces.check.value, '');

  // And the Job beside it still inherits, so this narrowed one Job rather than the board.
  const ordinary = json((await hkb('new', 'ordinary', '--brief', 'x', '--board', 'opt-out', '--json')).out);
  assert.deepEqual(ordinary.check, { value: 'npm test', source: 'board' });
});

test('`hkb new --check none` is refused; on `hkb job set` and on a board it CLEARS', async () => {
  // On `hkb new` there is nothing to clear — the column starts null, which is what inheriting the
  // board's default IS — so filing it as written is three paid sessions for a command that can
  // never pass. And the fix it names has to be one that exists on the verb it is said on.
  await assert.rejects(
    () => main(['new', 'none-check', '--brief', 'x', '--board', 'none-check-board', '--check', 'none']),
    (e: Error & { exitCode?: number }) => e.exitCode === 2
      && /would file the literal shell command/.test(e.message)
      && /--check ""/.test(e.message)
      && /leave --check out/.test(e.message),
  );

  // On `hkb job set` it means what `none` means on every other field of that verb: put the column
  // back to null. Refusing it left the operator with no way to undo a `--check` at all, pointed at
  // "leave --check out" — which on a verb that writes only what it is given does nothing.
  const b = 'none-set-board';
  const repo2 = scratchRepo('none-set-repo');
  await hkb('boards', 'add', b, '--repo', repo2);
  await hkb('boards', 'set', b, '--check', 'make verify');
  const j = json((await hkb('new', 'none-set', '--brief', 'x', '--board', b, '--check', 'npm test', '--json')).out);
  const back = json((await hkb('job', 'set', String(j.id), '--check', 'none', '--board', b, '--json')).out);
  assert.equal(back.changed[0].to, null, 'the column is null again');
  assert.match((await hkb('show', String(j.id), '--board', b)).out, /check\s+make verify\s+\[board\]/,
    'which is what inheriting the board looks like — not the built-in absence');
  // And it is a different thing from `--check ""`, which inherits nothing.
  await hkb('job', 'set', String(j.id), '--check', '', '--board', b);
  assert.match((await hkb('show', String(j.id), '--board', b)).out, /check\s+\(none\)\s+\[job\]/);

  // `hkb boards set --check none` is unchanged, and always meant this.
  const repo = scratchRepo('board-clears');
  await hkb('boards', 'add', 'board-clears', '--repo', repo);
  await hkb('boards', 'set', 'board-clears', '--check', 'npm test');
  const cleared = json((await hkb('boards', 'set', 'board-clears', '--check', 'none', '--json')).out);
  assert.equal(cleared.defaults.check, null);
});

test('hkb show prints both tails, labelled, and nothing for a stream that said nothing', async () => {
  const b = 'show-tails-board';
  const repo = scratchRepo('show-tails');
  await hkb('boards', 'add', b, '--repo', repo);
  const j = json((await hkb('new', 'tailed', '--brief', 'x', '--board', b, '--json')).out);
  await db.attempt.create({
    data: {
      jobId: j.id, k: 1, startedAt: new Date(), endedAt: new Date(), outcome: 'check_failed', maxBudgetUsd: 1,
      check: {
        command: 'cargo test', exitCode: 101, kind: 'exit', ms: 4000,
        stdout: 'test result: FAILED. 1 passed; 2 failed', stderr: 'warning: unused variable',
      },
    },
  });
  const out = (await hkb('show', String(j.id), '--board', b)).out;
  assert.match(out, /stdout:/);
  assert.match(out, /test result: FAILED/);
  assert.match(out, /stderr:/);
  assert.match(out, /warning: unused variable/);

  const k = json((await hkb('new', 'one-sided', '--brief', 'x', '--board', b, '--json')).out);
  await db.attempt.create({
    data: {
      jobId: k.id, k: 1, startedAt: new Date(), endedAt: new Date(), outcome: 'check_failed', maxBudgetUsd: 1,
      check: { command: 'npm test', exitCode: 1, kind: 'exit', ms: 10, stdout: '', stderr: '1 failing' },
    },
  });
  const only = (await hkb('show', String(k.id), '--board', b)).out;
  assert.doesNotMatch(only, /stdout:/, 'a stream that printed nothing draws no heading and no blank line');
  assert.match(only, /stderr:/);
});

test('hkb new --propose --check is refused: a proposal has nothing to check', async () => {
  // A check over a tree a proposing Job never changed always fails, and `check_failed` outranks the
  // gate — so the Job never suspended for approval and went round the retry loop instead.
  const b = 'propose-check-board';
  const repo = scratchRepo('propose-check');
  await hkb('boards', 'add', b, '--repo', repo);
  await assert.rejects(
    () => main(['new', 'proposer', '--brief', 'x', '--board', b, '--propose', '--check', 'npm test']),
    (e: Error & { exitCode?: number }) => e.exitCode === 2
      && /a proposing Job has nothing to check/.test(e.message),
  );
  const rows = json((await hkb('ls', '--board', b, '--json')).out) as unknown[];
  assert.equal(rows.length, 0, 'and nothing was filed');
});

test('a check longer than the kernel can pass is refused where it is written', async () => {
  // `sh -c` passes the whole line as one argument; past `MAX_ARG_STRLEN` the spawn throws `E2BIG`
  // synchronously, so every attempt of that Job would fail on the command rather than on the work.
  const b = 'long-check-board';
  await assert.rejects(
    () => main(['new', 'verbose', '--brief', 'x', '--board', b, '--check', `echo ${'x'.repeat(9000)}`]),
    (e: Error & { exitCode?: number }) => e.exitCode === 2 && /the limit is 8192/.test(e.message),
  );
});

test('hkb job set --check "" opts a filed Job out, and a command sets it back', async () => {
  const b = 'set-out-board';
  const j = json((await hkb('new', 'set-out', '--brief', 'x', '--board', b, '--json')).out);
  const off = json((await hkb('job', 'set', String(j.id), '--check', '', '--board', b, '--json')).out);
  assert.equal(off.changed[0].to, '', 'stored as the empty string, not as null');
  assert.match((await hkb('show', String(j.id), '--board', b)).out, /check\s+\(none\)\s+\[job\]/);
  const on = json((await hkb('job', 'set', String(j.id), '--check', 'make verify', '--board', b, '--json')).out);
  assert.equal(on.changed[0].to, 'make verify');
});

test('hkb job set --check changes what a filed Job must pass', async () => {
  const b = 'set-a-check-board';
  const j = json((await hkb('new', 'set-a-check', '--brief', 'x', '--board', b, '--json')).out);
  const set = json((await hkb('job', 'set', String(j.id), '--check', 'npm test', '--board', b, '--json')).out);
  assert.deepEqual(set.changed.map((c: { field: string }) => c.field), ['check']);
  assert.match((await hkb('show', String(j.id), '--board', b)).out, /check\s+npm test\s+\[job\]/);
});

test('a workflow file may name the check, because a workflow is what knows when a step is done', async () => {
  // Safe HERE and nowhere near a worktree: a workflow is read from `Board.repoPath`, so the command
  // that judges an attempt still arrives through a human merge (`src/templates.ts`).
  const repo = scratchRepo('workflow-check');
  fs.mkdirSync(path.join(repo, '.hkb', 'workflows'), { recursive: true });
  fs.writeFileSync(
    path.join(repo, '.hkb', 'workflows', 'shipped.md'),
    '---\nname: shipped\ncheck: npm test\n---\nDo the work.\n',
  );
  await hkb('boards', 'add', 'workflow-check', '--repo', repo);
  const j = json((await hkb('new', '--from', 'shipped', '--board', 'workflow-check', '--json')).out);
  assert.deepEqual(j.check, { value: 'npm test', source: 'job' });

  // And the flag still wins over the file, the way it does for every other key.
  const typed = json((await hkb('new', '--from', 'shipped', '--check', 'make check', '--board', 'workflow-check', '--json')).out);
  assert.equal(typed.check.value, 'make check');

  // `check: none` in a FILE is refused where it is written. It reached `hkb new` as though it had
  // been typed, so the author was told to "leave --check out" — about a flag they never used, and
  // on a verb where leaving the key out is the only fix there is.
  fs.writeFileSync(
    path.join(repo, '.hkb', 'workflows', 'noned.md'),
    '---\nname: noned\ncheck: none\n---\nDo the work.\n',
  );
  await assert.rejects(
    () => hkb('new', '--from', 'noned', '--board', 'workflow-check'),
    (e: Error & { exitCode?: number }) => e.exitCode === 2
      && /noned\.md, line 3/.test(e.message)
      && /Delete the line/.test(e.message)
      && !/--check/.test(e.message),
  );
});

// ---------------------------------------------------------------- the traps the third review found open

test('--brief and --gate refuse a bare flag and the next flag, like every other string flag', async () => {
  // `readBrief` and `--gate` on `hkb new` were the two string flags still read with `typeof ===
  // 'string'`, so `--brief --json` filed the word `--json` as a two-character brief — and ran a
  // paid session on it — with `--json` silently not in effect.
  const b = 'brief-json-board';
  const isTrap = (e: Error & { exitCode?: number }) => e.exitCode === 2 && /which is a flag rather than a value/.test(e.message);
  await assert.rejects(() => main(['new', 'b1', '--board', b, '--brief', '--json']), isTrap);
  await assert.rejects(() => main(['new', 'b2', '--board', b, '--brief', 'x', '--gate', '--json']), isTrap);
  await assert.rejects(
    () => main(['new', 'b3', '--board', b, '--brief']),
    (e: Error & { exitCode?: number }) => e.exitCode === 2 && /a bare --brief is not a value/.test(e.message),
  );
  const j = json((await hkb('new', 'b4', '--brief', 'real', '--board', b, '--json')).out) as { id: number };
  await assert.rejects(() => main(['job', 'set', String(j.id), '--board', b, '--brief', '--json']), isTrap);
  assert.equal((json((await hkb('show', String(j.id), '--board', b, '--json')).out) as { brief: string }).brief, 'real',
    'and the brief was not overwritten');
});

test('a bare numeric flag is refused rather than filed as 1', async () => {
  // `Number(true)` is 1: a bare `--max-turns` filed a ceiling of ONE turn, silently, on `hkb new`,
  // `hkb job set` and `hkb boards set --max-concurrent`; the Job then ended `max_turns` after one
  // tool call with no error ever shown.
  const b = 'bare-number-board';
  const bare = (flag: string) => (e: Error & { exitCode?: number }) => e.exitCode === 2 && new RegExp(`a bare ${flag} is not a number`).test(e.message);
  await assert.rejects(() => main(['new', 'n1', '--board', b, '--brief', 'x', '--max-turns']), bare('--max-turns'));
  const j = json((await hkb('new', 'n2', '--brief', 'x', '--board', b, '--json')).out) as { id: number };
  await assert.rejects(() => main(['job', 'set', String(j.id), '--board', b, '--max-budget']), bare('--max-budget'));
  await assert.rejects(() => main(['job', 'set', String(j.id), '--board', b, '--max-turns', '--json']),
    (e: Error & { exitCode?: number }) => e.exitCode === 2 && /which is a flag rather than a number/.test(e.message));
  // A negative number is still a number.
  await assert.rejects(() => main(['job', 'set', String(j.id), '--board', b, '--max-budget', '-5']),
    (e: Error & { exitCode?: number }) => e.exitCode === 2 && /dollars above zero/.test(e.message));
});

test('a value that really starts with a dash is reachable the way the refusal says', async () => {
  // `given` trimmed before the leading-dash test, so the escape its own message prescribed —
  // `--check " -x"` — was refused with the identical message, and no spelling reached the value.
  const b = 'dash-value-board';
  const j = json((await hkb('new', 'dashed', '--brief', 'x', '--board', b, '--check', ' -f dist/ok', '--json')).out) as { id: number; check: { value: string } };
  assert.equal(j.check.value, '-f dist/ok', 'the leading space is the escape, and it is trimmed away');
});

test('hkb job set refuses the list flags a bare flag or the next flag, through givenList', async () => {
  // The verb's `list()` helper cast to `string[]` and called `.trim()`: a bare `--export` threw a
  // raw TypeError with no exit code and no fix, and `--export --json` filed `--json` as the path.
  const b = 'set-list-board';
  const j = json((await hkb('new', 'lists', '--brief', 'x', '--board', b, '--json')).out) as { id: number };
  await assert.rejects(
    () => main(['job', 'set', String(j.id), '--board', b, '--export']),
    (e: Error & { exitCode?: number }) => e.exitCode === 2 && /a bare --export is not a value/.test(e.message),
  );
  await assert.rejects(
    () => main(['job', 'set', String(j.id), '--board', b, '--export', '--json']),
    (e: Error & { exitCode?: number }) => e.exitCode === 2 && /which is a flag rather than a value/.test(e.message),
  );
  assert.equal((json((await hkb('show', String(j.id), '--board', b, '--json')).out) as { exports: unknown }).exports, null,
    'nothing was filed');
});

test('a proposing Job cannot be given a check by hkb job set, and --json says the controller runs none', async () => {
  // Only `hkb new` refused the pair; `job set --check` on a proposer was accepted and `--json`
  // then printed a resolved command the controller never runs — the contract `jsonCheck` was
  // added to keep. A proposing Job's check is null on every verb, in every form.
  const b = 'propose-check-board';
  const j = json((await hkb('new', 'proposer', '--brief', 'break it down', '--board', b, '--propose', '--json')).out) as { id: number; check: { value: string | null; source: string } };
  assert.deepEqual(j.check, { value: null, source: 'proposes' });
  await assert.rejects(
    () => main(['job', 'set', String(j.id), '--board', b, '--check', 'npm test']),
    (e: Error & { exitCode?: number }) => e.exitCode === 2 && /a proposing Job runs no check/.test(e.message),
  );
  assert.deepEqual((json((await hkb('show', String(j.id), '--board', b, '--json')).out) as { check: unknown }).check,
    { value: null, source: 'proposes' }, 'show agrees with new');
});

test('a brief that opens with a Markdown bullet is a brief, not a flag', async () => {
  // The dash guard is for FLAG-shaped values — `-x`, `--json` — and a first version refused
  // `--brief "- add a test"`, which is how a person writes a list.
  const b = 'bullet-brief-board';
  const j = json((await hkb('new', 'bullets', '--brief', '- add a test\n- run it', '--board', b, '--json')).out) as { id: number; brief?: string };
  const shown = json((await hkb('show', String(j.id), '--board', b, '--json')).out) as { brief: string };
  assert.match(shown.brief, /^- add a test/);
  await assert.rejects(() => main(['new', 'flagged', '--board', b, '--brief', '-x']),
    (e: Error & { exitCode?: number }) => e.exitCode === 2 && /which is a flag rather than a value/.test(e.message));
});

test('hkb boards set --check has the same byte cap as hkb new --check', async () => {
  const repo = scratchRepo('cap-board');
  await hkb('boards', 'add', 'cap-board', '--repo', repo);
  await assert.rejects(
    () => main(['boards', 'set', 'cap-board', '--check', 'x'.repeat(9_000)]),
    (e: Error & { exitCode?: number }) => e.exitCode === 2 && /the limit is/.test(e.message),
  );
});

test('hkb job set --check "" reports the opt-out as what it means, not as a blank', async () => {
  const b = 'optout-render-board';
  const j = json((await hkb('new', 'opt', '--brief', 'x', '--board', b, '--check', 'npm test', '--json')).out) as { id: number };
  const r = await hkb('job', 'set', String(j.id), '--board', b, '--check', '');
  assert.match(r.out, /npm test → \(none — opted out\)/);
});
