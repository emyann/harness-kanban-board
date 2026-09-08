import { spawn } from 'node:child_process';

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
 * **`CHECK_TIMEOUT_MS` — ten minutes.** A hung suite must not hold the pass for ever. Ten minutes is
 * a third of the default `timeoutMs` for the agent itself, and comfortably more than the checks
 * anybody actually writes: this repository's own `npm run lint && npm test` is under two.
 *
 * Ten minutes is longer than the five-minute `LEASE_GRACE_MS` the lease is given past the run's own
 * `timeoutMs` (`src/controller.ts`), and that is fine because the RENEWER is what covers it: the
 * lease is held — and renewed on its own timer — across the rebase, this command and the record
 * writes, and released only once the outcome is on the row. The grace is the margin for teardown,
 * not the budget for the check.
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
 * How long a check killed on the timeout gets to die politely before it is killed properly.
 *
 * `SIGTERM` first, because a runner that traps it flushes its output and that output is the whole
 * point of keeping a tail. `SIGKILL` after, because a runner that traps it and then ignores it
 * would otherwise hold the pass open past every bound this module has.
 */
export const CHECK_KILL_GRACE_MS = 5_000;

/**
 * Why a check has no exit code, when it has none — and it is a closed set because the SENTENCE
 * differs per case, not just the wording.
 *
 *   - `exit`        — it ran and gave a verdict. The only kind with a number.
 *   - `unfinished`  — it started and never produced one: the timeout, a signal, a stop.
 *   - `unstartable` — it never began at all.
 *
 * The distinction is not cosmetic. "The work is there and it does not do what it must" is TRUE of
 * an `exit` and FALSE of the other two — an `unstartable` check has judged nothing whatsoever, and
 * saying otherwise about it asserts a finding nobody made.
 */
export type CheckKind = 'exit' | 'unfinished' | 'unstartable';

/**
 * What a check said. Stored on `Attempt.check` when it refused, and read back by the next attempt.
 *
 * `exitCode` is null in exactly the two kinds that are not `exit`; `why` is the sentence for those,
 * written as a complete predicate ("was still running after 600s and was killed") so that every
 * frame in this module can be one-per-case rather than a clause spliced into a frame written for
 * `exited N`.
 */
export type CheckRecord = {
  command: string;
  exitCode: number | null;
  /** Which of the three above. See `CheckKind`. */
  kind: CheckKind;
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
  /** Why it never produced an exit code, when it did not. A complete predicate — see above. */
  why?: string;
  /**
   * Whether the tree this ran in had the base it will be merged into in it, and which ref that is.
   *
   * The check runs after `rebaseOntoBase`, and the claim everywhere else is that it therefore tests
   * *what would merge*. That claim is not always true: a pushed branch whose pull request is no
   * longer a draft is deliberately not rewritten, and a fetch that failed leaves the base ref as of
   * whenever somebody last pulled. Neither fails the attempt and neither should — but a verdict
   * about a tree is worth exactly as much as the base it sat on, so which one it was is recorded
   * rather than assumed (`src/rebase.ts`, `src/controller.ts`).
   *
   * Absent for a Job with no worktree: `--no-isolate` runs in the repository itself, where there is
   * no branch and no replay, so there is no claim to qualify.
   */
  onBase?: boolean;
  /** The base ref `onBase` is about, e.g. `origin/main`. Absent whenever `onBase` is. */
  base?: string;
};

export type CheckResult = { ok: true; record: null } | { ok: false; record: CheckRecord };

/**
 * The last `max` bytes of some text, marked when something was dropped.
 *
 * `alreadyDropped` is what a caller threw away before this was called — `runCheck` streams each
 * pipe through a rolling window, so most of the dropping happens there and the note has to count
 * both or it understates the cut.
 */
export function tailOf(text: string, max = CHECK_TAIL_BYTES, alreadyDropped = 0): string {
  const s = text ?? '';
  const buf = Buffer.from(s, 'utf8');
  const over = buf.length > max;
  const dropped = alreadyDropped + (over ? buf.length - max : 0);
  // Sliced by BYTES and not by characters, because the cap is about what is paid for; a multi-byte
  // character cut in half at the seam becomes U+FFFD rather than corrupting the rest.
  const kept = over ? buf.subarray(buf.length - max).toString('utf8') : s;
  return (dropped ? `… (${dropped} earlier bytes dropped)\n${kept}` : kept).trim();
}

/**
 * The last `max` bytes of a stream, kept as the stream arrives.
 *
 * This is what replaces a `maxBuffer`. Buffering everything and slicing at the end meant a cliff —
 * past the cap Node kills the child and reports `ENOBUFS`, so a verbose PASSING suite became a
 * failed attempt — and it meant holding megabytes of a test runner's chatter in the daemon to throw
 * all but 4 KB of it away. A rolling window has neither problem: nothing is ever a reason to fail,
 * and the resident cost is the window.
 */
class Tail {
  private buf: Buffer = Buffer.alloc(0);
  /** How many bytes went past the window. Reported, never silently swallowed. */
  dropped = 0;
  private readonly max: number;

  // Assigned in the body rather than declared as a parameter property: Node runs these sources with
  // type stripping only, and `constructor(private max: number)` is TypeScript that has to be
  // COMPILED. See the note in `CLAUDE.md` about there being no build step in development.
  constructor(max: number) { this.max = max; }

  push(chunk: Buffer): void {
    const all = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    if (all.length > this.max) {
      this.dropped += all.length - this.max;
      // Copied out of the concatenation rather than kept as a view of it: a `subarray` retains the
      // whole underlying allocation, which is the thing this class exists to avoid.
      this.buf = Buffer.from(all.subarray(all.length - this.max));
    } else this.buf = all;
  }

  get text(): string { return this.buf.toString('utf8'); }
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
  /** Bytes the caller dropped before handing the tails over. See `tailOf`. */
  dropped?: number;
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
  const tail = tailOf([r.stdout ?? '', r.stderr ?? ''].filter((s) => s.trim()).join('\n'), CHECK_TAIL_BYTES, r.dropped ?? 0);
  const took = `${Math.round(ms / 1000)}s`;
  const unfinished = (why: string): CheckResult =>
    ({ ok: false, record: { command, exitCode: null, kind: 'unfinished', tail, ms, why } });

  // A TIMEOUT IS ONLY `ETIMEDOUT`, and the ordering below is the whole of that rule.
  //
  // Reading `signal` as a timeout is wrong and it is wrong in the direction that matters: it told
  // the operator — and BRIEFED THE NEXT ATTEMPT — that a suite killed by the OOM killer, or one
  // that segfaulted, "was still running after 600s and was killed", with a duration beside it that
  // said three seconds. `runCheck` is the only thing that kills for time and it says so by setting
  // this code itself, so nothing else may be read as having run out of it.
  if (r.error?.code === 'ETIMEDOUT') return unfinished(`was still running after ${Math.round(timeoutMs / 1000)}s and was killed`);
  // The operator stopped the daemon mid-check (`hkb down`). Not a verdict about anything, and the
  // controller discards it — the record exists so that a caller which does not is not lied to.
  if (r.error?.code === 'ABORT_ERR') return unfinished(`was interrupted after ${took}, because the run was stopped`);
  // A buffered spawn's own cap. `runCheck` streams and sets none, so this arrives only from a
  // caller that does — but a record built from it must not read as a timeout, which it did.
  if (r.error?.code === 'ENOBUFS') return unfinished(`printed more than could be buffered and was killed after ${took} — the tail is what was kept`);
  if (r.error) {
    return {
      ok: false,
      record: { command, exitCode: null, kind: 'unstartable', tail, ms, why: `could not be started: ${r.error.message}` },
    };
  }
  // Killed by something that is not us: SIGKILL from the OOM killer, SIGSEGV from a native crash.
  // Named, because the name is the entire diagnosis and it is not one anything here could infer.
  if (r.signal) return unfinished(`was killed by ${r.signal} after ${took}`);
  if (r.status === 0) return { ok: true, record: null };
  // No status, no signal and no error: not a shape Node produces, and "exited null" is what
  // believing it would print into a prompt.
  if (r.status == null) return unfinished(`ended after ${took} without an exit code`);
  return { ok: false, record: { command, exitCode: r.status, kind: 'exit', tail, ms } };
}

/**
 * Run a check in a checkout. The only I/O in this module.
 *
 * Through the shell, because the value is a shell line an operator wrote — `npm run lint && npm
 * test` has to mean what it says. It inherits the environment the worker ran under, so a check sees
 * the same PATH, the same node version manager and the same credentials the agent did; anything
 * else would make "it passes when I run it there" stop being evidence.
 *
 * ## Why this is `spawn` and not `spawnSync`
 *
 * It was `spawnSync`, and a synchronous ten-minute subprocess in the controller's concurrent
 * section had three consequences, all of them measured:
 *
 *   - **the daemon's event loop froze for the duration.** Timers, the SDK's stream, the in-process
 *     admission hook and the signal handlers do not run while a synchronous spawn is in flight — so
 *     `hkb down` went unacknowledged for the whole check, and sibling workers at
 *     `maxConcurrent > 1` stalled at their next tool call. A controller that cannot be interrupted
 *     is not level-triggered; it is blocked.
 *   - **the timeout signalled `/bin/sh` and nothing else.** The suite the shell started outlived
 *     it, orphaned in the very worktree the resumed attempt continues in. `detached: true` makes
 *     the shell a process-group leader and `process.kill(-pid)` reaches the whole group, which is
 *     the only version of "killed on the timeout" that is true.
 *   - **nothing could stop it.** `deps.signal` is how `hkb down` reaches a run; a check that did
 *     not honour it was ten minutes the operator could not shorten.
 */
export function runCheck(
  cwd: string,
  command: string,
  opts: { timeoutMs?: number; signal?: AbortSignal; now?: () => number; killGraceMs?: number } = {},
): Promise<CheckResult> {
  const timeoutMs = opts.timeoutMs ?? CHECK_TIMEOUT_MS;
  const graceMs = opts.killGraceMs ?? CHECK_KILL_GRACE_MS;
  const clock = opts.now ?? (() => Date.now());
  const started = clock();
  const out = new Tail(CHECK_TAIL_BYTES);
  const err = new Tail(CHECK_TAIL_BYTES);

  return new Promise<CheckResult>((resolve) => {
    const child = spawn(command, {
      cwd,
      shell: true,
      // The group, and the reason is the kill below. It also detaches the check from the daemon's
      // own controlling terminal, so a `Ctrl-C` meant for `hkb run` is not delivered to a suite
      // behind its back — the abort path below is how a stop reaches it, deliberately and once.
      detached: true,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let settled = false;
    /** Why we killed it, when we did — the child's own exit cannot say which of the two it was. */
    let killedFor: 'timeout' | 'abort' | null = null;
    let hard: ReturnType<typeof setTimeout> | null = null;

    const killGroup = (sig: NodeJS.Signals) => {
      const pid = child.pid;
      if (!pid) return;
      // `-pid` is the process GROUP. Signalling the shell alone leaves the suite running.
      try { process.kill(-pid, sig); } catch { try { child.kill(sig); } catch { /* already gone */ } }
    };
    const stop = (why: 'timeout' | 'abort') => {
      if (settled || killedFor) return;
      killedFor = why;
      killGroup('SIGTERM');
      hard = setTimeout(() => killGroup('SIGKILL'), graceMs);
      // A grace timer must never be the reason a process stays up: if the group is already gone
      // and only this is left, there is nothing to kill.
      hard.unref?.();
    };

    const timer = setTimeout(() => stop('timeout'), timeoutMs);
    const onAbort = () => stop('abort');
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    if (opts.signal?.aborted) stop('abort');

    const finish = (r: SpawnLike) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (hard) clearTimeout(hard);
      opts.signal?.removeEventListener('abort', onAbort);
      resolve(readCheck(command, r, clock() - started, timeoutMs));
    };

    child.stdout?.on('data', (b: Buffer) => out.push(b));
    child.stderr?.on('data', (b: Buffer) => err.push(b));
    const tails = () => ({ stdout: out.text, stderr: err.text, dropped: out.dropped + err.dropped });
    // A spawn that never began. `close` does not follow it, so this is a terminal path of its own.
    child.on('error', (e: Error & { code?: string }) => finish({ status: null, signal: null, error: e, ...tails() }));
    // `close` rather than `exit`: the pipes are the evidence, and `exit` can arrive before they
    // have been drained — which would keep the tail of exactly the output that explains the failure.
    child.on('close', (status, signal) => finish({
      status,
      signal,
      // Ours, so that `readCheck` can tell "we ran out of patience" from "something else killed it".
      error: killedFor === 'timeout'
        ? Object.assign(new Error(`the check ran longer than ${timeoutMs}ms`), { code: 'ETIMEDOUT' })
        : killedFor === 'abort'
          ? Object.assign(new Error('the run was stopped'), { code: 'ABORT_ERR' })
          : undefined,
      ...tails(),
    }));
  });
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
  const next = retrying
    ? 'A retry is left, and it resumes the same session — the next attempt is told the command, the '
      + 'exit code and the tail of what it printed, so it starts from the failure rather than from '
      + 'the brief.'
    : 'No retries are left. `hkb retry <id>` resumes that session with what the check said, once you '
      + 'have decided whose mistake it is.';
  // ONE FRAME PER CASE, and the reason is that the middle clause is a claim. "The work is there and
  // it does not do what it must" is a finding, and only a command that RAN and exited non-zero
  // made it: spliced onto a check that could not be started it asserted a verdict about work that
  // was never examined, on the strength of `spawn EACCES`.
  if (r.kind === 'unstartable') {
    return `its check \`${r.command}\` ${r.why}, so the attempt failed on the check itself — nothing `
      + 'about the work was judged. Fix the command where it is set: `hkb job set <id> --check "…"`, '
      + `or the board's own \`--check\`. ${next}`;
  }
  if (r.kind === 'unfinished') {
    return `its check \`${r.command}\` ${r.why}, so the attempt failed with no verdict — nothing here `
      + `says the work is wrong, only that the command never got to say. ${next}`;
  }
  return `its check \`${r.command}\` exited ${r.exitCode}, so the attempt failed: the work is there `
    + `and it does not do what it must. ${next}`;
}

/**
 * One line for the operator's log, and for `hkb show`'s attempt block.
 *
 * Short on purpose: the tail is printed under it, and a heading that repeats the tail's first line
 * is a heading nobody reads. One frame per kind, for the reason `checkShortfall` gives — the
 * spliced version read `check \`npm test\` it was still running after 600s and was killed (SIGTERM)
 * after 600s`, which is a duration stated twice around a sentence that does not join up.
 */
export function describeCheck(r: CheckRecord): string {
  const said = r.kind === 'exit'
    ? `exited ${r.exitCode} after ${Math.round(r.ms / 1000)}s`
    : (r.why ?? `ended after ${Math.round(r.ms / 1000)}s without an exit code`);
  // Only where there is a claim to qualify. See `CheckRecord.onBase`: the verdict is about a tree,
  // and which base that tree sat on is the difference between "this would merge" and "this is what
  // the branch does where it stands".
  const where = r.onBase === undefined || !r.base
    ? ''
    : r.onBase
      ? ` — on ${r.base}`
      : ` — NOT on ${r.base}: the branch was not replayed onto it, so this is the tree as it stands`;
  return `check \`${r.command}\` ${said}${where}`;
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
  // Derived when it is absent or unrecognisable, never trusted blindly: a number is a verdict, and
  // the absence of one is a check that did not give one. That is also the right answer for a row
  // written before this field existed.
  const kind: CheckKind = v.kind === 'exit' || v.kind === 'unfinished' || v.kind === 'unstartable'
    ? v.kind
    : exitCode == null ? 'unfinished' : 'exit';
  return {
    command: v.command,
    exitCode,
    kind,
    tail: typeof v.tail === 'string' ? v.tail : '',
    ms: typeof v.ms === 'number' ? v.ms : 0,
    ...(typeof v.why === 'string' && v.why ? { why: v.why } : {}),
    // Both or neither: `onBase` without the ref it is about says nothing anybody can act on.
    ...(typeof v.onBase === 'boolean' && typeof v.base === 'string' && v.base
      ? { onBase: v.onBase, base: v.base }
      : {}),
  };
}
