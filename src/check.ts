import { spawnSync } from 'node:child_process';

/**
 * `check` — the exit code hkb does not have.
 *
 * ADR-016 §3 in one module. A Kubernetes Job is complete when its container **exits 0**; that is
 * the whole completion contract, and it is why Kubernetes has no "run this after the workload
 * succeeded" hook — there is nothing left to ask. hkb's container is an agent session, and an agent
 * session always finishes successfully, because finishing talking is what it does. So hkb has no
 * exit code, and everything ADR-008 built — declared `exports`, `results` and `artifacts`, whose
 * absence fails the attempt — is hkb reconstructing one for FILES. This is the same question asked
 * for BEHAVIOUR.
 *
 * Which is why it is not a hook and does not sit in a list beside init and teardown: it is part of
 * the completion condition, next to the declared outputs. The controller runs it and reads 0 /
 * not-0 exactly as the kubelet reads a container's exit code — **it knows nothing about what the
 * command does, and must not**. There is no test-runner integration here, no parsing of output into
 * findings, and no special case for a framework: a check is a shell line the operator wrote and a
 * number it exited with.
 *
 * ## Where the command may come from, and why that is the whole security argument
 *
 * The Job row, the board row, or a workflow file under `Board.repoPath` (`src/templates.ts`) —
 * **never the worktree**. It is the same fence a guide and a plugin grant stand behind
 * (`src/plugins.ts`), and here it is at its sharpest: this command runs, with the daemon's
 * privileges, to judge the very work that produced the tree it runs in. A worker able to author it
 * would be marking its own homework with a pen it fetched itself. A human merge is the boundary,
 * and that is also why `check` is not a proposal key (`src/proposals.ts`).
 *
 * ## Two numbers this module has to choose
 *
 * **`CHECK_TIMEOUT_MS` — ten minutes.** A hung suite must not hold the pass for ever, and the state
 * it would leave is genuinely stuck rather than merely slow: the lease is released as soon as the
 * run ends (`src/controller.ts`), so a Job whose check never returns sits in `running` with no lease
 * for the reclaim to find and no `pending` row for the next pass to claim. Ten minutes is a third of
 * the default `timeoutMs` for the agent itself, and comfortably more than the checks anybody
 * actually writes: this repository's own `npm run lint && npm test` is under two.
 *
 * **`CHECK_TAIL_BYTES` — 4 KB, of the END.** The tail, because a test runner puts its verdict last
 * and its progress first; 4 KB because this is paid for twice — once in `hkb show` and once in the
 * next attempt's prompt, on every request of that attempt — and it is the same cap `src/results.ts`
 * puts on a value the board keeps, for the same reason. A check that needs more than 4 KB to explain
 * itself is one whose output belongs in an artifact.
 */

/** How long a check may take before it is killed and the attempt fails. See the header. */
export const CHECK_TIMEOUT_MS = 10 * 60_000;

/** How much of stdout+stderr is kept — the END of it. See the header. */
export const CHECK_TAIL_BYTES = 4 * 1024;

/**
 * How much a check may print before the child is killed.
 *
 * Not a cap on what is kept — that is `CHECK_TAIL_BYTES` — but on what Node will buffer. The
 * default is 1 MB, and exceeding it kills the process and truncates its output, which would turn a
 * verbose passing suite into a failed attempt. 16 MB is far past any suite's chatter and is
 * transient: only the tail survives the function.
 */
const CHECK_MAX_BUFFER = 16 * 1024 * 1024;

/**
 * What a check said. Stored on `Attempt.check` when it refused, and read back by the next attempt.
 *
 * `exitCode` is null only when there was no exit to read — the shell could not be started at all,
 * or the command was killed on the timeout. `why` is set in exactly those cases and says which,
 * because "command not found" and "still running after ten minutes" send an operator to opposite
 * places.
 */
export type CheckRecord = {
  command: string;
  exitCode: number | null;
  /**
   * The last `CHECK_TAIL_BYTES` of what it printed: stdout, then stderr.
   *
   * Concatenated rather than interleaved, because two pipes cannot be re-interleaved after the
   * fact and pretending otherwise would invent an ordering. Keeping the TAIL puts stderr on the
   * right side of the cut, which is where a runner writes the reason it failed.
   */
  tail: string;
  /** How long it ran, in milliseconds. */
  ms: number;
  /** Why it never produced an exit code, when it did not. */
  why?: string;
};

export type CheckResult = { ok: true; record: null } | { ok: false; record: CheckRecord };

/** The last `max` bytes of some text, marked when something was dropped. */
export function tailOf(text: string, max = CHECK_TAIL_BYTES): string {
  const s = text ?? '';
  const buf = Buffer.from(s, 'utf8');
  if (buf.length <= max) return s.trim();
  // Sliced by BYTES and not by characters, because the cap is about what is paid for; a multi-byte
  // character cut in half at the seam becomes U+FFFD rather than corrupting the rest.
  return `… (${buf.length - max} earlier bytes dropped)\n${buf.subarray(buf.length - max).toString('utf8')}`.trim();
}

/**
 * The shape this module needs from a spawn, and no more.
 *
 * Structurally typed so the decision below can be tested against plain objects — the pattern
 * `src/limits.ts` states: push the I/O to the edge, and test the case that refuses.
 */
export type SpawnLike = {
  status: number | null;
  signal: string | null;
  error?: Error & { code?: string };
  stdout?: string | null;
  stderr?: string | null;
};

/**
 * Whether a spawn passed, and what to keep about it if it did not. No I/O.
 *
 * Three ways to fail, and they are deliberately one outcome with three reasons rather than three
 * outcomes: what the controller does about a failing check does not depend on how it failed, and
 * what the *operator* does about it depends entirely on the sentence, not on an enum value.
 *
 *   - a non-zero exit — the ordinary case, and the only one with a number to report;
 *   - killed on the timeout — no exit code, and the reason says how long it was given;
 *   - never started at all — no exit code either, and the reason is the spawn's own.
 *
 * A shell that could not find the command is the FIRST kind, not the third: `sh -c` exits 127 and
 * says so on stderr, which is a better message than anything this function could write.
 */
export function readCheck(command: string, r: SpawnLike, ms: number, timeoutMs = CHECK_TIMEOUT_MS): CheckResult {
  const tail = tailOf([r.stdout ?? '', r.stderr ?? ''].filter((s) => s.trim()).join('\n'));
  // Ordered before the status test on purpose: a killed child reports `status: null` on POSIX, but
  // a shell that exited on its own after being signalled can report a status too, and "it ran out
  // of time" is the more useful thing to say about either.
  if (r.signal || r.error?.code === 'ETIMEDOUT') {
    return {
      ok: false,
      record: {
        command,
        exitCode: null,
        tail,
        ms,
        why: `it was still running after ${Math.round(timeoutMs / 1000)}s and was killed`
          + `${r.signal ? ` (${r.signal})` : ''}`,
      },
    };
  }
  if (r.error) {
    return {
      ok: false,
      record: { command, exitCode: null, tail, ms, why: `it could not be started: ${r.error.message}` },
    };
  }
  if (r.status === 0) return { ok: true, record: null };
  return { ok: false, record: { command, exitCode: r.status, tail, ms } };
}

/**
 * Run a check in a checkout. The only I/O in this module.
 *
 * Through the shell, because the value is a shell line an operator wrote — `npm run lint && npm
 * test` has to mean what it says. It inherits the environment the worker ran under, so a check sees
 * the same PATH, the same node version manager and the same credentials the agent did; anything
 * else would make "it passes when I run it there" stop being evidence.
 */
export function runCheck(
  cwd: string,
  command: string,
  opts: { timeoutMs?: number; now?: () => number } = {},
): CheckResult {
  const timeoutMs = opts.timeoutMs ?? CHECK_TIMEOUT_MS;
  const clock = opts.now ?? (() => Date.now());
  const started = clock();
  const r = spawnSync(command, {
    cwd,
    shell: true,
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: CHECK_MAX_BUFFER,
    env: process.env,
  });
  return readCheck(command, r as unknown as SpawnLike, clock() - started, timeoutMs);
}

/**
 * What a failed check owes the operator: what ran, what it said, and what happens next.
 *
 * It goes on `Job.lastError`, so it **names the command** rather than describing it — an operator
 * reading `hkb ls` sees a Job that says `check_failed` next to a pull request that looks fine, and
 * the first question is always "which command, and can I run it myself".
 *
 * Written without the Job's id, and `hkb retry <id>` is literal for the same reason `budgetAdvice`
 * writes it that way (`src/controller.ts`): this is produced by `nextPhase`, which is pure and is
 * given a decision to make rather than a row to read. The id is never far — this text is only ever
 * read beside it, under `hkb show <id>` or against a line `hkb ls` has already tagged.
 */
export function checkShortfall(r: CheckRecord, retrying: boolean): string {
  const what = r.why ?? `exited ${r.exitCode}`;
  return `its check \`${r.command}\` ${what}, so the attempt failed: the work is there and it does `
    + `not do what it must. `
    + (retrying
      ? 'A retry is left, and it resumes the same session — the next attempt is told the command, the '
        + 'exit code and the tail of what it printed, so it starts from the failure rather than from '
        + 'the brief.'
      : 'No retries are left. `hkb retry <id>` resumes that session with what the check said, once you '
        + 'have decided whose mistake it is.');
}

/**
 * One line for the operator's log, and for `hkb show`'s attempt block.
 *
 * Short on purpose: the tail is printed under it, and a heading that repeats the tail's first line
 * is a heading nobody reads.
 */
export function describeCheck(r: CheckRecord): string {
  return `check \`${r.command}\` ${r.why ?? `exited ${r.exitCode}`} after ${Math.round(r.ms / 1000)}s`;
}

/**
 * A check record out of a `Json?` column, defensively.
 *
 * A Json column is not a type: the controller writes this shape, but nothing stops a hand-written
 * row, and a malformed value must not take a reconcile pass down or reach a prompt as `[object
 * Object]`. Anything that is not recognisably a record reads as "no check was recorded", which is
 * the same answer an older attempt gives — this column did not exist before ADR-016.
 */
export function storedCheck(value: unknown): CheckRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (typeof v.command !== 'string' || !v.command.trim()) return null;
  const exitCode = typeof v.exitCode === 'number' ? v.exitCode : null;
  return {
    command: v.command,
    exitCode,
    tail: typeof v.tail === 'string' ? v.tail : '',
    ms: typeof v.ms === 'number' ? v.ms : 0,
    ...(typeof v.why === 'string' && v.why ? { why: v.why } : {}),
  };
}
