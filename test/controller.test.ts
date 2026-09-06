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
