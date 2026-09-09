import test from 'node:test';
import assert from 'node:assert/strict';

import { checkPush, scan } from '../src/push.ts';
import { admissionCallback } from '../src/admission.ts';

/**
 * The push refusal, from the refusing side.
 *
 * `docs/workflow-study.md` §4 puts prompt text at layer 6 — *"guarantees nothing; measured
 * guaranteeing nothing twice"* — so "never push to the default branch" was a sentence and nothing
 * else until this module. CLAUDE.md's rule for a new guard is the shape of this file: **every denied
 * form gets a test that makes it refuse**, and the two allowed forms get one that makes it admit,
 * because a gate that only ever proves what it lets through is how this project shipped three checks
 * that did nothing.
 */

const P = { branch: 'kb-7-1', defaultBranch: 'main' };
const denies = (command: string) => {
  const why = checkPush(command, P);
  assert.ok(why, `\`${command}\` was ADMITTED, and it must not be`);
  return why as string;
};
const admits = (command: string) =>
  assert.equal(checkPush(command, P), null, `\`${command}\` was refused, and it is the form the gate tells a worker to use`);

// ---------------------------------------------------------------- the refusals

test('the default branch is refused, however it is spelled', () => {
  for (const command of [
    'git push origin main',
    'git push origin HEAD:main',
    'git push origin kb-7-1:main',
    'git push origin main:main',
    'git push -u origin refs/heads/main',
    'git push --force-with-lease origin HEAD:main',
  ]) {
    assert.match(denies(command), /default branch/, command);
  }
});

test('another branch is refused too — the attempt owns exactly one', () => {
  const why = denies('git push origin kb-9-2');
  assert.match(why, /kb-7-1/, 'and the refusal names the one it may push');
  denies('git push origin HEAD:someone-elses-branch');
  denies('git push origin kb-7-1:kb-7-2');
});

test('a plain force is refused even to its own branch', () => {
  // The rule the operator settled on 2026-09-08: the worker owns its attempt branch, so forcing it
  // is legal work — but `--force-with-lease` is the same operation with the guarantee that nothing
  // arrived since you last looked, and there is no case that wants the version without it.
  for (const command of [
    'git push --force origin kb-7-1',
    'git push -f origin kb-7-1',
    'git push origin +kb-7-1',
  ]) {
    assert.match(denies(command), /force-with-lease/, command);
  }
});

test('a push that names no branch is refused, because it pushes whatever this checkout is on', () => {
  assert.match(denies('git push'), /Name it/);
  denies('git push origin');
  denies('git push -u origin');
});

test('the broad forms are refused by name', () => {
  for (const command of ['git push --all origin', 'git push --mirror origin', 'git push --tags origin']) {
    assert.match(denies(command), /more than your own branch/, command);
  }
});

test('a delete is refused — a worker does not unpublish', () => {
  assert.match(denies('git push origin --delete kb-7-1'), /does not delete branches/);
  denies('git push origin :main');
});

test('a push it cannot read is refused, not admitted', () => {
  for (const command of [
    'sh -c "git push origin main"',
    'eval "$PUSH_CMD"; git push origin main',
    'git push origin $BRANCH',
    'git push origin `echo main`',
    'gitpush() { git push origin main; }; gitpush',
  ]) {
    assert.ok(checkPush(command, P), `\`${command}\` must not be admitted — it cannot be read`);
  }
  assert.match(checkPush('git push origin $BRANCH', P) as string, /cannot tell/);
});

test('every refusal names a form that works', () => {
  for (const command of [
    'git push origin main', 'git push --force origin kb-7-1', 'git push', 'git push --all origin',
    'git push origin --delete kb-7-1', 'git push origin $BRANCH', 'git push origin kb-9-2',
  ]) {
    assert.match(denies(command), /git push -u origin kb-7-1/, `${command} — a refusal with no next move is a dead end`);
  }
});

// ---------------------------------------------------------------- what it must NOT break

test('the two allowed forms are admitted', () => {
  admits('git push -u origin kb-7-1');
  admits('git push --force-with-lease origin kb-7-1');
  admits('git push --force-with-lease=kb-7-1 origin kb-7-1');
  admits('git push origin kb-7-1:kb-7-1');
  admits('git push -u origin HEAD:kb-7-1');
});

test('a push that is one step of a compound command is judged on its own', () => {
  admits('git add -A && git commit -m "work" && git push -u origin kb-7-1');
  assert.ok(checkPush('git commit -m x && git push origin main', P), 'and so is a bad one');
  admits('git push -u origin kb-7-1 > /dev/null 2>&1');
});

test('a command with no push in it is not this gate\'s business', () => {
  for (const command of [
    'npm test', 'git commit -m "fix"', 'git log --oneline -5', 'git fetch origin main && git rebase origin/main',
    'gh pr create --draft --head kb-7-1', 'echo "$(date)"',
  ]) {
    admits(command);
  }
});

test('the answer does not depend on the shape of the quoting', () => {
  admits("git push -u 'origin' \"kb-7-1\"");
  assert.ok(checkPush('git push "origin" \'main\'', P), 'quoting a branch does not hide it');
});

// ---------------------------------------------------------------- the scanner it rests on

test('scan refuses to read what a shell would expand', () => {
  assert.equal(scan('git push origin $B'), null);
  assert.equal(scan('git push origin `b`'), null);
  assert.equal(scan('git push origin "$(b)"'), null);
  assert.equal(scan("git push origin 'unclosed"), null);
});

test('scan splits on the operators that start a new command', () => {
  assert.deepEqual(scan('a && b; c | d'), [['a'], ['b'], ['c'], ['d']]);
  assert.deepEqual(scan('git push -u origin kb-7-1'), [['git', 'push', '-u', 'origin', 'kb-7-1']]);
  // A redirection is not a new command, but what follows it is a filename rather than a refspec —
  // including the file descriptor in front of it, or a bare `2` reads as something to push.
  assert.deepEqual(scan('git push origin kb-7-1 2>/dev/null'), [['git', 'push', 'origin', 'kb-7-1'], ['/dev/null']]);
});

// ---------------------------------------------------------------- through the gate itself

/** The `PreToolUse` shape the SDK hands the hook. */
const bash = (command: string) => ({
  hook_event_name: 'PreToolUse' as const,
  tool_name: 'Bash',
  tool_input: { command },
  session_id: 's',
  transcript_path: '',
  cwd: '/tmp',
  permission_mode: 'default' as const,
});

const decision = (r: Awaited<ReturnType<ReturnType<typeof admissionCallback>>>) =>
  (r as { hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string } }).hookSpecificOutput;

test('the gate denies the push, and says so on the decision log', async () => {
  const log: string[] = [];
  const gate = admissionCallback({ push: P, onDecision: (d) => log.push(d) });
  const out = decision(await gate(bash('git push origin main') as never));
  assert.equal(out?.permissionDecision, 'deny');
  assert.match(out?.permissionDecisionReason ?? '', /default branch/);
  assert.equal(log.length, 1, 'a refusal is news — it is counted and printed');
  assert.equal(decision(await gate(bash('git push -u origin kb-7-1') as never))?.permissionDecision, 'allow');
});

test('a workload with no branch of its own has no push rule to break', async () => {
  // `--no-isolate` runs in the operator's checkout, where "your own branch" names nothing. It is not
  // given the sandbox contract either, so the prose and the guard cover the same population.
  const gate = admissionCallback({});
  assert.equal(decision(await gate(bash('git push origin main') as never))?.permissionDecision, 'allow');
});

test('the gate still refuses a tool that is off the surface, push or no push', async () => {
  const gate = admissionCallback({ push: P, allow: ['Read'] });
  assert.equal(decision(await gate(bash('git push -u origin kb-7-1') as never))?.permissionDecision, 'deny');
});
