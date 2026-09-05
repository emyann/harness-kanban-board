/**
 * What a Job actually runs with, and where each value came from.
 *
 * Three levels, and the order is the whole of it:
 *
 *     1. the Job's own value wins          — `kb new --model …`
 *     2. the Board's default fills a null  — `kb boards set <slug> --model …`
 *     3. the built-in is the last resort   — `BUILT_IN`, below
 *
 * A Board already carries policy — `maxConcurrent`, `dailyBudgetUsd`, `pausedAt` — and a default
 * model is the same kind of fact: a board that runs cheap, high-volume work should be able to say
 * so once instead of on every `kb new`. The difference between the two is worth keeping straight:
 * a *ceiling* is a limit a Job may not exceed and is enforced in `src/limits.ts`; a *default* is a
 * value a Job may freely override, and is resolved here.
 *
 * Pure on purpose, and structurally typed rather than importing Prisma's row types, so the whole
 * precedence table can be tested against plain objects with no database in the way. The failing
 * case that matters is a Board default quietly winning over a value the operator set on the Job —
 * so that is the case the tests are built around.
 *
 * `from` rides along with every value because a spec you cannot trace is worse than one you have
 * to repeat: `kb show` prints it, and "why did this Job run on Opus" stops being an archaeology
 * problem.
 */

/** Which level supplied a value. */
export type SpecSource = 'job' | 'board' | 'built-in';

export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type Effort = (typeof EFFORTS)[number];

/**
 * The last resort, and the only place these numbers are written down.
 *
 * They used to be `@default` on the Job's columns. A database default cannot be distinguished
 * from a value the operator chose, so a Board default would have been outranked by every Job
 * ever filed — which is why those columns are nullable now and this constant exists.
 *
 * `model` and `effort` are null because the built-in answer is "say nothing and let the harness
 * pick", which is a real answer and not a missing one.
 */
export const BUILT_IN = {
  model: null,
  effort: null,
  maxTurns: 20,
  maxBudgetUsd: 1,
  maxRetries: 2,
} as const;

/** The nullable half of a Job's spec — the fields a Board can supply a default for. */
export type JobSpec = {
  model?: string | null;
  effort?: string | null;
  maxTurns?: number | null;
  maxBudgetUsd?: number | null;
  maxRetries?: number | null;
};

/** The Board's side. Named `default*` so no call site has to guess what `board.model` means. */
export type BoardDefaults = {
  defaultModel?: string | null;
  defaultEffort?: string | null;
  defaultMaxTurns?: number | null;
  defaultMaxBudgetUsd?: number | null;
  defaultMaxRetries?: number | null;
};

export type Traced<T> = { value: T; from: SpecSource };

export type ResolvedSpec = {
  model: Traced<string | null>;
  effort: Traced<Effort | null>;
  maxTurns: Traced<number>;
  maxBudgetUsd: Traced<number>;
  maxRetries: Traced<number>;
};

/**
 * One field, resolved.
 *
 * The null check is `== null` and never a truthiness test: `maxRetries: 0` ("one attempt, no
 * retries"), `maxTurns: 0` and `maxBudgetUsd: 0` are all values an operator can mean, and a
 * falsy check would silently promote every one of them to the next level.
 */
function pick<T>(job: T | null | undefined, board: T | null | undefined, builtIn: T): Traced<T> {
  if (job != null) return { value: job, from: 'job' };
  if (board != null) return { value: board, from: 'board' };
  return { value: builtIn, from: 'built-in' };
}

export function resolveSpec(job: JobSpec | null | undefined, board: BoardDefaults | null | undefined): ResolvedSpec {
  const j = job ?? {};
  const b = board ?? {};
  return {
    model: pick(j.model, b.defaultModel, BUILT_IN.model as string | null),
    // Cast rather than validate: the closed set is enforced at the two write points (`kb new`
    // and `kb boards set`), so a value that is not an Effort got into the database by hand and
    // refusing to run it here would strand the Job with no way to see why.
    effort: pick(j.effort as Effort | null | undefined, b.defaultEffort as Effort | null | undefined, BUILT_IN.effort as Effort | null),
    maxTurns: pick(j.maxTurns, b.defaultMaxTurns, BUILT_IN.maxTurns),
    maxBudgetUsd: pick(j.maxBudgetUsd, b.defaultMaxBudgetUsd, BUILT_IN.maxBudgetUsd),
    maxRetries: pick(j.maxRetries, b.defaultMaxRetries, BUILT_IN.maxRetries),
  };
}

/** The same thing with the provenance dropped — what a caller passes to a runtime. */
export function specValues(r: ResolvedSpec) {
  return {
    model: r.model.value,
    effort: r.effort.value,
    maxTurns: r.maxTurns.value,
    maxBudgetUsd: r.maxBudgetUsd.value,
    maxRetries: r.maxRetries.value,
  };
}

/** Whether a board says anything at all. `kb boards` only prints a defaults line when it does. */
export function hasDefaults(b: BoardDefaults): boolean {
  return b.defaultModel != null || b.defaultEffort != null || b.defaultMaxTurns != null
    || b.defaultMaxBudgetUsd != null || b.defaultMaxRetries != null;
}

/** A board's defaults, under the names the Job knows them by. What `--json` carries. */
export function boardDefaults(b: BoardDefaults) {
  return {
    model: b.defaultModel ?? null,
    effort: b.defaultEffort ?? null,
    maxTurns: b.defaultMaxTurns ?? null,
    maxBudgetUsd: b.defaultMaxBudgetUsd ?? null,
    maxRetries: b.defaultMaxRetries ?? null,
  };
}
