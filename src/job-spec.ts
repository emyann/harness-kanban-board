import type { Prisma } from './generated/prisma/client.ts';
import type { openBoard } from './db.ts';
import type { Actor } from './transitions.ts';

/**
 * Changing what a Job will run with, after it has been filed.
 *
 * The sibling of `src/transitions.ts`: that module moves a Job through its lifecycle, this one
 * edits the thing it will run *as*. Neither is the controller's business — both are a person
 * deciding — and they are separate modules because a phase and a spec fail for different reasons
 * and answer to different rules.
 *
 * ## Why the verb exists
 *
 * There was no way to change a filed Job's spec except SQL. `hkb retry` could raise three caps,
 * and only while re-queueing; everything else — the model, the tool surface, the base, a declared
 * output, a label, the gate — was fixed at `hkb new` for ever. The escape was `hkb rm` and file it
 * again, which throws away the id, the attempts and the events on a board whose whole point is the
 * record. That is the shape CLAUDE.md calls a bug report: *possible, by hand*.
 *
 * ## One vocabulary, third consumer
 *
 * Every field here is set by the flag `hkb new` already parses, under the name a workflow file
 * already uses (`src/templates.ts`). That is not tidiness: it means `hkb --help` documents three
 * surfaces at once and cannot drift from any of them. A `job set` that invented `--budget` for what
 * `new` calls `--max-budget` would be a second vocabulary bought for nothing.
 *
 * ## What it refuses, and why each one
 *
 * - **a leased Job.** Its spec is what the running attempt was admitted under; changing it midway
 *   means the ceiling the gate charged and the ceiling the Job now claims disagree, and the worker
 *   cannot be told. Every transition refuses a lease and this is the same rule.
 * - **`phase`.** That is `src/transitions.ts`, which has the guards for it. A spec edit that could
 *   also move a Job would be two features wearing one flag.
 * - **`proposes`.** ADR-011 refuses a proposal that can itself propose, and turning it on after
 *   filing changes what the controller does with the run's output — a Job could be made a proposer
 *   after producing something that was never meant to be read as one.
 * - **`isolate`.** A Job that has a worktree cannot stop being isolated, and one that never had a
 *   branch cannot acquire the branch its earlier attempts would have pushed to.
 * - **nothing at all.** `hkb job set 12` with no flags is a typo, not a no-op.
 *
 * ## The brief IS settable, and that overrides a comment in `queue`
 *
 * `queueJob` says the brief is rewritable "HERE and nowhere else, because this is the moment it
 * stops being a note and becomes an instruction". That reasoning is about *triage → pending*, and
 * it stands there. It was never a reason a typo in a pending Job should cost its history. The
 * operator's decision (2026-09-07): settable here, and **recorded** — every change writes an Event
 * carrying the field, the old value and the new one, so `hkb log` can explain why `hkb show`
 * displays words a completed attempt never saw.
 *
 * That recording is the general answer to the same question for every field. A Job's spec is what
 * the NEXT attempt gets; `Attempt.maxBudgetUsd` is frozen at claim time and the rest is not, so
 * editing a Job with attempts behind it does make `hkb show` describe a spec those attempts did not
 * run under. The Event is what keeps that legible rather than a lie.
 */

type Db = ReturnType<typeof openBoard>;

function refuse(message: string): never {
  const e = new Error(message) as Error & { exitCode: number };
  e.exitCode = 2;
  throw e;
}

/**
 * The fields `hkb job set` may write, and the ONLY ones.
 *
 * A closed list rather than a filter over the columns, on `src/proposals.ts`'s rule: what is not
 * named is refused, and refused *by name* rather than dropped. A column added to the schema does
 * not silently become settable because somebody forgot to think about it.
 */
export const SETTABLE = [
  'name', 'brief', 'model', 'effort', 'maxTurns', 'maxBudgetUsd', 'maxRetries', 'timeoutMs',
  'base', 'guide', 'gate', 'allowedTools', 'pluginPaths', 'labels',
  'exports', 'results', 'artifacts', 'inputs',
] as const;

export type Settable = (typeof SETTABLE)[number];

/** The fields somebody will reach for, refused with the reason rather than "unknown field". */
const REFUSED: Record<string, string> = {
  phase: 'a phase is moved, not set — `hkb queue`, `hkb triage`, `hkb retry`, `hkb approve`, `hkb done` and `hkb cancel` each have the guards for it',
  proposes: 'whether a Job proposes decides how the controller reads its output (ADR-011), and turning it on after the fact would read a run nobody wrote as a proposal — file a new Job',
  isolate: 'a Job cannot change its mind about having a worktree: the attempts behind it either have a branch or do not',
  boardId: 'which board a Job is on is not an edit — it decides the repository, the ceilings and the budget it is charged against',
  id: 'the id is the Job',
};

export type SpecChange = { field: Settable; from: unknown; to: unknown };
export type SpecEdit = { id: number; changed: SpecChange[]; phase: string };

/**
 * Apply a set of field changes to a filed Job.
 *
 * `changes` is already parsed and validated by the caller — the checkers live beside the things
 * they check (`checkRef`, `checkExportPath`, `checkResultName`, `checkLabel`, `checkInputSpec`) and
 * `hkb new` runs the same ones, so a value that could not be filed cannot be set either.
 *
 * Returns what actually moved. A field set to the value it already had is dropped rather than
 * recorded, because an Event stream that says "the model was changed from opus to opus" makes the
 * one that says something real harder to find.
 */
export async function setJobSpec(
  db: Db,
  id: number,
  changes: Partial<Record<Settable, unknown>>,
  opts: { by: Actor },
): Promise<SpecEdit> {
  for (const field of Object.keys(changes)) {
    if (REFUSED[field]) refuse(`\`${field}\` cannot be set: ${REFUSED[field]}.`);
    if (!(SETTABLE as readonly string[]).includes(field)) {
      refuse(`\`${field}\` is not a field of a Job's spec — settable: ${SETTABLE.join(', ')}.`);
    }
  }
  if (!Object.keys(changes).length) {
    refuse(`#${id}: nothing to set — name a field, as in \`hkb job set ${id} --max-budget 5\`. \`hkb show ${id}\` prints the spec it has.`);
  }

  const job = await db.job.findUnique({ where: { id }, include: { lease: true } });
  if (!job) refuse(`no Job #${id} — \`hkb ls\` shows what is on the board`);
  if (job.lease) {
    refuse(
      `#${id} is leased by ${job.lease.holder} — it is running, and its spec is what that attempt `
      + `was admitted under. \`hkb down\` stops the daemon, or wait for the run to finish (the lease `
      + `lapses by ${job.lease.expiresAt.toISOString()}), then \`hkb job set ${id}\` again.`,
    );
  }

  // Only what actually moves. `JSON.stringify` rather than `===` because half of these are Json
  // columns holding arrays and objects, and an unchanged list is a list with the same contents
  // rather than the same reference.
  const current = job as unknown as Record<string, unknown>;
  const changed: SpecChange[] = (Object.keys(changes) as Settable[])
    .filter((f) => JSON.stringify(current[f] ?? null) !== JSON.stringify(changes[f] ?? null))
    .map((f) => ({ field: f, from: current[f] ?? null, to: changes[f] ?? null }));

  if (!changed.length) {
    return { id, changed: [], phase: job.phase };
  }

  // The write and the record of it together, for the reason every other transition is a
  // transaction: a spec that moved with no Event to explain it makes `hkb show` disagree with the
  // attempts behind it and leaves nothing to reconcile the two.
  await db.$transaction([
    db.job.updateMany({
      where: { id, lease: { is: null } },
      data: Object.fromEntries(changed.map((c) => [c.field, c.to])),
    }),
    db.event.create({
      data: {
        kind: 'spec_set',
        jobId: id,
        boardId: job.boardId,
        actor: opts.by,
        // Cast at the boundary: `from`/`to` are genuinely `unknown` (a string, a number, a list,
        // a label map) and Prisma's Json input type cannot see that they are all serialisable.
        payload: {
          changed: changed.map((c) => ({ field: c.field, from: c.from, to: c.to })),
        } as unknown as Prisma.InputJsonValue,
      },
    }),
  ]);

  return { id, changed, phase: job.phase };
}

/**
 * What an operator reads back, one line per field.
 *
 * A list is rendered by its contents rather than as `[object Object]`, and an absence reads as
 * `(none)` rather than as the word `null` — the two are the same fact and only one of them is
 * something a person says.
 */
export function describeChange(c: SpecChange): string {
  return `${c.field}  ${show(c.from)} → ${show(c.to)}`;
}

function show(v: unknown): string {
  if (v === null || v === undefined) return '(none)';
  if (Array.isArray(v)) return v.length ? v.join('|') : '(empty)';
  if (typeof v === 'object') {
    const pairs = Object.entries(v as Record<string, unknown>).map(([k, x]) => `${k}=${String(x)}`);
    return pairs.length ? pairs.join(',') : '(empty)';
  }
  const s = String(v);
  // A brief is the one settable field that is prose, and printing four paragraphs into a diff line
  // helps nobody. The Event keeps the whole of both.
  return s.length > 60 ? `${s.slice(0, 57)}…` : s;
}
