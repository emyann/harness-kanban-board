import { CHECK_COMMAND_MAX_BYTES } from './check.ts';

/**
 * A flag's value, and the four ways `parseArgs` lies about one.
 *
 * These were written inside `src/hkb.ts`, next to the `switch` that consumed them, and that was
 * right while the CLI was the only thing that ever held a flag. It is not any more: a **workflow
 * file's frontmatter keys are `hkb new`'s flags** (`src/templates.ts`), so the same values arrive
 * from a file with no argv anywhere near them, and `createJob` — which reads both — cannot live
 * downstream of the parser without dragging the parser along.
 *
 * So they are here, with one rule: **nothing in this module knows what a verb is.** It converts a
 * value that arrived under a flag's name into the value that flag means, or refuses by name. The
 * refusals are the reason it is worth a module of its own — every one of them is a bug this project
 * actually shipped, and each is one line away from being reintroduced by a `String(...)`.
 *
 * The type of what arrives says why. `parseArgs` runs with `strict: false`, where an option is
 * `string | boolean` and a repeatable one is an array of those; `readTemplate` produces
 * `string | string[] | boolean`. `Flagged` is the union of the two, which is what these all take.
 */

/** What a flag's value can arrive as, from `parseArgs` under `strict: false` or from a workflow. */
export type Flagged = string | boolean | (string | boolean)[] | undefined;

/**
 * A usage error: exit code 2, and a message that names the fix.
 *
 * Returned rather than thrown, because most callers say `throw usage(...)` at a point where the
 * control flow reads better with the `throw` visible.
 */
export const usage = (msg: string) => {
  const e = new Error(msg) as Error & { exitCode: number };
  e.exitCode = 2;
  return e;
};

/**
 * The string a `--flag <value>` was actually given, or a refusal.
 *
 * **`String(values.x)` is the bug this exists to stop.** `parseArgs` runs with `strict: false`,
 * and a bare `--flag` at the end of a line comes back as the BOOLEAN `true` — so `String(...)` turns
 * it into the word `true` and a non-empty guard waves it through. A bare `--check` was filed as the
 * shell command `true`: `hkb show` printed `check true [job]`, and every attempt of that Job passed
 * a check that verified nothing. That is a guard that is inert while looking present, which is the
 * failure this project keeps finding and the reason `--gate` one line over is written
 * `typeof values.gate === 'string'`.
 *
 * **A value that begins with a dash is refused too**, and it is the same bug one step along.
 * `parseArgs` under `strict: false` hands a string option *the next token*, whatever it is — so
 * `hkb new n --check --json` files the shell command `--json`, the check that judges every attempt
 * of that Job is a flag, and `--json` is silently not in effect either. Nothing legitimate is lost:
 * a shell line, a ref, a path and a comma-separated list all begin with something else, and a value
 * that really does start with a dash is reachable as `--check " -x"` or after `--`. This is the
 * third of the argv traps in `docs/wiki/gotchas/argv-traps.md`, and the first two do not cover it —
 * the option consumed a token, so nothing falls through as a stray positional to be caught.
 *
 * The empty string is NOT refused here — several flags mean something by it — so a caller that has
 * no use for one still has to say so. See `checkFlag`.
 */
export function given(raw: unknown, flag: string, clear?: string): string {
  if (typeof raw !== 'string') {
    throw usage(
      `${flag} was given nothing — a bare ${flag} is not a value. Pass one after it, as in `
      + `${flag} "…"${clear ? `, or ${flag} ${clear} to clear it` : ''}.`,
    );
  }
  // Tested on the RAW value, before the trim: `--flag " -x"` is the escape the message below
  // prescribes, and trimming first refused it with the same message — no spelling reached a value
  // that really starts with a dash.
  // FLAG-shaped: a dash followed by a letter, or two dashes. A brief that opens with a Markdown
  // bullet (`- add a test`) and a negative number are values; `-x` and `--json` are the trap.
  if (/^--?[A-Za-z]/.test(raw)) {
    const v = raw.trim();
    throw usage(
      `${flag} was given \`${v}\`, which is a flag rather than a value — \`${flag} ${v}\` would file `
      + `\`${v}\` as ${flag}'s value and drop ${v} itself. The argument parser hands a string option `
      + `the next token whatever it is. Quote a value that really starts with a dash, with a space in `
      + `front of it: ${flag} " ${v}".`,
    );
  }
  return raw.trim();
}

/**
 * The same rule for a repeatable flag: every item is a string, and none of them is a flag.
 *
 * `--export`, `--result`, `--artifact`, `--input`, `--label`, `--allow-tool` and `--plugin-dir` are
 * `multiple: true`, so a bare one comes back as `[true]` rather than as `true` — which walked
 * straight past `typeof raw !== 'string'` and was filed as the literal path, name or tool `true`.
 * `hkb new x --export` declared an output called `true`, and the attempt failed for not producing
 * it. One helper, so a flag added later gets the guard by using it rather than by remembering.
 */
export function givenList(raw: unknown, flag: string): string[] {
  if (raw === undefined) return [];
  const items = Array.isArray(raw) ? raw : [raw];
  return items.map((v) => given(v, flag));
}

/** A `--flag <number>`, or a refusal that says which flag and what arrived. */
export const num = (v: unknown, flag: string): number | undefined => {
  if (v === undefined) return undefined;
  // A bare `--max-turns` is the boolean `true`, and `Number(true)` is 1 — a ceiling of one turn,
  // filed silently. The same idiom `given` refuses for strings.
  if (typeof v !== 'string') throw usage(`${flag} was given nothing — a bare ${flag} is not a number. Pass one after it.`);
  if (v.trim().startsWith('-') && !/^-\d/.test(v.trim())) {
    throw usage(`${flag} was given \`${v}\`, which is a flag rather than a number — the parser hands a flag the next token whatever it is.`);
  }
  const n = Number(v);
  if (!Number.isFinite(n)) throw usage(`${flag} wants a number, got ${JSON.stringify(v)}`);
  return n;
};

/** The word that clears a nullable spec field back to "ask the next level". Three verbs spell it. */
export const CLEARED = 'none';

/**
 * A deadline flag, in **seconds** — the unit Kubernetes named `activeDeadlineSeconds` in.
 *
 * `undefined` when the flag is absent (the board's default answers) and `null` for the word `none`
 * (clear it), which is the shape every other clearable spec field uses. Everything else must be a
 * whole number of seconds greater than zero: Kubernetes says "value must be a positive integer",
 * and both refusals are worth having by name rather than as a Prisma error four layers down —
 * `--deadline 0` reads as "no deadline" to a person and would mean "already expired" to the
 * arithmetic, which is the most expensive way to be wrong here.
 */
export function seconds(v: unknown, flag: string): number | null | undefined {
  if (v === undefined) return undefined;
  if (typeof v === 'string' && v.trim() === CLEARED) return null;
  const n = num(v, flag);
  if (n === undefined) return undefined;
  if (!Number.isInteger(n)) throw usage(`${flag} wants a whole number of seconds, got ${n} — Kubernetes' activeDeadlineSeconds is an integer and so is this.`);
  // Above this a `setTimeout` delay exceeds 2^31 ms, which Node clamps to 1 — so the longest
  // possible clock would abort every session the instant it started, with a TimeoutOverflowWarning
  // nobody reads. Refused by name rather than left to be discovered as "my 30-day Job times out
  // immediately". ~24.8 days.
  const MAX = Math.floor((2 ** 31 - 1) / 1000);
  if (n > MAX) {
    throw usage(`${flag} wants at most ${MAX} seconds (~24 days) — above that the runtime's own timer overflows and fires immediately, got ${n}.`);
  }
  if (n <= 0) {
    throw usage(
      `${flag} wants a positive number of seconds, got ${n}. `
      + `${n === 0 ? '0 does not mean "no deadline" — it means "already expired". ' : ''}`
      + `Pass "${CLEARED}" to clear it and let the board answer.`,
    );
  }
  return n;
}

/**
 * The completion check as a flag value, for `hkb new` and `hkb job set`.
 *
 * Almost everything is stored verbatim, because the controller reads an exit code and knows nothing
 * about the command (ADR-016 §3). Three shapes are not:
 *
 *   - **a bare `--check`, or one handed the next flag.** See `given`.
 *   - **a command longer than `CHECK_COMMAND_MAX_BYTES`.** `sh -c` passes the whole line as one
 *     argument and the kernel refuses one past `MAX_ARG_STRLEN`, so `spawn` throws `E2BIG` — every
 *     attempt of that Job would fail its check without the work being looked at. Refused where it
 *     is written rather than where it is run. See `src/check.ts`.
 *   - **`none` on `hkb new`.** Every other `--flag none` on this CLI clears a value, and on a *new*
 *     Job there is nothing to clear: the column is already null, which is what inheriting the
 *     board's default IS. Filing it as written files the literal command `none` — exit 127,
 *     `check_failed`, resumed and re-failed until the retries are gone: three paid sessions for a
 *     command that can never pass.
 *
 * On `hkb job set` it is not refused, because there `none` has the meaning it has everywhere else
 * on that verb: **put the column back to null, and inherit the board's default again**. That is
 * what `str()` does for every other field, and what README's own sentence says. The distinction is
 * not a special case for `check`, it is the ordinary one between setting a value and clearing one —
 * a verb that files a row cannot clear a column that does not exist yet.
 *
 * `--check ""` is a VALUE on both, and a different one: no check, and do NOT inherit (`checkValue`
 * in `src/spec.ts`). The board keeps `none` too, for the same reason `hkb job set` does.
 */
export function checkFlag(raw: unknown, flag = '--check', clears = false): string | null {
  const v = given(raw, flag);
  if (v === CLEARED) {
    if (clears) return null;
    throw usage(
      `${flag} none would file the literal shell command \`none\`, which exits 127 — every attempt `
      + `would fail its check and burn a retry. A Job filed with no ${flag} already inherits the `
      + `board's default, so leave ${flag} out for that. For a Job that runs NO check, and does not `
      + `inherit the board's, use ${flag} "".`,
    );
  }
  if (Buffer.byteLength(v, 'utf8') > CHECK_COMMAND_MAX_BYTES) {
    throw usage(
      `${flag} is ${Buffer.byteLength(v, 'utf8')} bytes, and the limit is ${CHECK_COMMAND_MAX_BYTES} — `
      + 'a check runs as `sh -c <the whole line>`, and past the kernel\'s own argument limit it cannot '
      + 'be started at all, so every attempt would fail on the command rather than on the work. Put it '
      + `in a script the repository holds and name that: ${flag} "./scripts/verify.sh".`,
    );
  }
  return v;
}

/**
 * A number with a range, refused by name — the guard `hkb new` did not have.
 *
 * `num` above parses and deliberately does not judge: its own comment says the range is the
 * caller's rule. The trouble was that one caller had no rule. `hkb job set` and `hkb boards set`
 * both refuse `--max-budget 0`, a negative, and a fractional `--max-turns`; filing accepted all of
 * them, so a Job could be FILED with a spec that could never be SET — and a $0 or negative cap is
 * not inert, it resolves through `pick` (`src/spec.ts`, which compares against null rather than
 * truthiness) and is handed to the runtime, where every attempt dies on budget with nothing naming
 * the cause.
 *
 * One helper rather than a third copy of the predicate, because three copies of a rule is how the
 * three verbs came to disagree in the first place.
 */
export function inRange(
  v: unknown,
  flag: string,
  ok: (n: number) => boolean,
  wants: string,
): number | undefined {
  const n = num(v, flag);
  if (n === undefined) return undefined;
  if (!ok(n)) throw usage(`${flag} wants ${wants}, got ${n}`);
  return n;
}

/** The three ranges, written once so `new`, `job set` and `boards set` cannot drift apart. */
export const RANGES = {
  'max-turns': [(n: number) => Number.isInteger(n) && n >= 1, 'a whole number of turns, 1 or more'],
  'max-budget': [(n: number) => n > 0, 'dollars above zero'],
  'max-retries': [(n: number) => Number.isInteger(n) && n >= 0, 'a whole number of retries, 0 or more'],
} as const satisfies Record<string, readonly [(n: number) => boolean, string]>;
