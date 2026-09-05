import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

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
  // controller keeps `lastSessionId` on exactly this flag. Losing it would make `kb retry
  // --max-budget` start cold and re-buy everything the $2 already paid for.
  const d = nextPhase({ status: 'max_budget' } as never, 1, DEFAULT_RETRIES, DEFAULT_BUDGET);
  assert.equal(d.resumable, true);
});

test('nextPhase: the budget failure tells a human the cap, and what to do about it', () => {
  const d = nextPhase({ status: 'max_budget' } as never, 1, DEFAULT_RETRIES, DEFAULT_BUDGET);
  assert.match(d.lastError ?? '', /\$1\.00/, 'the cap it hit, in dollars');
  assert.match(d.lastError ?? '', /kb retry <id> --max-budget 2\.00/, 'the command that changes the answer');
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
  assert.ok(after.lastSessionId, 'the session survives, so `kb retry --max-budget` resumes rather than restarts');
  assert.match(after.lastError ?? '', /\$1\.00/);
  assert.match(after.lastError ?? '', /kb retry <id> --max-budget/, 'the row says what a human should do next');
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

const checkoutOf = (jobId: number) => path.join(cwd, '.kanban', 'worktrees', `kb-${jobId}-1`);

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
    'what was left was undeclared, which is litter by definition — no `kb` verb needed to reclaim it');
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
  assert.match(after.lastError ?? '', /kb retry/, 'and says what a human does next');
  assert.deepEqual(after.attempts[0].exported, [], 'it declared, and handed over nothing — which is not the same fact as null');
  assert.equal(fs.existsSync(path.join(cwd, 'notes-to-self.md')), false, 'and nothing undeclared was copied out');
  assert.equal(fs.existsSync(checkoutOf(job.id)), true,
    'the checkout stays, because what the run did instead is now the only copy of itself');
});

test('an export path that escapes the worktree is refused at the copy too, not only at `kb new`', async () => {
  // `kb new` validates the declaration, so reaching this needs a row written another way — which is
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
