import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

/**
 * ADR-018's boundary, as a test that **refuses**.
 *
 * The line between hkb-the-machinery and hkb-the-board has been drawn three times — ADR-015 drew
 * it, ADR-016 mapped the Pod spec, ADR-017 moved the pull request out — and re-argued a session
 * later every time, because each left a description rather than a check. A description is something
 * the next session re-derives from whatever the code looks like by then.
 *
 * So this is the check. It is deliberately about **imports**, because the whole boundary reduces to
 * a direction of dependency: the board may use core primitives, and the core may never name a board
 * concept. One import in the wrong direction is the entire failure, and it is greppable.
 *
 * CLAUDE.md's rule is that a guard is not proven by a test that asks whether it allows. This asks
 * only whether it refuses, at the shipped defaults, and it fails the moment anybody reintroduces
 * git to the Job kind — including by writing a new module and importing that.
 */

const SRC = path.resolve(import.meta.dirname, '..', 'src');
const read = (rel: string) => fs.readFileSync(path.join(SRC, rel), 'utf8');

/** Every file the Job kind is made of. A new one here is a deliberate act, so the list is closed. */
const THE_CORE = [
  'controller.ts', 'daemon.ts', 'limits.ts', 'liveness.ts', 'spec.ts', 'transitions.ts',
  'workspaces.ts', 'brief.ts', 'exports.ts', 'results.ts', 'artifacts.ts', 'check.ts',
  'runtime/index.ts',
];

/**
 * Modules that no longer exist, and must not come back into the core under any name.
 *
 * They were deleted rather than moved: `worktree.ts` reimplemented the harness feature for feature,
 * and `push.ts`, `pre-push.ts`, `rebase.ts` and `pulls.ts` were a git protocol the core no longer
 * requires. A file reappearing with one of these names is the strongest possible signal that the
 * conflation is back.
 */
const DELETED = ['worktree.ts', 'push.ts', 'pre-push.ts', 'rebase.ts', 'pulls.ts'];

test('the modules the git protocol lived in are gone, and stay gone', () => {
  for (const name of DELETED) {
    assert.equal(
      fs.existsSync(path.join(SRC, name)), false,
      `src/${name} is back. It was deleted, not moved (ADR-018): the core requires no commit, push `
      + 'or rebase, and reimplements no part of its harness. If something needs it, it is a board '
      + 'concern and belongs to a board kind.',
    );
  }
});

test('nothing in the Job kind imports a git module', () => {
  for (const file of THE_CORE) {
    const src = read(file);
    for (const gone of DELETED) {
      const stem = gone.replace(/\.ts$/, '');
      assert.doesNotMatch(
        src,
        new RegExp(`from ['"][./]*${stem}\\.ts['"]`),
        `src/${file} imports ${gone}`,
      );
    }
  }
});

/**
 * The forge, by every name it answers to.
 *
 * `pulls.ts` was the only module that shelled out to `gh`, and deleting it is only half the rule —
 * the other half is that nothing re-adds a `gh` call somewhere more convenient. A board that wants
 * to talk to GitHub does it from a board kind, or from a workflow's content, where it is one
 * consumer's opinion rather than the machinery's assumption.
 */
test('nothing in the Job kind reaches a forge', () => {
  for (const file of THE_CORE) {
    const src = read(file).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
    assert.doesNotMatch(src, /['"`]gh['"`]/, `src/${file} shells out to gh`);
    assert.doesNotMatch(src, /\bprForBranch\b|\bforgeAvailable\b/, `src/${file} reads the forge`);
  }
});

/**
 * Git commands, in the code rather than in the prose.
 *
 * Comments are exempt on purpose: a rationale that cannot name the thing it removed is a rationale
 * nobody can check, and these files carry the derivation. What is banned is *running* git — which
 * `src/workspaces.ts` is the single sanctioned exception to, because collecting a workspace is the
 * one thing `ttlSecondsAfterFinished` makes the Job controller's own job.
 */
test('the Job kind runs no git, apart from collecting the workspace it asked for', () => {
  /**
   * Two exceptions, both named rather than tolerated by a looser rule.
   *
   *   - `workspaces.ts` takes a workspace back, which is what `ttlSecondsAfterFinished` makes the
   *     Job controller's own job. Its narrowness is asserted below.
   *   - `daemon.ts` reads **hkb's own** build SHA for `hkb up --status`, so an operator can see
   *     that a running daemon is older than the checkout. That is hkb asking about itself, not
   *     about a workload's repository — a different repository, a different question, and it would
   *     be just as true if no Job ever touched git.
   */
  const RUNS_GIT = new Set(['workspaces.ts', 'daemon.ts']);
  for (const file of THE_CORE) {
    if (RUNS_GIT.has(file)) continue;
    const code = read(file).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
    assert.doesNotMatch(code, /['"`]git['"`]/, `src/${file} runs git`);
  }
  // The daemon's exception is exactly one read, about itself, and nothing else.
  const daemon = read('daemon.ts').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  const gitCalls = [...daemon.matchAll(/execFileSync\('git', \[([^\]]*)\]/g)].map((m) => m[1]);
  assert.deepEqual(gitCalls, ["'rev-parse', '--short', 'HEAD'"],
    'the daemon may ask git what hkb itself is running, and nothing else');
  // And the exception is exactly as narrow as it claims: two subcommands, neither of them about the
  // work inside a tree. `list` is the board-wide enumeration the sweep starts from — without it the
  // sweep would try to remove a workspace per finished Job per tick, for ever — and `remove` takes
  // one back. There is deliberately no `unlock`: a locked workspace is one somebody is using, and
  // clearing the lock before removing would make the lock protect nothing.
  const ws = read('workspaces.ts').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  const subcommands = [...ws.matchAll(/'worktree', '(\w+)'/g)].map((m) => m[1]).sort();
  assert.deepEqual([...new Set(subcommands)], ['list', 'remove']);
  assert.doesNotMatch(ws, /--force/, 'and it never forces: git\'s own refusal is the safety net');
});

test('no core spec field is git-shaped', () => {
  // `Job.base` is the one that kept dragging git back in: an arbitrary base branch is only
  // meaningful to a workload that is code in a repository, and it is what forced the controller to
  // fetch, resolve and validate refs. `batch/v1` has no such field, and neither does this one.
  const schema = fs.readFileSync(path.resolve(import.meta.dirname, '..', 'prisma', 'schema.prisma'), 'utf8')
    .split('\n').filter((l) => !l.trim().startsWith('///') && !l.trim().startsWith('//')).join('\n');
  for (const [field, why] of [
    ['base', 'an arbitrary base branch is a board concern (ADR-018 decision 3)'],
    ['branch', 'the core does not know what a branch is'],
    ['prNumber', 'the core does not read a forge'],
    ['prUrl', 'the core does not read a forge'],
  ] as [string, string][]) {
    assert.doesNotMatch(
      schema,
      new RegExp(`^\\s+${field}\\s+\\w`, 'm'),
      `the schema has a \`${field}\` column again — ${why}`,
    );
  }
});

/**
 * The OTHER boundary — the one this repository has not had a guard for until now.
 *
 * ADR-018's rule is a *direction of dependency*: the board may use core primitives, and the core may
 * never name a board concept. `Run`/`Step` (`src/runs.ts`) is a board kind with a controller of its
 * own, built on the Job kind the way `tekton.dev` is built on `batch/v1`. The tempting shortcut is
 * one line in `reconcile()` calling `reconcileRuns()` — which is how the last three attempts at this
 * line dissolved, because each of them left a description instead of a check.
 *
 * `src/pass.ts` is the composition, and it is the only file allowed to know both.
 */
test('the Job kind does not know the Run kind exists', () => {
  for (const file of THE_CORE) {
    assert.doesNotMatch(
      read(file),
      /from ['"][./]*runs\.ts['"]/,
      `src/${file} imports src/runs.ts. Ordering is a board concern with a controller of its own `
      + '(ADR-018); the core may not reach for it. `src/pass.ts` composes the two, and it is the '
      + 'only file that may import both.',
    );
  }
});

/**
 * Sequencing is not scheduling, and the day they merge nobody will notice without this.
 *
 * hkb's fleet half is finished — ceilings, leases, liveness, per-board leader election — and its
 * sequencing half is `src/runs.ts`. **A step becoming ready is a request to schedule; whether it
 * runs now is the fleet's business.** A Run controller that grew its own concurrency knob would be
 * a second scheduler, disagreeing with the first about a board it shares.
 */
test('the Run kind schedules nothing — it files rows and stops', () => {
  const runs = read('runs.ts').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  for (const [gone, why] of [
    ['limits.ts', 'a ceiling is the fleet\'s answer, checked once, before a claim'],
    ['liveness.ts', 'whether a holder is alive is a question about a lease, and runs hold none'],
  ] as [string, string][]) {
    assert.doesNotMatch(
      runs,
      new RegExp(`from ['"][./]*${gone.replace('.', '\\.')}['"]`),
      `src/runs.ts imports ${gone} — ${why}`,
    );
  }
  assert.doesNotMatch(
    runs, /\bLease\b|\bmaxConcurrent\b|\bdailyBudgetUsd\b/,
    'src/runs.ts names a scheduling concept. Sequencing decides WHAT is next; scheduling decides '
    + 'whether anything runs now. Two schedulers on one board disagree.',
  );
  // And the composition is exactly one file deep. `src/pass.ts` imports both halves; the two halves
  // import neither it nor each other. What DOES import it is an entry point — `src/daemon.ts`, which
  // is the process that drives a pass on a timer, and `src/hkb.ts`, which is the one that drives it
  // in the foreground. Neither of those is reconciling anything; they are choosing when a pass
  // happens, which is the one job a composition root has.
  for (const file of ['controller.ts', 'runs.ts']) {
    assert.doesNotMatch(
      read(file), /from ['"][./]*pass\.ts['"]/,
      `src/${file} imports src/pass.ts — composition flows one way, from the entry point inward`,
    );
  }
});

/**
 * The Step kind's own minimality, which is the answer `docs/is-a-step-data.md` arrived at.
 *
 * A step is *mostly markdown and barely data*: everything a controller needs to decide whether to
 * CREATE a row is data, everything needed to carry that decision out is a file read once at filing
 * time. The fields below are the ones that get proposed first and every one of them is already a
 * `TEMPLATE_KEYS` entry — a column for any of them would be a second place to edit one value, and
 * the controller would still hand it over unread.
 */
test('no Step column is a spec field', () => {
  const schema = fs.readFileSync(path.resolve(import.meta.dirname, '..', 'prisma', 'schema.prisma'), 'utf8');
  const model = schema.slice(schema.indexOf('\nmodel Step {') + 1);
  const body = model.slice(0, model.indexOf('\n}'))
    .split('\n').filter((l) => !l.trim().startsWith('///') && !l.trim().startsWith('//')).join('\n');
  for (const field of ['model', 'brief', 'effort', 'gate', 'guide', 'check', 'maxBudgetUsd', 'allowedTools', 'phase']) {
    assert.doesNotMatch(
      body, new RegExp(`^\\s+${field}\\s+\\w`, 'm'),
      `Step has a \`${field}\` column. Every one of these is already a workflow frontmatter key `
      + '(`src/templates.ts`), which the filing path reads and no reconcile pass ever does — so it '
      + 'changes no create/flip/refuse decision, and a column would only be a second place to edit '
      + 'it. `phase` is the other kind of wrong: it would be a copy of the Job\'s, rewritten on '
      + 'every child transition, which is the write amplification Tekton removed in v0.45.',
    );
  }
});
