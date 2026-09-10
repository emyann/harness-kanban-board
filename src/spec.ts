/**
 * What a Job actually runs with, and where each value came from.
 *
 * Three levels, and the order is the whole of it:
 *
 *     1. the Job's own value wins          — `hkb new --model …`
 *     2. the Board's default fills a null  — `hkb boards set <slug> --model …`
 *     3. the built-in is the last resort   — `BUILT_IN`, below
 *
 * A Board already carries policy — `maxConcurrent`, `dailyBudgetUsd`, `pausedAt` — and a default
 * model is the same kind of fact: a board that runs cheap, high-volume work should be able to say
 * so once instead of on every `hkb new`. The difference between the two is worth keeping straight,
 * because it decides who wins: a *ceiling* is a limit a Job may not exceed, and it is enforced in
 * `src/limits.ts`; a *default* is a value a Job may freely override, and it is resolved here.
 *
 * Pure on purpose, and structurally typed rather than importing Prisma's row types, so the whole
 * precedence table can be tested against plain objects with no database in the way. The failing
 * case that matters is silent — a Board default quietly winning over a value the operator set on
 * the Job. Nothing breaks; the Job just runs on the wrong model. So that is the case the tests are
 * built around.
 *
 * `from` rides along with every value because a spec you cannot trace is worse than one you must
 * repeat: `hkb show` prints it, and "why did this Job run on Opus" stops being archaeology across
 * two tables.
 */

/**
 * A tool list out of a `Json?` column, defensively.
 *
 * Null and "not a list of strings" both mean *unset*, so the next level answers — a malformed
 * column must not silently narrow a Job's surface to nothing, which would look exactly like a
 * deliberate read-only Job and fail in a way nobody could read.
 */
export function toolList(raw: unknown): string[] | null {
  if (!Array.isArray(raw)) return null;
  const names = raw.filter((t): t is string => typeof t === 'string' && t.length > 0);
  return names.length === raw.length ? names : null;
}

/** A string column, defensively: anything that is not a non-empty string reads as unset. */
export function str(raw: unknown): string | null {
  return typeof raw === 'string' && raw.trim() ? raw.trim() : null;
}

/**
 * The completion check out of a column — where the EMPTY STRING is a value and not an absence.
 *
 * This is the one string field with three states rather than two, and it needs them: a board that
 * sets `defaultCheck` otherwise owns every Job on it for ever, because `pick` reads a null column
 * as *unset* and falls straight through to the board again. The schema's own comment — "a Job whose
 * brief is an investigation has no suite to pass" — was unhonourable, and the ways out all failed:
 * a blank normalised to null and inherited, `--check none` filed the literal command `none` (exit
 * 127, `check_failed`, resumed and re-failed `maxRetries` times for a command that can never pass),
 * and there was nothing else to try.
 *
 * `''` is "no check, and do not inherit one" — the shape `allowedTools: []` already uses for the
 * same question, and for the same reason: an empty value is a decision, and only a null is silence.
 * Whitespace normalises INTO it rather than out of it, because a command of one space is not a
 * command anybody meant to run.
 */
export function checkValue(raw: unknown): string | null {
  return typeof raw === 'string' ? raw.trim() : null;
}

/** Which level supplied a value. */
export type SpecSource = 'job' | 'board' | 'built-in';

export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
import { pluginList } from './plugins.ts';

export type Effort = (typeof EFFORTS)[number];

/**
 * The last resort, and the only place these numbers are written down.
 *
 * They used to be `@default` on the Job's columns. A database default cannot be told apart from a
 * value the operator chose, so a Board default would have been outranked by every Job ever filed —
 * which is why those columns are nullable now and this constant exists.
 *
 * `model` and `effort` are null because the built-in answer is "say nothing and let the harness
 * pick", which is a real answer rather than a missing one.
 */
export const BUILT_IN = {
  model: null,
  effort: null,
  maxTurns: 20,
  maxBudgetUsd: 1,
  maxRetries: 2,
  /**
   * Thirty minutes for one attempt — Kubernetes' `template.spec.activeDeadlineSeconds`, and the
   * number the old `Job.timeoutMs` database default carried. It moves here for the reason every
   * other built-in did: a column that defaults to 1800 cannot tell "the operator asked for thirty
   * minutes" from "the operator said nothing", and without that distinction a board default is
   * outranked by every Job that ever existed.
   */
  attemptDeadlineSeconds: 1800,
  /**
   * **Null, and the null is Kubernetes' own default**: a Job has no wall clock across its attempts
   * unless somebody sets one. Writing a number here would put every Job that ever runs under a
   * ceiling nobody asked for, and this is the one deadline that does not retry — it ends the Job.
   * A default that silently ends work is not a default.
   */
  activeDeadlineSeconds: null as number | null,
  /**
   * Null for the same reason `model` is: the built-in answer is "say nothing and let the runtime
   * pick its own surface", which is a real answer rather than a missing one. Naming the list here
   * would move a runtime concern into the spec and give two modules an opinion that can drift.
   */
  allowedTools: null,
  /** Nothing granted. A repository's skills reach a worker only when someone said so (ADR-012). */
  pluginPaths: null,
  guide: null,
  /**
   * Null, and the null means something: *the repository's default branch*, resolved fresh by
   * `baseRef` from `origin/HEAD`. Writing a name here would make one branch the built-in answer for
   * every repository hkb ever runs in, which is exactly the constant `Job.base` exists to remove.
   */
  base: null,
  /**
   * Null, and the null is the whole shipped default: **nothing runs**. A check is a shell command
   * executed with the daemon's privileges, and one hkb invented for a repository it knows nothing
   * about would be a guess with a shell in it. It reaches a worker only because a person wrote it
   * on the Job, on the board, or in a workflow file that was merged.
   */
  check: null,
} as const;

/** The nullable half of a Job's spec — the fields a Board can supply a default for. */
export type JobSpec = {
  model?: string | null;
  effort?: string | null;
  maxTurns?: number | null;
  maxBudgetUsd?: number | null;
  maxRetries?: number | null;
  attemptDeadlineSeconds?: number | null;
  activeDeadlineSeconds?: number | null;
  /** Raw, straight off the `Json?` column — `toolList` normalizes it here rather than at
   * every call site, so a malformed value cannot narrow a surface by accident. */
  allowedTools?: unknown;
  /** Raw, off the `Json?` column. `pluginList` normalizes it here, not at each call site. */
  pluginPaths?: unknown;
  guide?: unknown;
  base?: unknown;
  check?: unknown;
};

/** The Board's side. Named `default*` so no call site has to guess what `board.model` would mean. */
export type BoardDefaults = {
  defaultModel?: string | null;
  defaultEffort?: string | null;
  defaultMaxTurns?: number | null;
  defaultMaxBudgetUsd?: number | null;
  defaultMaxRetries?: number | null;
  defaultAttemptDeadlineSeconds?: number | null;
  defaultActiveDeadlineSeconds?: number | null;
  defaultAllowedTools?: unknown;
  defaultPluginPaths?: unknown;
  defaultGuide?: unknown;
  defaultBase?: unknown;
  defaultCheck?: unknown;
  /**
   * The board's default workflow — and the one field here `resolveSpec` deliberately does not
   * resolve. It fills no column on a Job: `hkb new` expands it at file time, into the spec fields
   * below and into the brief (`src/templates.ts`), so by the time anything asks what a Job runs
   * with, the answer is already on the Job. It rides in this type so that `hkb boards` prints it
   * beside the defaults it does resolve — a board-wide instruction nobody can see is the surprise
   * every other line of `describeDefaults` exists to prevent.
   */
  defaultWorkflow?: unknown;
};

export type Traced<T> = { value: T; from: SpecSource };

export type ResolvedSpec = {
  model: Traced<string | null>;
  effort: Traced<Effort | null>;
  maxTurns: Traced<number>;
  maxBudgetUsd: Traced<number>;
  maxRetries: Traced<number>;
  /** One attempt's wall clock, in seconds. Always resolves — the built-in is 1800. */
  attemptDeadlineSeconds: Traced<number>;
  /** The Job's wall clock across every attempt, in seconds, or null for "no Job-wide deadline". */
  activeDeadlineSeconds: Traced<number | null>;
  allowedTools: Traced<string[] | null>;
  pluginPaths: Traced<string[] | null>;
  guide: Traced<string | null>;
  base: Traced<string | null>;
  check: Traced<string | null>;
};

/**
 * One field, resolved.
 *
 * The null check is `== null` and never a truthiness test: `maxRetries: 0` ("one attempt, do not
 * retry") and `maxBudgetUsd: 0` are both values an operator can mean, and a falsy check would
 * silently promote every one of them to the next level — which is the bug this module exists to
 * make impossible, arriving through the back door.
 */
function pick<T>(job: T | null | undefined, board: T | null | undefined, builtIn: T): Traced<T> {
  if (job != null) return { value: job, from: 'job' };
  if (board != null) return { value: board, from: 'board' };
  return { value: builtIn, from: 'built-in' };
}

export function resolveSpec(
  job: JobSpec | null | undefined,
  board: BoardDefaults | null | undefined,
): ResolvedSpec {
  const j = job ?? {};
  const b = board ?? {};
  return {
    model: pick(j.model, b.defaultModel, BUILT_IN.model as string | null),
    // Cast rather than validate: the closed set is enforced at the two write points (`hkb new` and
    // `hkb boards set`), so a value that is not an Effort got into the database by hand, and
    // refusing to run it here would strand the Job with no way to see why.
    effort: pick(
      j.effort as Effort | null | undefined,
      b.defaultEffort as Effort | null | undefined,
      BUILT_IN.effort as Effort | null,
    ),
    maxTurns: pick(j.maxTurns, b.defaultMaxTurns, BUILT_IN.maxTurns),
    maxBudgetUsd: pick(j.maxBudgetUsd, b.defaultMaxBudgetUsd, BUILT_IN.maxBudgetUsd),
    maxRetries: pick(j.maxRetries, b.defaultMaxRetries, BUILT_IN.maxRetries),
    attemptDeadlineSeconds: pick(
      j.attemptDeadlineSeconds, b.defaultAttemptDeadlineSeconds, BUILT_IN.attemptDeadlineSeconds,
    ),
    activeDeadlineSeconds: pick(
      j.activeDeadlineSeconds, b.defaultActiveDeadlineSeconds, BUILT_IN.activeDeadlineSeconds,
    ),
    // An EMPTY list is a value, not an absence: `allowedTools: []` means "this Job may call no
    // tools at all", which is exactly what a read-only propose half might want. `pick` compares
    // against null rather than truthiness precisely so that survives — the same reason
    // `maxRetries: 0` does.
    allowedTools: pick(toolList(j.allowedTools), toolList(b.defaultAllowedTools), BUILT_IN.allowedTools as string[] | null),
    // Same `pick`, and an empty list survives it for the same reason: `pluginPaths: []` on a Job is
    // "grant this one nothing", which is how a Job narrows a board that granted something.
    pluginPaths: pick(pluginList(j.pluginPaths), pluginList(b.defaultPluginPaths), BUILT_IN.pluginPaths as string[] | null),
    // A path or nothing. The empty string is not a third state here the way `[]` is for a list —
    // "no guide" is the absence, so a blank is normalised to it rather than becoming a Job that
    // reads the repository root.
    guide: pick(str(j.guide), str(b.defaultGuide), BUILT_IN.guide as string | null),
    // Same shape as `guide`: a ref or nothing, with a blank normalised to the absence. There is no
    // third state to protect here — "branch from no base" is not a thing a checkout can do.
    base: pick(str(j.base), str(b.defaultBase), BUILT_IN.base as string | null),
    // The completion condition. Resolved like `guide` in its three levels and UNLIKE it in one
    // thing: the empty string is a value here, not a blank to normalise away. `checkValue` says why
    // — it is the per-Job opt-out from a board-wide check, and without it a board that sets one owns
    // every Job on it. The built-in is still the absence, so at the shipped defaults this field
    // costs a resolution and changes nothing (ADR-016 §3).
    check: pick(checkValue(j.check), checkValue(b.defaultCheck), BUILT_IN.check as string | null),
  };
}

/**
 * The completion check under `--json`, in ONE shape wherever it appears.
 *
 * `hkb new --json` printed the RESOLVED check and `hkb show --json` printed the Job's raw column, so
 * the same Job answered `"npm test"` to one verb and `null` to the other — and a script that filed
 * work and then polled it saw a check appear out of nowhere. The resolved value is the one both
 * print, because it is the one that will run; `source` says which of the three levels answered, so
 * nothing is lost by not printing the column.
 *
 * A proposing Job runs none whatever the board says (`runsCheck` in the controller), so this says
 * null for it rather than a resolved command the human line already qualifies away — the two verbs
 * and the two forms answer the same.
 *
 * Here rather than in either caller, because it is the pair `src/filing.ts` and `src/read.ts` must
 * not disagree about, and a shape kept in one of two consumers is a shape the other one copies.
 */
export const jsonCheck = (t: Traced<string | null>, proposes?: string | null) =>
  (proposes ? { value: null, source: 'proposes' } : { value: t.value, source: t.from });

/** Whether a board says anything at all. `hkb boards` only prints a defaults line when it does. */
export function hasDefaults(b: BoardDefaults): boolean {
  return b.defaultModel != null || b.defaultEffort != null || b.defaultMaxTurns != null
    || b.defaultMaxBudgetUsd != null || b.defaultMaxRetries != null || toolList(b.defaultAllowedTools) != null
    || pluginList(b.defaultPluginPaths) != null || str(b.defaultGuide) != null
    || str(b.defaultBase) != null || str(b.defaultCheck) != null || str(b.defaultWorkflow) != null
    || b.defaultAttemptDeadlineSeconds != null || b.defaultActiveDeadlineSeconds != null;
}

/** A board's defaults, under the names the Job knows them by. What `--json` carries. */
export function boardDefaults(b: BoardDefaults) {
  return {
    model: b.defaultModel ?? null,
    effort: b.defaultEffort ?? null,
    maxTurns: b.defaultMaxTurns ?? null,
    maxBudgetUsd: b.defaultMaxBudgetUsd ?? null,
    maxRetries: b.defaultMaxRetries ?? null,
    allowedTools: toolList(b.defaultAllowedTools),
    pluginPaths: pluginList(b.defaultPluginPaths),
    guide: str(b.defaultGuide),
    base: str(b.defaultBase),
    check: str(b.defaultCheck),
    workflow: str(b.defaultWorkflow),
    attemptDeadlineSeconds: b.defaultAttemptDeadlineSeconds ?? null,
    activeDeadlineSeconds: b.defaultActiveDeadlineSeconds ?? null,
  };
}
