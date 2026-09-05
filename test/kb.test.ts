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

/** Run a verb and capture what it printed, so `--json` is asserted on its real output. */
async function kb(...argv: string[]): Promise<{ code: number; out: string }> {
  const chunks: string[] = [];
  const write = process.stdout.write.bind(process.stdout);
  (process.stdout as { write: unknown }).write = (s: string) => { chunks.push(String(s)); return true; };
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
