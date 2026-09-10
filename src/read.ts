import type { openBoard } from './db.ts';
import { jobLabels, selects } from './labels.ts';
import { boardDefaults, hasDefaults, jsonCheck, resolveSpec } from './spec.ts';
import { usage } from './flags.ts';
import * as daemon from './daemon.ts';

/**
 * The read model — the three questions every consumer of this board asks.
 *
 * `src/transitions.ts` and `src/filing.ts` are the write half of ADR-015's test; this is the read
 * half, and it is the one a web board hits first. `hkb boards`, `hkb ls` and `hkb show` each held
 * their query, their shaping and their printing in one `case` of `switch (verb)` — so a second
 * consumer had to re-derive `producedNothing`, re-resolve the spec, and re-decide which of the
 * three levels answered. Two surfaces re-deriving one answer is how they come to disagree, and
 * these three have disagreed before: `hkb new --json` and `hkb show --json` printed different
 * checks for the same Job (`jsonCheck`, `src/spec.ts`).
 *
 * ## The returned object IS what `--json` prints
 *
 * Not "a shape the CLI then maps to `--json`" — the same object, emitted verbatim. That is the
 * whole discipline of the file: `emit(out, await listJobs(...), () => …)` cannot drift from a web
 * board reading `listJobs` directly, because there is nothing in between to drift. What the human
 * output does with it is rendering, and it stays in the verb.
 *
 * ## What is NOT here
 *
 * The renderers — `formatDuration`, `describeDefaults`, the column widths. Those are a terminal's
 * opinion about a screen, and a web board wants none of them. And `hkb log` / `hkb watch`, which
 * are the event stream rather than the board's state; `src/watch.ts` already owns that seam.
 */

type Db = ReturnType<typeof openBoard>;

/**
 * Every phase a Job can be in, in the order a board reads them: the inbox, the queue, the run, the
 * four ways it ends, and the one that is waiting for a person.
 *
 * Here rather than in the CLI because it is the board's vocabulary and not a flag's — a consumer
 * building a filter needs the list as much as `--phase` does.
 */
export const PHASES = ['triage', 'pending', 'running', 'succeeded', 'failed', 'suspended', 'done', 'cancelled'] as const;
export type Phase = (typeof PHASES)[number];

/**
 * What a Job left behind, and whether that is anything at all.
 *
 * `succeeded` means the session ended. Nothing in the machinery requires it to have produced
 * anything: `withProtocol` (`src/brief.ts`) *asks* for a pull request in prose, and only when the
 * Job is isolated; `nextPhase` decides the phase from the runtime's status alone. That separation is
 * deliberate — "I looked, and there is nothing to change" is a real outcome, and so is a Job that
 * runs in the operator's own checkout. But the absence has to be legible, or a board of fifty
 * succeeded Jobs where five produced nothing reads as uniform.
 *
 * Three things count, and they are ADR-008's own list. A **pull request** on any attempt. A
 * **declared export**, and a **declared result** — both of which count without being re-checked
 * here, because a declared output the run did not produce already fails the attempt
 * (`src/worktree.ts`, `src/results.ts`, `src/artifacts.ts`), so a Job that reached `succeeded`
 * having declared any of the three produced it by construction.
 *
 * Pure, and asked only of a Job that succeeded. A failed, cancelled or `done` Job producing nothing
 * is not news — marking those would be noise, which is how a signal stops being read.
 */
export function producedNothing(
  job: {
    phase: string; pr: string | null; exports: string[];
    results?: string[]; artifacts?: string[]; proposes?: string | null;
  },
): boolean {
  if (job.phase !== 'succeeded') return false;
  // A PROPOSING Job that reached `succeeded` had its proposal applied — the controller only writes
  // that phase after filing the rows (`applyProposals`, `src/controller.ts`). Rows on the board are
  // the most concrete output anything here produces, and calling it "produced nothing" was the
  // complaint reading its own answer wrong.
  if (job.proposes) return false;
  return !job.pr
    && job.exports.length === 0
    && (job.results?.length ?? 0) === 0
    && (job.artifacts?.length ?? 0) === 0;
}

/** A Job's declared exports, from the `Json?` column, defensively. */
export function declaredExports(raw: unknown): string[] {
  return Array.isArray(raw) ? raw.filter((e): e is string => typeof e === 'string') : [];
}

// ---------------------------------------------------------------- the boards

/** One row of `hkb boards`. */
export type BoardSummary = Awaited<ReturnType<typeof boardSummaries>>[number];

/**
 * Every board on this machine, with what is on it — the cluster view.
 *
 * The counts are computed from one read per board rather than one query per phase, because the
 * `jobs` relation is already joined for the row: "one board read per pass" is this listing's rule
 * and a `groupBy` per column would be eight queries to answer what the join holds.
 *
 * **Every phase is counted, including `triage` and `suspended`**, and that is a completeness rule
 * rather than a display one. A read model that answered six of the eight would make a consumer go
 * back to the database for the two the CLI's table happens not to have a column for — which is
 * exactly the re-deriving this module exists to stop. Which of them a given surface *shows* is the
 * consumer's call: `hkb boards` still prints the columns it printed, and giving the inbox and the
 * waiting-on-a-person count a column of their own in the table and in `hkb up --status` is #57.
 */
export async function boardSummaries(db: Db, slug?: string, now = Date.now()) {
  // `now` passed through, not just used below. `daemon.status` takes one and uses it for
  // `controllerIsLive`, `uptimeMs`, `since` and its OWN spend window — so calling it without meant
  // half of every returned row was computed against the wall clock while the other half honoured
  // the injected one. A row that is internally inconsistent is worse than one that is simply late,
  // and it is non-deterministic in exactly the tests this parameter was added for.
  const serving = await daemon.status(slug, now);
  const boards = await db.board.findMany({
    where: slug ? { slug } : {},
    orderBy: { slug: 'asc' },
    include: { jobs: { select: { phase: true } } },
  });
  return boards.map((b) => {
    const by = (ph: string) => b.jobs.filter((j) => j.phase === ph).length;
    const d = serving.find((s) => s.slug === b.slug);
    return {
      board: b.slug,
      repoPath: b.repoPath,
      daemon: d?.running ? 'up' : 'down',
      paused: !!b.pausedAt,
      // The inbox, and the Jobs waiting on a person. Neither has a column in the CLI's table yet
      // (#57); both are here because a count the read model omits is a query a consumer writes.
      triage: by('triage'), suspended: by('suspended'),
      pending: by('pending'), running: by('running'),
      succeeded: by('succeeded'), failed: by('failed'),
      // Separate in the JSON, one column in the table. A consumer that wants to tell a merged
      // Job from an abandoned one can; a reader counting what is left to do only needs to know
      // that neither is.
      done: by('done'), cancelled: by('cancelled'),
      // From `daemon.status`, which already computed it board-wide in one query above — this used
      // to be a per-board `aggregate`, which is CLAUDE.md value 3's "no per-Job calls when a
      // board-wide one exists" one level up, and this function's own docstring's "one read per
      // board". It also re-implemented the window as `now - 24h` inline instead of `windowStart`
      // (`src/limits.ts`), so the gate's window and the status window could silently drift apart
      // and disagree about the same board.
      spent24h: d?.spent24h ?? 0,
      maxConcurrent: b.maxConcurrent,
      dailyBudgetUsd: b.dailyBudgetUsd,
      // Always in `--json`, set or not: a consumer that has to infer a missing default from a
      // missing key is reading a shape rather than a record.
      defaults: boardDefaults(b),
      hasDefaults: hasDefaults(b),
    };
  });
}

/**
 * One board, or null if this machine has no such board.
 *
 * The singular is what a second consumer asks for — a board's own page — and it is the plural with
 * a `where` rather than a second query, so the two cannot answer differently.
 */
export async function boardSummary(db: Db, slug: string, now = Date.now()): Promise<BoardSummary | null> {
  return (await boardSummaries(db, slug, now))[0] ?? null;
}

// ---------------------------------------------------------------- the listing

/** Which board to list. A null slug is every board on the machine — `hkb ls --all`. */
export type ListScope = { slug: string | null };

/** What to leave out. Both are ANDed; an absent one filters nothing. */
export type ListFilter = {
  phase?: Phase;
  /** Equality, ANDed — `src/labels.ts`. Not a query language, on purpose. */
  labels?: Record<string, string>;
};

/** One row of `hkb ls --json`. */
export type JobRow = Awaited<ReturnType<typeof listJobs>>[number];

/**
 * What is on the board.
 *
 * One query for the rows, their attempt counts and their pull requests together — the listing has
 * always been a single board-wide read, and a per-row `prUrl` lookup would be the N+1 this project
 * measures against.
 *
 * The label selector is applied over the rows rather than in the `where`, because Prisma's JSON
 * filters are PostgreSQL and MySQL only and SQLite cannot ask the question in SQL. The rows are
 * shaped in memory anyway, so a selector is a `filter` over a read that was happening regardless.
 */
export async function listJobs(db: Db, scope: ListScope, filter: ListFilter = {}) {
  const { phase } = filter;
  if (phase !== undefined && !(PHASES as readonly string[]).includes(phase)) {
    throw usage(`no phase "${phase}" — a Job is one of ${PHASES.join('|')}`);
  }
  const selector = filter.labels ?? {};
  const jobs = await db.job.findMany({
    where: { ...(scope.slug ? { board: { slug: scope.slug } } : {}), ...(phase ? { phase } : {}) },
    orderBy: [{ board: { slug: 'asc' } }, { id: 'asc' }],
    // The board is included whatever the scope, because `--json` carries it either way: a
    // consumer that has to branch on the flags it passed is reading a shape, not a record.
    //
    // The attempts' pull requests come back with the listing rather than in a second query per
    // row: a board-wide read already exists here, and "one board read per pass" is the rule
    // this listing has always followed.
    include: {
      _count: { select: { attempts: true } },
      board: { select: { slug: true } },
      attempts: { select: { prUrl: true }, orderBy: { k: 'desc' } },
    },
  });
  return jobs.map((j) => {
    const labels = jobLabels(j.labels);
    const exports = declaredExports(j.exports);
    const results = declaredExports(j.results);
    const artifacts = declaredExports(j.artifacts);
    const pr = j.attempts.find((a) => a.prUrl)?.prUrl ?? null;
    return {
      id: j.id, board: j.board.slug, name: j.name, phase: j.phase, attempts: j._count.attempts,
      lastError: j.lastError, sessionId: j.lastSessionId,
      // Carried on every row, whatever the phase, for the reason `hkb boards` carries its
      // defaults either way: a consumer inferring absence from a missing key reads a shape,
      // not a record.
      pr, exports, results, artifacts, labels,
      producedNothing: producedNothing({ phase: j.phase, pr, exports, results, artifacts, proposes: j.proposes }),
    };
    // Filtered on the built row rather than before it: the row is where a label has already
    // been read defensively out of the column, and reading it twice to save shaping a handful
    // of rows nobody will print would be the more expensive kind of thrift.
  }).filter((r) => selects(r.labels, selector));
}

// ---------------------------------------------------------------- one Job

/** What `hkb show --json` prints. */
export type ShownJob = Awaited<ReturnType<typeof showJob>>;

/**
 * One Job, whole: the row, its board, its lease, every attempt, and the spec it will actually run
 * with — traced to whichever of the three levels answered each field.
 *
 * The resolution is the reason this is not `db.job.findUnique`. Most of a Job's spec columns are
 * null on a board that sets defaults, and a null `model` is not an answer to "which model does this
 * run on" — `resolveSpec` is; and `spec.model.from` is what turns "why did this run on Opus" from
 * archaeology across two tables into a line. A consumer that read the row alone would print nulls
 * and be wrong in the direction that costs money.
 */
export async function showJob(db: Db, id: number) {
  const job = await db.job.findUnique({
    where: { id },
    include: { attempts: { orderBy: { k: 'asc' } }, lease: true, board: true },
  });
  if (!job) throw usage(`no Job #${id} — \`hkb ls\` shows what is on the board`);
  // What this Job will run with, and where each value came from. The raw columns are on the
  // object too, but most of them are null now, and a null `model` is not an answer to "which
  // model does this run on" — the board may have answered it.
  const spec = resolveSpec(job, job.board);
  // Where this Job's standing steps will come from — the BOARD's default workflow, read now,
  // because that is when the controller reads it too. It used to be recovered from the stored
  // brief, which was a record of what the board's default was on the day the Job was filed; the
  // steps are composed at claim time now (`src/controller.ts`), so the honest answer to "what
  // will this Job be told" is the board's answer today.
  //
  // Null for a proposing Job and for a `--no-isolate` one, which are the two populations the
  // controller does not compose them for: printing a workflow name beside a Job that will never
  // see it is the kind of quiet disagreement this line exists to prevent.
  const standingSteps = job.proposes || job.isolate === false ? null : (job.board?.defaultWorkflow?.trim() || null);
  // `check` is the resolved one here, overriding the raw column the spread carries — the same
  // object `hkb new --json` prints, so the two verbs cannot disagree about the command that
  // will judge this Job. See `jsonCheck`. Every other raw column is left as it is: they are
  // traced under `spec` alongside, and this is the one that was answering two ways.
  return { ...job, check: jsonCheck(spec.check, job.proposes), spec, standingSteps };
}
