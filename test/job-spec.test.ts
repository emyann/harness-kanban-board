import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

/**
 * Editing a filed Job's spec.
 *
 * The refusals are the feature, as everywhere else on this board: what may be set is a closed list,
 * what may not is refused **by name** with the reason, and a running Job is refused outright
 * because its spec is what the live attempt was admitted under.
 *
 * No repository, no worktree, no CLI — a spec edit is a decision about board state, the same
 * property that makes `src/transitions.ts` callable by something that is not a terminal.
 */

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hkb-spec-'));
process.env.HKB_DATABASE_URL = `file:${path.join(dir, 'test.db')}`;
const PKG = path.resolve(import.meta.dirname, '..');
execFileSync(process.execPath, ['node_modules/prisma/build/index.js', 'migrate', 'deploy'], {
  cwd: PKG, env: process.env, stdio: 'ignore',
});

const { openBoard, closeBoard } = await import('../src/db.ts');
const { setJobSpec, describeChange, SETTABLE } = await import('../src/job-spec.ts');

const db = openBoard();
const board = await db.board.upsert({ where: { slug: 'spec' }, update: {}, create: { slug: 'spec' } });
let slot = 0;

const mkJob = (name: string, extra: Record<string, unknown> = {}) =>
  db.job.create({ data: { boardId: board.id, name, brief: `do ${name}`, ...extra } });
const events = (jobId: number) => db.event.findMany({ where: { jobId }, orderBy: { id: 'asc' } });
const refusal = async (fn: () => Promise<unknown>, re: RegExp) => {
  await assert.rejects(fn, (e: Error & { exitCode?: number }) => {
    assert.equal(e.exitCode, 2);
    assert.match(e.message, re);
    return true;
  });
};

test.after(async () => { await closeBoard(); fs.rmSync(dir, { recursive: true, force: true }); });

// ---------------------------------------------------------------- the refusals

test('a field that is not a Job\'s to set is refused BY NAME, with the reason', async () => {
  const j = await mkJob('fixed');
  // Not "unknown field": each of these is something somebody will genuinely reach for, and the
  // answer to each is different.
  await refusal(() => setJobSpec(db, j.id, { phase: 'succeeded' } as never, { by: 'a' }), /a phase is moved, not set/);
  await refusal(() => setJobSpec(db, j.id, { proposes: 'jobs' } as never, { by: 'a' }), /ADR-011/);
  await refusal(() => setJobSpec(db, j.id, { isolate: false } as never, { by: 'a' }), /cannot change its mind about having a worktree/);
  await refusal(() => setJobSpec(db, j.id, { boardId: 2 } as never, { by: 'a' }), /decides the repository/);
  // And something nobody planned for is refused too, with the list — a column added to the schema
  // does not become settable because somebody forgot to think about it.
  await refusal(() => setJobSpec(db, j.id, { lastError: 'x' } as never, { by: 'a' }), /is not a field of a Job's spec/);

  assert.equal((await db.job.findUniqueOrThrow({ where: { id: j.id } })).phase, 'pending', 'and nothing moved');
});

test('a RUNNING Job is refused — its spec is what the live attempt was admitted under', async () => {
  const j = await mkJob('live');
  await db.lease.create({
    data: { jobId: j.id, holder: 'host/3', token: 't1', slot: slot++, expiresAt: new Date(Date.now() + 60_000) },
  });
  await refusal(() => setJobSpec(db, j.id, { maxBudgetUsd: 9 }, { by: 'a' }), /leased by host\/3/);
  await refusal(() => setJobSpec(db, j.id, { maxBudgetUsd: 9 }, { by: 'a' }), /hkb down/);
  assert.equal((await db.job.findUniqueOrThrow({ where: { id: j.id } })).maxBudgetUsd, null);
});

test('setting nothing is a typo, not a no-op', async () => {
  const j = await mkJob('empty');
  await refusal(() => setJobSpec(db, j.id, {}, { by: 'a' }), /nothing to set/);
  await refusal(() => setJobSpec(db, 999999, { model: 'x' }, { by: 'a' }), /no Job #999999/);
});

// ---------------------------------------------------------------- what it does

test('a change is written AND recorded, because the attempts behind it ran under something else', async () => {
  const j = await mkJob('edited', { model: 'claude-haiku-4-5', maxBudgetUsd: 1 });
  const r = await setJobSpec(db, j.id, { model: 'claude-opus-5', maxBudgetUsd: 5 }, { by: 'yann' });

  assert.equal(r.changed.length, 2);
  const after = await db.job.findUniqueOrThrow({ where: { id: j.id } });
  assert.equal(after.model, 'claude-opus-5');
  assert.equal(after.maxBudgetUsd, 5);

  const ev = (await events(j.id)).at(-1);
  assert.equal(ev?.kind, 'spec_set');
  assert.equal(ev?.actor, 'yann');
  // The before AND the after: `hkb show` prints the spec the NEXT attempt gets, so without this the
  // log cannot explain why it disagrees with an attempt that already ran.
  assert.deepEqual(ev?.payload, {
    changed: [
      { field: 'model', from: 'claude-haiku-4-5', to: 'claude-opus-5' },
      { field: 'maxBudgetUsd', from: 1, to: 5 },
    ],
  });
});

test('a value that is already what it was is not recorded as a change', async () => {
  // An event stream that says "the model was changed from opus to opus" makes the one that says
  // something real harder to find.
  const j = await mkJob('same', { model: 'claude-opus-5' });
  const r = await setJobSpec(db, j.id, { model: 'claude-opus-5' }, { by: 'a' });
  assert.deepEqual(r.changed, []);
  assert.equal((await events(j.id)).length, 0, 'and nothing was written');
});

test('the brief IS settable here, which `queue` says it is not — and the log says so', async () => {
  // `queueJob` reserves the rewrite for the note-becomes-an-instruction moment, which is about
  // triage → pending. It was never a reason a typo should cost a Job its id and its history.
  const j = await mkJob('typo', { brief: 'reveiw the parser' });
  const r = await setJobSpec(db, j.id, { brief: 'review the parser' }, { by: 'yann' });
  assert.equal(r.changed[0].field, 'brief');
  assert.equal((await db.job.findUniqueOrThrow({ where: { id: j.id } })).brief, 'review the parser');
  const ev = (await events(j.id)).at(-1);
  assert.deepEqual(
    (ev?.payload as { changed: { from: string; to: string }[] }).changed[0],
    { field: 'brief', from: 'reveiw the parser', to: 'review the parser' },
    'both halves, so a completed attempt can still be read against the words it saw',
  );
});

test('a list REPLACES rather than appends, and null clears it', async () => {
  const j = await mkJob('tools', { allowedTools: ['Read', 'Grep'] });
  await setJobSpec(db, j.id, { allowedTools: ['Read'] }, { by: 'a' });
  assert.deepEqual((await db.job.findUniqueOrThrow({ where: { id: j.id } })).allowedTools, ['Read'],
    'replaced — a flag that appended would leave no way to remove one');

  await setJobSpec(db, j.id, { allowedTools: null }, { by: 'a' });
  assert.equal((await db.job.findUniqueOrThrow({ where: { id: j.id } })).allowedTools, null,
    'and cleared, so the board\'s default answers again');
});

test('an edit works on a terminal Job too, because the spec is what the NEXT attempt gets', async () => {
  const j = await mkJob('failed one', { phase: 'failed', maxBudgetUsd: 1 });
  const r = await setJobSpec(db, j.id, { maxBudgetUsd: 4 }, { by: 'a' });
  assert.equal(r.phase, 'failed', 'and the result says where it stands, since the edit does not move it');
  assert.equal((await db.job.findUniqueOrThrow({ where: { id: j.id } })).phase, 'failed');
});

test('a proposer may not have its gate cleared — the proposal would never be applied', async () => {
  // `hkb new` refuses to file a proposer with no gate. Clearing it here reached the same state by
  // the back door, and the failure is silent: the controller only suspends a Job that has a gate,
  // so the next attempt succeeds terminally with `proposal.json` parsed and never applied.
  const j = await mkJob('proposer', { proposes: 'jobs', gate: 'a proposal to review' });
  await refusal(() => setJobSpec(db, j.id, { gate: null }, { by: 'a' }), /nothing ever reads/);
  await refusal(() => setJobSpec(db, j.id, { gate: '' }, { by: 'a' }), /ADR-011/);
  assert.equal((await db.job.findUniqueOrThrow({ where: { id: j.id } })).gate, 'a proposal to review');

  // A non-proposer may clear its gate freely.
  const k = await mkJob('gated', { gate: 'ok?' });
  await setJobSpec(db, k.id, { gate: null }, { by: 'a' });
  assert.equal((await db.job.findUniqueOrThrow({ where: { id: k.id } })).gate, null);
});

test('an un-isolated Job may not be given a base it could never use', async () => {
  // `hkb new` refuses the pair at file time, calling a stored-but-never-honoured spec field a
  // silent failure. Setting it later reached the same place, and `hkb show` does not even print it.
  const j = await mkJob('in place', { isolate: false });
  await refusal(() => setJobSpec(db, j.id, { base: 'origin/main' }, { by: 'a' }), /cuts no branch/);
  assert.equal((await db.job.findUniqueOrThrow({ where: { id: j.id } })).base, null);
});

test('the brief is read only after the guards, and rendered the way `hkb new` renders it', async () => {
  let read = false;
  const producer = async () => { read = true; return 'review {{page}} carefully'; };
  const render = (text: string, inputs: { name: string }[]) => {
    const used = new Set<string>();
    let out = text;
    for (const i of inputs as { name: string; value?: string }[]) {
      if (i.value !== undefined && out.includes(`{{${i.name}}}`)) {
        out = out.split(`{{${i.name}}}`).join(i.value);
        used.add(i.name);
      }
    }
    return { text: out, used };
  };

  // Not read for a Job that does not exist — `--brief -` would otherwise hang on stdin.
  await refusal(() => setJobSpec(db, 999999, {}, { by: 'a', brief: producer, render }), /no Job #999999/);
  assert.equal(read, false);

  const j = await mkJob('render me', { inputs: [{ name: 'page', value: 'the parser' }] });
  const r = await setJobSpec(db, j.id, {}, { by: 'a', brief: producer, render });
  assert.equal(read, true);
  const after = await db.job.findUniqueOrThrow({ where: { id: j.id } });
  assert.equal(after.brief, 'review the parser carefully', 'interpolated, not stored with braces in it');
  assert.deepEqual(after.inputs, [], 'and a value that went into the brief does not also arrive as data');
  assert.ok(r.changed.some((c) => c.field === 'brief'));
});

test('a Job claimed mid-edit is refused, and no Event claims a change that did not happen', async () => {
  // The first version used a conditional `updateMany` in the array form of `$transaction`, whose
  // count nothing could look at — so a claim landing here wrote a `spec_set` event describing a
  // change the WHERE had just prevented, and the CLI said "1 field set".
  const j = await mkJob('contended', { model: 'claude-haiku-4-5' });
  await db.lease.create({
    data: { jobId: j.id, holder: 'host/race', token: 'tr', slot: slot++, expiresAt: new Date(Date.now() + 60_000) },
  });
  await refusal(() => setJobSpec(db, j.id, { model: 'claude-opus-5' }, { by: 'a' }), /leased by host\/race/);
  assert.equal((await db.job.findUniqueOrThrow({ where: { id: j.id } })).model, 'claude-haiku-4-5');
  assert.equal((await events(j.id)).length, 0, 'and nothing was recorded');
});

// ---------------------------------------------------------------- what an operator reads

test('describeChange renders a list and an absence as something a person says', () => {
  assert.equal(describeChange({ field: 'model', from: null, to: 'claude-opus-5' }), 'model  (none) → claude-opus-5');
  assert.equal(describeChange({ field: 'allowedTools', from: ['Read', 'Grep'], to: null }), 'allowedTools  Read|Grep → (none)');
  assert.equal(describeChange({ field: 'allowedTools', from: null, to: [] }), 'allowedTools  (none) → (empty)');
  assert.equal(describeChange({ field: 'labels', from: null, to: { area: 'parser' } }), 'labels  (none) → area=parser');
  // An array of OBJECTS is what `inputs` is, and `join` renders those as `[object Object]` — the
  // one shape this function exists to avoid and the one the test did not cover.
  assert.equal(
    describeChange({ field: 'inputs', from: null, to: [{ name: 'page', value: 'x' }] }),
    'inputs  (none) → name=page,value=x',
  );
  // A brief is the one settable field that is prose, and four paragraphs in a diff line helps nobody.
  const long = 'x'.repeat(200);
  assert.match(describeChange({ field: 'brief', from: null, to: long }), /…$/);
  assert.ok(describeChange({ field: 'brief', from: null, to: long }).length < 80);
});

test('SETTABLE names every field the CLI can set, and no field it cannot', () => {
  // The closed list is the guard. If a field is added here it must be reachable, and if a flag is
  // added it must be in here — the failure otherwise is silent in both directions.
  for (const f of ['name', 'brief', 'model', 'maxBudgetUsd', 'base', 'labels', 'gate', 'inputs', 'check']) {
    assert.ok((SETTABLE as readonly string[]).includes(f), `${f} is settable`);
  }
  for (const f of ['phase', 'proposes', 'isolate', 'boardId', 'id', 'lastError', 'lastSessionId']) {
    assert.ok(!(SETTABLE as readonly string[]).includes(f), `${f} is NOT settable`);
  }
  // `timeoutMs` reaches no flag and its column is non-nullable, so a caller clearing it would get a
  // raw Prisma error rather than a refusal. The list is what the CLI can set; anything on it that
  // nothing can reach is a promise with no keeper.
  assert.ok(!(SETTABLE as readonly string[]).includes('timeoutMs'), 'timeoutMs reaches no flag');
});
