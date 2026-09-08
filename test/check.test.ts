import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
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
  assert.match(r.record?.tail ?? '', /boom/, 'and what it said is kept');
});

test('a command the shell cannot find is an ordinary failure — the shell says so better', () => {
  // `sh -c` exits 127 and writes its own message. Inventing one here would replace a precise
  // sentence naming the missing binary with a vaguer one that names nothing.
  const r = readCheck('nope', { status: 127, signal: null, stdout: '', stderr: 'sh: 1: nope: not found' }, 3);
  assert.equal(r.ok, false);
  assert.equal(r.record?.exitCode, 127);
  assert.match(r.record?.tail ?? '', /not found/);
});

test('a check that ran out of time fails, and says so rather than reporting a code', () => {
  const r = readCheck('sleep 999', { status: null, signal: 'SIGTERM', stdout: '', stderr: '' }, 600_000);
  assert.equal(r.ok, false);
  assert.equal(r.record?.exitCode, null, 'there is no exit code to report — it was killed');
  assert.match(r.record?.why ?? '', /still running after 600s/);
});

test('a check that could not be STARTED fails, and says which', () => {
  const e = Object.assign(new Error('spawn EACCES'), { code: 'EACCES' });
  const r = readCheck('./gate', { status: null, signal: null, error: e, stdout: '', stderr: '' }, 1);
  assert.equal(r.ok, false);
  assert.equal(r.record?.exitCode, null);
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
  assert.match(r.record?.tail ?? '', /AssertionError$/);
});

// ---------------------------------------------------------------- what the operator is told

test('the failure names the command, and what happens next depends on whether a retry is left', () => {
  const rec = { command: 'npm test', exitCode: 1, tail: '1 failing', ms: 1000 };
  const retrying = checkShortfall(rec, true);
  assert.match(retrying, /`npm test`/, 'the command, so it can be run by hand');
  assert.match(retrying, /exited 1/);
  assert.match(retrying, /resumes the same session/, 'and that the next attempt is told what failed');

  const done = checkShortfall(rec, false);
  assert.match(done, /No retries are left/);
  assert.match(done, /hkb retry <id>/, 'the command that changes the answer');
});

test('a check that never ran says WHY instead of quoting an exit code it does not have', () => {
  const line = describeCheck({ command: 'npm test', exitCode: null, tail: '', ms: 600_000, why: 'it was still running after 600s and was killed' });
  assert.match(line, /still running/);
  assert.doesNotMatch(line, /exited null/);
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
  const r = storedCheck({ command: 'npm test', exitCode: 1, tail: '1 failing', ms: 30 });
  assert.deepEqual(r, { command: 'npm test', exitCode: 1, tail: '1 failing', ms: 30 });
  const thin = storedCheck({ command: 'npm test' });
  assert.deepEqual(thin, { command: 'npm test', exitCode: null, tail: '', ms: 0 });
});

// ---------------------------------------------------------------- the one piece of I/O

test('it runs through the shell, in the directory it was given', () => {
  const where = fs.mkdtempSync(path.join(dir, 'run-'));
  fs.writeFileSync(path.join(where, 'here'), 'yes\n');
  assert.equal(runCheck(where, 'test -f here').ok, true, 'cwd is the checkout, not the daemon\'s');
  // `&&` is the reason it goes through a shell at all: one check, two commands, and the first
  // failure short-circuits exactly as the operator who wrote the line expects.
  const r = runCheck(where, 'echo one && exit 3');
  assert.equal(r.ok, false);
  assert.equal(r.record?.exitCode, 3);
  assert.match(r.record?.tail ?? '', /one/);
});

test('a check that outlives its timeout is killed rather than waited for', () => {
  const r = runCheck(dir, 'sleep 30', { timeoutMs: 250 });
  assert.equal(r.ok, false);
  assert.equal(r.record?.exitCode, null);
  assert.match(r.record?.why ?? '', /still running after 0s|still running after 1s/);
});
