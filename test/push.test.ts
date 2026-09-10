import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

import { checkHookEscape, installPushHook, parsePrePush, policyFile, refusePush } from '../src/push.ts';
import { admissionCallback } from '../src/admission.ts';

/**
 * The push refusal, from the refusing side — and at the layer that can actually refuse.
 *
 * The first version of this file tested a parser that read the `Bash` command as text, and it
 * passed. Then the same forms were run against a real remote and ten of them got through: `-f
 * --force-with-lease`, `-fu`, `>/dev/null` before a trailing `main`, `:kb-7-1`, `-c
 * remote.origin.push=…`, `git -c alias.p=push p origin main`, `/usr/bin/git`, `"gi"t`, `sh -c`. A
 * test suite that proves a guard refuses the forms its author thought of is not evidence about the
 * guard; it is evidence about the author.
 *
 * So the last test in this file is the one that matters, and it is not a unit test: it makes a real
 * repository with a real remote, installs the hook the controller installs, and pushes. Every form
 * above reaches `git push` differently and reaches the HOOK identically, which is the whole reason
 * the decision moved there — and this is how that claim is checked rather than asserted.
 */

const P = { branch: 'kb-7-1', defaultBranch: 'main' };
const ZERO = '0000000000000000000000000000000000000000';
const SHA = 'a'.repeat(40);

const denies = (lines: string) => {
  const why = refusePush(parsePrePush(lines), P);
  assert.ok(why, `${JSON.stringify(lines)} was ADMITTED, and it must not be`);
  return why as string;
};
const admits = (lines: string) =>
  assert.equal(refusePush(parsePrePush(lines), P), null, `${JSON.stringify(lines)} was refused`);

// ---------------------------------------------------------------- the decision

test('the default branch is refused, and the refusal says which branch it was', () => {
  const why = denies(`refs/heads/kb-7-1 ${SHA} refs/heads/main ${ZERO}`);
  assert.match(why, /default branch/);
  assert.match(why, /`main`/);
});

test('another branch is refused too — the attempt owns exactly one', () => {
  for (const remote of ['refs/heads/kb-9-1', 'refs/heads/develop', 'refs/heads/kb-7-2']) {
    assert.match(denies(`refs/heads/kb-7-1 ${SHA} ${remote} ${ZERO}`), /owns/, remote);
  }
});

test('a ref that is not a branch is refused — a tag is not this worker\'s to write', () => {
  assert.match(denies(`refs/tags/v1 ${SHA} refs/tags/v1 ${ZERO}`), /owns/);
});

test('a delete is refused, in both of git\'s spellings for it', () => {
  assert.match(denies(`(delete) ${ZERO} refs/heads/kb-7-1 ${SHA}`), /DELETES/);
  assert.match(denies(`refs/heads/kb-7-1 ${ZERO} refs/heads/kb-7-1 ${SHA}`), /DELETES/);
});

test('a delete of its OWN branch is still refused — the rule is about unpublishing', () => {
  assert.match(denies(`(delete) ${ZERO} refs/heads/kb-7-1 ${SHA}`), /DELETES/);
});

test('one bad ref in a push of several refuses the whole push', () => {
  const why = denies(
    `refs/heads/kb-7-1 ${SHA} refs/heads/kb-7-1 ${ZERO}\n`
    + `refs/heads/kb-7-1 ${SHA} refs/heads/main ${ZERO}`,
  );
  assert.match(why, /default branch/);
});

test('a line it cannot read is refused rather than skipped', () => {
  assert.ok(refusePush(parsePrePush('garbage'), P));
});

test('every refusal names the form that works', () => {
  for (const lines of [
    `refs/heads/kb-7-1 ${SHA} refs/heads/main ${ZERO}`,
    `refs/heads/kb-7-1 ${SHA} refs/heads/kb-9-1 ${ZERO}`,
    `(delete) ${ZERO} refs/heads/kb-7-1 ${SHA}`,
  ]) {
    assert.match(denies(lines), /git push -u origin kb-7-1/, lines);
  }
});

test('its own branch is admitted, new or updated', () => {
  admits(`refs/heads/kb-7-1 ${SHA} refs/heads/kb-7-1 ${ZERO}`);
  admits(`refs/heads/kb-7-1 ${SHA} refs/heads/kb-7-1 ${'b'.repeat(40)}`);
  // HEAD:kb-7-1 — the local side may be anything; only where it lands is this rule's business.
  admits(`HEAD ${SHA} refs/heads/kb-7-1 ${ZERO}`);
});

test('a push that updates nothing is admitted — git runs the hook for a no-op too', () => {
  admits('');
  admits('\n  \n');
});

test('a suffixed collision branch is the branch, when that is what the policy says', () => {
  assert.equal(refusePush(parsePrePush(`refs/heads/kb-7-1-2 ${SHA} refs/heads/kb-7-1-2 ${ZERO}`),
    { branch: 'kb-7-1-2', defaultBranch: 'main' }), null);
});

// ---------------------------------------------------------------- what the gate still reads

test('the gate refuses --no-verify, which is how a push skips the hook', () => {
  assert.match(checkHookEscape('git push --no-verify origin main') as string, /--no-verify/);
  assert.match(checkHookEscape('git push -u --no-verify origin kb-7-1') as string, /--no-verify/);
});

test('the gate refuses moving core.hooksPath, in every form of the move', () => {
  for (const command of [
    'git -c core.hooksPath=/tmp/x push origin main',
    'git config core.hooksPath /tmp/x',
    'git config --worktree --unset core.hooksPath',
    'git config --unset core.hooksPath',
  ]) {
    assert.match(checkHookEscape(command) as string, /core\.hooksPath/, command);
  }
});

test('the gate is not a push parser any more, and the commit form it used to refuse is admitted', () => {
  // Refused by the old parser for mentioning the word `push` inside a heredoc — the commit form
  // Claude Code itself teaches.
  assert.equal(checkHookEscape("git commit -m \"$(cat <<'EOF'\nWork\n\npush it later\nEOF\n)\""), null);
  for (const command of [
    'git push origin main',
    'git push --force origin kb-7-1',
    'git stash push',
    'git grep push',
    'npm test',
  ]) {
    assert.equal(checkHookEscape(command), null, command);
  }
});

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

test('the gate denies the escape, and says so on the decision log', async () => {
  const log: string[] = [];
  const gate = admissionCallback({ sandboxed: true, onDecision: (d) => log.push(d) });
  const out = decision(await gate(bash('git push --no-verify -u origin kb-7-1') as never));
  assert.equal(out?.permissionDecision, 'deny');
  assert.match(out?.permissionDecisionReason ?? '', /--no-verify/);
  assert.equal(log.length, 1, 'a refusal is news — it is counted and printed');
  assert.equal(decision(await gate(bash('git push -u origin kb-7-1') as never))?.permissionDecision, 'allow');
});

test('the gate leaves the branch rule to the hook — it admits a push it cannot judge', async () => {
  // The old gate refused this by reading the string, and was measured bypassable ten ways. The hook
  // refuses it at git instead, which is what the last test in this file proves.
  const gate = admissionCallback({ sandboxed: true });
  assert.equal(decision(await gate(bash('git push origin main') as never))?.permissionDecision, 'allow');
});

test('a workload with no sandbox has no hook to protect', async () => {
  // `--no-isolate` runs in the operator's checkout: no worktree, no `core.hooksPath`, nothing for
  // these two refusals to be about. It is not given the sandbox contract either, so the prose and
  // the guard cover the same population.
  const gate = admissionCallback({});
  assert.equal(decision(await gate(bash('git push --no-verify origin main') as never))?.permissionDecision, 'allow');
});

test('the gate still refuses a tool that is off the surface, push or no push', async () => {
  const gate = admissionCallback({ sandboxed: true, allow: ['Read'] });
  assert.equal(decision(await gate(bash('git push -u origin kb-7-1') as never))?.permissionDecision, 'deny');
});

// ---------------------------------------------------------------- against a real git

/**
 * The test the parser could not have passed.
 *
 * A bare remote, a worktree with the hook installed on it, and every bypass that beat the parser —
 * run for real. The point is not that these particular spellings are refused; it is that the hook
 * never sees a spelling at all. `git -c alias.p=push p origin main` and `git push origin main`
 * arrive at it as the same four fields.
 */
test('the hook refuses at git, whatever the command line looked like', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hkb-push-'));
  const was = process.env.HKB_DATABASE_URL;
  // `hooksHome()` is `boardDir()`, so pointing the board at this directory puts the hook in it —
  // the same isolation every other test in this repository gets for free. Restored on the way out
  // so a failure here does not take the rest of the suite with it.
  process.env.HKB_DATABASE_URL = `file:${path.join(home, 'board.db')}`;
  t.after(() => {
    if (was === undefined) delete process.env.HKB_DATABASE_URL;
    else process.env.HKB_DATABASE_URL = was;
    fs.rmSync(home, { recursive: true, force: true });
  });

  const run = (cwd: string, args: string[]) =>
    execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const root = path.join(home, 'repo');
  const remote = path.join(home, 'remote.git');
  fs.mkdirSync(root);
  execFileSync('git', ['init', '--bare', '-b', 'main', remote], { stdio: 'ignore' });
  run(root, ['init', '-b', 'main']);
  run(root, ['config', 'user.email', 't@example.com']);
  run(root, ['config', 'user.name', 'T']);
  fs.writeFileSync(path.join(root, 'a.txt'), 'a\n');
  run(root, ['add', '-A']);
  run(root, ['commit', '-m', 'first']);
  run(root, ['remote', 'add', 'origin', remote]);
  run(root, ['push', '-u', 'origin', 'main']);
  // Local `main` is left AHEAD of the remote, so every attempt below to push the trunk is a real
  // update rather than an "Everything up-to-date" that proves nothing. The hook judges effects, not
  // spellings: a push that would move nothing is admitted because it moves nothing.
  fs.writeFileSync(path.join(root, 'a.txt'), 'a2\n');
  run(root, ['commit', '-am', 'trunk moves on']);

  const wt = path.join(root, '.hkb', 'worktrees', 'kb-7-1');
  run(root, ['worktree', 'add', '-b', 'kb-7-1', wt, 'main']);
  assert.equal(installPushHook(root, wt, P), null, 'the hook did not install');
  // Keyed by the REPOSITORY now, so every worktree of it — including ones hkb never made — finds it.
  assert.ok(fs.existsSync(policyFile(root)), 'no policy was pinned to the repository');

  fs.writeFileSync(path.join(wt, 'b.txt'), 'b\n');
  run(wt, ['add', '-A']);
  run(wt, ['commit', '-m', 'work']);

  const push = (args: string[]) => spawnSync('git', args, { cwd: wt, encoding: 'utf8' });
  const refused = (args: string[]) => {
    const r = push(args);
    assert.notEqual(r.status, 0, `\`git ${args.join(' ')}\` SUCCEEDED, and it must not`);
    assert.match(`${r.stdout}${r.stderr}`, /hkb:/, `\`git ${args.join(' ')}\` failed for some other reason`);
  };

  // Each of these beat the string parser. None of them beats git.
  refused(['push', 'origin', 'main']);
  refused(['push', 'origin', 'HEAD:main']);
  refused(['push', '-f', '--force-with-lease', 'origin', 'HEAD:main']);
  refused(['push', '-fu', 'origin', 'HEAD:main']);
  refused(['push', '--all']);
  refused(['push', 'origin', '--delete', 'main']);
  refused(['-c', 'alias.p=push', 'p', 'origin', 'main']);
  refused(['-c', 'remote.origin.push=refs/heads/kb-7-1:refs/heads/main', 'push', 'origin']);
  refused(['push', 'origin', 'kb-7-1:kb-9-1']);
  refused(['push', 'origin', 'HEAD:refs/heads/main']);

  // The form the worker is told to use goes through, which is the half that has to keep working.
  const ok = push(['push', '-u', 'origin', 'kb-7-1']);
  assert.equal(ok.status, 0, `the allowed push was refused: ${ok.stdout}${ok.stderr}`);
  assert.match(run(root, ['ls-remote', '--heads', remote]), /refs\/heads\/kb-7-1/);
  // The trunk is where the remote had it: nothing above moved it, and local `main` is ahead.
  assert.notEqual(run(root, ['rev-parse', 'main']).trim(), run(root, ['ls-remote', remote, 'refs/heads/main']).split(/\s+/)[0]);

  // Unpublishing, in both spellings — and only reachable now that there is something to delete.
  refused(['push', 'origin', ':kb-7-1']);
  refused(['push', 'origin', '--delete', 'kb-7-1']);

  // The controller's own rebase push is on this same path, and it must not be refused.
  const lease = spawnSync('git', ['push', '--force-with-lease', 'origin', 'kb-7-1'], { cwd: wt, encoding: 'utf8' });
  assert.equal(lease.status, 0, `the controller's lease push was refused: ${lease.stdout}${lease.stderr}`);

  // The operator's own checkout is governed by nothing: their pushes, their hooks. The policy is
  // filed per REPOSITORY now, so without the `mainWorktree` exemption this would refuse them for as
  // long as a Job held a lease.
  const fromRoot = spawnSync('git', ['push', 'origin', 'main'], { cwd: root, encoding: 'utf8' });
  assert.equal(fromRoot.status, 0, `the main checkout was caught by the hook: ${fromRoot.stdout}${fromRoot.stderr}`);

  // ---- and the hole #63 measured: ANOTHER worktree of the same repository.
  //
  // The harness cuts one for a subagent at `<repo>/.claude/worktrees/agent-<id>`, which hkb never
  // sees and cannot install anything on. While `core.hooksPath` was set with `git config
  // --worktree` on the attempt's checkout, that worktree inherited NOTHING — measured in #63: a
  // push refused from `.hkb/worktrees/kb-7-1` succeeded from the agent's, so `Agent` plus `Bash`
  // could write the trunk. It is governed by the repository's policy now, like every checkout that
  // is not the operator's own.
  const agent = path.join(root, '.claude', 'worktrees', 'agent-abc123');
  run(root, ['worktree', 'add', '-b', 'agent-work', agent, 'main']);
  // It needs something to push: a push that would move nothing is admitted because it moves
  // nothing, which is the hook judging effects rather than spellings.
  fs.writeFileSync(path.join(agent, 'c.txt'), 'c\n');
  run(agent, ['add', '-A']);
  run(agent, ['commit', '-m', 'agent work']);
  const fromAgent = spawnSync('git', ['push', 'origin', 'HEAD:main'], { cwd: agent, encoding: 'utf8' });
  assert.notEqual(fromAgent.status, 0, 'a subagent worktree pushed the trunk — the fence #63 found broken');
  assert.match(`${fromAgent.stdout}${fromAgent.stderr}`, /hkb:/, 'and it is hkb that refused it');
  // Its own branch is refused too: a subagent is cut from origin/main and its work never comes back
  // (#63), so nothing it pushes is a sanctioned flow.
  const own = spawnSync('git', ['push', '-u', 'origin', 'agent-work'], { cwd: agent, encoding: 'utf8' });
  assert.notEqual(own.status, 0, 'a subagent owns no branch on the remote');
});
