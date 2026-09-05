import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hkb-kb-'));
process.env.HKB_DATABASE_URL = `file:${path.join(dir, 'kb.db')}`;
const REPO = path.resolve(import.meta.dirname, '..');
execFileSync(process.execPath, ['node_modules/prisma/build/index.js', 'migrate', 'deploy'], {
  cwd: REPO, env: process.env, stdio: 'ignore',
});

const { main } = await import('../src/kb.ts');
const { openBoard, closeBoard } = await import('../src/db.ts');
const db = openBoard();

test.after(async () => { await closeBoard(); fs.rmSync(dir, { recursive: true, force: true }); });

/**
 * Run a verb and capture what it printed, so `--json` is asserted on its real output.
 *
 * The runner's own frames have to be filtered out. `node --test` multiplexes its reporter protocol
 * (`test:enqueue`, `test:pass`, …) over this very stream as v8-serialized binary, so anything that
 * patches `process.stdout.write` captures whatever the runner happened to emit in the same window.
 * That made this harness quietly timing-dependent: it passed for as long as no frame landed mid-verb,
 * and failed with `Unexpected token '\uFFFD'` the moment one did.
 */
const RUNNER_FRAME = /\btest:(enqueue|dequeue|start|pass|fail|plan|diagnostic|complete|coverage|stderr|stdout|watch)\b/;

async function kb(...argv: string[]): Promise<{ code: number; out: string }> {
  const chunks: string[] = [];
  const write = process.stdout.write.bind(process.stdout);
  (process.stdout as { write: unknown }).write = (s: string) => {
    const text = String(s);
    if (!RUNNER_FRAME.test(text)) chunks.push(text);
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
  const r = await kb();
  assert.equal(r.code, 0);
  assert.match(r.out, /kb — run one agent against one brief/);
});

test('an unknown verb names the ones that exist', async () => {
  await assert.rejects(() => kb('frobnicate'), /unknown verb.*new, ls, show, run, rm/s);
});

// ---------------------------------------------------------------- new

test('new files a Job and returns its id', async () => {
  const r = await kb('new', 'first', '--brief', 'do the thing', '--json');
  const j = json(r.out);
  assert.equal(j.phase, 'pending');
  assert.equal(j.name, 'first');
  assert.ok(j.id > 0);
  const row = await db.job.findUniqueOrThrow({ where: { id: j.id } });
  assert.equal(row.brief, 'do the thing');
  assert.equal(row.isolate, true, 'isolation is the default, not the opt-in');
});

test('new refuses without a brief, and says how to give one', async () => {
  await assert.rejects(() => kb('new', 'no brief'), /--brief|--brief-file/);
});

test('new reads a brief from a file', async () => {
  const p = path.join(dir, 'brief.md');
  fs.writeFileSync(p, '  from a file  ');
  const j = json((await kb('new', 'filed', '--brief-file', p, '--json')).out);
  assert.equal((await db.job.findUniqueOrThrow({ where: { id: j.id } })).brief, 'from a file');
});

test('new names a missing brief file rather than failing obscurely', async () => {
  await assert.rejects(() => kb('new', 'x', '--brief-file', '/nope/nothing.md'), /no such file/);
});

test('new validates effort against the closed set', async () => {
  await assert.rejects(() => kb('new', 'x', '--brief', 'b', '--effort', 'turbo'), /low\|medium\|high/);
});

test('new carries the spec flags onto the row', async () => {
  const j = json((await kb('new', 'specced', '--brief', 'b', '--json',
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

test('a numeric flag given a non-number says so', async () => {
  await assert.rejects(() => kb('new', 'x', '--brief', 'b', '--max-turns', 'lots'), /wants a number/);
});

// ---------------------------------------------------------------- ls / show

test('ls is empty-safe and says so', async () => {
  const r = await kb('ls', '--board', 'nothing-here');
  assert.equal(r.code, 0);
  assert.match(r.out, /no jobs on nothing-here/);
});

test('ls --json lists what is on the board', async () => {
  const rows = json((await kb('ls', '--json')).out);
  assert.ok(rows.length >= 3);
  assert.ok(rows.every((r: { phase: string }) => r.phase === 'pending'));
});

test('ls --phase rejects a phase that is not one', async () => {
  await assert.rejects(() => kb('ls', '--phase', 'nearly'), /pending\|running/);
});

test('show is the one screen: spec, phase and attempts', async () => {
  const j = json((await kb('new', 'showme', '--brief', 'b', '--json')).out);
  const r = await kb('show', String(j.id));
  assert.match(r.out, /phase\s+pending/);
  assert.match(r.out, /maxBudget/);
  assert.match(r.out, /attempts \(none yet\)/);
});

test('show on a missing id points at ls', async () => {
  await assert.rejects(() => kb('show', '99999'), /no Job #99999.*kb ls/s);
});

// ---------------------------------------------------------------- how long it took

const { formatDuration } = await import('../src/kb.ts');

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
  const j = json((await kb('new', 'timed', '--brief', 'b', '--json')).out);
  const started = new Date('2026-09-05T10:00:00Z');
  await db.attempt.create({
    data: {
      jobId: j.id, k: 1, startedAt: started, endedAt: new Date(started.getTime() + 3_840_000),
      outcome: 'completed', costUsd: 0.4,
    },
  });
  await db.attempt.create({ data: { jobId: j.id, k: 2, startedAt: new Date(Date.now() - 90_000) } });
  const r = await kb('show', String(j.id));
  // $0.40 means very little without "and it took an hour" beside it.
  assert.match(r.out, /completed\s+1h04m \$0\.4000/);
  assert.match(r.out, /running\s+1m\+/, 'an attempt in flight shows elapsed-so-far, not nothing');
});

// ---------------------------------------------------------------- run

test('run on an empty board is a no-op that exits 0', async () => {
  const r = await kb('run', '--board', 'nothing-here', '--fake');
  assert.equal(r.code, 0);
  assert.match(r.out, /nothing pending/);
});

test('run --fake works a Job to succeeded and records the session pointer', async () => {
  const j = json((await kb('new', 'runme', '--brief', 'b', '--json')).out);
  await kb('run', String(j.id), '--fake');
  const row = await db.job.findUniqueOrThrow({ where: { id: j.id }, include: { attempts: true } });
  assert.equal(row.phase, 'succeeded');
  assert.equal(row.attempts.length, 1);
  assert.ok(row.attempts[0].sessionId);
});

test('run <id> touches only that Job', async () => {
  const a = json((await kb('new', 'only-a', '--brief', 'b', '--json')).out);
  const b = json((await kb('new', 'not-b', '--brief', 'b', '--json')).out);
  await kb('run', String(a.id), '--fake');
  assert.equal((await db.job.findUniqueOrThrow({ where: { id: a.id } })).phase, 'succeeded');
  assert.equal((await db.job.findUniqueOrThrow({ where: { id: b.id } })).phase, 'pending');
});

test('run on a Job that is not pending says so rather than pretending', async () => {
  const j = json((await kb('new', 'settled', '--brief', 'b', '--json')).out);
  await kb('run', String(j.id), '--fake');
  const r = await kb('run', String(j.id), '--fake');
  assert.match(r.out, new RegExp(`#${j.id} is not pending`));
});

test('run on a missing id refuses before spending anything', async () => {
  await assert.rejects(() => kb('run', '99999', '--fake'), /no Job #99999/);
});

// ---------------------------------------------------------------- rm

test('rm deletes a Job and its attempts', async () => {
  const j = json((await kb('new', 'goner', '--brief', 'b', '--json')).out);
  await kb('run', String(j.id), '--fake');
  await kb('rm', String(j.id));
  assert.equal(await db.job.findUnique({ where: { id: j.id } }), null);
  assert.equal(await db.attempt.count({ where: { jobId: j.id } }), 0, 'cascaded');
});

// ---------------------------------------------------------------- stop / start

test('stop is the kill switch: it refuses to claim and says who stopped it', async () => {
  await kb('new', 'blocked-by-stop', '--brief', 'b', '--board', 'switch', '--json');
  await kb('stop', '--board', 'switch');
  const r = await kb('run', '--board', 'switch', '--fake');
  assert.match(r.out, /refused:.*stopped/);
  assert.match(r.out, /kb start/, 'and says what to do about it');
});

test('a stopped board leaves its Jobs pending, not failed', async () => {
  const rows = json((await kb('ls', '--board', 'switch', '--json')).out);
  assert.ok(rows.every((j: { phase: string; attempts: number }) => j.phase === 'pending' && j.attempts === 0),
    'refusing to start is not failing');
});

test('start clears it and reports the ceilings', async () => {
  const r = await kb('start', '--board', 'switch');
  assert.match(r.out, /started/);
  assert.match(r.out, /no ceiling, 1 concurrent/);
  const after = await kb('run', '--board', 'switch', '--fake');
  assert.match(after.out, /1 succeeded/);
});

test('rm refuses a leased Job rather than orphaning a running worker', async () => {
  const j = json((await kb('new', 'leased', '--brief', 'b', '--json')).out);
  await db.lease.create({
    data: { jobId: j.id, holder: 'someone-else', token: 't', expiresAt: new Date(Date.now() + 60_000) },
  });
  await assert.rejects(() => kb('rm', String(j.id)), /leased by someone-else/);
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

// ---------------------------------------------------------------- one machine, many repositories

const { resolveBoard, gitRoot } = await import('../src/kb.ts');

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
    const j = json((await kb('new', 'from here', '--brief', 'b', '--json')).out);
    assert.equal(j.board, 'files-work');
    const board = await db.board.findUniqueOrThrow({ where: { slug: 'files-work' } });
    assert.equal(board.repoPath, root);
  } finally {
    process.chdir(before);
  }
});

test('kb boards add refuses a path that is not a repository, and says why', async () => {
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

test('kb boards add points a board at a repository, and re-pointing is not an error', async () => {
  const a = scratchRepo('target-a');
  const b = scratchRepo('target-b');
  await kb('boards', 'add', 'moved', '--repo', a);
  assert.equal((await db.board.findUniqueOrThrow({ where: { slug: 'moved' } })).repoPath, a);
  await kb('boards', 'add', 'moved', '--repo', b);
  assert.equal((await db.board.findUniqueOrThrow({ where: { slug: 'moved' } })).repoPath, b,
    'repositories move; a board should not have to be recreated when one does');
});

test('kb boards lists every board on the machine with its repository', async () => {
  const rows = json((await kb('boards', '--json')).out);
  const moved = rows.find((r: { board: string }) => r.board === 'moved');
  assert.ok(moved, 'the cluster view is one query, not a hunt across checkouts');
  assert.equal(moved.daemon, 'down');
  assert.equal(typeof moved.spent24h, 'number');
});

test('kb boards rejects a subcommand it does not have, rather than listing anyway', async () => {
  await assert.rejects(() => main(['boards', 'remove', 'x']), /no subcommand "remove"/);
});

