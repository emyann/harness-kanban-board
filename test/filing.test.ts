import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

/**
 * Filing a Job, without a terminal.
 *
 * The point of the file as much as its content: every refusal below used to live inside
 * `switch (verb)` in `src/hkb.ts`, downstream of `parseArgs`, so the only way to exercise one was to
 * hand it argv and read what it printed. **There is no CLI here** — a filing is a spec, a board and
 * a set of reasons to say no, and needing no argv is what makes it callable by a web board.
 *
 * Written refusal-first, because that is what `createJob` mostly is. Every one of these messages is
 * the one the verb already threw, word for word: an extraction that quietly rewrote a message would
 * be a behaviour change wearing a refactor's clothes.
 */

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hkb-filing-'));
process.env.HKB_DATABASE_URL = `file:${path.join(dir, 'test.db')}`;
const PKG = path.resolve(import.meta.dirname, '..');
execFileSync(process.execPath, ['node_modules/prisma/build/index.js', 'migrate', 'deploy'], {
  cwd: PKG, env: process.env, stdio: 'ignore',
});

const { openBoard, closeBoard } = await import('../src/db.ts');
const { createJob } = await import('../src/filing.ts');

const db = openBoard();
const scope = { slug: 'filing', repoPath: null as string | null };

test.after(async () => { await closeBoard(); fs.rmSync(dir, { recursive: true, force: true }); });

const refusal = async (fn: () => Promise<unknown>, re: RegExp) => {
  await assert.rejects(fn, (e: Error & { exitCode?: number }) => {
    assert.equal(e.exitCode, 2, 'a refusal is exit code 2, the same shape the CLI already threw');
    assert.match(e.message, re);
    return true;
  });
};

/** A repository with workflows in it, since a workflow is read from the board's checkout. */
function repoWith(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(dir, 'repo-'));
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.join(root, path.dirname(rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), body);
  }
  return root;
}

// ---------------------------------------------------------------- what it refuses

test('a Job with no name and no workflow to take one from is refused', async () => {
  await refusal(() => createJob(db, scope, { brief: 'do it' }, { by: 'a' }), /a Job needs a name/);
});

test('a Job with no brief is refused, and named the three ways to give one', async () => {
  await refusal(() => createJob(db, scope, { name: 'unbriefed' }, { by: 'a' }),
    /a Job needs a brief — pass --brief "…", --brief-file <path>, or --brief - to read stdin/);
});

test('the guards run BEFORE the brief is read, so a doomed filing does not hang on stdin', async () => {
  // `--brief -` blocks until EOF. Reading it before the workflow is found turns a `--from` typo
  // from an instant refusal into a process that never returns — the trap `queueJob` documents.
  let read = false;
  const brief = async () => { read = true; return 'the brief'; };
  await refusal(
    () => createJob(db, { slug: 'filing', repoPath: repoWith({ 'README.md': '#\n' }) }, { name: 'x', brief, from: 'nope' }, { by: 'a' }),
    /there is no workflow `nope`/,
  );
  assert.equal(read, false, 'nothing was read for a workflow that is not there');

  const filed = await createJob(db, scope, { name: 'briefed', brief }, { by: 'a' });
  assert.equal(read, true, 'and it IS read once the guards pass');
  assert.equal((await db.job.findUniqueOrThrow({ where: { id: filed.row.id } })).brief, 'the brief');
});

test('a bare flag is refused rather than filed as the word `true`', async () => {
  // `parseArgs` under `strict: false` makes a valueless option the BOOLEAN true, and `String(...)`
  // of that is a model named `true`. The same union arrives from a workflow file, so the guard
  // belongs here and not only in the parser.
  await refusal(() => createJob(db, scope, { name: 'bare', brief: 'x', model: true }, { by: 'a' }),
    /--model was given nothing/);
  await refusal(() => createJob(db, scope, { name: 'bare', brief: 'x', export: [true] }, { by: 'a' }),
    /--export was given nothing/);
});

test('--check none is refused at file time: it would file a command that exits 127', async () => {
  await refusal(() => createJob(db, scope, { name: 'noned', brief: 'x', check: 'none' }, { by: 'a' }),
    /would file the literal shell command `none`/);
});

test('a proposing Job with a check is refused, because it changes nothing to check', async () => {
  await refusal(
    () => createJob(db, scope, { name: 'proposer', brief: 'x', propose: true, check: 'npm test' }, { by: 'a' }),
    /a proposing Job has nothing to check.*\(--check\)/s,
  );
});

test('--base and --no-isolate contradict each other, and neither is silently dropped', async () => {
  await refusal(
    () => createJob(db, scope, { name: 'contradiction', brief: 'x', base: 'origin/dev', 'no-isolate': true }, { by: 'a' }),
    /--base and --no-isolate contradict each other/,
  );
});

test('a gate with no question, an effort that is not one, and a label that is not key=value', async () => {
  await refusal(() => createJob(db, scope, { name: 'g', brief: 'x', gate: '  ' }, { by: 'a' }),
    /--gate needs the question a human is being asked/);
  await refusal(() => createJob(db, scope, { name: 'e', brief: 'x', effort: 'colossal' }, { by: 'a' }),
    /--effort must be one of low\|medium\|high\|xhigh\|max/);
  await refusal(() => createJob(db, scope, { name: 'l', brief: 'x', label: ['justatag'] }, { by: 'a' }),
    /=/);
});

test('a declared output that escapes the checkout never becomes state', async () => {
  await refusal(() => createJob(db, scope, { name: 'esc', brief: 'x', export: ['../outside.md'] }, { by: 'a' }),
    /\.\./);
  // And nothing was filed by the attempt: a refusal that half-created a Job would be worse than the
  // illegal request it refused.
  assert.equal(await db.job.findFirst({ where: { name: 'esc' } }), null);
});

test('a board whose default workflow is not in the repository is refused, with nothing created', async () => {
  const repo = repoWith({ 'README.md': '#\n' });
  const b = await db.board.upsert({
    where: { slug: 'has-default' },
    update: { repoPath: repo, defaultWorkflow: 'ship' },
    create: { slug: 'has-default', repoPath: repo, defaultWorkflow: 'ship' },
  });
  await refusal(
    () => createJob(db, { slug: 'has-default', repoPath: repo }, { name: 'w', brief: 'x' }, { by: 'a' }),
    /board has-default files every Job with the workflow `ship`.*hkb boards set has-default --workflow/s,
  );
  assert.equal(await db.job.count({ where: { boardId: b.id } }), 0);
});

test('a workflow whose body has placeholders and a Job that declares no inputs is refused', async () => {
  const repo = repoWith({ '.hkb/workflows/page.md': '---\nname: page\n---\nWrite {{page}}.\n' });
  await refusal(
    () => createJob(db, { slug: 'filing', repoPath: repo }, { name: 'p', from: 'page' }, { by: 'a' }),
    /the workflow `page` needs `\{\{page\}\}`, and this Job declares no inputs/,
  );
});

// ---------------------------------------------------------------- what it does

test('the actor is a parameter, so a caller that is not a terminal can say who filed', async () => {
  const filed = await createJob(db, scope, { name: 'attributed', brief: 'x' }, { by: 'alice@web' });
  const ev = await db.event.findFirstOrThrow({ where: { jobId: filed.row.id } });
  assert.equal(ev.kind, 'created');
  assert.equal(ev.actor, 'alice@web');
  assert.deepEqual(ev.payload, { name: 'attributed' });
});

test('the row IS what `hkb new --json` prints, resolved check and all', async () => {
  const filed = await createJob(db, scope, {
    name: 'complete', brief: 'do {{who}} a favour',
    export: ['docs/out.md'], result: ['finding'], artifact: ['report.pdf'],
    label: ['area=parser'], input: ['who=value:me', 'guide=file:README.md'],
    'max-budget': '3', 'max-turns': '9', deadline: '600',
  }, { by: 'a' });
  assert.deepEqual(filed.row, {
    id: filed.row.id,
    name: 'complete',
    phase: 'pending',
    board: 'filing',
    exports: ['docs/out.md'],
    results: ['finding'],
    artifacts: ['report.pdf'],
    // The `value:` input went into the brief, so it does not also arrive as a data block.
    inputs: [{ name: 'guide', valueFrom: { file: { path: 'README.md' } } }],
    labels: { area: 'parser' },
    proposes: null,
    check: { value: null, source: 'built-in' },
    from: null,
    standingSteps: null,
  });
  const row = await db.job.findUniqueOrThrow({ where: { id: filed.row.id } });
  assert.equal(row.brief, 'do me a favour', 'what the board stores is what the run is given');
  assert.equal(row.maxBudgetUsd, 3);
  assert.equal(row.maxTurns, 9);
  assert.equal(row.activeDeadlineSeconds, 600);
});

test('a triage note needs no brief — its name is the brief until somebody decides', async () => {
  const filed = await createJob(db, scope, { name: 'I noticed something', triage: true }, { by: 'a' });
  assert.equal(filed.row.phase, 'triage');
  assert.equal((await db.job.findUniqueOrThrow({ where: { id: filed.row.id } })).brief, 'I noticed something');
});

test('a proposing Job is gated by default, and files the question it was not given', async () => {
  const filed = await createJob(db, scope, { name: 'decompose', brief: 'split it up', propose: true }, { by: 'a' });
  assert.equal(filed.row.proposes, 'jobs');
  assert.equal((await db.job.findUniqueOrThrow({ where: { id: filed.row.id } })).gate, 'a proposal to review');
  assert.deepEqual(filed.row.check, { value: null, source: 'proposes' },
    'a proposing Job runs no check whatever the board says, and `--json` says so');
});

test('a workflow fills what is absent and the caller still wins — one rule, both directions', async () => {
  const repo = repoWith({
    '.hkb/workflows/implement.md':
      '---\nname: implement\ndescription: the usual\nmax-budget: 2\nmodel: opus\nallow-tool: [Read, Grep]\n---\nDo the work.\n',
  });
  const filed = await createJob(db, { slug: 'filing', repoPath: repo }, {
    name: 'from a file', from: 'implement', model: 'sonnet',
  }, { by: 'a' });
  const row = await db.job.findUniqueOrThrow({ where: { id: filed.row.id } });
  assert.equal(row.brief, 'Do the work.', 'the body is the brief');
  assert.equal(row.model, 'sonnet', 'the more specific value wins: a caller outranks the file');
  assert.equal(row.maxBudgetUsd, 2, 'and the file fills what the caller did not say');
  assert.deepEqual(row.allowedTools, ['Read', 'Grep']);
  assert.equal(filed.row.from, 'implement');
  assert.equal(filed.from?.description, 'the usual',
    'the workflow itself comes back beside the row, because `--json` has never carried its description');
});

test('the board default fills the same gaps, and is named without being composed into the brief', async () => {
  const repo = repoWith({
    '.hkb/workflows/finish.md': '---\nname: finish\ndescription: open a PR\nmax-retries: 1\n---\nOpen a draft pull request.\n',
  });
  await db.board.upsert({
    where: { slug: 'finishes' },
    update: { repoPath: repo, defaultWorkflow: 'finish' },
    create: { slug: 'finishes', repoPath: repo, defaultWorkflow: 'finish' },
  });
  const filed = await createJob(db, { slug: 'finishes', repoPath: repo }, { name: 'ordinary', brief: 'the work' }, { by: 'a' });
  const row = await db.job.findUniqueOrThrow({ where: { id: filed.row.id } });
  assert.equal(row.brief, 'the work', 'the steps are composed at claim time, not baked in here');
  assert.equal(row.maxRetries, 1, 'but the frontmatter filled what the Job did not say');
  assert.equal(filed.row.standingSteps, 'finish');
});

test('filing the first Job in a repository creates the board and points it at the checkout', async () => {
  const repo = repoWith({ 'README.md': '#\n' });
  await createJob(db, { slug: 'brand-new', repoPath: repo }, { name: 'first', brief: 'x' }, { by: 'a' });
  assert.equal((await db.board.findUniqueOrThrow({ where: { slug: 'brand-new' } })).repoPath, repo,
    'without it a machine-level daemon would have nowhere to cut the worktree');
});

// ---------------------------------------------------------------- the seam itself

test('the CLI no longer holds a `db.job.create` — ADR-015 rule, checked rather than remembered', () => {
  // The rule is "logic goes in a module; a verb parses arguments, calls it, and prints", and the
  // thing that made `hkb new` fail it was one statement. A grep is a weak test of a strong rule,
  // and it is the one that catches the next verb written back into the switch.
  const src = fs.readFileSync(path.join(PKG, 'src', 'hkb.ts'), 'utf8');
  assert.equal(src.includes('db.job.create'), false,
    'filing a Job belongs to src/filing.ts — `hkb new` parses, calls createJob, and prints');
});

// ---------------------------------------------------------------- what the review of #431 found

test('a refused filing leaves NO board behind — an illegal request never becomes state', async () => {
  // `db.board.upsert` ran above every declaration guard, so one mistyped `hkb new` in a fresh
  // repository added a board to `hkb boards` and to every machine-wide daemon pass, for ever.
  // The existing "never becomes state" case ran against a board that already existed, so it could
  // only ever catch half of this.
  await assert.rejects(
    () => createJob(db, { slug: 'ghost-board', repoPath: scope.repoPath }, { name: 'x', brief: 'b', export: ['../outside.md'] } as never, { by: 't' }),
    /escapes the worktree/,
  );
  assert.equal(await db.board.findUnique({ where: { slug: 'ghost-board' } }), null, 'no board was created');
});

test('a doomed filing does not block on stdin for a refusal that needs nothing from it', async () => {
  // `hkb new x --brief - --export ../outside.md` used to wait for EOF and then refuse for a reason
  // known before a byte was read. The producer records whether it was called.
  let read = false;
  const producer = async () => { read = true; return 'b'; };
  await assert.rejects(
    () => createJob(db, scope, { name: 'y', brief: producer, export: ['../outside.md'] } as never, { by: 't' }),
    /escapes the worktree/,
  );
  assert.equal(read, false, 'the brief was never read');
});

test('the ranges that `hkb job set` refuses are refused at filing too', async () => {
  // A Job could be FILED with a spec that could never be SET. A $0 or negative cap is not inert: it
  // resolves through `pick` (non-null wins) and every attempt dies on budget naming no cause.
  for (const [flag, value, pattern] of [
    ['max-budget', '0', /dollars above zero/],
    ['max-budget', '-5', /dollars above zero/],
    ['max-turns', '0', /1 or more/],
    ['max-turns', '1.5', /whole number of turns/],
    ['max-retries', '-2', /0 or more/],
  ] as [string, string, RegExp][]) {
    await assert.rejects(
      () => createJob(db, scope, { name: 'r', brief: 'b', [flag]: value } as never, { by: 't' }),
      pattern,
      `--${flag} ${value}`,
    );
  }
  // And the legal edges still file: 0 retries is "one attempt, do not retry".
  const ok = await createJob(db, scope, { name: 'edges', brief: 'b', 'max-retries': '0', 'max-budget': '0.01' } as never, { by: 't' });
  assert.equal(ok.row.id > 0, true);
});
