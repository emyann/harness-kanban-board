import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

/**
 * The workspace, against the real SDK — and this test exists because of *how* it is wired.
 *
 * `WorkerSpec.workspace` reaches the harness through `Options.extraArgs`, which is an **untyped
 * escape hatch**: a `Record<string, string | null>` handed to the Claude Code executable as CLI
 * flags. It is the right mechanism — the SDK is a wrapper around that binary, so every flag is
 * reachable — but nothing about it is checked at compile time. Rename `--worktree` upstream and
 * `queryOptions` still type-checks, still runs, and silently stops isolating anything: every
 * session would run in the operator's own checkout, and no test built on the fake runtime could
 * possibly notice.
 *
 * So the assertion is the one that cannot be faked: after a real run, **is there a worktree, and
 * did the session actually stand in it?** CLAUDE.md's rule is that a guard is not proven by a test
 * that asks whether it allows. The refusing case here is the silent one — isolation that did not
 * happen — which is why this asserts on the filesystem rather than on the outcome.
 *
 * Skipped unless `HKB_LIVE_SDK=1`: it spends money and needs the network, and CI must stay free and
 * deterministic. Run it by hand when the runtime changes, and whenever the SDK is bumped.
 */
const live = process.env.HKB_LIVE_SDK === '1';

test('the harness provisions the workspace hkb declares, and the session runs in it',
  { skip: live ? false : 'set HKB_LIVE_SDK=1 to run against the real SDK' },
  async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'hkb-ws-'));
    const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
    execFileSync('git', ['init', '-q', repo]);
    git('config', 'user.email', 'test@example.invalid');
    git('config', 'user.name', 'test');
    fs.writeFileSync(path.join(repo, 'README.md'), 'base\n');
    git('add', '-A');
    git('commit', '-qm', 'base');

    const { claudeRuntime } = await import('../src/runtime/claude.ts');
    const { workspaceName } = await import('../src/workspaces.ts');
    const name = workspaceName(1);
    const outcome = await claudeRuntime.run({
      taskId: 1,
      attempt: 1,
      cwd: repo,
      // The declaration under test. The Job kind says "I need a workspace called this"; everything
      // about what that means is the runtime's.
      workspace: { name },
      prompt: 'Run `pwd` with Bash and reply with exactly that one line, nothing else.',
      allowedTools: ['Bash'],
      maxTurns: 6,
      maxBudgetUsd: 1,
      timeoutMs: 180_000,
    });

    // 1. The path came back, rather than being reconstructed from a convention this side invented.
    assert.ok(outcome.workspacePath, 'the runtime reported no workspace path — `--worktree` did not reach the CLI');

    // 2. It is a real git worktree of this repository, and it is NOT the main checkout. This is the
    //    assertion that fails if the flag is silently dropped: without it the session runs in
    //    `repo` itself and everything else about the run still looks perfectly healthy.
    const worktrees = git('worktree', 'list');
    assert.match(worktrees, new RegExp(name), `no worktree named ${name}:\n${worktrees}`);
    assert.notEqual(
      fs.realpathSync(outcome.workspacePath as string),
      fs.realpathSync(repo),
      'the session ran in the main checkout — it was not isolated',
    );

    // 3. It is where `workspaceJobId` can find it again. The sweep runs long after the session is
    //    gone and recognises its own workspaces by directory NAME, so "the harness puts it somewhere
    //    called `<name>`" is load-bearing and is exactly the kind of untyped-`extraArgs` fact this
    //    test exists to pin.
    const { workspaceJobId } = await import('../src/workspaces.ts');
    assert.equal(workspaceJobId(outcome.workspacePath as string), 1,
      `the sweep would not recognise ${outcome.workspacePath} as a workspace of Job 1`);

    // 4. The session itself agrees. The path is read off the `init` message, so a driver that
    //    reported a directory the agent never entered would pass the checks above.
    assert.match(
      outcome.text.trim(),
      new RegExp(name),
      `the agent reported a different cwd than the one recorded:\n${outcome.text}`,
    );

    fs.rmSync(repo, { recursive: true, force: true });
  });
