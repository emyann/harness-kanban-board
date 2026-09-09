import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

import {
  CHECK_TAIL_BYTES, checkShortfall, describeCheck, readCheck, runCheck, storedCheck, tailOf,
} from '../src/check.ts';

/**
 * The completion check, decided rather than run.
 *
 * `readCheck` is where every question that matters is answered — did it pass, and if not, which of
 * the three ways did it fail — and it has no I/O in it, so it can be asked the cases that refuse.
 * `src/limits.ts`'s header is the rule these follow: the guards this project has shipped inert were
 * inert because nothing ever tested that they said no.
 */

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hkb-check-'));
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

// ---------------------------------------------------------------- the decision

test('exit 0 is the whole of passing, and nothing is kept about it', () => {
  const r = readCheck('npm test', { status: 0, signal: null, stdout: 'ok\n', stderr: '' }, 12);
  assert.equal(r.ok, true);
  assert.equal(r.record, null, 'a passing check is the absence of a finding, not a row');
});

test('a non-zero exit fails, and the record carries the number', () => {
  const r = readCheck('npm test', { status: 1, signal: null, stdout: 'x', stderr: 'boom' }, 12);
  assert.equal(r.ok, false);
  assert.equal(r.record?.exitCode, 1);
  assert.equal(r.record?.command, 'npm test');
  assert.equal(r.record?.why, undefined, 'an ordinary failure needs no explanation beyond its code');
  assert.match(r.record?.stderr ?? '', /boom/, 'and what it said is kept');
  assert.equal(r.record?.stdout, 'x', 'each stream in its own window');
});

test('a command the shell cannot find is an ordinary failure — the shell says so better', () => {
  // `sh -c` exits 127 and writes its own message. Inventing one here would replace a precise
  // sentence naming the missing binary with a vaguer one that names nothing.
  const r = readCheck('nope', { status: 127, signal: null, stdout: '', stderr: 'sh: 1: nope: not found' }, 3);
  assert.equal(r.ok, false);
  assert.equal(r.record?.exitCode, 127);
  assert.match(r.record?.stderr ?? '', /not found/);
});

test('a check that ran out of time fails, and says so rather than reporting a code', () => {
  // ONLY `ETIMEDOUT`. `runCheck` is the only thing that kills for time and it sets this itself.
  const e = Object.assign(new Error('ETIMEDOUT'), { code: 'ETIMEDOUT' });
  const r = readCheck('sleep 999', { status: null, signal: 'SIGTERM', error: e, stdout: '', stderr: '' }, 600_000);
  assert.equal(r.ok, false);
  assert.equal(r.record?.exitCode, null, 'there is no exit code to report — it was killed');
  assert.equal(r.record?.kind, 'unfinished');
  assert.match(r.record?.why ?? '', /still running after 600s/);
});

// ---------------------------------------------------------------- three ways to be killed
//
// The bug these are here for: `signal ||` was read FIRST, so every one of these rendered — and was
// briefed to the next attempt — as "it was still running after 600s and was killed", with a
// millisecond count beside it that said three seconds. A signal is not a clock.

test('a SIGKILL is not a timeout: it says which signal, and does not invent ten minutes', () => {
  const r = readCheck('npm test', { status: null, signal: 'SIGKILL', stdout: '', stderr: '' }, 3_000);
  assert.equal(r.record?.kind, 'unfinished');
  assert.equal(r.record?.why, 'was killed by SIGKILL after 3s');
  assert.doesNotMatch(r.record?.why ?? '', /still running/, 'the OOM killer is not the timeout');
  assert.equal(describeCheck(r.record!), 'check `npm test` was killed by SIGKILL after 3s');
});

test('a SIGSEGV says SIGSEGV — the name IS the diagnosis', () => {
  const r = readCheck('./suite', { status: null, signal: 'SIGSEGV', stdout: '', stderr: '' }, 1_000);
  assert.equal(describeCheck(r.record!), 'check `./suite` was killed by SIGSEGV after 1s');
});

test('an output cap (ENOBUFS) gets its own sentence, and never reads as a timeout', () => {
  // `runCheck` streams a rolling tail and sets no `maxBuffer`, so it cannot produce this itself —
  // but a record built from a buffered spawn must still say what happened rather than the wrong
  // thing. It was reported as "still running after 600s and was killed".
  const e = Object.assign(new Error('spawnSync /bin/sh ENOBUFS'), { code: 'ENOBUFS' });
  const r = readCheck('npm test', { status: null, signal: 'SIGTERM', error: e, stdout: 'x', stderr: '' }, 41_000);
  assert.equal(r.record?.kind, 'unfinished');
  assert.match(r.record?.why ?? '', /printed more than could be buffered/);
  assert.match(r.record?.why ?? '', /the tail is what was kept/);
  assert.doesNotMatch(r.record?.why ?? '', /still running/);
});

test('the three renderings are distinct — a reader can tell which one happened', () => {
  const at = (r: { status: number | null; signal: string | null; error?: Error & { code?: string } }) =>
    describeCheck(readCheck('npm test', { ...r, stdout: '', stderr: '' }, 7_000).record!);
  const timeout = at({ status: null, signal: 'SIGTERM', error: Object.assign(new Error('t'), { code: 'ETIMEDOUT' }) });
  const nobufs = at({ status: null, signal: 'SIGTERM', error: Object.assign(new Error('b'), { code: 'ENOBUFS' }) });
  const killed = at({ status: null, signal: 'SIGKILL' });
  assert.equal(new Set([timeout, nobufs, killed]).size, 3, 'three causes, three sentences');
});

test('a check that could not be STARTED fails, and says which', () => {
  const e = Object.assign(new Error('spawn EACCES'), { code: 'EACCES' });
  const r = readCheck('./gate', { status: null, signal: null, error: e, stdout: '', stderr: '' }, 1);
  assert.equal(r.ok, false);
  assert.equal(r.record?.exitCode, null);
  assert.equal(r.record?.kind, 'unstartable', 'it never began — that is not the same as failing');
  assert.match(r.record?.why ?? '', /could not be started: spawn EACCES/);
});

test('a timeout is read as a timeout even when the spawn also reports an error', () => {
  // Node reports both on a killed child: `signal` AND an `ETIMEDOUT` error. Reading the error first
  // would tell the operator the command could not be started, which is the opposite of what
  // happened and sends them to check their PATH instead of their suite.
  const e = Object.assign(new Error('ETIMEDOUT'), { code: 'ETIMEDOUT' });
  const r = readCheck('npm test', { status: null, signal: 'SIGTERM', error: e, stdout: '', stderr: '' }, 5, 5_000);
  assert.match(r.record?.why ?? '', /still running after 5s/);
});

// ---------------------------------------------------------------- the tail

test('the tail keeps the END, because a runner puts its verdict last', () => {
  const long = `${'a'.repeat(CHECK_TAIL_BYTES * 4)}\nFAIL: the thing`;
  const t = tailOf(long);
  assert.match(t, /FAIL: the thing$/, 'the verdict survives');
  assert.match(t, /earlier bytes dropped/, 'and the cut is stated rather than silent');
  // Bounded by the cap plus the one line that says so — which is why the note is a line and not a
  // paragraph: it is paid for on every request of the attempt that reads it.
  assert.ok(Buffer.byteLength(t) < CHECK_TAIL_BYTES + 100, 'the cap is what is kept, not a suggestion');
});

test('a short tail is kept whole, with no note about a cut that did not happen', () => {
  assert.equal(tailOf('  1 failing\n'), '1 failing');
});

test('stderr survives the cut, because that is where the reason is', () => {
  const r = readCheck('t', { status: 1, signal: null, stdout: 'x'.repeat(CHECK_TAIL_BYTES * 2), stderr: 'AssertionError' }, 1);
  assert.match(r.record?.stderr ?? '', /AssertionError$/);
});

test('TWO windows: a loud stderr does not evict the stdout verdict', () => {
  // The bug: the two were joined and the JOIN was cut to `CHECK_TAIL_BYTES`, so the moment stderr
  // alone reached 4 KB the stdout side of the cut was gone entirely. That is the ordinary shape of
  // `cargo test`, mocha, vitest and `node --test` — progress and warnings on stderr, summary on
  // stdout — so the one line anybody wanted was the one reliably dropped.
  const noise = 'warning: unused variable\n'.repeat(300);
  assert.ok(Buffer.byteLength(noise) > CHECK_TAIL_BYTES, 'the noise really does overflow one window');
  const r = readCheck('cargo test', { status: 101, signal: null, stdout: 'test result: FAILED. 1 passed; 2 failed', stderr: noise }, 4_000);
  assert.equal(r.record?.stdout, 'test result: FAILED. 1 passed; 2 failed', 'the verdict survives whole');
  assert.match(r.record?.stderr ?? '', /earlier bytes dropped/, 'and the loud one is cut on its own');
  // Each window is capped separately, so the worst case is two of them and not one of eight.
  assert.ok(Buffer.byteLength(r.record?.stderr ?? '') < CHECK_TAIL_BYTES + 100);
});

// ---------------------------------------------------------------- what the operator is told

test('the failure names the command, and what happens next depends on whether a retry is left', () => {
  const rec = { command: 'npm test', exitCode: 1, kind: 'exit' as const, stdout: '1 failing', stderr: '', ms: 1000 };
  const retrying = checkShortfall(rec, true);
  assert.match(retrying, /`npm test`/, 'the command, so it can be run by hand');
  assert.match(retrying, /exited 1/);
  assert.match(retrying, /resumes the same session/, 'and that the next attempt is told what failed');

  const done = checkShortfall(rec, false);
  assert.match(done, /No retries are left/);
  assert.match(done, /hkb retry <id>/, 'the command that changes the answer');
});

test('a check that never ran says WHY instead of quoting an exit code it does not have', () => {
  const line = describeCheck({
    command: 'npm test', exitCode: null, kind: 'unfinished', stdout: '', stderr: '', ms: 600_000,
    why: 'was still running after 600s and was killed',
  });
  assert.match(line, /still running/);
  assert.doesNotMatch(line, /exited null/);
});

// ---------------------------------------------------------------- one frame per case
//
// The whole sentence is asserted, not a fragment of it. Both of these read as nonsense before,
// because a `why` clause was spliced into a frame written for `exited N` — and the second one
// asserted a FINDING ("the work is there and it does not do what it must") about a check that
// never ran, on the strength of `spawn EACCES`.

test('the timeout reads as one sentence, with the duration stated once', () => {
  const rec = {
    command: 'npm test', exitCode: null, kind: 'unfinished' as const, stdout: '', stderr: '', ms: 600_000,
    why: 'was still running after 600s and was killed',
  };
  assert.equal(describeCheck(rec), 'check `npm test` was still running after 600s and was killed');
  assert.equal(
    checkShortfall(rec, false),
    'its check `npm test` was still running after 600s and was killed, so the attempt failed with '
    + 'no verdict — nothing here says the work is wrong, only that the command never got to say. '
    + 'No retries are left. `hkb retry <id>` resumes that session with what the check said, once '
    + 'you have decided whose mistake it is.',
  );
});

test('a check that could not START claims nothing about the work, and says where the fix is', () => {
  const rec = {
    command: './gate', exitCode: null, kind: 'unstartable' as const, stdout: '', stderr: '', ms: 2,
    why: 'could not be started: spawn EACCES',
  };
  assert.equal(describeCheck(rec), 'check `./gate` could not be started: spawn EACCES');
  const said = checkShortfall(rec, true);
  assert.equal(
    said,
    'its check `./gate` could not be started: spawn EACCES, so the attempt failed on the check '
    + 'itself — nothing about the work was judged. Fix the command where it is set: `hkb job set '
    + '<id> --check "…"`, or the board\'s own `--check`. A retry is left, and it resumes the same '
    + 'session — the next attempt is told the command, the exit code and the tail of what it '
    + 'printed, so it starts from the failure rather than from the brief.',
  );
  assert.doesNotMatch(said, /the work is there/, 'nothing examined the work — that is the point');
});

test('an ordinary non-zero exit keeps the finding it has earned', () => {
  const rec = { command: 'npm test', exitCode: 1, kind: 'exit' as const, stdout: '1 failing', stderr: '', ms: 12_000 };
  assert.equal(describeCheck(rec), 'check `npm test` exited 1 after 12s');
  assert.match(checkShortfall(rec, true), /^its check `npm test` exited 1, so the attempt failed: the work is there and it does not do what it must\. /);
});

// ---------------------------------------------------------------- reading the column back

test('a malformed check column reads as "no check was recorded" rather than crashing a pass', () => {
  // A Json column is not a type. Every one of these reaches the next attempt's PROMPT if it is
  // believed, so the refusal matters more than the parse.
  for (const bad of [null, undefined, 'npm test', 42, [], {}, { command: '' }, { command: 3 }]) {
    assert.equal(storedCheck(bad), null, `${JSON.stringify(bad)} is not a check record`);
  }
});

test('a real record survives the round trip, and missing fields become safe ones', () => {
  const r = storedCheck({ command: 'npm test', exitCode: 1, kind: 'exit', stdout: '1 failing', stderr: 'x', ms: 30 });
  assert.deepEqual(r, { command: 'npm test', exitCode: 1, kind: 'exit', stdout: '1 failing', stderr: 'x', ms: 30 });
  // A row written before `kind` existed, and one whose `kind` is nonsense: a number is a verdict
  // and the absence of one is not, so the derivation is the same either way.
  assert.equal(storedCheck({ command: 'npm test', exitCode: 2 })?.kind, 'exit');
  assert.equal(storedCheck({ command: 'npm test', kind: 'nonsense' })?.kind, 'unfinished');
  const thin = storedCheck({ command: 'npm test' });
  assert.deepEqual(thin, { command: 'npm test', exitCode: null, kind: 'unfinished', stdout: '', stderr: '', ms: 0 });
  // `exit` is the ONE kind that makes a claim, and every renderer of it quotes the number. A row
  // that names it with no number reaches an operator and a prompt as `exited null`, which asserts
  // a verdict nobody gave — so the absence of a number wins over the label that contradicts it.
  assert.equal(storedCheck({ command: 'npm test', kind: 'exit' })?.kind, 'unfinished');
  assert.equal(storedCheck({ command: 'npm test', kind: 'exit', exitCode: null })?.kind, 'unfinished');
});

test('the base the tree was on rides along, or is absent together', () => {
  // Both or neither: `onBase` with no ref names nothing anybody can act on.
  const on = storedCheck({ command: 'npm test', exitCode: 1, kind: 'exit', onBase: false, base: 'origin/main' });
  assert.equal(on?.onBase, false);
  assert.equal(on?.base, 'origin/main');
  assert.equal(storedCheck({ command: 'npm test', onBase: false })?.onBase, undefined);
  assert.match(describeCheck(on!), /NOT on origin\/main/, 'and `hkb show` says so');
  const merged = storedCheck({ command: 'npm test', exitCode: 1, kind: 'exit', onBase: true, base: 'origin/main' });
  assert.match(describeCheck(merged!), /— on origin\/main$/);
});

// ---------------------------------------------------------------- the one piece of I/O

test('it runs through the shell, in the directory it was given', async () => {
  const where = fs.mkdtempSync(path.join(dir, 'run-'));
  fs.writeFileSync(path.join(where, 'here'), 'yes\n');
  assert.equal((await runCheck(where, 'test -f here')).ok, true, 'cwd is the checkout, not the daemon\'s');
  // `&&` is the reason it goes through a shell at all: one check, two commands, and the first
  // failure short-circuits exactly as the operator who wrote the line expects.
  const r = await runCheck(where, 'echo one && exit 3');
  assert.equal(r.ok, false);
  assert.equal(r.record?.exitCode, 3);
  assert.equal(r.record?.kind, 'exit');
  assert.match(r.record?.stdout ?? '', /one/);
});

test('a check that outlives its timeout is killed rather than waited for', async () => {
  const r = await runCheck(dir, 'sleep 30', { timeoutMs: 250 });
  assert.equal(r.ok, false);
  assert.equal(r.record?.exitCode, null);
  assert.equal(r.record?.kind, 'unfinished');
  assert.match(r.record?.why ?? '', /still running after 0s|still running after 1s/);
});

test('the timeout kills the whole PROCESS GROUP, not just the shell it started', async () => {
  // The failure this replaces: `spawnSync`'s timeout signalled `/bin/sh` and the suite it had
  // started was orphaned — still running, in the very worktree the resumed attempt continues in.
  // This is the shipped shape of that: a shell whose child outlives it unless the group is killed.
  const where = fs.mkdtempSync(path.join(dir, 'group-'));
  const pidFile = path.join(where, 'pid');
  const r = await runCheck(where, `sh -c 'echo $$ > ${pidFile}; sleep 30' & wait`, { timeoutMs: 400, killGraceMs: 100 });
  assert.equal(r.ok, false);
  assert.match(r.record?.why ?? '', /still running after/);

  const pid = Number(fs.readFileSync(pidFile, 'utf8').trim());
  assert.ok(Number.isInteger(pid) && pid > 0, 'the grandchild really did start');
  // `kill -0` asks whether it is still there. Given a moment for the group signal to land.
  await new Promise((r2) => setTimeout(r2, 300));
  let alive = true;
  try { process.kill(pid, 0); } catch { alive = false; }
  assert.equal(alive, false, 'the suite the shell started went with it — no orphan in the checkout');
});

test('a stop interrupts a check instead of waiting ten minutes for it', async () => {
  // `deps.signal` is how `hkb down` reaches a run. A check that did not honour it was up to ten
  // minutes of an unacknowledged stop, with the daemon unable to answer for any of it.
  const ac = new AbortController();
  const started = Date.now();
  setTimeout(() => ac.abort(), 150);
  const r = await runCheck(dir, 'sleep 30', { signal: ac.signal, killGraceMs: 100 });
  assert.ok(Date.now() - started < 10_000, 'it came back when it was told to, not when it was done');
  assert.equal(r.ok, false);
  assert.match(r.record?.why ?? '', /interrupted/, 'and it does not claim to be a verdict');
  assert.doesNotMatch(r.record?.why ?? '', /still running after/, 'a stop is not a timeout');
});

test('a check that prints far more than the tail is kept, not killed for it', async () => {
  // The 16 MB cliff is gone with `maxBuffer`: output is streamed through a rolling window, so a
  // verbose PASSING suite passes and a failing one still has its verdict at the end.
  const r = await runCheck(dir, `head -c ${CHECK_TAIL_BYTES * 8} /dev/zero | tr '\\0' 'x'; echo; echo FAIL-AT-THE-END >&2; exit 1`);
  assert.equal(r.ok, false);
  assert.equal(r.record?.kind, 'exit', 'it exited on its own — nothing killed it for being loud');
  assert.match(r.record?.stderr ?? '', /FAIL-AT-THE-END/, 'the verdict is at the end and it survived');
  assert.match(r.record?.stdout ?? '', /earlier bytes dropped/, 'and the cut is stated');
  assert.ok(Buffer.byteLength(r.record?.stdout ?? '') < CHECK_TAIL_BYTES + 200, 'bounded by the window');
});

// ---------------------------------------------------------------- the process lifecycle
//
// One design, and every one of these is a shipped failure of it. `runCheck` settled on `close`,
// which is neither the verdict nor a bound: `exit` is the verdict, `close` is the pipes and belongs
// to every descendant that inherited them, and the hard kill is owed to the process GROUP whatever
// either of those did. These use real processes on purpose — the bug in each case was in what the
// kernel does, not in what the module believes about it.

test('the VERDICT is the exit, so a background child holding the pipe does not fail a pass', async () => {
  // `--check "node server.js & mocha"` is the ordinary shape. The shell exits 0 the moment mocha is
  // done, and the server keeps stdout open behind it: waiting for `close` waited for the SERVER, so
  // a suite that passed in a second burnt the full ten minutes and was recorded as a timeout.
  const started = Date.now();
  const r = await runCheck(dir, 'sleep 30 & echo PASSED; exit 0', { timeoutMs: 30_000, drainMs: 300 });
  assert.equal(r.ok, true, 'it exited 0 — that is the whole of the answer');
  assert.ok(Date.now() - started < 5_000, `settled in ${Date.now() - started}ms rather than waiting for the child`);
});

test('a descendant OUTSIDE the group holding the pipe cannot make a check unbounded', async () => {
  // `setsid` leaves the process group, so the timeout's `kill(-pid)` never reaches it — and with the
  // promise settling only on `close`, neither the timeout NOR `deps.signal` could settle it at all.
  // The reconcile pass hung there with the lease renewed for ever. The pipes get their own bound.
  const started = Date.now();
  const r = await runCheck(dir, 'setsid sleep 30 & exit 3', { timeoutMs: 60_000, drainMs: 400 });
  const took = Date.now() - started;
  assert.equal(r.record?.exitCode, 3, 'the shell\'s own answer, not the timeout\'s');
  assert.equal(r.record?.kind, 'exit');
  assert.ok(took < 10_000, `settled at the drain (${took}ms), not at the timeout`);
  assert.ok(took >= 300, 'and it did give the pipes their moment');
});

test('the hard kill is UNCONDITIONAL: a TERM-ignoring child is dead after the grace', async () => {
  // `close` fired when the SHELL died and cancelled the `SIGKILL`, so a runner that traps `SIGTERM`
  // and has its stdio redirected went on running in the worktree the resumed attempt continues in,
  // while the record said it "was still running after Ns and was killed".
  const where = fs.mkdtempSync(path.join(dir, 'hardkill-'));
  const pidFile = path.join(where, 'pid');
  const script = path.join(where, 'stubborn.sh');
  fs.writeFileSync(script, '#!/bin/sh\ntrap "" TERM\necho $$ > "$1"\nsleep 30\n');
  fs.chmodSync(script, 0o755);
  // Redirected away from the pipes, so `close` arrives while the process is still very much alive.
  const r = await runCheck(where, `sh ${script} ${pidFile} </dev/null >/dev/null 2>&1 & wait`, {
    timeoutMs: 300, killGraceMs: 500, drainMs: 100,
  });
  assert.equal(r.ok, false);
  assert.match(r.record?.why ?? '', /still running after/, 'it ran out of time, and the group was signalled');

  const pid = Number(fs.readFileSync(pidFile, 'utf8').trim());
  assert.ok(Number.isInteger(pid) && pid > 0, 'the stubborn child really did start');
  let alive = true;
  try { process.kill(pid, 0); } catch { alive = false; }
  assert.equal(alive, true, 'it ignores SIGTERM — otherwise this test proves nothing');
  // The `SIGKILL` is armed by the timeout and fires whether or not `close` did.
  await new Promise((done) => setTimeout(done, 1_200));
  try { process.kill(pid, 0); alive = true; } catch { alive = false; }
  assert.equal(alive, false, 'and it is gone — no survivor in the checkout the next attempt resumes in');
});

test('runCheck NEVER rejects: every synchronous spawn failure is an `unstartable` record', async () => {
  // All three throw SYNCHRONOUSLY, before any listener exists — measured, on this Node. An unhandled
  // rejection out of the controller's post-run section is a Job stuck `running` with a lease nobody
  // can take, which is the expensive version of a typo in a `cwd`.
  const notADir = path.join(dir, 'a-file');
  fs.writeFileSync(notADir, 'x');
  const cases: [string, string, string][] = [
    ['a cwd that is not a directory', path.join(notADir, 'nope'), 'true'],
    ['a command past the kernel argument limit', dir, `echo ${'x'.repeat(200_000)}`],
    ['a command containing a NUL byte', dir, 'echo \0 hi'],
  ];
  for (const [what, cwd, command] of cases) {
    const r = await runCheck(cwd, command, { timeoutMs: 2_000 });
    assert.equal(r.ok, false, what);
    assert.equal(r.record?.kind, 'unstartable', `${what}: it never began, and that is not the same as failing`);
    assert.equal(r.record?.exitCode, null, `${what}: there is no verdict to quote`);
    assert.match(r.record?.why ?? '', /could not be started/, what);
    // And the sentence it produces claims nothing about the work.
    assert.match(checkShortfall(r.record!, true), /nothing about the work was judged/, what);
  }
});

test('an abort AFTER a timeout still settles — the operator\'s last resort is not a no-op', async () => {
  // `stop` returned early once `killedFor` was set, so a timeout that could not settle (a descendant
  // outside the group holding the pipe) left `hkb down` with nothing to do. The second, different
  // stop is let through: it re-signals the group and the hard kill still bounds it.
  const ac = new AbortController();
  const started = Date.now();
  // The timeout fires first and cannot finish the job; the abort follows.
  setTimeout(() => ac.abort(), 500);
  const r = await runCheck(dir, 'setsid sleep 30 & sleep 30', {
    timeoutMs: 200, killGraceMs: 400, drainMs: 10_000, signal: ac.signal,
  });
  const took = Date.now() - started;
  assert.equal(r.ok, false);
  assert.ok(took < 8_000, `it came back (${took}ms) rather than waiting out the drain`);
  assert.equal(r.record?.exitCode, null, 'nothing gave a verdict');
});

// ---------------------------------------------------------------- the verdict is frozen at exit

test('a stop that lands INSIDE the drain window cannot rewrite a real exit status', async () => {
  // `exit` armed the drain but left the wall clock running and recomputed the error at `finish`:
  // a timeout firing two seconds after a passing `exit 0` — the shell gone, a same-group child
  // still holding the pipe — killed a group that had already answered and recorded a timeout.
  // At the shipped numbers that is `node server.js & mocha` finishing in the last two seconds.
  const where = fs.mkdtempSync(path.join(dir, 'drain-race-'));
  const r = await runCheck(where, 'echo PASSED; sleep 3 & exit 0', { timeoutMs: 400, drainMs: 1_500, killGraceMs: 200 });
  assert.equal(r.ok, true, 'the shell said 0 and that is the verdict, whatever the clock did during the drain');

  // And a real failure is not improved by the same race either.
  const bad = await runCheck(where, 'echo NOPE >&2; sleep 3 & exit 7', { timeoutMs: 400, drainMs: 1_500, killGraceMs: 200 });
  assert.equal(bad.record?.kind, 'exit');
  assert.equal(bad.record?.exitCode, 7, 'exit 7 stays exit 7');
});

test('the SIGKILL is sent even by a process with nothing else to do — a single-pass `hkb run`', async () => {
  // The grace timer was `unref`'d "so it is never the reason the daemon stays up" — and a process
  // that had nothing else to do exited on `finish`, before the grace elapsed, so a `SIGTERM`-ignoring
  // runner lived on in the worktree. The daemon never noticed because it always has a next tick.
  // So: a child node process that calls `runCheck` and then has nothing left to wait for.
  const where = fs.mkdtempSync(path.join(dir, 'hardkill-alone-'));
  const pidFile = path.join(where, 'pid');
  fs.writeFileSync(path.join(where, 'stubborn.sh'), '#!/bin/sh\ntrap "" TERM\necho $$ > "$1"\nsleep 30\n');
  const probe = path.join(where, 'probe.mjs');
  const checkTs = path.resolve(import.meta.dirname, '..', 'src', 'check.ts');
  fs.writeFileSync(probe, [
    `import { runCheck } from ${JSON.stringify(checkTs)};`,
    `const r = await runCheck(${JSON.stringify(where)}, ${JSON.stringify(`sh stubborn.sh ${pidFile} </dev/null >/dev/null 2>&1 & wait`)}, { timeoutMs: 300, killGraceMs: 600, drainMs: 100 });`,
    'process.stdout.write(String(r.ok));',
    // Nothing after this: whether the process stays up for the kill is the whole question.
  ].join('\n'));
  const started = Date.now();
  const out = spawnSync(process.execPath, [probe], { cwd: where, encoding: 'utf8', timeout: 15_000 });
  const took = Date.now() - started;
  assert.equal(out.status, 0, out.stderr);
  assert.equal(out.stdout, 'false', 'the check ran out of time');
  assert.ok(took >= 900, `the probe stayed up for the grace (${took}ms) instead of exiting on finish`);

  const pid = Number(fs.readFileSync(pidFile, 'utf8').trim());
  assert.ok(Number.isInteger(pid) && pid > 0);
  let alive = true;
  try { process.kill(pid, 0); } catch { alive = false; }
  assert.equal(alive, false, 'the TERM-ignoring child is dead: the SIGKILL was sent by a process that had nothing else to do');
});

test('`interrupted` comes from the record, and a frozen verdict is never interrupted', async () => {
  // The controller used to ask `deps.signal.aborted`, which is true for an abort that landed in
  // the drain window AFTER a passing `exit 0` — and it then re-ran a session whose check had
  // passed. The result says which: only a stop that settled the check before it answered.
  const where = fs.mkdtempSync(path.join(dir, 'interrupted-'));
  const passed = new AbortController();
  const p = runCheck(where, 'echo PASSED; sleep 4 & exit 0', { signal: passed.signal, drainMs: 1_500, killGraceMs: 200 });
  await new Promise((r) => setTimeout(r, 300));
  passed.abort();
  const r1 = await p;
  assert.equal(r1.ok, true);
  assert.equal(r1.interrupted, undefined, 'the shell had answered before the abort — that answer stands');

  const cut = new AbortController();
  const q = runCheck(where, 'sleep 30', { signal: cut.signal, killGraceMs: 200 });
  await new Promise((r) => setTimeout(r, 200));
  cut.abort();
  const r2 = await q;
  assert.equal(r2.ok, false);
  assert.equal(r2.interrupted, true, 'no verdict existed — this one was interrupted');
});
