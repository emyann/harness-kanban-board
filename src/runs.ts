import type { openBoard } from './db.ts';
import { createJob, type FilingScope } from './filing.ts';
import { usage } from './flags.ts';
import { LABEL_TOKEN } from './labels.ts';
import { readTemplate, WORKFLOW_DIR } from './templates.ts';

/**
 * The second kind, and its controller — `Run` and `Step`.
 *
 * ## What this is, and what it deliberately is not
 *
 * ADR-018 says hkb-the-machinery is **one** kind, `Job`, whose whole contract is *cut a workspace,
 * run one agent session under limits, record what happened, clean up*. Ordering is not in it, and
 * `batch/v1` has no field for it either. So ordering is a kind of its own with a controller of its
 * own, built **on** the Job kind — the way `tekton.dev` is built on `batch/v1` and creates Pods.
 * This file is that controller, and the dependency runs one way only: it imports `createJob`, and
 * **nothing in `src/controller.ts` or `src/daemon.ts` imports this file.** `src/pass.ts` composes
 * the two, so neither has to know the other exists (`test/boundary.test.ts` asserts it).
 *
 * ## Four columns, and the reason there is no fifth
 *
 * A step is *mostly markdown and barely data*. The split is not between a step's parts but between
 * two questions asked at two different times: everything a controller needs to decide whether to
 * **create a row** is data, and everything needed to **carry that decision out** is a file, read
 * once, at the instant the Job is filed. So `Step` carries `runId`, `name` and `after`; the Job
 * carries `stepId`; and the model, the budget, the tool surface, the human gate and the whole
 * instruction stay in `.hkb/workflows/<name>.md`, whose frontmatter already has 21 keys
 * (`src/templates.ts`) and whose body is already a brief.
 *
 * The test that produced that list, and the one to apply to the next field somebody wants: *delete
 * it from the store and leave it only as bytes in a markdown file the controller may `cat` into a
 * prompt but never parse. Does any reconcile pass now reach a different create / flip / refuse
 * decision?* Operationally — does evaluating it require reading a row **other than this Step's own**,
 * on every pass? `after` does. A `model:` does not: `reconcileRuns` hands it to `createJob` unread,
 * and `createJob` already reads it from the file.
 *
 * `docs/is-a-step-data.md` is the derivation, including the two steps the test refuses to place.
 *
 * ## What v1 cannot do, said out loud
 *
 * No conditionals (`when`), no fan-out, no `finally`, and nothing flows along an edge yet — a
 * successor is filed because its predecessor **succeeded**, not because of anything it produced.
 * Each of those is a known shape with known prior art and none of them is guessed at here; the
 * first one to arrive gets built against a real workflow rather than designed against an imagined
 * one. That is the order ADR-018 was arrived at.
 */

type Db = ReturnType<typeof openBoard>;

/**
 * The phases that let a successor start.
 *
 * `succeeded` is the machine's answer and `done` is a person's — an operator who marks a Job done
 * has said the work is complete, and a successor that ignored them would make `hkb done` a lie.
 *
 * Everything else blocks, including `failed` and `cancelled`, and blocks **without an error**: a
 * blocked step is not a failure, it is a step whose turn has not come and may never come. `hkb
 * retry` on the predecessor is what unblocks it, and it works without this controller being told,
 * because readiness is recomputed from scratch on every pass.
 */
const SATISFIED = new Set(['succeeded', 'done']);

/** The phases a predecessor can never leave on its own. A successor behind one waits for a person. */
const TERMINAL_UNSATISFIED = new Set(['failed', 'cancelled']);

/** One step, as the readiness question needs to see it: a name, its edges, and its Job if it has one. */
export type StepState = {
  name: string;
  after: string[];
  /** The Job carrying this step out, or null while nothing has been filed for it. */
  job: { phase: string } | null;
};

/**
 * `Step.after`, out of a `Json` column, defensively.
 *
 * A `Json` column can hold anything a previous version or a hand-written `UPDATE` put there, and
 * the failure mode of guessing is a controller that files a Job whose predecessor never ran. So a
 * value that is not an array of strings reads as `[]` — no; as **not ready**, which is what the
 * callers below do with a name that resolves to nothing. Fail-safe in the direction that spends no
 * money.
 */
export function stepAfter(raw: unknown): string[] {
  return Array.isArray(raw) ? raw.filter((v): v is string => typeof v === 'string') : [];
}

/**
 * Which steps may be filed now.
 *
 * **Pure, and that is the point of it.** CLAUDE.md's rule is that a decision with no I/O in it gets
 * a module and an exhaustive test against the *refusing* case, because the refusing case is the one
 * that matters: this function deciding "ready" when it is not spends real money on a session whose
 * inputs do not exist yet. Every one of the four ways to be un-ready is a test in
 * `test/runs.test.ts`, and each of them falls out of the same two lines rather than being handled:
 *
 *   - **already filed** — `job` is not null, so the pass that filed it does not file it again;
 *   - **a predecessor that has not finished** — its phase is not in `SATISFIED`;
 *   - **a predecessor that failed** — same clause, no special case;
 *   - **an `after` naming a step that is not in this run** — `byName` misses, so it is never ready.
 *     A typo therefore costs nothing and says so through `stalled` below, rather than being
 *     silently treated as satisfied, which is the version of this bug that files everything at once;
 *   - **a cycle** — every step in it waits for a sibling that is itself unfiled, so none is ready
 *     and the run simply stops. No traversal, no visited set, no stack.
 *
 * An empty `after` is ready — `[].every()` is true — so the first step of a run needs no special
 * case anywhere in this file.
 *
 * It takes the whole run because that is what the question is about; a per-step signature would need
 * the siblings passed alongside anyway, and `after` naming siblings by name is what makes the run
 * the unit. It returns the same objects it was given, so a caller can carry its own row along.
 */
export function readyNow<S extends StepState>(steps: S[]): S[] {
  const byName = new Map(steps.map((s) => [s.name, s]));
  return steps.filter((s) => {
    if (s.job) return false;
    return s.after.every((n) => {
      const prev = byName.get(n);
      return !!prev?.job && SATISFIED.has(prev.job.phase);
    });
  });
}

/** A step that is waiting for something that is not going to happen by itself. */
export type Stalled = { step: string; why: string };

/**
 * The steps that will never become ready without a person — the other half of `readyNow`, and the
 * half that keeps a stuck run from being a silent one.
 *
 * hkb's fifth value is *never a silent failure*, and a run whose second step is behind a failed
 * first would otherwise sit there looking exactly like a run whose first step is still going. The
 * two need different words because they need different actions: one is *wait*, the other is
 * `hkb retry`.
 *
 * Pure, and reported rather than written: nothing here creates an Event. A level-triggered pass
 * recomputes this every time, so writing it would write the same row for ever — the runaway
 * `src/workspaces.ts` was rewritten to end. The caller decides what to do with it, and a foreground
 * `hkb run` prints it while the daemon says nothing.
 */
export function stalled(steps: StepState[]): Stalled[] {
  const byName = new Map(steps.map((s) => [s.name, s]));
  const out: Stalled[] = [];
  for (const s of steps) {
    if (s.job) continue;
    for (const n of s.after) {
      const prev = byName.get(n);
      if (!prev) {
        out.push({ step: s.name, why: `waits for \`${n}\`, which is not a step of this run` });
      } else if (prev.job && TERMINAL_UNSATISFIED.has(prev.job.phase)) {
        out.push({ step: s.name, why: `waits for \`${n}\`, which ${prev.job.phase}` });
      }
    }
  }
  return out;
}

/** What one pass over the runs did. `filed` merges into the controller's own report. */
export type RunsReport = { filed: number[]; stalled: { run: number; step: string; why: string }[] };

/**
 * The Job a step files, named so a person reading the board knows which run it belongs to.
 *
 * The run's name carries the intent and the step's name carries the phase of it, which is the pair
 * a listing has to show. It is a display decision and it lives here rather than in a column,
 * because a name that could drift from its run's name is a second copy of the same string.
 */
export const stepJobName = (runName: string, step: string): string => `${runName} — ${step}`;

/**
 * Cut a run: one `Run` row and a `Step` row per workflow, in the order given.
 *
 * **A chain, and only a chain.** Each step waits for the one before it, which is the whole authoring
 * surface of v1 — no DAG syntax, no file format, no new frontmatter grammar. That is deliberate and
 * it is trap #1 of `docs/is-a-step-data.md`: the method that worked on ADR-018 was to build the
 * smallest thing, run it, and see what it cannot say. A chain is enough to file a review after an
 * implementation, which is the forcing case that already exists.
 *
 * **Every refusal happens before anything is created**, on `--from`'s own rule: a workflow that is
 * not in the repository fails naming the path it looked for, with no half-cut run left behind. The
 * three that can only be caught here — a repeated step, a name that cannot be a label, a workflow
 * that is missing — are all cheaper to refuse than to reconcile around.
 */
export async function cutRun(
  db: Db,
  scope: FilingScope,
  spec: { name: string; steps: string[] },
  opts: { by: string },
): Promise<{ id: number; name: string; board: string; steps: { name: string; after: string[] }[] }> {
  const name = spec.name.trim();
  if (!name) throw usage('hkb new <name> --steps <workflow>,<workflow> — a run needs a name');
  if (!spec.steps.length) {
    throw usage(`--steps names no workflow — write \`--steps <name>,<name>\`, for files in ${WORKFLOW_DIR}/`);
  }

  const seen = new Set<string>();
  for (const step of spec.steps) {
    if (seen.has(step)) {
      throw usage(
        `\`${step}\` appears twice in --steps, and a step's name is how the one after it refers to `
        + 'back to it — two of them would be ambiguous. A workflow that genuinely runs twice needs '
        + 'two names, which is a copy of the file, which is the honest thing for it to be.',
      );
    }
    seen.add(step);
    // Refused here rather than at filing time, because the label is how a person finds the run's
    // Jobs on the board (`hkb ls --label run=<id>`) and a step that could not carry one would be
    // filed and then invisible. The rule is `src/labels.ts`'s, unchanged.
    if (!LABEL_TOKEN.test(step)) {
      throw usage(
        `\`${step}\` cannot be a step: its name becomes the label \`step=${step}\`, and a label is a `
        + 'letter or digit at each end with letters, digits, `-`, `_` and `.` between, up to 63 '
        + 'characters. Rename the workflow file.',
      );
    }
    // The workflow itself, read before anything exists. `readTemplate` refuses by path, so a typo
    // in the fourth step of four does not leave three rows behind.
    readTemplate(scope.repoPath, step);
  }

  const board = await db.board.upsert({
    where: { slug: scope.slug },
    update: {},
    create: { slug: scope.slug, repoPath: scope.repoPath },
  });
  const run = await db.run.create({
    data: {
      boardId: board.id,
      name,
      steps: {
        create: spec.steps.map((step, i) => ({
          name: step,
          after: i === 0 ? [] : [spec.steps[i - 1]],
        })),
      },
    },
    include: { steps: { orderBy: { id: 'asc' } } },
  });
  await db.event.create({
    data: {
      kind: 'run_cut',
      boardId: board.id,
      actor: opts.by,
      payload: { run: run.id, name, steps: spec.steps },
    },
  });
  return {
    id: run.id,
    name: run.name,
    board: scope.slug,
    steps: run.steps.map((s) => ({ name: s.name, after: stepAfter(s.after) })),
  };
}

/**
 * One pass over the runs: file a Job for every step whose turn has come.
 *
 * **Level-triggered, and idempotent by constraint rather than by memory.** It reads observed state
 * (which steps have Jobs, and what those Jobs' phases are), compares it to desired state (`after`),
 * and takes one step. Nothing depends on having seen a transition, so it is safe to interrupt, safe
 * to run twice, and correct after a restart — and the way it is made safe is the way
 * `applyProposals` already is: the created Job carries `stepId` under a `@unique`, so a second pass
 * over the same ready step is refused **by the database**, not by this function remembering. The
 * duplicate arrives as P2002 and is counted, not raised.
 *
 * **One read for the whole board**, which is CLAUDE.md's rule and the one the old workspace sweep
 * broke: the runs, their steps and their steps' Jobs' phases arrive together, so a board with fifty
 * finished runs costs one query and no per-step lookups. Runs with nothing left to file are not
 * fetched at all.
 *
 * It creates Jobs through **`createJob`** rather than `db.job.create`, which is the one thing about
 * `applyProposals`' precedent not worth copying: `createJob` is where a workflow is read, where a
 * declaration is refused by name, where the board's defaults fill, and where the `created` Event is
 * written. A second door into the Job table is a second set of rules to keep in step.
 */
export async function reconcileRuns(
  db: Db,
  opts: { board?: string; cwd?: string; by?: string } = {},
): Promise<RunsReport> {
  const runs = await db.run.findMany({
    where: {
      ...(opts.board ? { board: { slug: opts.board } } : {}),
      // Only runs with something left to do. A finished run is not read, so the cost of this pass
      // is proportional to what is in flight rather than to the board's history.
      steps: { some: { job: { is: null } } },
    },
    include: {
      board: { select: { slug: true, repoPath: true } },
      steps: {
        orderBy: { id: 'asc' },
        include: { job: { select: { phase: true } } },
      },
    },
    orderBy: { id: 'asc' },
  });

  const report: RunsReport = { filed: [], stalled: [] };
  for (const run of runs) {
    const state = run.steps.map((s) => ({
      id: s.id,
      name: s.name,
      after: stepAfter(s.after),
      job: s.job,
    }));
    for (const s of stalled(state)) report.stalled.push({ run: run.id, ...s });

    // The board's repository, never the process's cwd — CLAUDE.md's rule, because one daemon serves
    // every board. `opts.cwd` is the same fallback the controller's is: a board with no repoPath,
    // which is tests and `hkb run` in a checkout.
    const scope: FilingScope = {
      slug: run.board.slug,
      repoPath: run.board.repoPath ?? opts.cwd ?? null,
    };
    for (const step of readyNow(state)) {
      try {
        const filed = await createJob(db, scope, {
          // The step IS the workflow. No spec is passed alongside it, on purpose: everything a Job
          // needs is in that file, and a value repeated here would be a second place to edit it.
          from: step.name,
          name: stepJobName(run.name, step.name),
          // The human half of the ownership. Kubernetes conflates these in
          // `batch.kubernetes.io/job-name`; hkb cannot, because nothing in a controller may read a
          // label (`src/labels.ts`) — so `stepId` owns and these two only group. `hkb ls --label
          // run=<id>` is what makes fifty rows readable, and it needed no new verb.
          label: [`run=${run.id}`, `step=${step.name}`],
        }, { by: opts.by ?? 'runs', forStep: step.id });
        report.filed.push(filed.row.id);
      } catch (e) {
        // The unique key doing its job — an earlier pass filed this step. Nothing to say about it:
        // the row it would have created is already there, which is the outcome that was wanted.
        if ((e as { code?: string }).code === 'P2002') continue;
        // **Everything else stalls this step and nothing else**, and that is the shape of it that
        // matters. Filing can genuinely fail: the workflow file was deleted after the run was cut,
        // its body has a placeholder nothing can fill, a declaration in it is malformed. Left to
        // propagate, one such run would throw out of the whole pass — so a typo in one board's
        // workflow would stop every board's claim loop, every tick, for ever. That is not what a
        // controller does with a rejected create: Kubernetes records it against the object and
        // carries on with the rest.
        //
        // Reported rather than written, on the same rule as `stalled` above: a level-triggered pass
        // recomputes this every time, so an Event per pass would be the runaway `src/workspaces.ts`
        // was rewritten to end. The foreground verb prints it and the daemon says nothing, which is
        // the known cost of not writing it down (`docs/is-a-step-data.md`).
        report.stalled.push({
          run: run.id,
          step: step.name,
          why: `cannot be filed — ${(e as Error).message.split('\n')[0]}`,
        });
      }
    }
  }
  report.filed.sort((a, b) => a - b);
  return report;
}
