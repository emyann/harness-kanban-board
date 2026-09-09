import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { Runtime } from '../src/runtime/index.ts';

// A scratch database per run, migrated the same way production is.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hkb-ctl-'));
process.env.HKB_DATABASE_URL = `file:${path.join(dir, 'test.db')}`;
const REPO = path.resolve(import.meta.dirname, '..');
execFileSync(process.execPath, ['node_modules/prisma/build/index.js', 'migrate', 'deploy'], {
  cwd: REPO, env: process.env, stdio: 'ignore',
});

const { openBoard, closeBoard } = await import('../src/db.ts');
const { reconcile, reconcileToRest, nextPhase } = await import('../src/controller.ts');
const { fakeRuntime } = await import('../src/runtime/fake.ts');
const { admissionCallback } = await import('../src/admission.ts');
const { artifactsDir } = await import('../src/artifacts.ts');
const { concludeJob } = await import('../src/transitions.ts');
const { fenceSafe, withCheckFailure } = await import('../src/brief.ts');

const db = openBoard();
const board = await db.board.upsert({ where: { slug: 'test' }, update: {}, create: { slug: 'test' } });
/**
 * A throwaway repository, not the one you are working in.
 *
 * `mkJob` lets `isolate` default to true, so every Job here cuts a real worktree — and pointed at
 * `REPO` that meant this suite wrote 620 MB checkouts into the developer's own tree and left them.
 * The same defect was fixed in `test/safety.test.ts`; this is the other half of it.
 */
const cwd = path.join(dir, 'scratch-repo');
fs.mkdirSync(cwd);
{
  const g = (...a: string[]) => execFileSync('git', a, { cwd, stdio: 'ignore' });
  g('init', '-q', '-b', 'main');
  g('config', 'user.email', 'c@test');
  g('config', 'user.name', 'c');
  fs.writeFileSync(path.join(cwd, 'README.md'), '# scratch\n');
  g('add', '-A');
  g('commit', '-qm', 'base');
}

const mkJob = (name: string, extra: Record<string, unknown> = {}) =>
  db.job.create({ data: { boardId: board.id, name, brief: `do ${name}`, ...extra } });

test.after(async () => { await closeBoard(); fs.rmSync(dir, { recursive: true, force: true }); });

// ---------------------------------------------------------------- the pure decision

test('nextPhase: a completed run succeeds and is not resumable', () => {
  const d = nextPhase({ status: 'completed' } as never, 1, 2);
  assert.equal(d.phase, 'succeeded');
  assert.equal(d.resumable, false);
});

test('nextPhase: a turn cap is resumable and retries while budget remains', () => {
  const d = nextPhase({ status: 'max_turns' } as never, 1, 2);
  assert.equal(d.phase, 'pending');
  assert.equal(d.outcome, 'max_turns');
  assert.equal(d.resumable, true, 'a turn cap left a session worth continuing');
});

test('nextPhase: maxRetries 2 means three attempts, then failed', () => {
  assert.equal(nextPhase({ status: 'crashed' } as never, 1, 2).phase, 'pending');
  assert.equal(nextPhase({ status: 'crashed' } as never, 2, 2).phase, 'pending');
  assert.equal(nextPhase({ status: 'crashed' } as never, 3, 2).phase, 'failed', 'out of retries');
});

test('nextPhase: a wall-clock timeout is OUR stop, and it is resumable', () => {
  const d = nextPhase({ status: 'timeout' } as never, 1, 2);
  assert.equal(d.outcome, 'timed_out');
  assert.equal(d.phase, 'pending');
  assert.equal(d.resumable, true, 'the clock ran out, not the work — the session is worth continuing');
});

// The shipped defaults, so these say what a real Job gets rather than what a fixture does.
const DEFAULT_RETRIES = 2;
const DEFAULT_BUDGET = 1;

test('nextPhase: a spent budget REFUSES to retry, though two retries remain', () => {
  // The measured failure: job #6 spent $2.05, was retried into the same cap, spent $2.02 stopping
  // in the same place, and its third attempt was refused by the board ceiling. $4.07 for nothing.
  const d = nextPhase({ status: 'max_budget' } as never, 1, DEFAULT_RETRIES, DEFAULT_BUDGET);
  assert.equal(d.phase, 'failed', 'the first attempt is also the last: the retry would get the same cap');
  assert.equal(d.outcome, 'max_budget');
});

test('nextPhase: a spent budget stays resumable, so a raised retry continues', () => {
  // `failed` and `resumable` are not in tension: the work up to the wall is real, and the
  // controller keeps `lastSessionId` on exactly this flag. Losing it would make `hkb retry
  // --max-budget` start cold and re-buy everything the $2 already paid for.
  const d = nextPhase({ status: 'max_budget' } as never, 1, DEFAULT_RETRIES, DEFAULT_BUDGET);
  assert.equal(d.resumable, true);
});

test('nextPhase: the budget failure tells a human the cap, and what to do about it', () => {
  const d = nextPhase({ status: 'max_budget' } as never, 1, DEFAULT_RETRIES, DEFAULT_BUDGET);
  assert.match(d.lastError ?? '', /\$1\.00/, 'the cap it hit, in dollars');
  assert.match(d.lastError ?? '', /hkb retry <id> --max-budget 2\.00/, 'the command that changes the answer');
  assert.match(d.lastError ?? '', /session is kept/, 'and that the raise resumes rather than restarts');
});

test('nextPhase: with no cap to name, the advice still names the move', () => {
  const d = nextPhase({ status: 'max_budget' } as never, 1, DEFAULT_RETRIES);
  assert.match(d.lastError ?? '', /--max-budget <usd>/, 'a placeholder, never a fabricated number');
});

test('nextPhase: only max_budget carries advice — the rest have the runtime\'s own error', () => {
  assert.equal(nextPhase({ status: 'max_turns' } as never, 1, DEFAULT_RETRIES).lastError, null);
  assert.equal(nextPhase({ status: 'refused' } as never, 1, DEFAULT_RETRIES).lastError, null);
  assert.equal(nextPhase({ status: 'completed' } as never, 1, DEFAULT_RETRIES).lastError, null);
});

test('nextPhase: a refusal never retries — the same brief gets the same answer', () => {
  const d = nextPhase({ status: 'refused' } as never, 1, 5);
  assert.equal(d.phase, 'failed');
  assert.equal(d.resumable, false);
});

// The completion check, decided (ADR-016 §3). The runtime cannot report this outcome — as far as it
// is concerned the session completed — so the whole of it is here, and it is the branch that must
// outrank `completed` or the feature does nothing at all.
const RED = { command: 'npm test', exitCode: 1, stdout: '1 failing', stderr: '', ms: 900 };

test('nextPhase: a failed check outranks a COMPLETED run — that is what having no exit code means', () => {
  const d = nextPhase({ status: 'completed' } as never, 1, DEFAULT_RETRIES, DEFAULT_BUDGET, RED);
  assert.equal(d.outcome, 'check_failed', 'the session ended cleanly and the work still does not behave');
  assert.notEqual(d.phase, 'succeeded');
});

test('nextPhase: a failed check is TRANSIENT — it goes round again while retries remain', () => {
  assert.equal(nextPhase({ status: 'completed' } as never, 1, 2, 1, RED).phase, 'pending');
  assert.equal(nextPhase({ status: 'completed' } as never, 2, 2, 1, RED).phase, 'pending');
  assert.equal(nextPhase({ status: 'completed' } as never, 3, 2, 1, RED).phase, 'failed', 'out of retries');
  // `maxRetries: 0` is "one attempt, do not retry", and it must not be read as a truthy/falsy
  // question here any more than it is in `src/spec.ts`.
  assert.equal(nextPhase({ status: 'completed' } as never, 1, 0, 1, RED).phase, 'failed');
});

test('nextPhase: a failed check is always RESUMABLE, out of retries or not', () => {
  // The session that wrote the code the check refused is precisely the session worth continuing,
  // and `resumable` is what keeps `lastSessionId` for it — a cold retry would re-buy the work.
  for (const attempt of [1, 2, 3, 9]) {
    assert.equal(nextPhase({ status: 'completed' } as never, attempt, 2, 1, RED).resumable, true);
  }
});

test('nextPhase: a failed check carries its own line, because the runtime has no error to lend', () => {
  const retrying = nextPhase({ status: 'completed' } as never, 1, 2, 1, RED);
  assert.match(retrying.lastError ?? '', /`npm test`/, 'the command');
  assert.match(retrying.lastError ?? '', /exited 1/, 'and what it did');
  const done = nextPhase({ status: 'completed' } as never, 3, 2, 1, RED);
  assert.match(done.lastError ?? '', /No retries are left/, 'and what is left to do about it');
});

test('nextPhase: no check means the check decides nothing — every other outcome is unchanged', () => {
  // The shipped default reaches this function as `undefined`, and the test that matters is that the
  // parameter is inert then: adding a branch above `completed` is exactly how a feature nobody
  // enabled starts failing everybody's Jobs.
  for (const status of ['completed', 'max_turns', 'max_budget', 'timeout', 'refused', 'error']) {
    const without = nextPhase({ status } as never, 1, DEFAULT_RETRIES, DEFAULT_BUDGET);
    const withNull = nextPhase({ status } as never, 1, DEFAULT_RETRIES, DEFAULT_BUDGET, null);
    assert.deepEqual(withNull, without, status);
    assert.notEqual(without.outcome, 'check_failed');
  }
});

test('nextPhase: a runtime that threw is a crash, not a success', () => {
  assert.equal(nextPhase(null, 1, 2).outcome, 'crashed');
});

// ---------------------------------------------------------------- the loop

test('a pending job runs, succeeds, and records the session pointer', async () => {
  const job = await mkJob('happy');
  const r = await reconcile({ runtime: fakeRuntime(), cwd });
  assert.deepEqual(r.succeeded, [job.id]);

  const after = await db.job.findUniqueOrThrow({ where: { id: job.id }, include: { attempts: true } });
  assert.equal(after.phase, 'succeeded');
  assert.equal(after.attempts.length, 1);
  assert.ok(after.attempts[0].sessionId, 'the session id is the one SDK fact we keep');
  assert.equal(after.finishedAt !== null, true);
});

test('the lease is released when the attempt ends', async () => {
  const job = await mkJob('lease-released');
  await reconcile({ runtime: fakeRuntime(), cwd });
  assert.equal(await db.lease.findUnique({ where: { jobId: job.id } }), null);
});

test('a failing job retries up to maxRetries, then fails', async () => {
  const job = await mkJob('flaky', { maxRetries: 2 });
  await reconcileToRest({ runtime: fakeRuntime({ failTasks: [job.id] }), cwd });
  const after = await db.job.findUniqueOrThrow({ where: { id: job.id }, include: { attempts: true } });
  assert.equal(after.phase, 'failed');
  assert.equal(after.attempts.length, 3, '1 initial + 2 retries');
});

test('a Job that spends its whole budget stops after one attempt, and says what to change', async () => {
  const job = await mkJob('bigger-than-its-budget', { maxRetries: 2, maxBudgetUsd: 1 });
  await reconcileToRest({ runtime: fakeRuntime({ capTasks: [job.id] }), cwd });

  const after = await db.job.findUniqueOrThrow({ where: { id: job.id }, include: { attempts: true } });
  assert.equal(after.phase, 'failed');
  assert.equal(after.attempts.length, 1, 'two retries remained, and both would have made the same wall');
  assert.equal(after.attempts[0].outcome, 'max_budget');
  assert.ok(after.lastSessionId, 'the session survives, so `hkb retry --max-budget` resumes rather than restarts');
  assert.match(after.lastError ?? '', /\$1\.00/);
  assert.match(after.lastError ?? '', /hkb retry <id> --max-budget/, 'the row says what a human should do next');
});

test('known contention is refused by the gate before any claim is attempted', async () => {
  const job = await mkJob('contended');
  // somebody else got there first and still holds it; maxConcurrent is 1
  await db.lease.create({
    data: { jobId: job.id, holder: 'other-host', token: 't', expiresAt: new Date(Date.now() + 600_000) },
  });
  const r = await reconcile({ runtime: fakeRuntime(), cwd, board: 'test' });
  assert.match(r.refused ?? '', /concurrent slots/, 'the cheap check catches it first');
  assert.ok(!r.claimed.includes(job.id));
  assert.equal((await db.attempt.count({ where: { jobId: job.id } })), 0, 'and runs nothing');
  await db.lease.delete({ where: { jobId: job.id } });
});

test('a genuine race is lost at the compare-and-swap, not at the gate', async () => {
  // Room to spare, so the gate admits — and the lease insert is then the only thing standing
  // between two processes and a double run. This is the path the gate cannot cover: two hosts
  // that both read "one slot free" in the same instant.
  const board = await db.board.findFirstOrThrow({ where: { slug: 'test' } });
  await db.board.update({ where: { id: board.id }, data: { maxConcurrent: 5 } });
  const job = await mkJob('raced');
  await db.lease.create({
    data: { jobId: job.id, holder: 'won-the-race', token: 't', expiresAt: new Date(Date.now() + 600_000) },
  });

  const r = await reconcile({ runtime: fakeRuntime(), cwd, board: 'test' });
  assert.equal(r.refused, null, 'the gate had no objection');
  assert.ok(r.skipped.includes(job.id), 'the loser skips rather than throwing');
  assert.equal((await db.attempt.count({ where: { jobId: job.id } })), 0, 'and runs nothing');

  await db.lease.delete({ where: { jobId: job.id } });
  await db.board.update({ where: { id: board.id }, data: { maxConcurrent: 1 } });
});

test('an expired lease is reclaimed and its orphaned attempt is marked lost', async () => {
  const job = await mkJob('abandoned');
  await db.job.update({ where: { id: job.id }, data: { phase: 'running' } });
  await db.attempt.create({ data: { jobId: job.id, k: 1, host: 'dead-host', maxBudgetUsd: 1 } });
  await db.lease.create({
    data: { jobId: job.id, holder: 'dead-host', token: 't', expiresAt: new Date(Date.now() - 1000) },
  });

  const r = await reconcile({ runtime: fakeRuntime(), cwd });
  assert.ok(r.reclaimed.includes(job.id));
  const orphan = await db.attempt.findUniqueOrThrow({ where: { jobId_k: { jobId: job.id, k: 1 } } });
  assert.equal(orphan.outcome, 'lost', 'nobody ever reported it');
  assert.ok(orphan.endedAt);
});

test('reconcile is idempotent: a second pass on a settled board does nothing', async () => {
  await mkJob('settle-me');
  await reconcileToRest({ runtime: fakeRuntime(), cwd });
  const r = await reconcile({ runtime: fakeRuntime(), cwd });
  assert.deepEqual(r.claimed, []);
  assert.deepEqual(r.reclaimed, []);
});

// ---------------------------------------------------------------- admission
// The gate is a PreToolUse hook, not canUseTool: `bypassPermissions` and bare `allowedTools`
// entries both shadow canUseTool, and the SDK says so in a warning. Verified against the real
// SDK: a parent that omits isolation gets it injected.

const pre = (tool: string, input: Record<string, unknown>) =>
  ({ hook_event_name: 'PreToolUse', tool_name: tool, tool_input: input, tool_use_id: 't1' }) as never;
const spec = (r: Awaited<ReturnType<ReturnType<typeof admissionCallback>>>) =>
  (r as { hookSpecificOutput?: Record<string, unknown> }).hookSpecificOutput ?? {};

test('admission injects isolation onto an Agent spawn that omitted it', async () => {
  const gate = admissionCallback({});
  const o = spec(await gate(pre('Agent', { prompt: 'go', subagent_type: 'worker' })));
  assert.equal(o.permissionDecision, 'allow');
  assert.equal((o.updatedInput as Record<string, unknown>).isolation, 'worktree',
    'not asked for in a prompt — injected');
});

// The other half of the same rule, and the one that was wrong: a workload with no worktree of its
// own cannot give one to a subagent. Forcing isolation there sends the subagent's work to a
// checkout the parent never sees and the controller never merges, and it is silent about it.

test('a workload running in the operator\'s tree REFUSES to isolate a subagent', async () => {
  const gate = admissionCallback({ subagentIsolation: 'forbid' });
  const o = spec(await gate(pre('Agent', { prompt: 'go', isolation: 'worktree' })));
  assert.equal(o.permissionDecision, 'deny', 'a worktree here is work thrown away, not work done');
  const why = String(o.permissionDecisionReason);
  assert.match(why, /without `isolation`/, 'an error says what to do next');
  assert.match(why, /--no-isolate/, 'and what to change on the Job if the work really needs a branch');
});

test('and it does not inject one either — the subagent stays where the parent is', async () => {
  const gate = admissionCallback({ subagentIsolation: 'forbid' });
  const o = spec(await gate(pre('Agent', { prompt: 'go' })));
  assert.equal(o.permissionDecision, 'allow');
  assert.equal(o.updatedInput, undefined, 'no worktree to send it to, so nothing is injected');
});

test('admission leaves an already-isolated spawn alone', async () => {
  const gate = admissionCallback({});
  const o = spec(await gate(pre('Agent', { prompt: 'go', isolation: 'worktree' })));
  assert.equal(o.permissionDecision, 'allow');
  assert.equal(o.updatedInput, undefined, 'nothing to change');
});

test('a policy can refuse a spawn, and the model is told why', async () => {
  const gate = admissionCallback({
    admitSpawn: (input) => (String(input.description ?? '').includes('#2') ? '#2 is blocked by #1' : null),
  });
  const denied = spec(await gate(pre('Agent', { description: '#2 do the join' })));
  assert.equal(denied.permissionDecision, 'deny');
  assert.match(String(denied.permissionDecisionReason), /blocked by #1/);

  const allowed = spec(await gate(pre('Agent', { description: '#1 do the root' })));
  assert.equal(allowed.permissionDecision, 'allow');
});

test('the allowlist is enforced by the hook, not by the permission mode', async () => {
  // Measured: a nested session ran `Agent` under permissionMode dontAsk with Agent absent from
  // allowedTools. Hooks run first and are client-side, so this is the layer that actually holds.
  const gate = admissionCallback({ allow: ['Read', 'Bash'] });
  const denied = spec(await gate(pre('Agent', { prompt: 'fan out' })));
  assert.equal(denied.permissionDecision, 'deny');
  assert.match(String(denied.permissionDecisionReason), /tool surface/);
  assert.equal(spec(await gate(pre('Read', { file_path: 'x' }))).permissionDecision, 'allow');
});

test('no allowlist means the hook enforces none — the mode decides', async () => {
  const gate = admissionCallback({});
  assert.equal(spec(await gate(pre('Bash', { command: 'ls' }))).permissionDecision, 'allow');
});

test('admission denies a tool the workload may never use', async () => {
  const gate = admissionCallback({ deny: ['WebFetch'] });
  assert.equal(spec(await gate(pre('WebFetch', {}))).permissionDecision, 'deny');
  assert.equal(spec(await gate(pre('Read', {}))).permissionDecision, 'allow');
});

test('a non-PreToolUse event is not the gate\'s business', async () => {
  const gate = admissionCallback({ deny: ['Read'] });
  const r = await gate({ hook_event_name: 'PostToolUse', tool_name: 'Read' } as never);
  assert.deepEqual(r, {}, 'no opinion, rather than a wrong one');
});

// ---------------------------------------------------------------- the join
// A gate is only as good as what it is told. The policy was passed as a constant, so an
// un-isolated Job's subagents would have been forced into worktrees it does not have — unreachable
// only because `Agent` is off the tool surface, and reachable again the day anyone adds it.

test('the runtime is told whether this attempt has a worktree, per Job', async () => {
  const wired = await db.board.upsert({ where: { slug: 'wired' }, update: {}, create: { slug: 'wired' } });
  const seen: { isolated?: boolean; cwd: string }[] = [];
  const spy = {
    name: 'spy',
    async run(s: { cwd: string; isolated?: boolean }) {
      seen.push({ isolated: s.isolated, cwd: s.cwd });
      return { status: 'completed', ok: true, sessionId: 's', text: '', costUsd: 0, turns: 1,
               durationMs: 0, stopReason: 'end_turn', denials: 0, error: null };
    },
  } as never;
  const file = (name: string, extra: Record<string, unknown> = {}) =>
    db.job.create({ data: { boardId: wired.id, name, brief: `do ${name}`, ...extra } });

  await file('in-the-operators-tree', { isolate: false });
  await reconcile({ runtime: spy, cwd, board: 'wired', readPr: false });
  assert.equal(seen[0].isolated, false, 'no worktree — and the runtime must not pretend otherwise');
  assert.equal(seen[0].cwd, cwd, 'it really is the operator\'s checkout');

  await file('in-a-worktree');   // isolate defaults true
  await reconcile({ runtime: spy, cwd, board: 'wired', readPr: false });
  assert.equal(seen[1].isolated, true);
  assert.notEqual(seen[1].cwd, cwd, 'and this one really does have a checkout of its own');
});

// ---------------------------------------------------------------- declared outputs (ADR-008)
//
// A Job that produces an uncommitted file had no correct outcome: the artifact was deleted with
// the checkout, or it stranded one. The declaration is what lets the board move it out first.

/** A worker that writes exactly these files, wherever the controller put it, and then says it is done. */
const writes = (files: Record<string, string>) => ({
  name: 'writes',
  async run(s: { cwd: string }) {
    for (const [rel, body] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(s.cwd, rel)), { recursive: true });
      fs.writeFileSync(path.join(s.cwd, rel), body);
    }
    return { status: 'completed', ok: true, sessionId: 'sess', text: 'wrote what I was asked',
             costUsd: 0, turns: 1, durationMs: 0, stopReason: 'end_turn', denials: 0, error: null };
  },
} as never);

const checkoutOf = (jobId: number) => path.join(cwd, '.hkb', 'worktrees', `kb-${jobId}-1`);

test('a declared export lands in the board\'s repository, and the checkout goes with the litter', async () => {
  const job = await mkJob('produces-a-skill', { exports: ['.claude/skills/sdk-docs'] });
  const r = await reconcile({
    runtime: writes({
      '.claude/skills/sdk-docs/SKILL.md': '# sdk docs\n',
      'node_modules/dep/index.js': 'the 614 MB, gitignored and undeclared\n',
    }),
    cwd, readPr: false,
  });
  assert.deepEqual(r.succeeded, [job.id]);
  assert.equal(fs.readFileSync(path.join(cwd, '.claude', 'skills', 'sdk-docs', 'SKILL.md'), 'utf8'), '# sdk docs\n',
    'the artifact outlived the sandbox it was made in');

  const a = await db.attempt.findUniqueOrThrow({ where: { jobId_k: { jobId: job.id, k: 1 } } });
  assert.deepEqual(a.exported, ['.claude/skills/sdk-docs/SKILL.md'], 'and the attempt records what it handed over');
  assert.equal(fs.existsSync(checkoutOf(job.id)), false,
    'what was left was undeclared, which is litter by definition — no `hkb` verb needed to reclaim it');
  fs.rmSync(path.join(cwd, '.claude'), { recursive: true, force: true });
});

test('a declared export the worker did not produce FAILS the attempt', async () => {
  // Without this rule the declaration is a copy loop rather than a contract, and `succeeded` goes
  // back to meaning only that a session ended.
  const job = await mkJob('promises-more-than-it-writes', { exports: ['REPORT.md'], maxRetries: 2 });
  await reconcileToRest({ runtime: writes({ 'notes-to-self.md': 'not what was asked for\n' }), cwd, readPr: false });

  const after = await db.job.findUniqueOrThrow({ where: { id: job.id }, include: { attempts: true } });
  assert.equal(after.phase, 'failed', 'the session completed; the contract did not');
  assert.equal(after.attempts.length, 1, 'and it is not retried — the session\'s own account is that it finished');
  assert.equal(after.attempts[0].outcome, 'no_output', 'not a crash and not a refusal: it ran, and produced nothing declared');
  assert.match(after.attempts[0].reason ?? '', /REPORT\.md/, 'the attempt row names the path that is missing');
  assert.match(after.lastError ?? '', /REPORT\.md/);
  assert.match(after.lastError ?? '', /hkb retry/, 'and says what a human does next');
  assert.deepEqual(after.attempts[0].exported, [], 'it declared, and handed over nothing — which is not the same fact as null');
  assert.equal(fs.existsSync(path.join(cwd, 'notes-to-self.md')), false, 'and nothing undeclared was copied out');
  assert.equal(fs.existsSync(checkoutOf(job.id)), true,
    'the checkout stays, because what the run did instead is now the only copy of itself');
});

test('an export path that escapes the worktree is refused at the copy too, not only at `hkb new`', async () => {
  // `hkb new` validates the declaration, so reaching this needs a row written another way — which is
  // exactly why the check is here as well. The copy runs with the operator's authority.
  const job = await mkJob('escape-artist', { exports: ['../../etc/passwd'] });
  await reconcile({ runtime: writes({ 'harmless.txt': 'x\n' }), cwd, readPr: false });

  const a = await db.attempt.findUniqueOrThrow({ where: { jobId_k: { jobId: job.id, k: 1 } } });
  assert.equal(a.outcome, 'no_output');
  assert.match(a.reason ?? '', /escapes the worktree/);
  assert.equal((await db.job.findUniqueOrThrow({ where: { id: job.id } })).phase, 'failed');
});

// ---------------------------------------------------------------- board spec defaults
//
// Three levels answer five questions (`src/spec.ts`), and the precedence table is unit-tested in
// `test/spec.test.ts`. What is worth an integration test is the two places the resolved value has
// to arrive: the runtime, and the admission gate — which used to read the raw column and would now
// read null for every Job that inherits its cap.

/** A runtime that records the spec it was handed, and completes for free. */
function specSpy() {
  const seen: Record<string, unknown>[] = [];
  const runtime = {
    name: 'spec-spy',
    async run(s: Record<string, unknown>) {
      seen.push({ ...s });
      return { status: 'completed', ok: true, sessionId: 's', text: '', costUsd: 0, turns: 1,
               durationMs: 0, stopReason: 'end_turn', denials: 0, error: null };
    },
  } as never;
  return { seen, runtime };
}

test('a board default reaches the runtime, and a Job that spoke for itself outranks it', async () => {
  const b = await db.board.upsert({
    where: { slug: 'cheap' },
    update: { defaultModel: 'claude-haiku-4-5', defaultMaxTurns: 6, defaultMaxRetries: 0 },
    create: { slug: 'cheap', defaultModel: 'claude-haiku-4-5', defaultMaxTurns: 6, defaultMaxRetries: 0 },
  });
  const file = (name: string, extra: Record<string, unknown> = {}) =>
    db.job.create({ data: { boardId: b.id, name, brief: `do ${name}`, isolate: false, ...extra } });
  const { seen, runtime } = specSpy();

  await file('says-nothing');
  await reconcile({ runtime, cwd, board: 'cheap', readPr: false });
  assert.equal(seen[0].model, 'claude-haiku-4-5', 'the board answered a question the Job did not');
  assert.equal(seen[0].maxTurns, 6);

  await file('says-so-itself', { model: 'claude-opus-4-6', maxTurns: 40 });
  await reconcile({ runtime, cwd, board: 'cheap', readPr: false });
  assert.equal(seen[1].model, 'claude-opus-4-6', 'and it must not override one the Job asked for');
  assert.equal(seen[1].maxTurns, 40);
});

test('the budget gate judges a Job against the cap it would really run under', async () => {
  // The regression this whole card had to design around: `maxBudgetUsd` is null on the Job, so a
  // gate reading the column would compare `null` with the ceiling and wave the Job through.
  const b = await db.board.upsert({
    where: { slug: 'inherited-cap' },
    update: { defaultMaxBudgetUsd: 9, dailyBudgetUsd: 5 },
    create: { slug: 'inherited-cap', defaultMaxBudgetUsd: 9, dailyBudgetUsd: 5 },
  });
  const job = await db.job.create({
    data: { boardId: b.id, name: 'expensive-by-inheritance', brief: 'do it', isolate: false },
  });
  assert.equal(job.maxBudgetUsd, null, 'the Job itself says nothing about money');

  const { seen, runtime } = specSpy();
  const r = await reconcile({ runtime, cwd, board: 'inherited-cap', readPr: false });
  assert.equal(seen.length, 0, 'nothing ran');
  assert.match(r.refused ?? '', /may cost \$9\.00/, 'the refusal names the inherited cap, not $0.00');
  assert.match(r.refused ?? '', /\$5\.00 ceiling/);
});

test('the cap is FROZEN onto the attempt, so a board edited mid-flight cannot rewrite it', async () => {
  // The reason the gate reads `Attempt.maxBudgetUsd` rather than re-resolving the Job's spec. A
  // live run is bound by the number it was spawned with; lowering the board's default afterwards
  // must not tell the gate that run is now cheap, because that admits work the board cannot afford.
  const b = await db.board.upsert({
    where: { slug: 'frozen' },
    update: { defaultMaxBudgetUsd: 3, dailyBudgetUsd: null, maxConcurrent: 5 },
    create: { slug: 'frozen', defaultMaxBudgetUsd: 3, dailyBudgetUsd: null, maxConcurrent: 5 },
  });
  const job = await db.job.create({
    data: { boardId: b.id, name: 'claimed-at-three', brief: 'do it', isolate: false },
  });
  const { runtime } = specSpy();
  await reconcile({ runtime, cwd, board: 'frozen', readPr: false });

  const a = await db.attempt.findUniqueOrThrow({ where: { jobId_k: { jobId: job.id, k: 1 } } });
  assert.equal(a.maxBudgetUsd, 3, 'the attempt records the cap it was claimed under');

  // The operator changes their mind. The attempt keeps the promise that was made for it.
  await db.board.update({ where: { id: b.id }, data: { defaultMaxBudgetUsd: 0.1 } });
  const still = await db.attempt.findUniqueOrThrow({ where: { jobId_k: { jobId: job.id, k: 1 } } });
  assert.equal(still.maxBudgetUsd, 3, 'and re-resolving the spec today would have said $0.10');
});

test('an open attempt is charged its own frozen cap, not the board\'s current default', async () => {
  const b = await db.board.upsert({
    where: { slug: 'committed' },
    update: { defaultMaxBudgetUsd: 0.1, dailyBudgetUsd: 8, maxConcurrent: 5 },
    create: { slug: 'committed', defaultMaxBudgetUsd: 0.1, dailyBudgetUsd: 8, maxConcurrent: 5 },
  });
  // Somebody else's run, claimed while the board's default was $7. It is still going.
  const theirs = await db.job.create({ data: { boardId: b.id, name: 'theirs', brief: 'x', phase: 'running' } });
  await db.attempt.create({ data: { jobId: theirs.id, k: 1, host: 'another-host', maxBudgetUsd: 7 } });

  const { seen, runtime } = specSpy();
  await db.job.create({ data: { boardId: b.id, name: 'mine', brief: 'x', isolate: false, maxBudgetUsd: 2 } });
  const r = await reconcile({ runtime, cwd, board: 'committed', readPr: false });

  assert.equal(seen.length, 0, 'refused: $7 in flight plus $2 is over the $8 ceiling');
  assert.match(r.refused ?? '', /\$7\.00 committed to runs in flight/,
    'the promise made at claim, not the $0.10 the board would resolve to now');
});

test('a board\'s maxRetries default is the retry budget actually spent', async () => {
  const b = await db.board.upsert({
    where: { slug: 'one-shot' },
    update: { defaultMaxRetries: 0 },
    create: { slug: 'one-shot', defaultMaxRetries: 0 },
  });
  const job = await db.job.create({
    data: { boardId: b.id, name: 'crashes', brief: 'x', isolate: false },
  });
  const crashing = {
    name: 'crashing',
    async run() { return { status: 'error', ok: false, sessionId: null, text: '', costUsd: 0, turns: 0,
                           durationMs: 0, stopReason: 'error', denials: 0, error: 'boom' }; },
  } as never;
  await reconcileToRest({ runtime: crashing, cwd, board: 'one-shot', readPr: false });

  const after = await db.job.findUniqueOrThrow({ where: { id: job.id }, include: { attempts: true } });
  assert.equal(after.attempts.length, 1, 'one attempt — the board said no retries, and it was heard');
  assert.equal(after.phase, 'failed');
});

/**
 * Plugin grants, from the spec to the runtime (ADR-012).
 *
 * The unit tests in `test/plugins.test.ts` cover the two fences. What matters here is that a grant
 * is resolved against the BOARD'S REPOSITORY rather than the worktree, because that is the whole
 * security property: a worker writes in its worktree, so a grant resolved there would let a Job
 * write a hook its own next attempt executes.
 */
test('a granted directory reaches the runtime absolute, resolved against the repository', async () => {
  const b = await db.board.upsert({
    where: { slug: 'granted' },
    update: { repoPath: REPO },
    create: { slug: 'granted', repoPath: REPO },
  });
  const seen: (string[] | undefined)[] = [];
  const spy = {
    name: 'spy',
    async run(s: { plugins?: string[] }) {
      seen.push(s.plugins);
      return { status: 'completed', ok: true, sessionId: 's', text: '', costUsd: 0, turns: 1,
               durationMs: 0, stopReason: 'end_turn', denials: 0, error: null };
    },
  } as never;

  fs.mkdirSync(path.join(REPO, '.claude', 'skills'), { recursive: true });
  await db.job.create({
    data: { boardId: b.id, name: 'knows prisma', brief: 'x', isolate: false, pluginPaths: ['.claude'] },
  });
  await reconcile({ runtime: spy, cwd: REPO, board: 'granted', readPr: false });

  assert.deepEqual(seen[0], [path.join(fs.realpathSync(REPO), '.claude')],
    'absolute, and under the repository — the runtime gets a path, never a policy');
});

test('a Job with no grant hands the runtime nothing, and a grant that has gone does not strand it', async () => {
  const b = await db.board.findUniqueOrThrow({ where: { slug: 'granted' } });
  const seen: (string[] | undefined)[] = [];
  const spy = {
    name: 'spy',
    async run(s: { plugins?: string[] }) {
      seen.push(s.plugins);
      return { status: 'completed', ok: true, sessionId: 's', text: '', costUsd: 0, turns: 1,
               durationMs: 0, stopReason: 'end_turn', denials: 0, error: null };
    },
  } as never;

  await db.job.create({ data: { boardId: b.id, name: 'ungranted', brief: 'x', isolate: false } });
  await reconcile({ runtime: spy, cwd: REPO, board: 'granted', readPr: false });
  assert.equal(seen[0], undefined, 'nothing granted, so the option is absent rather than empty');

  // The refusal that must NOT be fatal: a board outlives the directories it names.
  const job = await db.job.create({
    data: { boardId: b.id, name: 'stale grant', brief: 'x', isolate: false, pluginPaths: ['no-such-dir'] },
  });
  await reconcile({ runtime: spy, cwd: REPO, board: 'granted', readPr: false });
  assert.equal(seen[1], undefined, 'a grant that has gone grants nothing');
  const after = await db.job.findUniqueOrThrow({ where: { id: job.id } });
  assert.equal(after.phase, 'succeeded', 'and the Job still ran — a missing skill directory is not a failed attempt');
});

/**
 * The tool surface, from the spec to the refusal.
 *
 * `WorkerSpec.allowedTools` existed and was honoured by the runtime for as long as nothing set it,
 * so every Job on every board ran the same nine tools — `Write`, `Edit` and `Bash` unconditional.
 * That is why ADR-010's motivating case (*propose the migration, let me look, then run it*) could
 * not be enforced: the propose half could simply apply.
 *
 * Tested end to end rather than in halves, because the halves have each passed on their own for
 * weeks. The gate is built FROM the resolved surface (`src/runtime/claude.ts`), so the thing worth
 * asserting is that a narrowed Job produces a gate that DENIES — not that a column round-trips.
 */
test('a narrowed Job reaches the runtime narrowed, and the gate built from it refuses', async () => {
  const b = await db.board.upsert({ where: { slug: 'narrow' }, update: {}, create: { slug: 'narrow' } });
  const seen: (string[] | undefined)[] = [];
  const spy = {
    name: 'spy',
    async run(s: { allowedTools?: string[] }) {
      seen.push(s.allowedTools);
      return { status: 'completed', ok: true, sessionId: 's', text: '', costUsd: 0, turns: 1,
               durationMs: 0, stopReason: 'end_turn', denials: 0, error: null };
    },
  } as never;

  await db.job.create({
    data: { boardId: b.id, name: 'read only', brief: 'look, do not touch', isolate: false,
            allowedTools: ['Read', 'Grep'] },
  });
  await reconcile({ runtime: spy, cwd: REPO, board: 'narrow' });

  assert.deepEqual(seen[0], ['Read', 'Grep'], 'the resolved surface reaches the runtime');

  // The half that matters: the gate the runtime builds from exactly that list.
  const gate = admissionCallback({ allow: seen[0] });
  assert.equal(spec(await gate(pre('Bash', { command: 'rm -rf /' }))).permissionDecision, 'deny',
    'a Job that may not write must be DENIED the tool that writes — this is the whole feature');
  assert.equal(spec(await gate(pre('Write', { file_path: 'x' }))).permissionDecision, 'deny');
  assert.equal(spec(await gate(pre('Read', { file_path: 'x' }))).permissionDecision, 'allow',
    'and what it WAS granted still works, or the narrowing is just breakage');
});

test('a Job that named no surface gets the runtime default, which is not the same as none', async () => {
  const b = await db.board.upsert({ where: { slug: 'wide' }, update: {}, create: { slug: 'wide' } });
  const seen: (string[] | undefined)[] = [];
  const spy = {
    name: 'spy',
    async run(s: { allowedTools?: string[] }) {
      seen.push(s.allowedTools);
      return { status: 'completed', ok: true, sessionId: 's', text: '', costUsd: 0, turns: 1,
               durationMs: 0, stopReason: 'end_turn', denials: 0, error: null };
    },
  } as never;
  await db.job.create({ data: { boardId: b.id, name: 'ordinary', brief: 'x', isolate: false } });
  await reconcile({ runtime: spy, cwd: REPO, board: 'wide' });
  assert.equal(seen[0], undefined,
    'undefined, not [] — an absent surface means the runtime decides, and [] would mean no tools at all');
});

test('an EMPTY surface is a value: the Job may call nothing, and the gate says so', async () => {
  // The distinction `pick()` protects. `allowedTools: []` is reachable and it means what it says;
  // if it were read as "unset", a Job deliberately given no tools would silently get all nine.
  const b = await db.board.upsert({ where: { slug: 'nothing' }, update: {}, create: { slug: 'nothing' } });
  const seen: (string[] | undefined)[] = [];
  const spy = {
    name: 'spy',
    async run(s: { allowedTools?: string[] }) {
      seen.push(s.allowedTools);
      return { status: 'completed', ok: true, sessionId: 's', text: '', costUsd: 0, turns: 1,
               durationMs: 0, stopReason: 'end_turn', denials: 0, error: null };
    },
  } as never;
  await db.job.create({
    data: { boardId: b.id, name: 'inert', brief: 'x', isolate: false, allowedTools: [] },
  });
  await reconcile({ runtime: spy, cwd: REPO, board: 'nothing' });
  assert.deepEqual(seen[0], [], 'an empty list survives resolution as an empty list');
  const gate = admissionCallback({ allow: [] });
  assert.equal(spec(await gate(pre('Read', {}))).permissionDecision, 'deny', 'and it denies everything');
});

test('a board default narrows every Job that named no surface of its own', async () => {
  const b = await db.board.upsert({
    where: { slug: 'narrow-board' },
    update: { defaultAllowedTools: ['Read'] },
    create: { slug: 'narrow-board', defaultAllowedTools: ['Read'] },
  });
  const seen: (string[] | undefined)[] = [];
  const spy = {
    name: 'spy',
    async run(s: { allowedTools?: string[] }) {
      seen.push(s.allowedTools);
      return { status: 'completed', ok: true, sessionId: 's', text: '', costUsd: 0, turns: 1,
               durationMs: 0, stopReason: 'end_turn', denials: 0, error: null };
    },
  } as never;
  await db.job.create({ data: { boardId: b.id, name: 'inherits', brief: 'x', isolate: false } });
  // A default is not a ceiling: a Job may name a WIDER list and get it. That is the line between
  // `src/spec.ts` and `src/limits.ts`, and it is the one this could most easily get wrong.
  await db.job.create({
    data: { boardId: b.id, name: 'overrides', brief: 'x', isolate: false, allowedTools: ['Read', 'Bash'] },
  });
  await reconcile({ runtime: spy, cwd: REPO, board: 'narrow-board' });
  await reconcile({ runtime: spy, cwd: REPO, board: 'narrow-board' });
  assert.deepEqual(seen[0], ['Read'], 'the board answered for the Job that said nothing');
  assert.deepEqual(seen[1], ['Read', 'Bash'], 'and the Job that spoke was not overridden by it');
});

test('the allowlist branch of the gate refuses, which nothing tested before', () => {
  // `deny` had a test; `allow` did not, though it is the branch every narrowed Job goes through.
  const gate = admissionCallback({ allow: ['Read', 'Grep'] });
  return Promise.all([
    gate(pre('Bash', {})).then((r) => assert.equal(spec(r).permissionDecision, 'deny')),
    gate(pre('Read', {})).then((r) => assert.equal(spec(r).permissionDecision, 'allow')),
  ]);
});

/**
 * What the run did, for the Job whose value is not a diff.
 *
 * `turns` and `denials` are returned by every runtime driver and were being dropped, so a Job that
 * opened no pull request had nothing to show for itself at all — `producedNothing` could say only
 * that it produced nothing, which reads as failure and is often not. The distinction these two
 * columns buy is between an investigation that concluded there was nothing to change and a session
 * that stalled, and nothing else in the record can tell those apart.
 *
 * Written as a refusal at the other end too: an attempt that never reached the runtime must record
 * **null**, not zero. `0 turns` is a claim about a run that happened and did nothing; no measurement
 * is the truth about a run that never started.
 *
 * On its own board, and `isolate: false`, for the same reason the frozen-cap tests above are: by
 * this point in the file the shared board carries whatever earlier tests left on it, and a claim
 * refused by an inherited ceiling writes no attempt to assert on.
 */
const measuring = (turns: number, denials: number): Runtime => ({
  name: 'measuring',
  async run() {
    return {
      status: 'completed', ok: true, sessionId: 'sess-measured', text: 'done',
      costUsd: 0.25, turns, durationMs: 1000, stopReason: 'end_turn', denials, error: null,
    };
  },
});

async function measuredBoard(name: string) {
  const b = await db.board.upsert({
    where: { slug: 'measured' },
    update: { dailyBudgetUsd: null, maxConcurrent: 5, pausedAt: null },
    create: { slug: 'measured', dailyBudgetUsd: null, maxConcurrent: 5 },
  });
  return db.job.create({ data: { boardId: b.id, name, brief: `do ${name}`, isolate: false } });
}

const attemptOf = (jobId: number) =>
  db.attempt.findUniqueOrThrow({ where: { jobId_k: { jobId, k: 1 } } });

test('the runtime\'s measurement of the work reaches the attempt row', async () => {
  const job = await measuredBoard('measured-run');
  await reconcile({ runtime: measuring(18, 3), cwd, board: 'measured', readPr: false });

  const a = await attemptOf(job.id);
  assert.equal(a.turns, 18, 'the runtime counted the turns and the board kept them');
  assert.equal(a.denials, 3, 'and how often the gate refused it a tool');
  assert.equal(a.costUsd, 0.25, 'beside the cost, which was already kept');
});

test('an attempt that never reached the runtime records no measurement, not a zero', async () => {
  const job = await measuredBoard('never-ran');
  const throwing: Runtime = {
    name: 'throwing',
    async run(): Promise<never> { throw new Error('the runtime never started'); },
  };
  await reconcile({ runtime: throwing, cwd, board: 'measured', readPr: false });

  const a = await attemptOf(job.id);
  assert.equal(a.turns, null, 'null, not 0 — there is no measurement of a run that did not happen');
  assert.equal(a.denials, null);
  assert.equal(a.costUsd, null, 'the rule the cost column already followed');
});

test('zero turns is recorded as zero, so null keeps meaning "not measured"', async () => {
  // The pair that makes the distinction above load-bearing rather than decorative: a runtime that
  // genuinely reported 0 must not be stored the same way as one that reported nothing.
  const job = await measuredBoard('zero-turns');
  await reconcile({ runtime: measuring(0, 0), cwd, board: 'measured', readPr: false });

  const a = await attemptOf(job.id);
  assert.equal(a.turns, 0, 'a measured zero survives as a zero');
  assert.equal(a.denials, 0);
});

/**
 * `results` end to end: the value a Job produces when it is not coupled to a commit.
 *
 * The unit tests in `test/results.test.ts` cover the contract; these two cover the wiring, and both
 * are refusals. A Job that declared a value and did not write it must FAIL — that rule is the whole
 * reason the declaration is worth making, and without it `succeeded` still means only that a session
 * ended.
 */
const writing = (values: Record<string, string>): Runtime => ({
  name: 'writing',
  async run(spec) {
    // The worker's side of the contract: write each declared value to the path it was given. The
    // paths are in the prompt, which is how a real worker learns them too.
    for (const [name, body] of Object.entries(values)) {
      const m = spec.prompt.match(new RegExp(`\`${name}\` → \`([^\`]+)\``));
      if (m) fs.writeFileSync(m[1], body);
    }
    return {
      status: 'completed', ok: true, sessionId: 'sess-r', text: 'done',
      costUsd: 0.1, turns: 2, durationMs: 10, stopReason: 'end_turn', denials: 0, error: null,
    };
  },
});

test('a declared result the run wrote is kept on the attempt', async () => {
  const b = await db.board.upsert({
    where: { slug: 'results' },
    update: { dailyBudgetUsd: null, maxConcurrent: 5, pausedAt: null },
    create: { slug: 'results', dailyBudgetUsd: null, maxConcurrent: 5 },
  });
  const job = await db.job.create({
    data: {
      boardId: b.id, name: 'reports', brief: 'look into it', isolate: false,
      results: ['finding'], maxBudgetUsd: 1,
    },
  });
  await reconcile({ runtime: writing({ finding: 'nothing to change here\n' }), cwd, board: 'results', readPr: false });

  const after = await db.job.findUniqueOrThrow({ where: { id: job.id }, include: { attempts: true } });
  assert.equal(after.phase, 'succeeded');
  assert.deepEqual(after.attempts[0].results, { finding: 'nothing to change here' },
    'the value the run reported, trimmed, on the row — no commit, and still an output');
});

test('a declared result the run did NOT write fails the attempt', async () => {
  const b = await db.board.findUniqueOrThrow({ where: { slug: 'results' } });
  const job = await db.job.create({
    data: {
      boardId: b.id, name: 'forgets', brief: 'look into it', isolate: false,
      results: ['finding'], maxBudgetUsd: 1, maxRetries: 0,
    },
  });
  // A runtime that succeeds and writes nothing — the exact shape ADR-008 exists to catch, because
  // the session's own account is that it finished.
  await reconcile({ runtime: writing({}), cwd, board: 'results', readPr: false });

  const after = await db.job.findUniqueOrThrow({ where: { id: job.id }, include: { attempts: true } });
  assert.equal(after.attempts[0].outcome, 'no_output', 'the runtime said completed; the board disagreed');
  assert.equal(after.phase, 'failed');
  assert.match(after.lastError ?? '', /`finding`/, 'and it names what is missing');
});

/**
 * `inputs` end to end: the read side, resolved before anything is spent.
 *
 * `test/inputs.test.ts` covers the contract. The two here are the wiring, and the second is the one
 * that pays for the feature — a declaration the board cannot satisfy must stop the attempt BEFORE
 * the runtime is called, because finding out afterwards costs a session.
 */
test('a declared input is read from the repository and reaches the prompt before the brief', async () => {
  const b = await db.board.upsert({
    where: { slug: 'inputs' },
    update: { repoPath: REPO, dailyBudgetUsd: null, maxConcurrent: 5, pausedAt: null },
    create: { slug: 'inputs', repoPath: REPO, dailyBudgetUsd: null, maxConcurrent: 5 },
  });
  const seen: string[] = [];
  const spy = {
    name: 'spy',
    async run(spec: { prompt: string }) {
      seen.push(spec.prompt);
      return { status: 'completed', ok: true, sessionId: 's', text: '', costUsd: 0, turns: 1,
               durationMs: 0, stopReason: 'end_turn', denials: 0, error: null };
    },
  } as never;

  const job = await db.job.create({
    data: {
      boardId: b.id, name: 'reads the licence', brief: 'Summarise it.', isolate: false,
      inputs: [{ name: 'licence', valueFrom: { file: { path: 'LICENSE' } } }],
    },
  });
  await reconcile({ runtime: spy, cwd: REPO, board: 'inputs', readPr: false });

  const after = await db.job.findUniqueOrThrow({ where: { id: job.id }, include: { attempts: true } });
  assert.equal(after.phase, 'succeeded');
  assert.match(seen[0], /### `licence`  \(file:LICENSE\)/, 'the input is labelled by name and source');
  assert.ok(seen[0].indexOf('MIT') < seen[0].indexOf('Summarise it.'),
    'and it arrives BEFORE the brief that is about it');

  const fed = after.attempts[0].inputs as { name: string; source: string; bytes: number }[];
  assert.equal(fed.length, 1);
  assert.equal(fed[0].name, 'licence');
  assert.ok(fed[0].bytes > 0, 'the catalogue records what the run was fed, never the content');
});

test('a declared input the board cannot read fails the attempt WITHOUT calling the runtime', async () => {
  const b = await db.board.findUniqueOrThrow({ where: { slug: 'inputs' } });
  let called = 0;
  const spy = {
    name: 'spy',
    async run() {
      called += 1;
      return { status: 'completed', ok: true, sessionId: 's', text: '', costUsd: 0, turns: 1,
               durationMs: 0, stopReason: 'end_turn', denials: 0, error: null };
    },
  } as never;

  const job = await db.job.create({
    data: {
      boardId: b.id, name: 'reads a ghost', brief: 'x', isolate: false, maxRetries: 0,
      inputs: [{ name: 'gone', valueFrom: { file: { path: 'no-such-file.md' } } }],
    },
  });
  await reconcile({ runtime: spy, cwd: REPO, board: 'inputs', readPr: false });

  assert.equal(called, 0, 'the whole point: an unreadable input costs no session');
  const after = await db.job.findUniqueOrThrow({ where: { id: job.id }, include: { attempts: true } });
  assert.equal(after.attempts[0].outcome, 'no_input');
  assert.equal(after.phase, 'failed', 'terminal — the same read fails identically next time');
  assert.match(after.lastError ?? '', /`gone`/, 'and it names which input');
});

test('a value input the brief did not consume still reaches the run, as data', async () => {
  const b = await db.board.findUniqueOrThrow({ where: { slug: 'inputs' } });
  const seen: string[] = [];
  const spy = {
    name: 'spy',
    async run(spec: { prompt: string }) {
      seen.push(spec.prompt);
      return { status: 'completed', ok: true, sessionId: 's', text: '', costUsd: 0, turns: 1,
               durationMs: 0, stopReason: 'end_turn', denials: 0, error: null };
    },
  } as never;

  // `hkb new` drops a value it interpolated, so anything still on the Job was never consumed and
  // has to arrive as a block — otherwise a caller's payload would silently vanish.
  const job = await db.job.create({
    data: {
      boardId: b.id, name: 'given a payload', brief: 'Handle it.', isolate: false,
      inputs: [{ name: 'pr', value: '{"number":42}' }],
    },
  });
  await reconcile({ runtime: spy, cwd: REPO, board: 'inputs', readPr: false });

  const after = await db.job.findUniqueOrThrow({ where: { id: job.id }, include: { attempts: true } });
  assert.equal(after.phase, 'succeeded', 'a literal cannot fail to resolve — there is nothing to fetch');
  assert.match(seen[0], /### `pr`  \(value\)/, 'labelled by name, and by the source it came from');
  assert.match(seen[0], /\{"number":42\}/);
  const fed = after.attempts[0].inputs as { name: string; source: string }[];
  assert.deepEqual(fed.map((i) => i.source), ['value'], 'the catalogue records it too');
});

/**
 * The downward API (`self:`) and the slot that earns it.
 *
 * The motivating case is concrete: an end-to-end suite running inside a worker needs a port, and
 * concurrent workers on one machine need DIFFERENT ports. `id` is unique but unbounded; nothing
 * else answered "which of the concurrent workers am I". Kubernetes gives every Pod its own IP and
 * the question never arises — hkb's workers share a machine, so the StatefulSet ordinal is the
 * shape that fits.
 */
test('self: hands a Job facts about itself, and slot is a small integer it can build a port from', async () => {
  const b = await db.board.findUniqueOrThrow({ where: { slug: 'inputs' } });
  const seen: string[] = [];
  const spy = {
    name: 'spy',
    async run(spec: { prompt: string }) {
      seen.push(spec.prompt);
      return { status: 'completed', ok: true, sessionId: 's', text: '', costUsd: 0, turns: 1,
               durationMs: 0, stopReason: 'end_turn', denials: 0, error: null };
    },
  } as never;

  const job = await db.job.create({
    data: {
      boardId: b.id, name: 'runs e2e', brief: 'Serve on the port.', isolate: false,
      inputs: [
        { name: 'slot', valueFrom: { jobRef: { field: 'slot' } } },
        { name: 'k', valueFrom: { jobRef: { field: 'attempt' } } },
        { name: 'who', valueFrom: { jobRef: { field: 'name' } } },
        { name: 'board', valueFrom: { jobRef: { field: 'board' } } },
      ],
    },
  });
  await reconcile({ runtime: spy, cwd: REPO, board: 'inputs', readPr: false });

  const after = await db.job.findUniqueOrThrow({ where: { id: job.id }, include: { attempts: true } });
  assert.equal(after.phase, 'succeeded');
  assert.match(seen[0], /### `slot`  \(self:slot\)/);
  assert.match(seen[0], /### `k`  \(self:attempt\)/);
  assert.match(seen[0], /runs e2e/, 'its own name');
  assert.match(seen[0], /inputs/, 'and the board it is on');
  assert.equal(after.attempts[0].slot, 0,
    'frozen onto the attempt, so a past run can still say which slot it held');
});

test('a self: field this Job does not have is REFUSED, not rendered empty', async () => {
  const b = await db.board.findUniqueOrThrow({ where: { slug: 'inputs' } });
  let called = 0;
  const spy = {
    name: 'spy',
    async run() {
      called += 1;
      return { status: 'completed', ok: true, sessionId: 's', text: '', costUsd: 0, turns: 1,
               durationMs: 0, stopReason: 'end_turn', denials: 0, error: null };
    },
  } as never;

  // `--no-isolate`, so there is no branch. Rendering an empty string would put a Job in the position
  // of acting on a fact that is not true, which is the failure every other declaration refuses.
  const job = await db.job.create({
    data: {
      boardId: b.id, name: 'no branch here', brief: 'x', isolate: false, maxRetries: 0,
      inputs: [{ name: 'branch', valueFrom: { jobRef: { field: 'branch' } } }],
    },
  });
  await reconcile({ runtime: spy, cwd: REPO, board: 'inputs', readPr: false });

  assert.equal(called, 0);
  const after = await db.job.findUniqueOrThrow({ where: { id: job.id }, include: { attempts: true } });
  assert.equal(after.attempts[0].outcome, 'no_input');
  assert.match(after.lastError ?? '', /running without a worktree/, 'and it says why, not just that');
});

test('concurrent runs get DIFFERENT slots, and a slot is released with its lease', async () => {
  const b = await db.board.upsert({
    where: { slug: 'slots' },
    update: { repoPath: REPO, maxConcurrent: 3, dailyBudgetUsd: null, pausedAt: null },
    create: { slug: 'slots', repoPath: REPO, maxConcurrent: 3, dailyBudgetUsd: null },
  });
  // A barrier, and it is the test rather than an implementation detail: a slot is held only while a
  // run is LIVE, so with an instant runtime the first lease is released before the second claim even
  // reads. That is correct behaviour and it is also not the thing under test. Three runs that
  // genuinely overlap is.
  let started = 0;
  let release!: () => void;
  // Timed out rather than open-ended. If the allocator stops handing out distinct slots, the unique
  // constraint refuses the second claim and only one run ever starts — an open barrier would then
  // hang the suite instead of failing it, and a test that deadlocks on a regression reports nothing.
  const allThree = Promise.race([
    new Promise<void>((r) => { release = r; }),
    new Promise<void>((r) => setTimeout(r, 3_000).unref()),
  ]);
  const spy = {
    name: 'spy',
    async run() {
      if (++started === 3) release();
      await allThree;
      return { status: 'completed', ok: true, sessionId: 's', text: '', costUsd: 0, turns: 1,
               durationMs: 0, stopReason: 'end_turn', denials: 0, error: null };
    },
  } as never;

  const ids: number[] = [];
  for (const n of [1, 2, 3]) {
    const j = await db.job.create({ data: { boardId: b.id, name: `concurrent ${n}`, brief: 'x', isolate: false } });
    ids.push(j.id);
  }
  await reconcile({ runtime: spy, cwd: REPO, board: 'slots', readPr: false });

  const got = await db.attempt.findMany({ where: { jobId: { in: ids } }, select: { slot: true } });
  const slots = got.map((a) => a.slot);
  assert.equal(slots.length, 3);
  assert.equal(new Set(slots).size, 3, 'three runs at once, three different slots — the whole point');
  assert.deepEqual([...slots].sort(), [0, 1, 2], 'and they are small and dense, so a port base + slot works');

  // Released with the lease, or the second batch on this board would start at slot 3 and climb.
  assert.equal(await db.lease.count({ where: { job: { boardId: b.id } } }), 0);
  const j4 = await db.job.create({ data: { boardId: b.id, name: 'later', brief: 'x', isolate: false } });
  const quick = {
    name: 'quick',
    async run() {
      return { status: 'completed', ok: true, sessionId: 's', text: '', costUsd: 0, turns: 1,
               durationMs: 0, stopReason: 'end_turn', denials: 0, error: null };
    },
  } as never;
  await reconcile({ runtime: quick, cwd: REPO, board: 'slots', readPr: false });
  const a4 = await db.attempt.findFirstOrThrow({ where: { jobId: j4.id } });
  assert.equal(a4.slot, 0, 'a freed slot is reused — otherwise the number is just `id` with extra steps');
});

test('the board input is the arithmetic hkb already computes, and never includes the reading Job', async () => {
  const b = await db.board.findUniqueOrThrow({ where: { slug: 'inputs' } });
  const seen: string[] = [];
  const spy = {
    name: 'spy',
    async run(spec: { prompt: string }) {
      seen.push(spec.prompt);
      return { status: 'completed', ok: true, sessionId: 's', text: '', costUsd: 0, turns: 1,
               durationMs: 0, stopReason: 'end_turn', denials: 0, error: null };
    },
  } as never;

  const job = await db.job.create({
    data: {
      boardId: b.id, name: 'grooms', brief: 'Look at the board.', isolate: false,
      inputs: [{ name: 'board', valueFrom: { board: {} } }],
    },
  });
  await reconcile({ runtime: spy, cwd: REPO, board: 'inputs', readPr: false });

  assert.match(seen[0], /### `board`  \(board\)/);
  assert.match(seen[0], /#\d+\s+failed\s+.*reads a ghost/, 'the other Jobs on this board are there');
  assert.doesNotMatch(seen[0], /grooms/,
    'and the reading Job is not — a Job reasoning about the board should not find itself listed as running');
  const after = await db.job.findUniqueOrThrow({ where: { id: job.id } });
  assert.equal(after.phase, 'succeeded');
});

/**
 * `artifacts` end to end (ADR-011): the output that is too big to be a result and must not be
 * committed. `test/artifacts.test.ts` covers the contract; these two cover the wiring, and the
 * second is the refusal — same rule as `exports` and `results`, third medium.
 */
test('a declared artifact the run wrote is kept beside the board, not in the repository', async () => {
  const b = await db.board.upsert({
    where: { slug: 'artifacts' },
    update: { dailyBudgetUsd: null, maxConcurrent: 5, pausedAt: null },
    create: { slug: 'artifacts', dailyBudgetUsd: null, maxConcurrent: 5 },
  });
  const job = await db.job.create({
    data: {
      boardId: b.id, name: 'writes a report', brief: 'look into it', isolate: false,
      artifacts: ['report.md'], maxBudgetUsd: 1,
    },
  });
  // Deliberately past RESULT_MAX_BYTES: a value this size is refused as a result, and that refusal
  // is the reason this channel exists.
  const big = '#'.repeat(9000);
  await reconcile({ runtime: writing({ 'report.md': big }), cwd, board: 'artifacts', readPr: false });

  const after = await db.job.findUniqueOrThrow({ where: { id: job.id }, include: { attempts: true } });
  assert.equal(after.phase, 'succeeded');
  assert.deepEqual(after.attempts[0].artifacts, [{ name: 'report.md', kind: 'file', bytes: 9000 }],
    'the catalogue is on the row — name, kind and size, never the contents');

  // The two properties that distinguish an artifact from the other two outputs.
  const kept = path.join(artifactsDir(job.id, 1), 'report.md');
  assert.equal(fs.readFileSync(kept, 'utf8').length, 9000, 'the file survives the attempt: it IS the value');
  assert.equal(fs.existsSync(path.join(cwd, 'report.md')), false,
    'and it never entered the checkout, so it cannot land in a diff');
});

test('a declared artifact the run did NOT write fails the attempt', async () => {
  const b = await db.board.findUniqueOrThrow({ where: { slug: 'artifacts' } });
  const job = await db.job.create({
    data: {
      boardId: b.id, name: 'forgets the file', brief: 'look into it', isolate: false,
      artifacts: ['plan.json'], maxBudgetUsd: 1, maxRetries: 0,
    },
  });
  await reconcile({ runtime: writing({}), cwd, board: 'artifacts', readPr: false });

  const after = await db.job.findUniqueOrThrow({ where: { id: job.id }, include: { attempts: true } });
  assert.equal(after.attempts[0].outcome, 'no_output', 'the runtime said completed; the board disagreed');
  assert.equal(after.phase, 'failed');
  assert.match(after.lastError ?? '', /`plan\.json`/, 'and it names what is missing');
  assert.equal(fs.existsSync(artifactsDir(job.id, 1)), false,
    'a run that wrote nothing leaves no directory behind — one per attempt for ever is litter');
});

/**
 * The gate (ADR-010): a Job that stops after producing, and waits for a person.
 *
 * Every assertion is a refusal, because a gate that only ever lets things through is the shape this
 * project has shipped five times and had to delete. The four that matter:
 *
 *   - an UNGATED Job must not suspend;
 *   - a gated Job must not go terminal on its first success;
 *   - a gated Job that did not produce what it declared must FAIL rather than suspend — there is
 *     nothing worth approving;
 *   - and the gate must be ONE-SHOT: after an approval it ends like any other Job, or `succeeded`
 *     becomes unreachable and the completion condition is gone.
 */
async function gatedBoard() {
  return db.board.upsert({
    where: { slug: 'gated' },
    update: { dailyBudgetUsd: null, maxConcurrent: 5, pausedAt: null },
    create: { slug: 'gated', dailyBudgetUsd: null, maxConcurrent: 5 },
  });
}
const runGated = (r = fakeRuntime()) => reconcile({ runtime: r, cwd, board: 'gated', readPr: false });

test('a gated Job suspends on success instead of finishing, and says what it waits for', async () => {
  const b = await gatedBoard();
  const job = await db.job.create({
    data: {
      boardId: b.id, name: 'proposes', brief: 'propose it', isolate: false,
      gate: 'does this migration look right?', maxBudgetUsd: 1,
    },
  });
  await runGated();

  const after = await db.job.findUniqueOrThrow({ where: { id: job.id }, include: { attempts: true } });
  assert.equal(after.phase, 'suspended', 'not succeeded — nobody has looked at it yet');
  assert.equal(after.suspendedFor, 'does this migration look right?');
  assert.equal(after.finishedAt, null, 'and it is not finished: it is waiting on a person');
  assert.ok(after.lastSessionId, 'the session survives, or the approval has nothing to continue');
  assert.equal(after.attempts[0].outcome, 'completed', 'the RUN completed; the JOB is not done');
});

test('an ungated Job does not suspend — the gate is not on by default', async () => {
  const b = await gatedBoard();
  const job = await db.job.create({
    data: { boardId: b.id, name: 'ungated', brief: 'just do it', isolate: false, maxBudgetUsd: 1 },
  });
  await runGated();
  assert.equal((await db.job.findUniqueOrThrow({ where: { id: job.id } })).phase, 'succeeded');
});

test('a gated Job that did not produce what it declared FAILS rather than suspending', async () => {
  // The ordering that matters: ADR-008's shortfall outranks the gate, because a run that broke its
  // promise has nothing worth putting in front of a human.
  const b = await gatedBoard();
  const job = await db.job.create({
    data: {
      boardId: b.id, name: 'gated-shortfall', brief: 'propose it', isolate: false,
      gate: 'look at it', results: ['finding'], maxBudgetUsd: 1, maxRetries: 0,
    },
  });
  await runGated();

  const after = await db.job.findUniqueOrThrow({ where: { id: job.id } });
  assert.equal(after.phase, 'failed', 'not suspended');
  assert.equal(after.suspendedFor, null);
});

test('approval resumes the SAME session and carries the approver\'s words as the prompt', async () => {
  const b = await gatedBoard();
  const job = await db.job.create({
    data: {
      boardId: b.id, name: 'approved-job', brief: 'propose it', isolate: false,
      gate: 'ok?', maxBudgetUsd: 1,
    },
  });
  await runGated();
  assert.equal((await db.job.findUniqueOrThrow({ where: { id: job.id } })).phase, 'suspended');

  // What `hkb approve` writes: the event is the durable record, the phase is what the loop acts on.
  await db.event.create({
    data: { kind: 'approved', jobId: job.id, boardId: b.id, actor: 'ada', payload: { note: 'ship it, but rename the column' } },
  });
  await db.job.update({ where: { id: job.id }, data: { phase: 'pending', suspendedFor: null } });

  let seen: { prompt: string; resume?: string } | null = null;
  const spy: Runtime = {
    name: 'spy',
    async run(spec) {
      seen = { prompt: spec.prompt, resume: spec.resume };
      return {
        status: 'completed', ok: true, sessionId: spec.resume ?? 'new', text: 'applied',
        costUsd: 0.1, turns: 1, durationMs: 1, stopReason: 'end_turn', denials: 0, error: null,
      };
    },
  };
  await runGated(spy);

  assert.ok(seen, 'the approved Job ran again');
  assert.match(seen!.prompt, /approved it\. Carry it out now/, 'the instruction, not the brief again');
  assert.match(seen!.prompt, /ada/, 'and who said so');
  assert.match(seen!.prompt, /rename the column/, 'and in their words');
  assert.doesNotMatch(seen!.prompt, /propose it/, 'the original brief is NOT re-sent — it would propose twice');
  assert.ok(seen!.resume, 'continued, not started cold');

  const after = await db.job.findUniqueOrThrow({ where: { id: job.id } });
  assert.equal(after.phase, 'succeeded', 'ONE-SHOT: it ends this time rather than suspending again');
  assert.ok(after.finishedAt, 'and it is finished');
});

test('a successful attempt does not spend a retry, so a gated chain keeps its budget', async () => {
  // Inert before the gate, because success was terminal. Live the moment a Job survives its own
  // successful attempt: a two-step Job would arrive at the apply half having spent one of two
  // retries without ever failing.
  const b = await gatedBoard();
  const job = await db.job.create({
    data: {
      boardId: b.id, name: 'retry-budget', brief: 'x', isolate: false,
      gate: 'ok?', maxBudgetUsd: 1, maxRetries: 0,
    },
  });
  await runGated();
  await db.event.create({ data: { kind: 'approved', jobId: job.id, boardId: b.id, actor: 'ada', payload: {} } });
  await db.job.update({ where: { id: job.id }, data: { phase: 'pending', suspendedFor: null } });

  // maxRetries 0 means one attempt's worth of budget. The apply half must still be allowed to run.
  await runGated();
  const after = await db.job.findUniqueOrThrow({ where: { id: job.id }, include: { attempts: true } });
  assert.equal(after.attempts.length, 2, 'the approved half ran; the retry budget was not eaten by the success');
  assert.equal(after.phase, 'succeeded');
});

test('a gated Job keeps its checkout while it waits, so the approved half continues in it', async () => {
  // Isolated, so there is a real worktree. Cutting a fresh one on approval would reset the branch to
  // base and strand whatever the propose half pushed.
  const b = await gatedBoard();
  const job = await db.job.create({
    data: { boardId: b.id, name: 'keeps-checkout', brief: 'x', gate: 'ok?', maxBudgetUsd: 1 },
  });
  await runGated();
  const after = await db.job.findUniqueOrThrow({ where: { id: job.id }, include: { attempts: true } });
  assert.equal(after.phase, 'suspended');
  assert.ok(fs.existsSync(path.join(cwd, '.hkb', 'worktrees', `kb-${job.id}-1`)),
    'the checkout is still there — the approval continues in it');
});

test('the retry budget survives the propose half, so an approved run that FAILS may still retry', async () => {
  // What `charged` counting a completed attempt would break: the apply half arrives having spent a
  // retry the Job never used, so its first real failure is also its last.
  const b = await gatedBoard();
  const job = await db.job.create({
    data: {
      boardId: b.id, name: 'retry-after-gate', brief: 'x', isolate: false,
      gate: 'ok?', maxBudgetUsd: 1, maxRetries: 1,
    },
  });
  await runGated();
  await db.event.create({ data: { kind: 'approved', jobId: job.id, boardId: b.id, actor: 'ada', payload: {} } });
  await db.job.update({ where: { id: job.id }, data: { phase: 'pending', suspendedFor: null } });

  // The approved half fails. With the retry budget intact it goes back to pending for one more go.
  await runGated(fakeRuntime({ failTasks: [job.id] }));
  const after = await db.job.findUniqueOrThrow({ where: { id: job.id } });
  assert.equal(after.phase, 'pending', 'it may try again — the successful propose half spent nothing');
});

/**
 * `proposals` end to end (ADR-011): a workload proposes, the controller writes.
 *
 * `test/proposals.test.ts` covers the validator's refusals. These cover the wiring, and what they
 * are really testing is that **nothing is created before a person says so** — the guard, not the
 * feature. A proposal that got applied on its own would be board access with extra steps.
 */
const proposing = (body: string): Runtime => ({
  name: 'proposing',
  async run(spec) {
    // The worker's side: the contract names one absolute path, and this writes to it. Taken from
    // the prompt rather than recomputed, so a brief that stopped naming the path fails this test.
    const m = spec.prompt.match(/`(\S+proposal\.json)`/);
    if (m) fs.writeFileSync(m[1], body);
    return {
      status: 'completed', ok: true, sessionId: 'sess-p', text: 'proposed',
      costUsd: 0.1, turns: 2, durationMs: 10, stopReason: 'end_turn', denials: 0, error: null,
    };
  },
});

const proposalBoard = async () => db.board.upsert({
  where: { slug: 'proposals' },
  update: { dailyBudgetUsd: null, maxConcurrent: 5, pausedAt: null },
  create: { slug: 'proposals', dailyBudgetUsd: null, maxConcurrent: 5 },
});

test('a proposing Job suspends holding its proposal, and creates NOTHING', async () => {
  const b = await proposalBoard();
  const before = await db.job.count();
  const job = await db.job.create({
    data: {
      boardId: b.id, name: 'decomposes', brief: 'break the work down', isolate: false,
      proposes: 'jobs', gate: 'a proposal to review', maxBudgetUsd: 2,
    },
  });
  await reconcile({
    runtime: proposing(JSON.stringify({
      jobs: [{ name: 'part one', brief: 'do the first half' }, { name: 'part two', brief: 'do the second half', maxBudgetUsd: 99 }],
    })),
    cwd, board: 'proposals', readPr: false,
  });

  const after = await db.job.findUniqueOrThrow({ where: { id: job.id }, include: { attempts: true } });
  assert.equal(after.phase, 'suspended', 'a proposal waits for a person, always');
  assert.equal(after.suspendedFor, '2 Jobs proposed — approve to file them',
    'and the gate text says how much is being asked for, not the operator’s placeholder');
  assert.deepEqual(after.attempts[0].proposal, {
    jobs: [
      { name: 'part one', brief: 'do the first half' },
      { name: 'part two', brief: 'do the second half', maxBudgetUsd: 2 },
    ],
    clamped: ['jobs[1].maxBudgetUsd asked for $99.00 and was clamped to $2.00'],
  }, 'stored as the validator accepted it, clamp and all');

  // THE guard. Everything else here is plumbing; this is the decision ADR-011 records.
  assert.equal(await db.job.count(), before + 1, 'one Job filed by this test, and not one row more');

  // And the raw file survives beside the board, which is what makes the proposal auditable.
  assert.ok(fs.existsSync(path.join(artifactsDir(job.id, 1), 'proposal.json')));
});

test('an approved proposal is applied by the CONTROLLER, once, with lineage', async () => {
  const b = await proposalBoard();
  const proposer = await db.job.findFirstOrThrow({ where: { boardId: b.id, name: 'decomposes' } });
  await db.event.create({ data: { kind: 'approved', jobId: proposer.id, boardId: b.id, actor: 'ada', payload: {} } });
  await db.job.update({ where: { id: proposer.id }, data: { phase: 'pending', suspendedFor: null } });

  const report = await reconcile({ runtime: proposing('{}'), cwd, board: 'proposals', readPr: false });

  const filed = await db.job.findMany({ where: { proposedByJobId: proposer.id }, orderBy: { proposalIndex: 'asc' } });
  assert.equal(filed.length, 2);
  assert.deepEqual(filed.map((j) => j.name), ['part one', 'part two']);
  assert.deepEqual(filed.map((j) => j.proposalIndex), [0, 1]);
  assert.deepEqual(filed.map((j) => j.proposedByK), [1, 1], 'the attempt that proposed them, not the Job alone');
  assert.equal(filed[1].maxBudgetUsd, 2, 'the clamped number, not the one that was asked for');
  assert.equal(filed[0].isolate, true, 'and everything a proposal may not set is the board’s answer');
  assert.deepEqual(report.filed, filed.map((j) => j.id).sort((x, y) => x - y));

  const after = await db.job.findUniqueOrThrow({ where: { id: proposer.id } });
  assert.equal(after.phase, 'succeeded', 'the proposer is finished, not re-run');
  assert.ok(after.finishedAt);

  // Who filed them is the approver, because the rows exist because a person said so.
  const created = await db.event.findFirstOrThrow({ where: { jobId: filed[0].id, kind: 'created' } });
  assert.equal(created.actor, 'ada');
  assert.deepEqual(created.payload, { name: 'part one', proposedBy: proposer.id, attempt: 1, index: 0 });
});

test('re-applying the same approval creates nothing — the unique key refuses it', async () => {
  const b = await proposalBoard();
  const proposer = await db.job.findFirstOrThrow({ where: { boardId: b.id, name: 'decomposes' } });
  // The crash this models: a pass that created the rows and died before it could finish the Job.
  await db.job.update({ where: { id: proposer.id }, data: { phase: 'pending', finishedAt: null } });
  const before = await db.job.count();

  const report = await reconcile({ runtime: proposing('{}'), cwd, board: 'proposals', readPr: false });

  assert.equal(await db.job.count(), before, 'not one duplicate — the database refused, nothing had to remember');
  assert.deepEqual(report.filed, []);
  const applied = await db.event.findMany({ where: { jobId: proposer.id, kind: 'applied' }, orderBy: { id: 'desc' } });
  assert.deepEqual(applied[0].payload, { filed: [], already: 2, attempt: 1 });
  assert.equal((await db.job.findUniqueOrThrow({ where: { id: proposer.id } })).phase, 'succeeded');
});

test('a proposal is NOT applied without an approval, however long it waits', async () => {
  const b = await proposalBoard();
  const job = await db.job.create({
    data: {
      boardId: b.id, name: 'unapproved', brief: 'break it down', isolate: false,
      proposes: 'jobs', gate: 'a proposal to review', maxBudgetUsd: 2,
    },
  });
  await reconcile({
    runtime: proposing(JSON.stringify({ jobs: [{ name: 'never filed', brief: 'x' }] })),
    cwd, board: 'proposals', readPr: false,
  });
  const before = await db.job.count();

  // Not suspended any more, but still not approved: the phase alone must not be what applies it.
  await db.job.update({ where: { id: job.id }, data: { phase: 'pending', suspendedFor: null } });
  await reconcile({ runtime: proposing('{}'), cwd, board: 'proposals', readPr: false });

  assert.equal(await db.job.findFirst({ where: { proposedByJobId: job.id } }), null,
    'no approval event, no rows — this is the whole of ADR-011 decision 5');
  assert.equal(await db.job.count(), before, 'and the pass created nothing else either');
});

test('a proposal the validator refuses fails the attempt and names why', async () => {
  const b = await proposalBoard();
  const job = await db.job.create({
    data: {
      boardId: b.id, name: 'over-reaches', brief: 'break it down', isolate: false,
      proposes: 'jobs', gate: 'a proposal to review', maxBudgetUsd: 1, maxRetries: 0,
    },
  });
  await reconcile({
    runtime: proposing(JSON.stringify({ jobs: [{ name: 'sneaky', brief: 'x', isolate: false }] })),
    cwd, board: 'proposals', readPr: false,
  });

  const after = await db.job.findUniqueOrThrow({ where: { id: job.id }, include: { attempts: true } });
  assert.equal(after.phase, 'failed', 'not suspended: there is nothing here a person could approve');
  assert.equal(after.attempts[0].outcome, 'no_output');
  assert.match(after.lastError ?? '', /`isolate`/, 'and the refusal names the key');
  assert.equal(after.attempts[0].proposal, null, 'nothing refused is ever stored');
});

test('a proposing Job that writes no proposal fails like any other declared output', async () => {
  const b = await proposalBoard();
  const job = await db.job.create({
    data: {
      boardId: b.id, name: 'writes nothing', brief: 'break it down', isolate: false,
      proposes: 'jobs', gate: 'a proposal to review', maxBudgetUsd: 1, maxRetries: 0,
    },
  });
  // A runtime that succeeds and writes nothing at all.
  await reconcile({ runtime: fakeRuntime(), cwd, board: 'proposals', readPr: false });

  const after = await db.job.findUniqueOrThrow({ where: { id: job.id }, include: { attempts: true } });
  assert.equal(after.phase, 'failed');
  assert.equal(after.attempts[0].outcome, 'no_output');
  assert.match(after.lastError ?? '', /there is no `proposal\.json`/,
    'and the reason is the validator’s, because the validator is the only thing that looks');
});

test('a pass that only applied a proposal still reports that it did something', async () => {
  // The report is what `hkb run` prints from, and `claimed + reclaimed` was the whole of "did this
  // pass do anything". A pass that created three Jobs and said "nothing pending" would be telling
  // the operator the opposite of what it had just done.
  const b = await proposalBoard();
  const job = await db.job.create({
    data: {
      boardId: b.id, name: 'files two', brief: 'break it down', isolate: false,
      proposes: 'jobs', gate: 'a proposal to review', maxBudgetUsd: 2,
    },
  });
  await reconcile({
    runtime: proposing(JSON.stringify({ jobs: [{ name: 'x', brief: 'x' }, { name: 'y', brief: 'y' }] })),
    cwd, board: 'proposals', readPr: false,
  });
  await db.event.create({ data: { kind: 'approved', jobId: job.id, boardId: b.id, actor: 'ada', payload: {} } });
  await db.job.update({ where: { id: job.id }, data: { phase: 'pending', suspendedFor: null } });

  const report = await reconcile({ runtime: proposing('{}'), cwd, only: job.id, board: 'proposals', readPr: false });
  assert.equal(report.claimed.length, 0, 'nothing was claimed — the proposer was applied, not run');
  assert.equal(report.filed.length, 2, 'and the two rows it filed are in the report');
});

test('a create failure that is NOT a duplicate stops the pass rather than being swallowed', async () => {
  // The other half of the P2002 catch. A board that silently drops half a proposal because one row
  // hit an error nobody looked at is worse than one that stops and says so — and the difference is
  // one equality test, which is exactly the kind that rots unnoticed.
  const b = await db.board.create({ data: { slug: 'orphaned', maxConcurrent: 5 } });
  const job = await db.job.create({
    data: {
      boardId: b.id, name: 'proposes into nowhere', brief: 'break it down', isolate: false,
      proposes: 'jobs', gate: 'a proposal to review', maxBudgetUsd: 1,
    },
  });
  await reconcile({
    runtime: proposing(JSON.stringify({ jobs: [{ name: 'never lands', brief: 'x' }] })),
    cwd, board: 'orphaned', readPr: false,
  });
  await db.event.create({ data: { kind: 'approved', jobId: job.id, boardId: b.id, actor: 'ada', payload: {} } });
  await db.job.update({ where: { id: job.id }, data: { phase: 'pending', suspendedFor: null } });

  // Pull the board out from under it without cascading the Job away, so the create fails on the
  // foreign key (P2003) rather than on the unique one.
  await db.$executeRawUnsafe('PRAGMA foreign_keys=OFF');
  await db.$executeRawUnsafe(`DELETE FROM "Board" WHERE id = ${b.id}`);
  await db.$executeRawUnsafe('PRAGMA foreign_keys=ON');

  await assert.rejects(
    () => reconcile({ runtime: proposing('{}'), cwd, only: job.id, readPr: false }),
    (e: { code?: string }) => e.code === 'P2003',
    'the pass fails loudly; it does not count a broken row as one that was already filed',
  );
  // Where it failed, not just that it failed. A swallowed error would have gone on to finish the
  // Job — so a proposer still `pending` is the proof that the create is what stopped the pass.
  assert.equal((await db.job.findUniqueOrThrow({ where: { id: job.id } })).phase, 'pending',
    'and the Job is not marked done for work that was never filed');

  await db.$executeRawUnsafe('PRAGMA foreign_keys=OFF');
  await db.$executeRawUnsafe(`DELETE FROM "Attempt" WHERE jobId = ${job.id}`);
  await db.$executeRawUnsafe(`DELETE FROM "Event" WHERE jobId = ${job.id}`);
  await db.$executeRawUnsafe(`DELETE FROM "Job" WHERE id = ${job.id}`);
  await db.$executeRawUnsafe('PRAGMA foreign_keys=ON');
});

test('an isolated proposing Job is NOT told to commit', async () => {
  // The contradiction this pins, found by printing the prompt rather than by a failing test: an
  // isolated Job gets the sandbox contract, and a proposing one gets the proposal contract, so one
  // prompt told a worker both to "commit what you have" and to "write the file and stop". A worker
  // cannot obey both, and which one it picks is not something to leave to chance.
  const b = await proposalBoard();
  let seen = '';
  const spy = {
    name: 'spy',
    async run(spec: { prompt: string }) {
      seen = spec.prompt;
      return { status: 'completed', ok: true, sessionId: 's', text: '', costUsd: 0, turns: 1,
               durationMs: 0, stopReason: 'end_turn', denials: 0, error: null };
    },
  } as never;
  const job = await db.job.create({
    data: {
      boardId: b.id, name: 'proposes from a worktree', brief: 'break it down',
      proposes: 'jobs', gate: 'a proposal to review', maxBudgetUsd: 1, maxRetries: 0,
    },
  });
  await reconcile({ runtime: spy, cwd, board: 'proposals', readPr: false });

  assert.doesNotMatch(seen, /Commit it on/, 'a proposal is not a diff and has nothing to commit');
  assert.doesNotMatch(seen, /git push/);
  assert.match(seen, new RegExp(`worktree of your own, checked out on \`kb-${job.id}-1\``),
    'it still has to know where it is standing — the worktree is the sandbox');
  assert.match(seen, /Write the file and stop/, 'and the contract that replaced the protocol is the one it follows');

  // An ordinary isolated Job is unchanged: this narrows the proposing case and nothing else.
  const plain = await db.job.create({
    data: { boardId: b.id, name: 'ordinary isolated', brief: 'do the work', maxBudgetUsd: 1, maxRetries: 0 },
  });
  await reconcile({ runtime: spy, cwd, only: plain.id, board: 'proposals', readPr: false });
  assert.match(seen, new RegExp(`Commit it on \`kb-${plain.id}-1\``));
});

test('an isolated Job with no guide and no default workflow gets the contract and nothing else', async () => {
  // The shipped defaults, on a board that configures nothing: what a worker is told is its branch,
  // the rules the controller refuses on, and its own brief. Every line that was moved out to a
  // workflow file is asserted ABSENT, because "the core stopped saying it" is the whole change and
  // it is invisible from the inside (ADR-017 decision 5).
  const b = await proposalBoard();
  let seen = '';
  const spy = {
    name: 'spy',
    async run(spec: { prompt: string }) {
      seen = spec.prompt;
      return { status: 'completed', ok: true, sessionId: 's', text: '', costUsd: 0, turns: 1,
               durationMs: 0, stopReason: 'end_turn', denials: 0, error: null };
    },
  } as never;
  const job = await db.job.create({
    data: { boardId: b.id, name: 'plain isolated', brief: 'Do the work.', maxBudgetUsd: 1, maxRetries: 0 },
  });
  await reconcile({ runtime: spy, cwd, only: job.id, board: 'proposals', readPr: false });

  assert.match(seen, new RegExp(`already checked out on the branch\\n\`kb-${job.id}-1\``), 'where it is standing');
  assert.match(seen, /Commit it on/, 'and what the machinery reads afterwards');
  assert.match(seen, new RegExp(`git push -u origin kb-${job.id}-1`), 'and to push it, which the sweep and the rebase both read');
  assert.match(seen, new RegExp(`\`kb-${job.id}-1\` is the only branch you may push`), 'and the rule the hook enforces');
  for (const gone of [/pull request/i, /gh pr/i, /Co-Authored-By/i, /--force-with-lease/]) {
    assert.doesNotMatch(seen, gone, 'nothing refuses on this, so nothing in the core says it');
  }
  // This scratch repository has no remote, so there is no base to rebase onto and no fetch to ask
  // for — `test/rebase.test.ts` is where that half is exercised against a real one.
  assert.doesNotMatch(seen, /git fetch/);
});

test('a suspended Job is reported as waiting, not as retrying, and carries no error', async () => {
  // Both found by running a real one and reading `hkb run` and `hkb show`. A gated Job that
  // suspended was counted in `retrying` — telling the operator the machine would pick it up again,
  // when it is waiting for THEM — and `lastError` fell through to the outcome word, so every
  // suspended Job displayed `error completed`.
  const b = await proposalBoard();
  const job = await db.job.create({
    data: {
      boardId: b.id, name: 'waits for a person', brief: 'look into it', isolate: false,
      gate: 'does this look right?', results: ['finding'], maxBudgetUsd: 1,
    },
  });
  const report = await reconcile({
    runtime: writing({ finding: 'it is fine' }), cwd, only: job.id, board: 'proposals', readPr: false,
  });

  assert.deepEqual(report.suspended, [job.id], 'waiting on a person is its own answer');
  assert.deepEqual(report.retrying, [], 'and it is not a retry — nothing will pick this up on its own');

  const after = await db.job.findUniqueOrThrow({ where: { id: job.id } });
  assert.equal(after.phase, 'suspended');
  assert.equal(after.lastError, null, 'a Job that succeeded and is waiting has nothing wrong with it');
  assert.equal(after.suspendedFor, 'does this look right?');
});

test('a suspended PROPOSER does not keep a checkout nothing will resume into', async () => {
  // The gated Job beside it keeps its worktree because the approved attempt continues in it. A
  // proposer's approval is applied by the controller — no session ever wakes up there — so the
  // checkout is a whole repository on disk holding work nobody will return to, and the line saying
  // "attempt 2 resumes in it" described an attempt that cannot happen.
  const b = await proposalBoard();
  const job = await db.job.create({
    data: {
      boardId: b.id, name: 'proposes and lets go', brief: 'break it down',
      proposes: 'jobs', gate: 'a proposal to review', maxBudgetUsd: 1, maxRetries: 0,
    },
  });
  await reconcile({
    runtime: proposing(JSON.stringify({ jobs: [{ name: 'follow-up', brief: 'do it' }] })),
    cwd, only: job.id, board: 'proposals', readPr: false,
  });

  const after = await db.job.findUniqueOrThrow({ where: { id: job.id } });
  assert.equal(after.phase, 'suspended', 'it is still waiting for a person');
  assert.equal(fs.existsSync(path.join(cwd, '.hkb', 'worktrees', `kb-${job.id}-1`)), false,
    'and its checkout is gone, because nothing will run in it again');
  // The proposal itself is untouched by that: it lives beside the board, not in the checkout.
  assert.ok(storedProposalOf(after.id));
});

const storedProposalOf = (id: number) => db.attempt.findFirst({ where: { jobId: id, k: 1 } });

/**
 * The contributor guide (ADR-013), end to end. `test/guide.test.ts` covers the reading and every
 * refusal; these cover the wiring, and the second is the one that matters — a Job told to follow
 * rules it was never given must not run.
 */
test('a granted guide reaches the worker, in front of the brief', async () => {
  const b = await db.board.upsert({
    where: { slug: 'guided' },
    update: { dailyBudgetUsd: null, maxConcurrent: 5, pausedAt: null, defaultGuide: 'GUIDE.md' },
    create: { slug: 'guided', dailyBudgetUsd: null, maxConcurrent: 5, defaultGuide: 'GUIDE.md' },
  });
  fs.writeFileSync(path.join(cwd, 'GUIDE.md'), '# House rules\n\nAlways run the tests.\n');
  let seen = '';
  const spy = {
    name: 'spy',
    async run(spec: { prompt: string }) {
      seen = spec.prompt;
      return { status: 'completed', ok: true, sessionId: 's', text: '', costUsd: 0, turns: 1,
               durationMs: 0, stopReason: 'end_turn', denials: 0, error: null };
    },
  } as never;
  const job = await db.job.create({
    data: { boardId: b.id, name: 'reads the rules', brief: 'Fix the thing.', isolate: false, maxBudgetUsd: 1 },
  });
  await reconcile({ runtime: spy, cwd, only: job.id, board: 'guided', readPr: false });

  assert.match(seen, /Always run the tests/, 'the board granted it, so the Job gets it');
  assert.ok(seen.indexOf('House rules') < seen.indexOf('Fix the thing.'), 'and it comes first');
  assert.equal((await db.job.findUniqueOrThrow({ where: { id: job.id } })).phase, 'succeeded');
});

test('a Job told to read a guide that is not there FAILS before it spends anything', async () => {
  const b = await db.board.findFirstOrThrow({ where: { slug: 'guided' } });
  let ran = false;
  const spy = { name: 'spy', async run() { ran = true; throw new Error('must not run'); } } as never;
  const job = await db.job.create({
    data: {
      boardId: b.id, name: 'points at nothing', brief: 'Fix the thing.', isolate: false,
      guide: 'NO-SUCH-GUIDE.md', maxBudgetUsd: 1, maxRetries: 0,
    },
  });
  await reconcile({ runtime: spy, cwd, only: job.id, board: 'guided', readPr: false });

  assert.equal(ran, false, 'the runtime is never called — this costs nothing to find out');
  const after = await db.job.findUniqueOrThrow({ where: { id: job.id }, include: { attempts: true } });
  assert.equal(after.phase, 'failed');
  assert.equal(after.attempts[0].outcome, 'no_input', 'the same outcome as an input that could not be read');
  assert.match(after.lastError ?? '', /NO-SUCH-GUIDE\.md/);
  assert.match(after.lastError ?? '', /worse than not running/);
});

test('a Job may refuse the board’s guide, and a Job with none is unchanged', async () => {
  const b = await db.board.findFirstOrThrow({ where: { slug: 'guided' } });
  let seen = '';
  const spy = {
    name: 'spy',
    async run(spec: { prompt: string }) {
      seen = spec.prompt;
      return { status: 'completed', ok: true, sessionId: 's', text: '', costUsd: 0, turns: 1,
               durationMs: 0, stopReason: 'end_turn', denials: 0, error: null };
    },
  } as never;
  // `--guide ""` is the empty string, which `str()` reads as unset on the JOB — so the board
  // answers. Refusing a board grant is `hkb boards set --guide none`, at the board.
  const job = await db.job.create({
    data: { boardId: b.id, name: 'inherits', brief: 'Do it.', isolate: false, maxBudgetUsd: 1 },
  });
  await reconcile({ runtime: spy, cwd, only: job.id, board: 'guided', readPr: false });
  assert.match(seen, /House rules/, 'the board default reaches a Job that said nothing');

  // A board with no guide gives a Job no guide: the frame is absent entirely, not empty.
  const plain = await db.board.upsert({
    where: { slug: 'unguided' }, update: { defaultGuide: null, maxConcurrent: 5, dailyBudgetUsd: null },
    create: { slug: 'unguided', maxConcurrent: 5, dailyBudgetUsd: null },
  });
  const bare = await db.job.create({
    data: { boardId: plain.id, name: 'no guide', brief: 'Do it.', isolate: false, maxBudgetUsd: 1 },
  });
  await reconcile({ runtime: spy, cwd, only: bare.id, board: 'unguided', readPr: false });
  assert.doesNotMatch(seen, /contributor guide/, 'no grant, no block — not an empty one');
});

test('EVERY board default reaches a worker, not the ones somebody remembered to select', async () => {
  // The bug this exists to catch, and it was live: `reconcile` read the Board with a hand-listed
  // `select`, and `defaultPluginPaths` was never added to it — so ADR-012's board-level skill grant
  // resolved to `undefined`, fell through to the built-in, and reached no worker at all. Nothing
  // failed; the grant just silently did not exist.
  //
  // So this asserts on the WHOLE resolved spec rather than one field: a test per default is a test
  // somebody has to remember to add, which is the same failure one layer up.
  const b = await db.board.upsert({
    where: { slug: 'defaulted' },
    update: {
      maxConcurrent: 5, dailyBudgetUsd: null, pausedAt: null,
      defaultModel: 'claude-opus-5', defaultEffort: 'high', defaultMaxTurns: 7,
      defaultMaxBudgetUsd: 3, defaultMaxRetries: 1, defaultAllowedTools: ['Read'],
      defaultPluginPaths: ['.claude'], defaultGuide: 'GUIDE.md',
    },
    create: {
      slug: 'defaulted', maxConcurrent: 5, dailyBudgetUsd: null,
      defaultModel: 'claude-opus-5', defaultEffort: 'high', defaultMaxTurns: 7,
      defaultMaxBudgetUsd: 3, defaultMaxRetries: 1, defaultAllowedTools: ['Read'],
      defaultPluginPaths: ['.claude'], defaultGuide: 'GUIDE.md',
    },
  });
  fs.writeFileSync(path.join(cwd, 'GUIDE.md'), '# House rules\n\nAlways run the tests.\n');
  fs.mkdirSync(path.join(cwd, '.claude'), { recursive: true });

  let got: { model?: string; maxTurns?: number; allowedTools?: string[]; plugins?: string[]; prompt: string } | null = null;
  const spy = {
    name: 'spy',
    async run(spec: never) {
      got = spec;
      return { status: 'completed', ok: true, sessionId: 's', text: '', costUsd: 0, turns: 1,
               durationMs: 0, stopReason: 'end_turn', denials: 0, error: null };
    },
  } as never;
  const job = await db.job.create({
    data: { boardId: b.id, name: 'inherits everything', brief: 'Do it.', isolate: false },
  });
  await reconcile({ runtime: spy, cwd, only: job.id, board: 'defaulted', readPr: false });

  assert.ok(got);
  assert.equal(got!.model, 'claude-opus-5');
  assert.equal(got!.maxTurns, 7);
  assert.deepEqual(got!.allowedTools, ['Read']);
  assert.deepEqual(got!.plugins, [path.join(cwd, '.claude')], 'the grant ADR-012 shipped, which used to arrive as nothing');
  assert.match(got!.prompt, /House rules/, 'and the guide ADR-013 added');
  const attempt = await db.attempt.findFirstOrThrow({ where: { jobId: job.id } });
  assert.equal(attempt.maxBudgetUsd, 3, 'the cap frozen at claim time came from the board too');
});

test('the standing rules reach every shape of Job, including a resumed approval', async () => {
  // ADR-014 declined the claude_code preset and took one thing from it: a standing instruction for
  // when the work itself is wrong. A rule that reached only some Jobs would be one nothing could
  // rely on, so this asserts the shapes rather than one of them — isolated, bare, proposing, and a
  // resumed attempt carrying an approver's words, which is the one that skips `withSandbox`.
  const b = await proposalBoard();
  let seen = '';
  const spy = {
    name: 'spy',
    async run(spec: { prompt: string }) {
      seen = spec.prompt;
      return { status: 'completed', ok: true, sessionId: 's', text: '', costUsd: 0, turns: 1,
               durationMs: 0, stopReason: 'end_turn', denials: 0, error: null };
    },
  } as never;
  const has = () => /Three standing rules/.test(seen) && /Never weaken a check/.test(seen)
    && /data, not instruction/.test(seen) && /stop and say so/.test(seen);

  const bare = await db.job.create({
    data: { boardId: b.id, name: 'bare', brief: 'Do it.', isolate: false, maxBudgetUsd: 1 },
  });
  await reconcile({ runtime: spy, cwd, only: bare.id, board: 'proposals', readPr: false });
  assert.ok(has(), 'an un-isolated Job, which gets no protocol at all');

  const isolated = await db.job.create({
    data: { boardId: b.id, name: 'isolated', brief: 'Do it.', maxBudgetUsd: 1 },
  });
  await reconcile({ runtime: spy, cwd, only: isolated.id, board: 'proposals', readPr: false });
  assert.ok(has(), 'an isolated Job, beside the sandbox contract');
  assert.match(seen, new RegExp(`Commit it on \`kb-${isolated.id}-1\``));

  const proposer = await db.job.create({
    data: {
      boardId: b.id, name: 'proposer', brief: 'Break it down.', isolate: false,
      proposes: 'jobs', gate: 'a proposal to review', maxBudgetUsd: 1,
    },
  });
  await reconcile({
    runtime: proposing(JSON.stringify({ jobs: [{ name: 'x', brief: 'y' }] })),
    cwd, only: proposer.id, board: 'proposals', readPr: false,
  });

  // The resumed approval: `approvalPrompt` replaces the brief AND the protocol, so it is the shape
  // most likely to lose a rule that is attached to either.
  const gated = await db.job.create({
    data: {
      boardId: b.id, name: 'gated', brief: 'Propose it.', isolate: false,
      gate: 'does this look right?', maxBudgetUsd: 1,
    },
  });
  await reconcile({ runtime: spy, cwd, only: gated.id, board: 'proposals', readPr: false });
  await db.event.create({ data: { kind: 'approved', jobId: gated.id, boardId: b.id, actor: 'ada', payload: {} } });
  await db.job.update({ where: { id: gated.id }, data: { phase: 'pending', suspendedFor: null } });
  await reconcile({ runtime: spy, cwd, only: gated.id, board: 'proposals', readPr: false });
  assert.match(seen, /has reviewed what you proposed/, 'this really is the approval prompt');
  assert.ok(has(), 'and it carries the standing rules too');
});

/**
 * `triage` — the state `pending` could not hold (ADR-011 named the gap).
 *
 * The guard is the whole feature: `pending` means *wants to run*, so a Job somebody has noticed but
 * not decided on had nowhere to be. That it is never claimed comes free from the claim query asking
 * for `pending` — which is exactly why it needs a test that would notice if the query changed.
 */
test('a Job in triage is NEVER claimed, however long the board runs', async () => {
  const b = await proposalBoard();
  const noted = await db.job.create({
    data: { boardId: b.id, name: 'something I noticed', brief: 'something I noticed', phase: 'triage', isolate: false },
  });
  const real = await db.job.create({
    data: { boardId: b.id, name: 'actual work', brief: 'do it', isolate: false, maxBudgetUsd: 1 },
  });

  // To rest, not one pass: a Job that is skipped once and picked up on the third tick would pass a
  // single-pass test and still be wrong.
  const passes = await reconcileToRest({ runtime: fakeRuntime(), cwd, board: 'proposals', readPr: false });
  const claimed = passes.flatMap((p) => p.claimed);

  assert.ok(claimed.includes(real.id), 'the pending one ran');
  assert.ok(!claimed.includes(noted.id), 'and the noted one was never touched');
  const after = await db.job.findUniqueOrThrow({ where: { id: noted.id }, include: { attempts: true } });
  assert.equal(after.phase, 'triage', 'still where it was put');
  assert.equal(after.attempts.length, 0, 'and it cost nothing — no attempt, no money');
});

test('an approved proposal cannot be applied to a Job in triage either', async () => {
  // `applyProposals` runs before the claim loop and asks the same question. A triage item with an
  // approval on it — reachable by filing one and approving nothing else — must stay put.
  const b = await proposalBoard();
  const job = await db.job.create({
    data: {
      boardId: b.id, name: 'noted proposer', brief: 'break it down', isolate: false,
      proposes: 'jobs', phase: 'triage',
    },
  });
  await db.attempt.create({
    data: {
      jobId: job.id, k: 1, maxBudgetUsd: 1, outcome: 'completed', endedAt: new Date(),
      proposal: { jobs: [{ name: 'must not be filed', brief: 'x' }], clamped: [] },
    },
  });
  await db.event.create({ data: { kind: 'approved', jobId: job.id, boardId: b.id, actor: 'ada', payload: {} } });

  const report = await reconcile({ runtime: fakeRuntime(), cwd, board: 'proposals', readPr: false });
  assert.deepEqual(report.filed, [], 'nothing filed');
  assert.equal(await db.job.findFirst({ where: { name: 'must not be filed' } }), null);
  assert.equal((await db.job.findUniqueOrThrow({ where: { id: job.id } })).phase, 'triage');
});

// ---------------------------------------------------------------- the completion check (ADR-016 §3)
//
// hkb has no exit code: its container is an agent session, and a session always finishes
// successfully. `exports`/`results`/`artifacts` reconstruct one for FILES; `check` reconstructs one
// for BEHAVIOUR. The tests that matter are the ones where it REFUSES — and the first of them is
// that at the shipped defaults it refuses to exist at all.

// A board per case, because a check leaves a Job PENDING while retries remain — so a board shared
// between two tests would re-run the previous test's Job inside this one's pass, and every
// assertion about "what ran" would be about both.
const checkBoard = (slug: string) =>
  db.board.upsert({ where: { slug }, update: {}, create: { slug } });
const runChecks = (slug: string, r: Runtime = fakeRuntime()) =>
  reconcile({ runtime: r, cwd, board: slug, readPr: false });

/** A runtime that leaves files in the worktree it was given, the way a worker does. */
const plants = (files: Record<string, string>, extra: (cwd: string, attempt: number) => void = () => {}): Runtime => ({
  name: 'plants',
  async run(spec) {
    for (const [name, body] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(spec.cwd, name)), { recursive: true });
      fs.writeFileSync(path.join(spec.cwd, name), body);
    }
    extra(spec.cwd, spec.attempt);
    return {
      status: 'completed', ok: true, sessionId: `s-${spec.taskId}-${spec.attempt}`, text: 'did it',
      costUsd: 0, turns: 1, durationMs: 0, stopReason: 'end_turn', denials: 0, error: null,
    };
  },
});

/** A runtime that records the prompt it was handed and does nothing else. */
const spyOn = (into: string[]): Runtime => ({
  name: 'spy',
  async run(spec) {
    into.push(spec.prompt);
    return {
      status: 'completed', ok: true, sessionId: `s-${spec.taskId}-${spec.attempt}`, text: '',
      costUsd: 0, turns: 1, durationMs: 0, stopReason: 'end_turn', denials: 0, error: null,
    };
  },
});

test('at the shipped defaults NOTHING runs: no check on the Job, none on the board, no command', async () => {
  // The refusing case first, and it is the one an operator gets by default. A `check` that ran
  // something anybody had not written would be hkb executing a guess with a shell in it.
  const b = await checkBoard('check-none');
  const marker = path.join(dir, 'must-not-exist');
  const job = await db.job.create({ data: { boardId: b.id, name: 'unchecked', brief: 'x' } });

  // The worker plants exactly what a convention-based implementation would look for. Nothing reads
  // it, because the command comes from the row and there is no row saying anything.
  await runChecks('check-none', plants({ '.hkb/check': `touch ${marker}\n`, 'check.sh': `touch ${marker}\n` }));

  const after = await db.job.findUniqueOrThrow({ where: { id: job.id }, include: { attempts: true } });
  assert.equal(after.phase, 'succeeded');
  assert.equal(after.attempts[0].outcome, 'completed');
  assert.equal(after.attempts[0].check, null, 'nothing ran, so there is nothing to record');
  assert.equal(fs.existsSync(marker), false, 'and no command was executed at all');
});

test('a check planted IN THE WORKTREE is ignored: the command comes from the row', async () => {
  // The fence, stated as a refusal. A worker able to author what judges its own next attempt would
  // be marking its own work — the same reason a guide and a plugin grant resolve against the
  // repository (`src/plugins.ts`). Here the worker writes a passing check into its own checkout and
  // the failing one the operator filed is still the one that runs.
  const b = await checkBoard('check-fence');
  const job = await db.job.create({
    data: { boardId: b.id, name: 'fenced', brief: 'x', check: 'exit 1', maxRetries: 0 },
  });
  await runChecks('check-fence', plants({ '.hkb/check': 'exit 0\n', 'check.sh': 'exit 0\n' }));

  const after = await db.job.findUniqueOrThrow({ where: { id: job.id }, include: { attempts: true } });
  assert.equal(after.attempts[0].outcome, 'check_failed', 'the operator\'s command decided it, not the worker\'s');
  assert.equal(after.phase, 'failed');
});

test('a check that exits non-zero fails the attempt, keeps the session, and re-queues it', async () => {
  const b = await checkBoard('check-red');
  const job = await db.job.create({
    data: {
      boardId: b.id, name: 'red-suite', brief: 'write the feature',
      check: 'echo "1) the parser drops a comma" >&2; exit 1',
    },
  });
  await runChecks('check-red');

  const after = await db.job.findUniqueOrThrow({ where: { id: job.id }, include: { attempts: true } });
  assert.equal(after.attempts[0].outcome, 'check_failed');
  assert.equal(after.phase, 'pending', 'transient: two retries remain, so it goes round again');
  assert.ok(after.lastSessionId, 'resumable: the session that wrote the code is the one worth continuing');
  assert.match(after.lastError ?? '', /the parser drops a comma|check `echo/, 'and the operator is told which command');
  const rec = after.attempts[0].check as { command: string; exitCode: number; stdout: string; stderr: string };
  assert.equal(rec.exitCode, 1);
  assert.match(rec.stderr, /1\) the parser drops a comma/, 'the tail is kept on the attempt, per stream');
});

test('the resumed attempt is TOLD what the check said — command, code and tail', async () => {
  // `docs/rebuild-plan.md`: "the practice that has actually worked is briefing: tell the second
  // attempt what the first collided with". A retry that does not know why it is retrying wakes up
  // believing it finished and produces the same tree.
  const b = await checkBoard('check-briefed');
  const job = await db.job.create({
    data: { boardId: b.id, name: 'briefed-retry', brief: 'write the feature', check: 'echo "2 failing: totals" >&2; exit 2' },
  });
  await runChecks('check-briefed');

  const seen: string[] = [];
  const spy: Runtime = {
    name: 'spy',
    async run(spec) {
      seen.push(spec.prompt);
      return {
        status: 'completed', ok: true, sessionId: 'again', text: '', costUsd: 0, turns: 1,
        durationMs: 0, stopReason: 'end_turn', denials: 0, error: null,
      };
    },
  };
  await runChecks('check-briefed', spy);

  assert.equal(seen.length, 1, 'the Job ran again');
  assert.match(seen[0], /exited 2/, 'the exit code');
  assert.match(seen[0], /echo "2 failing: totals"/, 'the command');
  assert.match(seen[0], /2 failing: totals/, 'and the tail of what it printed');
  assert.match(seen[0], /write the feature/, 'on top of the work, not instead of it');
});

test('a check that passes on the resume ends the Job — and only the LAST failure is quoted', async () => {
  const b = await checkBoard('check-fixed');
  const job = await db.job.create({
    data: { boardId: b.id, name: 'fixed-on-retry', brief: 'fix it', check: 'test -f fixed' },
  });
  // Attempt 1 writes nothing, so `test -f fixed` exits 1. Attempt 2 writes the file in the same
  // checkout it resumed into, so the same command passes.
  await runChecks('check-fixed', plants({}));
  assert.equal((await db.job.findUniqueOrThrow({ where: { id: job.id } })).phase, 'pending');

  await runChecks('check-fixed', plants({ fixed: 'yes\n' }));
  const after = await db.job.findUniqueOrThrow({ where: { id: job.id }, include: { attempts: { orderBy: { k: 'asc' } } } });
  assert.equal(after.phase, 'succeeded');
  assert.equal(after.attempts[1].outcome, 'completed');
  assert.equal(after.attempts[1].check, null, 'a passing check records nothing');
  assert.equal(after.lastError, null, 'and the Job stops claiming to be broken');

  // A third attempt would not be briefed about the FIRST one's failure: only `k - 1` is read, and
  // an older failure was already answered by the attempt in between.
  assert.ok(after.attempts[0].check, 'the record of the first failure is still on its own attempt');
});

test('a check that keeps failing gives up when the retries are gone', async () => {
  const b = await checkBoard('check-exhausted');
  const job = await db.job.create({
    data: { boardId: b.id, name: 'always-red', brief: 'x', check: 'exit 1', maxRetries: 1 },
  });
  await runChecks('check-exhausted');
  assert.equal((await db.job.findUniqueOrThrow({ where: { id: job.id } })).phase, 'pending', 'one retry left');
  await runChecks('check-exhausted');

  const after = await db.job.findUniqueOrThrow({ where: { id: job.id }, include: { attempts: true } });
  assert.equal(after.phase, 'failed', 'and then it is out of them');
  assert.equal(after.attempts.length, 2, 'maxRetries 1 means two attempts, exactly as a crash would');
  assert.match(after.lastError ?? '', /No retries are left/);
});

test('the board can say what every Job on it must pass, and a Job overrides it', async () => {
  const b = await db.board.upsert({
    where: { slug: 'checked-board' },
    update: { defaultCheck: 'exit 1' },
    create: { slug: 'checked-board', defaultCheck: 'exit 1' },
  });
  const inherits = await db.job.create({ data: { boardId: b.id, name: 'inherits', brief: 'x', maxRetries: 0 } });
  const overrides = await db.job.create({ data: { boardId: b.id, name: 'overrides', brief: 'x', check: 'exit 0', maxRetries: 0 } });
  await reconcile({ runtime: fakeRuntime(), cwd, board: 'checked-board', readPr: false });

  assert.equal((await db.job.findUniqueOrThrow({ where: { id: inherits.id } })).phase, 'failed');
  assert.equal((await db.job.findUniqueOrThrow({ where: { id: overrides.id } })).phase, 'succeeded',
    'the Job\'s own value wins, the way it does for every other spec field');
});

test('a check runs in the operator\'s checkout for a --no-isolate Job', async () => {
  const b = await checkBoard('check-unisolated');
  const job = await db.job.create({
    data: { boardId: b.id, name: 'unisolated-check', brief: 'x', isolate: false, check: 'test -f README.md', maxRetries: 0 },
  });
  await runChecks('check-unisolated');
  assert.equal((await db.job.findUniqueOrThrow({ where: { id: job.id } })).phase, 'succeeded',
    'the scratch repo has a README — so the check ran THERE, which is where the work happened');
});

// ---------------------------------------------------------------- the lease, the check, the order
//
// `runCheck` was a synchronous ten-minute spawn called AFTER the lease was deleted. For up to ten
// minutes the Job was `running` with no Lease row and an attempt still open, and every verb that
// looks into that window got a wrong answer: `hkb cancel` was accepted and then silently undone by
// the outcome written on the way out, `hkb rm` cascaded the rows away and turned the
// `attempt.update` into a P2025 that aborted the whole pass, and a daemon killed mid-check stranded
// the Job for ever because `reclaimExpired` scans Lease rows. The fix is the ordering below:
// verify, write, delete.

/** Wait for a condition, or give up — a poll rather than a sleep, so it is fast when it can be. */
const until = async (ok: () => boolean | Promise<boolean>, what: string, ms = 10_000) => {
  const stop = Date.now() + ms;
  while (Date.now() < stop) {
    if (await ok()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`timed out waiting for ${what}`);
};

test('the lease is HELD while the check runs, so nothing else may take the Job', async () => {
  const b = await checkBoard('check-leased');
  const gate = path.join(dir, 'release-the-check');
  const job = await db.job.create({
    data: {
      boardId: b.id, name: 'slow-check', brief: 'x', maxRetries: 0,
      check: `while [ ! -f ${gate} ]; do sleep 0.05; done`,
    },
  });

  const said: string[] = [];
  const pass = reconcile({
    runtime: fakeRuntime(), cwd, board: 'check-leased', readPr: false,
    onEvent: (l: string) => said.push(l),
  });
  // The gate is opened in a `finally`, and that is not tidiness: the check spins on it with the
  // shipped ten-minute `CHECK_TIMEOUT_MS`, so the first failing assertion below used to leave
  // `await pass` waiting out the whole of it — a suite that took ten minutes to tell you which
  // line was wrong. A failure has to fail fast or nobody runs the suite.
  try {
    await until(() => said.some((l) => l.includes('check while')), 'the check to start');

    // The Lease row is what refuses everybody else, and it is there for the whole command.
    const lease = await db.lease.findUniqueOrThrow({ where: { jobId: job.id } });
    assert.equal(lease.token.length > 0, true);
    await assert.rejects(
      () => db.lease.create({
        data: { jobId: job.id, holder: 'another-daemon', token: 'theirs', slot: 99, expiresAt: new Date(Date.now() + 60_000) },
      }),
      'a second claimant is refused by the live lease, not by luck',
    );
    // And the verb the operator would reach for is refused too, rather than accepted and then undone.
    await assert.rejects(
      () => concludeJob(db, job.id, { phase: 'cancelled', reason: 'changed my mind', by: 'ada' }),
      (e: Error) => /is leased by/.test(e.message),
    );
  } finally {
    fs.writeFileSync(gate, '');
  }
  await pass;
  const after = await db.job.findUniqueOrThrow({ where: { id: job.id } });
  assert.equal(after.phase, 'succeeded', 'and the check passed once it was let go');
  assert.equal(await db.lease.findUnique({ where: { jobId: job.id } }), null,
    'released at the very end, after the outcome was recorded — not before the check');
});

test('a check does not freeze the pass: the event loop keeps running under it', async () => {
  // The synchronous spawn blocked timers, the SDK stream, the in-process admission hook and every
  // signal handler for the whole check. A timer that fires under this one is the cheap proof.
  const b = await checkBoard('check-async');
  const gate = path.join(dir, 'release-the-async-check');
  await db.job.create({
    data: {
      boardId: b.id, name: 'not-blocking', brief: 'x', maxRetries: 0,
      check: `while [ ! -f ${gate} ]; do sleep 0.05; done`,
    },
  });
  let ticked = false;
  const t = setTimeout(() => { ticked = true; fs.writeFileSync(gate, ''); }, 200);
  await runChecks('check-async');
  clearTimeout(t);
  assert.equal(ticked, true, 'a timer ran while the check was in flight — the loop was never blocked');
});

test('a REFUSED attempt exports nothing into the operator\'s repository', async () => {
  // The copy ran ~150 lines before the check, so an attempt the check went on to refuse had already
  // written its declared outputs into `Board.repoPath` — contradicting the export block\'s own rule
  // that nothing leaves the sandbox until every declaration holds and nothing can still refuse.
  const b = await checkBoard('check-exports');
  const job = await db.job.create({
    data: { boardId: b.id, name: 'red-but-productive', brief: 'x', exports: ['docs/api.md'], check: 'exit 1', maxRetries: 0 },
  });
  await runChecks('check-exports', plants({ 'docs/api.md': '# the API\n' }));

  const after = await db.job.findUniqueOrThrow({ where: { id: job.id }, include: { attempts: true } });
  assert.equal(after.attempts[0].outcome, 'check_failed');
  assert.equal(fs.existsSync(path.join(cwd, 'docs', 'api.md')), false,
    'the check refused it, so nothing of it is in the operator\'s tree');
  assert.deepEqual(after.attempts[0].exported, [], 'it declared and handed nothing over, which is not null');
  // And the file itself is not lost: the checkout is kept for exactly this.
  assert.equal(fs.existsSync(path.join(checkoutOf(job.id), 'docs', 'api.md')), true,
    'it is still where the run wrote it, in the checkout the operator is told to look in');
});

test('a PASSING check still exports, so the split did not switch the feature off', async () => {
  const b = await checkBoard('check-exports-green');
  const job = await db.job.create({
    data: { boardId: b.id, name: 'green-and-productive', brief: 'x', exports: ['docs/ok.md'], check: 'test -f docs/ok.md', maxRetries: 0 },
  });
  await runChecks('check-exports-green', plants({ 'docs/ok.md': '# fine\n' }));

  const after = await db.job.findUniqueOrThrow({ where: { id: job.id }, include: { attempts: true } });
  assert.equal(after.phase, 'succeeded');
  assert.equal(fs.existsSync(path.join(cwd, 'docs', 'ok.md')), true);
  assert.deepEqual(after.attempts[0].exported, ['docs/ok.md']);
});

test('the record says which base the tree was on, because the verdict is only worth that', async () => {
  // README and the comment both say the check tests "what would actually merge". That is true when
  // the rebase replayed and NOT true when it legitimately declined — a pushed branch whose pull
  // request is out of draft, or a base that could not be fetched. Neither fails the attempt and
  // neither should; being quiet about it is what made the claim wrong rather than qualified.
  const b = await checkBoard('check-onbase');
  const job = await db.job.create({
    data: { boardId: b.id, name: 'says-its-base', brief: 'x', check: 'exit 1', maxRetries: 0 },
  });
  await runChecks('check-onbase');

  const rec = (await db.attempt.findUniqueOrThrow({ where: { jobId_k: { jobId: job.id, k: 1 } } })).check as
    { onBase: boolean; base: string };
  assert.equal(typeof rec.onBase, 'boolean', 'recorded, not assumed');
  assert.equal(typeof rec.base, 'string', 'and named — `onBase` alone says nothing anybody can act on');
  assert.match(
    (await db.job.findUniqueOrThrow({ where: { id: job.id } })).lastError ?? '',
    /exited 1/,
  );
});

test('an un-isolated Job makes no claim about a base it does not have', async () => {
  const b = await checkBoard('check-onbase-none');
  const job = await db.job.create({
    data: { boardId: b.id, name: 'no-branch', brief: 'x', isolate: false, check: 'exit 1', maxRetries: 0 },
  });
  await runChecks('check-onbase-none');
  const rec = (await db.attempt.findUniqueOrThrow({ where: { jobId_k: { jobId: job.id, k: 1 } } })).check as
    Record<string, unknown>;
  assert.equal(rec.onBase, undefined, 'nothing was replayed, so there is no claim to qualify');
});

// ---------------------------------------------------------------- what the worker is told, and when

test('the FIRST attempt is told the command it will be judged by', async () => {
  // It used to reach a prompt only through `withCheckFailure` — that is, only after an attempt had
  // already failed on it. The worker runs `npm test`, pushes, ends green, the check fails on the
  // lint half, and a whole paid retry goes on a one-line fix.
  const b = await checkBoard('check-told');
  await db.job.create({
    data: { boardId: b.id, name: 'told-up-front', brief: 'write the feature', check: 'npm run lint && npm test', maxRetries: 0 },
  });
  const seen: string[] = [];
  await runChecks('check-told', spyOn(seen));
  assert.equal(seen.length, 1);
  assert.match(seen[0], /must exit 0 in your checkout when you finish/);
  assert.match(seen[0], /npm run lint && npm test/, 'verbatim, as the retry prompt has always quoted it');
});

test('an unchecked Job is told nothing about a check, at the shipped defaults', async () => {
  const b = await checkBoard('check-untold');
  await db.job.create({ data: { boardId: b.id, name: 'untold', brief: 'x', maxRetries: 0 } });
  const seen: string[] = [];
  await runChecks('check-untold', spyOn(seen));
  assert.doesNotMatch(seen[0], /must exit 0/);
});

test('the briefing survives a `stopped` attempt in between — k-1 is not the whole history', async () => {
  // `k` counts every ended attempt, and `stopped`, `lost` and a pre-run `crashed` write no check
  // and clear no session. Reading only `k - 1` meant one of them in between dropped the briefing
  // silently: the next attempt resumed the very session the check refused, knowing nothing.
  const b = await checkBoard('check-walkback');
  const job = await db.job.create({
    data: { boardId: b.id, name: 'interrupted', brief: 'write the feature', check: 'test -f fixed', maxRetries: 4 },
  });
  await runChecks('check-walkback', plants({}));
  const first = await db.attempt.findUniqueOrThrow({ where: { jobId_k: { jobId: job.id, k: 1 } } });
  assert.equal(first.outcome, 'check_failed', 'attempt 1 collided with the check');

  // Attempt 2 is stopped by `hkb down` landing mid-run — the abort has to happen DURING it, which
  // is what a stop actually looks like: a pre-aborted pass claims nothing at all.
  const ac = new AbortController();
  const stopper: Runtime = {
    name: 'stopper',
    async run(spec) {
      ac.abort();
      return {
        status: 'completed', ok: true, sessionId: spec.resume ?? `s-${spec.taskId}-${spec.attempt}`, text: '',
        costUsd: 0, turns: 1, durationMs: 0, stopReason: 'end_turn', denials: 0, error: null,
      };
    },
  };
  await reconcile({ runtime: stopper, cwd, board: 'check-walkback', readPr: false, signal: ac.signal });
  const mid = await db.attempt.findUniqueOrThrow({ where: { jobId_k: { jobId: job.id, k: 2 } } });
  assert.equal(mid.outcome, 'stopped');
  assert.equal(mid.check, null, 'it ran no check, so it answered nothing');

  const seen: string[] = [];
  await runChecks('check-walkback', spyOn(seen));
  assert.equal(seen.length, 1, 'attempt 3 ran');
  assert.match(seen[0], /refused it/, 'and it was told what attempt 1 collided with, two rows back — the refusal, not just the contract');
  assert.match(seen[0], /test -f fixed/);
});

test('the briefing names the check as it is NOW, not the one that refused the last attempt', async () => {
  const b = await checkBoard('check-changed');
  const job = await db.job.create({
    data: { boardId: b.id, name: 'moved-goalposts', brief: 'write the feature', check: 'exit 1', maxRetries: 2 },
  });
  await runChecks('check-changed');
  // The operator decides the check was wrong and changes it, then lets it run again.
  await db.job.update({ where: { id: job.id }, data: { check: 'npm run lint' } });

  const seen: string[] = [];
  await runChecks('check-changed', spyOn(seen));
  assert.match(seen[0], /judges THIS attempt is `npm run lint`/, 'the command that will decide');
  assert.match(seen[0], /leave the tree so that `npm run lint` exits 0/, 'and it is what it is asked for');
});

// ---------------------------------------------------------------- opting out of a board-wide check

test('a Job whose check is `` runs none, on a board that checks everything', async () => {
  // The schema\'s own comment — "a Job whose brief is an investigation has no suite to pass" —
  // could not be honoured: a blank normalised to null, and null inherits.
  const b = await db.board.upsert({
    where: { slug: 'check-optout' },
    update: { defaultCheck: 'exit 1' },
    create: { slug: 'check-optout', defaultCheck: 'exit 1' },
  });
  const investigation = await db.job.create({
    data: { boardId: b.id, name: 'investigation', brief: 'read it and report', check: '', maxRetries: 0 },
  });
  const ordinary = await db.job.create({ data: { boardId: b.id, name: 'ordinary', brief: 'x', maxRetries: 0 } });
  await reconcile({ runtime: fakeRuntime(), cwd, board: 'check-optout', readPr: false });

  const out = await db.job.findUniqueOrThrow({ where: { id: investigation.id }, include: { attempts: true } });
  assert.equal(out.phase, 'succeeded', 'it opted out, so the board\'s failing check never ran');
  assert.equal(out.attempts[0].check, null, 'and nothing about one is recorded');
  assert.equal((await db.job.findUniqueOrThrow({ where: { id: ordinary.id } })).phase, 'failed',
    'while the Job beside it still inherits — one Job was narrowed, not the board');
});

test('a missing declared output outranks the check: one cause, and the cheaper one', async () => {
  // The check is not run at all when the attempt has already failed. Spending ten minutes on a
  // suite to report a second reason for a failure that already has one is the opposite of frugal.
  const b = await checkBoard('check-outranked');
  const job = await db.job.create({
    data: { boardId: b.id, name: 'no-output-first', brief: 'x', results: ['finding'], check: 'exit 1', maxRetries: 0 },
  });
  await runChecks('check-outranked');
  const after = await db.job.findUniqueOrThrow({ where: { id: job.id }, include: { attempts: true } });
  assert.equal(after.attempts[0].outcome, 'no_output', 'the declared result that never arrived is the reason');
  assert.equal(after.attempts[0].check, null, 'and the command was never run');
});

// ---------------------------------------------------------------- runtimes for the sections below

/** `plants`, with the prompt recorded. Two facts about one run, without two runtimes. */
const spyingPlants = (into: string[], files: Record<string, string>): Runtime => ({
  name: 'spying-plants',
  async run(spec, onEvent) {
    into.push(spec.prompt);
    return plants(files).run(spec, onEvent);
  },
});

/** A runtime that plants files AND writes a declared result to the path the prompt named. */
const writesResult = (inner: Runtime, name: string, value: string): Runtime => ({
  name: 'writes-result',
  async run(spec, onEvent) {
    const m = spec.prompt.match(new RegExp(`\`${name}\` \u2192 \`([^\`]+)\``));
    if (m) fs.writeFileSync(m[1], value);
    return inner.run(spec, onEvent);
  },
});

/** A run that never came back: the outcome that nulls `lastSessionId` and sweeps the checkout. */
const crashes = (): Runtime => ({
  name: 'crashes',
  async run() {
    return {
      status: 'error', ok: false, sessionId: null, text: '', costUsd: 0, turns: 0,
      durationMs: 0, stopReason: 'error', denials: 0, error: 'the runtime fell over',
    };
  },
});

/** A run that hit a cap. Both of these KEEP the session, which is the point of them here. */
const capped = (status: 'max_turns' | 'timeout'): Runtime => ({
  name: 'capped',
  async run(spec) {
    return {
      // A RESUMED session keeps its id — that is what resuming one means, and it is what makes
      // `lastRefusedCheck`'s identity test the right test rather than a coincidence.
      status, ok: false, sessionId: spec.resume ?? `s-${spec.taskId}-${spec.attempt}`, text: 'got partway',
      costUsd: 0, turns: 1, durationMs: 0, stopReason: status, denials: 0, error: null,
    };
  },
});

/** A proposing worker: it writes the proposal the contract named, and records the prompt. */
const proposes = (into: string[], jobs: { name: string; brief: string }[]): Runtime => ({
  name: 'proposes',
  async run(spec) {
    into.push(spec.prompt);
    const m = spec.prompt.match(/`(\S+proposal\.json)`/);
    if (m) fs.writeFileSync(m[1], JSON.stringify({ jobs }));
    return {
      status: 'completed', ok: true, sessionId: `s-${spec.taskId}-${spec.attempt}`, text: 'proposed',
      costUsd: 0, turns: 1, durationMs: 0, stopReason: 'end_turn', denials: 0, error: null,
    };
  },
});

// ---------------------------------------------------------------- the lease, and the way out
//
// The renewer's `clearInterval` and the fenced release used to be the last two statements of a
// section three hundred lines long, reached only on the way through. Every one of them is now under
// a `finally`, because a claim with a deadline whose holder has stopped must lapse — and that is a
// property of the release, not of the happy path arriving at it.

test('the lease is RELEASED and the attempt closed even when the post-run section throws', async () => {
  // Reproduced with a three-second lease: it went on advancing minutes after the pass had thrown,
  // with the Job `running`, `reclaimExpired` finding no expired lease to take and `whileUnleased`
  // refusing `hkb cancel` and `hkb rm` because a Lease row was there. Nothing on the machine could
  // end it. The throw is injected where a real one lands — inside the results block, between the
  // runtime call and the release — and what it is does not matter: an fs error in `collectResults`,
  // a `SQLITE_BUSY` on the fence read and an `EPIPE` out of the log are the same shape.
  const b = await checkBoard('lease-finally');
  const job = await db.job.create({
    data: { boardId: b.id, name: 'throws-after-the-run', brief: 'x', results: ['answer'], maxRetries: 0 },
  });
  await assert.rejects(
    () => reconcile({
      runtime: plants({}), cwd, board: 'lease-finally', readPr: false, leaseMs: 3_000,
      onEvent: (l: string) => { if (/declared .answer./.test(l)) throw new Error('the log went away'); },
    }),
    /the log went away/,
    'the pass still reports it — this is about what it leaves behind, not about swallowing it',
  );

  assert.equal(await db.lease.findUnique({ where: { jobId: job.id } }), null,
    'no Lease row: the renewer is stopped and the claim is gone');
  const after = await db.job.findUniqueOrThrow({ where: { id: job.id }, include: { attempts: true } });
  assert.equal(after.attempts[0].outcome, 'crashed', 'the attempt is closed rather than left open');
  assert.match(after.attempts[0].reason ?? '', /the pass failed after the run/);
  assert.notEqual(after.phase, 'running', 'and the Job is not stuck in a phase nothing can act on');

  // The renewer really has stopped: the lease would otherwise be pushed forward every second.
  await new Promise((r) => setTimeout(r, 1_200));
  assert.equal(await db.lease.findUnique({ where: { jobId: job.id } }), null, 'and it stays gone');
});


test('the lease is released when the PRE-RUN section throws — the try begins at the renewer', async () => {
  // The `try` began after the pre-run reads, ~330 lines past the renewer, so a throw in any of
  // them — SQLITE_BUSY on the approval read, a file where the results directory should be, the
  // log gone — still produced the immortal lease: a renewer ticking for the daemon's lifetime on
  // a Job `running` that `hkb cancel` refused because a Lease row was there. The throw here lands
  // where a real one does: in a `say` between the renewer and the runtime call.
  const b = await checkBoard('lease-prerun');
  const job = await db.job.create({
    // A granted plugin directory that does not exist is dropped with a line — said BEFORE the run.
    data: { boardId: b.id, name: 'throws-before-the-run', brief: 'x', pluginPaths: ['.nowhere-for-this-test'], maxRetries: 0 },
  });
  let ran = 0;
  const runtime: Runtime = { ...fakeRuntime(), run: async (spec) => { ran++; return fakeRuntime().run(spec); } };
  await assert.rejects(
    () => reconcile({
      runtime, cwd, board: 'lease-prerun', readPr: false, leaseMs: 3_000,
      onEvent: (l: string) => { if (/granted plugin path/.test(l)) throw new Error('the log went away early'); },
    }),
    /the log went away early/,
  );
  assert.equal(ran, 0, 'the throw was before the runtime — nothing was bought');
  assert.equal(await db.lease.findUnique({ where: { jobId: job.id } }), null, 'no Lease row: the renewer is stopped and the claim is gone');
  const after = await db.job.findUniqueOrThrow({ where: { id: job.id }, include: { attempts: true } });
  assert.equal(after.attempts[0].outcome, 'crashed', 'the attempt is closed');
  assert.notEqual(after.phase, 'running');
  await new Promise((r) => setTimeout(r, 1_200));
  assert.equal(await db.lease.findUnique({ where: { jobId: job.id } }), null, 'and it stays gone');
});

test('a failure AFTER the outcome is recorded rewrites nothing', async () => {
  // The `catch` could not tell whether the rows were already right, so a throw on the way out —
  // the event write losing a race, a closed log pipe on the final line — rewrote a `completed`
  // attempt as `crashed` and flipped a `succeeded` Job back to `pending` with its session kept:
  // the next pass re-claimed it and bought a second session for work already delivered.
  const b = await checkBoard('recorded-then-throws');
  const job = await db.job.create({ data: { boardId: b.id, name: 'done-then-log-dies', brief: 'x', maxRetries: 2 } });
  await assert.rejects(
    () => reconcile({
      runtime: fakeRuntime(), cwd, board: 'recorded-then-throws', readPr: false,
      // The final line of the pass, after the three writes.
      onEvent: (l: string) => { if (/succeeded\s+completed/.test(l)) throw new Error('pipe closed at the end'); },
    }),
    /pipe closed at the end/,
    'still raised — the operator is told',
  );
  const after = await db.job.findUniqueOrThrow({ where: { id: job.id }, include: { attempts: true } });
  assert.equal(after.phase, 'succeeded', 'the Job stays what it earned');
  assert.equal(after.attempts.length, 1);
  assert.equal(after.attempts[0].outcome, 'completed', 'the attempt is not rewritten as crashed');
  assert.equal(await db.event.count({ where: { jobId: job.id, kind: 'crashed' } }), 0, 'and no crashed event is invented');
  assert.equal(await db.lease.findUnique({ where: { jobId: job.id } }), null, 'the lease is released all the same');
  // And nothing to re-claim: a second pass finds no work.
  const again = await reconcile({ runtime: fakeRuntime(), cwd, board: 'recorded-then-throws', readPr: false });
  assert.deepEqual(again.claimed, [], 'the delivered work is not bought twice');
});

test('a holder whose lease was taken mid-run does not write the Job row from its catch either', async () => {
  // The body refuses to touch the contended Job row once `heldToTheEnd` is false; the `catch`
  // did not, so a stale holder that crashed while REPORTING that it had lost the lease wrote
  // `pending` and its own stale session id over a Job another holder was running — or had already
  // finished.
  const b = await checkBoard('stale-catch');
  const job = await db.job.create({ data: { boardId: b.id, name: 'taken-mid-run', brief: 'x', maxRetries: 2 } });
  const runtime: Runtime = {
    ...fakeRuntime(),
    run: async (spec) => {
      // Somebody else takes the lease while this run is in flight.
      await db.lease.update({ where: { jobId: job.id }, data: { holder: 'other-host', token: 'theirs' } });
      return { ...(await fakeRuntime().run(spec)), sessionId: 'stale-session' };
    },
  };
  await assert.rejects(
    () => reconcile({
      runtime, cwd, board: 'stale-catch', readPr: false,
      onEvent: (l: string) => { if (/lease was taken mid-run/.test(l)) throw new Error('log died while reporting the loss'); },
    }),
    /log died while reporting the loss/,
  );
  const after = await db.job.findUniqueOrThrow({ where: { id: job.id } });
  assert.equal(after.phase, 'running', 'the Job row is the other holder\'s and was left alone');
  assert.notEqual(after.lastSessionId, 'stale-session', 'and the stale session was not written over it');
  assert.equal(await db.event.count({ where: { jobId: job.id, kind: 'crashed' } }), 0, 'no crashed event from a non-holder');
  const lease = await db.lease.findUnique({ where: { jobId: job.id } });
  assert.equal(lease?.holder, 'other-host', 'and the other holder\'s lease is untouched — the release is fenced on the token');
});


test('a Job left `running` with no lease and no live holder is reclaimed on the next pass', async () => {
  // The state no lease describes: the holder released the lease and then could not write the Job
  // row. The lease scan never saw it, no pass claims a Job that is not `pending`, and `hkb retry`
  // refused it while saying `hkb run` reclaims it — which it now does.
  const b = await checkBoard('stranded-running');
  const job = await db.job.create({ data: { boardId: b.id, name: 'stranded', brief: 'x', phase: 'running', maxRetries: 2 } });
  // A holder on THIS machine whose process is gone — the one case liveness can prove. An open
  // attempt from another machine, or from a live process, is left alone: see the sibling tests
  // that model another host's run in flight this same way.
  await db.attempt.create({ data: { jobId: job.id, k: 1, host: `${os.hostname()}/999999@fake`, maxBudgetUsd: 1, startedAt: new Date() } });
  const r = await reconcile({ runtime: fakeRuntime(), cwd, board: 'stranded-running', readPr: false });
  assert.deepEqual(r.reclaimed, [job.id]);
  const after = await db.job.findUniqueOrThrow({ where: { id: job.id }, include: { attempts: true } });
  assert.equal(after.attempts[0].outcome, 'lost', 'the open attempt is closed');
  assert.equal(after.phase, 'succeeded', 'and, with retries left, it was pending — and this same pass then ran it');
  assert.equal(await db.event.count({ where: { jobId: job.id, kind: 'reclaimed' } }), 1);
});

test('the interrupted-check notice survives a `stopped` attempt in between', async () => {
  // `interruptedBefore` looked at `k - 1` only, so a stop mid-run between the interrupted check
  // and the resume lost the notice — the exact gap the refusal walk-back already closes.
  const b = await checkBoard('interrupted-walkback');
  const job = await db.job.create({
    data: { boardId: b.id, name: 'walk', brief: 'x', check: 'true', phase: 'pending', lastSessionId: 's-walk', maxRetries: 4 },
  });
  const at = new Date();
  await db.attempt.create({ data: { jobId: job.id, k: 1, host: 'h', maxBudgetUsd: 1, startedAt: at, endedAt: at, outcome: 'completed', sessionId: 's-walk', reason: 'check interrupted by a stop — the run stands, the check runs again' } });
  await db.attempt.create({ data: { jobId: job.id, k: 2, host: 'h', maxBudgetUsd: 1, startedAt: at, endedAt: at, outcome: 'stopped', sessionId: 's-walk' } });
  const prompts: string[] = [];
  await reconcile({ runtime: spyingPlants(prompts, {}), cwd, board: 'interrupted-walkback', readPr: false });
  assert.equal(prompts.length, 1);
  assert.match(prompts[0], /a stop landed while this command was being run/, 'told, two rows back');
});

// ---------------------------------------------------------------- a stop that lands mid-check

test('a stop during the check does not relabel a run that had already finished', async () => {
  // `ran` was reassigned to `stopped` AFTER the results had been collected and `clearResults` had
  // deleted them — so the resumed attempt could not re-produce them, ended `no_output`, and went
  // terminal. Pressing Ctrl-C during a test suite destroyed the Job. What is true is narrower: the
  // run completed, and the CHECK was interrupted.
  const b = await checkBoard('check-stopped');
  const gate = path.join(dir, 'release-the-stopped-check');
  const job = await db.job.create({
    data: {
      boardId: b.id, name: 'stopped-mid-check', brief: 'x', results: ['answer'], exports: ['docs/out.md'],
      check: `while [ ! -f ${gate} ]; do sleep 0.05; done`,
    },
  });

  const stop = new AbortController();
  const said: string[] = [];
  const runtime = plants({ 'docs/out.md': '# out\n' }, (where) => {
    fs.mkdirSync(path.join(dir, 'x'), { recursive: true });
    fs.writeFileSync(path.join(where, 'ignored'), '');
  });
  const pass = reconcile({
    runtime: writesResult(runtime, 'answer', '42'), cwd, board: 'check-stopped', readPr: false,
    signal: stop.signal, onEvent: (l: string) => said.push(l),
  });
  try {
    await until(() => said.some((l) => l.includes('check while')), 'the check to start');
    stop.abort();
  } finally {
    fs.writeFileSync(gate, '');
  }
  await pass;

  const after = await db.job.findUniqueOrThrow({ where: { id: job.id }, include: { attempts: true } });
  const one = after.attempts[0];
  assert.equal(one.outcome, 'completed', 'the run finished, and a stop is not a claim about that');
  assert.deepEqual(one.results, { answer: '42' }, 'and what it produced is kept on the attempt');
  assert.equal(one.check, null, 'no verdict was given, so none is recorded');
  // The exports are withheld, exactly as they are for a check that REFUSED: nothing verified this
  // tree, and a copy made now is one the next attempt's check may refuse with no way to take it
  // back. `[]` is the truth about what reached the repository.
  assert.deepEqual(one.exported, [], 'nothing was copied — the check never answered');
  assert.ok(!fs.existsSync(path.join(cwd, 'docs', 'out.md')), 'and nothing unverified is in the repository');
  assert.equal(one.reason, 'check interrupted by a stop — the run stands, the check runs again');
  assert.equal(after.phase, 'pending', 'the check has not been answered, so it goes round again');
  assert.equal(after.lastError, null, 'and nothing is asked of a human — the word `completed` is not an error');
  assert.ok(after.lastSessionId, 'in the same session — nothing about the work changed');
  const stopEvent = await db.event.findFirst({ where: { jobId: job.id, kind: 'completed' }, orderBy: { id: 'desc' } });
  assert.deepEqual(stopEvent?.payload, { k: 1, phase: 'pending', checkInterrupted: true }, 'the log says why a completed run is pending');

  // And the next attempt is briefed NOTHING about a check refusal, because there was none.
  const prompts: string[] = [];
  await reconcile({
    runtime: writesResult(spyingPlants(prompts, { 'docs/out.md': '# out\n' }), 'answer', '42'),
    cwd, board: 'check-stopped', readPr: false,
  });
  assert.equal(prompts.length, 1, 'it did go round again');
  assert.doesNotMatch(prompts[0], /refused it/, 'no refusal happened, so none is quoted');
  assert.match(prompts[0], /a stop landed while this command was being run/, 'but it is told the check never answered');
  assert.match(prompts[0], /results are per attempt/, 'and that this attempt owes its own results');
  const ended = await db.job.findUniqueOrThrow({ where: { id: job.id }, include: { attempts: true } });
  assert.notEqual(ended.attempts[1].outcome, 'no_output', 'and it does not fail for results attempt 1 already gave');
  assert.equal(ended.phase, 'succeeded', 'the check ran to a verdict this time, and it passed');
});

// ---------------------------------------------------------------- a proposing Job runs no check

test('a PROPOSING Job runs no check, however the board is configured', async () => {
  // It changes nothing in the tree — its output is `proposal.json` — so there is no behaviour for a
  // command to judge. Running one anyway did real harm: a check over an unchanged tree fails, and
  // `check_failed` outranks the gate, so the Job never suspended for approval. Measured: three
  // attempts, the same proposal stored three times, zero Jobs filed.
  const b = await checkBoard('check-proposes');
  const marker = path.join(dir, 'proposer-check-ran');
  await db.board.update({ where: { id: b.id }, data: { defaultCheck: `touch ${marker}; exit 1` } });
  const job = await db.job.create({
    data: { boardId: b.id, name: 'proposer', brief: 'x', proposes: 'jobs', gate: 'ok?' },
  });
  const prompts: string[] = [];
  await reconcile({
    runtime: proposes(prompts, [{ name: 'a follow-up', brief: 'do the next thing' }]),
    cwd, board: 'check-proposes', readPr: false,
  });

  const after = await db.job.findUniqueOrThrow({ where: { id: job.id }, include: { attempts: true } });
  assert.equal(fs.existsSync(marker), false, 'the board\'s check was not run in a tree it has nothing to say about');
  assert.equal(after.attempts.length, 1, 'one attempt, not three');
  assert.equal(after.phase, 'suspended', 'it suspends for the approval, which is the whole point of it');
  assert.equal(after.attempts[0].check, null);
  assert.doesNotMatch(prompts[0] ?? '', /must exit 0 in your checkout/, 'and it is not told about one either');
});

// ---------------------------------------------------------------- the export rule, restored

test('a declared export that IS there is delivered even when something else fell short', async () => {
  // `main`'s rule: copy what is present, and let the shortfall be the shortfall. Gating the copy on
  // `!shortfall` meant a missing RESULT withheld an export that was sitting right there — and the
  // rebase-conflict case is worse, because that attempt is not resumable, so nothing ever delivers
  // it. The check is the one thing that may withhold a copy, and it is why the copy moved at all.
  const b = await checkBoard('check-exports-partial');
  const job = await db.job.create({
    data: {
      boardId: b.id, name: 'partly-productive', brief: 'x',
      exports: ['docs/present.md'], results: ['never-written'], maxRetries: 0,
    },
  });
  await runChecks('check-exports-partial', plants({ 'docs/present.md': '# here\n' }));

  const after = await db.job.findUniqueOrThrow({ where: { id: job.id }, include: { attempts: true } });
  assert.equal(after.attempts[0].outcome, 'no_output', 'the missing result is still the cause, and still fails it');
  assert.equal(fs.existsSync(path.join(cwd, 'docs', 'present.md')), true,
    'and the file it DID produce is in the repository, which is where a durable record belongs');
  assert.deepEqual(after.attempts[0].exported, ['docs/present.md']);
});

// ---------------------------------------------------------------- the walk-back and the session

test('the walk-back stops at a crash that took the session with it', async () => {
  // `CHECKLESS_OUTCOMES` walked past `crashed` on the premise that it clears no session. A
  // runtime-error `crashed` nulls `lastSessionId` and its worktree is swept, so attempt 3 starts
  // COLD — and was briefed "the work is still there: the same session" about a session that no
  // longer exists, with the plain line saying what it has to pass suppressed in favour of it.
  const b = await checkBoard('check-walk-cold');
  const job = await db.job.create({
    data: { boardId: b.id, name: 'crashed-between', brief: 'x', check: 'exit 1', maxRetries: 4 },
  });
  // Attempt 1: the check refuses it, and the session is kept.
  await runChecks('check-walk-cold', plants({}));
  const one = await db.job.findUniqueOrThrow({ where: { id: job.id } });
  assert.ok(one.lastSessionId, 'attempt 1 left a session for attempt 2 to resume');

  // Attempt 2 crashes in the runtime, which nulls the session.
  await reconcile({ runtime: crashes(), cwd, board: 'check-walk-cold', readPr: false });
  const two = await db.job.findUniqueOrThrow({ where: { id: job.id }, include: { attempts: true } });
  assert.equal(two.attempts[1].outcome, 'crashed');
  assert.equal(two.lastSessionId, null, 'and the session is gone with it');

  // Attempt 3 is cold. It is told the command, plainly, and nothing about a refusal it cannot see.
  const prompts: string[] = [];
  await reconcile({ runtime: spyOn(prompts), cwd, board: 'check-walk-cold', readPr: false });
  assert.match(prompts[0], /This command must exit 0 in your checkout when you finish/,
    'the plain line, which the refusal used to suppress');
  assert.doesNotMatch(prompts[0], /the same session, and normally the same checkout/,
    'and no claim about work a cold session cannot reach');
});

test('the walk-back DOES cross a cap that kept the session, because the refusal is still unanswered', async () => {
  // `timed_out` and `max_turns` write no `check` column and clear no session, so an attempt that
  // hit one has not answered the refusal before it — and stopping the walk there dropped the
  // briefing entirely, exactly as `stopped` and `lost` did before them.
  const b = await checkBoard('check-walk-capped');
  const job = await db.job.create({
    data: { boardId: b.id, name: 'capped-between', brief: 'x', check: 'exit 1', maxRetries: 4 },
  });
  await runChecks('check-walk-capped', plants({}));
  // A cap, which keeps the session the check refused.
  await reconcile({ runtime: capped('max_turns'), cwd, board: 'check-walk-capped', readPr: false });
  const two = await db.job.findUniqueOrThrow({ where: { id: job.id }, include: { attempts: true } });
  assert.equal(two.attempts[1].outcome, 'max_turns');
  assert.ok(two.lastSessionId, 'the session survives a cap');

  const prompts: string[] = [];
  await reconcile({ runtime: spyOn(prompts), cwd, board: 'check-walk-capped', readPr: false });
  assert.match(prompts[0], /the check this Job must pass refused it/,
    'the refusal is still the most recent thing anybody said about this session');
});

// ---------------------------------------------------------------- two tails, both kept

test('the two tails are recorded apart, so a loud stderr cannot evict the stdout verdict', async () => {
  const b = await checkBoard('check-two-tails');
  const job = await db.job.create({
    data: {
      boardId: b.id, name: 'two-tails', brief: 'x', maxRetries: 0,
      // 6 KB of stderr noise and one line of stdout: joined and re-cut to 4 KB, the verdict was gone.
      check: 'i=0; while [ $i -lt 300 ]; do echo "warning: something is deprecated" >&2; i=$((i+1)); done;'
        + ' echo "FAILED: 3 assertions"; exit 1',
    },
  });
  await runChecks('check-two-tails', plants({}));
  const after = await db.job.findUniqueOrThrow({ where: { id: job.id }, include: { attempts: true } });
  const rec = after.attempts[0].check as { stdout: string; stderr: string };
  assert.match(rec.stdout, /FAILED: 3 assertions/, 'the verdict survived a stream that drowned it');
  assert.match(rec.stderr, /warning: something is deprecated/);
  assert.match(rec.stderr, /earlier bytes dropped/, 'and the loud one was cut on its own');
});

// ---------------------------------------------------------------- the fence around a tail

test('fenceSafe breaks a run of FIVE, and leaves a run of four byte-identical', () => {
  // The prompt fences a check's tails with five backticks, and CommonMark §4.5 closes a fence only
  // with a run at least as long as the one that opened it — so a run of four inside it is ordinary
  // content. Rewriting fours put a U+200B into the standard four-around-three nesting idiom, which
  // is how anybody shows a fenced block inside a fenced block; and this text is handed to the
  // worker as DATA it may quote, diff or copy into the repository.
  const nested = 'here is a block:\n\n````\n```js\nconst a = 1;\n```\n````\n';
  assert.equal(fenceSafe(nested), nested, 'a four-run passes through untouched, byte for byte');
  assert.equal(fenceSafe(nested).includes('\u200b'), false, 'and no zero-width space is inserted');

  // Five or more cannot survive, or it closes the fence and the rest of the tail becomes prose the
  // model may read as instruction.
  for (const n of [5, 6, 9, 20]) {
    const out = fenceSafe('x'.repeat(3) + '`'.repeat(n) + 'y');
    assert.doesNotMatch(out, /`{5,}/, `a run of ${n} must not leave one of five`);
    assert.match(out, /\u200b/, `a run of ${n} is broken up`);
  }
});

test('the briefing carries BOTH tails, each labelled with the stream it came from', () => {
  const out = withCheckFailure('do the work', {
    command: 'cargo test',
    exitCode: 101,
    kind: 'exit',
    stdout: 'test result: FAILED. 1 passed; 2 failed',
    stderr: 'warning: unused variable `x`',
  }, 'cargo test');
  assert.match(out, /The last of what it printed on stdout:/);
  assert.match(out, /The last of what it printed on stderr:/);
  assert.match(out, /test result: FAILED/);
  assert.match(out, /warning: unused variable/);
  // An empty stream draws no block at all — a blank fence is not evidence.
  const oneSided = withCheckFailure('do the work', {
    command: 'npm test', exitCode: 1, kind: 'exit', stdout: '', stderr: '1 failing',
  }, 'npm test');
  assert.doesNotMatch(oneSided, /printed on stdout/);
  assert.match(oneSided, /printed on stderr/);
});

// ---------------------------------------------------------------- standing steps, at claim time

/**
 * The board's default workflow reaches a worker from the CONTROLLER, not from `hkb new`.
 *
 * `hkb new` used to expand the steps into `Job.brief`, and that placement was wrong three ways:
 * `hkb queue <id> "…"` replaced the brief and dropped them, a `--no-isolate` Job was told to push a
 * branch it did not have, and they landed BEFORE the sandbox contract — so a worker read "open the
 * PR, reply with the URL" and then "1. commit, 2. rebase, 3. reply with the branch".
 *
 * These are the claim-time half. The refusing case is the last one, and it runs at the shipped
 * defaults: a board pointing at a workflow that is not in the repository.
 */
const stepsBoard = async () => {
  const b = await db.board.upsert({
    where: { slug: 'steps' },
    update: { repoPath: cwd, defaultWorkflow: null, maxConcurrent: 5, pausedAt: null },
    create: { slug: 'steps', repoPath: cwd, maxConcurrent: 5 },
  });
  fs.mkdirSync(path.join(cwd, '.hkb', 'workflows'), { recursive: true });
  fs.writeFileSync(
    path.join(cwd, '.hkb', 'workflows', 'ends.md'),
    '---\nname: ends\n---\n\nOpen a draft pull request against your base.\n',
  );
  return b;
};

const promptOf = () => {
  let seen = '';
  const runtime = {
    name: 'spy',
    async run(spec: { prompt: string }) {
      seen = spec.prompt;
      return { status: 'completed', ok: true, sessionId: 's', text: '', costUsd: 0, turns: 1,
               durationMs: 0, stopReason: 'end_turn', denials: 0, error: null };
    },
  } as never;
  return { runtime, seen: () => seen };
};

test('the board`s steps reach a worker whose brief never carried them, AFTER the contract', async () => {
  const b = await stepsBoard();
  await db.board.update({ where: { id: b.id }, data: { defaultWorkflow: 'ends' } });
  const job = await db.job.create({
    data: { boardId: b.id, name: 'briefed by hand', brief: 'Fix the parser.', maxBudgetUsd: 1, maxRetries: 0 },
  });
  const spy = promptOf();
  await reconcile({ runtime: spy.runtime, cwd, only: job.id, board: 'steps', readPr: false });
  const seen = spy.seen();

  assert.match(seen, /Standing steps for work on this board, from the workflow `ends`:/);
  assert.match(seen, /Open a draft pull request against your base\./);
  // The ordering that was backwards: the core says how work is done here, the board says what doing
  // it ends in. Two reply contracts in the wrong order is not an instruction.
  assert.ok(seen.indexOf('Commit it on') < seen.indexOf('Standing steps'), 'the contract comes first');
  // And the Job row is untouched — nothing was frozen onto it, which is what lets `hkb queue` work.
  assert.equal((await db.job.findUniqueOrThrow({ where: { id: job.id } })).brief, 'Fix the parser.');
});

test('a proposing Job gets no steps: its whole output is one JSON file', async () => {
  const b = await stepsBoard();
  await db.board.update({ where: { id: b.id }, data: { defaultWorkflow: 'ends' } });
  const job = await db.job.create({
    data: { boardId: b.id, name: 'proposer', brief: 'Think it through.', proposes: 'jobs', maxBudgetUsd: 1, maxRetries: 0 },
  });
  const spy = promptOf();
  await reconcile({ runtime: spy.runtime, cwd, only: job.id, board: 'steps', readPr: false });
  assert.doesNotMatch(spy.seen(), /Standing steps/);
});

test('a --no-isolate Job gets no steps either — it has no branch for them to be about', async () => {
  const b = await stepsBoard();
  await db.board.update({ where: { id: b.id }, data: { defaultWorkflow: 'ends' } });
  const job = await db.job.create({
    data: { boardId: b.id, name: 'in place', brief: 'Look at it.', isolate: false, maxBudgetUsd: 1, maxRetries: 0 },
  });
  const spy = promptOf();
  await reconcile({ runtime: spy.runtime, cwd, only: job.id, board: 'steps', readPr: false });
  assert.doesNotMatch(spy.seen(), /Standing steps/);
  assert.doesNotMatch(spy.seen(), /pull request/i, 'and it is not told to open one for a branch it does not have');
});

test('a board pointing at a workflow that is not there REFUSES the attempt, and names the fix', async () => {
  // The refusing case, at the shipped defaults. Running without the steps would be every Job on the
  // board quietly finishing half-way — which is the failure this whole placement exists because of.
  const b = await stepsBoard();
  await db.board.update({ where: { id: b.id }, data: { defaultWorkflow: 'gone' } });
  const job = await db.job.create({
    data: { boardId: b.id, name: 'orphaned steps', brief: 'Fix it.', maxBudgetUsd: 1, maxRetries: 0 },
  });
  let ran = false;
  const runtime = { name: 'never', async run() { ran = true; throw new Error('the runtime must not be reached'); } } as never;
  await reconcile({ runtime, cwd, only: job.id, board: 'steps', readPr: false });

  assert.equal(ran, false, 'nothing was spent on a Job that could not be briefed');
  const row = await db.job.findUniqueOrThrow({ where: { id: job.id } });
  assert.equal(row.phase, 'failed');
  assert.match(row.lastError ?? '', /workflow `gone`/);
  assert.match(row.lastError ?? '', /hkb boards set steps --workflow/, 'and the message names the fix');
});
