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
   * Null for the same reason `model` is: the built-in answer is "say nothing and let the runtime
   * pick its own surface", which is a real answer rather than a missing one. Naming the list here
   * would move a runtime concern into the spec and give two modules an opinion that can drift.
   */
  allowedTools: null,
  /** Nothing granted. A repository's skills reach a worker only when someone said so (ADR-012). */
  pluginPaths: null,
  guide: null,
} as const;

/** The nullable half of a Job's spec — the fields a Board can supply a default for. */
export type JobSpec = {
  model?: string | null;
  effort?: string | null;
  maxTurns?: number | null;
  maxBudgetUsd?: number | null;
  maxRetries?: number | null;
  /** Raw, straight off the `Json?` column — `toolList` normalizes it here rather than at
   * every call site, so a malformed value cannot narrow a surface by accident. */
  allowedTools?: unknown;
  /** Raw, off the `Json?` column. `pluginList` normalizes it here, not at each call site. */
  pluginPaths?: unknown;
  guide?: unknown;
};

/** The Board's side. Named `default*` so no call site has to guess what `board.model` would mean. */
export type BoardDefaults = {
  defaultModel?: string | null;
  defaultEffort?: string | null;
  defaultMaxTurns?: number | null;
  defaultMaxBudgetUsd?: number | null;
  defaultMaxRetries?: number | null;
  defaultAllowedTools?: unknown;
  defaultPluginPaths?: unknown;
  defaultGuide?: unknown;
};

export type Traced<T> = { value: T; from: SpecSource };

export type ResolvedSpec = {
  model: Traced<string | null>;
  effort: Traced<Effort | null>;
  maxTurns: Traced<number>;
  maxBudgetUsd: Traced<number>;
  maxRetries: Traced<number>;
  allowedTools: Traced<string[] | null>;
  pluginPaths: Traced<string[] | null>;
  guide: Traced<string | null>;
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
  };
}

/** Whether a board says anything at all. `hkb boards` only prints a defaults line when it does. */
export function hasDefaults(b: BoardDefaults): boolean {
  return b.defaultModel != null || b.defaultEffort != null || b.defaultMaxTurns != null
    || b.defaultMaxBudgetUsd != null || b.defaultMaxRetries != null || toolList(b.defaultAllowedTools) != null
    || pluginList(b.defaultPluginPaths) != null || str(b.defaultGuide) != null;
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
  };
}
