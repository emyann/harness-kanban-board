import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

/**
 * The second kind — `Run` and `Step` — and the one decision it makes.
 *
 * CLAUDE.md's rule is that **a guard is not proven by a test that asks whether it allows**: the
 * admission gate, the worktree base and the lease were each silently inert and each passed every
 * test it had. `readyNow` is exactly that shape of thing — a function whose failure mode is saying
 * *yes* — and saying yes wrongly here does not print a warning, it spends a session on a step whose
 * inputs do not exist. So the first half of this file is the four ways to be un-ready, at the
 * shipped defaults, with no configuration supplied by the test.
 *
 * The second half runs a real two-step chain end to end against the fake runtime, because a pure
 * function that is never called from the pass is a guard that is inert in exactly the way that rule
 * is about.
 */

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hkb-runs-'));
process.env.HKB_DATABASE_URL = `file:${path.join(dir, 'test.db')}`;
const REPO = path.resolve(import.meta.dirname, '..');
execFileSync(process.execPath, ['node_modules/prisma/build/index.js', 'migrate', 'deploy'], {
  cwd: REPO, env: process.env, stdio: 'ignore',
});

const { openBoard, closeBoard } = await import('../src/db.ts');
const { readyNow, stalled, stepAfter, cutRun, reconcileRuns, stepJobName } = await import('../src/runs.ts');
const { passToRest } = await import('../src/pass.ts');
const { fakeRuntime } = await import('../src/runtime/fake.ts');

const db = openBoard();

/** A throwaway repository with two workflows in it — a step IS a workflow file. */
const cwd = path.join(dir, 'scratch-repo');
fs.mkdirSync(path.join(cwd, '.hkb', 'workflows'), { recursive: true });
{
  const g = (...a: string[]) => execFileSync('git', a, { cwd, stdio: 'ignore' });
  g('init', '-q', '-b', 'main');
  g('config', 'user.email', 'c@test');
  g('config', 'user.name', 'c');
  fs.writeFileSync(path.join(cwd, 'README.md'), '# scratch\n');
  const wf = (name: string, body: string) =>
    fs.writeFileSync(path.join(cwd, '.hkb', 'workflows', `${name}.md`), body);
  wf('implement', `---\nname: implement\ndescription: write the thing\n---\n\nWrite it.\n`);
  wf('review', `---\nname: review\ndescription: read the thing\nno-isolate: true\n---\n\nRead it.\n`);
  // A workflow whose body has an unfilled placeholder. Nothing a run can supply, on purpose.
  wf('needy', `---\nname: needy\n---\n\nLook at {{page}} and say what is wrong.\n`);
  g('add', '-A');
  g('commit', '-qm', 'base');
}
/**
 * A board per test, sharing the one repository.
 *
 * Not tidiness: `reconcileRuns` is deliberately board-WIDE — it files every ready step it can see —
 * so two tests on one board make each other's assertions about `filed.length` depend on execution
 * order. A board is hkb's namespace and this is what namespaces are for.
 */
let boards = 0;
const freshBoard = async () => {
  const slug = `runs-${++boards}`;
  await db.board.create({ data: { slug, repoPath: cwd } });
  return { slug, repoPath: cwd };
};
const scope = await freshBoard();

test.after(async () => { await closeBoard(); fs.rmSync(dir, { recursive: true, force: true }); });

// ------------------------------------------------------------------ the pure decision

/** The shapes below are the pure function's whole input: a name, its edges, and its Job if it has one. */
const S = (name: string, after: string[] = [], phase?: string) =>
  ({ name, after, job: phase === undefined ? null : { phase } });

test('a step with no edges is ready at once, so a run needs no special case for its first', () => {
  assert.deepEqual(readyNow([S('implement')]).map((s) => s.name), ['implement']);
});

test('a step whose Job exists is never ready again — that is what stops a second pass re-filing it', () => {
  // Every phase, including the ones that are not terminal: a RUNNING step is not "ready", and a
  // failed one is not re-filed by this controller. `hkb retry` re-runs a Job; nothing here does.
  for (const phase of ['pending', 'running', 'succeeded', 'failed', 'suspended', 'done', 'cancelled', 'triage']) {
    assert.deepEqual(readyNow([S('implement', [], phase)]), [], `filed and ${phase}, and still offered`);
  }
});

test('a successor waits for its predecessor, and only succeeded or done release it', () => {
  // Asked about the SUCCESSOR alone: an unfiled `implement` is itself ready in every one of these,
  // which is right and is not what this test is about.
  const chain = (phase?: string) => readyNow([S('implement', [], phase), S('review', ['implement'])])
    .map((s) => s.name).filter((n) => n === 'review');
  // Not filed at all.
  assert.deepEqual(chain(), []);
  // Filed, still going, or ended in a way that is not success.
  for (const phase of ['pending', 'running', 'suspended', 'failed', 'cancelled', 'triage']) {
    assert.deepEqual(chain(phase), [], `released by a predecessor that is ${phase}`);
  }
  // The two that do release it: the machine's answer, and a person's.
  assert.deepEqual(chain('succeeded'), ['review']);
  assert.deepEqual(chain('done'), ['review'], 'hkb done is an operator saying the work is complete');
});

test('an `after` naming a step that is not in the run never fires — a typo costs nothing', () => {
  // The bug this refuses is the one that files everything at once: a lookup that misses, read as
  // "no predecessor", is indistinguishable from an empty `after`.
  assert.deepEqual(readyNow([S('review', ['implment'])]), []);
  assert.deepEqual(
    stalled([S('review', ['implment'])]),
    [{ step: 'review', why: 'waits for `implment`, which is not a step of this run' }],
  );
});

test('a cycle stops the run rather than hanging it, with no traversal anywhere', () => {
  const cyc = [S('a', ['b']), S('b', ['a'])];
  assert.deepEqual(readyNow(cyc), []);
  // And a three-step one, because a two-step cycle can be got right by accident.
  assert.deepEqual(readyNow([S('a', ['c']), S('b', ['a']), S('c', ['b'])]), []);
});

test('a step behind a failure is stalled, and the word for it is not the word for waiting', () => {
  const steps = [S('implement', [], 'failed'), S('review', ['implement'])];
  assert.deepEqual(readyNow(steps), []);
  assert.deepEqual(stalled(steps), [{ step: 'review', why: 'waits for `implement`, which failed' }]);
  // Still going is NOT stalled: the two need different words because they need different actions.
  assert.deepEqual(stalled([S('implement', [], 'running'), S('review', ['implement'])]), []);
});

test('a fan-in waits for every one of its predecessors, not the first', () => {
  const steps = (a: string, b: string) => [S('a', [], a), S('b', [], b), S('c', ['a', 'b'])];
  assert.deepEqual(readyNow(steps('succeeded', 'running')).map((s) => s.name), []);
  assert.deepEqual(readyNow(steps('running', 'succeeded')).map((s) => s.name), []);
  assert.deepEqual(readyNow(steps('succeeded', 'succeeded')).map((s) => s.name), ['c']);
});

test('`after` out of a Json column reads defensively, and an unusable value blocks rather than fires', () => {
  assert.deepEqual(stepAfter(['a', 'b']), ['a', 'b']);
  assert.deepEqual(stepAfter([]), []);
  // Everything a hand-written UPDATE or an older version could have left there. Each reads as `[]`
  // for `stepAfter` — but the names are then gone, so nothing they referred to can be satisfied.
  for (const junk of [null, undefined, 'implement', 42, {}, { after: ['a'] }]) {
    assert.deepEqual(stepAfter(junk), [], `${JSON.stringify(junk)} should not become an edge`);
  }
  // The one that matters: a mixed array keeps the usable names and drops the rest, so a corrupted
  // entry cannot silently release a step by emptying its edge list.
  assert.deepEqual(stepAfter(['a', 7, null, 'b']), ['a', 'b']);
});

// ------------------------------------------------------------------ cutting a run

test('a run is cut as a chain, and nothing is filed by cutting it', async () => {
  const run = await cutRun(db, scope, { name: 'the parser', steps: ['implement', 'review'] }, { by: 'test' });
  assert.equal(run.name, 'the parser');
  assert.deepEqual(run.steps, [
    { name: 'implement', after: [] },
    { name: 'review', after: ['implement'] },
  ]);
  // Rows eager, Jobs lazy — `JobSpec.suspend`'s shape. The declaration exists and is visible; nothing
  // has been created on the Job table by saying so.
  assert.equal(await db.job.count({ where: { step: { runId: run.id } } }), 0);
});

test('cutting refuses before it creates: a missing workflow, a repeat, an unlabellable name', async () => {
  const before = await db.run.count();
  // The refusal that matters most, because it is the one a typo produces. It must name the path.
  await assert.rejects(
    () => cutRun(db, scope, { name: 'x', steps: ['implement', 'reveiw'] }, { by: 'test' }),
    (e: Error) => /reveiw/.test(e.message) && /\.hkb\/workflows/.test(e.message),
  );
  await assert.rejects(
    () => cutRun(db, scope, { name: 'x', steps: ['implement', 'implement'] }, { by: 'test' }),
    /appears twice/,
  );
  await assert.rejects(() => cutRun(db, scope, { name: 'x', steps: [] }, { by: 'test' }), /--steps names no workflow/);
  await assert.rejects(() => cutRun(db, scope, { name: '  ', steps: ['implement'] }, { by: 'test' }), /a run needs a name/);
  // Nothing half-cut. The fourth step of four failing must not leave three rows behind.
  assert.equal(await db.run.count(), before, 'a refused cut created a Run row');
});

// ------------------------------------------------------------------ the pass, end to end

test('a two-step run files its second Job only after its first has succeeded', async () => {
  const mine = await freshBoard();
  const run = await cutRun(db, mine, { name: 'end to end', steps: ['implement', 'review'] }, { by: 'test' });
  const stepsOf = () => db.step.findMany({
    where: { runId: run.id }, orderBy: { id: 'asc' }, include: { job: { select: { id: true, phase: true } } },
  });

  // ONE pass: the first step is filed and the second is not. This is the whole assertion of the
  // design — a pass that filed both would be the bug `readyNow` exists to refuse.
  const first = await reconcileRuns(db, { board: mine.slug, cwd });
  assert.deepEqual(first.stalled, []);
  assert.equal(first.filed.length, 1);
  let steps = await stepsOf();
  assert.equal(steps[0].job?.id, first.filed[0]);
  assert.equal(steps[1].job, null, 'the second step was filed before its predecessor ran');

  // The Job a step files is an ordinary Job, named and labelled so a person can find it.
  const job = await db.job.findUniqueOrThrow({ where: { id: first.filed[0] } });
  assert.equal(job.name, stepJobName('end to end', 'implement'));
  assert.deepEqual(job.labels, { run: String(run.id), step: 'implement' });
  assert.equal(job.stepId, steps[0].id, 'the owner reference belongs on the Job, not the Step');

  // Now run the board to rest. Both steps end up filed and succeeded, in order.
  await passToRest({ runtime: fakeRuntime(), cwd, board: mine.slug });
  steps = await stepsOf();
  assert.equal(steps[0].job?.phase, 'succeeded');
  assert.equal(steps[1].job?.phase, 'succeeded', 'the second step never ran');
  assert.ok(steps[1].job!.id > steps[0].job!.id, 'the second Job was filed before the first');
});

test('the pass is idempotent by constraint: running it twice files nothing twice', async () => {
  const mine = await freshBoard();
  const run = await cutRun(db, mine, { name: 'twice', steps: ['implement'] }, { by: 'test' });
  const a = await reconcileRuns(db, { board: mine.slug, cwd });
  const b = await reconcileRuns(db, { board: mine.slug, cwd });
  assert.equal(a.filed.length, 1);
  assert.equal(b.filed.length, 0, 'a second pass filed the same step again');
  assert.equal(await db.job.count({ where: { step: { runId: run.id } } }), 1);
});

test('a step whose predecessor failed stops the run, and the run says which retry moves it', async () => {
  const mine = await freshBoard();
  const run = await cutRun(db, mine, { name: 'stops', steps: ['implement', 'review'] }, { by: 'test' });
  await reconcileRuns(db, { board: mine.slug, cwd });
  const first = await db.step.findFirstOrThrow({ where: { runId: run.id, name: 'implement' }, include: { job: true } });
  await db.job.update({ where: { id: first.job!.id }, data: { phase: 'failed' } });

  const report = await reconcileRuns(db, { board: mine.slug, cwd });
  assert.equal(report.filed.length, 0, 'a successor was filed behind a failure');
  assert.deepEqual(report.stalled, [{ run: run.id, step: 'review', why: 'waits for `implement`, which failed' }]);

  // And it is level-triggered: nothing is told that the Job recovered, and the successor still goes.
  await db.job.update({ where: { id: first.job!.id }, data: { phase: 'succeeded' } });
  const after = await reconcileRuns(db, { board: mine.slug, cwd });
  assert.equal(after.filed.length, 1, 'the run did not resume after its first step succeeded');
  assert.deepEqual(after.stalled, []);
});

test("deleting a step's Job re-files it — the Step is the declaration and outlives one run of it", async () => {
  const mine = await freshBoard();
  await cutRun(db, mine, { name: 'redo', steps: ['implement'] }, { by: 'test' });
  const one = await reconcileRuns(db, { board: mine.slug, cwd });
  await db.job.delete({ where: { id: one.filed[0] } });
  const two = await reconcileRuns(db, { board: mine.slug, cwd });
  assert.equal(two.filed.length, 1, 'the Step did not survive its Job being removed');
  assert.notEqual(two.filed[0], one.filed[0]);
});

test('a pass scoped to one board never files another board\'s step', async () => {
  const mine = await freshBoard();
  const theirs = await freshBoard();
  const other = await cutRun(db, theirs, { name: 'theirs', steps: ['implement'] }, { by: 'test' });
  const report = await reconcileRuns(db, { board: mine.slug, cwd });
  assert.equal(report.filed.length, 0, 'a scoped pass filed a step belonging to another board');
  assert.equal(await db.job.count({ where: { step: { runId: other.id } } }), 0);
  // And the other board's own pass does file it, so the scope is a filter and not a refusal.
  assert.equal((await reconcileRuns(db, { board: theirs.slug, cwd })).filed.length, 1);
});

test('deleting a run takes its steps and leaves its Jobs, which are a record of what happened', async () => {
  const mine = await freshBoard();
  const run = await cutRun(db, mine, { name: 'gone', steps: ['implement'] }, { by: 'test' });
  const filed = (await reconcileRuns(db, { board: mine.slug, cwd })).filed[0];
  await db.run.delete({ where: { id: run.id } });
  assert.equal(await db.step.count({ where: { runId: run.id } }), 0, 'steps did not cascade');
  const job = await db.job.findUnique({ where: { id: filed } });
  assert.ok(job, 'the Job was deleted with its Run — history is not a declaration');
  assert.equal(job.stepId, null, 'the owner reference was not cleared');
});

// ------------------------------------------------------------------ the refusal that is not optional

/**
 * The guard `docs/is-a-step-data.md` says must ship with the slice.
 *
 * A `value:` input is spliced into the brief as **instruction** and then dropped from the fenced
 * data block (`renderBrief`, `src/filing.ts`), and the licence for that is *"the filer supplied it
 * and the filer wrote the placeholder"* (`src/inputs.ts`). When the filer is a controller, that
 * licence is false — so the moment a cross-step value is passed this way it is prompt injection
 * performed by the engine's own hands.
 *
 * v1 passes no values along an edge, and this is what makes that a *fact* rather than an intention:
 * a step whose workflow has a placeholder is refused, by name, rather than filled by the controller
 * from anything it happens to have.
 */
test('a step whose workflow has an unfilled placeholder is refused, not filled by the controller', async () => {
  const mine = await freshBoard();
  const run = await cutRun(db, mine, { name: 'needy run', steps: ['needy'] }, { by: 'test' });
  // A healthy run on the same board, because the second half of this is the more important half.
  const ok = await cutRun(db, mine, { name: 'healthy', steps: ['implement'] }, { by: 'test' });

  const report = await reconcileRuns(db, { board: mine.slug, cwd });
  assert.equal(await db.job.count({ where: { step: { runId: run.id } } }), 0, 'a placeholder was filled');
  assert.match(
    report.stalled.find((s) => s.run === run.id)?.why ?? '',
    /\{\{page\}\}/,
    'the refusal did not reach the operator by name',
  );
  // **One broken run does not stop the board.** Left to propagate, a typo in one workflow file
  // would throw out of the pass and stop every board's claim loop on every tick.
  assert.equal(await db.job.count({ where: { step: { runId: ok.id } } }), 1,
    'a healthy run behind a broken one was not filed');
  assert.equal(report.filed.length, 1);
});
